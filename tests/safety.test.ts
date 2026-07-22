// Gate tests for C7 (issue #2): the six safety controls of the in-session
// /z-loop, remapped from super-board's headless runner. Every test is
// deterministic -- injected clocks, fixture executors, temp dirs -- with zero
// network and zero writes to a real ~/.zstack. Control -> test:
//
//   1. Second /z-loop refuses, naming the live session          -> "loop lock"
//   2. Crash -> restart detects orphans, reconcile parks + prunes -> "orphan scan"
//   3. Claim race: one proceeds, the loser never writes a lock   -> "claim race"
//   4. Lane cap: 5 queued, on-disk locks never exceed 3          -> "lane cap"
//   5. Quota exhaustion mid-loop: sweep pauses then resumes      -> "quota guard"
//   6. Human moves a ticket mid-loop: the lane stops cleanly     -> "wave reconcile"
import { test, expect, describe, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLoopLock,
  confirmIdentity,
  inspectLoopLock,
  laneLockPath,
  listLaneLocks,
  loopLockLiveness,
  loopLockPath,
  main as locksMain,
  processAlive,
  processStartTime,
  readLaneLock,
  readLoopLock,
  removeLaneLock,
  sameHost,
  writeLaneLock,
  type LoopLock,
} from "../lib/locks.ts";
import { ZError } from "../lib/config.ts";
import {
  applyReconcile,
  hasOrphans,
  reconcileBoardMoves,
  reconcilePlan,
  scanOrphans,
  sweep,
  type ReconcileAction,
  type ReconcileEffects,
} from "../lib/reconcile.ts";
import {
  applyAction,
  ingestBoardItems,
  nextAction,
  recordOutcome,
  type LaneState,
  type LoopState,
  type Stage,
  type TicketSnapshot,
} from "../lib/loop.ts";
import { Board, type GraphQLData, type GraphQLExecutor } from "../lib/board.ts";
import type { BoardConfig } from "../lib/config.ts";

const REPO_ROOT = join(import.meta.dir, "..");

// -- temp dirs (no real ~/.zstack ever touched) -------------------------------
const dirs: string[] = [];
function tmp(prefix = "zstack-safety-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// -- fixture builders (mirror tests/loop.test.ts) -----------------------------
function ticket(number: number, status: TicketSnapshot["status"], dependsOn: number[] = []): TicketSnapshot {
  return { number, title: `Ticket ${number}`, status, dependsOn, model: "sonnet" };
}
function lane(ticketNumber: number, stage: Stage, over: Partial<LaneState> = {}): LaneState {
  return { ticket: ticketNumber, stage, lastActivityMs: 0, qaBounces: 0, reviewBounces: 0, ...over };
}
function state(tickets: TicketSnapshot[], lanes: LaneState[] = [], maxLanes = 3): LoopState {
  return { tickets, lanes, maxLanes, watchdogMinutes: 10, mergedThisRun: [] };
}
const HAPPY: Record<Stage, string> = {
  builder: "BUILT: ok",
  qa: "QA-PASS: ok",
  reviewer: "REVIEW-APPROVE: confidence=100 ok", // clears the default 70 floor (issue #62)
  merge: "MERGED: https://pr/1",
};

// ============================================================================
// Control 1 -- second /z-loop refuses, naming the live session
// ============================================================================
describe("control 1: loop lock (second-invocation refusal)", () => {
  const STALE = 60 * 60_000; // 60 min staleness (config default)

  test("a live lock refuses a second acquire, naming the holder", () => {
    const d = tmp();
    const first = acquireLoopLock(d, { session: "sess-A", startedAt: 1000 }, { nowMs: 1000, stalenessMs: STALE });
    expect(first.acquired).toBe(true);

    const second = acquireLoopLock(d, { session: "sess-B", startedAt: 2000 }, { nowMs: 2000, stalenessMs: STALE });
    expect(second.acquired).toBe(false);
    expect(second.reason).toBe("live");
    expect(second.held!.session).toBe("sess-A"); // the message names the live session
    // The holder's lock is untouched (B never overwrote it).
    expect(readLoopLock(d)!.session).toBe("sess-A");
  });

  test("pid decides liveness: a dead pid reads stale, a live pid reads live", () => {
    const withPid = (pid: number): LoopLock => ({ session: "s", startedAt: 0, pid });
    expect(loopLockLiveness(withPid(4242), 0, STALE, () => false)).toBe("stale");
    expect(loopLockLiveness(withPid(4242), 0, STALE, () => true)).toBe("live");
    // Real check against this very process (definitely alive) and pid 1 semantics.
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(-1)).toBe(false);
  });

  test("no pid: age vs the staleness threshold is the heuristic", () => {
    const noPid: LoopLock = { session: "s", startedAt: 0 };
    expect(loopLockLiveness(noPid, STALE, STALE)).toBe("live"); // exactly at the budget
    expect(loopLockLiveness(noPid, STALE + 1, STALE)).toBe("stale"); // one ms past
  });

  // -- issue #14 H12: a recycled pid must not pin a lock "live forever" --------
  // (d) foreign host + (c) legacy/host-less lock: pid is unconfirmable -> age decides.
  test("pid-reuse safety: foreign-host / legacy locks fall back to age (--reconcile can clear)", () => {
    // A lock from ANOTHER machine. process.kill on THIS host may hit a coincidentally
    // -live local pid, but the lock isn't ours to verify -- identity is unconfirmable.
    const foreign: LoopLock = { session: "s", startedAt: 0, pid: 4242, host: "some-other-host" };
    expect(loopLockLiveness(foreign, STALE + 1, STALE, () => true)).toBe("stale"); // past staleness -> clearable
    expect(loopLockLiveness(foreign, STALE - 1, STALE, () => true)).toBe("live"); // within window -> don't nuke
    expect(loopLockLiveness(foreign, 0, STALE, () => false)).toBe("stale"); // dead pid -> stale, host regardless

    // (c) A same-host lock with NO stored start-time is a legacy lock -> unconfirmable
    // -> age decides, both directions (fresh -> live, old -> stale). This is what the
    // old same-host branch got wrong (it read "live" past staleness on pid alone).
    const legacy: LoopLock = { session: "s", startedAt: 0, pid: 4242, host: hostname() };
    expect(sameHost(legacy)).toBe(true);
    expect(loopLockLiveness(legacy, STALE + 1, STALE, () => true)).toBe("stale"); // old legacy lock -> clearable
    expect(loopLockLiveness(legacy, STALE - 1, STALE, () => true)).toBe("live"); // fresh legacy lock -> live

    // A host-less lock is unconfirmable too.
    const hostless: LoopLock = { session: "s", startedAt: 0, pid: 4242 };
    expect(loopLockLiveness(hostless, STALE + 1, STALE, () => true)).toBe("stale");

    // The three injected identity results drive the three outcomes directly.
    expect(loopLockLiveness(legacy, STALE + 1, STALE, () => true, () => "confirmed")).toBe("live"); // provably ours
    expect(loopLockLiveness(legacy, 0, STALE, () => true, () => "recycled")).toBe("stale"); // pid reused, mid-window
    expect(loopLockLiveness(legacy, STALE + 1, STALE, () => true, () => "unknown")).toBe("stale"); // age fallback
  });

  // (a) matching start-time -> live; (b) mismatched start-time on a REAL live pid ->
  // stale. Uses this very process (process.pid, definitely alive) and its real OS
  // start-time, so the whole shell-out roundtrip is exercised, not a stub.
  test("pid-reuse safety: same-host start-time identity (real roundtrip against this process)", () => {
    const realStart = processStartTime(process.pid);
    expect(realStart).not.toBeNull(); // the helper works on this platform

    // (a) matching start-time: reads live even PAST staleness -- the pid is provably
    // still our loop, so age is irrelevant.
    const mine: LoopLock = { session: "s", startedAt: 0, pid: process.pid, host: hostname(), startTime: realStart! };
    expect(loopLockLiveness(mine, STALE + 1, STALE)).toBe("live");

    // (b) mismatched stored start-time on the SAME real live pid: the OS recycled the
    // integer to an unrelated process -> stale/clearable even INSIDE the staleness
    // window (where a pure age check would wrongly say "live"). This is #14 item 12's
    // headline bug -- the same-host recycled pid that used to read "live forever".
    const recycled: LoopLock = { session: "s", startedAt: 0, pid: process.pid, host: hostname(), startTime: "1999-01-01T00:00:00.0000000+00:00" };
    expect(loopLockLiveness(recycled, 0, STALE)).toBe("stale");
  });

  test("confirmIdentity: same host + matching start-time confirms; mismatch is recycled; else unknown", () => {
    const realStart = processStartTime(process.pid)!;
    const ours: LoopLock = { session: "s", startedAt: 0, pid: process.pid, host: hostname(), startTime: realStart };
    expect(confirmIdentity(ours)).toBe("confirmed");
    expect(confirmIdentity({ ...ours, startTime: "1999-01-01T00:00:00.0000000+00:00" })).toBe("recycled");
    expect(confirmIdentity({ ...ours, host: "some-other-host" })).toBe("unknown"); // foreign host
    expect(confirmIdentity({ session: "s", startedAt: 0, pid: process.pid, host: hostname() })).toBe("unknown"); // legacy: no startTime
  });

  test("acquire records host AND the pid's start-time so a recycled pid is later detectable (H12)", () => {
    const d = tmp();
    // Drive the CLI acquire path (main()) so the host + start-time are recorded as in
    // production, not hand-set. --pid is this live process; its start-time is stored.
    const rc = locksMain(["acquire", "--dir", d, "--session", "s", "--pid", String(process.pid), "--now", "0"]);
    expect(rc).toBe(0);
    const written = readLoopLock(d)!;
    expect(written.host).toBe(hostname());
    // Non-null is a real invariant here: we are probing our OWN live pid, whose
    // start-time is always readable (the confirmIdentity test above relies on
    // the same fact).
    expect(written.startTime).toBe(processStartTime(process.pid)!); // the real start-time, roundtripped
  });

  test("a stale lock refuses without --reconcile, and is cleared with it", () => {
    const d = tmp();
    acquireLoopLock(d, { session: "crashed", startedAt: 0 }, { nowMs: 0, stalenessMs: STALE });
    const now = STALE + 10 * 60_000; // 70 min later: the crashed lock is stale

    const refuse = acquireLoopLock(d, { session: "fresh", startedAt: now }, { nowMs: now, stalenessMs: STALE });
    expect(refuse.acquired).toBe(false);
    expect(refuse.reason).toBe("stale");

    const recon = acquireLoopLock(d, { session: "fresh", startedAt: now }, { nowMs: now, stalenessMs: STALE, reconcile: true });
    expect(recon.acquired).toBe(true);
    expect(readLoopLock(d)!.session).toBe("fresh");
  });

  test("a LIVE lock never clears, even with --reconcile (never nuke a running loop)", () => {
    const d = tmp();
    acquireLoopLock(d, { session: "running", startedAt: 1000 }, { nowMs: 1000, stalenessMs: STALE });
    const res = acquireLoopLock(d, { session: "intruder", startedAt: 1500 }, { nowMs: 1500, stalenessMs: STALE, reconcile: true });
    expect(res.acquired).toBe(false);
    expect(res.reason).toBe("live");
    expect(readLoopLock(d)!.session).toBe("running");
  });

  test("inspect reports free / live / stale", () => {
    const d = tmp();
    expect(inspectLoopLock(d, 0, STALE).state).toBe("free");
    acquireLoopLock(d, { session: "s", startedAt: 0 }, { nowMs: 0, stalenessMs: STALE });
    expect(inspectLoopLock(d, 1000, STALE).state).toBe("live");
    expect(inspectLoopLock(d, STALE + 1, STALE).state).toBe("stale");
  });
});

// ============================================================================
// issue #14 H11 + M19 -- stale+reconcile CAS race, and staleness-flag validation
// ============================================================================
describe("stale+reconcile keeps the exclusive-create guard (H11)", () => {
  const LOCKS = join(REPO_ROOT, "lib", "locks.ts");
  const STALE = 60 * 60_000; // 60 min staleness (config default)

  // Seeds a definitely-stale loop lock (no pid, startedAt far in the past).
  function seedStale(dir: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(loopLockPath(dir), JSON.stringify({ session: "crashed", startedAt: 0 }) + "\n");
  }

  test("N concurrent --reconcile acquires against one stale lock: exactly one wins", async () => {
    const dir = tmp();
    seedStale(dir);
    const now = 10 * 60_000; // 10 min; --staleness-minutes 1 => the seeded lock is stale
    // Spawn several real processes racing the same stale lock in parallel.
    const procs = Array.from({ length: 6 }, (_, i) =>
      Bun.spawn(
        ["bun", LOCKS, "acquire", "--dir", dir, "--session", `sess-${i}`, "--reconcile", "--now", String(now), "--staleness-minutes", "1"],
        { stdout: "pipe", stderr: "pipe" }
      )
    );
    const codes = await Promise.all(procs.map((p) => p.exited));
    const winners = codes.filter((c) => c === 0).length;
    expect(winners).toBe(1); // never two loops both "acquiring" the same project
    // And a live lock is left behind (the winner's), readable back.
    expect(readLoopLock(dir)!.session).toMatch(/^sess-\d$/);
  });

  // The spawn race above can serialize by luck (one process finishes the whole
  // clear-and-replace before the next reads the lock), so it does NOT reliably fail
  // when the CAS is removed. This test forces the exact contended interleaving
  // deterministically: racer A is already inside the critical section (it holds the
  // one-shot claim file), and racer B reconciles concurrently. WITHOUT the CAS, B
  // would clear+overwrite and also "acquire" (two winners); WITH it, B sees A's claim
  // (EEXIST) and defers. Removing the CAS block makes this assertion fail.
  test("a second --reconcile deferring to an in-flight claim does NOT also acquire (CAS gate)", () => {
    const dir = tmp();
    const now = STALE + 1; // the seeded lock is stale at `now`
    seedStale(dir); // crashed loop's stale lock (no pid, startedAt 0)
    // Racer A is mid-reconcile: it holds the one-shot claim file (loop.lock.reconcile).
    writeFileSync(`${loopLockPath(dir)}.reconcile`, "racer-A\n");

    // Racer B reconciles the SAME stale lock at the same moment: it must defer to A.
    const res = acquireLoopLock(dir, { session: "racer-B", startedAt: now }, { nowMs: now, stalenessMs: STALE, reconcile: true });
    expect(res.acquired).toBe(false); // the CAS blocked the second winner
    expect(res.reason).toBe("stale"); // still stale under A's claim
    expect(readLoopLock(dir)!.session).toBe("crashed"); // B did NOT overwrite the lock
  });

  test("the stale+reconcile branch no longer unconditionally overwrites (structural)", () => {
    const src = readFileSync(LOCKS, "utf8");
    // The fix serializes the clear-and-replace through a one-shot claim file and
    // takes the lock with an exclusive create -- proof the CAS wasn't abandoned.
    expect(src).toContain(".reconcile"); // claim-file mutex
    expect(src).toMatch(/writeFileSync\(path, body, \{ flag: "wx"/); // exclusive create on the reconcile path
  });
});

describe("staleness-minutes validation (M19)", () => {
  const LOCKS = join(REPO_ROOT, "lib", "locks.ts");
  test("a non-numeric --staleness-minutes throws instead of yielding NaN", () => {
    const dir = tmp();
    acquireLoopLock(dir, { session: "s", startedAt: 0 }, { nowMs: 0, stalenessMs: 60_000 });
    const proc = Bun.spawnSync(
      ["bun", LOCKS, "inspect", "--dir", dir, "--staleness-minutes", "ten", "--now", "1000"],
      { stdout: "pipe", stderr: "pipe" }
    );
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toMatch(/staleness-minutes must be a positive number/);
  });

  test("a valid --staleness-minutes still works", () => {
    const dir = tmp();
    acquireLoopLock(dir, { session: "s", startedAt: 0 }, { nowMs: 0, stalenessMs: 60_000 });
    const proc = Bun.spawnSync(
      ["bun", LOCKS, "inspect", "--dir", dir, "--staleness-minutes", "5", "--now", "1000"],
      { stdout: "pipe", stderr: "pipe" }
    );
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString()).state).toBe("live");
  });
});

// ============================================================================
// Fix 6 -- lockfiles are written owner-only (0o600), never world-readable
// ============================================================================
describe("lockfile permissions", () => {
  test("a lane lock is written 0o600 (owner-only)", () => {
    const locksDir = tmp();
    writeLaneLock(locksDir, { ticket: 5, stage: "builder", session: "s", claimedAt: 0 });
    // fs mode bits don't map to POSIX perms on Windows; skip the assertion there
    // so the gate stays green cross-platform (the mode arg is a harmless no-op).
    if (process.platform === "win32") return;
    expect(statSync(laneLockPath(locksDir, 5)).mode & 0o777).toBe(0o600);
  });

  test("the loop lock is created 0o600 (owner-only)", () => {
    const locksDir = tmp();
    const res = acquireLoopLock(locksDir, { session: "s", startedAt: 0 }, { nowMs: 0, stalenessMs: 60_000 });
    expect(res.acquired).toBe(true);
    if (process.platform === "win32") return;
    expect(statSync(join(locksDir, "loop.lock")).mode & 0o777).toBe(0o600);
  });
});

// ============================================================================
// Control 2 -- crash simulation: restart detects orphans; reconcile parks + prunes
// ============================================================================
describe("control 2: orphan scan (crash recovery)", () => {
  function byKind(plan: ReconcileAction[], kind: ReconcileAction["kind"]): number[] {
    return plan.filter((a) => a.kind === kind).map((a) => (a as any).ticket).sort((x, y) => x - y);
  }

  test("scan finds all three orphan categories; plan parks to Ready and prunes", () => {
    const locksDir = tmp();
    const worktreesDir = tmp();
    // #5: crashed lane -- lock + worktree, board still Building.
    writeLaneLock(locksDir, { ticket: 5, stage: "builder", session: "dead", claimedAt: 0 });
    mkdirSync(join(worktreesDir, "ticket-5"));
    // #7: worktree with no lock, board still shows it in-flight (QA).
    mkdirSync(join(worktreesDir, "ticket-7"));
    // (a plain file that isn't a ticket dir must be ignored.)
    // #9: Building on the board with neither lock nor worktree.
    const board = [ticket(5, "Building"), ticket(7, "QA"), ticket(9, "Building")].map((t) => ({ number: t.number, status: t.status }));

    const orphans = scanOrphans(locksDir, worktreesDir, board, 30 * 60_000);
    expect(hasOrphans(orphans)).toBe(true);
    expect(orphans.crashedLanes.map((c) => c.ticket)).toEqual([5]);
    expect(orphans.crashedLanes[0].worktreePath).toContain("ticket-5");
    expect(orphans.orphanWorktrees.map((w) => w.ticket)).toEqual([7]);
    expect(orphans.buildingWithoutState).toEqual([9]);

    const plan = reconcilePlan(orphans);
    expect(byKind(plan, "park-ready")).toEqual([5, 7, 9]); // all three return to Ready
    expect(byKind(plan, "prune-worktree")).toEqual([5, 7]); // both worktrees pruned
    expect(byKind(plan, "remove-lock")).toEqual([5]); // only the crashed lane had a lock
    expect(byKind(plan, "release-claim")).toEqual([5, 7, 9]); // every parked ticket is released
  });

  test("a lockless worktree whose ticket is NOT in-flight is only pruned, not parked", () => {
    const locksDir = tmp();
    const worktreesDir = tmp();
    mkdirSync(join(worktreesDir, "ticket-3"));
    const orphans = scanOrphans(locksDir, worktreesDir, [{ number: 3, status: "Done" }], 0);
    const plan = reconcilePlan(orphans);
    expect(plan).toEqual([{ kind: "prune-worktree", ticket: 3, path: join(worktreesDir, "ticket-3") }]);
  });

  // -- issue #14 C4: a crashed lane's recovery depends on its board status ------
  test("a crashed lane whose ticket is TERMINAL is only pruned + unlocked, never reopened", () => {
    // #5 crashed AFTER its PR merged and the ticket moved to Done, but before the
    // lock was removed. Parking it back to Ready would rebuild already-merged work.
    const locksDir = tmp();
    const worktreesDir = tmp();
    writeLaneLock(locksDir, { ticket: 5, stage: "merge", session: "dead", claimedAt: 0 });
    mkdirSync(join(worktreesDir, "ticket-5"));
    const orphans = scanOrphans(locksDir, worktreesDir, [{ number: 5, status: "Done" }], 0);
    expect(orphans.crashedLanes[0].boardStatus).toBe("Done");

    const plan = reconcilePlan(orphans);
    expect(byKind(plan, "prune-worktree")).toEqual([5]);
    expect(byKind(plan, "remove-lock")).toEqual([5]);
    expect(byKind(plan, "park-ready")).toEqual([]); // NEVER reopen a Done ticket
    expect(byKind(plan, "release-claim")).toEqual([]); // NEVER unassign it either
  });

  test("each terminal status (Done/Questions/Blocked/Skipped) is pruned-only, INFLIGHT is parked", () => {
    for (const status of ["Done", "Questions", "Blocked", "Skipped"] as const) {
      const locksDir = tmp();
      writeLaneLock(locksDir, { ticket: 8, stage: "builder", session: "dead", claimedAt: 0 });
      const plan = reconcilePlan(scanOrphans(locksDir, tmp(), [{ number: 8, status }], 0));
      expect(byKind(plan, "park-ready")).toEqual([]);
      expect(byKind(plan, "remove-lock")).toEqual([8]);
    }
    // Contrast: a Building crashed lane IS released + parked + unlocked.
    const locksDir = tmp();
    writeLaneLock(locksDir, { ticket: 8, stage: "builder", session: "dead", claimedAt: 0 });
    const plan = reconcilePlan(scanOrphans(locksDir, tmp(), [{ number: 8, status: "Building" }], 0));
    expect(byKind(plan, "park-ready")).toEqual([8]);
    expect(byKind(plan, "release-claim")).toEqual([8]);
    expect(byKind(plan, "remove-lock")).toEqual([8]);
  });

  // -- issue #14 C4: sweep() must read the FULL board, not just INFLIGHT ---------
  // The C4 tests above feed scanOrphans a hand-built snapshot, so they never prove
  // sweep() actually PUTS a Done ticket's status into that snapshot. This drives the
  // real sweep()->scanOrphans->reconcilePlan chain against a fake board where the
  // crashed lane's ticket is Done. Reverting sweep()'s loop from BOARD_STATUSES to
  // INFLIGHT drops Done from the snapshot -> boardStatus undefined -> park+release
  // -> this test fails (merged work would be reopened).
  test("sweep() carries a Done crashed-lane's status through: pruned, never parked (C4 end-to-end)", async () => {
    const locksDir = tmp();
    const worktreesDir = tmp();
    // A crashed lane for ticket 5: lock + worktree left behind after a merge crash.
    writeLaneLock(locksDir, { ticket: 5, stage: "merge", session: "dead", claimedAt: 0 });
    mkdirSync(join(worktreesDir, "ticket-5"));

    // A fake board where ticket 5 is Done. sweep() lists every status; Board.list
    // filters this item set client-side, so it only surfaces under "Done".
    const doneBoard: GraphQLExecutor = async (query) => {
      const op = opName(query);
      if (op === "RateLimit") return { rateLimit: { remaining: 5000, resetAt: "2026-07-19T00:00:00Z" } };
      if (op === "ProjectItems")
        return {
          node: {
            items: {
              // Real responses always carry pageInfo (selected in the query);
              // the F3c malformed-response guard refuses a page without it.
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  content: { number: 5, title: "t5", url: "u5" },
                  fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Done", field: { name: "Status" } }] },
                },
              ],
            },
          },
        };
      throw new Error(`doneBoard: unexpected op ${op}`);
    };

    const snapshot = await sweep(new Board(CFG, doneBoard));
    expect(snapshot).toContainEqual({ number: 5, status: "Done" }); // sweep() saw the Done status

    const plan = reconcilePlan(scanOrphans(locksDir, worktreesDir, snapshot, 0));
    expect(byKind(plan, "park-ready")).toEqual([]); // NEVER reopen merged work
    expect(byKind(plan, "release-claim")).toEqual([]); // NEVER unassign it either
    expect(byKind(plan, "prune-worktree")).toEqual([5]); // just clear the crashed run's state
    expect(byKind(plan, "remove-lock")).toEqual([5]);
  });

  test("no orphans -> empty plan, hasOrphans false", () => {
    const orphans = scanOrphans(tmp(), tmp(), [ticket(1, "Ready")].map((t) => ({ number: t.number, status: t.status })), 0);
    expect(hasOrphans(orphans)).toBe(false);
    expect(reconcilePlan(orphans)).toEqual([]);
  });

  test("apply half executes each action: the lock file is actually removed", async () => {
    const locksDir = tmp();
    const worktreesDir = tmp();
    writeLaneLock(locksDir, { ticket: 5, stage: "builder", session: "dead", claimedAt: 0 });
    mkdirSync(join(worktreesDir, "ticket-5"));
    const lockPath = join(locksDir, "ticket-5.json");
    expect(existsSync(lockPath)).toBe(true);

    const orphans = scanOrphans(locksDir, worktreesDir, [{ number: 5, status: "Building" }], 0);
    const plan = reconcilePlan(orphans);

    const parked: number[] = [];
    const released: number[] = [];
    const pruned: string[] = [];
    const fx: ReconcileEffects = {
      removeLock: (p) => rmSync(p, { force: true }), // real fs, prove the file goes away
      pruneWorktree: (_t, p) => void pruned.push(p), // faked: no git in a temp dir
      parkReady: (n) => void parked.push(n),
      releaseClaim: (n) => void released.push(n),
    };
    await applyReconcile(plan, fx);

    expect(existsSync(lockPath)).toBe(false); // remove-lock ran for real
    expect(parked).toEqual([5]);
    expect(released).toEqual([5]);
    expect(pruned[0]).toContain("ticket-5");
  });
});

// ============================================================================
// Control 3 -- claim race: exactly one proceeds; the loser never writes a lock
// ============================================================================
// A stateful in-memory board backend (mirrors tests/board.test.ts): assignee
// mutations are additive and returned in assignment order, so the C2 contract's
// first-assignee-wins tiebreaker is what decides the race.
function opName(query: string): string {
  return query.match(/(?:query|mutation)\s+(\w+)/)![1];
}
function claimBackend(initial: string[] = []): GraphQLExecutor {
  const assignees = [...initial];
  const login = (userId: string) => userId.replace(/^U_/, "");
  return async (query, vars: any) => {
    switch (opName(query)) {
      case "RateLimit":
        return { rateLimit: { remaining: 5000, resetAt: "2026-07-19T00:00:00Z" } };
      case "IssueLookup":
        return { repository: { issue: { id: "I_9", number: 9, title: "t", body: "", assignees: { nodes: assignees.map((l) => ({ login: l })) }, projectItems: { nodes: [{ id: "PVTI_9", project: { number: 1 } }] } } } };
      case "UserId":
        return { user: { id: `U_${vars.login}` } };
      case "AddAssignees": {
        const l = login(vars.user);
        if (!assignees.includes(l)) assignees.push(l);
        return { addAssigneesToAssignable: { clientMutationId: null } };
      }
      case "RemoveAssignees": {
        const i = assignees.indexOf(login(vars.user));
        if (i >= 0) assignees.splice(i, 1);
        return { removeAssigneesFromAssignable: { clientMutationId: null } };
      }
      case "IssueAssignees":
        return { repository: { issue: { assignees: { nodes: assignees.map((l) => ({ login: l })) } } } };
      default:
        throw new Error(`claimBackend: unexpected op ${opName(query)}`);
    }
  };
}
const CFG: BoardConfig = {
  slug: "zstack",
  owner: "zacgoodwin",
  repo: "zstack",
  projectNumber: 1,
  projectId: "PVT_1",
  repositoryId: "R_1",
  statusField: {
    id: "F_status",
    dataType: "SINGLE_SELECT",
    options: { Backlog: "o0", Ready: "o1", Questions: "o2", Building: "o3", QA: "o4", Review: "o5", Blocked: "o6", Skipped: "o7", Done: "o8" },
  },
  fields: { Model: { id: "F_m", dataType: "SINGLE_SELECT", options: { opus: "o_op" } } },
  quota: { threshold: 200, mode: "sleep" },
};

describe("control 3: claim race (lock only after a won claim)", () => {
  // Mirrors the SKILL's claim row: z-board claim first, lane lock ONLY on success.
  async function claimThenLock(exec: GraphQLExecutor, locksDir: string, n: number, me: string, session: string, stage: Stage) {
    const board = new Board(CFG, exec);
    await board.claim(n, me); // throws for the loser -> the next line never runs
    writeLaneLock(locksDir, { ticket: n, stage, session, claimedAt: 0 });
  }

  test("two claimers, one proceeds; the loser leaves no lock behind", async () => {
    const locksDir = tmp();
    const exec = claimBackend(); // shared backend = the same GitHub issue
    const claimers = [
      { me: "alice", session: "sess-alice" },
      { me: "bob", session: "sess-bob" },
    ];
    const results = await Promise.allSettled(
      claimers.map((c) => claimThenLock(exec, locksDir, 9, c.me, c.session, "builder"))
    );
    const winners = results.map((r, i) => ({ r, c: claimers[i] })).filter((x) => x.r.status === "fulfilled");
    expect(winners.length).toBe(1); // exactly one claim proceeded

    const locks = listLaneLocks(locksDir);
    expect(locks.length).toBe(1); // the loser wrote nothing
    expect(locks[0].lock.session).toBe(winners[0].c.session); // the lock belongs to the winner
  });

  test("a claim lost to a prior assignee writes no lock", async () => {
    const locksDir = tmp();
    const exec = claimBackend(["someone-else"]); // already claimed
    await expect(claimThenLock(exec, locksDir, 9, "alice", "sess-alice", "builder")).rejects.toThrow(/already claimed/);
    expect(listLaneLocks(locksDir)).toEqual([]);
  });

  // -- issue #14 C8: claim identity is the LOGIN, not the session (documented) --
  test("a re-claim by the SAME login is a no-op -- the per-machine limitation's root", async () => {
    // This no-op is correct WITHIN one machine (a resume re-claims its own ticket),
    // but it is exactly why two loops under the same login on different machines
    // both see "already ours". The safe fix needs shared cross-machine state; the
    // limitation is documented loudly in lib/board.ts claim() and z-loop/SKILL.md.
    const exec = claimBackend(["alice"]); // already solely assigned to alice
    const board = new Board(CFG, exec);
    await expect(board.claim(9, "alice")).resolves.toBeUndefined(); // treated as already-ours, no throw

    // The limitation must be documented where an operator will see it.
    const skill = readFileSync(join(REPO_ROOT, "z-loop", "SKILL.md"), "utf8");
    expect(skill).toMatch(/same (github )?login on different machines/i);
    const boardSrc = readFileSync(join(REPO_ROOT, "lib", "board.ts"), "utf8");
    expect(boardSrc).toMatch(/KNOWN LIMITATION/);
  });
});

// ============================================================================
// Control 4 -- lane cap: 5 queued, on-disk locks never exceed 3
// ============================================================================
describe("control 4: lane cap enforced at the locks layer", () => {
  // Drives the reducer to drain, mirroring every lane on disk exactly as the
  // SKILL does (write on claim/advance, remove at lane end). The peak count of
  // lock FILES is the physical proof the cap held.
  function driveWithLocks(s: LoopState, locksDir: string): { peakLocks: number; end: LoopState } {
    let peakLocks = 0;
    for (let i = 0; i < 500; i++) {
      const a = nextAction(s, 0);
      if (a.kind === "drain-complete") return { peakLocks, end: s };
      if (a.kind === "wait") {
        const idle = s.lanes.find((l) => !l.outcome);
        if (!idle) throw new Error("wait with no lane to progress");
        s = recordOutcome(s, idle.ticket, HAPPY[idle.stage], 0);
        continue;
      }
      if (a.kind === "claim") writeLaneLock(locksDir, { ticket: a.ticket, stage: a.stage, session: "s", claimedAt: 0 });
      else if (a.kind === "advance") writeLaneLock(locksDir, { ticket: a.ticket, stage: a.to, session: "s", claimedAt: 0 });
      else if (a.kind === "park" || a.kind === "skip" || a.kind === "complete" || a.kind === "stop-lane") removeLaneLock(locksDir, a.ticket);
      s = applyAction(s, a, 0);
      peakLocks = Math.max(peakLocks, listLaneLocks(locksDir).length);
    }
    throw new Error("no drain within 500 steps");
  }

  test("5 queued tickets: at most 3 lane locks on disk at once, none left at the end", () => {
    const locksDir = tmp();
    const s = state([1, 2, 3, 4, 5].map((n) => ticket(n, "Building")));
    const { peakLocks, end } = driveWithLocks(s, locksDir);
    expect(peakLocks).toBe(3); // never more than maxLanes locks coexist
    expect(end.tickets.every((t) => t.status === "Done")).toBe(true);
    expect(listLaneLocks(locksDir)).toEqual([]); // every lock removed at lane end
  });

  test("a smaller maxLanes caps the on-disk locks too", () => {
    const locksDir = tmp();
    const { peakLocks } = driveWithLocks(state([1, 2, 3, 4].map((n) => ticket(n, "Building")), [], 1), locksDir);
    expect(peakLocks).toBe(1);
  });
});

// ============================================================================
// Control 5 -- quota exhaustion mid-loop: the board sweep pauses, then resumes
// ============================================================================
describe("control 5: quota guard (pause/resume, no bypass)", () => {
  const at = (iso: string) => Date.parse(iso);
  const LOW: GraphQLData = { rateLimit: { remaining: 150, resetAt: "2026-07-18T23:30:00Z" } };
  const HEALTHY: GraphQLData = { rateLimit: { remaining: 5000, resetAt: "2026-07-19T00:00:00Z" } };

  // Executor for a loop board sweep: RateLimit responses come from a queue (low
  // first, then healthy = the window reset); list ops return empty item sets.
  function sweepExecutor(rateLimits: GraphQLData[], calls: string[]): GraphQLExecutor {
    let i = 0;
    return async (query) => {
      const op = opName(query);
      calls.push(op);
      if (op === "RateLimit") return rateLimits[Math.min(i++, rateLimits.length - 1)];
      if (op === "ProjectItems") return { node: { items: { nodes: [] } } };
      throw new Error(`unexpected op ${op}`);
    };
  }

  test("remaining < threshold mid-sweep sleeps until reset, then resumes", async () => {
    const slept: number[] = [];
    const calls: string[] = [];
    const board = new Board(
      CFG,
      sweepExecutor([LOW, HEALTHY], calls),
      async (ms) => void slept.push(ms),
      () => at("2026-07-18T23:00:00Z")
    );
    // The loop's board sweep: list several statuses in a row.
    await board.list("Building"); // probe LOW -> pause
    await board.list("QA"); // probe HEALTHY -> resume, no pause
    await board.list("Review");
    expect(slept).toEqual([at("2026-07-18T23:30:00Z") - at("2026-07-18T23:00:00Z")]); // paused exactly once, 30 min
  });

  test("no code path reaches the executor without the guard (runtime proof)", async () => {
    const calls: string[] = [];
    const board = new Board(CFG, sweepExecutor([HEALTHY], calls), async () => {});
    await board.list("Building");
    await board.move(0, "Ready").catch(() => {}); // move probes too; item lookup may 404, fine
    // Every real backend op is immediately preceded by a RateLimit probe.
    for (let i = 0; i < calls.length; i++) {
      if (calls[i] !== "RateLimit") expect(calls[i - 1]).toBe("RateLimit");
    }
    expect(calls.filter((c) => c === "ProjectItems").length).toBeGreaterThan(0);
  });

  test("no code path reaches the executor without the guard (structural proof)", () => {
    const src = readFileSync(join(REPO_ROOT, "lib", "board.ts"), "utf8");
    // Every this.exec() call is either the single dynamic-query funnel (gql) or
    // the zero-cost rate-limit probe. There is exactly ONE dynamic exec, so no
    // subcommand can pass an arbitrary query to the backend except through gql.
    const execArgs = [...src.matchAll(/this\.exec\((\w+)/g)].map((m) => m[1]);
    expect(execArgs.filter((a) => a !== "Q_RATE_LIMIT")).toEqual(["query"]);
    // ...and that single funnel is guarded: enforceQuota runs immediately before it.
    expect(src).toMatch(/enforceQuota\(\);\s*return this\.exec\(query, variables\);/);
    // Real operations go through gql (the guarded funnel), many of them.
    expect([...src.matchAll(/this\.gql\(/g)].length).toBeGreaterThan(5);
  });
});

// ============================================================================
// Control 6 -- human moves a ticket mid-loop: the lane stops cleanly at a boundary
// ============================================================================
describe("control 6: wave reconciliation (mid-loop human moves)", () => {
  test("reconcileBoardMoves flags a lane whose ticket was parked by a human", () => {
    const tickets = [ticket(5, "Blocked"), ticket(6, "Building"), ticket(7, "Questions")];
    const lanes = [lane(5, "builder"), lane(6, "builder")];
    // #5 was moved to Blocked and #6 is still Building -> only #5 stops. #7 has
    // no lane, so it is not in the set.
    expect([...reconcileBoardMoves(tickets, lanes)].sort()).toEqual([5]);
  });

  test("a mid-stage lane is NOT stopped until its boundary; then stop-lane fires", () => {
    // #5's ticket is Blocked but its builder is still running (no outcome yet):
    // the reducer must not kill it -- it schedules the other lane's work instead.
    let s = state([ticket(5, "Blocked"), ticket(6, "Building")], [lane(5, "builder"), lane(6, "builder")]);
    const a1 = nextAction(s, 0);
    expect(a1.kind).not.toBe("stop-lane"); // no boundary reached for #5 yet

    // #5's stage finishes (outcome recorded) -> now it is at a boundary.
    s = recordOutcome(s, 5, HAPPY.builder, 0);
    const a2 = nextAction(s, 0);
    expect(a2).toMatchObject({ kind: "stop-lane", ticket: 5 });
  });

  test("stop-lane drops the lane, honors the human's status, and other lanes finish", () => {
    // Two live lanes; a human drags #5 to Blocked mid-run. Re-ingest (the board
    // re-read the SKILL does before each transition) picks up the move.
    let s = state([ticket(5, "Building"), ticket(6, "Building")], [lane(5, "builder"), lane(6, "builder")]);
    s = recordOutcome(s, 5, HAPPY.builder, 0); // #5's builder finished (a boundary)
    s = ingestBoardItems(
      s,
      [
        { number: 5, title: "t5", fields: { Status: "Blocked" } }, // human move
        { number: 6, title: "t6", fields: { Status: "Building" } },
      ],
      { "5": "", "6": "" }
    );
    expect(s.lanes.find((l) => l.ticket === 5)!.outcome).toBeDefined(); // ingest preserved the lane

    const stop = nextAction(s, 0);
    expect(stop).toMatchObject({ kind: "stop-lane", ticket: 5 });
    s = applyAction(s, stop, 0);
    expect(s.lanes.some((l) => l.ticket === 5)).toBe(false); // lane dropped
    expect(s.tickets.find((t) => t.number === 5)!.status).toBe("Blocked"); // human's status honored, not overwritten

    // #6 is untouched and drains to Done normally.
    for (let i = 0; i < 50 && s.lanes.length; i++) {
      const a = nextAction(s, 0);
      if (a.kind === "drain-complete") break;
      if (a.kind === "wait") {
        const idle = s.lanes.find((l) => !l.outcome)!;
        s = recordOutcome(s, idle.ticket, HAPPY[idle.stage], 0);
        continue;
      }
      s = applyAction(s, a, 0);
    }
    expect(s.tickets.find((t) => t.number === 6)!.status).toBe("Done");
  });
});

// ============================================================================
// issue #14 item 18 -- corrupt-lock ZErrors on the crash-recovery path
// ============================================================================
// A crash can leave a half-written or hand-mangled lock on disk. Every read
// path (readLaneLock, listLaneLocks, readLoopLock, and acquire's EEXIST
// inspection) must surface a ZError naming the file -- actionable via
// handleCliError -- never a raw SyntaxError, and never silently treat the
// slot as free.
describe("item 18: corrupt locks fail with ZErrors on the recovery path", () => {
  test("an unparseable lane lock raises a ZError naming the file, not a raw SyntaxError", () => {
    const d = tmp();
    writeFileSync(join(d, "ticket-3.json"), "{ definitely not json");
    let caught: unknown;
    try {
      readLaneLock(d, 3);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ZError);
    expect(caught).not.toBeInstanceOf(SyntaxError);
    expect((caught as ZError).message).toMatch(/ticket-3\.json is not valid JSON/);
  });

  test("a structurally invalid lane lock names the required shape", () => {
    const d = tmp();
    writeFileSync(join(d, "ticket-3.json"), JSON.stringify({ ticket: 3, stage: "builder" })); // no session/claimedAt
    expect(() => readLaneLock(d, 3)).toThrow(ZError);
    expect(() => readLaneLock(d, 3)).toThrow(/ticket-3\.json must be \{ticket, stage, session, claimedAt\}/);
  });

  test("a lane lock with wrong-typed fields is structurally invalid, not accepted", () => {
    const d = tmp();
    writeFileSync(
      join(d, "ticket-4.json"),
      JSON.stringify({ ticket: "4", stage: "builder", session: "s", claimedAt: "now" }) // strings where numbers belong
    );
    expect(() => readLaneLock(d, 4)).toThrow(/must be \{ticket, stage, session, claimedAt\}/);
  });

  // -- F13: only a MISSING locks dir reads as "no lanes" ----------------------
  test("a missing locks dir still reads as no lanes (fresh project)", () => {
    expect(listLaneLocks(join(tmp(), "never-created"))).toEqual([]);
  });

  test("a locks 'dir' that is actually a FILE raises ZError naming the path, not []", () => {
    // readdir on a file fails ENOTDIR (not ENOENT) -- swallowing that into []
    // rendered a plausible-but-false idle dashboard. Same for EACCES/EPERM.
    const notADir = join(tmp(), "locks");
    writeFileSync(notADir, "i am a file");
    let caught: unknown;
    try {
      listLaneLocks(notADir);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ZError);
    expect((caught as ZError).message).toContain(notADir);
  });

  test("the crash-recovery sweep (listLaneLocks) surfaces a corrupt lock loudly", () => {
    const d = tmp();
    writeLaneLock(d, { ticket: 1, stage: "builder", session: "s", claimedAt: 0 });
    writeFileSync(join(d, "ticket-2.json"), "%%%");
    expect(() => listLaneLocks(d)).toThrow(ZError);
    expect(() => listLaneLocks(d)).toThrow(/ticket-2\.json is not valid JSON/);
  });

  test("an unparseable loop lock raises a ZError, and acquire refuses instead of clobbering", () => {
    const d = tmp();
    writeFileSync(loopLockPath(d), "not json at all");
    let caught: unknown;
    try {
      readLoopLock(d);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ZError);
    expect((caught as ZError).message).toMatch(/loop\.lock is not valid JSON/);

    // The recovery path proper: a fresh acquire hits EEXIST, inspects the
    // incumbent, and must surface the corruption -- not read it as free/stale
    // and steal the slot.
    expect(() =>
      acquireLoopLock(d, { session: "fresh", startedAt: 10 }, { nowMs: 10, stalenessMs: 60_000 })
    ).toThrow(/loop\.lock is not valid JSON/);
    expect(readFileSync(loopLockPath(d), "utf8")).toBe("not json at all"); // incumbent untouched
  });

  test("a structurally invalid loop lock names the required shape through inspect", () => {
    const d = tmp();
    writeFileSync(loopLockPath(d), JSON.stringify({ session: "s" })); // no startedAt
    expect(() => readLoopLock(d)).toThrow(ZError);
    expect(() => readLoopLock(d)).toThrow(/loop\.lock must be \{session, startedAt, pid\?\}/);
    expect(() => inspectLoopLock(d, 0, 60_000)).toThrow(/must be \{session, startedAt, pid\?\}/);
  });
});
