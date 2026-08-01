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
import { basename, join } from "node:path";
import { Board, ghExecutor } from "./board.ts";
import { handleCliError, parseFlags, str, type ParsedArgs } from "./cli.ts";
import { DEFAULT_LOCK_STALENESS_MINUTES, TERMINAL_STATUSES, ZError, loadConfig } from "./config.ts";
import { defaultLocksDir, inspectLoopLock, listLaneLocks, type LaneLock } from "./locks.ts";
import { BOARD_STATUSES, type BoardStatus, type LaneState, type TicketSnapshot } from "./loop.ts";
import { liveAgentsIn, subagentsDirFor } from "./transcripts.ts";

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
  throwawayWorktrees: OrphanWorktree[]; // leftover `review-<N>` reviewer scratch checkouts (#209)
  buildingWithoutState: number[]; // Building on the board with neither lock nor worktree
}

// A lane's own worktree: exactly `ticket-<N>`.
const LANE_WORKTREE_RE = /^ticket-(\d+)$/;

// The reviewer's throwaway checkout (#209). `.worktrees/review-<N>`, plus the
// suffixed variants a fanned-out review adds (`review-<N>-lead`, `-base`). It
// belongs to no lane and holds no work -- it is a detached checkout of the head
// commit the reviewer and its skeptics read -- so it is ALWAYS pruned and NEVER
// parked or released: the number in the name is the ticket the review was for,
// not a lane to recover.
//
// Reconcile owns these because #209 gated their in-run removal on the whole
// reviewer subtree going quiet, which makes "left behind" the ordinary outcome
// rather than the exception. The only other sweep is z-loop/SKILL.md Step 7's
// batch cleanup, which a `context-clear` pause or any crash skips by design, and
// before this scan matched nothing but `ticket-<N>` they were invisible here too
// -- so they accumulated across runs (nine were sitting in this repo when #209's
// QA looked).
const THROWAWAY_WORKTREE_RE = /^review-(\d+)(?:-[A-Za-z0-9._-]+)?$/;

// Worktree directories: the lanes' own `ticket-<N>` plus the reviewer's
// throwaway `review-<N>` scratch checkouts. Tolerates a missing dir.
function listWorktrees(worktreesDir: string): { ticket: number; path: string; throwaway: boolean }[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(worktreesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { ticket: number; path: string; throwaway: boolean }[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const lane = e.name.match(LANE_WORKTREE_RE);
    const throwaway = lane ? null : e.name.match(THROWAWAY_WORKTREE_RE);
    const m = lane ?? throwaway;
    if (!m) continue;
    out.push({ ticket: Number(m[1]), path: join(worktreesDir, e.name), throwaway: throwaway !== null });
  }
  // Two throwaways can share a ticket (`review-9`, `review-9-lead`), so the path
  // breaks the tie and the order stays deterministic.
  return out.sort((a, b) => a.ticket - b.ticket || a.path.localeCompare(b.path));
}

// The leftover reviewer scratch checkouts alone, for the batch-end sweep that
// runs without a board snapshot (CLI `sweep-review`).
export function listThrowawayWorktrees(worktreesDir: string): { ticket: number; path: string }[] {
  return listWorktrees(worktreesDir)
    .filter((w) => w.throwaway)
    .map(({ ticket, path }) => ({ ticket, path }));
}

// Is this path one of the reviewer's throwaway checkouts? Used to hold those
// prunes back while an agent of this session may still be inside one.
export function isThrowawayWorktreePath(path: string): boolean {
  return THROWAWAY_WORKTREE_RE.test(basename(path));
}

// What the review-worktree sweep may remove RIGHT NOW (#209).
//
// The removal itself is unconditional in the sense that a throwaway holds no
// work -- but WHEN it may happen is the whole point of this ticket: `.worktrees/
// review-<N>` is where the reviewer's skeptics execute, and they outlive the
// parent that spawned them (the reviewer contract checks each skeptic at most
// once and stops waiting, so returning with skeptics still running is the
// DESIGNED case, not an anomaly). #66's review removed that worktree out from
// under two live skeptics, and a sweep that ignores liveness is the same defect
// with a different trigger: on the last lane, drain-complete fires minutes after
// the reviewer returned.
//
// So the sweep is gated on the same evidence the in-stage teardown uses --
// whether any agent of THIS session is still running (liveAgentsIn; parentage is
// not needed and not available here, since a leftover directory carries no stage
// tag). All-or-nothing rather than per-worktree, because a live agent's own
// transcript does not say which checkout it is reading.
//
// The gate is what makes the two sanctioned call sites honest: Step 0, where the
// session has spawned nothing yet (empty/absent subagents dir -> sweep proceeds,
// and the loop lock it was just handed proves no OTHER loop is running), and
// Step 7, where it now declines whenever anything is still live instead of
// force-removing under it. Declining costs one leftover directory until the next
// run's Step 0 -- the same cheap direction the in-stage gate fails in.
// The same hold, applied to a reconcile plan: with anything of this session
// still live, the throwaway prunes drop out and every other action still runs
// (a wedged lane's recovery must not wait on a skeptic). Pure, so the rule is
// gate-testable without a git worktree.
export function holdLiveThrowawayPrunes(plan: ReconcileAction[], live: string[]): ReconcileAction[] {
  if (live.length === 0) return plan;
  return plan.filter((a) => !(a.kind === "prune-worktree" && isThrowawayWorktreePath(a.path)));
}

export function planReviewSweep(opts: {
  worktreesDir: string;
  // Undefined = no session transcript resolved for this cwd, i.e. no Claude Code
  // session is running here to have spawned anything. Sweeps.
  subagentsDir: string | undefined;
  now?: number;
  quietMs?: number;
  staleMs?: number;
}): { paths: string[]; live: string[] } {
  const live =
    opts.subagentsDir === undefined
      ? []
      : liveAgentsIn(opts.subagentsDir, { now: opts.now, quietMs: opts.quietMs, staleMs: opts.staleMs });
  const found = listThrowawayWorktrees(opts.worktreesDir).map((w) => w.path);
  return { paths: live.length > 0 ? [] : found, live };
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
  const all = listWorktrees(worktreesDir);
  const worktrees = all.filter((w) => !w.throwaway);
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

  // No lock lookup and no board status: a throwaway has neither by construction.
  const throwawayWorktrees: OrphanWorktree[] = all
    .filter((w) => w.throwaway)
    .map((w) => ({ ticket: w.ticket, worktreePath: w.path }));

  const buildingWithoutState = boardSnapshot
    .filter((t) => t.status === "Building" && !lockTickets.has(t.number) && !wtByTicket.has(t.number))
    .map((t) => t.number)
    .sort((a, b) => a - b);

  return { crashedLanes, orphanWorktrees, throwawayWorktrees, buildingWithoutState };
}

// Deliberately does NOT count throwawayWorktrees. hasOrphans is the startup
// REFUSAL gate (z-loop/SKILL.md Step 0b: orphans + no --reconcile => refuse), and
// a leftover `review-<N>` is not a wedge -- it is a scratch checkout nobody owns.
// Since #209 made leftovers the ordinary outcome, counting them here would refuse
// to start the loop after almost every run. They are still pruned by the plan
// below whenever reconcile does run, and swept unconditionally by Step 0's
// `sweep-review` and Step 7's batch cleanup.
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
  // Throwaway reviewer checkouts: prune only. Never release or park -- the number
  // in `review-<N>` names the ticket the review was for, and that ticket may well
  // be Done (merged) by now; parking it back to Ready would rebuild landed work.
  for (const w of orphans.throwawayWorktrees) {
    actions.push({ kind: "prune-worktree", ticket: w.ticket, path: w.worktreePath });
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
  sweep-review [--worktrees D] [--project-dir D] [--subagents-dir D]
               [--quiet-ms MS] [--stale-ms MS]
                      remove leftover throwaway reviewer worktrees (.worktrees/review-<N>)
                      and nothing else. No board read, no locks, no slug needed --
                      z-loop/SKILL.md Step 0 / Step 7 cleanup, as a command instead of
                      prose. Prints the paths removed, one per line, then a count.
                      REMOVES NOTHING while any sub-agent of this session has not
                      been observed finishing: the skeptics execute inside those
                      worktrees and outlive the reviewer that spawned them (#209).
                      --worktrees is the directory scanned, default <cwd>/.worktrees
                      -- run it from the repo root or pass the flag, or it sweeps a
                      directory that does not exist and reports 0 either way.
                      --stale-ms is the ceiling past which a transcript nobody has
                      written to reads finished whatever its last record was
                      (default 8h, SUBTREE_STALE_MS): the override for a session
                      holding an agent that was killed mid-tool-call.
  apply  [--now MS] [--session ID]
                      execute the plan: release claims, park to Ready, prune worktrees,
                      remove stale locks (never deletes branches or comments).
                      REFUSES while a loop lock is live, since reconciling a
                      running loop parks its tickets and deletes its worktrees.
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

// Where the liveness gate looks for this session's sub-agent transcripts.
// --subagents-dir wins outright (the gate tests point it at a fixture);
// otherwise it is derived from --project-dir / cwd by the same resolver
// `transcripts collect` uses, so the two can never consult different sessions.
function reviewSweepSubagentsDir(flags: ParsedArgs["flags"]): string | undefined {
  return str(flags, "subagents-dir") ?? subagentsDirFor(str(flags, "project-dir") ?? process.cwd());
}

// --quiet-ms / --stale-ms: the two liveness windows (lib/transcripts.ts). The
// gate tests inject both to pin their boundaries; the operator override matters
// for --stale-ms, which is the way out when a session holds an agent that was
// killed mid-tool-call and would otherwise hold the sweep for its full ceiling.
function msFlag(flags: ParsedArgs["flags"], name: string): number | undefined {
  const v = str(flags, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ZError(`--${name} must be a non-negative number of milliseconds, got ${JSON.stringify(v)}.`);
  return n;
}

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  if (!["scan", "plan", "apply", "sweep-review"].includes(cmd)) {
    console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
    return 1;
  }
  try {
    const { flags } = parseFlags(argv.slice(1));
    const nowMs = Number(str(flags, "now") ?? Date.now());

    // sweep-review touches nothing but throwaway reviewer checkouts, so it runs
    // before the config load and the board client: Step 7 calls it with the loop
    // lock still held, and a batch-end cleanup must not be able to fail on a
    // GraphQL quota or a missing project config.
    if (cmd === "sweep-review") {
      const dir = str(flags, "worktrees") ?? join(process.cwd(), ".worktrees");
      const { paths, live } = planReviewSweep({
        worktreesDir: dir,
        subagentsDir: reviewSweepSubagentsDir(flags),
        now: nowMs,
        quietMs: msFlag(flags, "quiet-ms"),
        staleMs: msFlag(flags, "stale-ms"),
      });
      // Declining is a normal outcome, not an error: nothing waits on this sweep
      // (a leftover scratch checkout is litter, never a wedge), and exiting
      // non-zero here would fail a batch-end cleanup step for doing the safe
      // thing. Say who is live so the operator can see why.
      if (live.length > 0) {
        console.log(
          `swept 0 of ${listThrowawayWorktrees(dir).length} throwaway review worktree(s): ` +
            `${live.length} agent(s) of this session have not been observed finishing (${live.join(", ")}), ` +
            `and a skeptic still reading .worktrees/review-<N> must not have it removed underneath it (#209). ` +
            `They wait for the next sweep that finds the session quiet. If you know it is not -- an agent killed ` +
            `mid-tool-call never reports finished until its transcript goes stale -- re-run with --stale-ms.`
        );
        return 0;
      }
      for (const p of paths) {
        pruneWorktreeReal(p);
        console.log(p);
      }
      console.log(`swept ${paths.length} throwaway review worktree(s)`);
      return 0;
    }

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
    // `apply` is the OTHER path that force-removes review worktrees, so it takes
    // the same liveness hold as sweep-review (#209). Its own #198 guard proves no
    // other loop is running, and the one sanctioned caller (Step 0, --session)
    // has spawned nothing yet -- so in practice nothing is ever held here. That
    // is the point of doing it anyway: the invariant is "no path removes a review
    // worktree while an agent of this session might be inside one", and an
    // invariant with one unchecked path is not one.
    const live = planReviewSweep({
      worktreesDir,
      subagentsDir: reviewSweepSubagentsDir(flags),
      now: nowMs,
      quietMs: msFlag(flags, "quiet-ms"),
      staleMs: msFlag(flags, "stale-ms"),
    }).live;
    const runnable = holdLiveThrowawayPrunes(plan, live);
    await applyReconcile(runnable, realEffects(board));
    const counts = runnable.reduce((m, a) => ((m[a.kind] = (m[a.kind] ?? 0) + 1), m), {} as Record<string, number>);
    const held = plan.length - runnable.length;
    console.log(
      `reconciled: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "nothing"}` +
        (held > 0 ? ` (held ${held} review-worktree prune(s): ${live.length} agent(s) of this session still live)` : "")
    );
    return 0;
  } catch (e) {
    return handleCliError(e);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
