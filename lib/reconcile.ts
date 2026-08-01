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
// and removes stale lane locks -- nothing that a human can't cheaply redo. And
// since #217, one more never: it does not force-remove a LOCKLESS worktree that
// holds uncommitted work with no salvage patch on disk. That is the one prune
// whose loss a human cannot redo at all, so the plan refuses it by name and the
// CLI exits non-zero rather than starting a loop over the only copy.
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Board, ghExecutor } from "./board.ts";
import { handleCliError, parseFlags, str } from "./cli.ts";
import {
  DEFAULT_LOCK_STALENESS_MINUTES,
  TERMINAL_STATUSES,
  ZError,
  loadConfig,
  reportsDir,
  salvagePatchName,
} from "./config.ts";
import { defaultLocksDir, inspectLoopLock, listLaneLocks, type LaneLock } from "./locks.ts";
import { BOARD_STATUSES, type BoardStatus, type LaneState, type TicketSnapshot } from "./loop.ts";

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
// shows it in-flight. #217 adds the facts the prune is now judged against:
// whether the tree holds uncommitted work, how new that work is, and whether a
// salvage patch covering it exists.
export interface OrphanWorktree {
  ticket: number;
  worktreePath: string;
  boardStatus?: BoardStatus;
  dirty: boolean; // uncommitted work present (git status --porcelain non-empty)
  newestChangeMs: number; // mtime of the newest uncommitted path; 0 when clean
  patchPath: string; // where this ticket's salvage patch lives, if it was dumped
  patchStale: boolean; // on disk, but older than the work it would have to contain
  hasPatch: boolean; // ...on disk AND new enough to be this worktree's salvage
}

// #217: what the prune step needs to know before it force-removes a lockless
// worktree. `reportsDir` is the project's ~/.zstack/projects/<slug>/reports --
// REQUIRED, not optional-with-a-default, so this check cannot be silently
// omitted by a caller the way #177's git facts could be. `probe` defaults to
// the real git probe; tests inject.
export interface SalvageProbe {
  reportsDir: string;
  probe?: (worktreePath: string) => WorktreeWork;
}

// What one worktree holds, as the prune guard judges it.
//
// `newestChangeMs` is the whole of the staleness half: nothing ever deletes
// reports/uncommitted-<N>.patch, so a patch dumped by a park weeks ago outlives
// its worktree and would satisfy a filename-existence check forever. The next
// time ticket N gets a worktree and leaves NEW uncommitted work in it, that
// ancient file would wave the force-remove through and the loss would be silent
// again -- the exact failure #217 exists to close, one re-park later. So the
// evidence is tied to THIS tree's current state: a patch older than the newest
// uncommitted path in the worktree cannot contain that path's contents.
export interface WorktreeWork {
  dirty: boolean;
  newestChangeMs: number; // newest mtime among the uncommitted paths; 0 when clean
}

// mtime in ms, or 0 for anything unreadable (deleted between the scan and the
// stat, a permission error). 0 never wins a Math.max and never makes a patch
// look fresh, so an unreadable path degrades to "no evidence", not "safe".
function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

// Does this worktree hold uncommitted work, and how new is it? Fail-CLOSED on a
// real worktree git cannot read (exit != 0 -> assume work is there AND that no
// patch could cover it, so the prune refuses and a human looks). A directory
// with no `.git` entry is not a git worktree at all -- git never knew it, `git
// diff` could not have salvaged it, and pruneWorktreeReal's rmSync fallback
// exists precisely for that leftover -- so it reads as clean rather than wedging
// every future reconcile on a stray dir.
export function worktreeWork(worktreePath: string): WorktreeWork {
  if (!existsSync(join(worktreePath, ".git"))) return { dirty: false, newestChangeMs: 0 };
  // -uall lists untracked FILES (not just their directory), so a never-added
  // test file contributes its own mtime; -z is the only quoting-proof format.
  const p = Bun.spawnSync(["git", "-C", worktreePath, "status", "--porcelain", "-uall", "-z"], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) return { dirty: true, newestChangeMs: Number.POSITIVE_INFINITY };
  const records = p.stdout.toString().split("\0").filter((s) => s.length > 0);
  if (records.length === 0) return { dirty: false, newestChangeMs: 0 };
  let newest = 0;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    // `XY <path>`; a rename/copy is followed by its ORIGINAL path as the next
    // record. That original no longer exists, so it is skipped as a record but
    // its removal still shows up in its parent directory's mtime below.
    if (rec[0] === "R" || rec[0] === "C") i++;
    const full = join(worktreePath, rec.slice(3));
    // A deleted path has no mtime of its own; deleting it bumps the mtime of the
    // directory that held it, which is what keeps a delete-only dirty tree from
    // reading as "newest change: never" and trusting an ancient patch.
    newest = Math.max(newest, mtimeMs(full) || mtimeMs(dirname(full)));
  }
  return { dirty: true, newestChangeMs: newest };
}

// Kept as the boolean shorthand the rest of the codebase reads more easily; the
// guard itself needs the mtime, so it calls worktreeWork directly.
export function worktreeDirty(worktreePath: string): boolean {
  return worktreeWork(worktreePath).dirty;
}

export interface Orphans {
  crashedLanes: CrashedLane[];
  orphanWorktrees: OrphanWorktree[];
  buildingWithoutState: number[]; // Building on the board with neither lock nor worktree
}

// Worktree directories, one per `ticket-<N>`. Tolerates a missing dir.
function listWorktrees(worktreesDir: string): { ticket: number; path: string }[] {
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
  nowMs: number,
  salvage: SalvageProbe
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

  const probe = salvage.probe ?? worktreeWork;
  const orphanWorktrees: OrphanWorktree[] = worktrees
    .filter((w) => !lockTickets.has(w.ticket))
    .map((w) => {
      const patchPath = join(salvage.reportsDir, salvagePatchName(w.ticket));
      const work = probe(w.path);
      // Existence is presence; the mtime is what makes it EVIDENCE for this
      // tree. A clean tree needs no patch at all, so staleness is only asked
      // about a dirty one.
      const patchMs = existsSync(patchPath) ? mtimeMs(patchPath) : 0;
      const patchStale = patchMs > 0 && work.dirty && patchMs < work.newestChangeMs;
      return {
        ticket: w.ticket,
        worktreePath: w.path,
        boardStatus: statusByTicket.get(w.ticket),
        dirty: work.dirty,
        newestChangeMs: work.newestChangeMs,
        patchPath,
        patchStale,
        hasPatch: patchMs > 0 && !patchStale,
      };
    });

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
  | { kind: "remove-lock"; ticket: number; path: string }
  // #217: the prune this plan REFUSES to make, the patch it looked for, and why
  // it did not count -- absent, older than the work, or unknowable because git
  // could not read the worktree at all.
  | { kind: "refuse-prune"; ticket: number; path: string; patchPath: string; reason: "missing" | "stale" | "unreadable" };

// Pure: orphans in, ordered action list out. For each crashed lane the board
// status decides the recovery (issue #14 C4):
//   * TERMINAL (Done/Questions/Blocked/Skipped): the work already landed or a
//     human parked it -- ONLY prune the worktree + remove the lock. Never release
//     or park, which would reopen merged work or undo a human's decision.
//   * INFLIGHT or unknown: release the assignee, prune its worktree (if present),
//     park it back to Ready, remove its lock -- the crash left it mid-build.
// A lockless worktree is pruned, and also released+parked when the board still
// thinks it in-flight -- UNLESS it holds uncommitted work with no salvage patch
// on disk (#217), in which case the plan refuses to touch it at all. A Building
// ticket with no on-disk state is released+parked.
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
    // #217: a lockless worktree is the shape the #177 exhausted-commit-retry park
    // leaves behind (parking releases the lane lock), and it is the ONE recovery
    // path whose only copy of real work may be uncommitted. Force-removing it
    // without a salvage patch destroys that work silently, so the plan refuses --
    // naming the file it looked for -- and does nothing else to that lane. The
    // guard costs exactly nothing once the dump ran (`loop apply` writes the
    // patch, so hasPatch is true) or when the tree is clean.
    //
    // Deliberately NOT extended to crashedLanes above: a crashed lane keeps its
    // lock, is parked back to Ready, and rebuilds fresh -- discarding its
    // uncommitted work is the documented, intended behaviour there (issue #2),
    // not an accident of a released lock.
    if (w.dirty && !w.hasPatch) {
      // An infinite newest-change is worktreeWork's "git could not read this
      // tree" sentinel: no patch can be proven newer than an unknown, so the
      // refusal is right, but calling it stale would send a human hunting for a
      // leftover patch instead of a broken worktree.
      const reason = !Number.isFinite(w.newestChangeMs) ? "unreadable" : w.patchStale ? "stale" : "missing";
      actions.push({ kind: "refuse-prune", ticket: w.ticket, path: w.worktreePath, patchPath: w.patchPath, reason });
      continue;
    }
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

// Returns the refusals (#217) rather than taking an effect for them: a refusal
// is not something to DO, it is the plan declining to do something, and the
// caller decides how loud that is (the CLI prints them and exits non-zero).
export type RefusePrune = Extract<ReconcileAction, { kind: "refuse-prune" }>;

export async function applyReconcile(actions: ReconcileAction[], fx: ReconcileEffects): Promise<RefusePrune[]> {
  const refused: RefusePrune[] = [];
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
      case "refuse-prune":
        refused.push(a);
        break;
    }
  }
  return refused;
}

// The operator-facing refusal text. One place, so `scan`'s JSON consumers and
// `apply`'s stderr say the same thing: which worktree, which patch was missing
// (or too old to be this worktree's salvage), and the two ways out.
export function refusalMessage(r: RefusePrune): string {
  const why =
    r.reason === "stale"
      ? `it has uncommitted work NEWER than the salvage patch at ${r.patchPath}, so that patch is a leftover from an earlier park and does not contain this work`
      : r.reason === "unreadable"
        ? `git could not read it, so whether it holds uncommitted work covered by ${r.patchPath} is unknowable`
        : `it has uncommitted work and no salvage patch at ${r.patchPath}`;
  return (
    `REFUSED to prune ${r.path}: ${why}.\n` +
    `  Force-removing it would discard the only copy (#217). Either:\n` +
    `    git -C "${r.path}" add -A && git -C "${r.path}" diff --cached --binary HEAD > "${r.patchPath}"\n` +
    `  (dump it, then re-run --reconcile), or commit the work onto the lane's branch and delete the worktree yourself.`
  );
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
// Since #217 this is only ever reached for a LOCKLESS worktree that is clean or
// already has its salvage patch -- reconcilePlan refuses the rest.
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
  apply  [--now MS] [--session ID]
                      execute the plan: release claims, park to Ready, prune worktrees,
                      remove stale locks (never deletes branches or comments).
                      REFUSES while a loop lock is live, since reconciling a
                      running loop parks its tickets and deletes its worktrees.
                      Also refuses (exit 1, worktree left in place) to force-remove
                      a lockless worktree that has uncommitted work and no salvage
                      patch in the project's reports dir -- or only one older than
                      that work, which is a leftover, not a salvage (#217).
                      --session is the owning loop's own id: /z-loop reconciles
                      AFTER taking the lock, so it passes its session to proceed.

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

// The whole of `apply`'s second half: execute the plan, print the summary, and
// return the process exit code. Exported (and board-free) so the #217 refusal's
// EXIT CODE is gate-testable -- Step 0(b) keys on it, and a refusal that printed
// but exited 0 would read as a successful reconcile and start the loop anyway.
export async function applyAndReport(plan: ReconcileAction[], fx: ReconcileEffects): Promise<number> {
  const refused = await applyReconcile(plan, fx);
  const counts = plan.reduce((m, a) => ((m[a.kind] = (m[a.kind] ?? 0) + 1), m), {} as Record<string, number>);
  console.log(`reconciled: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "nothing"}`);
  if (refused.length === 0) return 0;
  for (const r of refused) console.error(refusalMessage(r));
  console.error(`${refused.length} worktree(s) left in place; reconcile is INCOMPLETE.`);
  return 1;
}

// Throws unless it is safe to reconcile: the loop lock must be free, stale, or
// held by the caller itself (#198). Exported so the refusal is gate-testable
// without a board or a network call.
export function assertNotReconcilingLiveLoop(
  locksDir: string,
  nowMs: number,
  cfg: { lockStalenessMinutes?: number },
  session: string | undefined
): void {
  const stalenessMs = (cfg.lockStalenessMinutes ?? DEFAULT_LOCK_STALENESS_MINUTES) * 60_000;
  const st = inspectLoopLock(locksDir, nowMs, stalenessMs);
  if (st.state !== "live") return;
  if (session !== undefined && st.lock!.session === session) return; // our own recovery pass
  throw new ZError(
    `Refusing to reconcile: a /z-loop is running on this project in session ` +
      `"${st.lock!.session}". Reconciling would park its tickets back to Ready and ` +
      `delete its worktrees. Stop that loop first.`
  );
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

    // #198: refuse to reconcile a LIVE loop, before doing any work.
    //
    // Until now this module only ASSUMED the loop lock was free or stale (see the
    // comment on scanOrphans); nothing verified it. So a --reconcile run against a
    // live loop treated that loop's live lane locks as crashed lanes -- parking its
    // tickets back to Ready and force-deleting the running builders' worktrees.
    // The trigger was #198: a loop outliving lockStalenessMinutes read stale, and
    // the acquire error told the operator to reconcile.
    //
    // Checked BEFORE the board sweep so a refusal costs no GraphQL. The sanctioned
    // caller (z-loop/SKILL.md Step 0) reconciles AFTER taking the lock, so it
    // passes its own --session and is let through; a bare human invocation has no
    // session and refuses on any live lock, which is the safe default.
    if (cmd === "apply") assertNotReconcilingLiveLoop(locksDir, nowMs, cfg, str(flags, "session"));

    const orphans = scanOrphans(locksDir, worktreesDir, await sweep(board), nowMs, { reportsDir: reportsDir(cfg.slug) });
    const plan = reconcilePlan(orphans);

    if (cmd === "scan") {
      console.log(JSON.stringify({ hasOrphans: hasOrphans(orphans), orphans, plan }, null, 2));
      return 0;
    }
    if (cmd === "plan") {
      console.log(JSON.stringify(plan, null, 2));
      return 0;
    }
    return await applyAndReport(plan, realEffects(board));
  } catch (e) {
    return handleCliError(e);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
