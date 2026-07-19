// Orphan handling for /z-loop (C7, issue #2): the crash-recovery scanner and the
// pure plan that returns a wedged project to a clean state, plus the mid-loop
// wave-reconciliation check the reducer honors. All the judgment is deterministic
// space (PRINCIPLES.md): scanOrphans reads the filesystem + a board snapshot,
// reconcilePlan is a pure function from orphans to an action list, and a thin
// applyReconcile half executes that list through injected effects (so tests run
// against temp dirs and fakes, never a real board or worktree).
//
// What reconcile NEVER does (issue #2): no branch deletion, no board comment
// deletion. It releases claims, parks tickets back to Ready, prunes worktrees,
// and removes stale lane locks -- nothing that a human can't cheaply redo.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Board, ghExecutor } from "./board.ts";
import { handleCliError, parseFlags, str } from "./cli.ts";
import { TERMINAL_STATUSES, loadConfig } from "./config.ts";
import { defaultLocksDir, listLaneLocks, type LaneLock } from "./locks.ts";
import { BOARD_STATUSES, type BoardStatus, type LaneState, type TicketSnapshot } from "./loop.ts";

export { ZError } from "./config.ts";

// -- orphan scan --------------------------------------------------------------

// The in-flight board statuses. A leftover worktree whose ticket sits in one of
// these (but has no lane lock) means a crash between claim and lock, so it is
// parked back to Ready alongside the prune.
const INFLIGHT: BoardStatus[] = ["Building", "QA", "Review"];

// Terminal-for-this-batch statuses come from lib/config.ts (TERMINAL_STATUSES).
// A crashed lane whose ticket already reached one of these did its work (Done)
// or was intentionally parked by a human (Questions/Blocked/Skipped): reconcile
// must NOT reopen it (issue #14 C4) -- a crash between the Done move and lock
// removal would otherwise rebuild already-merged work. Such a lane is only
// pruned + unlocked.

export type BoardTicketStatus = Pick<TicketSnapshot, "number" | "status">;

// A lane lock left behind by a crashed loop. How it is reconciled depends on the
// ticket's current board status (issue #14 C4): an INFLIGHT lane is released +
// parked to Ready + pruned + unlocked; a TERMINAL lane (the work already landed
// or a human parked it) is only pruned + unlocked.
export interface CrashedLane {
  ticket: number;
  lockPath: string;
  lock: LaneLock;
  ageMs: number;
  worktreePath?: string;
  boardStatus?: BoardStatus; // the ticket's status in the board snapshot, if present
}

// A worktree with no backing lock. Pruned; also parked when the board still
// shows it in-flight.
export interface OrphanWorktree {
  ticket: number;
  worktreePath: string;
  boardStatus?: BoardStatus;
}

export interface Orphans {
  crashedLanes: CrashedLane[];
  orphanWorktrees: OrphanWorktree[];
  buildingWithoutState: number[]; // Building on the board with neither lock nor worktree
}

// Worktree directories, one per `ticket-<N>`. Tolerates a missing dir.
export function listWorktrees(worktreesDir: string): { ticket: number; path: string }[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(worktreesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { ticket: number; path: string }[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = e.name.match(/^ticket-(\d+)$/);
    if (!m) continue;
    out.push({ ticket: Number(m[1]), path: join(worktreesDir, e.name) });
  }
  return out.sort((a, b) => a.ticket - b.ticket);
}

// Cross-references three sets -- lane locks (L), worktrees (W), and Building
// tickets (B) -- into the three orphan categories (issue #2): locks without a
// live lane, worktrees without a lock, and Building tickets without either.
// Called only once the loop lock is known free/stale (a live loop owns its
// locks), so a present lane lock IS a crashed lane. Clock injected for age.
export function scanOrphans(
  locksDir: string,
  worktreesDir: string,
  boardSnapshot: BoardTicketStatus[],
  nowMs: number
): Orphans {
  const locks = listLaneLocks(locksDir);
  const worktrees = listWorktrees(worktreesDir);
  const lockTickets = new Set(locks.map((l) => l.lock.ticket));
  const wtByTicket = new Map(worktrees.map((w) => [w.ticket, w]));
  const statusByTicket = new Map(boardSnapshot.map((t) => [t.number, t.status]));

  const crashedLanes: CrashedLane[] = locks.map((l) => ({
    ticket: l.lock.ticket,
    lockPath: l.path,
    lock: l.lock,
    ageMs: nowMs - l.lock.claimedAt,
    worktreePath: wtByTicket.get(l.lock.ticket)?.path,
    boardStatus: statusByTicket.get(l.lock.ticket),
  }));

  const orphanWorktrees: OrphanWorktree[] = worktrees
    .filter((w) => !lockTickets.has(w.ticket))
    .map((w) => ({ ticket: w.ticket, worktreePath: w.path, boardStatus: statusByTicket.get(w.ticket) }));

  const buildingWithoutState = boardSnapshot
    .filter((t) => t.status === "Building" && !lockTickets.has(t.number) && !wtByTicket.has(t.number))
    .map((t) => t.number)
    .sort((a, b) => a - b);

  return { crashedLanes, orphanWorktrees, buildingWithoutState };
}

export function hasOrphans(o: Orphans): boolean {
  return o.crashedLanes.length > 0 || o.orphanWorktrees.length > 0 || o.buildingWithoutState.length > 0;
}

// -- reconcile plan (pure) ----------------------------------------------------

export type ReconcileAction =
  | { kind: "release-claim"; ticket: number }
  | { kind: "park-ready"; ticket: number; note: string }
  | { kind: "prune-worktree"; ticket: number; path: string }
  | { kind: "remove-lock"; ticket: number; path: string };

// Pure: orphans in, ordered action list out. For each crashed lane the board
// status decides the recovery (issue #14 C4):
//   * TERMINAL (Done/Questions/Blocked/Skipped): the work already landed or a
//     human parked it -- ONLY prune the worktree + remove the lock. Never release
//     or park, which would reopen merged work or undo a human's decision.
//   * INFLIGHT or unknown: release the assignee, prune its worktree (if present),
//     park it back to Ready, remove its lock -- the crash left it mid-build.
// A lockless worktree is pruned, and also released+parked when the board still
// thinks it in-flight. A Building ticket with no on-disk state is released+parked.
export function reconcilePlan(orphans: Orphans): ReconcileAction[] {
  const actions: ReconcileAction[] = [];
  for (const c of orphans.crashedLanes) {
    if (c.boardStatus && TERMINAL_STATUSES.includes(c.boardStatus)) {
      // Terminal: leave the board alone; just clear the crashed run's on-disk state.
      if (c.worktreePath) actions.push({ kind: "prune-worktree", ticket: c.ticket, path: c.worktreePath });
      actions.push({ kind: "remove-lock", ticket: c.ticket, path: c.lockPath });
      continue;
    }
    actions.push({ kind: "release-claim", ticket: c.ticket });
    if (c.worktreePath) actions.push({ kind: "prune-worktree", ticket: c.ticket, path: c.worktreePath });
    actions.push({
      kind: "park-ready",
      ticket: c.ticket,
      note: `Recovered from a crashed lane (lock left at stage ${c.lock.stage}, ${Math.round(c.ageMs / 60_000)}m old); returned to Ready for a fresh build.`,
    });
    actions.push({ kind: "remove-lock", ticket: c.ticket, path: c.lockPath });
  }
  for (const w of orphans.orphanWorktrees) {
    actions.push({ kind: "prune-worktree", ticket: w.ticket, path: w.worktreePath });
    if (w.boardStatus && INFLIGHT.includes(w.boardStatus)) {
      actions.push({ kind: "release-claim", ticket: w.ticket });
      actions.push({
        kind: "park-ready",
        ticket: w.ticket,
        note: `Worktree without a lock while the board showed ${w.boardStatus}; returned to Ready.`,
      });
    }
  }
  for (const n of orphans.buildingWithoutState) {
    actions.push({ kind: "release-claim", ticket: n });
    actions.push({
      kind: "park-ready",
      ticket: n,
      note: `Was Building with neither a lock nor a worktree (crash before claim); returned to Ready.`,
    });
  }
  return actions;
}

// -- thin apply half (injected effects) ---------------------------------------

export interface ReconcileEffects {
  removeLock: (path: string) => void;
  pruneWorktree: (ticket: number, path: string) => void;
  parkReady: (ticket: number, note: string) => void;
  releaseClaim: (ticket: number) => void;
}

export async function applyReconcile(actions: ReconcileAction[], fx: ReconcileEffects): Promise<void> {
  for (const a of actions) {
    switch (a.kind) {
      case "remove-lock":
        fx.removeLock(a.path);
        break;
      case "prune-worktree":
        fx.pruneWorktree(a.ticket, a.path);
        break;
      case "park-ready":
        await fx.parkReady(a.ticket, a.note);
        break;
      case "release-claim":
        await fx.releaseClaim(a.ticket);
        break;
    }
  }
}

// -- wave reconciliation (mid-loop board moves) -------------------------------

// A human moving an in-flight ticket to a terminal status (TERMINAL_STATUSES)
// means "take this lane out of the loop." The loop's own reducers (lib/loop.ts)
// drop a lane BEFORE setting any of these on its ticket, so a lane co-existing
// with one of these on a fresh board snapshot is proof a human intervened -- no
// stage/status comparison needed. Replaces super-board's 120s tick (issue #2):
// the board is re-read before every stage transition, so a mid-loop move is
// respected at the boundary.
export function reconcileBoardMoves(tickets: TicketSnapshot[], lanes: LaneState[]): Set<number> {
  const byNumber = new Map(tickets.map((t) => [t.number, t]));
  const stopped = new Set<number>();
  for (const lane of lanes) {
    const t = byNumber.get(lane.ticket);
    if (t && TERMINAL_STATUSES.includes(t.status)) stopped.add(lane.ticket);
  }
  return stopped;
}

// -- production effects --------------------------------------------------------

// git worktree remove for a pruned lane. --force because the crashed builder
// likely left uncommitted work (discarded on purpose: the ticket is parked to
// Ready for a fresh build). Falls back to an rmSync + `git worktree prune` for a
// leftover directory git no longer tracks. NEVER deletes the branch (issue #2).
function pruneWorktreeReal(path: string): void {
  const rm = Bun.spawnSync(["git", "worktree", "remove", "--force", path], { stdout: "pipe", stderr: "pipe" });
  if (rm.exitCode === 0) return;
  rmSync(path, { recursive: true, force: true });
  Bun.spawnSync(["git", "worktree", "prune"], { stdout: "pipe", stderr: "pipe" });
}

function realEffects(board: Board): ReconcileEffects {
  return {
    removeLock: (p) => rmSync(p, { force: true }),
    pruneWorktree: (_t, p) => pruneWorktreeReal(p),
    parkReady: async (n) => {
      await board.move(n, "Ready");
    },
    releaseClaim: async (n) => {
      await board.release(n);
    },
  };
}

// -- CLI ----------------------------------------------------------------------

const USAGE = `reconcile <command> [args] --slug S

  scan   [--now MS]   scan orphans + build the plan; print JSON {hasOrphans, orphans, plan}
  plan   [--now MS]   print the reconcile action list as JSON
  apply  [--now MS]   execute the plan: release claims, park to Ready, prune worktrees,
                      remove stale locks (never deletes branches or comments)

  --dir / --worktrees override the locks + worktrees dirs (tests). Otherwise
  locks default to ~/.zstack/projects/<slug>/locks and worktrees to ./.worktrees.`;

// Sweeps EVERY status, not just the in-flight ones (issue #14 C4): a crashed
// lane's recovery hinges on whether its ticket is already terminal (Done/parked),
// so the plan needs the full board picture, not only Building/QA/Review.
export async function sweep(board: Board): Promise<BoardTicketStatus[]> {
  const out: BoardTicketStatus[] = [];
  for (const status of BOARD_STATUSES) {
    for (const it of await board.list(status)) out.push({ number: it.number, status });
  }
  return out;
}

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  if (!["scan", "plan", "apply"].includes(cmd)) {
    console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
    return 1;
  }
  try {
    const { flags } = parseFlags(argv.slice(1));
    const nowMs = Number(str(flags, "now") ?? Date.now());
    const cfg = loadConfig(str(flags, "slug"));
    const board = new Board(cfg, ghExecutor());
    const locksDir = str(flags, "dir") ?? defaultLocksDir(cfg.slug);
    const worktreesDir = str(flags, "worktrees") ?? join(process.cwd(), ".worktrees");

    const orphans = scanOrphans(locksDir, worktreesDir, await sweep(board), nowMs);
    const plan = reconcilePlan(orphans);

    if (cmd === "scan") {
      console.log(JSON.stringify({ hasOrphans: hasOrphans(orphans), orphans, plan }, null, 2));
      return 0;
    }
    if (cmd === "plan") {
      console.log(JSON.stringify(plan, null, 2));
      return 0;
    }
    // apply
    await applyReconcile(plan, realEffects(board));
    const counts = plan.reduce((m, a) => ((m[a.kind] = (m[a.kind] ?? 0) + 1), m), {} as Record<string, number>);
    console.log(`reconciled: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "nothing"}`);
    return 0;
  } catch (e) {
    return handleCliError(e);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
