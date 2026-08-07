// Gate tests for C6's deterministic core: the loop state machine (lib/loop.ts)
// and lane scheduling (lib/lanes.ts), driven entirely against in-memory fixture
// snapshots -- no network, no real agents, no wall clock (nowMs injected
// everywhere). Covers the issue #8 acceptance criteria that are unit-testable:
// lane cap (AC2), fresh-stage lane state (AC4), watchdog -> Skipped (AC5),
// Questions never claimable (AC6), plus dependency-order claiming, merge
// ordering with a stacked chain, and drain-complete detection.
import { test, expect, describe, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ABANDONED_CLAIM_TICKET_BUDGETS,
  abandonedClaimBoundMs,
  applyAction,
  applyConfirmations,
  boardWriteFor,
  builtGuardFailure,
  canTransition,
  claimConfirmed,
  confirmTargets,
  drainComplete,
  humanNeededStatus,
  humanNeededTripped,
  clearsClaim,
  ingestBoardItems,
  markClaimLost,
  markHumanNeededNotified,
  countSuiteRuns,
  detectGateScripts,
  foundNoTestFiles,
  isLaneBranch,
  laneWorktreePath,
  mergeGate,
  mergeGateBaseKey,
  observeLaneHeads,
  MERGE_GATE_BUDGET_MS,
  MERGE_GATE_MAX_RUNS,
  MERGE_GATE_RETRY_WAIT_MS,
  nextAction,
  parseAssignees,
  parseSuiteFailCount,
  stripAnsi,
  parseReviewerConfidence,
  parseSkepticQuorum,
  parseStageResult,
  partitionKnownStatus,
  MAX_COMMIT_RETRIES,
  MAX_DEAD_RESPAWNS,
  MAX_QUORUM_RETRIES,
  STAGE_CEILING_MINUTES,
  recordActivity,
  recordConfirmAttempt,
  recordMergeGate,
  recordOutcome,
  recordProbe,
  resolveStageModel,
  slugFromStatePath,
  stageAttempt,
  STATUS_FOR_STAGE,
  worktreeHoldsWork,
  type Action,
  type GateScripts,
  type LaneState,
  type LoopState,
  type Stage,
  type StageOutcome,
  type SuiteRun,
  type TicketSnapshot,
} from "../lib/loop.ts";
import {
  DEFAULT_MIN_SKEPTIC_QUORUM,
  DEFAULT_STAGE_WATCHDOG_MINUTES,
  DEFAULT_WATCHDOG_MINUTES,
  resolveWatchdogMinutes,
  ZError,
} from "../lib/config.ts";
// #307: the placeholder-coverage test derives the contract's template lines from the
// REAL rendered prompts, so rewording a prompt cannot leave a template that parses
// as a live verdict.
import { builderPrompt, mergePrompt, qaPrompt, reviewerPrompt } from "../lib/stage-prompts.ts";
import {
  MEASURED_MAX_STAGE_MS,
  MEASURED_MIDWORK_GAP_MS,
  MEASURED_STAGE_SILENCE_MS,
  SUBTREE_QUIET_MS,
  SUBTREE_STALE_MS,
  spawnTag,
} from "../lib/transcripts.ts";
import { SPAWN_TAG_MARKER } from "../lib/stage-prompts.ts";
import { isWorkableStatus } from "../lib/lanes.ts";
import { defaultLoopDir } from "../lib/throttle.ts";
import { validateConfig } from "../lib/config-schema.ts";
import {
  claimableTickets,
  claimStage,
  deadDeps,
  mergeOrder,
  mergeOrderProbe,
  parseDependsOn,
  selectBatch,
  watchdogExpired,
} from "../lib/lanes.ts";
import type { BoardStatus } from "../lib/loop.ts";
import { ALLOWED_LANE_KEYS } from "../evals/e2e/assertions.ts";

const REPO_ROOT = join(import.meta.dir, "..");

// -- source pinning -----------------------------------------------------------

test("lib/lanes.ts has no CLI entrypoint (import.meta.main is removed)", () => {
  const source = readFileSync(join(REPO_ROOT, "lib", "lanes.ts"), "utf8");
  expect(source).not.toContain("import.meta.main");
  expect(source).not.toContain("export function main");
  expect(source).not.toContain("const USAGE");
});

// -- fixture builders ---------------------------------------------------------

function ticket(number: number, status: TicketSnapshot["status"], dependsOn: number[] = [], over: Partial<TicketSnapshot> = {}): TicketSnapshot {
  return { number, title: `Ticket ${number}`, status, dependsOn, model: "sonnet", ...over };
}

function lane(ticketNumber: number, stage: Stage, over: Partial<LaneState> = {}): LaneState {
  return { ticket: ticketNumber, stage, lastActivityMs: 0, qaBounces: 0, reviewBounces: 0, ...over };
}

// #191: a review-approve outcome. `skeptics` is the skeptic-delivery denominator
// the quorum gate reads; null means "no adversarial fan-out reported one", which
// is what every case written before #191 meant -- so those cases keep judging
// exactly the confidence floor they were written for, and the quorum path is
// exercised by its own describe block below.
function approve(confidence: number | null, skeptics: { received: number; of: number } | null = null): StageOutcome {
  return { kind: "review-approve", confidence, skeptics };
}

function state(tickets: TicketSnapshot[], lanes: LaneState[] = [], maxLanes = 3, watchdogMinutes = 10): LoopState {
  return { tickets, lanes, maxLanes, watchdogMinutes, mergedThisRun: [] };
}

// The happy-path final message per stage, for simulation. The reviewer's
// confidence=100 clears the default 70 floor (issue #62) so every existing
// drain-to-Done flow below is unaffected by the gate.
const HAPPY: Record<Stage, string> = {
  builder: "BUILT: all criteria pass",
  qa: "QA-PASS: functional + technical green",
  reviewer: "REVIEW-APPROVE: confidence=100 diff satisfies every criterion",
  merge: "MERGED: https://github.com/x/y/pull/1",
};

// A green merge-gate verdict, the shape `loop merge-gate --state` stamps (#178).
const GREEN_GATE = { green: true, attempts: 1, failCount: 0, note: "merge gate GREEN on attempt 1: 0 fail, exit 0" };

// Drives the state machine to drain, feeding every stage a happy-path outcome.
// Returns the action log and the peak concurrent-lane count.
function drainHappy(s: LoopState): { state: LoopState; log: Action[]; maxConcurrent: number } {
  const log: Action[] = [];
  let maxConcurrent = 0;
  for (let i = 0; i < 500; i++) {
    const a = nextAction(s, 0);
    log.push(a);
    if (a.kind === "drain-complete") return { state: s, log, maxConcurrent };
    if (a.kind === "wait") {
      const idle = s.lanes.find((l) => !l.outcome);
      if (!idle) throw new Error("wait with no lane to progress -- scheduler stuck");
      s = recordOutcome(s, idle.ticket, HAPPY[idle.stage], 0);
      continue;
    }
    if (a.kind === "check-worker") throw new Error("unexpected watchdog in happy path");
    // #178: the loop gates every merge itself. On the happy path the gauntlet
    // is green, which is what unlocks the advance to merge.
    if (a.kind === "merge-gate") {
      s = recordMergeGate(s, a.ticket, GREEN_GATE, 0);
      continue;
    }
    s = applyAction(s, a, 0);
    maxConcurrent = Math.max(maxConcurrent, s.lanes.length);
  }
  throw new Error("no drain-complete within 500 steps");
}

// -- lane cap (AC2) -----------------------------------------------------------

describe("lane cap", () => {
  test("5 queued tickets never exceed 3 concurrent lanes and all reach Done", () => {
    const s = state([1, 2, 3, 4, 5].map((n) => ticket(n, "Building")));
    const { state: end, log, maxConcurrent } = drainHappy(s);
    expect(maxConcurrent).toBe(3);
    expect(end.tickets.every((t) => t.status === "Done")).toBe(true);
    // The lane log: exactly 5 claims, and the 4th claim comes only after a completion.
    const claims = log.filter((a) => a.kind === "claim");
    expect(claims.length).toBe(5);
    const fourthClaim = log.findIndex((a) => a.kind === "claim" && a.ticket === 4);
    const firstComplete = log.findIndex((a) => a.kind === "complete");
    expect(firstComplete).toBeGreaterThan(-1);
    expect(fourthClaim).toBeGreaterThan(firstComplete);
  });

  test("a smaller maxLanes is respected", () => {
    const s = state([1, 2, 3].map((n) => ticket(n, "Building")), [], 1);
    const { maxConcurrent } = drainHappy(s);
    expect(maxConcurrent).toBe(1);
  });
});

// -- dependency-order claiming ------------------------------------------------

describe("dependency-order claiming", () => {
  test("a chain claims strictly in dependency order", () => {
    const s = state([ticket(10, "Building"), ticket(11, "Building", [10]), ticket(12, "Building", [11])]);
    expect(claimableTickets(s.tickets, s.lanes).map((t) => t.number)).toEqual([10]);
    const { state: end, log } = drainHappy(s);
    const claimIdx = (n: number) => log.findIndex((a) => a.kind === "claim" && a.ticket === n);
    const completeIdx = (n: number) => log.findIndex((a) => a.kind === "complete" && a.ticket === n);
    expect(claimIdx(11)).toBeGreaterThan(completeIdx(10)); // 11 waits for 10 to be Done
    expect(claimIdx(12)).toBeGreaterThan(completeIdx(11));
    expect(end.tickets.every((t) => t.status === "Done")).toBe(true);
  });

  test("a dep absent from the snapshot counts as merged", () => {
    const s = state([ticket(40, "Building", [7])]); // #7 landed in an earlier batch
    expect(claimableTickets(s.tickets, s.lanes).map((t) => t.number)).toEqual([40]);
  });

  test("claim resumes at the stage matching the ticket's status", () => {
    const s = state([ticket(50, "QA"), ticket(51, "Review")]);
    const a = nextAction(s, 0);
    expect(a).toEqual({ kind: "claim", ticket: 50, stage: "qa" });
    const s2 = applyAction(s, a, 0);
    expect(nextAction(s2, 0)).toEqual({ kind: "claim", ticket: 51, stage: "reviewer" });
  });
});

// -- Questions tickets (AC6) --------------------------------------------------

describe("Questions tickets", () => {
  test("a Questions ticket is never claimable and never claimed", () => {
    const s = state([ticket(5, "Questions"), ticket(6, "Building")]);
    expect(claimableTickets(s.tickets, s.lanes).map((t) => t.number)).toEqual([6]);
    const { state: end, log } = drainHappy(s);
    expect(log.some((a) => a.kind === "claim" && a.ticket === 5)).toBe(false);
    expect(end.tickets.find((t) => t.number === 5)!.status).toBe("Questions");
    expect(end.tickets.find((t) => t.number === 6)!.status).toBe("Done");
  });

  test("a dependent of a Questions ticket parks in Blocked, not a busy-wait", () => {
    const s = state([ticket(5, "Questions"), ticket(7, "Building", [5])]);
    const a = nextAction(s, 0);
    expect(a).toEqual({
      kind: "park",
      ticket: 7,
      status: "Blocked",
      note: expect.stringContaining("#5 (Questions)"),
    });
    const s2 = applyAction(s, a, 0);
    expect(nextAction(s2, 0)).toEqual({ kind: "drain-complete" });
  });
});

// -- issue #14 item 18: the claimStage guard ----------------------------------

describe("claimStage guard (item 18)", () => {
  const CLAIMABLE: [BoardStatus, Stage][] = [
    ["Ready", "builder"],
    ["Building", "builder"],
    ["QA", "qa"],
    ["Review", "reviewer"],
  ];
  const UNCLAIMABLE: BoardStatus[] = ["Backlog", "Questions", "Blocked", "Skipped", "Done"];

  test("each claimable status maps to its entry stage", () => {
    for (const [status, stage] of CLAIMABLE) expect(claimStage(status)).toBe(stage);
  });

  test("every non-claimable status is rejected with a ZError naming the status", () => {
    for (const status of UNCLAIMABLE) {
      expect(() => claimStage(status)).toThrow(ZError);
      expect(() => claimStage(status)).toThrow(`Status "${status}" is not claimable.`);
    }
  });
});

// -- watchdog (AC5) -----------------------------------------------------------

describe("watchdog", () => {
  const MIN = 60_000;

  test("expiry boundary: exactly the budget is alive, one ms past is expired", () => {
    const l = lane(1, "builder", { lastActivityMs: 0 });
    expect(watchdogExpired(l, 10 * MIN, 10)).toBe(false);
    expect(watchdogExpired(l, 10 * MIN + 1, 10)).toBe(true);
  });

  test("silent lane -> check-worker; dead -> Skipped with note; other lanes continue", () => {
    let s = state(
      [ticket(1, "Building"), ticket(2, "Building")],
      [lane(1, "builder", { lastActivityMs: 0 }), lane(2, "builder", { lastActivityMs: 10 * MIN })]
    );
    const now = 11 * MIN;
    // Silent past the budget: probe first, never skip blind.
    expect(nextAction(s, now)).toEqual({ kind: "check-worker", ticket: 1 });
    // Probe says dead: skip with a note.
    s = recordProbe(s, 1, false, now);
    const skip = nextAction(s, now);
    expect(skip).toEqual({ kind: "skip", ticket: 1, note: expect.stringContaining("watchdog") });
    s = applyAction(s, skip, now);
    expect(s.tickets.find((t) => t.number === 1)!.status).toBe("Skipped");
    // The loop continues with the other lane: ticket 2 finishes normally.
    s = recordOutcome(s, 2, HAPPY.builder, now);
    expect(nextAction(s, now)).toEqual({ kind: "advance", ticket: 2, to: "qa" });
  });

  test("probe says alive: baseline refreshes and no skip fires", () => {
    let s = state([ticket(1, "Building")], [lane(1, "builder", { lastActivityMs: 0 })]);
    const now = 11 * MIN;
    expect(nextAction(s, now).kind).toBe("check-worker");
    s = recordProbe(s, 1, true, now);
    expect(nextAction(s, now)).toEqual({ kind: "wait" });
  });

  // -- silence, not stage age (#256) ------------------------------------------
  //
  // The defect: lastActivityMs was written ONLY by stage events (claim, advance,
  // respawn, outcome, an alive probe), so the subtraction above measured how long
  // ago the stage STARTED. A QA stage is ordered to run typecheck + the full suite
  // + the build before it touches an acceptance criterion -- 121s idle, 234s
  // loaded on this repo -- so every QA stage crossed the default budget while
  // perfectly healthy, and the machine's answers are check-worker and, on a dead
  // probe, a skip that discards the ticket.
  //
  // recordActivity is what makes the number mean what its name says. The
  // observation itself (lib/transcripts.ts subtreeActivityMs) is a filesystem
  // read, so it happens at the tick boundary and the reducer takes a number --
  // same split as nowMs.
  describe("recordActivity (#256)", () => {
    const CLAIMED = 0;
    const NOW = 25 * MIN; // a QA stage 25 minutes into its work

    test("AC1: a stage well past the budget whose subtree is still appending is NOT probed", () => {
      const s = state([ticket(1, "QA")], [lane(1, "qa", { lastActivityMs: CLAIMED })]);
      // Before the heartbeat this is the defect, verbatim: 25 minutes of stage age
      // against a 10-minute budget, and the machine reaches for the worker.
      expect(nextAction(s, NOW)).toEqual({ kind: "check-worker", ticket: 1 });
      // Its subtree appended 30 seconds ago -- the agent is working.
      const beat = recordActivity(s, 1, NOW - 30_000);
      expect(beat.lanes[0].lastActivityMs).toBe(NOW - 30_000);
      expect(nextAction(beat, NOW)).toEqual({ kind: "wait" });
      // pure: the input state is untouched
      expect(s.lanes[0].lastActivityMs).toBe(CLAIMED);
    });

    test("AC2: a stage whose subtree went silent still expires, and the dead-probe skip is unchanged", () => {
      let s = state([ticket(1, "QA")], [lane(1, "qa", { lastActivityMs: CLAIMED })]);
      // Newest append 40 minutes ago: silence, whatever the stage's age.
      s = recordActivity(s, 1, NOW - 40 * MIN);
      expect(nextAction(s, NOW)).toEqual({ kind: "check-worker", ticket: 1 });
      s = recordProbe(s, 1, false, NOW);
      const skip = nextAction(s, NOW);
      // Byte-identical to the note the pre-#256 machine produced for this lane.
      expect(skip).toEqual({
        kind: "skip",
        ticket: 1,
        note: "Worker died mid-qa: silent past the 10-minute watchdog and not alive on probe. Skipped per the PROCESS.md no-token-burn rule; worktree left for inspection.",
      });
    });

    test("AC3: the heartbeat is monotonic -- an older observation never moves the baseline back", () => {
      const s = state([ticket(1, "QA")], [lane(1, "qa", { lastActivityMs: 20 * MIN })]);
      // A subtree whose newest record predates the lane's own baseline (a stage
      // that has written nothing since it was claimed, or a re-spawn reading its
      // dead predecessor's transcripts). Moving backwards here would EXPIRE a lane
      // the stage-age reading considers alive -- strictly worse than today.
      expect(recordActivity(s, 1, 5 * MIN).lanes[0].lastActivityMs).toBe(20 * MIN);
      expect(recordActivity(s, 1, 20 * MIN).lanes[0].lastActivityMs).toBe(20 * MIN);
      expect(recordActivity(s, 1, 20 * MIN + 1).lanes[0].lastActivityMs).toBe(20 * MIN + 1);
    });

    test("AC3: an unobservable subtree is a no-op, not a park -- the lane keeps its stage-age behavior", () => {
      const s = state([ticket(1, "QA")], [lane(1, "qa", { lastActivityMs: CLAIMED })]);
      // Every fail-open answer subtreeActivityMs can give arrives here as one of
      // these, and none of them may change a thing.
      for (const bad of [undefined, NaN, Infinity, -Infinity]) {
        const after = recordActivity(s, 1, bad);
        expect(after.lanes[0].lastActivityMs).toBe(CLAIMED);
        expect(after).toEqual(s);
      }
      // ...so the watchdog still fires on stage age alone, exactly as it did before
      // this ticket. Degrading, never parking, is the whole fail-open contract.
      expect(nextAction(recordActivity(s, 1, undefined), NOW)).toEqual({ kind: "check-worker", ticket: 1 });
    });

    test("a heartbeat for a ticket no lane holds is a loud error, not a silent write", () => {
      const s = state([ticket(1, "QA")], [lane(1, "qa")]);
      expect(() => recordActivity(s, 9, 1)).toThrow(ZError);
      expect(() => recordActivity(s, 9, 1)).toThrow("No lane holds #9");
    });

    // The boundary AC2 of the ticket keeps: exactly the budget is still in budget.
    // Restated over an OBSERVED baseline rather than a stage-start one, since that
    // is what the number means now.
    test("the expiry boundary holds on an observed baseline", () => {
      const s = recordActivity(state([ticket(1, "QA")], [lane(1, "qa", { lastActivityMs: 0 })]), 1, 5 * MIN);
      expect(watchdogExpired(s.lanes[0], 15 * MIN, 10)).toBe(false);
      expect(watchdogExpired(s.lanes[0], 15 * MIN + 1, 10)).toBe(true);
    });
  });

  // -- per-stage budgets (#256) ------------------------------------------------
  //
  // One global number had to serve a merge stage that runs `gh pr merge` and a
  // reviewer that sits blocked on three background skeptics. Measured, those two
  // are 12x apart in how long they legitimately go quiet (merge max 97s, reviewer
  // max 1,161s), so a single budget is either far too patient for one or fatal to
  // the other.
  describe("per-stage watchdog budgets (#256)", () => {
    const laneAt = (stage: Stage) => lane(1, stage, { lastActivityMs: 0 });

    test("the object form applies each stage's own number", () => {
      const s = state([ticket(1, "QA")], [], 3);
      s.watchdogMinutes = { builder: 25, qa: 15, reviewer: 40, merge: 15 };
      // Each stage is alive AT its own budget and expired one ms past it, and the
      // numbers are genuinely different per stage -- a resolver that fell back to
      // one value would fail at least three of these.
      for (const [stage, budget] of [["builder", 25], ["qa", 15], ["reviewer", 40], ["merge", 15]] as const) {
        const l = laneAt(stage);
        expect(watchdogExpired(l, budget * MIN, resolveWatchdogMinutes(s.watchdogMinutes, stage))).toBe(false);
        expect(watchdogExpired(l, budget * MIN + 1, resolveWatchdogMinutes(s.watchdogMinutes, stage))).toBe(true);
      }
    });

    test("a scalar still applies to every stage, identical to pre-#256", () => {
      const s = state([ticket(1, "QA")], [], 3);
      s.watchdogMinutes = 10;
      for (const stage of ["builder", "qa", "reviewer", "merge"] as const) {
        expect(resolveWatchdogMinutes(s.watchdogMinutes, stage)).toBe(10);
      }
      // ...and end to end through nextAction, which is where it matters: a qa lane
      // silent 10 minutes exactly is in budget, one ms later it is probed.
      const s10 = state([ticket(1, "QA")], [lane(1, "qa", { lastActivityMs: 0 })]);
      expect(nextAction(s10, 10 * MIN)).toEqual({ kind: "wait" });
      expect(nextAction(s10, 10 * MIN + 1)).toEqual({ kind: "check-worker", ticket: 1 });
    });

    test("a partial object is a one-stage override; every other stage keeps its default", () => {
      const partial = { reviewer: 90 };
      expect(resolveWatchdogMinutes(partial, "reviewer")).toBe(90);
      expect(resolveWatchdogMinutes(partial, "qa")).toBe(DEFAULT_STAGE_WATCHDOG_MINUTES.qa);
      expect(resolveWatchdogMinutes(partial, "builder")).toBe(DEFAULT_STAGE_WATCHDOG_MINUTES.builder);
      // No config at all is the whole table, not the scalar -- the case that would
      // silently strand the derivation if ingest or loadConfig filled a number.
      expect(resolveWatchdogMinutes(undefined, "merge")).toBe(DEFAULT_STAGE_WATCHDOG_MINUTES.merge);
    });

    // A budget of `undefined` would make `nowMs - base > undefined * 60_000`
    // evaluate NaN, and `x > NaN` is false -- the watchdog silently off for that
    // lane. Reachable only from a hand-edited or half-written state.json, and
    // silent enough to be worth the floor.
    test("an unknown stage on a corrupt state resolves to the floor, never undefined", () => {
      const bogus = "qa2" as unknown as Stage;
      expect(resolveWatchdogMinutes({ qa: 15 }, bogus)).toBe(DEFAULT_WATCHDOG_MINUTES);
      expect(resolveWatchdogMinutes(undefined, bogus)).toBe(DEFAULT_WATCHDOG_MINUTES);
      // ...and the lane still expires rather than living forever.
      const l = lane(1, bogus, { lastActivityMs: 0 });
      expect(watchdogExpired(l, DEFAULT_WATCHDOG_MINUTES * MIN + 1, resolveWatchdogMinutes(undefined, bogus))).toBe(true);
    });

    test("an ingest with no --watchdog-minutes carries the per-stage table into state", () => {
      const s = ingestBoardItems(null, [{ number: 1, title: "T", fields: { Status: "Ready" } }], { "1": "" });
      expect(s.watchdogMinutes).toEqual(DEFAULT_STAGE_WATCHDOG_MINUTES);
    });

    // Both ceilings, per stage. The floor exists because a per-family sample is
    // small: qa's 293 subtrees hold nothing longer than 174.8s, which says nothing
    // about the agent-level 423.1s ceiling measured over a 22x larger population.
    // Shipping 2 x 174.8s = 6 minutes for QA would kill any QA agent that sits on
    // one slow build.
    test("every shipped per-stage default clears BOTH measured ceilings by 2x", () => {
      for (const stage of ["builder", "qa", "reviewer", "merge"] as const) {
        const budgetMs = DEFAULT_STAGE_WATCHDOG_MINUTES[stage] * 60_000;
        expect(budgetMs).toBeGreaterThanOrEqual(2 * MEASURED_MIDWORK_GAP_MS);
        expect(budgetMs).toBeGreaterThanOrEqual(2 * MEASURED_STAGE_SILENCE_MS[stage]);
      }
      // The two stages whose own measurement is what sets them, so a future
      // re-measurement that lowers them cannot silently pass on the floor alone.
      expect(DEFAULT_STAGE_WATCHDOG_MINUTES.reviewer * 60_000).toBeGreaterThanOrEqual(2 * 1_161_119);
      expect(DEFAULT_STAGE_WATCHDOG_MINUTES.builder * 60_000).toBeGreaterThanOrEqual(2 * 607_966);
      // And no stage is quietly below the global floor.
      for (const stage of ["builder", "qa", "reviewer", "merge"] as const) {
        expect(DEFAULT_STAGE_WATCHDOG_MINUTES[stage]).toBeGreaterThanOrEqual(DEFAULT_WATCHDOG_MINUTES);
      }
    });

    test("the dead-worker note names the stage's OWN budget, not a global one", () => {
      let s = state([ticket(1, "Review")], [lane(1, "reviewer", { lastActivityMs: 0 })]);
      s.watchdogMinutes = { reviewer: 40 };
      const now = 41 * MIN;
      expect(nextAction(s, now)).toEqual({ kind: "check-worker", ticket: 1 });
      s = recordProbe(s, 1, false, now);
      const skip = nextAction(s, now) as { note: string };
      expect(skip.note).toContain("40-minute watchdog");
    });
  });

  // -- the cumulative ceiling (#256) -------------------------------------------
  //
  // An ALIVE probe refreshes lastActivityMs with no memory of the probes before
  // it, so a wedged-but-registered worker was probed alive every budget-period
  // forever -- holding its ticket, worktree, lock and one of maxLanes slots. Every
  // other retry in the pack is outcome-driven; elapsed time had no bound at all.
  describe("STAGE_CEILING_MINUTES (#256)", () => {
    const started = 0;
    const overCeiling = STAGE_CEILING_MINUTES * MIN + 1;

    test("a lane past the ceiling parks Blocked, naming the stage, the elapsed time and the ceiling", () => {
      const s = state([ticket(1, "QA")], [lane(1, "qa", { lastActivityMs: overCeiling, stageStartedMs: started })]);
      const a = nextAction(s, overCeiling) as { kind: string; ticket: number; status: string; note: string; salvage?: true };
      expect(a.kind).toBe("park");
      expect(a.status).toBe("Blocked");
      expect(a.ticket).toBe(1);
      expect(a.note).toContain("qa stage");
      expect(a.note).toContain(`${STAGE_CEILING_MINUTES}-minute`);
      expect(a.note).toContain("480 minutes"); // the elapsed reading, in the note
      // The lane may still be writing files it never committed, and parking
      // releases the lane lock -- so the worktree is dumped, like every other
      // action that strands one (#209's salvage contract).
      expect(a.salvage).toBe(true);
      // ...and the park is terminal for the lane.
      const after = applyAction(s, a as Action, overCeiling);
      expect(after.lanes).toEqual([]);
      expect(after.tickets[0].status).toBe("Blocked");
    });

    // AC5 of the ticket, as the sequence it describes: probe ALIVE every budget
    // period. On main this never terminates.
    test("an alive-probe loop terminates instead of running forever", () => {
      let s = state([ticket(1, "QA")], [lane(1, "qa", { lastActivityMs: 0, stageStartedMs: 0 })]);
      const budget = resolveWatchdogMinutes(s.watchdogMinutes, "qa");
      let now = 0;
      let probes = 0;
      let parked = false;
      // Generously more rounds than the ceiling allows, so a non-terminating
      // machine fails this by exhausting the loop rather than by timing out.
      for (let i = 0; i < 200; i++) {
        now += budget * MIN + 1;
        const a = nextAction(s, now);
        if (a.kind === "park") {
          parked = true;
          expect((a as { status: string }).status).toBe("Blocked");
          expect((a as { note: string }).note).toContain("ALIVE");
          break;
        }
        expect(a).toEqual({ kind: "check-worker", ticket: 1 });
        probes++;
        s = recordProbe(s, 1, true, now); // the worker is registered: alive, forever
      }
      expect(parked).toBe(true);
      // It probed for the whole ceiling first -- the bound is elapsed time, not a
      // probe count, so a lane that answers alive is still given its full budget.
      expect(probes).toBeGreaterThan(20);
      expect(now).toBeGreaterThan(STAGE_CEILING_MINUTES * MIN);
    });

    test("the ceiling is checked even while the lane is NOT silent", () => {
      // The failure mode a ceiling folded into the expiry branch would have: a
      // worker probed alive one second ago is not silent, so an expiry-gated
      // ceiling is unreachable on exactly the lanes it exists to end.
      const s = state([ticket(1, "QA")], [lane(1, "qa", { lastActivityMs: overCeiling, stageStartedMs: started })]);
      expect(watchdogExpired(s.lanes[0], overCeiling, resolveWatchdogMinutes(s.watchdogMinutes, "qa"))).toBe(false);
      expect(nextAction(s, overCeiling).kind).toBe("park");
    });

    test("exactly the ceiling is still in budget; one ms past parks", () => {
      const s = state([ticket(1, "QA")], [lane(1, "qa", { lastActivityMs: STAGE_CEILING_MINUTES * MIN, stageStartedMs: 0 })]);
      expect(nextAction(s, STAGE_CEILING_MINUTES * MIN)).toEqual({ kind: "wait" });
      expect(nextAction(s, STAGE_CEILING_MINUTES * MIN + 1).kind).toBe("park");
    });

    test("a lane with a recorded outcome is never ceiling-parked", () => {
      // Its stage finished; the machine is about to advance it. Parking here would
      // throw away work that is done and reported.
      let s = state([ticket(1, "QA")], [lane(1, "qa", { lastActivityMs: 0, stageStartedMs: 0 })]);
      s = recordOutcome(s, 1, HAPPY.qa, overCeiling);
      expect(nextAction(s, overCeiling)).toEqual({ kind: "advance", ticket: 1, to: "reviewer" });
    });

    test("a pre-#256 lane with no stageStartedMs is never parked (fail open)", () => {
      const s = state([ticket(1, "QA")], [lane(1, "qa", { lastActivityMs: 0 })]);
      expect(s.lanes[0].stageStartedMs).toBeUndefined();
      // Silent past its budget, so the watchdog still works -- but no ceiling.
      expect(nextAction(s, 10 * 60 * MIN)).toEqual({ kind: "check-worker", ticket: 1 });
    });

    test("a merge lane's note carries the H9 warning instead of a bare return-to-Ready", () => {
      const s = state([ticket(1, "Review")], [lane(1, "merge", { lastActivityMs: 0, stageStartedMs: 0 })]);
      const a = nextAction(s, overCeiling) as { note: string };
      expect(a.note).toContain("gh pr view");
      expect(a.note).toContain("may have landed");
    });

    // stageStartedMs is the field the heartbeat must NOT touch. If recordActivity
    // moved it, the ceiling would reset on every observation and bound nothing --
    // which is the same defect as the alive probe, reintroduced through the fix.
    test("only stage ENTRY moves stageStartedMs -- not the heartbeat, a probe, or an outcome", () => {
      let s = state([ticket(1, "Building")], []);
      s = applyAction(s, { kind: "claim", ticket: 1, stage: "builder" }, 1_000);
      expect(s.lanes[0].stageStartedMs).toBe(1_000);
      s = recordActivity(s, 1, 5_000);
      expect(s.lanes[0].lastActivityMs).toBe(5_000);
      expect(s.lanes[0].stageStartedMs).toBe(1_000); // unmoved
      s = recordProbe(s, 1, true, 9_000);
      expect(s.lanes[0].stageStartedMs).toBe(1_000); // unmoved
      s = recordOutcome(s, 1, HAPPY.builder, 11_000, { porcelain: "## z/x\n", headSha: "a", baseSha: "b" });
      expect(s.lanes[0].stageStartedMs).toBe(1_000); // unmoved
      // An advance IS a new stage, so it resets -- a fresh agent gets a fresh
      // ceiling, and a lane that bounces builder->qa->builder is not aged out by
      // the time its predecessors spent.
      s = applyAction(s, { kind: "advance", ticket: 1, to: "qa" }, 20_000);
      expect(s.lanes[0].stageStartedMs).toBe(20_000);
    });

    test("a #209 re-spawn gets a fresh ceiling (a new agent, same stage)", () => {
      let s = state([ticket(1, "Building")], [lane(1, "builder", { lastActivityMs: 0, stageStartedMs: 0, workerDead: true, worktreeDirty: true })]);
      s = applyAction(s, { kind: "respawn", ticket: 1, stage: "builder", attempt: 2, note: "n" }, 7_000);
      expect(s.lanes[0].stageStartedMs).toBe(7_000);
    });

    // The constant is a measurement like every other one in this pack.
    test("the ceiling clears the longest stage that ever FINISHED by 2x", () => {
      expect(MEASURED_MAX_STAGE_MS).toBe(13_304_097); // 3.7h, a real builder that returned
      expect(STAGE_CEILING_MINUTES * 60_000).toBeGreaterThanOrEqual(2 * MEASURED_MAX_STAGE_MS);
      // Same answer as the transcript-staleness ceiling, asked of the same corpus:
      // 8 hours is already the age at which a transcript stops proving anything is
      // running behind it.
      expect(STAGE_CEILING_MINUTES * 60_000).toBe(SUBTREE_STALE_MS);
      // And it is far above every per-stage watchdog budget -- the ceiling bounds
      // the alive path, it must never preempt an ordinary expiry.
      for (const stage of ["builder", "qa", "reviewer", "merge"] as const) {
        expect(STAGE_CEILING_MINUTES).toBeGreaterThan(DEFAULT_STAGE_WATCHDOG_MINUTES[stage] * 4);
      }
    });
  });

  // The default is a MEASUREMENT once the baseline is real silence, and it is the
  // same measurement lib/transcripts.ts derives SUBTREE_QUIET_MS from: the longest
  // gap between a working agent's own transcript records, 9,589 mid-work samples
  // over 1,388 sub-agent transcripts. A budget under that ceiling declares a
  // healthy agent dead. The pre-#256 10 cleared it by 1.42x -- on the decision
  // that discards a whole ticket, where SUBTREE_QUIET_MS's 2x only risks leaving a
  // scratch worktree behind.
  test("#256: the default watchdog clears the measured mid-work gap by 2x", () => {
    expect(MEASURED_MIDWORK_GAP_MS).toBe(423_110);
    expect(DEFAULT_WATCHDOG_MINUTES * 60_000).toBeGreaterThanOrEqual(2 * MEASURED_MIDWORK_GAP_MS);
    // Same question, same evidence, same answer as the liveness window's.
    expect(DEFAULT_WATCHDOG_MINUTES * 60_000).toBe(SUBTREE_QUIET_MS);
  });
});

// -- stage-transition rules ---------------------------------------------------

describe("stage transitions", () => {
  test("builder -> qa -> reviewer -> merge -> Done on the happy path", () => {
    let s = state([ticket(1, "Building")], [lane(1, "builder")]);
    const step = (msg: string): Action => {
      s = recordOutcome(s, 1, msg, 0);
      const a = nextAction(s, 0);
      s = applyAction(s, a, 0);
      return a;
    };
    expect(step(HAPPY.builder)).toMatchObject({ kind: "advance", to: "qa" });
    expect(s.tickets[0].status).toBe("QA");
    expect(step(HAPPY.qa)).toMatchObject({ kind: "advance", to: "reviewer" });
    expect(s.tickets[0].status).toBe("Review");
    // #178: the loop's own green gate stands between review-approve and merge.
    expect(step(HAPPY.reviewer)).toMatchObject({ kind: "merge-gate", ticket: 1 });
    s = recordMergeGate(s, 1, GREEN_GATE, 0);
    const toMerge = nextAction(s, 0);
    expect(toMerge).toMatchObject({ kind: "advance", to: "merge", stackedOn: [] });
    s = applyAction(s, toMerge, 0);
    expect(s.tickets[0].status).toBe("Review"); // merge runs under Review
    expect(step(HAPPY.merge)).toMatchObject({ kind: "complete", note: "https://github.com/x/y/pull/1" });
    expect(s.tickets[0].status).toBe("Done");
    expect(s.lanes).toEqual([]);
  });

  test("QA bounce ladder: notes, then /investigate first, then Blocked on pass 3", () => {
    let s = state([ticket(3, "QA")], [lane(3, "qa")]);
    const bounce = (): Action => {
      s = recordOutcome(s, 3, "QA-BUGS: 1) save button 500s", 0);
      const a = nextAction(s, 0);
      s = applyAction(s, a, 0);
      return a;
    };
    const backToQa = () => {
      s = recordOutcome(s, 3, HAPPY.builder, 0);
      s = applyAction(s, nextAction(s, 0), 0); // advance qa
    };
    // Pass 1: straight back to the builder with notes.
    expect(bounce()).toMatchObject({ kind: "advance", to: "builder", note: "1) save button 500s", investigateFirst: false });
    expect(s.lanes[0].qaBounces).toBe(1);
    backToQa();
    // Pass 2: /investigate first (PROCESS.md step 15).
    expect(bounce()).toMatchObject({ kind: "advance", to: "builder", investigateFirst: true });
    expect(s.lanes[0].qaBounces).toBe(2);
    backToQa();
    // Pass 3: Blocked with findings (PROCESS.md step 16).
    expect(bounce()).toMatchObject({ kind: "park", status: "Blocked", note: expect.stringContaining("pass 3") });
    expect(s.tickets[0].status).toBe("Blocked");
    expect(s.lanes).toEqual([]);
  });

  test("needs-input and human-question park to Questions; confused skips", () => {
    let s = state([ticket(1, "Building")], [lane(1, "builder")]);
    s = recordOutcome(s, 1, "NEEDS-INPUT: which currency should defaults use?", 0);
    expect(nextAction(s, 0)).toEqual({
      kind: "park", ticket: 1, status: "Questions", note: "which currency should defaults use?",
    });

    let s2 = state([ticket(2, "QA")], [lane(2, "qa")]);
    s2 = recordOutcome(s2, 2, "CONFUSED: ticket describes a service that does not exist", 0);
    expect(nextAction(s2, 0)).toEqual({
      kind: "skip", ticket: 2, note: "ticket describes a service that does not exist",
    });
  });

  test("reviewer findings bounce to a fresh builder", () => {
    let s = state([ticket(1, "Review")], [lane(1, "reviewer")]);
    s = recordOutcome(s, 1, "REVIEW-FINDINGS: 1) AC3 assertion weakened in tests/x.test.ts:12", 0);
    const a = nextAction(s, 0);
    expect(a).toMatchObject({ kind: "advance", to: "builder", note: expect.stringContaining("AC3") });
    s = applyAction(s, a, 0);
    expect(s.lanes[0].qaBounces).toBe(0); // review bounces do not consume QA passes
    expect(s.lanes[0].reviewBounces).toBe(1); // issue #76: this IS a review bounce
    expect(s.tickets[0].status).toBe("Building");
  });
});

// -- QA bounce config knobs (issue #41): maxQaPasses / qaInvestigateAfter ----

describe("QA bounce config knobs", () => {
  test("AC2: maxQaPasses=5 bounces passes 1-4 (investigateFirst true at/after the default qaInvestigateAfter=2), parks Blocked naming limit 5 on pass 5", () => {
    let s = state([ticket(3, "QA")], [lane(3, "qa")]);
    s.maxQaPasses = 5;
    const bounce = (): Action => {
      s = recordOutcome(s, 3, "QA-BUGS: 1) save button 500s", 0);
      const a = nextAction(s, 0);
      s = applyAction(s, a, 0);
      return a;
    };
    const backToQa = () => {
      s = recordOutcome(s, 3, HAPPY.builder, 0);
      s = applyAction(s, nextAction(s, 0), 0);
    };
    for (let pass = 1; pass <= 4; pass++) {
      const a = bounce();
      expect(a).toMatchObject({ kind: "advance", to: "builder", investigateFirst: pass >= 2 });
      expect(s.lanes[0].qaBounces).toBe(pass);
      backToQa();
    }
    const final = bounce();
    expect(final).toMatchObject({
      kind: "park",
      status: "Blocked",
      note: expect.stringContaining("pass 5 (limit 5)"),
    });
    expect(s.tickets[0].status).toBe("Blocked");
    expect(s.lanes).toEqual([]);
  });

  test("AC3: qaInvestigateAfter=1 makes the FIRST QA bounce carry investigateFirst: true", () => {
    let s = state([ticket(4, "QA")], [lane(4, "qa")]);
    s.qaInvestigateAfter = 1;
    s = recordOutcome(s, 4, "QA-BUGS: 1) flaky spinner", 0);
    const a = nextAction(s, 0);
    expect(a).toMatchObject({ kind: "advance", to: "builder", investigateFirst: true });
  });

  test("AC1: no knobs set reproduces today's ladder exactly (default 3 / 2, byte-identical to the unconfigured test above)", () => {
    let s = state([ticket(9, "QA")], [lane(9, "qa")]);
    expect(s.maxQaPasses).toBeUndefined();
    expect(s.qaInvestigateAfter).toBeUndefined();
    const bounce = (): Action => {
      s = recordOutcome(s, 9, "QA-BUGS: x", 0);
      const a = nextAction(s, 0);
      s = applyAction(s, a, 0);
      return a;
    };
    const backToQa = () => {
      s = recordOutcome(s, 9, HAPPY.builder, 0);
      s = applyAction(s, nextAction(s, 0), 0);
    };
    expect(bounce()).toMatchObject({ kind: "advance", to: "builder", investigateFirst: false });
    backToQa();
    expect(bounce()).toMatchObject({ kind: "advance", to: "builder", investigateFirst: true });
    backToQa();
    expect(bounce()).toMatchObject({ kind: "park", status: "Blocked", note: expect.stringContaining("pass 3 (limit 3)") });
  });
});

// -- reviewer confidence gate (issue #62) -------------------------------------

describe("reviewer confidence gate", () => {
  // AC1: a well-formed confidence= token parses off the REVIEW-APPROVE note.
  test("parses a well-formed confidence off REVIEW-APPROVE", () => {
    expect(parseStageResult("reviewer", "REVIEW-APPROVE: confidence=85 diff satisfies every criterion")).toEqual({
      kind: "review-approve",
      confidence: 85,
      skeptics: null, // #191: no `skeptics=` token in this note -> no denominator
    });
  });

  // AC2: no confidence= token at all parses to null, not a throw or a default.
  test("treats a missing confidence token as null", () => {
    expect(parseStageResult("reviewer", "REVIEW-APPROVE: looks good, all criteria met")).toEqual({
      kind: "review-approve",
      confidence: null,
      skeptics: null,
    });
  });

  // AC3: the boundary values and the (?!\d) 4th-digit rejection.
  test("rejects out-of-range and >100 confidence", () => {
    expect(parseReviewerConfidence("confidence=0")).toBe(0);
    expect(parseReviewerConfidence("confidence=100")).toBe(100);
    expect(parseReviewerConfidence("confidence=150")).toBeNull(); // out of range
    expect(parseReviewerConfidence("confidence=1000")).toBeNull(); // (?!\d) rejects the 4th digit
  });

  // One lane, ticket in Review with no deps, stage reviewer, a review-approve
  // outcome carrying `confidence`. Drives nextAction with the gate knobs under
  // test -- mirrors the maxQaPasses gate tests' fixture-then-nextAction shape.
  // The lane carries a green merge-gate stamp (#178) because this fixture is
  // about the CONFIDENCE floor: with the suite gate already satisfied, a
  // passing score is visibly the advance to merge and a failing one is visibly
  // the park, exactly as before #178. The unstamped case is its own suite below.
  function reviewGate(confidence: number | null, minConfidence: number, belowAction: "block" | "retry" | "off"): Action {
    const s = state([ticket(1, "Review")], [lane(1, "reviewer", { outcome: approve(confidence), mergeGate: GREEN_GATE })]);
    s.minReviewerConfidence = minConfidence;
    s.reviewerBelowThresholdAction = belowAction;
    return nextAction(s, 0);
  }

  // AC4: at/above the floor, the gate passes the outcome through to the merge
  // gate -- NOT a park.
  test("an approve at or above the floor advances to merge", () => {
    expect(reviewGate(85, 70, "block")).toMatchObject({ kind: "advance", to: "merge", ticket: 1 });
  });

  // AC5: the floor comparison is >=, so 70 merges and 69 does not.
  test("the floor comparison is inclusive at the boundary", () => {
    expect(reviewGate(70, 70, "block")).toMatchObject({ kind: "advance", to: "merge", ticket: 1 });
    expect(reviewGate(69, 70, "block")).toMatchObject({ kind: "park", status: "Blocked", ticket: 1 });
  });

  // AC6: sub-floor + block parks Blocked with the EXACT truth-check note.
  test("a sub-floor approve with action block parks Blocked with the exact truth-check note", () => {
    expect(reviewGate(60, 70, "block")).toEqual({
      kind: "park",
      ticket: 1,
      status: "Blocked",
      note: "truth-check failed (confidence 60/100)",
    });
  });

  // AC7: sub-floor + retry bounces to the builder, note starting with the same
  // truth-check text.
  test("a sub-floor approve with action retry bounces to the builder", () => {
    const a = reviewGate(60, 70, "retry");
    expect(a).toMatchObject({ kind: "advance", to: "builder", ticket: 1 });
    expect((a as { note: string }).note).toMatch(/^truth-check failed \(confidence 60\/100\)/);
  });

  // AC8: "off" disables the gate entirely -- a very low score still merges.
  test("action off approves regardless of a low score", () => {
    expect(reviewGate(10, 70, "off")).toMatchObject({ kind: "advance", to: "merge", ticket: 1 });
  });

  // AC9: an approve with no parseable confidence is fail-closed when the gate
  // is on -- an unverifiable approval never merges silently.
  test("a malformed approve is fail-closed to Blocked", () => {
    expect(reviewGate(null, 70, "block")).toEqual({
      kind: "park",
      ticket: 1,
      status: "Blocked",
      note: "truth-check failed (reviewer approved with no parseable confidence score)",
    });
  });
});

// -- reviewer bounce cap (issue #76): maxReviewBounces ------------------------
// -- skeptic quorum gate (issue #191) -----------------------------------------

// The hole #191 closes, stated exactly: the adversarial reviewer aggregates
// confidence over the skeptics that REPORTED, so one skeptic returning "cannot
// refute" is confidence=100 -- which clears #62's default floor of 70 and merges
// as though three independent reviews agreed. Loop run 10 measured deliveries of
// 0-of-3, so this is the ordinary case under load, not an edge. The confidence
// token cannot express the denominator; `skeptics=<k>/3` is the missing fact.
describe("skeptic quorum gate (issue #191)", () => {
  test("parses skeptics=<k>/<of> off a reviewer note", () => {
    expect(parseSkepticQuorum("confidence=100 skeptics=3/3 all clear")).toEqual({ received: 3, of: 3 });
    expect(parseSkepticQuorum("confidence=100 skeptics=0/3 nothing came back")).toEqual({ received: 0, of: 3 });
    expect(parseSkepticQuorum("SKEPTICS=2/3")).toEqual({ received: 2, of: 3 }); // case-insensitive, like confidence
  });

  test("an absent token is null, and neither token disturbs the other", () => {
    expect(parseSkepticQuorum("confidence=100 looks good")).toBeNull();
    // Adjacency both ways: #62's regex must not read the quorum's digits and
    // this one must not read the confidence's.
    expect(parseReviewerConfidence("skeptics=1/3 confidence=67 ok")).toBe(67);
    expect(parseSkepticQuorum("skeptics=1/3 confidence=67 ok")).toEqual({ received: 1, of: 3 });
  });

  test("an incoherent denominator reads as null, never as a pass", () => {
    expect(parseSkepticQuorum("skeptics=4/3")).toBeNull(); // nobody delivered 4 of 3
    expect(parseSkepticQuorum("skeptics=0/0")).toBeNull(); // no fan-out to have a quorum over
    // A 3rd digit at that position is not a truncated match, same discipline as
    // parseReviewerConfidence's (?!\d).
    expect(parseSkepticQuorum("skeptics=1/300")).toBeNull();
  });

  test("parseStageResult carries both tokens off one REVIEW-APPROVE marker", () => {
    expect(parseStageResult("reviewer", "REVIEW-APPROVE: confidence=100 skeptics=3/3 every criterion holds")).toEqual({
      kind: "review-approve",
      confidence: 100,
      skeptics: { received: 3, of: 3 },
    });
  });

  // One lane in Review with an approve that CLEARS the confidence floor, so the
  // only thing left to decide is the quorum. The lane also carries a green
  // merge-gate stamp (#178) for the same reason it carries confidence=100: with
  // the suite gate already satisfied, a met quorum is visibly the advance to
  // merge and a short one is visibly the reviewer re-spawn.
  function quorumGate(
    skeptics: { received: number; of: number } | null,
    minSkepticQuorum: number,
    laneOver: Partial<LaneState> = {}
  ): Action {
    const s = state([ticket(1, "Review")], [lane(1, "reviewer", { outcome: approve(100, skeptics), mergeGate: GREEN_GATE, ...laneOver })]);
    s.minReviewerConfidence = 70;
    s.reviewerBelowThresholdAction = "block";
    s.minSkepticQuorum = minSkepticQuorum;
    return nextAction(s, 0);
  }

  test("a full quorum merges", () => {
    expect(quorumGate({ received: 3, of: 3 }, 2)).toMatchObject({ kind: "advance", ticket: 1, to: "merge" });
    expect(quorumGate({ received: 2, of: 3 }, 2)).toMatchObject({ kind: "advance", ticket: 1, to: "merge" });
  });

  // THE headline case. Before #191 this merged: confidence=100 >= 70, gate done.
  test("a short quorum re-spawns the REVIEWER, not the builder, and does not merge", () => {
    const a = quorumGate({ received: 1, of: 3 }, 2);
    expect(a).toMatchObject({ kind: "advance", ticket: 1, to: "reviewer" });
    expect((a as { note: string }).note).toContain("skeptic quorum not met (1/3 verdicts delivered, 2 required)");
    // Rebuilding a diff nobody faulted fixes nothing and pays a builder + a QA
    // pass for it, so the retry must NOT go to the builder.
    expect(a).not.toMatchObject({ to: "builder" });
  });

  test("zero verdicts re-spawns too, and says nobody looked", () => {
    const a = quorumGate({ received: 0, of: 3 }, 2);
    expect(a).toMatchObject({ kind: "advance", ticket: 1, to: "reviewer" });
    expect((a as { note: string }).note).toContain("no verdicts at all");
  });

  test("the re-spawn's board status is Review, so the move is a no-op", () => {
    // canTransition("Review","Review") is already legal and STATUS_FOR_STAGE
    // maps reviewer -> Review, so the advance needs no new transition.
    expect(canTransition("Review", "Review")).toBe(true);
    let s = state([ticket(1, "Review")], [lane(1, "reviewer", { outcome: approve(100, { received: 0, of: 3 }) })]);
    s.minSkepticQuorum = 2;
    s = applyAction(s, nextAction(s, 0), 0);
    expect(s.tickets[0].status).toBe("Review");
    expect(s.lanes[0].stage).toBe("reviewer");
  });

  test("the retry is spent once, then the ticket parks Blocked", () => {
    const a = quorumGate({ received: 0, of: 3 }, 2, { quorumRetries: MAX_QUORUM_RETRIES });
    expect(a).toMatchObject({ kind: "park", ticket: 1, status: "Blocked" });
    const note = (a as { note: string }).note;
    expect(note).toContain("environmental, not luck");
    expect(note).toContain("lower minSkepticQuorum");
    // The human must not read this as "the reviewer rejected the diff".
    expect(note).toContain("The diff itself was never faulted.");
  });

  // Without applyAction's reviewer->reviewer increment, `spent` never grows and
  // a project with broken sub-agent delivery re-spawns the same reviewer forever
  // -- a paid infinite loop. This drives the real sequence to prove it converges.
  test("a reviewer that starves twice terminates instead of looping forever", () => {
    let s = state([ticket(1, "Review")], [lane(1, "reviewer")]);
    s.minReviewerConfidence = 70;
    s.minSkepticQuorum = 2;
    const STARVED = "REVIEW-APPROVE: confidence=100 skeptics=0/3 no skeptic reported";

    s = recordOutcome(s, 1, STARVED, 0);
    const first = nextAction(s, 0);
    expect(first).toMatchObject({ kind: "advance", to: "reviewer" });
    s = applyAction(s, first, 0);
    expect(s.lanes[0].quorumRetries).toBe(1);

    s = recordOutcome(s, 1, STARVED, 0); // the re-spawned reviewer starves again
    expect(nextAction(s, 0)).toMatchObject({ kind: "park", ticket: 1, status: "Blocked" });
  });

  // Two failures, two budgets: a delivery race must not consume the rebuild a
  // genuine finding needs, and must not park the ticket under "review bounce cap
  // reached" -- which would tell the human a reviewer faulted this diff twice.
  test("a quorum re-spawn spends quorumRetries and leaves reviewBounces alone", () => {
    let s = state([ticket(1, "Review")], [lane(1, "reviewer", { outcome: approve(100, { received: 0, of: 3 }) })]);
    s.minSkepticQuorum = 2;
    s = applyAction(s, nextAction(s, 0), 0);
    expect(s.lanes[0].quorumRetries).toBe(1);
    expect(s.lanes[0].reviewBounces).toBe(0);
    // And the converse: a real reviewer->builder bounce leaves quorumRetries at 0.
    let t = state([ticket(1, "Review")], [lane(1, "reviewer", { outcome: { kind: "review-findings", note: "1) bad" } })]);
    t.maxReviewBounces = 2;
    t = applyAction(t, nextAction(t, 0), 0);
    expect(t.lanes[0].reviewBounces).toBe(1);
    expect(t.lanes[0].quorumRetries ?? 0).toBe(0);
  });

  test("minSkepticQuorum 0 disables the gate entirely", () => {
    expect(quorumGate({ received: 0, of: 3 }, 0)).toMatchObject({ kind: "advance", ticket: 1, to: "merge" });
  });

  // A single-pass review reports no denominator by design, so the gate has
  // nothing to judge -- #62's floor is the only thing that ruled, unchanged.
  test("a review with no denominator is untouched by the gate", () => {
    expect(quorumGate(null, 2)).toMatchObject({ kind: "advance", ticket: 1, to: "merge" });
  });

  // A lane's outcome is PERSISTED in state.json, so a loop upgraded onto #191
  // mid-drain reads approve outcomes recorded before the field existed.
  test("a pre-#191 persisted outcome with no skeptics key does not crash the tick", () => {
    const s = state([ticket(1, "Review")], [lane(1, "reviewer", { mergeGate: GREEN_GATE })]);
    // Exactly what the old code wrote: no `skeptics` key at all, not null.
    // Written as a literal on purpose -- `approve(100)` sets `skeptics: null`,
    // which is a DIFFERENT shape and stops this test from covering the
    // `skeptics == null` (loose) read it exists to pin.
    (s.lanes[0] as { outcome: unknown }).outcome = { kind: "review-approve", confidence: 100 };
    s.minSkepticQuorum = 2;
    expect(nextAction(s, 0)).toMatchObject({ kind: "advance", ticket: 1, to: "merge" });
  });

  // Ordering: the confidence floor runs FIRST, so a below-floor approve parks
  // with the truth-check note even when its quorum was full. Otherwise the
  // quorum note would mask the more serious failure.
  test("a below-floor confidence still parks on the truth check, quorum notwithstanding", () => {
    const s = state([ticket(1, "Review")], [lane(1, "reviewer", { outcome: approve(50, { received: 3, of: 3 }) })]);
    s.minReviewerConfidence = 70;
    s.reviewerBelowThresholdAction = "block";
    s.minSkepticQuorum = 2;
    expect(nextAction(s, 0)).toMatchObject({ kind: "park", status: "Blocked", note: "truth-check failed (confidence 50/100)" });
  });

  test("ingest threads --min-skeptic-quorum and preserves it across re-ingest", () => {
    const items = [{ number: 1, title: "t", fields: { Status: "Ready" } }];
    const first = ingestBoardItems(null, items, { "1": "body" }, { minSkepticQuorum: 1 });
    expect(first.minSkepticQuorum).toBe(1);
    // A re-ingest with no cfg keeps the captured value, like every sibling knob.
    expect(ingestBoardItems(first, items, { "1": "body" }, {}).minSkepticQuorum).toBe(1);
    // Default when nobody supplies one.
    expect(ingestBoardItems(null, items, { "1": "body" }, {}).minSkepticQuorum).toBe(DEFAULT_MIN_SKEPTIC_QUORUM);
    expect(DEFAULT_MIN_SKEPTIC_QUORUM).toBe(2); // a majority of the 3-skeptic fan-out
  });

});

// A `built` marker used to advance a lane to QA on the marker ALONE. Run 9's
// #155 builder emitted BUILT with everything still uncommitted, so QA reviewed
// the BASE tree and passed a diff that did not exist. These drive the guard that
// closes it (issue #177) -- the facts are passed as data, so no real git is
// needed and the whole block stays a free gate test.
describe("built guard: clean tree + moved HEAD (#177)", () => {
  const BASE = "1111111111111111111111111111111111111111";
  const HEAD = "2222222222222222222222222222222222222222";
  // What `git status --porcelain --branch` prints for a clean lane worktree: the
  // `## <branch>` header and nothing else. The header is REQUIRED (an empty
  // payload is a git status that never ran), so no fixture may omit it.
  const CLEAN = "## z/ticket-1-thing...origin/main [ahead 1]\n";
  // The AC's setup: staged (`M `) + unstaged (` M`) edits and an unadded new
  // file, no commit, HEAD still at the base SHA.
  const DIRTY_NO_COMMIT = {
    porcelain: `${CLEAN}M  lib/loop.ts\n M tests/loop.test.ts\n?? docs/new.md\n`,
    headSha: BASE,
    baseSha: BASE,
  };
  const CLEAN_MOVED = { porcelain: CLEAN, headSha: HEAD, baseSha: BASE };

  test("the guard passes a clean tree with a commit off base, and fails on either half alone", () => {
    expect(builtGuardFailure(CLEAN_MOVED)).toBeNull();
    // Trailing/blank lines are not dirt -- git's porcelain output ends in \n.
    expect(builtGuardFailure({ porcelain: `${CLEAN}\n   \n`, headSha: HEAD, baseSha: BASE })).toBeNull();
    expect(builtGuardFailure(DIRTY_NO_COMMIT)).toContain("uncommitted work");
    // Committed SOMETHING but left the rest behind: still an incomplete diff.
    const half = builtGuardFailure({ porcelain: `${CLEAN}?? tests/new.test.ts\n`, headSha: HEAD, baseSha: BASE })!;
    expect(half).toContain("1 uncommitted path(s)");
    expect(half).toContain("Commit what is already in the worktree");
    // Clean tree, no commit: the lane holds nothing at all, so the fix line must
    // NOT tell that builder to commit files nobody wrote.
    const nothing = builtGuardFailure({ porcelain: CLEAN, headSha: BASE, baseSha: BASE })!;
    expect(nothing).toContain("still an ancestor of the base branch");
    expect(nothing).toContain("Nothing at all is on this branch");
  });

  // The porcelain half needs the SAME fail-closed twin the SHA half has. The
  // orchestrator collects status with `> file`, and a redirect creates the file
  // BEFORE git runs -- so a `git status` that failed leaves an EMPTY file, which a
  // bare porcelain payload cannot tell apart from a clean tree. With a moved HEAD
  // that read a half-committed build straight into QA. `--branch` closes it: git
  // always emits the `## <branch>` header, so its absence means "no status".
  test("a status payload with no `## ` header fails closed instead of reading as clean", () => {
    const empty = builtGuardFailure({ porcelain: "", headSha: HEAD, baseSha: BASE })!;
    expect(empty).toContain("uncommitted work");
    expect(empty).toContain("`## <branch>` header is missing");
    // ...and the fix line cannot claim the branch is empty or that files are
    // waiting -- neither is known.
    expect(empty).toContain("look before you build");
    expect(empty).not.toContain("Nothing at all is on this branch");
    // Whitespace-only and dirt-without-a-header are the same unproven state.
    expect(builtGuardFailure({ porcelain: "\n \n", headSha: HEAD, baseSha: BASE })).toContain("header is missing");
    expect(builtGuardFailure({ porcelain: " M lib/loop.ts\n", headSha: HEAD, baseSha: BASE })).toContain("header is missing");
    // A `##` inside a path is not the header (git's own header is `## ` + branch).
    expect(builtGuardFailure({ porcelain: "?? docs/##notes.md\n", headSha: HEAD, baseSha: BASE })).toContain("header is missing");
  });

  // Reading a 7-char abbreviation as "different from" its own full OID would fail
  // OPEN: the guard would report a moved HEAD for a branch still on base -- the
  // exact build this ticket exists to stop.
  test("an abbreviated or upper-case SHA still reads as the same commit", () => {
    expect(builtGuardFailure({ porcelain: CLEAN, headSha: BASE, baseSha: BASE.slice(0, 7) })).toContain("uncommitted work");
    expect(builtGuardFailure({ porcelain: CLEAN, headSha: BASE.toUpperCase(), baseSha: BASE })).toContain("uncommitted work");
    // A genuinely different commit, abbreviated, still reads as moved.
    expect(builtGuardFailure({ porcelain: CLEAN, headSha: HEAD.slice(0, 7), baseSha: BASE })).toBeNull();
  });

  test("an unreadable SHA fails closed instead of reading as a moved HEAD", () => {
    expect(builtGuardFailure({ porcelain: CLEAN, headSha: "", baseSha: BASE })).toContain("no readable HEAD/base SHA");
    expect(builtGuardFailure({ porcelain: CLEAN, headSha: HEAD, baseSha: "  " })).toContain("no readable HEAD/base SHA");
  });

  // `baseSha` is the MERGE-BASE of the base branch and HEAD, not the base tip, and
  // the difference is the whole guard on a re-claimed worktree: the tip moves when
  // step 7 pulls the base forward between loops, so a lane that committed NOTHING
  // has a HEAD that differs from the tip. Only the merge-base answers "does HEAD
  // carry a commit of its own" -- it EQUALS HEAD exactly when HEAD is an ancestor
  // of the base. Real git, so the identity is git's, not a fixture's.
  test("the merge-base -- not the base tip -- is what proves a commit of its own", () => {
    const repo = mkdtempSync(join(tmpdir(), "zstack-builtguard-git-"));
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
      if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
      return p.stdout.toString().trim();
    };
    try {
      git("init", "-q", "-b", "main");
      git("config", "user.email", "t@t.t");
      git("config", "user.name", "t");
      writeFileSync(join(repo, "a.txt"), "1");
      git("add", "-A");
      git("commit", "-qm", "base");
      // A lane branch cut from base that commits NOTHING, then a base branch that
      // advances underneath it (what the next loop's `git pull` does).
      git("branch", "z/ticket-1");
      writeFileSync(join(repo, "a.txt"), "2");
      git("commit", "-qam", "base moved on");
      const headSha = git("rev-parse", "z/ticket-1");
      const baseTip = git("rev-parse", "main");
      const mergeBase = git("merge-base", "main", "z/ticket-1");
      const facts = (baseSha: string) => ({ porcelain: `## z/ticket-1\n`, headSha, baseSha });
      // Ground truth: the lane branch has no commit of its own.
      expect(git("rev-list", "--count", "main..z/ticket-1")).toBe("0");
      // The base TIP differs from HEAD, so a tip-based check reads "moved" and
      // fails OPEN -- this is the bug the merge-base closes, pinned as a fact.
      expect(baseTip).not.toBe(headSha);
      expect(builtGuardFailure(facts(baseTip))).toBeNull();
      // The merge-base equals HEAD, so the guard holds the lane.
      expect(mergeBase).toBe(headSha);
      expect(builtGuardFailure(facts(mergeBase))).toContain("no commit of its own");
      // And a lane that DID commit passes on the same merge-base input.
      git("checkout", "-q", "z/ticket-1");
      writeFileSync(join(repo, "b.txt"), "own work");
      git("add", "-A");
      git("commit", "-qm", "the lane's own commit");
      const ownHead = git("rev-parse", "HEAD");
      expect(builtGuardFailure({ porcelain: `## z/ticket-1\n`, headSha: ownHead, baseSha: git("merge-base", "main", "HEAD") })).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // AC1: dirty tree + no commit + BUILT -> held, flagged, builder asked to commit.
  test("AC1: a dirty, no-commit BUILT does NOT advance to QA -- the builder is asked to commit", () => {
    let s = state([ticket(1, "Building")], [lane(1, "builder")]);
    s = recordOutcome(s, 1, HAPPY.builder, 0, DIRTY_NO_COMMIT);
    // Asserted field-by-field, not via toMatchObject + expect.stringContaining:
    // bun 1.3.14's toMatchObject REPLACES a matched value with the asymmetric
    // matcher object in the received value, which would corrupt the very state
    // this test goes on to drive through nextAction.
    expect(s.lanes[0].outcome!.kind).toBe("built");
    expect((s.lanes[0].outcome as { unverified?: string }).unverified).toContain("uncommitted work");
    const a = nextAction(s, 0);
    expect(a).toMatchObject({ kind: "advance", ticket: 1, to: "builder" });
    expect(a).not.toMatchObject({ to: "qa" });
    expect((a as { note: string }).note).toContain("uncommitted work");
    s = applyAction(s, a, 0);
    expect(s.tickets[0].status).toBe("Building"); // never reached QA
    expect(s.lanes[0].stage).toBe("builder");
    expect(s.lanes[0].commitRetries).toBe(1);
    expect(s.lanes[0].outcome).toBeUndefined(); // fresh spawn, same lane
  });

  // AC2: clean tree + one commit ahead + BUILT -> the normal walk to QA.
  test("AC2: a clean tree one commit ahead of base advances to QA normally", () => {
    let s = state([ticket(1, "Building")], [lane(1, "builder")]);
    s = recordOutcome(s, 1, HAPPY.builder, 0, CLEAN_MOVED);
    expect(s.lanes[0].outcome).toEqual({ kind: "built" }); // no `unverified` key at all
    const a = nextAction(s, 0);
    expect(a).toMatchObject({ kind: "advance", ticket: 1, to: "qa" });
    s = applyAction(s, a, 0);
    expect(s.tickets[0].status).toBe("QA");
    expect(s.lanes[0].commitRetries ?? 0).toBe(0);
  });

  // #130's shortcut would otherwise hand the reviewer the same empty diff.
  test("a skip-qa ticket does not walk to Review on an unverified BUILT either", () => {
    let s = state([ticket(1, "Building", [], { skipQa: true })], [lane(1, "builder")]);
    s = recordOutcome(s, 1, HAPPY.builder, 0, DIRTY_NO_COMMIT);
    expect(nextAction(s, 0)).toMatchObject({ kind: "advance", to: "builder" });
    // The same label with a VERIFIED build still takes the shortcut, unchanged.
    let t = state([ticket(1, "Building", [], { skipQa: true })], [lane(1, "builder")]);
    t = recordOutcome(t, 1, HAPPY.builder, 0, CLEAN_MOVED);
    expect(nextAction(t, 0)).toMatchObject({ kind: "advance", to: "reviewer" });
  });

  // Without applyAction's builder->builder increment, `spent` never grows and a
  // builder that keeps reporting BUILT with nothing committed is re-spawned
  // forever -- a paid infinite loop. This drives the real sequence to prove it
  // converges.
  test("the retry is spent once, then the ticket parks Blocked with the uncommitted-work note", () => {
    let s = state([ticket(1, "Building")], [lane(1, "builder")]);
    s = recordOutcome(s, 1, HAPPY.builder, 0, DIRTY_NO_COMMIT);
    s = applyAction(s, nextAction(s, 0), 0);
    expect(s.lanes[0].commitRetries).toBe(MAX_COMMIT_RETRIES);
    s = recordOutcome(s, 1, HAPPY.builder, 0, DIRTY_NO_COMMIT); // does it again
    const a = nextAction(s, 0);
    expect(a).toMatchObject({ kind: "park", ticket: 1, status: "Blocked" });
    const note = (a as { note: string }).note;
    expect(note).toContain("uncommitted work");
    expect(note).toContain("not a slip");
    expect(note).toContain("worktree"); // the human is told where to look
    s = applyAction(s, a, 0);
    expect(s.tickets[0].status).toBe("Blocked");
    expect(s.lanes).toEqual([]);
  });

  // This park is the only one in the machine whose work is NOT already committed
  // on a branch, and parking removes the lane lock -- which makes the worktree an
  // orphan the next run's reconcile plan prunes with `git worktree remove --force`
  // (lib/reconcile.ts), gated by Step 0(b) BEFORE the loop will start. A note that
  // said "the worktree is left in place -- commit or discard what is there" was
  // pointing the human at a directory the loop deletes first. So the note must name
  // the salvage patch and warn, and the SKILL must actually dump it.
  test("the park note points at a durable salvage patch, not the doomed worktree", () => {
    let s = state([ticket(7, "Building")], [lane(7, "builder", { commitRetries: MAX_COMMIT_RETRIES })]);
    s = recordOutcome(s, 7, HAPPY.builder, 0, DIRTY_NO_COMMIT);
    const a = nextAction(s, 0);
    // The dump is triggered by the action's own field, never by a phrase in the
    // note (#209): a prose key is matched by whatever sentence happens to contain
    // it, and two different notes carried this one.
    expect(a).toMatchObject({ kind: "park", salvage: true });
    const note = (a as { note: string }).note;
    expect(note.startsWith("uncommitted work:")).toBe(true);
    expect(note).toContain("reports/uncommitted-7.patch"); // the ticket's own patch
    expect(note).toContain("git apply");
    expect(note).toContain("force-removes it");
    expect(note).toContain("BEFORE the next /z-loop run");
    expect(note).not.toContain("it is left in place");
    // The park path has to write that patch, or the note lies.
    const skill = readFileSync(join(REPO_ROOT, "z-loop", "SKILL.md"), "utf8");
    const has = (s: string) => skill.includes(s); // see the canary below re: file dumps
    expect(has('when the action carries `"salvage": true`')).toBe(true);
    expect(has("diff --cached --binary HEAD")).toBe(true);
    expect(has(`> "$HOME/.zstack/projects/$SLUG/reports/uncommitted-<N>.patch"`)).toBe(true);
    expect(has(`git -C ".worktrees/ticket-<N>" add -A`)).toBe(true);
  });

  // Every action that drops a lane must agree on the trigger, and only the ones
  // whose worktree really holds work may set it -- an unconditional flag would
  // stage-and-diff a worktree a human is still reading.
  test("`salvage` is the one structural key, set by exactly the actions that strand work", () => {
    const skill = readFileSync(join(REPO_ROOT, "z-loop", "SKILL.md"), "utf8");
    // All three lane-dropping rows read the same field...
    expect(skill.match(/when the action carries `"salvage": true`/g)?.length).toBe(3);
    // ...and no row keys a dump on a phrase in the note any more.
    expect(skill.includes("when the note mentions `uncommitted work`")).toBe(false);
    expect(skill.includes("when the note begins `uncommitted work:`")).toBe(false);

    // An ordinary park (a QA-bugs cap, say) strands nothing: its work is committed
    // on a branch, and branches are never deleted (issue #2).
    let s = state([ticket(1, "QA")], [lane(1, "qa", { qaBounces: 3 })]);
    s = recordOutcome(s, 1, "QA-BUGS: still broken", 0);
    expect(nextAction(s, 0)).toMatchObject({ kind: "park", status: "Blocked" });
    expect((nextAction(s, 0) as { salvage?: true }).salvage).toBeUndefined();
  });

  // Three failures, three budgets: "you forgot to commit" must not consume the
  // rebuild a QA bug or a reviewer finding needs, nor park under their notes.
  test("a commit re-spawn spends commitRetries and leaves qaBounces/reviewBounces alone", () => {
    let s = state([ticket(1, "Building")], [lane(1, "builder")]);
    s = recordOutcome(s, 1, HAPPY.builder, 0, DIRTY_NO_COMMIT);
    s = applyAction(s, nextAction(s, 0), 0);
    expect(s.lanes[0].commitRetries).toBe(1);
    expect(s.lanes[0].qaBounces).toBe(0);
    expect(s.lanes[0].reviewBounces).toBe(0);
    // And the converse: a QA bounce back to the builder leaves commitRetries at 0.
    let t = state([ticket(2, "QA")], [lane(2, "qa", { outcome: { kind: "qa-bugs", note: "1) boom" } })]);
    t.maxQaPasses = 3;
    t = applyAction(t, nextAction(t, 0), 0);
    expect(t.lanes[0].qaBounces).toBe(1);
    expect(t.lanes[0].commitRetries ?? 0).toBe(0);
  });

  // The pure reducer keeps its old contract: no facts -> no verdict, byte-identical
  // to pre-#177. That is what a state file recorded by an older loop mid-drain
  // looks like, and what the e2e/orchestrator-context eval harnesses pass. The CLI
  // is where the facts are made non-optional for a real builder lane (below).
  test("a BUILT recorded with no git facts stays a plain built and advances", () => {
    let s = state([ticket(1, "Building")], [lane(1, "builder")]);
    s = recordOutcome(s, 1, HAPPY.builder, 0);
    expect(s.lanes[0].outcome).toEqual({ kind: "built" });
    expect(nextAction(s, 0)).toMatchObject({ kind: "advance", to: "qa" });
  });

  test("the facts are ignored on every non-builder stage", () => {
    let s = state([ticket(1, "QA")], [lane(1, "qa")]);
    s = recordOutcome(s, 1, HAPPY.qa, 0, DIRTY_NO_COMMIT);
    expect(s.lanes[0].outcome).toEqual({ kind: "qa-pass" });
    expect(nextAction(s, 0)).toMatchObject({ kind: "advance", to: "reviewer" });
  });

  // The guard only fires if the orchestrator collects the facts, and the retry is
  // only useful if the note reaches the re-spawned builder -- both live in the
  // SKILL, so both are pinned here (same doc-canary discipline as the C8 claim
  // limitation in tests/safety.test.ts).
  test("the SKILL documents the git-fact flags, the commitNotes route, and the attempt count", () => {
    const skill = readFileSync(join(REPO_ROOT, "z-loop", "SKILL.md"), "utf8");
    expect(skill).toContain("--porcelain");
    expect(skill).toContain("--head-sha");
    expect(skill).toContain("--base-sha");
    expect(skill).toMatch(/from `builder`[^|]*`commitNotes`/);
    // Without commitRetries in the attempt count, the re-spawned builder's
    // transcript overwrites its predecessor's -- a silent Actual undercount.
    // (#209 moved the count itself into `loop.ts attempt` and added respawns.)
    expect(skill).toContain("qaBounces + reviewBounces + commitRetries + respawns.builder + 1");
    const docs = readFileSync(join(REPO_ROOT, "docs", "user-guide", "z-loop.md"), "utf8");
    expect(docs).toMatch(/`git status --porcelain --branch` must report a clean tree/);
    expect(docs).toMatch(/`HEAD` must have moved off the base branch/);
    expect(docs).toContain("git merge-base");
    expect(docs).toContain("uncommitted-<N>.patch");
  });

  // The two collection flags carry the guard's fail-closed halves, and BOTH have a
  // shorter form that reads as working while failing open. The verdict is in code,
  // but the INPUTS are the SKILL's, so the exact commands are pinned here -- this
  // canary is what catches a future edit "simplifying" either one.
  test("the SKILL collects status --branch and the merge-base, never the bare forms", () => {
    const skill = readFileSync(join(REPO_ROOT, "z-loop", "SKILL.md"), "utf8");
    // Booleans, not toContain: a miss on a 60KB SKILL.md dumps the entire file
    // into the failure output, and the test name already says what is missing.
    const has = (s: string) => skill.includes(s);
    expect(has(`git -C "$WT" status --porcelain --branch > "$TMP/porcelain-<N>.txt"`)).toBe(true);
    expect(has(`--base-sha "$(git -C "$WT" merge-base "$BASE" HEAD)"`)).toBe(true);
    // The base TIP cannot answer "does HEAD carry a commit of its own" once the
    // base has moved under a re-claimed worktree (see the real-git test above).
    expect(has(`--base-sha "$(git -C "$WT" rev-parse "$BASE")"`)).toBe(false);
    // A bare `status --porcelain >` redirect leaves an empty file when git fails.
    expect(has(`status --porcelain > "$TMP/porcelain-<N>.txt"`)).toBe(false);
  });

  // #177's untracked-file strictness is right (an un-added test file is exactly the
  // work that goes missing) but it makes .gitignore part of the guard: scratch
  // output every agent in this repo produces would hold an honest, fully committed
  // BUILT as "uncommitted work" and then tell the builder to commit scratch.
  test("this repo's own mandatory graphify scratch output is gitignored", () => {
    const p = Bun.spawnSync(["git", "check-ignore", "-q", "graphify-out/graph.json"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0); // 0 = ignored, 1 = would show up as `??` in the guard
  });
});

// #62 shipped reviewerBelowThresholdAction: "retry" with no cap on the
// reviewer->builder bounce -- this closes it, mirroring the maxQaPasses gate
// tests' fixture-then-nextAction shape above.

describe("reviewer bounce cap (issue #76)", () => {
  // AC1: a lane bouncing reviewer->builder repeatedly under action "retry"
  // parks Blocked at the cap instead of bouncing forever.
  test("AC1: repeated confidence-retry bounces park Blocked at maxReviewBounces with the cap note, instead of bouncing forever", () => {
    let s = state([ticket(1, "Review")], [lane(1, "reviewer")]);
    s.reviewerBelowThresholdAction = "retry";
    s.minReviewerConfidence = 70;
    s.maxReviewBounces = 2;
    const bounceFromReview = (): Action => {
      s = recordOutcome(s, 1, "REVIEW-APPROVE: confidence=10 not convinced", 0);
      const a = nextAction(s, 0);
      s = applyAction(s, a, 0);
      return a;
    };
    const backToReview = () => {
      s = recordOutcome(s, 1, HAPPY.builder, 0);
      s = applyAction(s, nextAction(s, 0), 0); // builder -> qa
      s = recordOutcome(s, 1, HAPPY.qa, 0);
      s = applyAction(s, nextAction(s, 0), 0); // qa -> reviewer
    };
    // Pass 1: bounces back to the builder same as before the cap.
    expect(bounceFromReview()).toMatchObject({ kind: "advance", to: "builder" });
    expect(s.lanes[0].reviewBounces).toBe(1);
    backToReview();
    // Pass 2 hits maxReviewBounces=2: parks Blocked instead of bouncing again.
    expect(bounceFromReview()).toEqual({
      kind: "park",
      ticket: 1,
      status: "Blocked",
      note: "review bounce cap reached (2/2)\n\ntruth-check failed (confidence 10/100)",
    });
    expect(s.tickets[0].status).toBe("Blocked");
    expect(s.lanes).toEqual([]); // the lane is dropped, not left spinning
  });

  // AC2: one review bounce then an approve at/above the floor merges
  // normally, and a fresh lane on a different ticket never inherits another
  // ticket's bounce count.
  test("AC2: one review bounce then an at-threshold approve merges normally; a fresh lane starts its own count at 0", () => {
    let s = state([ticket(1, "Review")], [lane(1, "reviewer")]);
    s.reviewerBelowThresholdAction = "retry";
    s.minReviewerConfidence = 70;
    s.maxReviewBounces = 2;

    // One bounce.
    s = recordOutcome(s, 1, "REVIEW-APPROVE: confidence=10 not convinced", 0);
    s = applyAction(s, nextAction(s, 0), 0);
    expect(s.lanes[0].reviewBounces).toBe(1);
    expect(s.tickets[0].status).toBe("Building");

    // Builder + QA clear it back to Review, leaving the counter untouched.
    s = recordOutcome(s, 1, HAPPY.builder, 0);
    s = applyAction(s, nextAction(s, 0), 0);
    s = recordOutcome(s, 1, HAPPY.qa, 0);
    s = applyAction(s, nextAction(s, 0), 0);
    expect(s.lanes[0].reviewBounces).toBe(1);

    // An at-threshold approve merges normally -- the one prior bounce does
    // not block it. (#178: the rebuilt code is gated afresh -- the bounce
    // cleared any earlier verdict -- and green lets the merge proceed.)
    s = recordOutcome(s, 1, "REVIEW-APPROVE: confidence=70 now satisfied", 0);
    expect(nextAction(s, 0)).toMatchObject({ kind: "merge-gate", ticket: 1 });
    s = recordMergeGate(s, 1, GREEN_GATE, 0);
    expect(nextAction(s, 0)).toMatchObject({ kind: "advance", ticket: 1, to: "merge" });

    // A second ticket claimed fresh starts its own lane at reviewBounces: 0 --
    // the counter lives on the lane, so it can never leak from #1's lane.
    s.tickets.push(ticket(2, "Ready"));
    s = applyAction(s, { kind: "claim", ticket: 2, stage: "builder" }, 0);
    expect(s.lanes.find((l) => l.ticket === 2)!.reviewBounces).toBe(0);
  });

  // AC3 (loop.ts half; the config-schema half lives in tests/setup.test.ts):
  // no maxReviewBounces set reproduces the default cap of 2.
  test("AC3: maxReviewBounces absent defaults to 2", () => {
    let s = state([ticket(9, "Review")], [lane(9, "reviewer")]);
    s.reviewerBelowThresholdAction = "retry";
    expect(s.maxReviewBounces).toBeUndefined();
    const bounceFromReview = (): Action => {
      s = recordOutcome(s, 9, "REVIEW-APPROVE: confidence=10 nope", 0);
      const a = nextAction(s, 0);
      s = applyAction(s, a, 0);
      return a;
    };
    const backToReview = () => {
      s = recordOutcome(s, 9, HAPPY.builder, 0);
      s = applyAction(s, nextAction(s, 0), 0);
      s = recordOutcome(s, 9, HAPPY.qa, 0);
      s = applyAction(s, nextAction(s, 0), 0);
    };
    expect(bounceFromReview()).toMatchObject({ kind: "advance", to: "builder" });
    backToReview();
    expect(bounceFromReview()).toMatchObject({
      kind: "park",
      status: "Blocked",
      note: expect.stringContaining("review bounce cap reached (2/2)"),
    });
  });

  // A REVIEW-FINDINGS bounce draws on the SAME budget as a confidence retry --
  // not a separate counter.
  test("REVIEW-FINDINGS and a confidence retry share one budget: two REVIEW-FINDINGS then a retry hits the cap", () => {
    let s = state([ticket(1, "Review")], [lane(1, "reviewer")]);
    s.reviewerBelowThresholdAction = "retry";
    s.minReviewerConfidence = 70;
    s.maxReviewBounces = 2;
    s = recordOutcome(s, 1, "REVIEW-FINDINGS: 1) missing test", 0);
    s = applyAction(s, nextAction(s, 0), 0);
    expect(s.lanes[0].reviewBounces).toBe(1);
    // Back to Review.
    s = recordOutcome(s, 1, HAPPY.builder, 0);
    s = applyAction(s, nextAction(s, 0), 0);
    s = recordOutcome(s, 1, HAPPY.qa, 0);
    s = applyAction(s, nextAction(s, 0), 0);
    // A confidence-retry now, not another REVIEW-FINDINGS, still hits the cap
    // this bounce carried over from the FINDINGS path.
    s = recordOutcome(s, 1, "REVIEW-APPROVE: confidence=5 unconvinced", 0);
    expect(nextAction(s, 0)).toMatchObject({
      kind: "park",
      status: "Blocked",
      note: expect.stringContaining("review bounce cap reached (2/2)"),
    });
  });
});

// -- merge ordering (stacked-chain aware) -------------------------------------

describe("merge ordering", () => {
  test("fixture graph with a stacked chain merges topologically, lowest first", () => {
    const steps = mergeOrder([
      { ticket: 22, dependsOn: [21] },
      { ticket: 21, dependsOn: [20] },
      { ticket: 20, dependsOn: [] },
      { ticket: 30, dependsOn: [] },
    ]);
    expect(steps).toEqual([
      { ticket: 20, stackedOn: [] },
      { ticket: 21, stackedOn: [20] }, // stacked: parent merges first, branch kept
      { ticket: 22, stackedOn: [21] },
      { ticket: 30, stackedOn: [] },
    ]);
  });

  test("deps outside the finished set are ignored", () => {
    expect(mergeOrder([{ ticket: 9, dependsOn: [4] }])).toEqual([{ ticket: 9, stackedOn: [] }]);
  });

  test("a cycle among finished lanes throws instead of merging anything", () => {
    expect(() => mergeOrder([{ ticket: 1, dependsOn: [2] }, { ticket: 2, dependsOn: [1] }])).toThrow(ZError);
  });

  test("mergeOrderProbe never throws: a pure 2-cycle resolves nothing and reports both stuck", () => {
    expect(mergeOrderProbe([{ ticket: 2, dependsOn: [1] }, { ticket: 1, dependsOn: [2] }])).toEqual({
      order: [],
      stuck: [1, 2],
    });
  });

  test("mergeOrderProbe resolves an independent ticket before hitting a cycle elsewhere in the set", () => {
    const result = mergeOrderProbe([
      { ticket: 2, dependsOn: [1] },
      { ticket: 1, dependsOn: [2] },
      { ticket: 30, dependsOn: [] },
    ]);
    expect(result.order).toEqual([{ ticket: 30, stackedOn: [] }]);
    expect(result.stuck).toEqual([1, 2]);
  });

  test("one merge at a time, in dependency order across approved lanes", () => {
    // Both lanes are already gated green (#178) so this test stays about ORDER.
    let s = state(
      [ticket(20, "Review"), ticket(21, "Review", [20])],
      [
        lane(21, "reviewer", { outcome: approve(100), mergeGate: GREEN_GATE }),
        lane(20, "reviewer", { outcome: approve(100), mergeGate: GREEN_GATE }),
      ]
    );
    // The parent merges first even though the child's lane comes first in the array.
    const a = nextAction(s, 0);
    expect(a).toEqual({ kind: "advance", ticket: 20, to: "merge", stackedOn: [] });
    s = applyAction(s, a, 0);
    // Child stays gated while the parent is mid-merge.
    expect(nextAction(s, 0)).toEqual({ kind: "wait" });
    s = recordOutcome(s, 20, HAPPY.merge, 0);
    s = applyAction(s, nextAction(s, 0), 0); // complete #20
    // #20 merging moved the base under #21, so its pre-parent green stops
    // counting and it re-gates first (review finding 3).
    expect(nextAction(s, 0)).toEqual({ kind: "merge-gate", ticket: 21 });
    s = recordMergeGate(s, 21, GREEN_GATE, 0);
    // Then it advances, carrying its stacked parent for the merge prompt.
    expect(nextAction(s, 0)).toEqual({ kind: "advance", ticket: 21, to: "merge", stackedOn: [20] });
  });
});

// -- merge-gate cycle among review-approved lanes (issue #146) ---------------
// A dependency cycle discovered before merge (unclaimed tickets, no lane yet)
// already parks gracefully (see "deadlock breaker" above). This is the OTHER
// throw site: mergeOrder() called unguarded from the merge gate on lanes that
// already passed review. Two review-approved lanes whose tickets each list
// the other in `dependsOn` used to throw ZError out of nextAction and exit the
// whole drain; it must park instead, same as every other unresolvable
// situation (PROCESS.md's "park with a comment, never a stall").

describe("merge-gate cycle parks instead of throwing (#146)", () => {
  test("AC1: a 2-lane cycle parks the lowest ticket Blocked, naming both, and never throws", () => {
    const s = state(
      [ticket(10, "Review", [11]), ticket(11, "Review", [10])],
      [
        lane(10, "reviewer", { outcome: approve(100) }),
        lane(11, "reviewer", { outcome: approve(100) }),
      ]
    );
    expect(() => nextAction(s, 0)).not.toThrow();
    const a = nextAction(s, 0);
    expect(a).toMatchObject({
      kind: "park",
      ticket: 10,
      status: "Blocked",
      note: expect.stringContaining("Dependency cycle among review-approved lanes: #10, #11"),
    });
  });

  test("AC2: a third, non-cycle review-approved lane still merges normally in the same drain", () => {
    let s = state(
      [ticket(10, "Review", [11]), ticket(11, "Review", [10]), ticket(30, "Review")],
      [
        lane(10, "reviewer", { outcome: approve(100) }),
        lane(11, "reviewer", { outcome: approve(100) }),
        lane(30, "reviewer", { outcome: approve(100), mergeGate: GREEN_GATE }),
      ]
    );
    // The cycle doesn't block the independent lane: #30 merges this very tick.
    const a = nextAction(s, 0);
    expect(a).toEqual({ kind: "advance", ticket: 30, to: "merge", stackedOn: [] });
    s = applyAction(s, a, 0);
    s = recordOutcome(s, 30, HAPPY.merge, 0);
    s = applyAction(s, nextAction(s, 0), 0); // complete #30
    expect(s.tickets.find((t) => t.number === 30)!.status).toBe("Done");
    // #30 out of the way: only the cycle remains, and it now parks.
    expect(nextAction(s, 0)).toMatchObject({ kind: "park", ticket: 10, status: "Blocked" });
  });

  test("continuing the drain eventually parks BOTH cycle members, never merges the survivor", () => {
    // Regression for the naive fix: once #10 parks Blocked, #11's dependency on
    // #10 drops OUT of the merge-ready set (already merged, mergeOrder assumes)
    // -- which would wrongly read #11 as free to merge. The merge gate must
    // catch #11's now-dead dependency (#10 is terminal, never reaching Done)
    // the same way step 4 catches a dead-dependency unclaimed ticket, before
    // ever computing a merge order.
    let s = state(
      [ticket(10, "Review", [11]), ticket(11, "Review", [10])],
      [
        lane(10, "reviewer", { outcome: approve(100) }),
        lane(11, "reviewer", { outcome: approve(100) }),
      ]
    );
    const first = nextAction(s, 0);
    expect(first).toMatchObject({ kind: "park", ticket: 10, status: "Blocked" });
    s = applyAction(s, first, 0);
    expect(s.tickets.find((t) => t.number === 10)!.status).toBe("Blocked");
    // #11 is NOT merged next -- its dependency on the now-Blocked #10 parks it too.
    const second = nextAction(s, 0);
    expect(second).toMatchObject({
      kind: "park",
      ticket: 11,
      status: "Blocked",
      note: expect.stringContaining("#10 (Blocked)"),
    });
    s = applyAction(s, second, 0);
    expect(s.tickets.find((t) => t.number === 11)!.status).toBe("Blocked");
    expect(nextAction(s, 0)).toEqual({ kind: "drain-complete" });
  });
});

// -- drain-complete -----------------------------------------------------------

describe("drain-complete", () => {
  test("all terminal statuses and no lanes -> drain-complete", () => {
    const s = state([ticket(1, "Done"), ticket(2, "Questions"), ticket(3, "Blocked"), ticket(4, "Skipped")]);
    expect(nextAction(s, 0)).toEqual({ kind: "drain-complete" });
    expect(drainComplete(s.tickets, s.lanes)).toBe(true);
  });

  test("a workable ticket or a live lane blocks the drain", () => {
    const s = state([ticket(1, "Done"), ticket(2, "Building")]);
    expect(drainComplete(s.tickets, s.lanes)).toBe(false);
    expect(nextAction(s, 0).kind).toBe("claim");
    const s2 = state([ticket(1, "Done")], [lane(9, "builder", { lastActivityMs: 0 })]);
    expect(drainComplete(s2.tickets, s2.lanes)).toBe(false);
  });

  test("a ticket claimed by another session is outside this batch", () => {
    let s = state([ticket(1, "Done"), ticket(2, "Building")]);
    s = markClaimLost(s, 2, 0);
    expect(claimableTickets(s.tickets, s.lanes)).toEqual([]);
    expect(nextAction(s, 0)).toEqual({ kind: "drain-complete" });
  });

  test("a dependency cycle inside the batch parks instead of spinning forever", () => {
    const s = state([ticket(1, "Building", [2]), ticket(2, "Building", [1])]);
    const a = nextAction(s, 0);
    expect(a).toMatchObject({ kind: "park", ticket: 1, status: "Blocked", note: expect.stringContaining("deadlock") });
  });
});

// -- human-needed safety control (issue #63) ----------------------------------

describe("humanNeededTripped", () => {
  test("AC1: below threshold does not trip (1/10 = 10%)", () => {
    expect(humanNeededTripped(1, 0, 0, 10, 30)).toBe(false);
  });

  test("AC2: exactly at threshold does not trip (strict >, 3/10 = 30%)", () => {
    expect(humanNeededTripped(3, 0, 0, 10, 30)).toBe(false);
  });

  test("AC3: above threshold trips (4/10 = 40%)", () => {
    expect(humanNeededTripped(4, 0, 0, 10, 30)).toBe(true);
  });

  test("AC4: percent 0 disables regardless of counts (100% parked)", () => {
    expect(humanNeededTripped(10, 10, 10, 10, 0)).toBe(false);
  });

  test("AC5: initialReady 0 never trips (division-by-zero guarded)", () => {
    expect(humanNeededTripped(5, 5, 5, 0, 30)).toBe(false);
  });
});

describe("humanNeededStatus / markHumanNeededNotified", () => {
  test("AC6: reports tripped + alreadyNotified + which tickets", () => {
    const s = state(
      [
        ticket(1, "Blocked"),
        ticket(2, "Blocked"),
        ticket(3, "Skipped"),
        ticket(4, "Questions"),
        ...([5, 6, 7, 8, 9, 10].map((n) => ticket(n, "Building"))),
      ],
      []
    );
    s.initialReadyCount = 10;
    s.humanNeededPercent = 30;
    const status = humanNeededStatus(s);
    expect(status.tripped).toBe(true); // 4/10 = 40% > 30%
    expect(status.alreadyNotified).toBe(false);
    expect(status.blocked).toBe(2);
    expect(status.skipped).toBe(1);
    expect(status.questions).toBe(1);
    expect(status.initialReadyCount).toBe(10);
    expect(status.percent).toBe(30);
    expect(status.tickets.blocked).toEqual([1, 2]);
    expect(status.tickets.skipped).toEqual([3]);
    expect(status.tickets.questions).toEqual([4]);
  });

  test("AC7: markHumanNeededNotified flips alreadyNotified without clearing tripped (fire-once)", () => {
    const s = state(
      [ticket(1, "Blocked"), ticket(2, "Blocked"), ticket(3, "Skipped"), ticket(4, "Questions")],
      []
    );
    s.initialReadyCount = 10;
    s.humanNeededPercent = 30;
    expect(humanNeededStatus(s).alreadyNotified).toBe(false);
    const acked = markHumanNeededNotified(s);
    const status = humanNeededStatus(acked);
    expect(status.tripped).toBe(true); // still over threshold
    expect(status.alreadyNotified).toBe(true); // fire-once flag now set
    // pure: input untouched
    expect(humanNeededStatus(s).alreadyNotified).toBe(false);
  });
});

// -- deadlock breaker vs cross-session deps (issue #14 C7) --------------------

describe("deadlock breaker excludes still-completable deps", () => {
  test("a ticket whose only unsatisfied dep is claimedByOther waits, never parks", () => {
    // #2 is being built by another session (claimedByOther, not Done). #1 depends
    // on it. There is no in-batch cycle -- #2 will finish elsewhere -- so #1 must
    // WAIT, not be wrongly parked Blocked as a phantom cycle.
    //
    // claimedByOtherAt: 0 keeps the flag inside its confirm throttle at nowMs 0.
    // This case is about the wait-vs-park discriminator, not #223's read
    // schedule; an UNSTAMPED flag is due for a confirm at any clock (AC2b).
    const s = state([ticket(1, "Building", [2]), ticket(2, "Building", [], { claimedByOther: true, claimedByOtherAt: 0 })]);
    expect(nextAction(s, 0)).toEqual({ kind: "wait" });
  });

  test("a genuine in-batch 2-cycle still parks the lowest ticket Blocked", () => {
    const s = state([ticket(1, "Building", [2]), ticket(2, "Building", [1])]);
    expect(nextAction(s, 0)).toMatchObject({
      kind: "park", ticket: 1, status: "Blocked", note: expect.stringContaining("cycle"),
    });
  });

  test("a dep that can never complete in THIS batch (Backlog, not claimed elsewhere) parks, never waits forever", () => {
    // #7 (Ready) depends on #8 which sits in Backlog: the loop never pulls Backlog
    // into the batch and no other session owns it, so waiting would burn tokens
    // forever. It must park Blocked so a human notices -- NOT wait.
    const s = state([ticket(7, "Ready", [8]), ticket(8, "Backlog")]);
    expect(nextAction(s, 0)).toMatchObject({ kind: "park", ticket: 7, status: "Blocked" });
  });

  test("a real cycle plus a cross-session dependent waits until the external work resolves", () => {
    // #1<->#2 are a real cycle, but #3 waits on #9 (claimed elsewhere). Not EVERY
    // stuck ticket is mutually blocked, so wait rather than park anything yet; once
    // #9 lands and #3 drains, the residual pure cycle parks on a later tick.
    const s = state([
      ticket(1, "Building", [2]),
      ticket(2, "Building", [1]),
      ticket(3, "Building", [9]),
      ticket(9, "Building", [], { claimedByOther: true, claimedByOtherAt: 0 }), // stamped: see above
    ]);
    expect(nextAction(s, 0)).toEqual({ kind: "wait" });
  });
});

// -- dead merge worker: verify PR, don't blind-skip (issue #14 H9) ------------

describe("dead merge worker path", () => {
  const MIN = 60_000;

  test("a dead merge lane is held at check-worker, never blind-skipped", () => {
    const s = state([ticket(1, "Review")], [lane(1, "merge", { workerDead: true, lastActivityMs: 0 })]);
    // Silent past the watchdog AND probed dead: a normal stage would skip here.
    const a = nextAction(s, 11 * MIN);
    expect(a).toEqual({ kind: "check-worker", ticket: 1 });
  });

  test("recording MERGED on the dead merge lane completes it and counts mergedThisRun", () => {
    let s = state([ticket(1, "Review")], [lane(1, "merge", { workerDead: true })]);
    // The SKILL's gh pr view found the PR landed before the worker died.
    s = recordOutcome(s, 1, "MERGED: https://pr/9", 0);
    const a = nextAction(s, 0);
    expect(a).toMatchObject({ kind: "complete", ticket: 1 });
    s = applyAction(s, a, 0);
    expect(s.tickets[0].status).toBe("Done");
    expect(s.mergedThisRun).toContain(1); // retarget/branch-delete logic still sees it
  });

  test("a dead non-merge worker still skips (regression guard)", () => {
    const s = state([ticket(1, "Building")], [lane(1, "builder", { workerDead: true, lastActivityMs: 0 })]);
    expect(nextAction(s, 11 * MIN).kind).toBe("skip");
  });
});

// -- #209: a stage that died without a marker, holding finished work ----------
//
// Run 11's #170 builder addressed both reviewer findings, backgrounded its own
// `bun test`, and ended its turn waiting on it. A markerless final message parses
// as CONFUSED, and the only answer the machine had was `skip` -- discarding
// `lib/cost.ts` + `tests/cost.test.ts` sitting uncommitted in the worktree along
// with the $2.11 that spawn had already spent. The recovery is a bounded
// re-spawn at the SAME stage; the cap is what keeps it from becoming the
// unbounded retry loop the straight-to-skip design was avoiding.

describe("dead-worker re-spawn (#209)", () => {
  const MIN = 60_000;
  const NOW = 11 * MIN; // past the 10-minute watchdog
  // The exact shape run 11 left behind, and its counterpart.
  const DIRTY = "## z/ticket-1\n M lib/cost.ts\n M tests/cost.test.ts\n";
  const CLEAN = "## z/ticket-1...origin/main\n";

  // A lane whose worker went silent and probed dead, with the worktree facts the
  // orchestrator collected at probe time (omitted entirely = a pre-#209 probe).
  function deadLane(porcelain: string | undefined, over: Partial<LaneState> = {}, stage: Stage = "builder"): LoopState {
    const status = stage === "builder" ? "Building" : stage === "qa" ? "QA" : "Review";
    const s = state([ticket(1, status)], [lane(1, stage, { lastActivityMs: 0, ...over })]);
    return recordProbe(s, 1, false, NOW, porcelain);
  }

  test("AC2: dead with no marker + a dirty worktree -> respawn at the same stage, next attempt", () => {
    let s = deadLane(DIRTY);
    expect(s.lanes[0].worktreeDirty).toBe(true);
    const a = nextAction(s, NOW);
    expect(a.kind).toBe("respawn");
    const r = a as { ticket: number; stage: Stage; attempt: number; note: string };
    expect(r.ticket).toBe(1);
    expect(r.stage).toBe("builder"); // SAME stage -- not a rebuild from Ready
    // The dead spawn was attempt 1; re-using its tag makes `transcripts collect`
    // refuse and re-using its <stage>-<attempt> name overwrites its transcript.
    expect(r.attempt).toBe(2);
    s = applyAction(s, a, NOW);
    expect(s.lanes[0].stage).toBe("builder");
    expect(s.tickets[0].status).toBe("Building"); // no board move: it never left
    expect(s.lanes[0].respawns).toEqual({ builder: 1 }); // spent against THIS stage

    expect(s.lanes[0].workerDead).toBeUndefined(); // fresh agent, fresh probe state
    expect(s.lanes[0].worktreeDirty).toBeUndefined();
    expect(s.lanes[0].lastActivityMs).toBe(NOW); // watchdog baseline restarts
    // The action's attempt and the CLI's post-apply reading are the same number.
    expect(stageAttempt(s.lanes[0])).toBe(r.attempt);
  });

  test("AC3: a second silent death spends no further respawn -- the cap holds", () => {
    const s = deadLane(DIRTY, { respawns: { builder: MAX_DEAD_RESPAWNS } });
    const a = nextAction(s, NOW);
    expect(a.kind).toBe("skip");
    expect((a as { note: string }).note).toContain("not a slip");
  });

  // The Plan's words are "a hard cap -- one respawn per stage per lane", and the
  // difference is not cosmetic: a builder that died silently is no evidence at all
  // about the QA agent that runs after it, so a lane-wide counter would spend QA's
  // only recovery on the builder's failure and skip a ticket whose QA worktree
  // holds real work. Driven through the reducer, because the budget is only
  // per-stage if applyAction keys it that way.
  describe("the cap is per (stage, lane), not per lane", () => {
    test("a spent builder re-spawn still leaves QA its own", () => {
      let s = deadLane(DIRTY);
      s = applyAction(s, nextAction(s, NOW), NOW); // builder's one re-spawn, spent
      expect(s.lanes[0].respawns).toEqual({ builder: 1 });
      // ...the fresh builder succeeds and the lane moves on to QA...
      s = applyAction(s, { kind: "advance", ticket: 1, to: "qa" }, NOW);
      // ...where the QA agent dies exactly the same way.
      s = recordProbe(s, 1, false, 2 * NOW, DIRTY);
      const a = nextAction(s, 2 * NOW);
      expect(a.kind).toBe("respawn"); // NOT skip: builder's budget was not QA's
      expect((a as { stage: Stage }).stage).toBe("qa");
      s = applyAction(s, a, 2 * NOW);
      expect(s.lanes[0].respawns).toEqual({ builder: 1, qa: 1 });
      // Each stage's own budget is now spent, and each holds independently.
      s = recordProbe(s, 1, false, 3 * NOW, DIRTY);
      expect(nextAction(s, 3 * NOW).kind).toBe("skip");
    });

    test("a builder re-spawn does not shift QA's attempt numbering", () => {
      let s = deadLane(DIRTY);
      s = applyAction(s, nextAction(s, NOW), NOW);
      expect(stageAttempt(s.lanes[0])).toBe(2); // builder's SECOND spawn
      s = applyAction(s, { kind: "advance", ticket: 1, to: "qa" }, NOW);
      expect(stageAttempt(s.lanes[0])).toBe(1); // QA's FIRST, not its second
    });
  });

  test("AC4: dead with a CLEAN worktree still skips, with the pre-#209 note verbatim", () => {
    const s = deadLane(CLEAN);
    expect(s.lanes[0].worktreeDirty).toBe(false);
    expect(nextAction(s, NOW)).toEqual({
      kind: "skip",
      ticket: 1,
      note: "Worker died mid-builder: silent past the 10-minute watchdog and not alive on probe. Skipped per the PROCESS.md no-token-burn rule; worktree left for inspection.",
    });
  });

  // A state file written before this ticket (or an orchestrator that skipped the
  // status collection) carries no worktree facts at all: unchanged behavior.
  test("no worktree facts at all -> the old skip, no respawn spent", () => {
    const s = deadLane(undefined);
    expect(s.lanes[0].worktreeDirty).toBeUndefined();
    expect(nextAction(s, NOW).kind).toBe("skip");
  });

  // Output with no `## <branch>` header is UNREADABLE, not clean -- it cannot
  // prove an empty tree, and failing that direction costs at most one bounded
  // re-spawn while the other direction discards finished work.
  test("an unreadable status payload buys the respawn rather than discarding the lane", () => {
    expect(worktreeHoldsWork("fatal: not a git repository\n")).toBe(true);
    expect(worktreeHoldsWork("## z/ticket-1\n")).toBe(false);
    expect(worktreeHoldsWork("## z/ticket-1\n?? tests/new.test.ts\n")).toBe(true); // untracked counts
    expect(nextAction(deadLane("fatal: not a git repository\n"), NOW).kind).toBe("respawn");
  });

  // ...but an EMPTY payload is a different fact, and review caught the first cut
  // treating them as one. The `> file` redirect creates the file BEFORE git runs,
  // and `git status --porcelain --branch` ALWAYS prints its header when it runs
  // at all, so zero bytes means git failed outright -- which is exactly what a
  // MISSING or broken worktree yields (exit 128, nothing on stdout). Re-spawning
  // there spends a paid agent on a directory that is not present and briefs it
  // that "its worktree still holds UNCOMMITTED changes", which is a falsehood.
  // Reading it as no facts also means every re-spawn that DOES happen fires on a
  // worktree git successfully read seconds earlier, which is what makes that
  // briefing true.
  test("an EMPTY status payload is no facts at all -- no re-spawn into a worktree that is gone", () => {
    expect(worktreeHoldsWork("")).toBe(false);
    expect(worktreeHoldsWork("   \n")).toBe(false);
    const s = deadLane("");
    expect(s.lanes[0].worktreeDirty).toBe(false);
    const a = nextAction(s, NOW);
    expect(a.kind).toBe("skip");
    expect((a as { note: string }).note).toContain("worktree left for inspection");
    expect((a as { note: string }).note).not.toContain("uncommitted work"); // nothing to salvage, so no patch promised
  });

  // Review finding 3: the human-park guard in step 1 only inspects lanes that
  // RECORDED an outcome (`if (!lane.outcome) continue;`), and a worker that died
  // silently has none by definition -- so a ticket a human dragged to Blocked
  // mid-run fell straight through to the dead-worker branch and got a fresh paid
  // builder spawned into it. The board move is respected instead: the lane stops,
  // the human's status stands (no Skipped overwrite), and nothing is spent.
  test("a human's mid-run park beats the re-spawn: stop the lane, spend nothing", () => {
    for (const status of ["Blocked", "Questions"] as const) {
      let s = deadLane(DIRTY);
      s.tickets[0].status = status; // dragged on the board while the worker was dying
      const a = nextAction(s, NOW);
      expect(a.kind).toBe("stop-lane");
      expect((a as { note: string }).note).toContain("a human");
      s = applyAction(s, a, NOW);
      expect(s.lanes).toEqual([]); // lane dropped...
      expect(s.tickets[0].status).toBe(status); // ...and the human's status untouched
    }
    // The budget is not spent either: nothing was re-spawned.
    const parked = deadLane(DIRTY);
    parked.tickets[0].status = "Blocked";
    expect(applyAction(parked, nextAction(parked, NOW), NOW).lanes).toHaveLength(0);
  });

  // stop-lane drops the lane lock exactly like park and skip do, so the lockless
  // `ticket-<N>` worktree is an orphan the next `--reconcile` force-removes
  // (lib/reconcile.ts: orphanWorktrees -> prune-worktree -> `git worktree remove
  // --force`). An earlier cut of this branch promised that tree was "kept for
  // inspection" -- and pinned the promise in a test -- 33 lines above the skip
  // branch that documents the same chain and dumps a patch because of it.
  test("the human-park stop-lane salvages the work it used to promise to keep", () => {
    const s = deadLane(DIRTY);
    s.tickets[0].status = "Blocked";
    const a = nextAction(s, NOW);
    expect(a).toMatchObject({ kind: "stop-lane", salvage: true });
    const note = (a as { note: string }).note;
    expect(note).toContain("reports/uncommitted-1.patch");
    expect(note).toContain("git apply");
    expect(note).not.toContain("kept for inspection"); // the claim reconcile disproves

    // Nothing to strand, nothing to dump: no flag, no patch promised.
    const clean = deadLane(CLEAN);
    clean.tickets[0].status = "Blocked";
    const b = nextAction(clean, NOW);
    expect(b.kind).toBe("stop-lane");
    expect((b as { salvage?: true }).salvage).toBeUndefined();
    expect((b as { note: string }).note).not.toContain("uncommitted-1.patch");
  });

  test("a QA lane recovers the same way; a reviewer lane never does", () => {
    expect(nextAction(deadLane(DIRTY, {}, "qa"), NOW).kind).toBe("respawn");
    // The reviewer executes in a THROWAWAY worktree, so a dirty lane worktree is
    // not its work -- and its four-key blinded input has nowhere to put a "your
    // predecessor left this" briefing. A thin review is #191's retry, not this.
    expect(nextAction(deadLane(DIRTY, {}, "reviewer"), NOW).kind).toBe("skip");
  });

  test("a dead MERGE lane is still held at check-worker, dirty worktree or not (H9)", () => {
    const s = state([ticket(1, "Review")], [lane(1, "merge", { lastActivityMs: 0 })]);
    const probed = recordProbe(s, 1, false, NOW, DIRTY);
    expect(nextAction(probed, NOW)).toEqual({ kind: "check-worker", ticket: 1 });
  });

  // Four failures, four budgets: a worker dying silently must not consume the
  // rebuild a QA bug, a reviewer finding, or a missed commit is holding.
  test("a respawn spends only respawns, and the other three counters stay put", () => {
    let s = deadLane(DIRTY, { qaBounces: 1, reviewBounces: 1, commitRetries: 1 });
    s = applyAction(s, nextAction(s, NOW), NOW);
    expect(s.lanes[0].respawns).toEqual({ builder: 1 });
    expect(s.lanes[0].qaBounces).toBe(1);
    expect(s.lanes[0].reviewBounces).toBe(1);
    expect(s.lanes[0].commitRetries).toBe(1);
    // Every re-spawn route counts toward the attempt, so no two spawns of this
    // lane's builder can mint the same tag: 1 + 1 + 1 + 1 + 1.
    expect(stageAttempt(s.lanes[0])).toBe(5);
  });

  // This stage's ONE re-spawn, then the skip -- driven end to end, because without
  // applyAction's increment `spent` never grows and a lane whose environment
  // keeps killing workers re-spawns forever on the loop's money.
  test("the sequence converges: respawn once, then Skipped", () => {
    let s = deadLane(DIRTY);
    s = applyAction(s, nextAction(s, NOW), NOW);
    s = recordProbe(s, 1, false, 2 * NOW, DIRTY); // dies the same way again
    const a = nextAction(s, 2 * NOW);
    expect(a.kind).toBe("skip");
    s = applyAction(s, a, 2 * NOW);
    expect(s.tickets[0].status).toBe("Skipped");
    expect(s.lanes).toEqual([]);
  });

  // Skipping removes the lane lock, and a lockless worktree is force-removed by
  // the next run's reconcile scan -- so a skip note promising "worktree left for
  // inspection" would be pointing the human at a directory the loop deletes.
  // Same salvage contract as #177's park, on the same structural key.
  test("the cap-exhausted skip names a durable salvage patch, and the SKILL dumps it", () => {
    const s = deadLane(DIRTY, { respawns: { builder: MAX_DEAD_RESPAWNS } });
    const a = nextAction(s, NOW);
    expect(a).toMatchObject({ kind: "skip", salvage: true });
    const note = (a as { note: string }).note;
    expect(note.startsWith("Worker died mid-")).toBe(true); // the SKILL's Notify key
    expect(note).toContain("reports/uncommitted-1.patch");
    expect(note).toContain("git apply");
    expect(note).toContain("force-removes it");
    expect(note).not.toContain("worktree left for inspection");
    // ...and the skip with nothing to strand carries no flag at all.
    expect((nextAction(deadLane(CLEAN), NOW) as { salvage?: true }).salvage).toBeUndefined();
    const skill = readFileSync(join(REPO_ROOT, "z-loop", "SKILL.md"), "utf8");
    const has = (x: string) => skill.includes(x); // booleans: a miss must not dump 60KB
    expect(has(`git -C ".worktrees/ticket-<N>" add -A`)).toBe(true);
    expect(has("diff --cached --binary HEAD")).toBe(true);
    expect(has(`> "$HOME/.zstack/projects/$SLUG/reports/uncommitted-<N>.patch"`)).toBe(true);
  });

  // applyAction spends `respawns[lane.stage]`, not `respawns[action.stage]`, and
  // reads the attempt off the lane too -- so applying an action built for a stage
  // the lane has since left would spend the wrong budget and shift the wrong
  // stage's stageAttempt. That is the duplicate-spawn-tag class the derivation
  // header exists to prevent (a re-used tag makes `transcripts collect` refuse and
  // a re-used transcript name overwrites its predecessor's spend), so it throws.
  test("a respawn action for a stage the lane has left is refused, not applied to the wrong one", () => {
    const s = deadLane(DIRTY);
    const a = nextAction(s, NOW);
    expect(a).toMatchObject({ kind: "respawn", stage: "builder" });
    const moved = structuredClone(s);
    moved.lanes[0].stage = "qa"; // some other tick advanced it first
    expect(() => applyAction(moved, a, NOW)).toThrow(ZError);
    expect(() => applyAction(moved, a, NOW)).toThrow(/stage "builder" but the lane is now at "qa"/);
    expect(moved.lanes[0].respawns).toBeUndefined(); // no budget spent on the wrong stage
    // The matching lane still applies, unchanged.
    expect(applyAction(s, a, NOW).lanes[0].respawns).toEqual({ builder: 1 });
  });

  test("an alive probe clears a stale worktree reading", () => {
    let s = deadLane(DIRTY);
    s = recordProbe(s, 1, true, NOW);
    expect(s.lanes[0].workerDead).toBeUndefined();
    expect(s.lanes[0].worktreeDirty).toBeUndefined();
    expect(nextAction(s, NOW)).toEqual({ kind: "wait" });
  });

  // worktreeDirty describes ONE probe of ONE stage's leftovers. Every route that
  // ends a stage or takes a fresh probe must therefore re-establish it, because a
  // reading that outlives its stage is a fact about a worktree nobody looked at:
  // it buys a paid re-spawn on evidence that does not exist, and makes `loop
  // probe`'s own stdout assert a status it never collected.
  describe("the worktree reading never outlives the probe that took it", () => {
    test("an advance to the next stage drops it", () => {
      let s = deadLane(DIRTY);
      expect(s.lanes[0].worktreeDirty).toBe(true);
      s = applyAction(s, { kind: "advance", ticket: 1, to: "qa" }, NOW);
      expect(s.lanes[0].worktreeDirty).toBeUndefined();
      // ...so a later death at QA with no facts collected skips, as documented.
      s = recordProbe(s, 1, false, 2 * NOW);
      expect(nextAction(s, 2 * NOW).kind).toBe("skip");
    });

    test("a second dead probe with no facts drops the first probe's reading", () => {
      let s = deadLane(DIRTY);
      s = recordProbe(s, 1, false, NOW); // probed again, status never collected
      expect(s.lanes[0].worktreeDirty).toBeUndefined();
      expect(nextAction(s, NOW).kind).toBe("skip");
    });

    test("a second dead probe that DOES collect facts overwrites the first", () => {
      let s = deadLane(DIRTY);
      s = recordProbe(s, 1, false, NOW, CLEAN); // the work got committed meanwhile
      expect(s.lanes[0].worktreeDirty).toBe(false);
      expect(nextAction(s, NOW).kind).toBe("skip");
    });
  });

  test("the respawn note hands the fresh agent the keep/fix/drop call", () => {
    const note = (nextAction(deadLane(DIRTY), NOW) as { note: string }).note;
    expect(note).toContain("UNCOMMITTED");
    expect(note).toContain("unverified");
    expect(note).toContain("keep, fix, or drop");
    expect(note).toContain("never emitted an exit marker");
    // It must name the budget it just spent honestly: the STAGE's, not the lane's,
    // or the agent reads "one shot for this whole ticket" and it is not true.
    expect(note).toContain("This lane's builder stage has ONE re-spawn");
    expect((nextAction(deadLane(DIRTY, {}, "qa"), NOW) as { note: string }).note).toContain("This lane's qa stage has ONE re-spawn");
  });

  // stageAttempt is the one definition of a spawn's <attempt>; a route that
  // re-spawns a stage without counting here mints a duplicate tag.
  test("stageAttempt counts every re-spawn route, per stage", () => {
    expect(stageAttempt(lane(1, "builder"))).toBe(1);
    expect(stageAttempt(lane(1, "builder", { qaBounces: 2, reviewBounces: 1, commitRetries: 1, respawns: { builder: 1 } }))).toBe(6);
    // A reviewer bounce sends the lane back through the builder and into QA a
    // SECOND time, so reviewBounces counts here as well as at builder.
    expect(stageAttempt(lane(1, "qa", { qaBounces: 2, reviewBounces: 1, respawns: { qa: 1 } }))).toBe(5);
    // #191's quorum retry re-spawns the REVIEWER at the same stage, so it counts
    // here too -- the SKILL's old prose formula omitted it.
    expect(stageAttempt(lane(1, "reviewer", { reviewBounces: 1, quorumRetries: 1 }))).toBe(3);
    expect(stageAttempt(lane(1, "merge"))).toBe(1);
    // Per-stage: another stage's re-spawn is not this one's.
    expect(stageAttempt(lane(1, "qa", { respawns: { builder: 1, reviewer: 1, merge: 1 } }))).toBe(1);
  });

  // Finding-2 regression, driven through the REAL reducer rather than by handing
  // stageAttempt a fixture: the reviewer-bounce path advances straight from
  // `built` to qa (resolveOutcome) without touching qaBounces, so a formula
  // missing reviewBounces gave a lane's first and second QA spawns the SAME
  // number. Both then stamp spawnTag(slug, N, "qa", 1), `transcripts collect`
  // refuses ("matches 2 orchestrator-spawned agents"), and BOTH QA spawns' tokens
  // go uncounted -- the #190 undercount this machinery exists to prevent.
  // Reachable on any ticket that takes a single reviewer bounce.
  test("a reviewer bounce does not make the lane's two QA spawns share an attempt", () => {
    let s = state([ticket(1, "Ready")], []);
    s = applyAction(s, nextAction(s, 0), 0); // claim -> builder
    const attempts: number[] = [];
    const finish = (msg: string) => {
      s = recordOutcome(s, 1, msg, 0);
      s = applyAction(s, nextAction(s, 0), 0);
      if (s.lanes[0]?.stage === "qa") attempts.push(stageAttempt(s.lanes[0]));
    };
    finish(HAPPY.builder); // -> qa (first QA spawn)
    finish(HAPPY.qa); // -> reviewer
    finish("REVIEW-FINDINGS: 1) AC3 is not covered"); // -> builder, reviewBounces 1
    expect(s.lanes[0].qaBounces).toBe(0); // the reviewer bounce never touches it
    finish(HAPPY.builder); // -> qa AGAIN (second QA spawn)
    expect(attempts).toEqual([1, 2]);
  });

  // The invariant stageAttempt exists for, checked over the whole machine instead
  // of one route at a time: walk every arrow that can re-spawn a stage and assert
  // no stage ever repeats an attempt number on one lane. Three duplicate-tag
  // defects have already come out of this formula (quorumRetries, a builder
  // re-spawn shifting QA, and the reviewer-bounce qa case), so the guard is the
  // property, not the three examples.
  test("no lane ever mints the same (stage, attempt) twice, over every re-spawn route", () => {
    const seen = new Set<string>();
    const record = (l: LaneState) => {
      const key = `${l.stage}-${stageAttempt(l)}`;
      expect(seen.has(key)).toBe(false); // a duplicate tag: `collect` would refuse
      seen.add(key);
    };
    let s = state([ticket(1, "Ready")], []);
    s.minSkepticQuorum = 2; // arms #191's reviewer -> reviewer self-advance below
    s = applyAction(s, nextAction(s, 0), 0);
    record(s.lanes[0]); // builder 1
    // #177's guard failure: a BUILT whose worktree is dirty and whose HEAD never
    // moved off the base -- the route that re-spawns the builder onto itself.
    const SHIPPED_NOTHING = { porcelain: DIRTY, headSha: "a".repeat(40), baseSha: "a".repeat(40) };
    const step = (msg: string, git?: typeof SHIPPED_NOTHING) => {
      s = recordOutcome(s, 1, msg, 0, git);
      s = applyAction(s, nextAction(s, 0), 0);
      record(s.lanes[0]);
    };
    const dieDirty = () => {
      s = recordProbe(s, 1, false, 11 * MIN, DIRTY);
      const a = nextAction(s, 11 * MIN);
      expect(a.kind).toBe("respawn");
      s = applyAction(s, a, 11 * MIN);
      s.lanes[0].lastActivityMs = 0; // the fresh agent's own watchdog baseline
      record(s.lanes[0]);
    };
    dieDirty(); // builder 2 (#209 re-spawn)
    step(HAPPY.builder, SHIPPED_NOTHING); // builder 3 (#177 commit re-spawn)
    step(HAPPY.builder); // qa 1
    dieDirty(); // qa 2 (#209 re-spawn -- QA's OWN budget, builder's is spent)
    step("QA-BUGS: 1) save button 500s"); // builder 4 (QA bounce)
    step(HAPPY.builder); // qa 3
    step(HAPPY.qa); // reviewer 1
    step("REVIEW-APPROVE: confidence=100 skeptics=0/3"); // reviewer 2 (#191 quorum)
    step("REVIEW-FINDINGS: 1) AC3 is not covered"); // builder 5 (reviewer bounce)
    step(HAPPY.builder); // qa 4 -- the finding-2 case, inside the walk
    step(HAPPY.qa); // reviewer 3
    expect(seen.size).toBe(12);
  });

  // The transition only helps if the orchestrator collects the facts, spawns the
  // right stage with the note, and tags it with the action's own attempt -- all
  // of which live in the SKILL. Same doc-canary discipline as #177's.
  test("the SKILL and the user docs carry the recovery contract", () => {
    const skill = readFileSync(join(REPO_ROOT, "z-loop", "SKILL.md"), "utf8");
    const has = (x: string) => skill.includes(x);
    expect(has("`respawn N at S`")).toBe(true);
    expect(has("respawnNotes")).toBe(true);
    // The dead probe must carry the worktree facts, with --branch for the same
    // fail-closed reason the BUILT verification needs it.
    expect(has(`probe "$STATE" <N> dead --porcelain "$TMP/porcelain-<N>.txt"`)).toBe(true);
    expect(has(`git -C ".worktrees/ticket-<N>" status --porcelain --branch > "$TMP/porcelain-<N>.txt"`)).toBe(true);
    // The attempt is computed, never re-derived in prose.
    expect(has(`bun "$PACK/lib/loop.ts" attempt "$STATE" <N>`)).toBe(true);
    expect(has("qaBounces + reviewBounces + commitRetries + respawns.builder + 1")).toBe(true);
    const docs = readFileSync(join(REPO_ROOT, "docs", "user-guide", "z-loop.md"), "utf8");
    expect(docs).toContain("died without ever reporting");
    expect(docs).toContain("uncommitted-<N>.patch");
    const trouble = readFileSync(join(REPO_ROOT, "docs", "user-guide", "troubleshooting.md"), "utf8");
    expect(trouble).toContain("dead-worker note but its worktree has real uncommitted changes");
  });
});

// -- #138: positive-evidence ingest ------------------------------------------
// The rule this replaces H14 (issue #14) with: the board affects loop state ONLY
// through positive observations. A ticket absent from a PAGINATED bulk read is a
// non-observation -- a short page and a real removal are indistinguishable at
// this boundary -- so absence carries forward and only a single-ticket lookup's
// positive "not on this project" (confirmedGone) removes anything.
describe("#138 positive-evidence ingest: absence carries forward", () => {
  // The board the loop is mid-drain on for AC1-AC3: 68 tickets, a lane on #40.
  function prev68(): LoopState {
    return {
      tickets: Array.from({ length: 68 }, (_, i) =>
        ticket(i + 1, i + 1 === 40 ? "Building" : "Ready", i + 1 === 7 ? [3] : [])
      ),
      lanes: [lane(40, "builder", { lastWroteStatus: "Building" })],
      maxLanes: 3,
      watchdogMinutes: 10,
      mergedThisRun: [12],
      initialReadyCount: 68,
      initialBatchTickets: [40],
      batchTickets: [40],
      humanNeededNotified: false,
    };
  }

  // AC1: a two-item read over a 68-ticket board.
  test("AC1: a 2-item read carries the other 66 forward unchanged, keeps the lane, and deep-clones", () => {
    const prev = prev68();
    const s = ingestBoardItems(
      prev,
      [
        { number: 40, title: "Ticket 40", fields: { Status: "Building" } },
        { number: 41, title: "Ticket 41", fields: { Status: "Done" } },
      ],
      { "40": "", "41": "" },
      undefined,
      []
    );
    expect(s.tickets.length).toBe(68);
    expect(s.tickets.map((t) => t.number)).toEqual(Array.from({ length: 68 }, (_, i) => i + 1));
    expect(s.lanes.map((l) => l.ticket)).toEqual([40]); // the in-flight lane is intact
    // The 66 unobserved tickets are byte-identical to what prev held -- status,
    // deps, everything -- and the 2 observed ones took the read's values.
    const byNum = new Map(s.tickets.map((t) => [t.number, t]));
    expect(byNum.get(7)).toEqual(prev.tickets.find((t) => t.number === 7)!);
    expect(byNum.get(41)!.status).toBe("Done");
    expect(byNum.get(68)!.status).toBe("Ready");

    // Deep clone, no aliasing: mutating the result never reaches prev.
    s.tickets[0].status = "Skipped";
    s.tickets[0].title = "mutated";
    s.lanes[0].stage = "merge";
    s.mergedThisRun!.push(999);
    s.batchTickets!.push(999);
    s.initialBatchTickets!.push(999);
    expect(prev.tickets[0].status).toBe("Ready");
    expect(prev.tickets[0].title).toBe("Ticket 1");
    expect(prev.lanes[0].stage).toBe("builder");
    expect(prev.mergedThisRun).toEqual([12]);
    expect(prev.batchTickets).toEqual([40]);
    expect(prev.initialBatchTickets).toEqual([40]);
  });

  // AC2: the #127 empty-read special case is GONE -- 0 items is just the case
  // where nothing was observed, and it flows through the same merge.
  test("AC2: a 0-item read carries everything forward through the same merge path", () => {
    const prev = prev68();
    const empty = ingestBoardItems(prev, [], {}, undefined, []);
    // Identical to a 1-item read of a ticket that did not change: same merge, no
    // branch. (Compared against a read of #40 exactly as prev already holds it.)
    const oneNoOp = ingestBoardItems(
      prev,
      [{ number: 40, title: "Ticket 40", fields: { Status: "Building", Model: "sonnet" }, labels: [] }],
      { "40": "" },
      undefined,
      []
    );
    expect(JSON.stringify(empty.tickets)).toBe(JSON.stringify(oneNoOp.tickets));
    expect(empty.lanes).toEqual(prev.lanes);
    expect(drainComplete(empty.tickets, empty.lanes, empty.batchTickets)).toBe(false);
    expect(nextAction(empty, 0).kind).not.toBe("drain-complete");
    // Never `prev` by reference (the old special case returned it verbatim).
    expect(empty).not.toBe(prev);
    empty.tickets[0].status = "Skipped";
    expect(prev.tickets[0].status).toBe("Ready");
  });

  // Source canary, comments stripped (the removal is DOCUMENTED in a comment
  // there, and documenting it must not satisfy the gate): no code path in
  // lib/loop.ts branches on an empty read any more.
  test("AC2: ingestBoardItems no longer carries an items.length === 0 special case", () => {
    const code = readFileSync(join(REPO_ROOT, "lib", "loop.ts"), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toContain("items.length === 0");
    expect(code).not.toContain("items.length ===");
  });

  // AC3: the H14 outcome survives, but ONLY on positive confirmation -- and
  // since #273 it is reached by the stop-lane ACTION, not by the reducer. The
  // ingest MARKS the lane; the apply is what removes ticket and lane together.
  test("AC3: confirmedGone stops exactly that ticket's lane and removes the pair, nothing else", () => {
    const prev = prev68();
    const s = ingestBoardItems(prev, [{ number: 41, title: "Ticket 41", fields: { Status: "Done" } }], { "41": "" }, undefined, [40]);
    // #273: the lane survives ingest carrying its reason, and so does a tombstone
    // ticket -- the state machine's only handle on the lane it must tear down.
    expect(s.lanes.map((l) => l.ticket)).toEqual([40]);
    expect(s.lanes[0].goneReason).toEqual({ kind: "confirmed-gone" });
    expect(s.tickets.find((t) => t.number === 40)).toBeDefined();
    expect(s.tickets.length).toBe(68); // every other ticket untouched
    expect(s.tickets.find((t) => t.number === 39)).toEqual(prev.tickets.find((t) => t.number === 39)!);
    // The action is the removal, and it is the FIRST thing nextAction returns.
    const a = nextAction(s, 0);
    expect(a.kind).toBe("stop-lane");
    expect((a as { ticket: number }).ticket).toBe(40);
    // And the state stays usable: the old H14 failure was a later apply throwing
    // in findTicket on the orphaned lane.
    const after = applyAction(s, a, 0);
    expect(after.lanes).toEqual([]);
    expect(after.tickets.find((t) => t.number === 40)).toBeUndefined();
    expect(after.tickets.length).toBe(67);
  });

  // Without this, the confirm pass re-looks-up a ticket it already proved gone on
  // EVERY remaining tick (it is still in batchTickets and still absent from every
  // read) -- one API call and one log line per tick for the rest of the drain.
  test("a confirmed-gone ticket leaves batchTickets, so it is never re-confirmed", () => {
    const prev = prev68();
    const s = ingestBoardItems(prev, [], {}, undefined, [40]);
    expect(s.batchTickets).toEqual([]);
    // #273: the lane is retained until its stop-lane is applied, and confirmTargets
    // watches lanes -- so the number would come back onto the target list for that
    // window. It does not: a lane already carrying a goneReason is skipped, because
    // it was marked BY a positive observation and a lookup can prove nothing new.
    // Zero wasted lookups both before the stop and after it.
    expect(confirmTargets(s, [])).toEqual([]);
    expect(confirmTargets(applyAction(s, nextAction(s, 0), 0), [])).toEqual([]);
    expect(prev.batchTickets).toEqual([40]); // and prev is untouched
    // The capture-once contract is otherwise intact: nothing was re-selected.
    expect(ingestBoardItems(prev, [], {}, undefined, []).batchTickets).toEqual([40]);
  });

  // AC6: the false mid-batch drain the prior design's review found (finding 3).
  test("AC6: a truncated read that drops the last un-built batch ticket does not drain-complete", () => {
    const prev: LoopState = {
      tickets: [ticket(1, "Done"), ticket(2, "Done"), ticket(3, "Ready")],
      lanes: [],
      maxLanes: 3,
      watchdogMinutes: 10,
      mergedThisRun: [1, 2],
      initialReadyCount: 3,
      initialBatchTickets: [1, 2, 3],
      batchTickets: [1, 2, 3],
      humanNeededNotified: false,
    };
    const s = ingestBoardItems(
      prev,
      [
        { number: 1, title: "Ticket 1", fields: { Status: "Done" } },
        { number: 2, title: "Ticket 2", fields: { Status: "Done" } },
      ],
      { "1": "", "2": "" },
      undefined,
      []
    );
    expect(s.tickets.find((t) => t.number === 3)!.status).toBe("Ready");
    expect(s.batchTickets).toEqual([1, 2, 3]); // the allow-list did not evaporate
    expect(drainComplete(s.tickets, s.lanes, s.batchTickets)).toBe(false);
    expect(nextAction(s, 0)).toMatchObject({ kind: "claim", ticket: 3 });
  });

  // AC7: an honest read with a big legitimate shrink in workable tickets is
  // ingested verbatim -- there is no shrink predicate anywhere on the path.
  test("AC7: an honest read in which 30 tickets went Done ingests exactly as read", () => {
    const nums = Array.from({ length: 40 }, (_, i) => i + 1);
    const prev: LoopState = {
      tickets: nums.map((n) => ticket(n, "Ready")),
      lanes: [],
      maxLanes: 3,
      watchdogMinutes: 10,
      mergedThisRun: [],
      initialReadyCount: 40,
      initialBatchTickets: nums,
      batchTickets: nums,
      humanNeededNotified: false,
    };
    const items = nums.map((n) => ({ number: n, title: `Ticket ${n}`, fields: { Status: n <= 30 ? "Done" : "Ready" } }));
    const bodies = Object.fromEntries(nums.map((n) => [String(n), ""]));
    const s = ingestBoardItems(prev, items, bodies, undefined, []);
    expect(s.tickets.filter((t) => t.status === "Done").length).toBe(30);
    expect(s.tickets.map((t) => t.number)).toEqual(nums); // nothing held back
    // Byte-identical to a plain ingest of the same read with no prior state at
    // all: carry-forward contributed nothing, so no heuristic could have.
    expect(JSON.stringify(s.tickets)).toBe(JSON.stringify(ingestBoardItems(null, items, bodies).tickets));
  });

  // The origin marker (#125) may only be cleared by a FRESH observation.
  // applyAction writes a lane's ticket status and its lastWroteStatus together,
  // so clearing off the merged (carried-forward) set would disarm the desync
  // guard with no board evidence at all.
  test("a carried-forward lane keeps its #125 origin marker; an observed one clears it", () => {
    const prev: LoopState = {
      tickets: [ticket(1, "QA"), ticket(2, "QA")],
      lanes: [lane(1, "qa", { lastWroteStatus: "QA" }), lane(2, "qa", { lastWroteStatus: "QA" })],
      maxLanes: 3,
      watchdogMinutes: 10,
      mergedThisRun: [],
    };
    const s = ingestBoardItems(prev, [{ number: 2, title: "Ticket 2", fields: { Status: "QA" } }], { "2": "" });
    expect(s.lanes.find((l) => l.ticket === 1)!.lastWroteStatus).toBe("QA"); // unobserved -> unproven
    expect(s.lanes.find((l) => l.ticket === 2)!.lastWroteStatus).toBeUndefined(); // observed -> landed
  });
});

// -- #138: which absences are worth a lookup, and folding the answers back in --

describe("#138 confirmTargets", () => {
  const items = [{ number: 5, title: "t5", fields: { Status: "Ready" } }];

  test("names the lane and batch tickets the read did not show, sorted, deduped", () => {
    const prev: LoopState = {
      tickets: [ticket(5, "Ready")],
      lanes: [lane(9, "builder"), lane(2, "qa")],
      maxLanes: 3,
      watchdogMinutes: 10,
      batchTickets: [2, 5, 7],
    };
    expect(confirmTargets(prev, items)).toEqual([2, 7, 9]);
  });

  test("no prior state (tick 1) and a fully-observed board both confirm nothing", () => {
    expect(confirmTargets(null, items)).toEqual([]);
    const prev: LoopState = { tickets: [ticket(5, "Ready")], lanes: [lane(5, "builder")], maxLanes: 3, watchdogMinutes: 10, batchTickets: [5] };
    expect(confirmTargets(prev, items)).toEqual([]);
  });
});

describe("#138 applyConfirmations", () => {
  const items = [{ number: 5, title: "t5", fields: { Status: "Ready" } }];
  const bodies = { "5": "body5" };

  test("a found ticket is spliced into the read (body included) and is not confirmed gone", () => {
    const r = applyConfirmations(items, bodies, [
      { number: 1, present: true, item: { number: 1, title: "t1", fields: { Status: "QA" } }, body: "Depends on #5" },
    ]);
    expect(r.items.map((i) => i.number)).toEqual([5, 1]);
    expect(r.bodies["1"]).toBe("Depends on #5");
    expect(r.confirmedGone).toEqual([]);
    expect(r.notes[0]).toContain("read missed #1");
    expect(r.notes[0]).toContain("still on the board");
  });

  test("a positively absent ticket becomes confirmedGone with the reason in its note", () => {
    const r = applyConfirmations(items, bodies, [{ number: 1, present: false, reason: "not-on-project" }]);
    expect(r.confirmedGone).toEqual([1]);
    expect(r.items.map((i) => i.number)).toEqual([5]);
    expect(r.notes[0]).toContain("gone from the board (not-on-project)");
    // #273: the note must not claim the confirm pass released anything -- it
    // proves a removal, and a lane still holding the ticket is torn down by the
    // stop-lane action that follows, not by this pass.
    expect(r.notes[0]).not.toContain("releasing its lane");
    expect(r.notes[0]).toContain("stopped by the next action");
  });

  test("a lookup for a ticket the read already showed, or one with no usable answer, changes nothing", () => {
    const already = applyConfirmations(items, bodies, [{ number: 5, present: false, reason: "not-on-project" }]);
    expect(already.confirmedGone).toEqual([]); // the read is the newer positive observation
    expect(already.notes).toEqual([]);
    const malformed = applyConfirmations(items, bodies, [{ number: 1, present: true }]);
    expect(malformed.confirmedGone).toEqual([]); // never drops a lane on a malformed answer
    expect(malformed.items.map((i) => i.number)).toEqual([5]);
    expect(malformed.notes[0]).toContain("carrying it forward");
  });

  test("no lookups at all is a pure pass-through (the fail-open shape)", () => {
    const r = applyConfirmations(items, bodies, []);
    expect(r.items).toEqual(items);
    expect(r.bodies).toEqual(bodies);
    expect(r.confirmedGone).toEqual([]);
    expect(r.items).not.toBe(items); // and never aliases its input
  });
});

// -- #127: a transient empty snapshot must NOT wipe tickets/lanes -------------
// #138 kept this contract and generalized it: the empty read is no longer a
// special case, it is the carry-forward merge with nothing observed.
describe("ingest preserves state on a transient empty snapshot (#127)", () => {
  test("a 0-item snapshot over tickets + in-flight lanes preserves both and does not drain-complete", () => {
    const prev: LoopState = {
      tickets: [ticket(119, "Review"), ticket(120, "Review")],
      lanes: [lane(119, "merge"), lane(120, "reviewer")],
      maxLanes: 3,
      watchdogMinutes: 10,
      mergedThisRun: [],
      initialReadyCount: 2,
      humanNeededNotified: false,
    };
    const s = ingestBoardItems(prev, [], {});
    expect(s.tickets.map((t) => t.number)).toEqual([119, 120]); // preserved, not wiped
    expect(s.lanes.map((l) => l.ticket)).toEqual([119, 120]); // in-flight lanes kept
    expect(drainComplete(s.tickets, s.lanes)).toBe(false);
    expect(nextAction(s, 0).kind).not.toBe("drain-complete");
  });

  test("a genuine first ingest (no prev) of 0 items is still allowed to be empty", () => {
    const s = ingestBoardItems(null, [], {});
    expect(s.tickets).toEqual([]);
    expect(s.lanes).toEqual([]);
    expect(drainComplete(s.tickets, s.lanes)).toBe(true); // nothing to do, correctly
  });
});

// -- fresh-stage guarantee (AC4): lane state carries no conversation id -------

describe("fresh-stage lane state", () => {
  test("LaneState carries exactly its seventeen scheduling fields and no session/conversation id", () => {
    // Compile-time half: this constant stops typechecking if LaneState's key
    // set ever drifts from the seventeen named here (issue #76 added reviewBounces,
    // mirroring qaBounces; #125 added lastWroteStatus, the resync origin marker;
    // #191 added quorumRetries, a budget deliberately separate from
    // reviewBounces; #177 added commitRetries, separate for the same reason;
    // #209 added respawns -- a fourth separate budget -- and worktreeDirty, the
    // probe-time git fact its transition reads; #273 added goneReason, the mark
    // that turns "this lane's ticket left the board" into a stop-lane action
    // instead of a silent filter; #256 added stageStartedMs, the one timestamp
    // the heartbeat may NOT move, which is what bounds a lane whose worker keeps
    // answering ALIVE; #178 added the mechanical merge-gate verdict, its attempt
    // count, and the merge base that verdict was taken against). Every addition
    // must be a deliberate edit here -- this gate is what keeps a
    // conversation/session id from ever riding between stages.
    type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
    const _laneKeysExact: Exact<
      keyof LaneState,
      "ticket" | "stage" | "lastActivityMs" | "stageStartedMs" | "qaBounces" | "reviewBounces" | "quorumRetries" | "commitRetries" | "respawns" | "workerDead" | "worktreeDirty" | "outcome" | "lastWroteStatus" | "goneReason" | "mergeGate" | "mergeGateRuns" | "mergeGateBase"
    > = true;
    void _laneKeysExact;
    // Runtime half: a fully-populated lane exposes exactly those keys, and none
    // of them smells like a carried conversation.
    const full: Required<LaneState> = {
      ticket: 1, stage: "builder", lastActivityMs: 0, stageStartedMs: 0, qaBounces: 0, reviewBounces: 0, quorumRetries: 0, commitRetries: 0, respawns: { builder: 0 }, workerDead: false, worktreeDirty: false, outcome: { kind: "built" }, lastWroteStatus: "Building", goneReason: { kind: "confirmed-gone" },
      mergeGate: { green: true, attempts: 1, failCount: 0, note: "green" }, mergeGateRuns: 1, mergeGateBase: "",
    };
    expect(Object.keys(full).sort()).toEqual(["commitRetries", "goneReason", "lastActivityMs", "lastWroteStatus", "mergeGate", "mergeGateBase", "mergeGateRuns", "outcome", "qaBounces", "quorumRetries", "respawns", "reviewBounces", "stage", "stageStartedMs", "ticket", "workerDead", "worktreeDirty"]);
    for (const k of Object.keys(full)) {
      expect(k).not.toMatch(/conversation|session|context|transcript|agent/i);
    }
    // The e2e eval's fresh-context oracle keeps a SECOND copy of this set, and it
    // is the copy that gets forgotten (#177 and #191 updated it; #209 did not).
    // Nothing fails while the happy path never populates a retry counter -- and
    // then the first unhappy run reports a scheduling field as leaked state. Same
    // fact, one gate.
    expect([...ALLOWED_LANE_KEYS].sort()).toEqual(Object.keys(full).sort());
  });

  test("advancing a stage clears the previous stage's outcome and probe state", () => {
    let s = state([ticket(1, "Building")], [lane(1, "builder", { workerDead: false, outcome: { kind: "built" } })]);
    s = applyAction(s, { kind: "advance", ticket: 1, to: "qa" }, 5);
    expect(s.lanes[0].outcome).toBeUndefined();
    expect(s.lanes[0].workerDead).toBeUndefined();
    expect(s.lanes[0].lastActivityMs).toBe(5);
  });
});

// -- parsing ------------------------------------------------------------------

describe("parseDependsOn", () => {
  test("z-plan prose form and z-board link form both parse", () => {
    expect(parseDependsOn("## Context\n\nDepends on: C2 (#5), C4 (#6)")).toEqual([5, 6]);
    expect(parseDependsOn("body\n\nDepends on #7")).toEqual([7]);
  });
  test("multiple lines merge and dedupe; other #N references are ignored", () => {
    expect(parseDependsOn("Depends on: #5\nPart of: EPIC #3\nDepends on #5\nDepends on #2")).toEqual([2, 5]);
    expect(parseDependsOn("no deps here, see #12")).toEqual([]);
    expect(parseDependsOn("Depends on: none")).toEqual([]);
  });
});

describe("parseStageResult", () => {
  test("each stage's markers parse with their notes", () => {
    expect(parseStageResult("builder", "BUILT: all green")).toEqual({ kind: "built" });
    expect(parseStageResult("builder", "NEEDS-INPUT: pick a currency")).toEqual({ kind: "needs-input", note: "pick a currency" });
    expect(parseStageResult("qa", "QA-BUGS: 1) x\n2) y")).toEqual({ kind: "qa-bugs", note: "1) x\n2) y" });
    expect(parseStageResult("reviewer", "REVIEW-APPROVE: verified")).toEqual(approve(null));
    expect(parseStageResult("merge", "MERGED: https://pr/9")).toEqual({ kind: "merged", note: "https://pr/9" });
    expect(parseStageResult("merge", "BLOCKED: conflict gauntlet failed")).toEqual({ kind: "stage-blocked", note: "conflict gauntlet failed" });
  });
  test("a marker from the wrong stage, an unknown marker, or no marker is CONFUSED", () => {
    expect(parseStageResult("builder", "QA-PASS: nope").kind).toBe("confused");
    expect(parseStageResult("qa", "ALL-DONE: what").kind).toBe("confused");
    expect(parseStageResult("reviewer", "I looked at the diff and it seems fine.").kind).toBe("confused");
    expect(parseStageResult("builder", "").kind).toBe("confused");
  });
});

// -- #307: a marker that is not the first line ---------------------------------

// Loop 16 drained three tickets and delivered zero. All three were Skipped, and
// in all three the stage had already done the work: #207's builder had committed
// 7940725 with 1986 pass / 0 fail, #192's QA had verified all three acceptance
// criteria green. Both closed a prose summary with a correctly spelled `BUILT:` /
// `QA-PASS:` as the LAST line, and first-line-only parsing made the marker
// invisible -- CONFUSED, which the no-token-burn rule turns into a skip AFTER the
// stage spent its full budget. $2.33 paid, nothing merged, three tickets left for
// a human.
//
// AC1/AC2/AC6 run against the REAL final messages, pulled verbatim out of the
// retained run-16 stage transcripts and checked in, so these pin the observed
// regression rather than a reconstruction of it.
// Inputs for the placeholder-coverage test below. They render the REAL contract
// text; none of the payload values reach the assertions, only the template lines do.
const PLACEHOLDER_INPUT_PATH = "/loop/tmp/input-42.json";
const PLACEHOLDER_BUILDER = {
  ticketNumber: 42,
  ticketTitle: "t",
  ticketBody: "b",
  worktreePath: ".worktrees/ticket-42",
  branch: "z/ticket-42",
  baseBranch: "main",
};
const PLACEHOLDER_QA = {
  ticketNumber: 42,
  ticketBody: "b",
  worktreePath: ".worktrees/ticket-42",
  branch: "z/ticket-42",
  qaPass: 1,
  webTarget: false,
};
const PLACEHOLDER_REVIEWER = { ticketBody: "b", acceptanceCriteria: "a", diff: "d", worktreePath: "/tmp/wt" };
const PLACEHOLDER_MERGE = {
  ticketNumber: 42,
  prTitle: "p",
  branch: "z/ticket-42",
  baseBranch: "main",
  worktreePath: ".worktrees/ticket-42",
  stackedOn: [],
};
// The markers each stage owns, as the exit contracts print them.
const STAGE_MARKERS: Record<Stage, string[]> = {
  builder: ["BUILT", "NEEDS-INPUT", "BLOCKED", "CONFUSED"],
  qa: ["QA-PASS", "QA-BUGS", "NEEDS-HUMAN", "BLOCKED", "CONFUSED"],
  reviewer: ["REVIEW-APPROVE", "REVIEW-FINDINGS", "NEEDS-HUMAN", "BLOCKED", "CONFUSED"],
  merge: ["MERGED", "NEEDS-HUMAN", "BLOCKED", "CONFUSED"],
};

describe("parseStageResult finds a marker that is not the first line (#307)", () => {
  const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "stage-messages", name), "utf8");
  // parseStageResult returns the StageOutcome union, and TS cannot narrow it off
  // an expect() call, so this asserts CONFUSED and yields its note in one step.
  const confusedNote = (out: StageOutcome): string => {
    expect(out.kind).toBe("confused");
    return out.kind === "confused" ? out.note : "";
  };

  test("AC1: the real #207 builder message -- prose summary, BUILT: last -- is built", () => {
    const msg = fixture("builder-207-trailing-built.txt");
    // The shape that lost the ticket: line 1 is prose, the marker is the closer.
    expect(msg.split(/\r?\n/)[0]).not.toMatch(/^BUILT:/);
    expect(msg.trimEnd().split(/\r?\n/).at(-1)).toMatch(/^BUILT:/);
    expect(parseStageResult("builder", msg)).toEqual({ kind: "built" });
  });

  test("AC2: the real #192 QA message -- multi-paragraph summary, QA-PASS: last -- is qa-pass", () => {
    const msg = fixture("qa-192-trailing-qa-pass.txt");
    expect(msg.split(/\r?\n/)[0]).not.toMatch(/^QA-PASS:/);
    expect(parseStageResult("qa", msg)).toEqual({ kind: "qa-pass" });
  });

  test("AC3: the widening is additive -- a well-formed first-line marker is unchanged", () => {
    // Same expectations as the pre-#307 suite above, plus the note extraction:
    // the note is the remainder of the marker line and every line after it, and
    // the prose an agent writes BELOW its marker still rides along.
    expect(parseStageResult("builder", "BUILT: done")).toEqual({ kind: "built" });
    expect(parseStageResult("qa", "QA-BUGS: 1) x\n2) y")).toEqual({ kind: "qa-bugs", note: "1) x\n2) y" });
    expect(parseStageResult("builder", "NEEDS-INPUT: pick a currency\n\nmore context")).toEqual({
      kind: "needs-input",
      note: "pick a currency\n\nmore context",
    });
    expect(parseStageResult("merge", "MERGED: https://pr/9")).toEqual({ kind: "merged", note: "https://pr/9" });
    // A leading marker still wins over anything below it, so a stage that signs off
    // on line 1 and then rambles is parsed exactly as it always was.
    expect(parseStageResult("reviewer", "REVIEW-APPROVE: confidence=85 clean\n\nmore prose")).toEqual({
      kind: "review-approve",
      confidence: 85,
      skeptics: null,
    });
    // ...but NOT over a contradicting verdict. This is the one place the shipped
    // behavior is narrower than AC3's "byte-identical" text, and it is deliberate:
    // AC3 and AC4 conflict on this exact input, and resolving toward AC3 meant a
    // reviewer's line-1 REVIEW-APPROVE shipped a diff its own next line called
    // defective. "Additive" is honored for every WELL-FORMED message; a message
    // reporting two verdicts was never one.
    expect(parseStageResult("reviewer", "REVIEW-APPROVE: confidence=85 clean\n\nREVIEW-FINDINGS: exploitable bug").kind).toBe(
      "confused"
    );
  });

  test("AC4: two different markers of one stage, neither on line 1, stays CONFUSED and names both", () => {
    const msg = [
      "I read the whole diff and I am of two minds about it.",
      "",
      "REVIEW-APPROVE: confidence=85 every criterion verified",
      "",
      "REVIEW-FINDINGS: two issues",
    ].join("\n");
    // Both markers named, so the skip note tells a human what the stage actually
    // said. Resolving a contradiction silently by position would be worse.
    //
    // Asserted as the marker LIST, not as two bare toContain() calls: main's
    // fallback note interpolates Object.keys(MARKERS[stage]), so it already
    // contains every marker name for this stage and `toContain("REVIEW-APPROVE")`
    // passes against the old code too. Only the list phrase discriminates.
    const note = confusedNote(parseStageResult("reviewer", msg));
    expect(note).toContain("2 different exit markers (REVIEW-APPROVE, REVIEW-FINDINGS)");
    expect(note).not.toContain("ended without a recognized exit marker");
    // The contradiction is judged BEFORE last-hit-wins, so the fact that
    // REVIEW-FINDINGS happens to be the last hit does not resolve it.
    expect(msg.trimEnd().split(/\r?\n/).at(-1)).toMatch(/^REVIEW-FINDINGS:/);
  });

  test("AC5: a marker mentioned in prose or indented in a code fence is not a marker", () => {
    const indented = [
      "Here is the contract I was given:",
      "",
      "```",
      "    BUILT: <one-line summary>",
      "```",
      "",
      "I have not finished yet.",
    ].join("\n");
    expect(parseStageResult("builder", indented).kind).toBe("confused");
    const midSentence = "I will report BUILT: once the suite finishes, which it has not.";
    expect(parseStageResult("builder", midSentence).kind).toBe("confused");
  });

  test("AC5b: the LAST line-leading marker wins, so a narrated one cannot pre-commit the verdict", () => {
    const msg = [
      "My plan is to close with BLOCKED: if the dependency is broken.",
      "It was not broken.",
      "",
      "BUILT: dependency was fine after all",
    ].join("\n");
    expect(parseStageResult("builder", msg)).toEqual({ kind: "built" });
    // Same marker twice is not a contradiction -- the last is the verdict, and it
    // leads the note.
    const twice = parseStageResult("merge", "prose\nMERGED: https://pr/1\nmore\nMERGED: https://pr/2");
    expect(twice.kind).toBe("merged");
    expect(twice.kind === "merged" && twice.note.split("\n")[0]).toBe("https://pr/2");
  });

  // A marker mid-message is ACCEPTED, and that is measured rather than assumed.
  // Over every retained stage final message in this repo (507 with text, 135 with a
  // marker off line 1), 80 put the marker mid-message against 55 on the closing
  // line -- 71 of the 80 as the second non-empty line, the dominant real shape of a
  // headline, the verdict, then the evidence below. A closing-line-only rule would
  // skip all 80 and re-open #307 for the majority of its own population.
  test("a marker mid-message is a verdict: the corpus's dominant shape", () => {
    const shape = (marker: string) => ["Ran the full gauntlet.", "", marker, "", "Evidence:", "- suite green", "- typecheck clean"].join("\n");
    expect(parseStageResult("builder", shape("BUILT: narrowed the assertion"))).toEqual({ kind: "built" });
    expect(parseStageResult("qa", shape("QA-PASS: all three criteria green"))).toEqual({ kind: "qa-pass" });
    expect(parseStageResult("reviewer", shape("REVIEW-APPROVE: confidence=100 skeptics=3/3 verified"))).toEqual({
      kind: "review-approve",
      confidence: 100,
      skeptics: { received: 3, of: 3 },
    });
  });

  // The fail-open worth closing is a QUOTED marker, and it is closed by mechanism
  // rather than by position, because position is what the corpus says we cannot use.
  // Every stage prompt hands the agent the literal marker strings, so pasting one
  // back is a route it can actually take; narrating a fully-formed marker at column
  // 0 is not a shape the corpus contains (0 occurrences).
  test("a QUOTED marker is not a verdict: fenced, or still carrying the contract placeholder", () => {
    // Column-0 fence. This is the case the leading-whitespace rule never covered:
    // fenced content is not indented.
    const fenced = ["The contract says:", "", "```", "BUILT: done and committed", "```", "", "Still building."].join("\n");
    expect(confusedNote(parseStageResult("builder", fenced))).toContain("only QUOTED its exit markers");
    // ~~~ fences too, and an indented fence body stays excluded by both rules.
    const tilde = ["Contract:", "~~~", "QA-PASS: everything green", "~~~", "Not done."].join("\n");
    expect(parseStageResult("qa", tilde).kind).toBe("confused");
    // The contract's own placeholder, unfenced -- what pasting one instruction line
    // produces.
    const placeholder = ["I was told to end with:", "BUILT: <one-line summary>", "I could not finish."].join("\n");
    expect(confusedNote(parseStageResult("builder", placeholder))).toContain("only QUOTED its exit markers");
    // A real verdict AFTER a quoted one is still read: quoting does not poison the
    // message, it just does not count as reporting.
    const both = ["Contract:", "```", "BUILT: <one-line summary>", "```", "", "BUILT: the real thing"].join("\n");
    expect(parseStageResult("builder", both)).toEqual({ kind: "built" });
    // An unbalanced fence cannot swallow the verdict below it either... it can, and
    // that is the honest boundary: a stage that opens a fence and never closes it
    // has produced a message whose marker IS inside a fence.
    expect(parseStageResult("builder", ["```", "BUILT: inside an unclosed fence"].join("\n")).kind).toBe("confused");
  });

  // A NESTED fence is the shape a boolean toggle gets wrong, and it is not exotic:
  // an agent documenting the exit contract writes a ````markdown block containing a
  // ``` block. A toggle flips OFF at the inner delimiter and the marker inside the
  // real code block reads as a live verdict -- reachable for MERGED, which is
  // terminal. CommonMark's rule (close only on a run of the SAME character at least
  // as long as the opener) is what makes the inner fence inert.
  test("a nested fence cannot un-quote a marker inside a code block", () => {
    const nested = [
      "Documenting the contract:",
      "````markdown",
      "Example final message:",
      "```",
      "MERGED: https://github.com/o/r/pull/999",
      "```",
      "````",
      "I did not actually merge anything; the gate is red.",
    ].join("\n");
    expect(parseStageResult("merge", nested).kind).toBe("confused");
    // Same for tildes, and for a longer closer than opener (which does close).
    expect(parseStageResult("builder", ["~~~~", "~~~", "BUILT: done", "~~~", "~~~~", "still building"].join("\n")).kind).toBe("confused");
    expect(parseStageResult("builder", ["```", "quoted", "`````", "", "BUILT: the real one"].join("\n"))).toEqual({ kind: "built" });
    // A ``` block is NOT closed by a ~~~ line -- different character.
    expect(parseStageResult("builder", ["```", "~~~", "BUILT: still quoted", "```"].join("\n")).kind).toBe("confused");
  });

  // The forging routes two independent adversarial passes proved with probes. Each
  // one had a working exploit before the fix, and each is a CommonMark rule the
  // first fence implementation skipped, or a guard the line-1 path skipped.
  test("proven forging routes are closed", () => {
    // A closing fence carries NOTHING but its delimiter. `` ```ts `` is an opener's
    // info string; treating it as a closer ended the block early and promoted every
    // marker below it -- including a terminal MERGED, defeating CLOSING_LINE_ONLY
    // too, because the forged marker then WAS the last line.
    expect(parseStageResult("merge", ["Plan:", "```", "log", "```ts", "MERGED: https://x/pull/1"].join("\n")).kind).toBe("confused");
    expect(parseStageResult("merge", ["Narration", "```text", "quoted", "``` still inside the block", "MERGED: https://x/pull/2"].join("\n")).kind).toBe("confused");
    // A backtick opener's info string may not contain a backtick, so an inline code
    // span in prose does not open a fence and swallow the real marker below it.
    expect(parseStageResult("builder", ["Ran `bun test` and it passed.", "", "BUILT: done"].join("\n"))).toEqual({ kind: "built" });
    // The placeholder guard has to match the contract's REAL lines, which carry a
    // trailing description after the <placeholder> -- a full-match rule missed a
    // verbatim paste, i.e. exactly the input it exists for.
    const qaLine = "QA-PASS: <one-line evidence summary>       everything above verified green";
    expect(parseStageResult("qa", ["I was told to end with:", qaLine, "I could not verify AC2."].join("\n")).kind).toBe("confused");
    // ...and it applies on LINE 1 too. `MERGED: <the PR URL>` is the merge
    // contract's own template; it used to complete the ticket. Now it is discarded,
    // and the message's real verdict is read instead.
    expect(parseStageResult("merge", ["MERGED: <the PR URL>", "BLOCKED: gh pr merge failed"].join("\n"))).toMatchObject({
      kind: "stage-blocked",
    });
    // A line-1 marker no longer short-circuits the contradiction guard: an approve
    // must not ship the diff its own next line calls defective.
    expect(parseStageResult("reviewer", ["REVIEW-APPROVE: confidence=100", "REVIEW-FINDINGS: defect at auth.ts:40"].join("\n")).kind).toBe("confused");
    // Deep indentation cannot change fence state (CommonMark caps a delimiter at 3
    // leading spaces), so an indented delimiter inside a block is just content.
    expect(parseStageResult("builder", ["```", "quoted", "     ```", "BUILT: forged"].join("\n")).kind).toBe("confused");
  });

  // The pessimistic reads have to be pessimistic in every direction, and the quoting
  // guard must not eat correct verdicts. Each case here was a [P1]/[P2] a structured
  // cross-model review found in the previous round of fixes.
  test("the gate reads are lowest-wins, and the placeholder guard spares real payloads", () => {
    // The marker's own token does NOT get to hide a lower one the reviewer disclosed
    // in prose: it is the LOWER of the two sources, not "the marker's if present".
    expect(
      parseStageResult("reviewer", ["Only 1 of 3 came back: skeptics=1/3.", "", "REVIEW-APPROVE: confidence=100 skeptics=3/3 fine"].join("\n"))
    ).toEqual(approve(100, { received: 1, of: 3 }));
    // Two tokens on ONE line: the definitional parsers read only the first, so the
    // lowest-wins rule has to scan every occurrence.
    expect(parseStageResult("reviewer", "REVIEW-APPROVE: confidence=95, corrected to confidence=40")).toEqual(approve(40));
    // A markdown autolink and an identifier are NOT contract placeholders. Treating
    // any angle-bracket payload as quoted refused a landed PR, which drops the ticket
    // out of mergedThisRun and breaks stacked-chain handling.
    expect(parseStageResult("merge", "MERGED: <https://github.com/o/r/pull/7>")).toEqual({
      kind: "merged",
      note: "<https://github.com/o/r/pull/7>",
    });
    expect(parseStageResult("qa", "NEEDS-HUMAN: <API_KEY> is missing")).toEqual({
      kind: "human-question",
      note: "<API_KEY> is missing",
    });
    // ...while every placeholder the contract actually leads a payload with is still
    // excluded, because all of them are multi-word.
    for (const [stage, payload] of [
      ["qa", "QA-PASS: <one-line evidence summary>       everything above verified green"],
      ["builder", "BUILT: <one-line summary>            all acceptance criteria pass"],
      ["reviewer", "REVIEW-FINDINGS: <numbered findings>          each with file:line"],
    ] as [Stage, string][]) {
      expect(parseStageResult(stage, ["I was told to end with:", payload, "but I did not finish."].join("\n")).kind).toBe("confused");
    }
    // An empty MERGED payload falls back to the note, so a URL on the NEXT line is
    // not lost -- completing a ticket with an empty prUrl is worse than a wordy one.
    expect(parseStageResult("merge", "MERGED:\nhttps://github.com/o/r/pull/7")).toEqual({
      kind: "merged",
      note: "https://github.com/o/r/pull/7",
    });
  });

  // The durable version of the guard's coverage: derive the placeholders from the
  // REAL rendered prompts rather than trusting a hand-written list, so rewording the
  // contract cannot silently leave a template that parses as a verdict. This is what
  // caught `<reason>` -- the one single-word placeholder, which a bare "must contain
  // a space" rule let through as a live BLOCKED.
  test("every placeholder the rendered prompts lead a payload with is treated as quoted", () => {
    const prompts: [Stage, string][] = [
      ["builder", builderPrompt(PLACEHOLDER_BUILDER, PLACEHOLDER_INPUT_PATH)],
      ["qa", qaPrompt(PLACEHOLDER_QA, PLACEHOLDER_INPUT_PATH)],
      ["reviewer", reviewerPrompt(PLACEHOLDER_REVIEWER, PLACEHOLDER_INPUT_PATH, true)],
      ["merge", mergePrompt(PLACEHOLDER_MERGE, PLACEHOLDER_INPUT_PATH)],
    ];
    let checked = 0;
    for (const [stage, prompt] of prompts) {
      for (const line of prompt.split("\n")) {
        // Only the contract's own template lines: `MARKER: <placeholder> ...`, where
        // MARKER is one this stage owns.
        const m = line.match(/^([A-Z][A-Z-]*):\s*(<[^>]*>.*)$/);
        if (!m || !STAGE_MARKERS[stage].includes(m[1]!)) continue;
        checked++;
        const out = parseStageResult(stage, ["I was told to end with:", line, "but I did not finish."].join("\n"));
        expect(out.kind, `${stage} template not treated as quoted: ${line}`).toBe("confused");
      }
    }
    // Guard the guard: if the extraction stops matching anything, the loop above
    // would pass vacuously.
    expect(checked).toBeGreaterThanOrEqual(6);
  });

  // The merge note is the PR URL, not the message. The orchestrator writes a merge
  // lane's note into the completion note's PR-URL slot, so a rescued mid-message
  // marker would have put model-authored multi-line prose there.
  test("a MERGED note carries only its own payload", () => {
    const out = parseStageResult("merge", ["Ran the gate, green.", "", "MERGED: https://github.com/o/r/pull/7"].join("\n"));
    expect(out).toEqual({ kind: "merged", note: "https://github.com/o/r/pull/7" });
  });

  // MERGED is the one verdict that is both terminal (sets the ticket Done, feeds
  // mergedThisRun, and batch cleanup then deletes the branch) and never re-read, so
  // it does not get the loose rule. Cost measured over the corpus: 3 real messages
  // put it mid-message against 5 that close with it. A lost rescue is a human seeing
  // a merged PR next to a Skipped ticket -- loud and recoverable; a false Done is
  // silent.
  test("MERGED is accepted on the first or the closing line only", () => {
    const closing = ["Opened and merged the PR.", "", "MERGED: https://pr/9"].join("\n");
    expect(parseStageResult("merge", closing)).toMatchObject({ kind: "merged" });
    expect(parseStageResult("merge", "MERGED: https://pr/9\n\nAll green.")).toMatchObject({ kind: "merged" });
    const midMessage = [
      "I ran the gate and it exited 1, so I stopped.",
      "For the record the PR that would have been produced is:",
      "MERGED: https://github.com/o/r/pull/1",
      "Nothing was merged.",
    ].join("\n");
    const note = confusedNote(parseStageResult("merge", midMessage));
    expect(note).toContain("did not CLOSE with it");
    // Only MERGED is restricted -- the other stages keep the loose rule, which is
    // where 132 of the 135 corpus rescues live.
    expect(parseStageResult("builder", "headline\n\nBUILT: done\n\nevidence below")).toEqual({ kind: "built" });
    expect(parseStageResult("qa", "headline\n\nQA-PASS: green\n\nevidence below")).toEqual({ kind: "qa-pass" });
    expect(parseStageResult("merge", "headline\n\nBLOCKED: gate red\n\ndetails")).toMatchObject({ kind: "stage-blocked" });
  });

  // The scan's note carries the prose on BOTH sides of the marker, because the
  // corpus holds both shapes: the mid-message majority puts its evidence BELOW the
  // marker, while #207 and #192 put theirs ABOVE. Dropping either side would rescue
  // the ticket and discard the reason -- this note becomes `qaNotes` / `reviewNotes`
  // for the rebuilding builder (nextAction's qa-bugs advance), so an empty one sends
  // a fresh agent to fix bugs nobody described.
  test("a scanned marker's note carries the prose above AND below it, remainder first", () => {
    const above = parseStageResult(
      "qa",
      ["1) click X, expect Y, got Z", "2) null deref at a.ts:10", "", "QA-BUGS: 2 issues, detailed above"].join("\n")
    );
    expect(above.kind === "qa-bugs" && above.note.split("\n")[0]).toBe("2 issues, detailed above");
    expect(above.kind === "qa-bugs" && above.note).toContain("1) click X, expect Y, got Z");
    expect(above.kind === "qa-bugs" && above.note).toContain("2) null deref at a.ts:10");
    const below = parseStageResult(
      "qa",
      ["Found two bugs.", "", "QA-BUGS: 2 issues, detailed below", "", "1) click X, expect Y, got Z", "2) null deref at a.ts:10"].join("\n")
    );
    expect(below.kind === "qa-bugs" && below.note.split("\n")[0]).toBe("2 issues, detailed below");
    expect(below.kind === "qa-bugs" && below.note).toContain("Found two bugs.");
    expect(below.kind === "qa-bugs" && below.note).toContain("1) click X, expect Y, got Z");
  });

  // #62's floor and #191's quorum are GATES, so each of their two tokens is read
  // from whichever position gives the SAFER answer. A number elsewhere in the
  // message can only inflate `confidence`, so confidence comes off the marker line
  // alone; a `skeptics=` denominator can only ever block, so it is read from the
  // marker line first and then from anywhere.
  test("a scanned REVIEW-APPROVE is scored off its own marker line, both directions fail closed", () => {
    // An honest "only 1 of 3 reported" in the prose still blocks -- the pessimistic
    // direction, so a starved review cannot merge by keeping the number off its
    // marker.
    expect(
      parseStageResult(
        "reviewer",
        ["Only 1 of 3 skeptics reported: skeptics=1/3.", "", "REVIEW-APPROVE: confidence=100 nobody could refute"].join("\n")
      )
    ).toEqual({ kind: "review-approve", confidence: 100, skeptics: { received: 1, of: 3 } });
    // ...but a denominator on the marker line WINS over one in the prose, so a
    // quoted `3/3` cannot override a real `1/3` the reviewer actually reported.
    expect(
      parseStageResult(
        "reviewer",
        ["Some quoted text says skeptics=3/3.", "", "REVIEW-APPROVE: confidence=100 skeptics=1/3 only one came back"].join("\n")
      )
    ).toEqual({ kind: "review-approve", confidence: 100, skeptics: { received: 1, of: 3 } });
    // Confidence comes off the marker line, so a number in the prose cannot raise it.
    expect(
      parseStageResult("reviewer", ["I started at confidence=20.", "", "REVIEW-APPROVE: confidence=90 verified"].join("\n"))
    ).toEqual({ kind: "review-approve", confidence: 90, skeptics: null });
  });

  test("line endings and degenerate messages", () => {
    // The loop runs on Windows, so the split is load-bearing: a CRLF payload and a
    // `\r\r\n` payload -- which leaves a stray TRAILING \r the scan must tolerate,
    // since `.` in MARKER_LINE does not match \r -- must both still find the marker.
    // A LONE-CR message is out of scope and stays CONFUSED: split(/\r?\n/) never
    // breaks it into lines at all, and no real transcript produces one.
    expect(parseStageResult("builder", "prose\r\nBUILT: done\r\n")).toEqual({ kind: "built" });
    expect(parseStageResult("builder", "prose\r\r\nBUILT: done\r\r\n")).toEqual({ kind: "built" });
    expect(parseStageResult("merge", "prose\r\nMERGED: https://pr/9\r\n").kind).toBe("merged");
    expect(parseStageResult("builder", "prose\rBUILT: done").kind).toBe("confused");
    // A trailing whitespace-only line does not hide the marker either.
    expect(parseStageResult("builder", "prose\nBUILT: done\n   \n")).toEqual({ kind: "built" });
    // Nothing to parse is CONFUSED, never a crash.
    expect(parseStageResult("builder", "   \n\t\n ").kind).toBe("confused");
    expect(parseStageResult("builder", "\n\n").kind).toBe("confused");
    // A marker with an empty note is still that marker.
    expect(parseStageResult("builder", "prose\nBUILT:")).toEqual({ kind: "built" });
    // Three repeats of one marker: the closing one wins, same as two.
    const thrice = parseStageResult("merge", "p\nMERGED: a\nq\nMERGED: b\nr\nMERGED: c");
    expect(thrice.kind === "merged" && thrice.note.split("\n")[0]).toBe("c");
  });

  // A token-less REVIEW-APPROVE scores NULL confidence, on BOTH paths. This was the
  // fail-open the security pass found: a bare approve used to be vouched for by any
  // `confidence=` in the message, including one inside a fenced diff hunk the
  // reviewer merely quoted -- i.e. text the BUILDER wrote, deciding the gate that
  // is supposed to check the builder. Null is what resolveOutcome reads as a
  // truth-check failure, so refusing to guess fails closed.
  test("a token-less REVIEW-APPROVE scores null, whichever side the numbers sit on", () => {
    const tokens = "The bar here is confidence=95.";
    const above = [tokens, "", "REVIEW-APPROVE: looks fine to me"].join("\n");
    const below = ["REVIEW-APPROVE: looks fine to me", "", tokens].join("\n");
    expect(parseStageResult("reviewer", below)).toEqual(approve(null)); // line-1 path
    expect(parseStageResult("reviewer", above)).toEqual(approve(null)); // scan path
    // The fenced-quote route the security pass demonstrated: a `confidence=` inside
    // a diff hunk the reviewer pasted -- text the BUILDER wrote -- must not score the
    // gate that checks the builder.
    const quoted = ["I reviewed the diff. The hunk:", "```diff", "+// confidence=100 skeptics=3/3", "```", "", "REVIEW-APPROVE: every criterion holds"].join("\n");
    // Neither token survives: confidence is read off the marker line, and the
    // `skeptics=` fallback scans the message with FENCED REGIONS DROPPED, so
    // builder-authored text the reviewer pasted cannot reach either gate.
    expect(parseStageResult("reviewer", quoted)).toEqual(approve(null));
  });

  // The pessimistic quorum read: the LOWEST `skeptics=` wins, so a quoted or
  // narrated `3/3` cannot outrank a real `1/3` whichever order they appear in. The
  // first-match read this replaced could be fooled by ordering alone.
  test("the skeptic quorum takes the lowest denominator anywhere unquoted", () => {
    const both = (a: string, b: string) => ["Delivery notes:", a, b, "", "REVIEW-APPROVE: confidence=100 done"].join("\n");
    for (const msg of [both("skeptics=3/3 claimed", "skeptics=1/3 actual"), both("skeptics=1/3 actual", "skeptics=3/3 claimed")]) {
      expect(parseStageResult("reviewer", msg)).toEqual(approve(100, { received: 1, of: 3 }));
    }
    // A number on the marker line still wins outright over the prose.
    expect(
      parseStageResult("reviewer", ["Some text says skeptics=3/3.", "", "REVIEW-APPROVE: confidence=100 skeptics=1/3 one back"].join("\n"))
    ).toEqual(approve(100, { received: 1, of: 3 }));
  });

  // Confidence is the lowest on the winning marker's OWN lines, so a stage that
  // narrates a high score and then reports a real lower one is held to the real one
  // -- and a reviewer that scores its verdict then repeats the marker as a bare
  // closing recap does not lose the score it did report.
  test("confidence is the lowest reported on the winning marker's own lines", () => {
    expect(
      parseStageResult("reviewer", ["REVIEW-APPROVE: confidence=100 first pass", "", "REVIEW-APPROVE: confidence=30 on reflection"].join("\n"))
    ).toEqual(approve(30));
    // The recap shape: scored verdict, evidence, then a bare repeat of the marker.
    expect(
      parseStageResult("reviewer", ["REVIEW-APPROVE: confidence=95 verified", "", "Evidence: suite green.", "", "REVIEW-APPROVE:"].join("\n"))
    ).toEqual(approve(95));
  });

  test("an unusable first line falls through to the scan", () => {
    // A line-1 marker belonging to ANOTHER stage is not this stage's verdict, so
    // the fast path cannot use it -- and the scan then reads the real closing
    // marker rather than skipping the ticket over a mislabeled opener.
    expect(parseStageResult("builder", "QA-PASS: wrong stage\nBUILT: the right one")).toEqual({ kind: "built" });
    // An indented marker IS accepted as line 1 (the fast path trims both ends,
    // unchanged since the contract shipped) but never below it.
    expect(parseStageResult("builder", "    BUILT: indented opener")).toEqual({ kind: "built" });
    expect(parseStageResult("builder", "context\n    BUILT: indented below line 1").kind).toBe("confused");
  });

  test("AC6: the real #286 builder message -- no marker anywhere -- is still CONFUSED", () => {
    // The other run-16 failure mode: the agent backgrounded `bun test` and ended
    // its turn to await a completion notification no orchestrator will ever send.
    // It genuinely did not finish, so the widening must NOT rescue it.
    const msg = fixture("builder-286-no-marker.txt");
    const note = confusedNote(parseStageResult("builder", msg));
    expect(note).toContain("ended without a recognized exit marker");
    expect(note).toContain("BUILT, NEEDS-INPUT, BLOCKED, CONFUSED");
    // Byte-identical to the note main already produced for this message.
    expect(note).toContain(JSON.stringify(msg.trim().slice(0, 200)));
  });

  test("a marker belonging to another stage is still not this stage's verdict", () => {
    // The scan filters by THIS stage's marker table, exactly as the first-line
    // path always did, so a builder closing with QA-PASS is not a pass.
    expect(parseStageResult("builder", "summary\n\nQA-PASS: all good").kind).toBe("confused");
    expect(parseStageResult("qa", "summary\n\nMERGED: https://pr/9").kind).toBe("confused");
  });

  // -- the scan's verdicts through their CONSUMERS -----------------------------
  //
  // Parsing a verdict correctly is half the contract; the other half is that the
  // widened path reaches the same guards the line-1 path does. These three drive
  // recordOutcome -> nextAction, because each pins a safety claim #307's design
  // argument actually leans on -- and a claim with no test is the shape this
  // ticket's own review kept finding.
  describe("a scanned verdict meets the same guards as a line-1 one", () => {
    const CLEAN = "## z/ticket-1-thing...origin/main [ahead 1]\n";

    // The residual is bounded by "#177 re-verifies BUILT against the worktree".
    // That sentence is only true if the SCAN path reaches builtGuardFailure too.
    test("a scanned BUILT over a dirty tree bounces to the builder, never to QA", () => {
      let s = state([ticket(1, "Building")], [lane(1, "builder")]);
      s = recordOutcome(s, 1, "All criteria pass, suite green.\n\nBUILT: narrowed the assertion", 0, {
        porcelain: `${CLEAN}M  lib/loop.ts\n`,
        headSha: "a".repeat(40),
        baseSha: "a".repeat(40),
      });
      expect(s.lanes[0]!.outcome).toMatchObject({ kind: "built", unverified: expect.stringContaining("uncommitted work") });
      expect(nextAction(s, 0)).toMatchObject({ kind: "advance", to: "builder" });
    });

    // scanMarkerNote keeps the prose above the marker SPECIFICALLY so QA's repros
    // survive into qaNotes. This proves the advance actually carries them.
    test("a scanned QA-BUGS delivers the repros above the marker as the builder's notes", () => {
      let s = state([ticket(3, "QA")], [lane(3, "qa")]);
      s = recordOutcome(s, 3, "1) click X, expect Y, got Z\n2) null deref at a.ts:10\n\nQA-BUGS: 2 issues, above", 0);
      const a = nextAction(s, 0);
      expect(a).toMatchObject({ kind: "advance", to: "builder" });
      expect(a.kind === "advance" && a.note).toContain("1) click X, expect Y, got Z");
      expect(a.kind === "advance" && a.note).toContain("2) null deref at a.ts:10");
    });

    // #191's quorum floor has to bite on a scanned approve as well, or the note
    // ordering that finds a `skeptics=` token above the marker buys nothing.
    test("a scanned REVIEW-APPROVE with a starved quorum does not reach merge", () => {
      let s = state([ticket(1, "Review")], [lane(1, "reviewer")]);
      s.minSkepticQuorum = 2;
      s = recordOutcome(s, 1, "Only 1 of 3 skeptics reported: skeptics=1/3.\n\nREVIEW-APPROVE: confidence=100 nobody refuted", 0);
      expect(s.lanes[0]!.outcome).toMatchObject({ kind: "review-approve", skeptics: { received: 1, of: 3 } });
      const starved = nextAction(s, 0);
      expect(starved).toMatchObject({ kind: "advance", ticket: 1, to: "reviewer" });
      expect(starved.kind === "advance" && starved.note).toContain("skeptic quorum not met");
      // The positive control, so the assertion above is discrimination and not just
      // "nextAction returned something": the SAME scanned shape with the quorum met
      // does reach the merge gate.
      let ok = state([ticket(1, "Review")], [lane(1, "reviewer")]);
      ok.minSkepticQuorum = 2;
      ok = recordOutcome(ok, 1, "All three reported.\n\nREVIEW-APPROVE: confidence=100 skeptics=3/3 nobody refuted", 0);
      expect(nextAction(ok, 0)).toMatchObject({ kind: "merge-gate", ticket: 1 });
    });
  });

  // This repo pins documented promises with a grep gate (see the #209 doc canary
  // above). #307 tells a human to recognize three specific skip notes while
  // recovering a ticket, so a reworded note must not be able to leave the recovery
  // page naming text the loop no longer emits.
  test("the user docs carry the exact skip notes #307 tells a human to look for", () => {
    const docs = (...p: string[]) => readFileSync(join(import.meta.dir, "..", ...p), "utf8");
    const trouble = docs("docs", "user-guide", "troubleshooting.md");
    for (const note of [
      "only QUOTED its exit markers",
      "ended without a recognized exit marker",
      "so no single verdict can be read",
      "did not CLOSE with it",
    ]) {
      expect(trouble).toContain(note);
      // ...and each one is a string parseStageResult actually produces.
      expect(readFileSync(join(import.meta.dir, "..", "lib", "loop.ts"), "utf8")).toContain(note);
    }
    expect(docs("docs", "user-guide", "z-loop.md")).toContain("A marker on a line of its own is read wherever it sits");
  });
});

// -- #318: the loop-17 reviewer messages, pinned unchanged --------------------

// #318 AC3. The defect is that an adversarial reviewer ends its turn waiting for
// skeptic verdicts that can never reach it, and the fix is entirely in the PROMPT
// (lib/stage-prompts.ts). These are the three real final messages from loop 17
// (session tordek-ai-1786066160), verbatim, and they exist to pin that the parser
// is NOT the thing being changed: a prompt fix must not be able to ride along with
// a quiet loosening of what counts as a verdict.
//
// The distinction matters because the tempting "fix" is to make a markerless
// waiting-on-skeptics message parse as something salvageable. It must not. A stage
// that ended without a verdict genuinely has no verdict -- whatever it was about to
// conclude, it did not conclude, and inventing one from its prose is how a diff
// nobody actually approved gets merged. #307 already widened marker POSITION as far
// as the corpus justifies; existence is not negotiable.
describe("the loop-17 reviewer final messages parse exactly as they do today (#318)", () => {
  const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "stage-messages", name), "utf8");

  // The two that cost tickets. Both had green, committed, QA-passed work on the
  // branch; both were Skipped. Note what they are NOT: neither is malformed, and
  // neither is confused about the diff -- each is a complete, accurate report that
  // simply withholds the one line the loop reads, because the agent believed it had
  // one more step to take. There is no next turn in which to take it.
  const AWAITING: [string, string, string][] = [
    [
      "#192 reviewer, attempt 1 (haiku)",
      "reviewer-192-awaiting-skeptics.txt",
      "Waiting for skeptic completion notifications.",
    ],
    [
      "#207 reviewer, attempt 2 (haiku)",
      "reviewer-207-attempt2-awaiting-skeptics.txt",
      "Let me wait briefly for responses before finalizing.",
    ],
  ];

  for (const [label, file, closer] of AWAITING) {
    test(`${label} closes on a wait-for-skeptics sentence and is CONFUSED`, () => {
      const msg = fixture(file);
      // The signature a human recovering the ticket is told to recognize
      // (troubleshooting.md): the message ENDS on the wait, mid-collection.
      expect(msg.trimEnd().endsWith(closer)).toBe(true);
      // Not one of this stage's markers appears anywhere in it -- the ticket was
      // not lost to a position or spelling problem #307 would have caught.
      for (const m of ["REVIEW-APPROVE", "REVIEW-FINDINGS", "NEEDS-HUMAN", "BLOCKED:", "CONFUSED:"]) {
        expect(msg).not.toContain(m);
      }
      const out = parseStageResult("reviewer", msg);
      expect(out.kind).toBe("confused");
      expect(out.kind === "confused" ? out.note : "").toContain("ended without a recognized exit marker");
    });
  }

  // The third one DID exit -- and is the reason the fix is about collection rather
  // than about markers. It emitted a well-formed verdict carrying an honest
  // skeptics=0/3, so #191's quorum gate correctly bounced it for a retry. One whole
  // reviewer stage paid for, zero delivered verdicts folded in. The prompt change
  // targets the 0, not the marker.
  test("#207 reviewer, attempt 1 approves with an honest zero-verdict tally", () => {
    const msg = fixture("reviewer-207-approve-zero-skeptics.txt");
    // The marker is mid-message, not line 1: this one parses only because of #307,
    // which is itself worth pinning here.
    expect(msg.split(/\r?\n/)[0]).not.toMatch(/^REVIEW-APPROVE:/);
    expect(parseStageResult("reviewer", msg)).toEqual({
      kind: "review-approve",
      confidence: 88,
      skeptics: { received: 0, of: 3 },
    });
  });

  // The fix lives in the prompt, so the prompt is where the assertion belongs: the
  // sentences these two messages ended on are now named in the reviewer's own
  // instructions as the thing not to do. Cross-checked here, against the real
  // corpus text, rather than only against a phrase chosen in the test.
  test("the reviewer prompt now rules out the exact sentences these messages ended on", () => {
    const active = reviewerPrompt(
      { ticketBody: "b", acceptanceCriteria: "a", diff: "d", worktreePath: "/tmp/wt" },
      "/loop/tmp/input-42.json",
      true
    );
    // "Waiting for skeptic completion notifications." (#192)
    expect(active).toContain("await completion notifications");
    expect(active).toContain("no notification is coming");
    // "Let me wait briefly for responses before finalizing." (#207 attempt 2)
    expect(active).toContain("You therefore never wait for a skeptic");
    // ...and the mechanism that makes the wait unnecessary rather than forbidden.
    expect(active).toContain("`run_in_background: false`");
  });
});

// -- transition matrix + reducers ---------------------------------------------

describe("transitions and reducers", () => {
  test("canTransition spot checks", () => {
    expect(canTransition("Ready", "Building")).toBe(true);
    expect(canTransition("Review", "Done")).toBe(true);
    expect(canTransition("QA", "Building")).toBe(true);
    expect(canTransition("Building", "Review")).toBe(true); // #130: skip-QA label walks builder straight to Review
    expect(canTransition("Building", "Done")).toBe(false); // but never straight to Done -- Review is never skipped
    expect(canTransition("Backlog", "Building")).toBe(false);
    expect(canTransition("Done", "Ready")).toBe(true); // human bounce
    expect(canTransition("QA", "QA")).toBe(true); // same status is a no-op
  });

  test("claiming a Ready ticket moves it to Building; illegal transitions throw", () => {
    const s = state([ticket(1, "Ready")]);
    const s2 = applyAction(s, { kind: "claim", ticket: 1, stage: "builder" }, 0);
    expect(s2.tickets[0].status).toBe("Building");
    expect(s.tickets[0].status).toBe("Ready"); // pure: input untouched
    const done = state([ticket(2, "Done")]);
    expect(() => applyAction(done, { kind: "park", ticket: 2, status: "Questions", note: "x" }, 0)).toThrow(ZError);
  });

  test("recordOutcome and recordProbe demand a live lane", () => {
    const s = state([ticket(1, "Building")]);
    expect(() => recordOutcome(s, 1, "BUILT: x", 0)).toThrow(ZError);
    expect(() => recordProbe(s, 1, true, 0)).toThrow(ZError);
  });
});

// -- #110: a stage/status desync must fail SOFT, never abort the whole tick ----
// A lane can reach a boundary while its ticket's board status (re-read live each
// tick) disagrees with the status its stage runs under -- a lagged/failed stage
// board-write, or a human/board move back to an in-flight status. Resolving the
// outcome would hand applyAction an advance whose setStatus is illegal from the
// stale status (the qa-pass lane still showing Building -> the Building->Review
// that threw an unhandled ZError and killed every lane's progress with it).
//
// #116 refined the one-hop-behind case (the qa-pass-lagging-at-Building fixture
// below): rather than stop-lane for every desync, it is now resynced and
// advanced when the gap is explainable by the loop's own still-propagating
// write -- see the "resync-on-lag vs genuine move-back (#116)" block below for
// the side-by-side pinning. The two tests here are updated in place (same
// fixtures, corrected expectations) since they ARE that exact scenario; AC3
// (a two-hop, unambiguous human move) is untouched.
describe("stage/status desync fails soft (#110)", () => {
  test("AC1: a qa-pass lane whose board status lags at Building resyncs and advances (#116), does not throw, leaves the other lane untouched", () => {
    let s = state(
      [ticket(1, "Building"), ticket(2, "QA")],
      [
        lane(1, "qa", { outcome: { kind: "qa-pass" }, lastWroteStatus: "QA" }), // loop's QA write still in flight (board lags at Building)
        lane(2, "qa"), // healthy, mid-stage (no outcome yet)
      ]
    );
    const a = nextAction(s, 0);
    // One hop behind (Building is qa's own preceding status) -- resync-on-lag
    // (#116), not the old stop-lane, and NOT the illegal advance-to-reviewer
    // that used to throw before #110's guard existed.
    expect(a).toMatchObject({ kind: "advance", ticket: 1, to: "reviewer", resyncStatus: "QA" });
    expect(() => applyAction(s, a, 0)).not.toThrow(); // the tick does not abort
    s = applyAction(s, a, 0);
    expect(s.tickets.find((t) => t.number === 1)!.status).toBe("Review"); // resynced, then advanced
    expect(s.lanes.find((l) => l.ticket === 1)).toMatchObject({ stage: "reviewer" });
    expect(s.lanes.find((l) => l.ticket === 1)!.outcome).toBeUndefined();
    expect(s.lanes.find((l) => l.ticket === 2)).toEqual(lane(2, "qa")); // #2 untouched (still mid-stage, no outcome)
  });

  test("AC2: Building -> Review is a legal skip-QA walk now (#130); a qa-pass lane lagging at Building still resyncs through QA", () => {
    // #130 made Building -> Review legal (the label-gated skip-QA advance), so
    // the raw advance no longer throws -- it lands the ticket in Review directly.
    expect(canTransition("Building", "Review")).toBe(true);
    // #125: lastWroteStatus is the origin marker that lets nextAction's guard
    // resync -- the loop's own QA write is in flight (not a human move-back), so
    // the lagged-at-Building qa-pass lane is corrected to QA before it advances.
    const skip = state([ticket(1, "Building")], [lane(1, "qa", { outcome: { kind: "qa-pass" }, lastWroteStatus: "QA" })]);
    expect(() => applyAction(skip, { kind: "advance", ticket: 1, to: "reviewer" }, 0)).not.toThrow();
    // The #116 resync-on-lag path is UNCHANGED for a real qa-pass lane: through
    // nextAction the lagged lane is still corrected to QA before it advances, so
    // the board reflects the QA the ticket actually passed (not a skip walk).
    const a = nextAction(skip, 0);
    expect(a).toMatchObject({ kind: "advance", to: "reviewer", resyncStatus: "QA" });
    const after = applyAction(skip, a, 0);
    expect(after.tickets[0].status).toBe("Review");
    expect(after.lanes[0]).toMatchObject({ ticket: 1, stage: "reviewer" });
  });

  test("AC3: a lane a human dragged back to Building parks only its own lane; other lanes continue", () => {
    let s = state(
      [ticket(1, "Building"), ticket(2, "Building")],
      [
        lane(1, "reviewer", { outcome: approve(100) }), // dragged Review -> Building
        lane(2, "builder", { outcome: { kind: "built" } }), // healthy, ready to advance
      ]
    );
    const stop = nextAction(s, 0);
    expect(stop).toMatchObject({ kind: "stop-lane", ticket: 1 });
    expect((stop as { note: string }).note).toContain("reviewer");
    s = applyAction(s, stop, 0);
    expect(s.lanes.map((l) => l.ticket)).toEqual([2]); // only #1's lane stopped
    // The other lane continues on the very next tick.
    expect(nextAction(s, 0)).toMatchObject({ kind: "advance", ticket: 2, to: "qa" });
  });
});

// -- #116: resync-on-lag instead of stop-lane rebuild, when the board status --
// merely lags the loop's own write -----------------------------------------
// A lagged board write (GitHub eventual consistency) and a genuine human
// move-back produce the IDENTICAL snapshot for a mid-pipeline stage. #116's
// first cut used distance alone: a gap of exactly one hop behind the lane's own
// stage was treated as our own write still propagating (resync + advance, no
// rebuild); a gap of more than one hop cannot be a single write in flight and
// stays #110's safe stop-lane. #125 closed the one-hop blind spot -- distance
// alone can't tell a lagged one-hop write from a genuine one-hop human move --
// so the one-hop resync now ALSO requires the origin marker (lastWroteStatus);
// see the "(#125)" block below. The two-hop case here is unchanged.
describe("resync-on-lag vs genuine move-back (#116)", () => {
  test("AC1: one hop behind (qa lane lagging at Building) resyncs to QA and advances to reviewer -- no stop-lane, no rebuild", () => {
    const s = state(
      [ticket(1, "Building")],
      [lane(1, "qa", { outcome: { kind: "qa-pass" }, lastWroteStatus: "QA" })] // the loop's own QA-move write has not landed yet
    );
    const a = nextAction(s, 0);
    expect(a).toMatchObject({ kind: "advance", ticket: 1, to: "reviewer", resyncStatus: "QA" });
    const after = applyAction(s, a, 0);
    expect(after.tickets[0].status).toBe("Review");
    expect(after.lanes[0]).toMatchObject({ ticket: 1, stage: "reviewer" });
    expect(after.lanes[0].outcome).toBeUndefined();
  });

  test("AC2: two hops behind (reviewer lane at Building) is a genuine move-back -- stop-lane, and the ticket re-claims as a fresh builder", () => {
    let s = state(
      [ticket(1, "Building")],
      [lane(1, "reviewer", { outcome: approve(100) })] // human dragged Review -> Building
    );
    const a = nextAction(s, 0);
    expect(a).toMatchObject({ kind: "stop-lane", ticket: 1 });
    s = applyAction(s, a, 0);
    expect(s.lanes).toEqual([]);
    expect(s.tickets[0].status).toBe("Building"); // the human's move is honored, not overwritten
    // Re-claimed as a fresh builder next tick -- the full build+QA cycle re-runs.
    expect(nextAction(s, 0)).toMatchObject({ kind: "claim", ticket: 1, stage: "builder" });
  });
});

// -- #125: one-hop resync tells a lagged write from a genuine move by ORIGIN --
// #116's distance-only discriminator resynced EVERY one-hop-behind read, so a
// reviewer lane reading QA was silently pushed to merge whether the loop's own
// Review write merely lagged OR a human genuinely dragged Review->QA (wanting
// another QA pass). Both snapshots are byte-identical; distance cannot tell
// them apart at one hop. The fix records the status the loop wrote
// (lane.lastWroteStatus, cleared by ingest the moment the board shows it land):
// a one-hop gap resyncs ONLY while that marker still points at the lane's own
// stage status. A human move the loop never wrote leaves it cleared -> safe
// stop-lane, even at one hop.
describe("one-hop resync: lagged write vs genuine move-back by origin (#125)", () => {
  // Already gated green (#178) so these stay about the resync discriminator:
  // the merge-gate action is not resync-carrying, and the advance that follows
  // it is the one under test here.
  const reviewerLane = (over: Partial<LaneState> = {}) =>
    lane(1, "reviewer", { outcome: approve(100), mergeGate: GREEN_GATE, ...over });

  test("AC1: a reviewer lane one hop behind (board QA) with the loop's Review write still in flight resyncs to Review and advances to merge", () => {
    const s = state([ticket(1, "QA")], [reviewerLane({ lastWroteStatus: "Review" })]);
    const a = nextAction(s, 0);
    expect(a).toMatchObject({ kind: "advance", ticket: 1, to: "merge", resyncStatus: "Review" });
    const after = applyAction(s, a, 0);
    expect(after.tickets[0].status).toBe("Review"); // resynced past the lag, merge runs under Review
    expect(after.lanes[0]).toMatchObject({ ticket: 1, stage: "merge" });
  });

  test("AC2: a reviewer lane a human dragged Review -> QA (loop observed its Review write land, marker cleared) stop-lanes -- the one-hop human move is honored, NOT silently overridden", () => {
    let s = state([ticket(1, "QA")], [reviewerLane()]); // no lastWroteStatus: the Review write already landed and was observed
    const a = nextAction(s, 0);
    expect(a).toMatchObject({ kind: "stop-lane", ticket: 1 });
    expect((a as { note: string }).note).toContain("reviewer");
    s = applyAction(s, a, 0);
    expect(s.lanes).toEqual([]); // lane dropped
    expect(s.tickets[0].status).toBe("QA"); // human's move honored, never overwritten back to Review
  });

  test("AC1 vs AC2: the IDENTICAL one-hop snapshot yields opposite outcomes -- marker present resyncs, marker absent stop-lanes (origin, not distance)", () => {
    const lagged = nextAction(state([ticket(1, "QA")], [reviewerLane({ lastWroteStatus: "Review" })]), 0);
    const human = nextAction(state([ticket(1, "QA")], [reviewerLane()]), 0);
    expect(lagged.kind).toBe("advance");
    expect(human.kind).toBe("stop-lane");
  });

  test("origin marker mechanics: advance sets lastWroteStatus; ingest clears it on observed-land and preserves it while the write lags", () => {
    // advance-to-reviewer records the Review write as the lane's origin marker.
    let s = state([ticket(1, "QA")], [lane(1, "qa", { outcome: { kind: "qa-pass" } })]);
    s = applyAction(s, { kind: "advance", ticket: 1, to: "reviewer" }, 0);
    expect(s.lanes[0].lastWroteStatus).toBe("Review");

    // Ingest sees the board LAND on Review -> marker cleared (write observed).
    const landed = ingestBoardItems(s, [{ number: 1, title: "t", fields: { Status: "Review" } }], { "1": "" });
    expect(landed.lanes[0].lastWroteStatus).toBeUndefined();

    // Ingest sees the board still LAG at QA -> marker preserved (write in flight,
    // so the desync guard will still resync on the next tick).
    const lagging = ingestBoardItems(s, [{ number: 1, title: "t", fields: { Status: "QA" } }], { "1": "" });
    expect(lagging.lanes[0].lastWroteStatus).toBe("Review");
  });
});

// -- #205: every stage transition writes the board ----------------------------
// applyAction can only RECORD a transition -- the reducer is pure and
// lib/board.ts is the pack's sole gh caller -- so the board move belongs to the
// ORCHESTRATOR, and `boardWriteFor` is the one place that derives which one. The
// `advance` row named no move at all, so the board sat a stage behind its lane
// forever: the #125 marker never cleared (the "transient" lag became permanent),
// /z-status lied, and -- the expensive one -- every later claim of that ticket
// reads the BOARD for its stage, so a lane that had reached qa came back as a
// BUILDER and rebuilt finished, committed work.
describe("#205: every stage transition writes the board", () => {
  const STAGES: Stage[] = ["builder", "qa", "reviewer", "merge"];

  // The board a simulated orchestrator keeps: it moves ONLY when boardWriteFor
  // names a write, which is what makes a dropped derivation visible downstream
  // instead of silently agreeing with the state file.
  function performRow(board: Map<number, BoardStatus>, action: Action): void {
    const write = boardWriteFor(action);
    if (write) board.set(write.ticket, write.status);
  }
  const asItems = (board: Map<number, BoardStatus>) =>
    [...board].map(([number, Status]) => ({ number, title: `Ticket ${number}`, fields: { Status } }));

  // The printed repair line is only useful if it runs as printed, and
  // resolveSlug throws on a multi-project machine, so the slug is read off the
  // state path the caller already passed (~/.zstack/projects/<slug>/loop/...).
  test("slugFromStatePath reads the slug out of the state path, on both separators, with a ZSTACK_SLUG fallback", () => {
    expect(slugFromStatePath("/home/z/.zstack/projects/zstack/loop/state.json", {})).toBe("zstack");
    expect(slugFromStatePath("C:\\Users\\z\\.zstack\\projects\\my-app\\loop\\state.json", {})).toBe("my-app");
    // a path that is not a project state file falls back to the env the loop exports
    expect(slugFromStatePath("/tmp/scratch/state.json", { ZSTACK_SLUG: "from-env" })).toBe("from-env");
    // and with neither, no slug is invented
    expect(slugFromStatePath("/tmp/scratch/state.json", {})).toBeUndefined();
    expect(slugFromStatePath("/tmp/scratch/state.json", { ZSTACK_SLUG: "" })).toBeUndefined();
    // the path wins over a stale env var pointing at another project
    expect(slugFromStatePath("/home/z/.zstack/projects/zstack/loop/state.json", { ZSTACK_SLUG: "other" })).toBe("zstack");
    // The result is interpolated into a command line a human or the orchestrator
    // RUNS, so a segment outside the slug charset must not become a --slug
    // argument. Refusing to match is the safe direction: the line then carries no
    // --slug and resolveSlug fails loudly at the point of use, instead of a
    // whitespace split or a metacharacter riding into the shell.
    expect(slugFromStatePath("/home/z/.zstack/projects/my app/loop/state.json", {})).toBeUndefined();
    expect(slugFromStatePath("/home/z/.zstack/projects/a;rm -rf ~/loop/state.json", {})).toBeUndefined();
    // ...and it falls back rather than inventing one, same as any other non-match
    expect(slugFromStatePath("/home/z/.zstack/projects/my app/loop/state.json", { ZSTACK_SLUG: "real" })).toBe("real");
    // The ENV branch goes through the same guard. Guarding only the path branch
    // left ZSTACK_SLUG a hole straight into the printed command line: driven
    // through the real CLI, `ZSTACK_SLUG='evil"; cat ~/.ssh/id_rsa; echo "'`
    // printed `--slug "evil"; cat ~/.ssh/id_rsa; echo ""` under an instruction
    // to run the line verbatim.
    expect(slugFromStatePath("/tmp/x/state.json", { ZSTACK_SLUG: 'evil"; cat ~/.ssh/id_rsa; echo "' })).toBeUndefined();
    expect(slugFromStatePath("/tmp/x/state.json", { ZSTACK_SLUG: "has space" })).toBeUndefined();
    // `..` would traverse out of ~/.zstack/projects; a leading `-` is read as a
    // flag by the command the value is pasted into. Both refused on both branches.
    expect(slugFromStatePath("/home/z/.zstack/projects/../loop/state.json", {})).toBeUndefined();
    expect(slugFromStatePath("/home/z/.zstack/projects/--if-present/loop/state.json", {})).toBeUndefined();
    expect(slugFromStatePath("/tmp/x/state.json", { ZSTACK_SLUG: ".." })).toBeUndefined();
    expect(slugFromStatePath("/tmp/x/state.json", { ZSTACK_SLUG: "-rf" })).toBeUndefined();
    // Anchored on the real layout and taking the LAST match, so an ancestor
    // directory shaped `projects/<x>/loop/` cannot shadow the true slug and aim
    // the printed board write at a different configured project. Unanchored,
    // this returned "scratch".
    expect(
      slugFromStatePath("/home/zac/projects/scratch/loop/.zstack/projects/my-real-repo/loop/state.json", {})
    ).toBe("my-real-repo");
    // The regex hardcodes the on-disk layout that lib/throttle.ts defaultLoopDir
    // CONSTRUCTS, and nothing else couples them -- so a layout change would make
    // this return undefined silently and drop --slug from a repair line the
    // comment above calls load-bearing. Drive the real constructor instead of a
    // hand-written path, so the move breaks a test rather than degrading quietly.
    expect(slugFromStatePath(join(defaultLoopDir("acme-app", "/home/z"), "state.json"), {})).toBe("acme-app");
  });

  // The contract stated as literals, NOT re-derived from the map the function
  // reads -- an assertion built out of STATUS_FOR_STAGE survives any mutation
  // that keeps a STATUS_FOR_STAGE lookup (swapping action.to for action.stage,
  // say), which is most of them.
  test("boardWriteFor derives STATUS_FOR_STAGE for claim and advance, at every stage", () => {
    const EXPECTED: Record<Stage, BoardStatus> = { builder: "Building", qa: "QA", reviewer: "Review", merge: "Review" };
    // merge is in that table on purpose: it has no column of its own, it runs
    // under Review (Done means the PR landed), so advancing to merge re-writes
    // Review and is a no-op on the board.
    expect(EXPECTED).toEqual(STATUS_FOR_STAGE);
    for (const stage of STAGES) {
      expect(boardWriteFor({ kind: "claim", ticket: 7, stage })).toEqual({ ticket: 7, status: EXPECTED[stage] });
      expect(boardWriteFor({ kind: "advance", ticket: 7, to: stage })).toEqual({ ticket: 7, status: EXPECTED[stage] });
    }
  });

  // The coupling that makes a marker clearable at all, as a biconditional driven
  // through the REAL reducer for every kind in the Action union: applying an
  // action leaves a lane carrying `lastWroteStatus` IF AND ONLY IF boardWriteFor
  // names a write of that same status for that same ticket. A branch that stamps
  // a marker nothing is told to write leaves a lane no board read can ever clear
  // -- #205 in code rather than in prose -- and a branch that names a write it
  // never stamps re-arms the resync guard behind a write nobody made.
  //
  // `Record<Action["kind"], ...>` is what keeps this total: add a kind to the
  // union and this file stops typechecking until the new branch is covered here.
  test("INVARIANT: applying an action leaves a marker iff boardWriteFor names that exact write (every Action kind)", () => {
    const withLane = (s: TicketSnapshot["status"], stage: Stage, over: Partial<LaneState> = {}) =>
      state([ticket(1, s)], [lane(1, stage, over)]);
    const CASES: Record<Action["kind"], { before: LoopState; action: Action }[]> = {
      claim: [
        { before: state([ticket(1, "Ready")]), action: { kind: "claim", ticket: 1, stage: "builder" } },
        { before: state([ticket(1, "QA")]), action: { kind: "claim", ticket: 1, stage: "qa" } },
        { before: state([ticket(1, "Review")]), action: { kind: "claim", ticket: 1, stage: "reviewer" } },
      ],
      advance: [
        { before: withLane("Building", "builder", { outcome: { kind: "built" } }), action: { kind: "advance", ticket: 1, to: "qa" } },
        { before: withLane("QA", "qa", { outcome: { kind: "qa-pass" } }), action: { kind: "advance", ticket: 1, to: "reviewer" } },
        { before: withLane("Review", "reviewer", { outcome: approve(100) }), action: { kind: "advance", ticket: 1, to: "merge" } },
        { before: withLane("QA", "qa", { outcome: { kind: "qa-bugs", note: "x" } }), action: { kind: "advance", ticket: 1, to: "builder" } },
        { before: withLane("Review", "reviewer", { outcome: { kind: "review-findings", note: "x" } }), action: { kind: "advance", ticket: 1, to: "builder" } },
      ],
      park: [
        { before: withLane("Building", "builder"), action: { kind: "park", ticket: 1, status: "Questions", note: "q" } },
        { before: withLane("QA", "qa"), action: { kind: "park", ticket: 1, status: "Blocked", note: "b" } },
      ],
      skip: [{ before: withLane("Building", "builder"), action: { kind: "skip", ticket: 1, note: "s" } }],
      "stop-lane": [{ before: withLane("QA", "qa"), action: { kind: "stop-lane", ticket: 1, note: "gone" } }],
      complete: [{ before: withLane("Review", "merge", { outcome: { kind: "merged", note: "pr" } }), action: { kind: "complete", ticket: 1, note: "pr" } }],
      respawn: [{ before: withLane("Building", "builder", { workerDead: true }), action: { kind: "respawn", ticket: 1, stage: "builder", note: "died", attempt: 2 } }],
      // The no-ops KEEP their lane, so a stamping branch added to any of them is
      // visible here (park/skip/stop-lane/complete drop the lane, which is
      // itself why they own no derived write -- nothing survives to clear).
      "check-worker": [{ before: withLane("Building", "builder"), action: { kind: "check-worker", ticket: 1 } }],
      // #178's gate run is a probe of the lane's own branch, not a transition:
      // it neither moves the ticket nor places an agent on a new stage.
      "merge-gate": [{ before: withLane("Review", "reviewer", { outcome: approve(100) }), action: { kind: "merge-gate", ticket: 1 } }],
      wait: [{ before: withLane("Building", "builder"), action: { kind: "wait" } }],
      // #223's confirm-claim asks for ONE live assignee read on a ticket THIS
      // loop does not own. It moves nothing and writes nothing to the board --
      // the answer comes back through claimConfirmed, not the reducer.
      "confirm-claim": [{ before: withLane("Building", "builder"), action: { kind: "confirm-claim", ticket: 1 } }],
      "context-clear": [{ before: withLane("Building", "builder"), action: { kind: "context-clear" } }],
      "drain-complete": [{ before: state([ticket(1, "Done")]), action: { kind: "drain-complete" } }],
    };

    for (const cases of Object.values(CASES)) {
      expect(cases.length).toBeGreaterThan(0);
      for (const { before, action } of cases) {
        // the fixture itself must start clean, or the assertion below is bogus
        expect(before.lanes.every((l) => l.lastWroteStatus === undefined)).toBe(true);
        const after = applyAction(before, action, 0);
        const write = boardWriteFor(action);
        const marked = after.lanes.filter((l) => l.lastWroteStatus !== undefined).map((l) => [l.ticket, l.lastWroteStatus]);
        if (write) {
          expect(marked).toEqual([[write.ticket, write.status]]);
          // and the state file records the same status the orchestrator writes
          expect(after.tickets.find((t) => t.number === write.ticket)!.status).toBe(write.status);
        } else {
          expect(marked).toEqual([]);
        }
      }
    }
  });

  // AC1: the row's move is derived, the advance stamps QA, and the NEXT tick's
  // ingest clears the marker. Skip the write and it is not transient, it is
  // permanent -- which is what makes the resume below read the wrong stage.
  test("AC1: advance to qa writes `QA`; once written, the next ingest clears the marker -- skipped, it survives every tick", () => {
    const board = new Map<number, BoardStatus>([[1, "Building"]]);
    let s = state([ticket(1, "Building")], [lane(1, "builder", { outcome: { kind: "built" } })]);
    const action: Action = { kind: "advance", ticket: 1, to: "qa" };
    s = applyAction(s, action, 0);
    performRow(board, action); // the row moves the board as part of the advance
    expect(s.lanes[0].lastWroteStatus).toBe("QA");
    expect(board.get(1)).toBe("QA"); // AC1

    // The next tick reads the board back and the marker is gone.
    const written = ingestBoardItems(s, asItems(board), { "1": "" });
    expect(written.lanes[0].lastWroteStatus).toBeUndefined();

    // On the pre-#205 row the move never happened: the board stays Building and
    // the marker is not transient, it is forever.
    let skipped = ingestBoardItems(s, [{ number: 1, title: "t", fields: { Status: "Building" } }], { "1": "" });
    expect(skipped.tickets[0].status).toBe("Building");
    expect(skipped.lanes[0].lastWroteStatus).toBe("QA");
    for (let tick = 0; tick < 5; tick++) {
      skipped = ingestBoardItems(skipped, [{ number: 1, title: "t", fields: { Status: "Building" } }], { "1": "" });
    }
    expect(skipped.lanes[0].lastWroteStatus).toBe("QA");
  });

  // AC2, driven end to end so it FAILS if the write is dropped: the whole point
  // of this ticket is that the resume stage comes from the board, so the test
  // has to run the transition through the same simulated orchestrator and read
  // the resume off the board it produced. Delete the `advance` case from
  // boardWriteFor and this board never reaches QA, so the resume claims builder.
  //
  // Scope of "the process dies": this is the ticket whose lane lock is already
  // gone (a stop-lane'd lane, or one a previous --reconcile pruned), so nothing
  // marks it as crashed and the fresh invocation just ingests the board and
  // claims. A ticket that still holds its lock takes the --reconcile path
  // instead, which parks an in-flight one back to Ready by design (a lock whose
  // ticket already reached a TERMINAL status is only pruned and unlocked --
  // lib/reconcile.ts reconcilePlan).
  test("AC2: a lane advanced to qa, then killed, resumes at `qa` and never re-claims as a builder -- because the advance wrote the board", () => {
    const board = new Map<number, BoardStatus>([[1, "Building"]]);
    let live = state([ticket(1, "Building")], [lane(1, "builder", { outcome: { kind: "built" } })]);
    const action: Action = { kind: "advance", ticket: 1, to: "qa" };
    live = applyAction(live, action, 0);
    performRow(board, action);
    expect(live.lanes[0].stage).toBe("qa");

    // ...the process dies here. A new invocation holds no lanes; Step 3's ingest
    // rebuilds loop state from the board alone, and Step 4 asks for an action.
    const resumed = ingestBoardItems(null, asItems(board), { "1": "" });
    expect(resumed.lanes).toEqual([]);
    expect(nextAction(resumed, 0)).toEqual({ kind: "claim", ticket: 1, stage: "qa" });
    expect(claimStage("QA")).toBe("qa");

    // The same crash on pre-#205 main, where the row wrote nothing: the board
    // still reads Building, so the resume re-claims a finished build and pays
    // for it twice (#164 burned $1.35 duplicating already-pushed commits).
    const stale = ingestBoardItems(null, [{ number: 1, title: "Ticket 1", fields: { Status: "Building" } }], { "1": "" });
    expect(nextAction(stale, 0)).toEqual({ kind: "claim", ticket: 1, stage: "builder" });

    // A reviewer lane resumes at the reviewer for the same reason.
    const rBoard = new Map<number, BoardStatus>([[2, "QA"]]);
    performRow(rBoard, { kind: "advance", ticket: 2, to: "reviewer" });
    expect(nextAction(ingestBoardItems(null, asItems(rBoard), { "2": "" }), 0)).toEqual({ kind: "claim", ticket: 2, stage: "reviewer" });
  });

  // The one stage the board write does NOT restore, pinned so it cannot change
  // unnoticed. merge owns no column -- it runs under Review -- so the advance
  // into it writes `Review`, and CLAIMABLE_STAGE maps Review back to `reviewer`.
  // A lane that reached merge and then died therefore re-claims as a REVIEWER
  // and re-pays one adversarial review of a diff that was already approved. That
  // is strictly cheaper than the builder rebuild this ticket removes, and it is
  // inherent to merge having no status of its own (out of scope here: the nine
  // canonical statuses), but it is the residual cost, not a fixed one.
  test("known limit: a lane advanced to merge, then killed, resumes as a REVIEWER -- merge owns no board column", () => {
    const board = new Map<number, BoardStatus>([[3, "Review"]]);
    performRow(board, { kind: "advance", ticket: 3, to: "merge" });
    expect(board.get(3)).toBe("Review");
    expect(claimStage("Review")).toBe("reviewer");
    expect(nextAction(ingestBoardItems(null, asItems(board), { "3": "" }), 0)).toEqual({ kind: "claim", ticket: 3, stage: "reviewer" });
  });

  // AC3: the legality check is unchanged, and the row's ordering keeps it in
  // FRONT of the board. `apply` validates the transition through canTransition
  // and throws exactly as it does today; the orchestrator only moves the board
  // afterwards, so an illegal advance never reaches it at all.
  test("AC3: an advance writing an illegal transition still throws, and the state file is untouched", () => {
    const s = state([ticket(1, "Ready")], [lane(1, "reviewer", { outcome: { kind: "review-findings", note: "x" } })]);
    // Ready -> Building is legal; Ready -> Review (the reviewer lane's own
    // status) is not, and that is what an advance to `reviewer` would write.
    expect(canTransition("Ready", "Review")).toBe(false);
    expect(() => applyAction(s, { kind: "advance", ticket: 1, to: "reviewer" }, 0)).toThrow(/Illegal status transition for #1: Ready -> Review/);
    // pure: the caller's state never moved, so nothing tells the row to write
    expect(s.tickets[0].status).toBe("Ready");
    expect(s.lanes[0].stage).toBe("reviewer");
    expect(s.lanes[0].lastWroteStatus).toBeUndefined();
  });

  // The crash window the row's ordering leaves, evaluated where the guard
  // actually runs: apply landed, the move did not, and the lane has since
  // reached its next stage boundary (the guard skips a lane with no recorded
  // outcome, so a crash that also cost the step-4 spawn waits on the #209
  // re-spawn to produce one before any of this is reachable). The board is then
  // exactly one hop BEHIND a lane that names the write it owes.
  // That is the shape #125's origin marker was built for, so the existing guard
  // resyncs on the next tick and the advance proceeds with the lane's stage,
  // bounce counters intact -- no stop-lane, no re-claim, no
  // rebuild, FOR A ONE-HOP ADVANCE (the skip-qa two-hop case is its own test
  // below). Pinned here because the ordering is a choice: move the board FIRST
  // and this window inverts to board-ahead-of-lane, which isOneHopLag does not
  // model and which therefore stop-lanes (losing qaBounces and qaNotes).
  test("crash between the apply and the move is recovered by the existing one-hop resync, on both the forward advance and a bounce", () => {
    // forward: apply advanced the lane to qa, the QA move never went out
    const fwd = state([ticket(1, "Building")], [lane(1, "qa", { outcome: { kind: "qa-pass" }, lastWroteStatus: "QA" })]);
    expect(nextAction(fwd, 0)).toEqual({ kind: "advance", ticket: 1, to: "reviewer", resyncStatus: "QA" });

    // bounce: apply bounced the lane back to builder, the Building move did not
    // go out. The bounce counter it just spent is what gates the resync, and it
    // survives -- the QA note rides on the advance the loop is about to make.
    const bounce = state([ticket(1, "QA")], [lane(1, "builder", { qaBounces: 1, lastWroteStatus: "Building", outcome: { kind: "built" } })]);
    expect(nextAction(bounce, 0)).toEqual({ kind: "advance", ticket: 1, to: "qa", resyncStatus: "Building" });
  });

  // KNOWN GAP, pinned so it cannot be mistaken for the recovered case above.
  // #130's skip-qa walk is the ONE advance that is not one hop: resolveOutcome
  // sends a labeled builder straight to `reviewer`, i.e. Building -> Review,
  // while PRECEDING_BOARD_STATUS maps a reviewer lane's lag to `QA` alone. So a
  // missed step-3 move on THAT advance is not a lag the guard recognizes -- it
  // stop-lanes, and the re-claim reads the board's stale Building and comes back
  // as a *builder*, rebuilding an already-built, already-approved ticket.
  //
  // This is the pre-#205 outcome for EVERY skip-qa advance (the row wrote
  // nothing, so the board never left Building), now narrowed to the crash window
  // -- so the board write is a strict improvement here too. Closing the window
  // means widening isOneHopLag, which this ticket's Out of scope list holds back
  // ("the #125 resync guard's logic, which is correct given a truthful marker"),
  // so the gap is pinned rather than silently patched.
  test("KNOWN GAP: the skip-qa two-hop advance is NOT recovered -- a missed move there still re-claims as a builder", () => {
    const skip = state(
      [ticket(1, "Building", [], { skipQa: true })],
      [lane(1, "reviewer", { outcome: approve(100), lastWroteStatus: "Review" })]
    );
    const stop = nextAction(skip, 0);
    expect(stop).toMatchObject({ kind: "stop-lane", ticket: 1 });
    // ...and that stop-lane is what hands the ticket back to a builder.
    expect(nextAction(applyAction(skip, stop, 0), 0)).toEqual({ kind: "claim", ticket: 1, stage: "builder" });

    // The same lane WITHOUT the two-hop jump resyncs, which is what isolates the
    // cause to the hop distance rather than to the reviewer stage itself.
    const oneHop = state([ticket(1, "QA")], [lane(1, "reviewer", { outcome: approve(100), lastWroteStatus: "Review" })]);
    expect(nextAction(oneHop, 0)).not.toMatchObject({ kind: "stop-lane" });
  });
});

// -- #124: resync-on-lag also covers advance->builder bounce-backs ------------
// #116 mapped only the two FORWARD advances (qa lagging at Building, reviewer
// at QA) and omitted builder on the false premise that no advance reaches it.
// But a qa-bugs bounce and a review-findings bounce both advance TO builder, so
// a lagged bounce-to-Building write can leave a builder-stage lane reading its
// pre-bounce status. Distance alone can't discriminate here (the bounce lags at
// QA or at Review, both a single write behind Building), so the source counter
// gates it: resync only when the matching bounce actually happened, else a
// genuine human move still stop-lanes.
describe("resync-on-lag covers advance->builder bounce-backs (#124)", () => {
  test("AC1: a qa-bugs bounce lane at builder lagging at QA resyncs to Building and proceeds -- no stop-lane, no second rebuild", () => {
    const s = state(
      [ticket(1, "QA")], // the loop's own bounce-to-Building write has not landed yet
      [lane(1, "builder", { qaBounces: 1, outcome: { kind: "built" }, lastWroteStatus: "Building" })] // rebuild passing; #125 origin marker: the bounce write is in flight
    );
    const a = nextAction(s, 0);
    expect(a).toMatchObject({ kind: "advance", ticket: 1, to: "qa", resyncStatus: "Building" });
    const after = applyAction(s, a, 0);
    expect(after.tickets[0].status).toBe("QA"); // resynced to Building, then advanced -- not stopped, not re-claimed
    expect(after.lanes[0]).toMatchObject({ ticket: 1, stage: "qa" });
    expect(after.lanes[0].outcome).toBeUndefined();
  });

  test("AC2: a review-findings bounce lane at builder lagging at Review resyncs to Building and proceeds -- same resync", () => {
    const s = state(
      [ticket(1, "Review")], // the bounce-to-Building write from Review has not landed yet
      [lane(1, "builder", { reviewBounces: 1, outcome: { kind: "built" }, lastWroteStatus: "Building" })] // #125 origin marker: the bounce write is in flight
    );
    const a = nextAction(s, 0);
    expect(a).toMatchObject({ kind: "advance", ticket: 1, to: "qa", resyncStatus: "Building" });
    const after = applyAction(s, a, 0);
    expect(after.tickets[0].status).toBe("QA");
    expect(after.lanes[0]).toMatchObject({ ticket: 1, stage: "qa" });
  });

  test("AC3: a genuine human move-back stays stop-lane -- more than one hop, and one hop with no matching bounce", () => {
    // More than one hop: a builder lane dragged back to Ready is nothing our own
    // single bounce write could produce.
    const farMove = state(
      [ticket(1, "Ready")],
      [lane(1, "builder", { qaBounces: 1, outcome: { kind: "built" } })]
    );
    expect(nextAction(farMove, 0)).toMatchObject({ kind: "stop-lane", ticket: 1 });

    // One hop by status, but no lane-driven bounce ever happened (counters at 0),
    // so QA/Review on a builder lane is a genuine move, not a lagged bounce.
    const noBounce = state(
      [ticket(1, "QA")],
      [lane(1, "builder", { qaBounces: 0, reviewBounces: 0, outcome: { kind: "built" } })]
    );
    expect(nextAction(noBounce, 0)).toMatchObject({ kind: "stop-lane", ticket: 1 });
  });
});

// -- #130: a `skip-qa` label sends a finished builder straight to Review -------
// A human sets the label at triage (error fix, answering a question, resolving
// a blocker); it rides the board snapshot onto TicketSnapshot.skipQa, and a
// finished builder then advances to reviewer, skipping QA. Every non-skip
// ticket is byte-for-byte unchanged (the QA-bounce ladder test above still
// passes untouched).
describe("skip-qa label short-circuits QA (#130)", () => {
  // Build the exact AC fixture: ingest a Building issue #1 (skip-qa label or
  // not) so skipQa comes off the snapshot the real reducer reads, then attach
  // the finished builder lane.
  const builtLane = (skipQaLabel: boolean): LoopState => {
    const ingested = ingestBoardItems(
      null,
      [{ number: 1, title: "t", fields: { Status: "Building" }, labels: skipQaLabel ? ["skip-qa"] : [] }],
      { "1": "" }
    );
    return { ...ingested, lanes: [lane(1, "builder", { outcome: { kind: "built" } })] };
  };

  test("AC1: a skip-qa builder advances straight to reviewer and lands in Review, no throw", () => {
    let s = builtLane(true);
    expect(s.tickets[0].skipQa).toBe(true);
    const a = nextAction(s, 0);
    expect(a).toEqual({ kind: "advance", ticket: 1, to: "reviewer" });
    expect(() => applyAction(s, a, 0)).not.toThrow();
    s = applyAction(s, a, 0);
    expect(s.tickets[0].status).toBe("Review");
    expect(s.lanes[0]).toMatchObject({ ticket: 1, stage: "reviewer" });
    expect(s.lanes[0].outcome).toBeUndefined();
  });

  test("AC2: the same fixture without the label takes the normal builder -> qa path", () => {
    let s = builtLane(false);
    expect(s.tickets[0].skipQa).toBeFalsy();
    const a = nextAction(s, 0);
    expect(a).toEqual({ kind: "advance", ticket: 1, to: "qa" });
    s = applyAction(s, a, 0);
    expect(s.tickets[0].status).toBe("QA");
    expect(s.lanes[0]).toMatchObject({ ticket: 1, stage: "qa" });
  });
});

// -- board-snapshot ingest ----------------------------------------------------

describe("ingestBoardItems", () => {
  test("builds tickets from z-board items + bodies, preserving lanes and lost claims", () => {
    const prev: LoopState = {
      tickets: [ticket(6, "Building", [], { claimedByOther: true })],
      lanes: [lane(5, "qa")],
      maxLanes: 2,
      watchdogMinutes: 7,
    };
    const s = ingestBoardItems(
      prev,
      [
        { number: 6, title: "B", fields: { Status: "Building", Model: "opus", "Model Effort": "xhigh" } },
        { number: 5, title: "A", fields: { Status: "QA", Model: "sonnet" } },
      ],
      { "5": "## Context\n\nDepends on: #2", "6": "no deps" }
    );
    expect(s.tickets.map((t) => t.number)).toEqual([5, 6]); // sorted
    expect(s.tickets[0]).toMatchObject({ status: "QA", model: "sonnet", dependsOn: [2] });
    expect(s.tickets[1]).toMatchObject({ model: "opus", modelEffort: "xhigh", claimedByOther: true });
    expect(s.lanes).toEqual([lane(5, "qa")]);
    expect(s.maxLanes).toBe(2);
    expect(s.watchdogMinutes).toBe(7);
  });

  // #226 follow-up. A human adding a board column (a staging queue, a triage
  // lane) used to throw out of ingest and kill every tick. The loop now ignores
  // what it cannot drive -- and ignoring means REMOVING, because #138's
  // carry-forward would otherwise hold the ticket's last workable status.
  describe("board statuses the loop does not drive (#226)", () => {
    const staged = (n: number) => ({ number: n, title: `t${n}`, fields: { Status: "Stage" } });

    test("a ticket in an unknown status is ignored instead of crashing ingest", () => {
      const s = ingestBoardItems(
        null,
        [staged(1), { number: 2, title: "t2", fields: { Status: "Ready" } }],
        { "1": "", "2": "" }
      );
      expect(s.tickets.map((t) => t.number)).toEqual([2]);
    });

    test("an item with no Status field is ignored, not crashed on", () => {
      const s = ingestBoardItems(null, [{ number: 1, title: "t1", fields: {} }], { "1": "" });
      expect(s.tickets).toEqual([]);
    });

    test("it is never claimed, never counted in the batch, and never blocks drain-complete", () => {
      const s = ingestBoardItems(null, [staged(1)], { "1": "" }, { ticketLimit: 5 });
      expect(s.tickets).toEqual([]);
      expect(s.batchTickets ?? []).not.toContain(1);
      expect(drainComplete(s.tickets, s.lanes, s.batchTickets)).toBe(true);
      expect(nextAction(s, 0).kind).toBe("drain-complete");
    });

    // The failure a plain skip would leave behind: carry-forward keeps the old
    // status, so the loop would still see Ready and claim a ticket the human
    // deliberately moved out of the queue.
    test("moving a Ready ticket into an unknown status removes it, not just skips it", () => {
      const prev: LoopState = { tickets: [ticket(1, "Ready")], lanes: [], maxLanes: 2, watchdogMinutes: 7 };
      const s = ingestBoardItems(prev, [staged(1)], { "1": "" });
      expect(s.tickets).toEqual([]);
      expect(nextAction(s, 0).kind).not.toBe("claim");
    });

    // #273 replaced the silent drop this used to assert. Dropping the lane inside
    // the reducer left the lane's background agent running, its ticket-<N>.json
    // lock on disk, and its worktree undecided -- with nothing in state left to
    // name any of them. The lane is now MARKED and stopped by an action.
    test("a laned ticket moved to an unknown status is stopped, not dropped, by ingest (#273)", () => {
      const prev: LoopState = { tickets: [ticket(1, "QA")], lanes: [lane(1, "qa")], maxLanes: 2, watchdogMinutes: 7 };
      const s = ingestBoardItems(prev, [staged(1)], { "1": "" });
      expect(s.lanes.map((l) => l.ticket)).toEqual([1]);
      expect(s.lanes[0].goneReason).toEqual({ kind: "unsupported-status", status: "Stage" });
      expect(s.tickets.map((t) => t.number)).toEqual([1]); // the tombstone
    });

    test("a known-status ticket in the same read is unaffected", () => {
      const prev: LoopState = { tickets: [ticket(2, "Ready")], lanes: [], maxLanes: 2, watchdogMinutes: 7 };
      const withStage = ingestBoardItems(prev, [staged(1), { number: 2, title: "t2", fields: { Status: "Ready" } }], {
        "1": "",
        "2": "",
      });
      const without = ingestBoardItems(prev, [{ number: 2, title: "t2", fields: { Status: "Ready" } }], { "2": "" });
      expect(JSON.stringify(withStage.tickets)).toBe(JSON.stringify(without.tickets));
    });

    test("partitionKnownStatus names the issue and the status in one note per ignored ticket", () => {
      const p = partitionKnownStatus([staged(1), { number: 2, title: "t2", fields: { Status: "Ready" } }, { number: 3, title: "t3", fields: {} }]);
      expect(p.known.map((i) => i.number)).toEqual([2]);
      expect(p.ignored).toEqual([
        { number: 1, status: "Stage" },
        { number: 3, status: "" },
      ]);
      expect(p.notes).toHaveLength(2);
      expect(p.notes[0]).toContain("#1");
      expect(p.notes[0]).toContain('"Stage"');
      expect(p.notes[1]).toContain("(none)");
    });
  });

  // ==========================================================================
  // #273 -- a lane whose ticket leaves the loop's reach is STOPPED, not filtered
  // ==========================================================================
  // The defect: `gone` (an unknown board status OR a confirmed removal) deleted
  // the ticket AND filtered the lane inside ingestBoardItems, emitting no action.
  // Nothing tore down the lane's background agent, nothing removed its
  // ticket-<N>.json lock, and drainComplete -- which reads lanes.length -- went
  // true underneath a worker still committing to z/ticket-<N>, so Step 7 could
  // delete that branch. Removal is now an ACTION the orchestrator executes.
  describe("a gone ticket's lane is stopped by an action (#273)", () => {
    const cancelled = (n: number) => ({ number: n, title: `t${n}`, fields: { Status: "Cancelled" } });

    // AC1. On the pre-#273 code this state came back with no lane at all and the
    // next action was drain-complete.
    test("AC1: an unknown status stops its lane, naming the observed status", () => {
      const prev: LoopState = { tickets: [ticket(5, "Building")], lanes: [lane(5, "builder")], maxLanes: 2, watchdogMinutes: 7 };
      const s = ingestBoardItems(prev, [cancelled(5)], { "5": "" });
      expect(s.lanes.map((l) => l.ticket)).toEqual([5]);
      expect(s.lanes[0].goneReason).toEqual({ kind: "unsupported-status", status: "Cancelled" });

      const a = nextAction(s, 0);
      expect(a.kind).toBe("stop-lane");
      expect((a as { ticket: number }).ticket).toBe(5);
      expect((a as { note: string }).note).toContain('"Cancelled"');
      expect((a as { note: string }).note).toContain("#5");
      // The note must name the teardown the SKILL's stop-lane row performs --
      // this is the whole reason the action exists rather than a filter.
      expect((a as { note: string }).note).toMatch(/lane lock/i);
      // Both structural flags, read off the action JSON and never off the note
      // (#209's rule). dropTicket is what makes applyAction remove the ticket;
      // salvage is required because this is the one stop-lane that fires
      // MID-STAGE, so the worktree may hold work no boundary ever committed.
      expect((a as { dropTicket?: true }).dropTicket).toBe(true);
      expect((a as { salvage?: true }).salvage).toBe(true);
      expect((a as { note: string }).note).toContain("uncommitted-5.patch");
    });

    // The bug the single-lane fixtures above could not see: the stop used to live
    // inside the shared per-lane loop, so a LOWER-INDEXED lane with a finished
    // stage returned first and #5's live agent kept running for another tick (and
    // another, for as long as its neighbours had work). Step 1a is its own pass.
    test("AC1: a gone lane's stop outranks a DIFFERENT lane's finished stage", () => {
      const prev: LoopState = {
        tickets: [ticket(4, "Building"), ticket(5, "Building")],
        lanes: [lane(4, "builder", { outcome: { kind: "built" } }), lane(5, "builder")],
        maxLanes: 3,
        watchdogMinutes: 10,
      };
      const s = ingestBoardItems(prev, [
        { number: 4, title: "t4", fields: { Status: "Building" } },
        cancelled(5),
      ], { "4": "", "5": "" });
      const a = nextAction(s, 0);
      expect(a.kind).toBe("stop-lane");
      expect((a as { ticket: number }).ticket).toBe(5);
    });

    // Deterministic when two lanes go gone at once: lowest ticket number first.
    test("two gone lanes stop in ticket order, one per tick", () => {
      const prev: LoopState = {
        tickets: [ticket(5, "Building"), ticket(9, "QA")],
        lanes: [lane(9, "qa"), lane(5, "builder")],
        maxLanes: 3,
        watchdogMinutes: 10,
      };
      const s = ingestBoardItems(prev, [cancelled(5), cancelled(9)], { "5": "", "9": "" });
      const first = nextAction(s, 0);
      expect((first as { ticket: number }).ticket).toBe(5);
      const second = nextAction(applyAction(s, first, 0), 0);
      expect(second.kind).toBe("stop-lane");
      expect((second as { ticket: number }).ticket).toBe(9);
    });

    // The two goneReason sources have a documented precedence -- an observed
    // status is the newer evidence -- and swapping the two loops in ingest would
    // flip it with nothing failing.
    test("an observed unsupported status outranks a stale confirmed-gone answer", () => {
      const prev: LoopState = { tickets: [ticket(5, "Building")], lanes: [lane(5, "builder")], maxLanes: 2, watchdogMinutes: 7 };
      const s = ingestBoardItems(prev, [cancelled(5)], { "5": "" }, undefined, [5]);
      expect(s.lanes[0].goneReason).toEqual({ kind: "unsupported-status", status: "Cancelled" });
      expect((nextAction(s, 0) as { note: string }).note).toContain('"Cancelled"');
    });

    // An item with no Status field renders "(none)", not an empty pair of quotes.
    test("a missing Status field is named (none) in the stop note", () => {
      const prev: LoopState = { tickets: [ticket(5, "Building")], lanes: [lane(5, "builder")], maxLanes: 2, watchdogMinutes: 7 };
      const s = ingestBoardItems(prev, [{ number: 5, title: "t5", fields: {} }], { "5": "" });
      expect(s.lanes[0].goneReason).toEqual({ kind: "unsupported-status", status: "" });
      const note = (nextAction(s, 0) as { note: string }).note;
      expect(note).toContain("(none)");
      expect(note).not.toContain('""');
    });

    // A state.json written by a future version (or hand-edited) must still stop
    // the lane -- but must NOT borrow either proof. Fabricating "a lookup proved
    // it gone" for evidence nobody gathered is the #138 failure with a new face.
    test("an unrecognized goneReason kind stops the lane without fabricating evidence", () => {
      const s: LoopState = {
        tickets: [ticket(5, "Building")],
        lanes: [lane(5, "builder", { goneReason: { kind: "some-future-kind" } as never })],
        maxLanes: 2,
        watchdogMinutes: 7,
      };
      const a = nextAction(s, 0);
      expect(a.kind).toBe("stop-lane");
      expect((a as { dropTicket?: true }).dropTicket).toBe(true);
      const note = (a as { note: string }).note;
      expect(note).toMatch(/does not recognize/i);
      expect(note).not.toMatch(/single-ticket lookup/i);
      expect(note).not.toMatch(/does not drive/i);
    });

    // The stop does NOT wait for a stage boundary, unlike the human-move stop:
    // a gone ticket is not observable next tick, so there is no boundary coming.
    test("AC1: the stop fires on a mid-stage lane with no recorded outcome", () => {
      const prev: LoopState = { tickets: [ticket(5, "Building")], lanes: [lane(5, "builder")], maxLanes: 2, watchdogMinutes: 7 };
      expect(prev.lanes[0].outcome).toBeUndefined();
      const s = ingestBoardItems(prev, [cancelled(5)], { "5": "" });
      expect(nextAction(s, 0).kind).toBe("stop-lane");
    });

    // AC2: the pair leaves state together, and only on the apply.
    test("AC2: applying the stop drops the lane and the tombstone, leaving the rest alone", () => {
      const prev: LoopState = {
        tickets: [ticket(5, "Building"), ticket(6, "Ready")],
        lanes: [lane(5, "builder")],
        maxLanes: 2,
        watchdogMinutes: 7,
      };
      const s = ingestBoardItems(prev, [cancelled(5), { number: 6, title: "t6", fields: { Status: "Ready" } }], { "5": "", "6": "" });
      const after = applyAction(s, nextAction(s, 0), 0);
      expect(after.lanes).toEqual([]);
      expect(after.tickets.map((t) => t.number)).toEqual([6]);
      // Everything else is untouched, and no board status was written for #5 --
      // the human's column (or the removal) is not the loop's to overwrite.
      expect(after.tickets.find((t) => t.number === 6)).toEqual(s.tickets.find((t) => t.number === 6)!);
      expect({ ...after, tickets: [], lanes: [] }).toEqual({ ...s, tickets: [], lanes: [] });
    });

    // And it does not accumulate: a second ingest after the apply has no lane to
    // re-mark and no tombstone to re-carry.
    test("AC2: the tombstone does not survive into the next tick", () => {
      const prev: LoopState = { tickets: [ticket(5, "Building")], lanes: [lane(5, "builder")], maxLanes: 2, watchdogMinutes: 7 };
      const one = applyAction(ingestBoardItems(prev, [cancelled(5)], { "5": "" }), nextAction(ingestBoardItems(prev, [cancelled(5)], { "5": "" }), 0), 0);
      const two = ingestBoardItems(one, [cancelled(5)], { "5": "" });
      expect(two.tickets).toEqual([]);
      expect(two.lanes).toEqual([]);
    });

    // AC3: the drain cannot declare itself finished under the live worker. On
    // pre-#273 code this was true, which let Step 7 `git branch -D` the branch
    // that worker was still committing to.
    test("AC3: drainComplete is false while a gone lane is still outstanding", () => {
      const prev: LoopState = {
        tickets: [ticket(5, "Building"), ticket(6, "Done"), ticket(7, "Skipped")],
        lanes: [lane(5, "builder")],
        maxLanes: 2,
        watchdogMinutes: 7,
      };
      const s = ingestBoardItems(prev, [cancelled(5)], { "5": "" });
      expect(s.tickets.filter((t) => t.number !== 5).every((t) => !isWorkableStatus(t.status))).toBe(true);
      expect(drainComplete(s.tickets, s.lanes, s.batchTickets)).toBe(false);
      expect(nextAction(s, 0).kind).not.toBe("drain-complete");
      // ...and it becomes true only once the stop has actually been applied.
      const after = applyAction(s, nextAction(s, 0), 0);
      expect(drainComplete(after.tickets, after.lanes, after.batchTickets)).toBe(true);
    });

    // AC4: the confirmed-gone arm takes the identical path, driven through the
    // REAL confirm pass (applyConfirmations) rather than a hand-passed number.
    test("AC4: a confirmed-gone ticket stops its lane too, naming the removal proof", () => {
      const prev: LoopState = { tickets: [ticket(7, "QA")], lanes: [lane(7, "qa")], maxLanes: 2, watchdogMinutes: 7 };
      const confirmed = applyConfirmations([], {}, [{ number: 7, present: false, reason: "not-on-project" }]);
      expect(confirmed.confirmedGone).toEqual([7]);

      const s = ingestBoardItems(prev, confirmed.items, confirmed.bodies, undefined, confirmed.confirmedGone);
      expect(s.lanes.map((l) => l.ticket)).toEqual([7]);
      expect(s.lanes[0].goneReason).toEqual({ kind: "confirmed-gone" });

      const a = nextAction(s, 0);
      expect(a.kind).toBe("stop-lane");
      expect((a as { ticket: number }).ticket).toBe(7);
      expect((a as { note: string }).note).toMatch(/no longer on the project board/i);
      expect((a as { note: string }).note).toMatch(/lane lock/i);

      const after = applyAction(s, a, 0);
      expect(after.lanes).toEqual([]);
      expect(after.tickets).toEqual([]);
    });

    // AC5: the LANELESS case is untouched. This is the #226 behavior the fix must
    // not disturb -- there is no agent, no lock and no worktree to tear down, so
    // there is nothing for an action to do and the plain removal stays right.
    test("AC5: an unknown status on a laneless ticket still just removes it, with no action", () => {
      const prev: LoopState = { tickets: [ticket(9, "Ready")], lanes: [], maxLanes: 2, watchdogMinutes: 7 };
      const s = ingestBoardItems(prev, [cancelled(9)], { "9": "" });
      expect(s.tickets).toEqual([]);
      expect(s.lanes).toEqual([]);
      expect(nextAction(s, 0).kind).toBe("drain-complete");
      // The stderr note is still the only trace, and still one per ignored ticket.
      expect(partitionKnownStatus([cancelled(9)]).notes).toHaveLength(1);
    });

    // A gone lane jumps the queue: it is checked before every other per-lane
    // transition, including a finished stage sitting on the same lane.
    test("a gone lane's stop outranks its own finished-stage advance", () => {
      const prev: LoopState = {
        tickets: [ticket(5, "Building")],
        lanes: [lane(5, "builder", { outcome: { kind: "built" } })],
        maxLanes: 2,
        watchdogMinutes: 7,
      };
      const s = ingestBoardItems(prev, [cancelled(5)], { "5": "" });
      expect(nextAction(s, 0).kind).toBe("stop-lane");
    });

    // A lane whose ticket was ALREADY missing from prev is the orphan-lane crash
    // (#138's H14) the retention would otherwise re-introduce: nextAction and
    // applyAction both index tickets by lane number and assume a hit.
    test("a retained lane always gets a ticket, even when prev had none for it", () => {
      const prev: LoopState = { tickets: [], lanes: [lane(5, "reviewer")], maxLanes: 2, watchdogMinutes: 7 };
      const s = ingestBoardItems(prev, [], {}, undefined, [5]);
      expect(s.tickets.map((t) => t.number)).toEqual([5]);
      expect(s.tickets[0].status).toBe("Review"); // the lane's own stage status
      expect(() => applyAction(s, nextAction(s, 0), 0)).not.toThrow();
      expect(applyAction(s, nextAction(s, 0), 0).tickets).toEqual([]);
    });

    // A mark normally lives one tick. It can outlive that only if the run dies
    // between the ingest that set it and the apply that consumes it -- and then
    // it must not stop a lane the board has since proved workable again.
    test("a stale goneReason is cleared when the ticket is observed back in a driven status", () => {
      const crashed: LoopState = {
        tickets: [ticket(5, "Building")],
        lanes: [lane(5, "builder", { goneReason: { kind: "unsupported-status", status: "Cancelled" }, lastWroteStatus: "Building" })],
        maxLanes: 2,
        watchdogMinutes: 7,
      };
      const s = ingestBoardItems(crashed, [{ number: 5, title: "t5", fields: { Status: "Building" } }], { "5": "" });
      expect(s.lanes[0].goneReason).toBeUndefined();
      expect(nextAction(s, 0).kind).not.toBe("stop-lane");
      // A revived lane gets the SAME treatment every other lane on this read
      // gets: #125's origin marker is cleared too, because the board has been
      // observed showing the status the loop last wrote. An earlier cut returned
      // early here and left it set, which tells the next tick's desync guard to
      // resync a lag that does not exist instead of honoring a human's move-back.
      expect(s.lanes[0].lastWroteStatus).toBeUndefined();
    });

    // ...but an ABSENCE is not that proof (#138). A short page or a failed
    // confirm lookup must leave a mark that was once positively earned alone,
    // or a truncated read silently resurrects a lane the loop proved was gone.
    test("a stale goneReason survives a read that simply does not show the ticket", () => {
      const crashed: LoopState = {
        tickets: [ticket(5, "Building")],
        lanes: [lane(5, "builder", { goneReason: { kind: "confirmed-gone" } })],
        maxLanes: 2,
        watchdogMinutes: 7,
      };
      const s = ingestBoardItems(crashed, [], {});
      expect(s.lanes[0].goneReason).toEqual({ kind: "confirmed-gone" });
      expect(nextAction(s, 0).kind).toBe("stop-lane");
    });

    // #273: the discriminator is the ACTION's `dropTicket`, never `lane.goneReason`.
    // The SKILL hand-builds a stop-lane of this kind itself (the `--if-present`
    // moved:false row) for a lane that never went through a marking ingest, so a
    // reducer that consulted hidden lane state left THAT path's ticket behind at a
    // workable status -- and the next `next` returned a `claim`, spawning a paid
    // agent into a ticket the board had just proved it does not have.
    test("a hand-built stop-lane with dropTicket removes the ticket, with no lane mark", () => {
      const s: LoopState = { tickets: [ticket(7, "Building")], lanes: [lane(7, "builder")], maxLanes: 2, watchdogMinutes: 7 };
      expect(s.lanes[0].goneReason).toBeUndefined(); // never ingested, never marked
      const after = applyAction(
        s,
        { kind: "stop-lane", ticket: 7, dropTicket: true, note: "#7 is no longer on the project board; releasing its lane." },
        0
      );
      expect(after.lanes).toEqual([]);
      expect(after.tickets).toEqual([]);
      // The regression this pins: without the flag the next tick re-claimed it.
      expect(nextAction(after, 0).kind).not.toBe("claim");
    });

    // Applying a replayed/duplicate stop-lane must not delete a live ticket.
    test("a stop-lane for a lane that is already gone is a safe no-op", () => {
      const s: LoopState = { tickets: [ticket(5, "Blocked")], lanes: [], maxLanes: 2, watchdogMinutes: 7 };
      const after = applyAction(s, { kind: "stop-lane", ticket: 5, note: "replayed" }, 0);
      expect(after.tickets).toEqual([ticket(5, "Blocked")]);
      expect(after.lanes).toEqual([]);
    });

    // A confirmed-gone lane awaiting its stop must not be re-looked-up: it was
    // marked BY a positive observation, so the lookup can prove nothing new.
    test("a marked lane is dropped from the confirm pass's target list", () => {
      const prev: LoopState = { tickets: [ticket(7, "QA")], lanes: [lane(7, "qa")], maxLanes: 2, watchdogMinutes: 7 };
      const s = ingestBoardItems(prev, [], {}, undefined, [7]);
      expect(s.lanes[0].goneReason).toEqual({ kind: "confirmed-gone" });
      expect(confirmTargets(s, [])).toEqual([]);
    });

    // The OTHER stop-lane (a human move to a terminal status) must keep its
    // ticket: that ticket is real, still on the board, and drainComplete has to
    // see its terminal status. Only a tombstone leaves with its lane.
    test("a human-move stop-lane still leaves its ticket in state", () => {
      const s: LoopState = {
        tickets: [ticket(5, "Blocked")],
        lanes: [lane(5, "builder", { outcome: { kind: "built" } })],
        maxLanes: 2,
        watchdogMinutes: 7,
      };
      const a = nextAction(s, 0);
      expect(a.kind).toBe("stop-lane");
      const after = applyAction(s, a, 0);
      expect(after.lanes).toEqual([]);
      expect(after.tickets).toEqual([ticket(5, "Blocked")]);
    });
  });

  test("reads the skip-qa label into skipQa; an item without it leaves skipQa falsy (#130)", () => {
    const s = ingestBoardItems(
      null,
      [
        { number: 1, title: "a", fields: { Status: "Building" }, labels: ["skip-qa"] },
        { number: 2, title: "b", fields: { Status: "Building" }, labels: [] },
      ],
      { "1": "", "2": "" }
    );
    expect(s.tickets.find((t) => t.number === 1)!.skipQa).toBe(true);
    expect(s.tickets.find((t) => t.number === 2)!.skipQa).toBeFalsy();
  });

  // -- issue #41: maxQaPasses / qaInvestigateAfter thread through ingest, same
  //    fallback chain (cfg -> preserved-from-prev -> DEFAULT_*) as maxLanes.
  test("maxQaPasses/qaInvestigateAfter: first ingest defaults to 3/2, a re-ingest with no cfg preserves the prior values, and an explicit cfg overrides them", () => {
    const items = [{ number: 6, title: "B", fields: { Status: "Building" } }];
    const bodies = { "6": "no deps" };

    // AC1: a genuinely first ingest (no prev, no cfg) carries the defaults.
    const first = ingestBoardItems(null, items, bodies);
    expect(first.maxQaPasses).toBe(3);
    expect(first.qaInvestigateAfter).toBe(2);

    // A project that set custom knobs at first ingest...
    const custom = ingestBoardItems(null, items, bodies, { maxQaPasses: 5, qaInvestigateAfter: 1 });
    expect(custom.maxQaPasses).toBe(5);
    expect(custom.qaInvestigateAfter).toBe(1);

    // ...keeps them on a re-ingest that passes no cfg (SKILL Step 4 never
    // re-passes --max-qa-passes/--qa-investigate-after, only Step 3 does).
    const reingested = ingestBoardItems(custom, items, bodies);
    expect(reingested.maxQaPasses).toBe(5);
    expect(reingested.qaInvestigateAfter).toBe(1);

    // An explicit cfg on a later ingest still wins over the preserved value.
    const overridden = ingestBoardItems(custom, items, bodies, { maxQaPasses: 7, qaInvestigateAfter: 4 });
    expect(overridden.maxQaPasses).toBe(7);
    expect(overridden.qaInvestigateAfter).toBe(4);
  });

  // -- issue #76: maxReviewBounces threads through ingest, same fallback
  //    chain (cfg -> preserved-from-prev -> DEFAULT_MAX_REVIEW_BOUNCES) as
  //    maxQaPasses above.
  test("maxReviewBounces: first ingest defaults to 2, a re-ingest with no cfg preserves the prior value, and an explicit cfg overrides it", () => {
    const items = [{ number: 6, title: "B", fields: { Status: "Building" } }];
    const bodies = { "6": "no deps" };

    const first = ingestBoardItems(null, items, bodies);
    expect(first.maxReviewBounces).toBe(2);

    const custom = ingestBoardItems(null, items, bodies, { maxReviewBounces: 4 });
    expect(custom.maxReviewBounces).toBe(4);

    const reingested = ingestBoardItems(custom, items, bodies);
    expect(reingested.maxReviewBounces).toBe(4);

    const overridden = ingestBoardItems(custom, items, bodies, { maxReviewBounces: 7 });
    expect(overridden.maxReviewBounces).toBe(7);
  });

  // -- issue #63: initialReadyCount / humanNeededNotified capture-once + reset -
  test("AC8: a genuinely first ingest captures initialReadyCount from Ready tickets only, defaults humanNeededPercent, humanNeededNotified false", () => {
    const items = [
      { number: 1, title: "a", fields: { Status: "Ready" } },
      { number: 2, title: "b", fields: { Status: "Ready" } },
      { number: 3, title: "c", fields: { Status: "Ready" } },
      { number: 4, title: "d", fields: { Status: "Ready" } },
      { number: 5, title: "e", fields: { Status: "Done" } },
      { number: 6, title: "f", fields: { Status: "Done" } },
    ];
    const bodies = Object.fromEntries(items.map((it) => [String(it.number), "no deps"]));
    const s = ingestBoardItems(null, items, bodies);
    expect(s.initialReadyCount).toBe(4); // #133: the Ready committed queue, not Building
    expect(s.humanNeededPercent).toBe(30); // default
    expect(s.humanNeededNotified).toBe(false);
  });

  // #133 AC3: with the batch-commit move deferred to claim time, the committed
  // queue sits in Ready at ingest-time-zero and Building is NOT the fresh-batch
  // signal. A stray Building ticket (e.g. a crash-resume mid-flight) must not be
  // counted as this batch's committed work -- the denominator is the Ready count.
  test("AC3 (#133): first ingest captures initialReadyCount from the Ready committed queue; Building tickets are not the signal", () => {
    const items = [
      { number: 1, title: "a", fields: { Status: "Ready" } },
      { number: 2, title: "b", fields: { Status: "Ready" } },
      { number: 3, title: "c", fields: { Status: "Ready" } },
      { number: 4, title: "d", fields: { Status: "Ready" } },
      { number: 5, title: "e", fields: { Status: "Building" } }, // in flight, not part of this fresh batch's committed count
      { number: 6, title: "f", fields: { Status: "Done" } },
    ];
    const bodies = Object.fromEntries(items.map((it) => [String(it.number), "no deps"]));
    const s = ingestBoardItems(null, items, bodies);
    expect(s.initialReadyCount).toBe(4); // the 4 Ready, NOT the Building #5
    expect(s.humanNeededNotified).toBe(false);
  });

  // #133 AC4: the Ready-count denominator is behavior-equivalent to the old
  // Building-count one. Step 1 parks 3 of 10 planned to Questions; the 7
  // committed sit in Ready (they used to sit in Building after Step 2). Numerator
  // = 3 Questions in both models, denominator = 7 in both -> identical trip.
  //
  // #203 moved this onto the state file Step 1 actually leaves behind. The
  // denominator claim is untouched (7 either way); the numerator claim needs a
  // prev to exist, because that is the only way "new to the snapshot" can mean
  // "this batch just filed it" rather than "there is nothing to compare
  // against". Step 3's ingest runs after Step 1's board writes, so every run but
  // a project's first has one.
  test("AC4 (#133): denominator equals the old Building-count semantics when Step 1 parks tickets to Questions", () => {
    const prev: LoopState = {
      tickets: [ticket(99, "Done")], // a drained prior batch
      lanes: [],
      maxLanes: 3,
      watchdogMinutes: 10,
      initialReadyCount: 1,
      initialBatchTickets: [99],
    };
    const items = [
      { number: 99, title: "old", fields: { Status: "Done" } },
      ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({ number: n, title: `r${n}`, fields: { Status: "Ready" } })),
      ...[8, 9, 10].map((n) => ({ number: n, title: `q${n}`, fields: { Status: "Questions" } })),
    ];
    const bodies = Object.fromEntries(items.map((it) => [String(it.number), "no deps"]));
    const s = ingestBoardItems(prev, items, bodies, { humanNeededPercent: 30 });
    expect(s.initialReadyCount).toBe(7); // the 7 Ready committed, not counting the 3 parked Questions
    const hn = humanNeededStatus(s);
    expect(hn.questions).toBe(3);
    expect(hn.tripped).toBe(true); // 3/7 = 42.8% > 30, identical to the pre-#133 Building-count result
  });

  test("AC9: a mid-batch re-ingest (prev has a live lane) preserves initialReadyCount/humanNeededNotified unchanged", () => {
    const prev: LoopState = {
      tickets: [ticket(5, "QA"), ticket(7, "Building")],
      lanes: [lane(5, "qa")],
      maxLanes: 3,
      watchdogMinutes: 10,
      initialReadyCount: 7,
      humanNeededNotified: true,
    };
    const items = [
      { number: 5, title: "A", fields: { Status: "QA" } },
      { number: 7, title: "B", fields: { Status: "Building" } },
    ];
    const bodies = { "5": "no deps", "7": "no deps" };
    const s = ingestBoardItems(prev, items, bodies);
    expect(s.initialReadyCount).toBe(7); // preserved, not recomputed
    expect(s.humanNeededNotified).toBe(true); // preserved
  });

  test("AC10: a re-ingest after the prior batch fully drained resets initialReadyCount/humanNeededNotified (drainComplete is the boundary)", () => {
    const prev: LoopState = {
      tickets: [ticket(5, "Done"), ticket(7, "Blocked")],
      lanes: [],
      maxLanes: 3,
      watchdogMinutes: 10,
      initialReadyCount: 7,
      humanNeededNotified: true,
    };
    expect(drainComplete(prev.tickets, prev.lanes)).toBe(true); // sanity: prev IS fully drained
    const items = [
      { number: 10, title: "New1", fields: { Status: "Ready" } },
      { number: 11, title: "New2", fields: { Status: "Ready" } },
    ];
    const bodies = { "10": "no deps", "11": "no deps" };
    const s = ingestBoardItems(prev, items, bodies);
    expect(s.initialReadyCount).toBe(2); // recomputed from the NEW batch's Ready count, not the stale 7
    expect(s.humanNeededNotified).toBe(false); // reset
  });

  // -- issue #119: mergedThisRun resets at the same startingFreshBatch boundary
  // as initialReadyCount/humanNeededNotified. Before this fix mergedThisRun
  // carried forward unconditionally (lib/loop.ts:793 used to be
  // `[...(prev?.mergedThisRun ?? [])]` with no fresh-batch branch), so a merge
  // from batches ago stayed visible to the merge gate's runParents check
  // forever, since state.json is never deleted between /z-loop invocations.
  test("issue #119 AC2: a mid-batch re-ingest (startingFreshBatch false) preserves mergedThisRun unchanged", () => {
    const prev: LoopState = {
      tickets: [ticket(5, "QA"), ticket(7, "Building")],
      lanes: [lane(5, "qa")],
      maxLanes: 3,
      watchdogMinutes: 10,
      mergedThisRun: [50],
    };
    const items = [
      { number: 5, title: "A", fields: { Status: "QA" } },
      { number: 7, title: "B", fields: { Status: "Building" } },
    ];
    const bodies = { "5": "no deps", "7": "no deps" };
    const s = ingestBoardItems(prev, items, bodies);
    expect(s.mergedThisRun).toEqual([50]); // preserved -- a merge earlier in this batch is not lost
  });

  test("issue #119 AC1: a re-ingest after the prior batch fully drained resets mergedThisRun (drainComplete + new Ready is the fresh-batch boundary)", () => {
    const prev: LoopState = {
      tickets: [ticket(5, "Done"), ticket(7, "Blocked")],
      lanes: [],
      maxLanes: 3,
      watchdogMinutes: 10,
      mergedThisRun: [50],
    };
    expect(drainComplete(prev.tickets, prev.lanes)).toBe(true); // sanity: prev IS fully drained
    const items = [
      { number: 200, title: "New", fields: { Status: "Ready" } },
    ];
    const bodies = { "200": "Depends on: #50" };
    const s = ingestBoardItems(prev, items, bodies);
    expect(s.mergedThisRun).toEqual([]); // reset, not [50] -- #50 merged batches ago and has no branch left
  });

  // Regression (issue #63 review bounce, ticket #63): AC9/AC10 above only ever
  // drove ingestBoardItems against hand-authored `prev` fixtures. The real
  // production sequence is ingest -> applyAction (park/skip/complete) ->
  // ingest, and applyAction updates a terminal ticket's status AND drops its
  // lane in the SAME state write. So the tick that resolves a batch's LAST
  // ticket already leaves that written state drainComplete -- and the very
  // NEXT ingest (which just re-observes that same finished batch, having
  // committed nothing new) must NOT read as "a fresh batch", or it silently
  // wipes initialReadyCount/humanNeededNotified for the crossing that just
  // happened on that final ticket -- the control's highest-value case, since a
  // trip with no live lane left to report it is easy to miss otherwise.
  test("regression: final-tick confirmation preserves counters (real ingest -> applyAction -> ingest chain, not a hand-built prev)", () => {
    const bodies = { "1": "no deps", "2": "no deps", "3": "no deps" };
    const items1 = [
      { number: 1, title: "a", fields: { Status: "Ready" } },
      { number: 2, title: "b", fields: { Status: "Ready" } },
      { number: 3, title: "c", fields: { Status: "Ready" } },
    ];
    let s = ingestBoardItems(null, items1, bodies, { humanNeededPercent: 30 });
    s.lanes = [lane(1, "builder"), lane(2, "builder"), lane(3, "builder")];
    expect(s.initialReadyCount).toBe(3);

    // #2 parks Blocked; #3 completes Done. Only #1's lane remains -- the LAST
    // ticket of the whole batch still being worked.
    s = ingestBoardItems(s, [
      { number: 1, title: "a", fields: { Status: "Building" } },
      { number: 2, title: "b", fields: { Status: "Blocked" } },
      { number: 3, title: "c", fields: { Status: "Done" } },
    ], bodies);
    s.lanes = [lane(1, "builder")];
    expect(s.initialReadyCount).toBe(3); // preserved through the mid-batch re-ingest (AC9's case)

    // #1 -- the batch's final ticket -- gets skipped (watchdog: dead worker).
    // This crosses (1 Blocked + 1 Skipped) / 3 = 66.7% > 30% for the FIRST
    // time, applied through the REAL reducer (park/lane-drop in one write).
    s = applyAction(s, { kind: "skip", ticket: 1, note: "Worker died mid-build" }, 5000);
    expect(drainComplete(s.tickets, s.lanes)).toBe(true); // this state IS the next tick's `prev`

    // Next tick: a fresh board snapshot just confirms #1 is now Skipped too --
    // nothing new committed to Ready. The bug reset initialReadyCount to 0
    // here (recomputed from an all-terminal snapshot) and humanNeededNotified
    // to false, which by itself looks harmless, but initialReadyCount=0 makes
    // humanNeededTripped's initialReady<=0 guard force tripped=false forever.
    s = ingestBoardItems(s, [
      { number: 1, title: "a", fields: { Status: "Skipped" } },
      { number: 2, title: "b", fields: { Status: "Blocked" } },
      { number: 3, title: "c", fields: { Status: "Done" } },
    ], bodies);
    expect(s.initialReadyCount).toBe(3); // preserved, NOT reset to 0
    expect(s.humanNeededNotified).toBe(false); // preserved (never yet acked)
    const hn = humanNeededStatus(s);
    expect(hn.tripped).toBe(true); // (1 blocked + 1 skipped) / 3 = 66.7% > 30%
    expect(hn.blocked).toBe(1);
    expect(hn.skipped).toBe(1);
    expect(hn.initialReadyCount).toBe(3);
  });

  test("regression: fire-once flag survives a same-batch confirmation re-ingest, resets only for a genuinely new batch", () => {
    const bodies = { "1": "no deps" };
    let s = ingestBoardItems(null, [{ number: 1, title: "a", fields: { Status: "Ready" } }], bodies, { humanNeededPercent: 30 });
    s.lanes = [lane(1, "builder")];
    s = applyAction(s, { kind: "skip", ticket: 1, note: "dead" }, 1000);
    expect(drainComplete(s.tickets, s.lanes)).toBe(true);
    s = ingestBoardItems(s, [{ number: 1, title: "a", fields: { Status: "Skipped" } }], bodies);
    expect(humanNeededStatus(s).tripped).toBe(true);
    s = markHumanNeededNotified(s);

    // Another confirmation tick on the same drained batch: still no new
    // Ready tickets. Must not re-arm the control.
    s = ingestBoardItems(s, [{ number: 1, title: "a", fields: { Status: "Skipped" } }], bodies);
    expect(s.humanNeededNotified).toBe(true);
    expect(humanNeededStatus(s).alreadyNotified).toBe(true);

    // A genuinely NEW batch (fresh Ready tickets) DOES reset, even though
    // the old ticket #1 is still present in the snapshot.
    s = ingestBoardItems(s, [
      { number: 1, title: "a", fields: { Status: "Skipped" } },
      { number: 2, title: "b", fields: { Status: "Ready" } },
    ], { ...bodies, "2": "no deps" });
    expect(s.initialReadyCount).toBe(1); // only the new batch's Ready count
    expect(s.humanNeededNotified).toBe(false);
  });

  // Regression (issue #63 second review bounce), sharpened for #133: with the
  // committed queue now in Ready, drainComplete permits a claimedByOther ticket
  // to linger in a workable status -- here *Ready* -- because it belongs to
  // another session's batch, not this one. readyCount must exclude
  // claimedByOther for the same reason buildingCount did: a lingering foreign
  // Ready ticket in the snapshot must not make startingFreshBatch wrongly true
  // on the confirmation re-ingest after THIS session's own last ticket resolved,
  // silently resetting initialReadyCount/humanNeededNotified from a ticket this
  // session never committed.
  test("regression: a claimedByOther Ready ticket does not start a fresh batch, but a new unclaimed Ready ticket does", () => {
    const bodies = { "1": "no deps", "9": "no deps" };
    const prev: LoopState = {
      tickets: [ticket(1, "Done"), ticket(9, "Ready", [], { claimedByOther: true })],
      lanes: [],
      maxLanes: 3,
      watchdogMinutes: 10,
      initialReadyCount: 5,
      humanNeededNotified: true,
    };
    // sanity: OWN batch is drained (ticket 1 terminal); #9 is another session's
    // Ready ticket, workable-but-foreign, which drainComplete explicitly permits.
    expect(drainComplete(prev.tickets, prev.lanes)).toBe(true);

    // Confirmation tick: the same foreign Ready ticket #9 is still there,
    // nothing new committed. Must NOT read as a fresh batch (readyCount excludes it).
    const same = ingestBoardItems(
      prev,
      [
        { number: 1, title: "a", fields: { Status: "Done" } },
        { number: 9, title: "z", fields: { Status: "Ready" } },
      ],
      bodies
    );
    expect(same.initialReadyCount).toBe(5); // preserved, not recomputed from the foreign ticket
    expect(same.humanNeededNotified).toBe(true); // preserved, not silently reset

    // A genuinely new batch -- an UNCLAIMED Ready ticket appears alongside
    // the still-foreign #9 -- DOES reset, same as the AC10 and fire-once-flag
    // regression tests above.
    const fresh = ingestBoardItems(
      prev,
      [
        { number: 1, title: "a", fields: { Status: "Done" } },
        { number: 9, title: "z", fields: { Status: "Ready" } },
        { number: 10, title: "New", fields: { Status: "Ready" } },
      ],
      { ...bodies, "10": "no deps" }
    );
    expect(fresh.initialReadyCount).toBe(1); // only the new UNCLAIMED Ready ticket, not the foreign #9
    expect(fresh.humanNeededNotified).toBe(false); // reset
  });

  // -- issue #150: the human-needed numerator is scoped to THIS batch --------
  test("#150 AC1: 3 pre-existing Blocked tickets from a prior drained batch do not inflate a fresh batch of 10 -- 0%, no notification", () => {
    const prev: LoopState = {
      tickets: [ticket(1, "Blocked"), ticket(2, "Blocked"), ticket(3, "Blocked")],
      lanes: [],
      maxLanes: 3,
      watchdogMinutes: 10,
      initialReadyCount: 5, // stale, from whatever batch parked these 3
      initialBatchTickets: [], // that old batch is long gone; irrelevant here
      humanNeededNotified: true,
    };
    expect(drainComplete(prev.tickets, prev.lanes)).toBe(true); // sanity: prev IS fully drained

    // The 3 old Blocked tickets are still on the board, untouched, alongside a
    // freshly-committed batch of 10 Ready tickets -- none parked yet.
    const items = [
      { number: 1, title: "old1", fields: { Status: "Blocked" } },
      { number: 2, title: "old2", fields: { Status: "Blocked" } },
      { number: 3, title: "old3", fields: { Status: "Blocked" } },
      ...[4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((n) => ({ number: n, title: `r${n}`, fields: { Status: "Ready" } })),
    ];
    const bodies = Object.fromEntries(items.map((it) => [String(it.number), "no deps"]));
    const s = ingestBoardItems(prev, items, bodies, { humanNeededPercent: 30 });
    expect(s.initialReadyCount).toBe(10); // only the new batch's 10, not the 3 old Blocked
    expect(s.initialBatchTickets).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]); // the 3 old ones excluded
    const hn = humanNeededStatus(s);
    expect(hn.blocked).toBe(0); // the pre-existing parks are ignored
    expect(hn.tripped).toBe(false);
  });

  test("#150 AC2: 3 of the batch's own 10 parking trips the control; the pre-existing parks stay excluded; fires exactly once", () => {
    const oldParked = [ticket(1, "Blocked"), ticket(2, "Blocked"), ticket(3, "Blocked")];
    const prev: LoopState = {
      tickets: oldParked,
      lanes: [],
      maxLanes: 3,
      watchdogMinutes: 10,
      initialReadyCount: 5,
      initialBatchTickets: [],
      humanNeededNotified: true,
    };
    const items1 = [
      { number: 1, title: "old1", fields: { Status: "Blocked" } },
      { number: 2, title: "old2", fields: { Status: "Blocked" } },
      { number: 3, title: "old3", fields: { Status: "Blocked" } },
      ...[4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((n) => ({ number: n, title: `r${n}`, fields: { Status: "Ready" } })),
    ];
    const bodies = Object.fromEntries(items1.map((it) => [String(it.number), "no deps"]));
    let s = ingestBoardItems(prev, items1, bodies, { humanNeededPercent: 20 }); // 3/10 = 30% > 20%, cleanly trips
    expect(s.initialReadyCount).toBe(10);
    expect(humanNeededStatus(s).tripped).toBe(false); // none of the batch's own tickets parked yet

    // 3 of the batch's own 10 park; the 3 pre-existing Blocked stay untouched.
    const items2 = [
      { number: 1, title: "old1", fields: { Status: "Blocked" } },
      { number: 2, title: "old2", fields: { Status: "Blocked" } },
      { number: 3, title: "old3", fields: { Status: "Blocked" } },
      { number: 4, title: "r4", fields: { Status: "Blocked" } },
      { number: 5, title: "r5", fields: { Status: "Skipped" } },
      { number: 6, title: "r6", fields: { Status: "Questions" } },
      ...[7, 8, 9, 10, 11, 12, 13].map((n) => ({ number: n, title: `r${n}`, fields: { Status: "Building" } })),
    ];
    s = ingestBoardItems(s, items2, bodies);
    const hn = humanNeededStatus(s);
    expect(hn.blocked).toBe(1); // only #4 -- the 2 pre-existing Blocked (#1, #2) excluded
    expect(hn.skipped).toBe(1);
    expect(hn.questions).toBe(1);
    expect(hn.tripped).toBe(true); // 3/10 = 30% > 20%

    // Fires exactly once: ack, then a same-batch confirmation re-ingest must
    // not re-trip or clear alreadyNotified.
    s = markHumanNeededNotified(s);
    expect(s.humanNeededNotified).toBe(true);
    s = ingestBoardItems(s, items2, bodies); // nothing new committed, same batch
    expect(s.humanNeededNotified).toBe(true); // preserved, not reset
    expect(humanNeededStatus(s).alreadyNotified).toBe(true);
    expect(humanNeededStatus(s).tripped).toBe(true); // still true -- alreadyNotified is what gates re-firing, not tripped
  });

  // #133 AC4's Step-1-park scenario still counts (genuinely this batch's own
  // planned tickets, just already parked at the very first observation) --
  // #150 only excludes tickets that predate the batch. #203 pins this to the
  // path Step 1 actually runs on: Step 1's board writes land BEFORE Step 3's
  // ingest, so on every run but the very first there IS a prev, and the
  // "absent from prev" clause is what catches the parked ticket. (The old
  // version of this case passed prev === null, which is not that path -- it is
  // the fresh-state path #203 fixes, where a Questions ticket is
  // indistinguishable from a pre-existing park. See the AC1/AC2 cases below.)
  test("#150/#203 regression: a Step-1 pre-commit park (prev exists, #133 AC4) still counts toward this batch's own numerator", () => {
    // The prior batch is fully drained -- 3 Done tickets, nothing workable.
    const prev: LoopState = {
      tickets: [ticket(1, "Done"), ticket(2, "Done"), ticket(3, "Done")],
      lanes: [],
      maxLanes: 3,
      watchdogMinutes: 10,
      initialReadyCount: 3,
      initialBatchTickets: [1, 2, 3],
      humanNeededNotified: true,
    };
    expect(drainComplete(prev.tickets, prev.lanes, prev.batchTickets)).toBe(true);

    // Step 1 planned 10 new tickets and parked 3 of them straight to Questions
    // before Step 3's ingest ever ran. All 10 are new to prev, so all 10 are
    // this batch's.
    const items = [
      ...[1, 2, 3].map((n) => ({ number: n, title: `old${n}`, fields: { Status: "Done" } })),
      ...[11, 12, 13, 14, 15, 16, 17].map((n) => ({ number: n, title: `r${n}`, fields: { Status: "Ready" } })),
      ...[18, 19, 20].map((n) => ({ number: n, title: `q${n}`, fields: { Status: "Questions" } })),
    ];
    const bodies = Object.fromEntries(items.map((it) => [String(it.number), "no deps"]));
    const s = ingestBoardItems(prev, items, bodies, { humanNeededPercent: 30 });
    expect(s.initialBatchTickets).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]); // all 10, including the 3 parked at Step 1
    expect(humanNeededStatus(s).questions).toBe(3);
    expect(humanNeededStatus(s).tripped).toBe(true); // 3/7 = 42.9% >= 30
  });

  // -- issue #203: a fresh state file must not swallow the whole board --------
  // The exact defect measured live: `bun lib/loop.ts human-needed
  // ~/.zstack/projects/zstack/loop/state.json` on a fresh ingest returned
  // tripped:true with initialBatchTickets holding all 174 board items against
  // an initialReadyCount of 1, because `!prevByNumber.has(n)` is true for every
  // ticket when prevByNumber is empty.
  test("#203 AC1+AC2: a fresh state (prev === null) captures only the Ready queue -- pre-existing parks do not trip the gate at tick zero", () => {
    // The board on a first run: 11 Ready (the committed queue) alongside 7
    // Blocked and 3 Skipped that predate any batch, plus unrelated Done/Backlog.
    const ready = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const items = [
      ...ready.map((n) => ({ number: n, title: `r${n}`, fields: { Status: "Ready" } })),
      ...[20, 21, 22, 23, 24, 25, 26].map((n) => ({ number: n, title: `b${n}`, fields: { Status: "Blocked" } })),
      ...[30, 31, 32].map((n) => ({ number: n, title: `s${n}`, fields: { Status: "Skipped" } })),
      { number: 40, title: "done", fields: { Status: "Done" } },
      { number: 41, title: "backlog", fields: { Status: "Backlog" } },
    ];
    const bodies = Object.fromEntries(items.map((it) => [String(it.number), "no deps"]));
    const s = ingestBoardItems(null, items, bodies, { humanNeededPercent: 30 });

    // AC2: exactly the Ready set. On main this was all 24.
    expect(s.initialBatchTickets).toEqual(ready);
    expect(s.initialReadyCount).toBe(11);

    // AC1: the numerator is 0 -- this batch parked nothing. On main: 10/11 = 90.9%.
    const hn = humanNeededStatus(s);
    expect(hn.blocked).toBe(0);
    expect(hn.skipped).toBe(0);
    expect(hn.questions).toBe(0);
    expect(hn.tripped).toBe(false);
  });

  // The two captures must agree on a fresh state: initialBatchTickets is now the
  // same Ready-and-unclaimed filter initialReadyCount already used, so the
  // numerator's scope and the denominator can no longer describe different sets.
  // (claimedByOther cannot exist here by construction -- it originates only in
  // markClaimLost and rides prev's tickets forward, so a fresh state has none.)
  test("#203: on a fresh state initialBatchTickets and initialReadyCount describe the same set", () => {
    const items = [
      ...[1, 2, 3].map((n) => ({ number: n, title: `r${n}`, fields: { Status: "Ready" } })),
      { number: 4, title: "q", fields: { Status: "Questions" } },
      { number: 5, title: "building", fields: { Status: "Building" } },
    ];
    const bodies = Object.fromEntries(items.map((it) => [String(it.number), "no deps"]));
    const s = ingestBoardItems(null, items, bodies, { humanNeededPercent: 30 });
    expect(s.initialBatchTickets).toEqual([1, 2, 3]); // not #4 (predates the batch), not #5 (not the committed queue)
    expect(s.initialBatchTickets!.length).toBe(s.initialReadyCount!);
    expect(humanNeededStatus(s).tripped).toBe(false);
  });

  test("#203 AC4: a batch that starts fresh and then parks 4 of its own 11 still trips the gate", () => {
    const ready = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const items1 = [
      ...ready.map((n) => ({ number: n, title: `r${n}`, fields: { Status: "Ready" } })),
      ...[20, 21, 22].map((n) => ({ number: n, title: `b${n}`, fields: { Status: "Blocked" } })),
    ];
    const bodies = Object.fromEntries(items1.map((it) => [String(it.number), "no deps"]));
    let s = ingestBoardItems(null, items1, bodies, { humanNeededPercent: 30 });
    expect(humanNeededStatus(s).tripped).toBe(false);

    // 4 of the batch's own 11 genuinely break down mid-run.
    const items2 = [
      ...[1, 2, 3, 4].map((n) => ({ number: n, title: `r${n}`, fields: { Status: "Blocked" } })),
      ...[5, 6, 7, 8, 9, 10, 11].map((n) => ({ number: n, title: `r${n}`, fields: { Status: "Building" } })),
      ...[20, 21, 22].map((n) => ({ number: n, title: `b${n}`, fields: { Status: "Blocked" } })),
    ];
    s = ingestBoardItems(s, items2, bodies);
    const hn = humanNeededStatus(s);
    expect(hn.blocked).toBe(4); // the batch's own 4 -- the 3 pre-existing stay out
    expect(hn.tripped).toBe(true); // 4/11 = 36.4% >= 30
  });

  // #203 AC4 (scope check): batchTickets does NOT share the defect. selectBatch
  // never consults prev -- it filters isWorkableStatus && !claimedByOther -- so
  // a fresh capture already excludes pre-existing parks. Pinned so a future
  // change to selectBatch cannot quietly introduce the same blind spot.
  test("#203: batchTickets on a fresh state already excludes pre-existing parks (selectBatch never reads prev)", () => {
    const items = [
      ...[1, 2, 3].map((n) => ({ number: n, title: `r${n}`, fields: { Status: "Ready" } })),
      { number: 4, title: "blocked", fields: { Status: "Blocked" } },
      { number: 5, title: "skipped", fields: { Status: "Skipped" } },
      { number: 6, title: "questions", fields: { Status: "Questions" } },
    ];
    const bodies = Object.fromEntries(items.map((it) => [String(it.number), "no deps"]));
    const s = ingestBoardItems(null, items, bodies, { ticketLimit: 10 });
    expect(s.batchTickets).toEqual([1, 2, 3]); // Blocked/Skipped/Questions are not workable
    expect(s.mergedThisRun).toEqual([]); // the sibling capture-once field: empty on a fresh batch
  });

  test("#150: a state file predating initialBatchTickets falls back to counting every ticket (graceful pre-feature decay)", () => {
    const s: LoopState = {
      tickets: [ticket(1, "Blocked"), ticket(2, "Ready")],
      lanes: [],
      maxLanes: 3,
      watchdogMinutes: 10,
      initialReadyCount: 4,
      // initialBatchTickets deliberately omitted -- a pre-#150 state file
    };
    const hn = humanNeededStatus(s);
    expect(hn.blocked).toBe(1); // undefined batch scope counts everything, same as before #150
  });

  test("#150: a foreign claimedByOther park is excluded from the numerator even when its number is in the batch", () => {
    const s: LoopState = {
      tickets: [ticket(1, "Blocked", [], { claimedByOther: true }), ticket(2, "Ready")],
      lanes: [],
      maxLanes: 3,
      watchdogMinutes: 10,
      initialReadyCount: 2,
      initialBatchTickets: [1, 2],
    };
    const hn = humanNeededStatus(s);
    expect(hn.blocked).toBe(0); // #1 is claimedByOther -- another session's park, not this batch's
  });
});

// -- resolveStageModel (issue #82) --------------------------------------------
// Loop run 2 billed every mechanical merge stage at the ticket's full model
// tier ($73/10 tickets); the merge spawn (gh pr create/merge, conflict check)
// never needs it. These three cases are AC1-3 verbatim.
describe("resolveStageModel", () => {
  const ALL_STAGES: Stage[] = ["builder", "qa", "reviewer", "merge"];

  // AC1: stageModels: {merge: "haiku"}, ticket Model "opus" -> merge resolves
  // "haiku"; builder/qa/reviewer resolve "opus" (the ticket Model, untouched).
  test("AC1: an explicit override wins for its stage; every other stage still resolves the ticket Model", () => {
    const stageModels = { merge: "haiku" };
    expect(resolveStageModel("merge", "opus", stageModels)).toBe("haiku");
    for (const s of ["builder", "qa", "reviewer"] as Stage[]) {
      expect(resolveStageModel(s, "opus", stageModels)).toBe("opus");
    }
  });

  // AC2: no stageModels key at all (undefined, not read from disk) -> the pack
  // default ({merge: "haiku"}) applies; every other stage resolves the ticket
  // Model.
  test("AC2: stageModels undefined (key absent) -> pack default merge->haiku, others untouched", () => {
    expect(resolveStageModel("merge", "opus", undefined)).toBe("haiku");
    for (const s of ["builder", "qa", "reviewer"] as Stage[]) {
      expect(resolveStageModel(s, "opus", undefined)).toBe("opus");
    }
  });

  // AC3: stageModels: {} (explicit opt-out) -> NO default layered on top; every
  // stage, including merge, resolves the ticket Model. This is the case that
  // distinguishes resolveStageModel from a naive "?? DEFAULT_STAGE_MODELS[stage]"
  // merge -- {} must NOT silently regain the merge->haiku default.
  test("AC3: stageModels === {} (explicit opt-out) -> no default layered on, every stage is the ticket Model", () => {
    for (const s of ALL_STAGES) {
      expect(resolveStageModel(s, "opus", {})).toBe("opus");
    }
  });

  test("a stage-specific override always wins over the pack default, even for merge", () => {
    expect(resolveStageModel("merge", "opus", { merge: "sonnet" })).toBe("sonnet");
  });
});

// -- CLI smoke ----------------------------------------------------------------

describe("loop CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "zstack-loop-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("next reads a state file and prints the Action as JSON", () => {
    const statePath = join(dir, "state.json");
    writeFileSync(statePath, JSON.stringify(state([ticket(1, "Building")])));
    const proc = Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "loop.ts"), "next", statePath, "--now", "0"], { stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString())).toEqual({ kind: "claim", ticket: 1, stage: "builder" });
  });

  // #205: `apply` prints the board move the row still owes, derived in code from
  // STATUS_FOR_STAGE, so a row that skipped its move is visible in the tick
  // output instead of living only in a SKILL row a reader can skim past.
  function runApply(name: string, s: LoopState, action: Action, subdir = ""): { exitCode: number | null; stdout: string } {
    const base = subdir ? join(dir, subdir) : dir;
    mkdirSync(base, { recursive: true });
    const statePath = join(base, `${name}-state.json`);
    const actionPath = join(base, `${name}-action.json`);
    writeFileSync(statePath, JSON.stringify(s));
    writeFileSync(actionPath, JSON.stringify(action));
    const proc = Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "loop.ts"), "apply", statePath, actionPath, "--now", "0"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ZSTACK_SLUG: "" },
    });
    return { exitCode: proc.exitCode, stdout: proc.stdout.toString() };
  }

  test("apply prints the board write an advance owes (#205)", () => {
    const s = state([ticket(1, "Building")], [lane(1, "builder", { outcome: { kind: "built" } })]);
    const { exitCode, stdout } = runApply("advance", s, { kind: "advance", ticket: 1, to: "qa" });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("applied advance #1");
    expect(stdout).toContain("board write for #1 = QA");
    expect(stdout).toContain(`"$Z_BOARD" move 1 QA --if-present`);
  });

  // The printed line has to be runnable as printed: lib/config.ts resolveSlug
  // THROWS "Multiple zstack projects configured" on a machine with more than one
  // project, which is the machine the loop runs on, so a slug-less command line
  // is dead on arrival. The slug comes from the state path the caller passed --
  // ~/.zstack/projects/<slug>/loop/state.json -- so nothing has to remember it.
  test("apply's printed board move carries --slug, derived from the state path (#205)", () => {
    const s = state([ticket(1, "Building")], [lane(1, "builder", { outcome: { kind: "built" } })]);
    const { stdout } = runApply("advance", s, { kind: "advance", ticket: 1, to: "qa" }, join(".zstack", "projects", "acme-app", "loop"));
    expect(stdout).toContain(`"$Z_BOARD" move 1 QA --if-present --slug "acme-app"`);
  });

  // The env fallback is what covers a state path that is not under
  // ~/.zstack/projects/<slug>/loop/, and it rides `slugFromStatePath`'s DEFAULT
  // `env = process.env` binding -- which every other test replaces, so nothing
  // exercised it end to end. Without this, changing that default to `{}` is
  // green across the whole suite while the real loop silently loses its slug.
  test("apply falls back to ZSTACK_SLUG when the state path names no project (#205)", () => {
    const s = state([ticket(1, "Building")], [lane(1, "builder", { outcome: { kind: "built" } })]);
    const statePath = join(dir, "envfallback-state.json");
    const actionPath = join(dir, "envfallback-action.json");
    writeFileSync(statePath, JSON.stringify(s));
    writeFileSync(actionPath, JSON.stringify({ kind: "advance", ticket: 1, to: "qa" }));
    const proc = Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "loop.ts"), "apply", statePath, actionPath, "--now", "0"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ZSTACK_SLUG: "env-slug" },
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain(`"$Z_BOARD" move 1 QA --if-present --slug "env-slug"`);
  });

  test("apply prints the owed write for a claim, and nothing for an action that owns no stage status (#205)", () => {
    const claimed = runApply("claim", state([ticket(1, "Ready")]), { kind: "claim", ticket: 1, stage: "builder" });
    expect(claimed.stdout).toContain("board write for #1 = Building");

    const parked = runApply("park", state([ticket(1, "Building")], [lane(1, "builder")]), { kind: "park", ticket: 1, status: "Questions", note: "q" });
    expect(parked.exitCode).toBe(0);
    expect(parked.stdout).not.toContain("board write for");
  });

  // -- fix 7: ingest must not treat a corrupt state as a first ingest ---------
  const ITEMS = JSON.stringify([{ number: 1, title: "x", fields: { Status: "Ready" } }]);
  const BODIES = JSON.stringify({ "1": "no deps" });

  function runIngest(statePath: string): { exitCode: number | null; stderr: string } {
    const itemsPath = join(dir, "items.json");
    const bodiesPath = join(dir, "bodies.json");
    writeFileSync(itemsPath, ITEMS);
    writeFileSync(bodiesPath, BODIES);
    const proc = Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "loop.ts"), "ingest", statePath, itemsPath, bodiesPath], { stdout: "pipe", stderr: "pipe" });
    return { exitCode: proc.exitCode, stderr: proc.stderr.toString() };
  }

  // #226: ignoring a human's board column must be visible, not silent. Same
  // stderr channel the #138 confirm notes use; stdout stays the tick's summary.
  test("ingest warns on stderr for a status the loop does not drive, and still succeeds", () => {
    const statePath = join(dir, "unknown-status-state.json");
    const itemsPath = join(dir, "unknown-items.json");
    const bodiesPath = join(dir, "unknown-bodies.json");
    writeFileSync(itemsPath, JSON.stringify([{ number: 7, title: "staged", fields: { Status: "Stage" } }]));
    writeFileSync(bodiesPath, JSON.stringify({ "7": "no deps" }));
    const proc = Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "loop.ts"), "ingest", statePath, itemsPath, bodiesPath], { stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode).toBe(0);
    expect(proc.stderr.toString()).toContain("#7");
    expect(proc.stderr.toString()).toContain("does not drive");
    expect(JSON.parse(readFileSync(statePath, "utf8")).tickets).toEqual([]);
  });

  test("ingest on a corrupt state.json exits non-zero and does NOT silently reset it", () => {
    const statePath = join(dir, "corrupt-state.json");
    const corrupt = '{ "tickets": [ {"number": 1, '; // truncated -> invalid JSON
    writeFileSync(statePath, corrupt);
    const { exitCode, stderr } = runIngest(statePath);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/not valid JSON/);
    expect(readFileSync(statePath, "utf8")).toBe(corrupt); // left untouched, never overwritten
  });

  test("ingest on a present-but-wrong-shape state.json exits non-zero, no silent reset", () => {
    const statePath = join(dir, "wrongshape-state.json");
    const wrong = JSON.stringify({ foo: 1 }); // valid JSON, not a LoopState
    writeFileSync(statePath, wrong);
    const { exitCode, stderr } = runIngest(statePath);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/not a LoopState/);
    expect(readFileSync(statePath, "utf8")).toBe(wrong);
  });

  test("ingest on a MISSING state.json is a legitimate first ingest: creates it, exit 0", () => {
    const statePath = join(dir, "fresh-state.json");
    expect(existsSync(statePath)).toBe(false);
    const { exitCode } = runIngest(statePath);
    expect(exitCode).toBe(0);
    expect(existsSync(statePath)).toBe(true);
  });

  // -- #256: the `heartbeat` verb, the ingest-boundary half of the fix ---------
  //
  // The reducer takes a number; THIS is where the number comes from, and the wire
  // it rides is the spawn tag -- a digest of slug/ticket/stage/attempt that is
  // never stored on the lane, only recomputed from it (`stageAttempt`). A test
  // that stubbed the tag would prove nothing, so these build the transcript
  // directory the harness writes and let the verb resolve it for itself.
  describe("heartbeat (#256)", () => {
    // The harness's on-disk pair for one sub-agent. `tag` present = a stage agent
    // (the orchestrator's own spawn stamps it into the prompt's first line);
    // `parent` = a descendant, exactly as lib/transcripts.ts walks them.
    function writeAgent(subagentsDir: string, id: string, opts: { tag?: string; parent?: string; at?: string }): void {
      const first = JSON.stringify({
        type: "user",
        agentId: id,
        message: { role: "user", content: opts.tag === undefined ? `a prompt for ${id}` : `prompt\n${SPAWN_TAG_MARKER} ${opts.tag}\n` },
      });
      const lines = [first];
      if (opts.at !== undefined) {
        lines.push(JSON.stringify({ type: "assistant", agentId: id, message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash", input: {} }] }, timestamp: opts.at }));
      }
      writeFileSync(join(subagentsDir, `agent-${id}.jsonl`), lines.join("\n") + "\n");
      writeFileSync(
        join(subagentsDir, `agent-${id}.meta.json`),
        JSON.stringify({ agentType: "general-purpose", description: id, spawnDepth: opts.parent === undefined ? 1 : 2, ...(opts.parent === undefined ? {} : { parentAgentId: opts.parent }) })
      );
    }

    // --now is passed explicitly: the verb clamps observations to the clock
    // (clampToNow), so a test that let it read the wall clock would pass or fail
    // depending on the hour its fixture timestamps landed on.
    function runHeartbeat(statePath: string, subagentsDir: string, nowMs: number): { exitCode: number | null; stdout: string; stderr: string } {
      const proc = Bun.spawnSync(
        ["bun", join(REPO_ROOT, "lib", "loop.ts"), "heartbeat", statePath, "--slug", "demo", "--subagents-dir", subagentsDir, "--now", String(nowMs)],
        { stdout: "pipe", stderr: "pipe" }
      );
      return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
    }

    function lanesOf(statePath: string): LaneState[] {
      return (JSON.parse(readFileSync(statePath, "utf8")) as LoopState).lanes;
    }

    test("moves the baseline to the subtree's newest append, and the lane stops being probed", () => {
      const subagents = mkdtempSync(join(tmpdir(), "zstack-heartbeat-"));
      const statePath = join(dir, "heartbeat-state.json");
      const appended = Date.parse("2026-08-04T12:00:00.000Z");
      // The lane is 25 minutes into QA, i.e. long past the budget on stage age.
      const now = appended + 30_000;
      const s = state([ticket(1, "QA")], [lane(1, "qa", { lastActivityMs: now - 25 * 60_000 })]);
      writeFileSync(statePath, JSON.stringify(s));
      // attempt 1 for a lane with no bounces: the tag of the spawn running RIGHT NOW.
      writeAgent(subagents, "q1", { tag: spawnTag("demo", 1, "qa", 1) });
      writeAgent(subagents, "k1", { parent: "q1", at: new Date(appended).toISOString() });
      const { exitCode, stdout } = runHeartbeat(statePath, subagents, now);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("#1 qa last append");
      expect(lanesOf(statePath)[0].lastActivityMs).toBe(appended);
      // End to end: `next` no longer reaches for the worker.
      const proc = Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "loop.ts"), "next", statePath, "--now", String(now)], { stdout: "pipe", stderr: "pipe" });
      expect(JSON.parse(proc.stdout.toString())).toEqual({ kind: "wait" });
      rmSync(subagents, { recursive: true, force: true });
    });

    // The attempt is half the tag, and it MOVES: a QA bounce spawns a fresh agent
    // under a new tag. Reading the previous attempt's transcript would keep
    // vouching for a stage that no longer exists -- so the verb must recompute it
    // from the lane (stageAttempt), and this is what catches a hardcoded 1.
    test("reads the CURRENT attempt's subtree, not the first one's", () => {
      const subagents = mkdtempSync(join(tmpdir(), "zstack-heartbeat-attempt-"));
      const statePath = join(dir, "heartbeat-attempt-state.json");
      const dead = Date.parse("2026-08-04T12:00:00.000Z"); // attempt 1's last word
      const alive = dead + 10 * 60_000; // attempt 2, still writing
      const s = state([ticket(1, "QA")], [lane(1, "qa", { lastActivityMs: 0, qaBounces: 1 })]);
      writeFileSync(statePath, JSON.stringify(s));
      writeAgent(subagents, "old", { tag: spawnTag("demo", 1, "qa", 1), at: new Date(dead).toISOString() });
      writeAgent(subagents, "new", { tag: spawnTag("demo", 1, "qa", 2), at: new Date(alive).toISOString() });
      expect(runHeartbeat(statePath, subagents, alive + 60_000).exitCode).toBe(0);
      expect(lanesOf(statePath)[0].lastActivityMs).toBe(alive);
      rmSync(subagents, { recursive: true, force: true });
    });

    // Fail-open at the boundary, which is where a drain would actually die: an
    // unresolvable subtree must cost the lane nothing and the tick nothing.
    test("an unresolvable subtree leaves every lane exactly as it was, exit 0", () => {
      const subagents = mkdtempSync(join(tmpdir(), "zstack-heartbeat-open-"));
      const statePath = join(dir, "heartbeat-open-state.json");
      const before = state([ticket(1, "QA")], [lane(1, "qa", { lastActivityMs: 7 })]);
      writeFileSync(statePath, JSON.stringify(before));
      const NOW = Date.parse("2026-08-04T12:00:00.000Z");
      const { exitCode, stdout } = runHeartbeat(statePath, subagents, NOW); // empty dir: no agent carries the tag
      expect(exitCode).toBe(0);
      expect(stdout).toContain("no subtree observed");
      expect(lanesOf(statePath)).toEqual(before.lanes);
      // ...and a directory that does not exist at all is the same answer, loudly.
      const missing = runHeartbeat(statePath, join(subagents, "never-created"), NOW);
      expect(missing.exitCode).toBe(0);
      expect(missing.stderr).toContain("every lane keeps its current watchdog baseline");
      expect(lanesOf(statePath)).toEqual(before.lanes);
      rmSync(subagents, { recursive: true, force: true });
    });

    // A machine's clock moves -- an NTP correction or a suspend/resume can leave
    // a transcript record dated ahead of `now`. Unclipped, that lands in
    // lastActivityMs, `nowMs - lastActivityMs` goes NEGATIVE, and the watchdog is
    // silently OFF for that lane for the length of the skew: the exact failure
    // #256 removes, reintroduced through its own fix.
    test("an observation dated in the future is clipped to the clock, never past it", () => {
      const subagents = mkdtempSync(join(tmpdir(), "zstack-heartbeat-skew-"));
      const statePath = join(dir, "heartbeat-skew-state.json");
      const now = Date.parse("2026-08-04T12:00:00.000Z");
      const s = state([ticket(1, "QA")], [lane(1, "qa", { lastActivityMs: now - 30 * 60_000 })]);
      writeFileSync(statePath, JSON.stringify(s));
      writeAgent(subagents, "q1", { tag: spawnTag("demo", 1, "qa", 1), at: new Date(now + 3 * 60 * 60_000).toISOString() });
      expect(runHeartbeat(statePath, subagents, now).exitCode).toBe(0);
      expect(lanesOf(statePath)[0].lastActivityMs).toBe(now); // clipped, not now+3h
      // ...so the lane is still watchdog-eligible on its own budget rather than
      // being immune for three hours.
      const proc = Bun.spawnSync(
        ["bun", join(REPO_ROOT, "lib", "loop.ts"), "next", statePath, "--now", String(now + 11 * 60_000)],
        { stdout: "pipe", stderr: "pipe" }
      );
      expect(JSON.parse(proc.stdout.toString())).toEqual({ kind: "check-worker", ticket: 1 });
      rmSync(subagents, { recursive: true, force: true });
    });

    // bin/z-loop-tick's wiring, pinned where it can rot: the observation is
    // worthless unless it lands between the ingest that settles the lane list and
    // the `next` that reads the baseline.
    test("bin/z-loop-tick runs the heartbeat after the ingest and before next", () => {
      const tick = readFileSync(join(REPO_ROOT, "bin", "z-loop-tick"), "utf8");
      const at = (s: string) => tick.indexOf(s);
      expect(at(`loop.ts" heartbeat "$STATE"`)).toBeGreaterThan(-1);
      expect(at(`loop.ts" heartbeat "$STATE"`)).toBeGreaterThan(at(`loop.ts" ingest "$STATE"`));
      expect(at(`loop.ts" heartbeat "$STATE"`)).toBeLessThan(at(`loop.ts" next "$STATE"`));
      // Never aborts the tick: a transcript-dir hiccup must not wedge a drain.
      expect(tick).toContain(`heartbeat "$STATE" --slug "$SLUG" --project-dir "$PWD" >/dev/null || true`);
    });
  });

  // -- #256: --watchdog-minutes carries both shapes across the CLI edge --------
  //
  // z-loop/SKILL.md Step 3 passes whatever loadConfig resolved, JSON-stringified.
  // If the flag could only parse a number, every project on the per-stage table
  // would ingest NaN -- which compares false in `nowMs - base > NaN`, silently
  // disabling the watchdog for the whole run.
  describe("ingest --watchdog-minutes (#256)", () => {
    const items = join(dir, "wd-items.json");
    const bodies = join(dir, "wd-bodies.json");

    function runIngestWith(statePath: string, value: string): { exitCode: number | null; stderr: string } {
      writeFileSync(items, JSON.stringify([{ number: 1, title: "T", fields: { Status: "Ready" } }]));
      writeFileSync(bodies, JSON.stringify({ "1": "no deps" }));
      const proc = Bun.spawnSync(
        ["bun", join(REPO_ROOT, "lib", "loop.ts"), "ingest", statePath, items, bodies, "--watchdog-minutes", value],
        { stdout: "pipe", stderr: "pipe" }
      );
      return { exitCode: proc.exitCode, stderr: proc.stderr.toString() };
    }

    test("a per-stage JSON object survives the flag and lands in state", () => {
      const statePath = join(dir, "wd-object-state.json");
      const { exitCode } = runIngestWith(statePath, '{"builder":25,"qa":15,"reviewer":40,"merge":15}');
      expect(exitCode).toBe(0);
      expect((JSON.parse(readFileSync(statePath, "utf8")) as LoopState).watchdogMinutes).toEqual({
        builder: 25, qa: 15, reviewer: 40, merge: 15,
      });
    });

    test("a bare number still lands as a number", () => {
      const statePath = join(dir, "wd-scalar-state.json");
      expect(runIngestWith(statePath, "10").exitCode).toBe(0);
      expect((JSON.parse(readFileSync(statePath, "utf8")) as LoopState).watchdogMinutes).toBe(10);
    });

    // The flag validates through the SAME function config.json does, so a typo'd
    // stage cannot enter state by the back door -- and it fails at ingest, before
    // any agent is spawned, rather than at the first watchdog decision.
    test("a typo'd stage or a broken object is refused at the CLI edge", () => {
      const statePath = join(dir, "wd-bad-state.json");
      const typo = runIngestWith(statePath, '{"QA":20}');
      expect(typo.exitCode).toBe(1);
      expect(typo.stderr).toMatch(/is not a known stage/);
      const broken = runIngestWith(statePath, '{"qa":');
      expect(broken.exitCode).toBe(1);
      expect(broken.stderr).toMatch(/looks like JSON but does not parse/);
      const zero = runIngestWith(statePath, "0");
      expect(zero.exitCode).toBe(1);
      expect(zero.stderr).toMatch(/must be a positive number/);
      // NaN was the silent failure this parser exists to stop: it must never
      // become a state file.
      expect(existsSync(statePath)).toBe(false);
    });
  });

  // -- AC13: `human-needed` / `human-needed-ack` CLI verbs ---------------------
  test("human-needed prints the breakdown without writing, matching AC6's shape", () => {
    const statePath = join(dir, "human-needed-state.json");
    const s = state(
      [ticket(1, "Blocked"), ticket(2, "Blocked"), ticket(3, "Skipped"), ticket(4, "Questions")],
      []
    );
    s.initialReadyCount = 10;
    s.humanNeededPercent = 30;
    writeFileSync(statePath, JSON.stringify(s));
    const before = readFileSync(statePath, "utf8");

    const proc = Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "loop.ts"), "human-needed", statePath], { stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode).toBe(0);
    const status = JSON.parse(proc.stdout.toString());
    expect(status).toMatchObject({
      tripped: true,
      alreadyNotified: false,
      blocked: 2,
      skipped: 1,
      questions: 1,
      initialReadyCount: 10,
      percent: 30,
      tickets: { blocked: [1, 2], skipped: [3], questions: [4] },
    });
    // no writes: state.json is byte-identical after a `human-needed` call.
    expect(readFileSync(statePath, "utf8")).toBe(before);

    // human-needed-ack sets alreadyNotified on the next human-needed call.
    const ack = Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "loop.ts"), "human-needed-ack", statePath], { stdout: "pipe", stderr: "pipe" });
    expect(ack.exitCode).toBe(0);
    const proc2 = Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "loop.ts"), "human-needed", statePath], { stdout: "pipe", stderr: "pipe" });
    expect(proc2.exitCode).toBe(0);
    expect(JSON.parse(proc2.stdout.toString())).toMatchObject({ tripped: true, alreadyNotified: true });
  });

  // -- #223: `claim-confirmed` CLI verb ---------------------------------------
  describe("claim-confirmed", () => {
    function runConfirm(statePath: string, assigneesJson: string, extra: string[] = ["--me", "me"]) {
      const aPath = join(dir, "assignees.json");
      writeFileSync(aPath, assigneesJson);
      const proc = Bun.spawnSync(
        ["bun", join(REPO_ROOT, "lib", "loop.ts"), "claim-confirmed", statePath, "1", "--assignees", aPath, "--now", "5000", ...extra],
        { stdout: "pipe", stderr: "pipe" }
      );
      return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
    }

    function flaggedState(name: string): string {
      const statePath = join(dir, name);
      const s = state([ticket(1, "Ready", [], { claimedByOther: true, claimedByOtherAt: 0, claimConfirmingSince: 0 })]);
      writeFileSync(statePath, JSON.stringify(s));
      return statePath;
    }

    test("an unassigned read clears the flag and the next `next` claims the ticket", () => {
      const statePath = flaggedState("confirm-empty.json");
      const { exitCode, stdout } = runConfirm(statePath, JSON.stringify({ number: 1, assignees: [] }));
      expect(exitCode).toBe(0);
      expect(stdout).toContain("claimable again");
      expect(JSON.parse(readFileSync(statePath, "utf8")).tickets[0].claimedByOther).toBeUndefined();
      const next = Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "loop.ts"), "next", statePath, "--now", "5000"], { stdout: "pipe", stderr: "pipe" });
      expect(JSON.parse(next.stdout.toString())).toEqual({ kind: "claim", ticket: 1, stage: "builder" });
    });

    test("a foreign read keeps the flag, records the login, and re-stamps the clock", () => {
      const statePath = flaggedState("confirm-foreign.json");
      const { exitCode, stdout } = runConfirm(statePath, JSON.stringify({ number: 1, assignees: ["someone-else"] }));
      expect(exitCode).toBe(0);
      expect(stdout).toContain("someone-else");
      expect(JSON.parse(readFileSync(statePath, "utf8")).tickets[0]).toMatchObject({
        claimedByOther: true,
        claimedByOtherAt: 5000,
        claimConfirmingSince: 0,
        claimedByOtherLogin: "someone-else",
      });
    });

    test("an unreadable assignee file exits 1 and leaves the flag alone (never reads as unassigned)", () => {
      const statePath = flaggedState("confirm-garbage.json");
      const before = readFileSync(statePath, "utf8");
      const { exitCode, stderr } = runConfirm(statePath, JSON.stringify({ oops: true }));
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/Refusing to read it as "unassigned"/);
      expect(readFileSync(statePath, "utf8")).toBe(before);
    });

    // The trust boundary's readable-but-WRONG half. The orchestrator row writes
    // `z-board assignees <N>` to a file and then re-types <N> in this command, so
    // a transposed pair applies one ticket's live assignee set to another -- and
    // an EMPTY set for the wrong ticket clears a live foreign claim exactly as a
    // misparse would, handing another session's in-flight ticket to this run on
    // the very next tick.
    test("an assignee file for a DIFFERENT ticket exits 1 and never clears the flag", () => {
      const statePath = flaggedState("confirm-wrong-ticket.json");
      writeFileSync(statePath, JSON.stringify(state([ticket(1, "Ready", [], { claimedByOther: true, claimedByOtherAt: 0, claimConfirmingSince: 0, claimedByOtherLogin: "someone-else" })])));
      const before = readFileSync(statePath, "utf8");
      const { exitCode, stderr } = runConfirm(statePath, JSON.stringify({ number: 999, assignees: [] }));
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/for #999 but it is being applied to #1/);
      expect(readFileSync(statePath, "utf8")).toBe(before);
      const next = Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "loop.ts"), "next", statePath, "--now", "5000"], { stdout: "pipe", stderr: "pipe" });
      expect(JSON.parse(next.stdout.toString()).kind).not.toBe("claim");
    });

    // The mirror: applying a read to a ticket nobody flagged must not INVENT the
    // flag. The attempt recorder has always guarded this; claimConfirmed now does
    // too. Otherwise one transposed number both steals a claim and freezes a
    // different workable ticket out of the batch.
    test("a read applied to an UNFLAGGED ticket changes nothing and says so", () => {
      const statePath = join(dir, "confirm-unflagged.json");
      writeFileSync(statePath, JSON.stringify(state([ticket(1, "Ready")])));
      const { exitCode, stdout } = runConfirm(statePath, JSON.stringify({ number: 1, assignees: ["someone-else"] }));
      expect(exitCode).toBe(0);
      expect(stdout).toContain("nothing to confirm");
      const after = JSON.parse(readFileSync(statePath, "utf8")).tickets[0];
      for (const k of ["claimedByOther", "claimedByOtherAt", "claimConfirmingSince", "claimedByOtherLogin"]) {
        expect(Object.keys(after)).not.toContain(k);
      }
      const next = Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "loop.ts"), "next", statePath, "--now", "5000"], { stdout: "pipe", stderr: "pipe" });
      expect(JSON.parse(next.stdout.toString())).toEqual({ kind: "claim", ticket: 1, stage: "builder" });
    });

    test("--me is required: without this loop's login there is no way to judge the set", () => {
      const statePath = flaggedState("confirm-nome.json");
      const before = readFileSync(statePath, "utf8");
      const { exitCode, stderr } = runConfirm(statePath, JSON.stringify({ assignees: [] }), []);
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/--me/);
      expect(readFileSync(statePath, "utf8")).toBe(before);
    });

    test("--assignees is required: without a read there is nothing to fold back", () => {
      const statePath = flaggedState("confirm-noassignees.json");
      const before = readFileSync(statePath, "utf8");
      const proc = Bun.spawnSync(
        ["bun", join(REPO_ROOT, "lib", "loop.ts"), "claim-confirmed", statePath, "1", "--me", "me", "--now", "5000"],
        { stdout: "pipe", stderr: "pipe" }
      );
      expect(proc.exitCode).toBe(1);
      expect(proc.stderr.toString()).toMatch(/--assignees/);
      expect(readFileSync(statePath, "utf8")).toBe(before);
    });

    test("claim-confirm-failed on an UNFLAGGED ticket says so instead of reporting a write", () => {
      // It takes its ticket from prose with no file to cross-check against, so a
      // mistyped number is a real input. "attempt recorded" on the wrong number
      // is what would let an operator believe a bound is running.
      const statePath = join(dir, "confirm-failed-wrong.json");
      writeFileSync(
        statePath,
        JSON.stringify(state([ticket(1, "Ready", [], { claimedByOther: true, claimedByOtherAt: 0, claimConfirmingSince: 0 }), ticket(2, "Ready")]))
      );
      const proc = Bun.spawnSync(
        ["bun", join(REPO_ROOT, "lib", "loop.ts"), "claim-confirm-failed", statePath, "2", "--now", "5000"],
        { stdout: "pipe", stderr: "pipe" }
      );
      expect(proc.exitCode).toBe(0);
      expect(proc.stdout.toString()).toMatch(/not flagged claimedByOther.*check the ticket number/s);
    });

    // The failed-read half of the orchestrator row: no assignee file exists to
    // fold back, so it takes no --assignees and no --me. It must never be able
    // to CLEAR anything -- it only stamps the attempt.
    test("claim-confirm-failed records the attempt and leaves the flag standing", () => {
      const statePath = flaggedState("confirm-failed.json");
      const proc = Bun.spawnSync(
        ["bun", join(REPO_ROOT, "lib", "loop.ts"), "claim-confirm-failed", statePath, "1", "--now", "5000"],
        { stdout: "pipe", stderr: "pipe" }
      );
      expect(proc.exitCode).toBe(0);
      expect(proc.stdout.toString()).toContain("attempt recorded");
      expect(JSON.parse(readFileSync(statePath, "utf8")).tickets[0]).toMatchObject({
        claimedByOther: true,
        claimedByOtherAt: 5000, // the throttle moved
        claimConfirmingSince: 0, // the bound's anchor did not
      });
    });

    // #223 QA pass 2, the exact CLI repro. A claim lost long before the drain
    // first goes idle must still be ASKED about. Pass 1 anchored the bounded park
    // on a stamp markClaimLost wrote, so this sequence parked #102 Blocked having
    // spent zero reads -- the run-12 shape the ticket exists to remove, merely
    // relabelled from a state.json hand-edit to a board move.
    test("a claim lost long before the drain goes idle is confirmed, not parked unread", () => {
      const statePath = join(dir, "late-idle.json");
      writeFileSync(statePath, JSON.stringify(state([ticket(101, "Ready"), ticket(102, "Ready", [101]), ticket(103, "Done")])));
      const lost = Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "loop.ts"), "claim-lost", statePath, "101", "--now", "1000000"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(lost.exitCode).toBe(0);
      // 35 minutes later (watchdogMinutes 10, so already past the wd*3 bound), lanes idle.
      const next = Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "loop.ts"), "next", statePath, "--now", "3100000"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(JSON.parse(next.stdout.toString())).toEqual({ kind: "confirm-claim", ticket: 101 });
    });

    test("claim-confirm-failed without a ticket number exits 1 and writes nothing", () => {
      const statePath = flaggedState("confirm-failed-bad.json");
      const before = readFileSync(statePath, "utf8");
      const proc = Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "loop.ts"), "claim-confirm-failed", statePath], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode).toBe(1);
      expect(readFileSync(statePath, "utf8")).toBe(before);
    });
  });

  // -- #177: a BUILDER outcome may not be recorded without its git facts ------
  // The pure recordOutcome treats them as optional (a pre-#177 state file must
  // still load); this CLI edge is what makes the guard impossible to omit, the
  // same fail-loud-on-tick-1 reasoning as z-loop-tick's required --session (#198).
  describe("outcome (#177 builder verification)", () => {
    const BASE = "1111111111111111111111111111111111111111";
    const HEAD = "2222222222222222222222222222222222222222";

    function runOutcome(statePath: string, message: string, extra: string[]) {
      const msgPath = join(dir, "outcome-msg.txt");
      writeFileSync(msgPath, message);
      const proc = Bun.spawnSync(
        ["bun", join(REPO_ROOT, "lib", "loop.ts"), "outcome", statePath, "1", msgPath, "--now", "0", ...extra],
        { stdout: "pipe", stderr: "pipe" }
      );
      return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
    }

    function porcelainFile(name: string, content: string): string {
      const p = join(dir, name);
      writeFileSync(p, content);
      return p;
    }

    test("a builder lane with no git facts exits 1 and leaves the state untouched", () => {
      const statePath = join(dir, "outcome-nofacts.json");
      const before = JSON.stringify(state([ticket(1, "Building")], [lane(1, "builder")]));
      writeFileSync(statePath, before);
      const r = runOutcome(statePath, "BUILT: all criteria pass\n", []);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("git facts");
      expect(r.stderr).toContain("--porcelain");
      expect(readFileSync(statePath, "utf8")).toBe(before); // no outcome recorded
    });

    test("a partial set of facts is refused too (all three or none)", () => {
      const statePath = join(dir, "outcome-partial.json");
      writeFileSync(statePath, JSON.stringify(state([ticket(1, "Building")], [lane(1, "builder")])));
      const r = runOutcome(statePath, "BUILT: x\n", ["--head-sha", HEAD, "--base-sha", BASE]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("git facts");
    });

    test("dirty + no commit records the unverified reason; clean + moved records a plain built", () => {
      const statePath = join(dir, "outcome-dirty.json");
      writeFileSync(statePath, JSON.stringify(state([ticket(1, "Building")], [lane(1, "builder")])));
      const dirty = runOutcome(statePath, "BUILT: done\n", [
        "--porcelain", porcelainFile("porcelain-dirty.txt", "## z/ticket-1\n M lib/loop.ts\n?? tests/new.test.ts\n"),
        "--head-sha", BASE, "--base-sha", BASE,
      ]);
      expect(dirty.exitCode).toBe(0);
      const outcome = JSON.parse(dirty.stdout) as { kind: string; unverified?: string };
      expect(outcome.kind).toBe("built");
      expect(outcome.unverified).toContain("uncommitted work");
      // And the same command on a clean, moved worktree records no reason at all.
      const cleanPath = join(dir, "outcome-clean.json");
      writeFileSync(cleanPath, JSON.stringify(state([ticket(1, "Building")], [lane(1, "builder")])));
      const clean = runOutcome(cleanPath, "BUILT: done\n", [
        "--porcelain", porcelainFile("porcelain-clean.txt", "## z/ticket-1...origin/main\n"),
        "--head-sha", HEAD, "--base-sha", BASE,
      ]);
      expect(clean.exitCode).toBe(0);
      expect(JSON.parse(clean.stdout)).toEqual({ kind: "built" });
    });

    // The redirect that collects the facts creates the file BEFORE git runs, so a
    // `git status` that FAILED hands the CLI an existing, empty file -- the one
    // shape a missing-file check (ENOENT -> exit 1) cannot catch. With a moved HEAD
    // it used to read as a clean tree and walk to QA.
    test("an empty porcelain file (a git status that failed) is held, not read as clean", () => {
      const statePath = join(dir, "outcome-emptyporcelain.json");
      writeFileSync(statePath, JSON.stringify(state([ticket(1, "Building")], [lane(1, "builder")])));
      const r = runOutcome(statePath, "BUILT: done\n", [
        "--porcelain", porcelainFile("porcelain-empty.txt", ""),
        "--head-sha", HEAD, "--base-sha", BASE,
      ]);
      expect(r.exitCode).toBe(0);
      const outcome = JSON.parse(r.stdout) as { kind: string; unverified?: string };
      expect(outcome.unverified).toContain("header is missing");
    });

    test("a non-builder lane still records with no facts (the dead-merge PR-state path)", () => {
      const statePath = join(dir, "outcome-merge.json");
      writeFileSync(statePath, JSON.stringify(state([ticket(1, "Review")], [lane(1, "merge")])));
      const r = runOutcome(statePath, "MERGED: https://github.com/x/y/pull/1\n", []);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ kind: "merged", note: "https://github.com/x/y/pull/1" });
    });
  });

  // -- #209: the probe carries the worktree facts, and attempt is computed -----
  describe("probe --porcelain / attempt (#209)", () => {
    function run(args: string[]) {
      const proc = Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "loop.ts"), ...args], { stdout: "pipe", stderr: "pipe" });
      return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
    }

    test("a dead probe with a dirty worktree records the fact, and next returns respawn", () => {
      const statePath = join(dir, "probe-dirty.json");
      writeFileSync(statePath, JSON.stringify(state([ticket(1, "Building")], [lane(1, "builder")])));
      const porcelain = join(dir, "probe-porcelain-dirty.txt");
      writeFileSync(porcelain, "## z/ticket-1\n M lib/cost.ts\n");
      const p = run(["probe", statePath, "1", "dead", "--porcelain", porcelain, "--now", "0"]);
      expect(p.exitCode).toBe(0);
      expect(p.stdout).toContain("uncommitted work");
      expect((JSON.parse(readFileSync(statePath, "utf8")) as LoopState).lanes[0].worktreeDirty).toBe(true);
      const next = run(["next", statePath, "--now", String(11 * 60_000)]);
      expect(JSON.parse(next.stdout)).toMatchObject({ kind: "respawn", ticket: 1, stage: "builder", attempt: 2 });
    });

    test("a dead probe with no --porcelain records no facts at all (pre-#209 behavior)", () => {
      const statePath = join(dir, "probe-nofacts.json");
      writeFileSync(statePath, JSON.stringify(state([ticket(1, "Building")], [lane(1, "builder")])));
      expect(run(["probe", statePath, "1", "dead", "--now", "0"]).exitCode).toBe(0);
      expect((JSON.parse(readFileSync(statePath, "utf8")) as LoopState).lanes[0].worktreeDirty).toBeUndefined();
      expect(JSON.parse(run(["next", statePath, "--now", String(11 * 60_000)]).stdout).kind).toBe("skip");
    });

    // The whole sequence through the real CLI: a builder dies dirty, is recovered,
    // ships, advances -- and then the QA worker dies with no status collected. The
    // builder's reading must not still be standing to buy that lane a re-spawn, and
    // the probe line must not report a worktree it never opened.
    test("the builder's reading cannot vouch for a later stage's death", () => {
      const statePath = join(dir, "probe-carryover.json");
      writeFileSync(statePath, JSON.stringify(state([ticket(1, "Building")], [lane(1, "builder")])));
      const dirty = join(dir, "carryover-dirty.txt");
      writeFileSync(dirty, "## z/ticket-1\n M lib/cost.ts\n");
      expect(run(["probe", statePath, "1", "dead", "--porcelain", dirty, "--now", "0"]).exitCode).toBe(0);

      const msg = join(dir, "carryover-msg.txt");
      writeFileSync(msg, "BUILT: shipped\n");
      const clean = join(dir, "carryover-clean.txt");
      writeFileSync(clean, "## z/ticket-1...origin/main\n");
      const out = run([
        "outcome", statePath, "1", msg, "--porcelain", clean,
        "--head-sha", "a".repeat(40), "--base-sha", "b".repeat(40), "--now", "1000",
      ]);
      expect(out.exitCode).toBe(0);
      const adv = join(dir, "carryover-advance.json");
      writeFileSync(adv, run(["next", statePath, "--now", "2000"]).stdout);
      expect(run(["apply", statePath, adv, "--now", "2000"]).exitCode).toBe(0);
      const advanced = JSON.parse(readFileSync(statePath, "utf8")) as LoopState;
      expect(advanced.lanes[0].stage).toBe("qa");
      expect(advanced.lanes[0].worktreeDirty).toBeUndefined();

      const p = run(["probe", statePath, "1", "dead", "--now", "2000"]);
      expect(p.stdout).not.toContain("uncommitted work"); // nothing was read to say that
      expect(JSON.parse(run(["next", statePath, "--now", String(12 * 60_000)]).stdout).kind).toBe("skip");
    });

    // The spawn tag's <attempt> is arithmetic over five counters; the SKILL reads
    // it from here instead of re-deriving it, so a re-spawn can never collide
    // with the transcript it replaced.
    test("attempt prints the lane's spawn count for its current stage", () => {
      const statePath = join(dir, "attempt.json");
      writeFileSync(
        statePath,
        JSON.stringify(state([ticket(1, "Building")], [lane(1, "builder", { qaBounces: 1, respawns: { builder: 1, qa: 1 } })]))
      );
      const r = run(["attempt", statePath, "1"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("3"); // qaBounces 1 + respawns.builder 1 + 1; qa's is not builder's
      const missing = run(["attempt", statePath, "99"]);
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr).toContain("No lane holds #99");
    });
  });

  // -- stage-model (issue #82): the real CLI wiring the SKILL shells out to --
  describe("stage-model", () => {
    test("prints the resolved model, reading a REAL config.json through loadConfig (not hardcoded)", () => {
      const home = mkdtempSync(join(tmpdir(), "zstack-loop-stagemodel-home-"));
      try {
        const projDir = join(home, ".zstack", "projects", "demo");
        mkdirSync(projDir, { recursive: true });
        const cfg = {
          slug: "demo",
          owner: "acme",
          repo: "demo",
          projectNumber: 1,
          projectId: "PVT_1",
          repositoryId: "R_1",
          statusField: { id: "F_status", dataType: "SINGLE_SELECT", options: { Backlog: "o1", Done: "o2" } },
          fields: {},
          stageModels: { merge: "haiku" },
        };
        writeFileSync(join(projDir, "config.json"), JSON.stringify(cfg));
        const env = { ...process.env, HOME: home, USERPROFILE: home };

        const merge = Bun.spawnSync(
          ["bun", join(REPO_ROOT, "lib", "loop.ts"), "stage-model", "merge", "opus", "--slug", "demo"],
          { stdout: "pipe", stderr: "pipe", env }
        );
        expect(merge.exitCode).toBe(0);
        expect(merge.stdout.toString().trim()).toBe("haiku");

        const builder = Bun.spawnSync(
          ["bun", join(REPO_ROOT, "lib", "loop.ts"), "stage-model", "builder", "opus", "--slug", "demo"],
          { stdout: "pipe", stderr: "pipe", env }
        );
        expect(builder.exitCode).toBe(0);
        expect(builder.stdout.toString().trim()).toBe("opus");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    test("rejects an unknown stage with a ZError: non-zero exit, message on stderr", () => {
      const proc = Bun.spawnSync(
        ["bun", join(REPO_ROOT, "lib", "loop.ts"), "stage-model", "deploy", "opus"],
        { stdout: "pipe", stderr: "pipe" }
      );
      expect(proc.exitCode).toBe(1);
      expect(proc.stderr.toString()).toMatch(/Usage: loop stage-model/);
    });
  });
});

// ============================================================================
// issue #131: per-loop ticket cap (ticketLimit / selectBatch / batch-scoped
// claim+drain) and context ceiling (contextTokenLimit gate + context-clear).
// ============================================================================

describe("selectBatch (#131 ticket cap)", () => {
  test("AC1: ticketLimit 3 over 10 no-dep tickets flags the 3 lowest; the rest stay Ready but are not claimable", () => {
    const tickets = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ticket(n, "Ready"));
    const batch = selectBatch(tickets, 3);
    expect(batch).toEqual([1, 2, 3]);
    // The other 7 remain in tickets (Ready) but are excluded from the claim set.
    const claimable = claimableTickets(tickets, [], batch);
    expect(claimable.map((t) => t.number)).toEqual([1, 2, 3]);
    // Sanity: without the allow-list all 10 are claimable (byte-identical today).
    expect(claimableTickets(tickets, []).length).toBe(10);
  });

  test("AC3: cap 2, #2 depends on #3 -- the greedy walk closes #1 + #3, never flags #2 before #3, and the batch is dependency-self-contained", () => {
    const tickets = [ticket(1, "Ready"), ticket(2, "Ready", [3]), ticket(3, "Ready")];
    const batch = selectBatch(tickets, 2);
    expect(batch).toEqual([1, 3]); // #1 (no deps) + #3 (no deps); #2 can't close within the cap
    expect(batch).not.toContain(2);
    // Dependency-self-contained: every flagged ticket's deps are Done or flagged.
    const byNum = new Map(tickets.map((t) => [t.number, t]));
    for (const n of batch!) {
      const t = byNum.get(n)!;
      expect(t.dependsOn.every((d) => batch!.includes(d) || byNum.get(d)?.status === "Done")).toBe(true);
    }
    // #2 left in Ready is NOT deadDeps-parked: its dep #3 is Ready (not terminal).
    expect(deadDeps(tickets[1], byNum)).toEqual([]);
  });

  test("ticketLimit 0 returns undefined (no allow-list, no gating)", () => {
    expect(selectBatch([ticket(1, "Ready"), ticket(2, "Ready")], 0)).toBeUndefined();
  });

  test("a dependency chain longer than the cap flags a closable prefix, never a ticket whose dep is left out", () => {
    // #1 <- #2 <- #3 (each depends on the previous), cap 2.
    const tickets = [ticket(1, "Ready"), ticket(2, "Ready", [1]), ticket(3, "Ready", [2])];
    expect(selectBatch(tickets, 2)).toEqual([1, 2]); // #3 excluded (its dep #2's chain root closes, but cap hit at 2)
  });

  // #157 (#131 review finding 2): the Kahn walk closes NOTHING when every
  // workable ticket waits on another workable ticket. It used to return an
  // empty batch, which drainComplete reads as "drained" -- a silent clean exit
  // that dropped the cycle. The stuck set is admitted instead, so nextAction's
  // deadlock break can park it (the no-cap path's behavior).
  test("#157: a cap over a fully cyclic workable set admits the stuck tickets instead of returning an empty batch", () => {
    expect(selectBatch([ticket(1, "Ready", [2]), ticket(2, "Ready", [1])], 2)).toEqual([1, 2]);
    // A 3-cycle under cap 2 admits all 3: the fallback closes the seed over its
    // workable deps (see the cap-smaller-than-the-stuck-set test below), and a
    // cycle's closure is the whole cycle. Over-admitting is free here -- none
    // of them is claimable -- and it is what keeps the capped decision equal to
    // the uncapped one.
    const three = [ticket(1, "Ready", [2]), ticket(2, "Ready", [3]), ticket(3, "Ready", [1])];
    expect(selectBatch(three, 2)).toEqual([1, 2, 3]);
    // Nothing workable -> still an empty batch: there is no stuck work to surface.
    expect(selectBatch([ticket(1, "Done")], 2)).toEqual([]);
  });

  // #157 adversarial-review finding 1, the regression the cap == stuck-set-size
  // tests above could not see. #1 -> #2 -> #3, #3 held by ANOTHER session:
  // there is no cycle, and #1's real blocker is work that will finish. A bare
  // `workable.slice(0, cap)` amputated #2 -- the only ticket holding the
  // claimedByOther dep -- and nextAction's step-6 discriminator reads only the
  // DIRECT deps of what was admitted, so cap 1 parked #1 Blocked as a
  // "dependency cycle" while cap 2 and no cap both waited. Closing the seed
  // over its workable deps is the fix: on this shape every cap now decides
  // what no cap decides.
  test("#157 finding 1: a cap SMALLER than the stuck set closes over the amputated dep, so every cap agrees with no cap", () => {
    const stuck = () => [
      ticket(1, "Ready", [2]),
      ticket(2, "Ready", [3]),
      ticket(3, "Building", [], { claimedByOther: true, claimedByOtherAt: 0 }), // stamped: this is a cap case, not a confirm-schedule case
    ];
    // #3 is another session's, so it is never workable/admitted -- but #2, the
    // ticket that HOLDS the dep on it, now is, at every cap.
    for (const cap of [1, 2, 3]) expect(selectBatch(stuck(), cap)).toEqual([1, 2]);

    // ...which is what makes the decision cap-independent, and equal to no cap.
    for (const cap of [1, 2, 3, 0]) {
      const s = state(stuck());
      s.batchTickets = selectBatch(s.tickets, cap);
      expect(nextAction(s, 0)).toEqual({ kind: "wait" }); // never a park, at any cap
    }

    // And it stays right after the other session lands #3: the allow-list
    // persists across re-ingest (#131), so #2 -- now dep-satisfied -- is
    // claimable rather than sitting outside the batch while #1 gets parked.
    const landed = state([ticket(1, "Ready", [2]), ticket(2, "Ready", [3]), ticket(3, "Done")]);
    landed.batchTickets = selectBatch(stuck(), 1); // the batch captured at cap 1
    expect(nextAction(landed, 0)).toMatchObject({ kind: "claim", ticket: 2 });
  });

  // The closure walks only WORKABLE deps, so a dep no run can start (Backlog)
  // is still not dragged in -- the dependent is admitted alone and parked,
  // which is exactly what an uncapped run does with it.
  test("#157: the stuck-set closure does not admit a non-workable dep (Backlog stays out)", () => {
    const tickets = [ticket(1, "Ready", [2]), ticket(2, "Backlog")];
    expect(selectBatch(tickets, 1)).toEqual([1]);
    const s = state(tickets);
    s.batchTickets = [1];
    expect(nextAction(s, 0)).toMatchObject({ kind: "park", ticket: 1, status: "Blocked" });
  });
});

describe("batch-scoped claiming + drain (#131)", () => {
  test("AC2: no cap drains all 5 (== a full allow-list, gating nothing); a PARTIAL allow-list gates the drain to exactly its batch -- the allow-list is load-bearing", () => {
    const mk = () => state([1, 2, 3, 4, 5].map((n) => ticket(n, "Ready")));
    const noCap = drainHappy(mk());
    const fullAllow = mk();
    fullAllow.batchTickets = [1, 2, 3, 4, 5]; // an allow-list containing everything gates nothing
    const withAllow = drainHappy(fullAllow);
    expect(withAllow.log).toEqual(noCap.log); // identical schedule
    expect(noCap.state.tickets.every((t) => t.status === "Done")).toBe(true);
    // Recorded golden for the no-cap drain: every ticket claimed and completed in
    // ascending order. (This alone is NOT load-bearing -- reverting #131 keeps it
    // green -- so the partial-allow-list case below is what actually pins gating.)
    expect(noCap.log.filter((a) => a.kind === "claim").map((a) => (a as any).ticket)).toEqual([1, 2, 3, 4, 5]);
    expect(noCap.log.filter((a) => a.kind === "complete").map((a) => (a as any).ticket)).toEqual([1, 2, 3, 4, 5]);

    // LOAD-BEARING: a PARTIAL allow-list over the SAME board drains ONLY #1/#2 and
    // stops -- #3/#4/#5 are never claimed and end still Ready. Reverting #131 (or
    // the finding-1 bug that drops the allow-list mid-run) would drain all 5 here,
    // so this golden fails the moment batch-gating regresses -- unlike the
    // undefined-vs-full-allow-list compare, which both collapse to the same path.
    const partial = mk();
    partial.batchTickets = [1, 2];
    const capped = drainHappy(partial);
    expect(capped.log.filter((a) => a.kind === "claim").map((a) => (a as any).ticket)).toEqual([1, 2]);
    expect(capped.log.filter((a) => a.kind === "complete").map((a) => (a as any).ticket)).toEqual([1, 2]);
    expect(capped.state.tickets.filter((t) => t.status === "Done").map((t) => t.number)).toEqual([1, 2]);
    expect(capped.state.tickets.filter((t) => t.status === "Ready").map((t) => t.number)).toEqual([3, 4, 5]);
    // The capped schedule genuinely differs from the uncapped one.
    expect(capped.log).not.toEqual(noCap.log);
  });

  test("AC1 (nextAction): a claim only ever targets an in-batch ticket", () => {
    const s = state([1, 2, 3, 4, 5, 6].map((n) => ticket(n, "Ready")));
    s.batchTickets = [1, 2];
    expect(nextAction(s, 0)).toEqual({ kind: "claim", ticket: 1, stage: "builder" });
  });

  test("AC4: cap 2, #1/#2 Done, #3..#10 Ready but un-flagged, no lanes -> drain-complete (leftovers don't keep the run alive)", () => {
    const s = state([
      ticket(1, "Done"),
      ticket(2, "Done"),
      ...[3, 4, 5, 6, 7, 8, 9, 10].map((n) => ticket(n, "Ready")),
    ]);
    s.batchTickets = [1, 2];
    expect(nextAction(s, 0)).toEqual({ kind: "drain-complete" });
    expect(drainComplete(s.tickets, s.lanes, s.batchTickets)).toBe(true);
    // Without the batch scope those 8 Ready tickets WOULD keep it alive.
    expect(drainComplete(s.tickets, s.lanes)).toBe(false);
  });

  // #157 AC2 (#131 review finding 2), end to end through the REAL ingest: a cap
  // over a fully cyclic workable set (#1 depends #2, #2 depends #1). Before the
  // fix selectBatch returned [], drainComplete read true, and the very first
  // `next` was drain-complete -- the run exited clean and never surfaced the
  // cycle. Reverting lanes.ts makes every assertion below fail.
  test("#157 AC2: a cap over a fully cyclic workable set parks the cycle Blocked instead of exiting clean", () => {
    const items = [
      { number: 1, title: "t1", fields: { Status: "Ready" } },
      { number: 2, title: "t2", fields: { Status: "Ready" } },
    ];
    const bodies = { "1": "Depends on #2", "2": "Depends on #1" };
    const s = ingestBoardItems(null, items, bodies, { ticketLimit: 2, humanNeededPercent: 30 });
    expect(s.batchTickets).toEqual([1, 2]);
    expect(drainComplete(s.tickets, s.lanes, s.batchTickets)).toBe(false); // NOT a silent clean exit

    const first = nextAction(s, 0);
    expect(first).toMatchObject({ kind: "park", ticket: 1, status: "Blocked" });
    expect((first as any).note).toContain("Dependency deadlock");

    // It TERMINATES, and both cycle members reach a terminal status -- one park
    // must not leave the other hanging, and the park path must not re-park a
    // ticket forever (drainHappy throws past 500 steps).
    const { state: end, log } = drainHappy(s);
    expect(log[log.length - 1].kind).toBe("drain-complete");
    expect(log.filter((a) => a.kind === "park").map((a) => (a as any).ticket)).toEqual([1, 2]);
    expect(end.tickets.map((t) => t.status)).toEqual(["Blocked", "Blocked"]);

    // A 3-cycle under a cap of 3: the first park is the deadlock break, and the
    // other two then fall to the dead-dependency park (a cycle member is now
    // Blocked) -- so a longer cycle terminates with ALL of it terminal too,
    // never one parked and the rest hanging.
    const cycle3 = state([ticket(1, "Ready", [2]), ticket(2, "Ready", [3]), ticket(3, "Ready", [1])]);
    cycle3.batchTickets = selectBatch(cycle3.tickets, 3);
    expect(cycle3.batchTickets).toEqual([1, 2, 3]);
    const end3 = drainHappy(cycle3);
    expect(end3.log[end3.log.length - 1].kind).toBe("drain-complete");
    expect(end3.state.tickets.every((t) => t.status === "Blocked")).toBe(true);
  });

  // The other half of the same branch: "nothing closable" is NOT always a
  // cycle. When the block is a dependency ANOTHER live session holds, the
  // admitted stuck set must WAIT (that session will finish it), never park --
  // nextAction's step-6 discriminator, unchanged, is what tells the two apart.
  test("#157: a capped stuck set blocked on another session's in-flight dep waits, never parks", () => {
    const s = state([
      ticket(1, "Ready", [2]),
      ticket(2, "Building", [], { claimedByOther: true, claimedByOtherAt: 0 }), // stamped: see the deadlock-breaker cases
    ]);
    s.batchTickets = selectBatch(s.tickets, 2);
    expect(s.batchTickets).toEqual([1]); // #2 is another session's, so only #1 is admitted
    expect(nextAction(s, 0)).toEqual({ kind: "wait" });
  });

  // #131 review-bounce finding 1 (SEVERE) + finding 2 (MEDIUM): the real
  // ingest -> next sequence ACROSS the capped-batch drain boundary (the
  // z-loop-tick path). Before the fix, the batch-scoped drainComplete turned
  // true the instant the flagged tickets finished, while the leftover Ready
  // kept readyCount > 0 -- so the very next per-tick ingest (which passes NO
  // --ticket-limit) re-fired startingFreshBatch, dropped the allow-list
  // (selectBatch(.., 0) -> undefined), and `next` returned `claim #3`, draining
  // the WHOLE remaining queue in one /z-loop invocation. It also wiped
  // mergedThisRun/initialReadyCount/humanNeededNotified (finding 2). The capped
  // run must instead drain EXACTLY its batch, then return drain-complete so the
  // operator re-invokes /z-loop for the next batch. Reverting the fix makes
  // every assertion below fail (next -> claim #3, batchTickets undefined,
  // mergedThisRun []).
  test("finding 1/2 regression: after a capped batch drains, a per-tick re-ingest returns drain-complete (NOT claim of leftover Ready) and preserves batchTickets/mergedThisRun/counters", () => {
    const nums = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const bodies = Object.fromEntries(nums.map((n) => [String(n), "no deps"]));
    const readyItems = nums.map((n) => ({ number: n, title: `t${n}`, fields: { Status: "Ready" } }));

    // Step 3 ingest WITH --ticket-limit 2 captures the batch [1,2].
    let s = ingestBoardItems(null, readyItems, bodies, { ticketLimit: 2, humanNeededPercent: 30 });
    expect(s.batchTickets).toEqual([1, 2]);
    const capturedInitialReady = s.initialReadyCount; // 10 (all Ready at capture)

    // Drive the batch to Done through the REAL reducer -- drainHappy claims only
    // the flagged #1/#2 (batch-scoped), completes them (populating mergedThisRun
    // via the `complete` reducer), and stops. #3..#10 stay Ready, un-flagged.
    const drained = drainHappy(s).state;
    expect(drained.tickets.filter((t) => t.status === "Done").map((t) => t.number)).toEqual([1, 2]);
    expect(drained.tickets.filter((t) => t.status === "Ready").map((t) => t.number)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(drained.mergedThisRun).toEqual([1, 2]);
    expect(drainComplete(drained.tickets, drained.lanes, drained.batchTickets)).toBe(true); // batch-scoped: this IS the boundary prev

    // THE BOUNDARY: the next per-tick ingest (z-loop-tick path -- NO
    // --ticket-limit), against a fresh board snapshot showing #1/#2 Done and
    // #3..#10 still Ready.
    const drainedItems = [
      { number: 1, title: "t1", fields: { Status: "Done" } },
      { number: 2, title: "t2", fields: { Status: "Done" } },
      ...[3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ number: n, title: `t${n}`, fields: { Status: "Ready" } })),
    ];
    const afterBoundary = ingestBoardItems(drained, drainedItems, bodies, { contextTokens: 0 });

    // finding 1: the allow-list survives -- the run does NOT roll into leftover Ready.
    expect(afterBoundary.batchTickets).toEqual([1, 2]);
    expect(nextAction(afterBoundary, 0)).toEqual({ kind: "drain-complete" });
    // finding 2: the per-batch counters survive the boundary (no spurious fresh batch).
    expect(afterBoundary.mergedThisRun).toEqual([1, 2]);
    expect(afterBoundary.initialReadyCount).toBe(capturedInitialReady);
    expect(afterBoundary.humanNeededNotified).toBe(false);

    // And a re-INVOCATION (Step 3 ingest, which DOES pass --ticket-limit) against
    // that same drained state captures the NEXT batch [3,4] -- the operator's way
    // to continue -- proving the run exits between batches rather than draining
    // everything at once.
    const nextRun = ingestBoardItems(afterBoundary, drainedItems, bodies, { ticketLimit: 2 });
    expect(nextRun.batchTickets).toEqual([3, 4]);
    expect(nextRun.mergedThisRun).toEqual([]); // fresh batch resets the counters
    expect(nextAction(nextRun, 0)).toEqual({ kind: "claim", ticket: 3, stage: "builder" });
  });

  // #168 (adversarial review of #150, unpinned gap 2): a ticket that a
  // ticketLimit cap leaves in Ready -- excluded from batchTickets, the CLAIM
  // allow-list -- is NOT excluded from initialBatchTickets, the
  // humanNeededStatus SCOPE, once the next batch captures it. The two lists
  // answer different questions (what may THIS run claim vs. what counts toward
  // THIS run's safety-control numerator) and must not collapse into the same
  // set. Reverting #150's isNewBatchTicket-based capture to the narrower
  // flagged allow-list makes every assertion below fail.
  test("#168: a ticket left out of a capped batchTickets by the ticket-limit still lands in the NEXT batch's initialBatchTickets, and counts toward humanNeededStatus if it parks", () => {
    const nums = [1, 2, 3, 4, 5];
    const bodies = Object.fromEntries(nums.map((n) => [String(n), "no deps"]));
    const readyItems = nums.map((n) => ({ number: n, title: `t${n}`, fields: { Status: "Ready" } }));

    // First capped batch: ticketLimit 2 over 5 Ready tickets flags [1, 2];
    // #3/#4/#5 stay Ready, outside batchTickets -- the deliberately-excluded
    // leftovers #150's context describes.
    const first = ingestBoardItems(null, readyItems, bodies, { ticketLimit: 2 });
    expect(first.batchTickets).toEqual([1, 2]);

    // Drain it -- drainHappy claims/completes only the flagged pair (batch-scoped
    // claiming, #131), leaving #3/#4/#5 untouched at Ready.
    const drained = drainHappy(first).state;
    expect(drained.tickets.filter((t) => t.status === "Done").map((t) => t.number)).toEqual([1, 2]);
    expect(drained.tickets.filter((t) => t.status === "Ready").map((t) => t.number)).toEqual([3, 4, 5]);

    // Re-invocation (Step 3, passes --ticket-limit again) against that drained
    // state captures the NEXT batch: batchTickets caps at the lowest 2 of the 3
    // leftovers ([3, 4]), but initialBatchTickets -- the same Ready-or-new rule
    // initialReadyCount uses, not the capped allow-list -- picks up all 3,
    // including leftover #5.
    const drainedItems = [
      { number: 1, title: "t1", fields: { Status: "Done" } },
      { number: 2, title: "t2", fields: { Status: "Done" } },
      ...[3, 4, 5].map((n) => ({ number: n, title: `t${n}`, fields: { Status: "Ready" } })),
    ];
    const next = ingestBoardItems(drained, drainedItems, bodies, { ticketLimit: 2, humanNeededPercent: 30 });
    expect(next.batchTickets).toEqual([3, 4]); // the cap: #5 excluded from the claim allow-list
    expect(next.initialBatchTickets).toEqual([3, 4, 5]); // the scope: #5 included anyway
    expect(next.initialBatchTickets).not.toEqual(next.batchTickets);

    // Park leftover #5 -- outside the cap, so nextAction's own claim/deadlock
    // steps never reach it; this simulates whatever park path (human or a later
    // run) eventually resolves it -- and confirm it counts toward THIS batch's
    // human-needed numerator exactly like a flagged, in-cap ticket would.
    const parked = applyAction(next, { kind: "park", ticket: 5, status: "Blocked", note: "test park" }, 0);
    const hn = humanNeededStatus(parked);
    expect(hn.blocked).toBe(1);
    expect(hn.tickets.blocked).toEqual([5]);
  });
});

describe("context ceiling gate (#131)", () => {
  const overLimit = (over: Partial<LoopState> = {}): LoopState => ({
    ...state([ticket(1, "Ready")]),
    contextTokenLimit: 550000,
    contextTokens: 600000,
    ...over,
  });

  test("AC5: over-limit, one claimable batch ticket, all lanes idle -> context-clear (claim suppressed, no wait)", () => {
    expect(nextAction(overLimit(), 0)).toEqual({ kind: "context-clear" });
  });

  test("AC6: over-limit but a lane is still running (unresolved) -> the lane's watchdog action, never context-clear", () => {
    const s = overLimit({
      tickets: [ticket(1, "QA")],
      lanes: [lane(1, "qa", { lastActivityMs: 0 })], // silent, no outcome
    });
    // nowMs past the 10-minute watchdog: an in-flight lane drains via check-worker.
    const a = nextAction(s, 11 * 60_000);
    expect(a).toEqual({ kind: "check-worker", ticket: 1 });
    expect(a.kind).not.toBe("context-clear");
  });

  test("AC6b: over-limit but a lane has a finished stage -> its advance still fires (draining continues)", () => {
    const s = overLimit({
      tickets: [ticket(1, "QA")],
      lanes: [lane(1, "qa", { outcome: { kind: "qa-pass" } })],
    });
    expect(nextAction(s, 0)).toMatchObject({ kind: "advance", ticket: 1, to: "reviewer" });
  });

  test("AC7: contextTokenLimit 0 disables the gate -> a normal claim even far over any reading", () => {
    const s = overLimit({ contextTokenLimit: 0 });
    expect(nextAction(s, 0)).toEqual({ kind: "claim", ticket: 1, stage: "builder" });
  });

  test("over-limit with the batch fully drained (no work remaining) -> drain-complete still wins over context-clear", () => {
    const s = overLimit({ tickets: [ticket(1, "Done")] });
    expect(nextAction(s, 0)).toEqual({ kind: "drain-complete" });
  });

  test("AC8: applyAction(context-clear) is a pure no-op -- lanes, tickets, and batchTickets all unchanged", () => {
    const s: LoopState = { ...overLimit(), batchTickets: [1] };
    const before = structuredClone(s);
    const after = applyAction(s, { kind: "context-clear" }, 12345);
    expect(after).toEqual(before); // state is identical; a pause, not a transition
    expect(s).toEqual(before); // input untouched (pure)
  });
});

describe("ingestBoardItems: batch + context knobs (#131)", () => {
  test("AC1 (capture): a fresh batch with --ticket-limit captures batchTickets as the flagged allow-list", () => {
    const items = [1, 2, 3, 4, 5].map((n) => ({ number: n, title: `t${n}`, fields: { Status: "Ready" } }));
    const bodies = Object.fromEntries(items.map((it) => [String(it.number), "no deps"]));
    const s = ingestBoardItems(null, items, bodies, { ticketLimit: 3 });
    expect(s.batchTickets).toEqual([1, 2, 3]);
    // The other 2 are present + Ready but not claimable within the batch.
    expect(s.tickets.filter((t) => t.status === "Ready").map((t) => t.number)).toEqual([1, 2, 3, 4, 5]);
    expect(claimableTickets(s.tickets, s.lanes, s.batchTickets).map((t) => t.number)).toEqual([1, 2, 3]);
  });

  test("ticketLimit 0 (default) leaves batchTickets undefined -- byte-identical to today", () => {
    const items = [1, 2].map((n) => ({ number: n, title: `t${n}`, fields: { Status: "Ready" } }));
    const s = ingestBoardItems(null, items, { "1": "", "2": "" });
    expect(s.batchTickets).toBeUndefined();
  });

  test("contextTokens is stored fresh from cfg (never preserved from prev); contextTokenLimit defaults + persists", () => {
    const items = [{ number: 1, title: "t1", fields: { Status: "Ready" } }];
    const first = ingestBoardItems(null, items, { "1": "" });
    expect(first.contextTokens).toBe(0); // absent reading -> 0 (never gates)
    expect(first.contextTokenLimit).toBe(550000); // DEFAULT_CONTEXT_TOKEN_LIMIT

    const withReading = ingestBoardItems(first, items, { "1": "" }, { contextTokens: 400000, contextTokenLimit: 500000 });
    expect(withReading.contextTokens).toBe(400000);
    expect(withReading.contextTokenLimit).toBe(500000);

    // A later tick with a fresh (smaller) reading and no --context-token-limit:
    // contextTokens updates to the new reading, the limit persists from prev.
    const nextTick = ingestBoardItems(withReading, items, { "1": "" }, { contextTokens: 5000 });
    expect(nextTick.contextTokens).toBe(5000); // NOT preserved at 400000
    expect(nextTick.contextTokenLimit).toBe(500000); // preserved
  });

  test("AC11: over-limit context-clear then re-ingest the un-drained state -> batchTickets preserved, small fresh reading resumes claiming the next flagged ticket", () => {
    // Prev: #1 built (Done, left Ready), #2/#3 flagged-but-unbuilt (Ready), no
    // lanes, over the ceiling -- the state a context-clear pause leaves behind.
    const prev: LoopState = {
      ...state([ticket(1, "Done"), ticket(2, "Ready"), ticket(3, "Ready")]),
      batchTickets: [1, 2, 3],
      initialBatchTickets: [1, 2, 3], // #150: this batch's own captured numerator scope
      contextTokens: 600000,
      contextTokenLimit: 550000,
      initialReadyCount: 3,
    };
    // Sanity: prev is NOT drained (unbuilt flagged Ready tickets remain in-batch).
    expect(drainComplete(prev.tickets, prev.lanes, prev.batchTickets)).toBe(false);

    const items = [
      { number: 1, title: "t1", fields: { Status: "Done" } },
      { number: 2, title: "t2", fields: { Status: "Ready" } },
      { number: 3, title: "t3", fields: { Status: "Ready" } },
    ];
    const bodies = { "1": "", "2": "", "3": "" };
    // Resume ingest: no --ticket-limit (batch already flagged), a fresh SMALL
    // reading (the context-cleared orchestrator's first tick).
    const resumed = ingestBoardItems(prev, items, bodies, { contextTokens: 5000 });
    expect(resumed.batchTickets).toEqual([1, 2, 3]); // preserved verbatim (startingFreshBatch false)
    // #168 (adversarial review of #150, unpinned gap 1): initialBatchTickets
    // rides the SAME non-fresh carry-forward as batchTickets (both gated on
    // startingFreshBatch false) -- pinned here so a future edit that drops it
    // from that carry-forward fails loudly instead of silently re-scoping
    // humanNeededStatus's numerator mid-run.
    expect(resumed.initialBatchTickets).toEqual([1, 2, 3]);
    expect(resumed.contextTokens).toBe(5000);
    expect(resumed.contextTokenLimit).toBe(550000); // preserved
    // The gate is now open -> claiming resumes on the next flagged-but-unbuilt ticket.
    expect(nextAction(resumed, 0)).toEqual({ kind: "claim", ticket: 2, stage: "builder" });
  });
});

describe("validateConfig: ticketLimit / contextTokenLimit (#131 AC10) + minSkepticQuorum (#191)", () => {
  const baseConfig = () => ({
    slug: "s",
    owner: "o",
    repo: "r",
    projectNumber: 1,
    projectId: "P",
    repositoryId: "R",
    statusField: { id: "F", dataType: "SINGLE_SELECT", options: { Ready: "o1" } },
    fields: {},
  });

  test("ticketLimit -1 throws naming the field with the non-negative-integer rule", () => {
    expect(() => validateConfig({ ...baseConfig(), ticketLimit: -1 })).toThrow(
      /"ticketLimit" must be a non-negative integer \(0 = no cap\)/
    );
  });

  test("contextTokenLimit 2.5 throws naming the field with the non-negative-integer rule", () => {
    expect(() => validateConfig({ ...baseConfig(), contextTokenLimit: 2.5 })).toThrow(
      /"contextTokenLimit" must be a non-negative integer \(0 = disabled\)/
    );
  });

  test("ticketLimit 0 and contextTokenLimit 0 both pass (disabled is legal)", () => {
    expect(() => validateConfig({ ...baseConfig(), ticketLimit: 0, contextTokenLimit: 0 })).not.toThrow();
  });

  // #191: a quorum above the fixed 3-skeptic fan-out is unsatisfiable, so every
  // adversarial review would park Blocked. That is a config error at write time,
  // not a mystery at drain time.
  test("minSkepticQuorum is bounded to the fan-out it is a quorum over", () => {
    for (const bad of [4, 1.5, -1]) {
      expect(() => validateConfig({ ...baseConfig(), minSkepticQuorum: bad })).toThrow(
        /"minSkepticQuorum" must be an integer 0-3 \(0 disables the gate\)/
      );
    }
    for (const ok of [0, 1, 2, 3]) {
      expect(() => validateConfig({ ...baseConfig(), minSkepticQuorum: ok })).not.toThrow();
    }
  });
});

// -- merge gate (#178) --------------------------------------------------------
//
// The gate the loop owns instead of the merge agent's prose judgment: run 9's
// worker for #132 read a suite reporting 9 failures, called it green, merged,
// and broke main (reverted in PR #158). These feed SYNTHETIC suite outputs to
// mergeGate -- no spawns, no waiting -- and assert block / retry-then-pass /
// pass, plus the two real-CLI ends.

// ONE `bun test` run, banner to summary, byte-shaped like bun's real output
// (captured from `bun test` on a throwaway project: the banner goes to stdout,
// the summary block to stderr, and runGauntlet concatenates them). Both ends
// matter: the banner is how the gate counts runs STARTED, the `Ran N tests`
// line how it counts them FINISHED, and the ` N fail` line in between is the
// only verdict it reads.
const SUITE_BANNER = "bun test v1.3.14 (0d9b296a)\n";
const suiteTail = (pass: number, fail: number) =>
  `${SUITE_BANNER} ${pass} pass\n ${fail} fail\n ${pass + fail} expect() calls\nRan ${pass + fail} tests across 3 files. [900.00ms]\n`;

// Drives mergeGate over a scripted list of attempts. An attempt beyond the
// script THROWS -- that is how "no retry happened" is proven, not by a count an
// assertion could forget to check.
// `clockMs` advances the injected clock by that much per attempt, which is the
// only way the wall-clock budget is reachable without actually waiting.
function driveGate(
  runs: SuiteRun[],
  scripts: GateScripts = { test: true, typecheck: true, bunTest: true },
  budgetMs: number = MERGE_GATE_BUDGET_MS,
  clockMs = 0
) {
  const attempts: number[] = [];
  const waits: number[] = [];
  const budgets: number[] = [];
  let clock = 0;
  const verdict = mergeGate(
    (n, timeoutMs) => {
      attempts.push(n);
      budgets.push(timeoutMs);
      clock += clockMs;
      const r = runs[n - 1];
      if (!r) throw new Error(`gate ran attempt ${n}, only ${runs.length} scripted`);
      return r;
    },
    (ms) => {
      waits.push(ms);
      clock += ms;
    },
    MERGE_GATE_RETRY_WAIT_MS,
    scripts,
    budgetMs,
    () => clock
  );
  return { verdict, attempts, waits, budgets };
}

describe("merge gate: the loop decides green/red, never the agent (#178)", () => {
  // AC1 -- 9 fail, exit 1: RED, and the fail count is in the note. The retry
  // happens (see the retry-shape describe below) and reproduces the failures;
  // what AC1 demands is the verdict, which is red either way -- "it merges
  // under NO circumstance while red" is the criterion, and a second run that
  // reports the same 9 is still red.
  test("a suite reporting 9 fail (exit 1) is RED and names the fail count", () => {
    const nine = { exitCode: 1, output: `(fail) claims a lane\n${suiteTail(1252, 9)}` };
    const { verdict, attempts } = driveGate([nine, nine]);
    expect(verdict.green).toBe(false);
    expect(verdict.failCount).toBe(9);
    expect(verdict.note).toContain("9 fail");
    expect(verdict.note).toContain("refusing the merge");
    expect(attempts).toEqual([1, 2]); // and never a third: the budget is exactly one retry
  });

  // AC2 -- contention on the first run, green on the retry: exactly one retry
  // after the 15s wait, then the merge proceeds.
  test("a nonzero first exit with no reported failures retries ONCE after 15s, then passes on green", () => {
    const { verdict, attempts, waits } = driveGate([
      { exitCode: 1, output: "error: EBUSY: resource busy or locked, open 'tsconfig.tsbuildinfo'\n" },
      { exitCode: 0, output: suiteTail(1261, 0) },
    ]);
    expect(verdict.green).toBe(true);
    expect(verdict.attempts).toBe(2);
    expect(verdict.failCount).toBe(0);
    expect(attempts).toEqual([1, 2]);
    expect(waits).toEqual([MERGE_GATE_RETRY_WAIT_MS]);
    expect(MERGE_GATE_RETRY_WAIT_MS).toBe(15_000);
  });

  // -- review finding 2: the retry fired for the wrong shape ------------------
  //
  // The retry used to be conditioned on the first run reporting NO counted
  // failures, on the theory that contention arrives as a bannerless nonzero
  // exit. Measured on this repo it does not: contention arrives as TEST
  // TIMEOUTS, which bun counts on the summary line (the full suite under load
  // reports `2 fail`, both `this test timed out after 5000ms`, where the same
  // file run alone reports 1 -- the count is load-dependent). Every real
  // contention case therefore took the "summary reports failures" branch and
  // got no retry, no 15s wait and an immediate Blocked, so AC2 held only for
  // the synthetic bannerless fixture above.
  describe("any red first attempt gets the one retry, whatever shape it wore", () => {
    // The measured shape, verbatim from a loaded run of tests/z-loop-tick.test.ts.
    const TIMEOUT_RUN = {
      exitCode: 1,
      output:
        "(fail) z-loop-tick > drains a batch [5001.00ms]\n" +
        "^ this test timed out after 5000ms\n" +
        suiteTail(1259, 2),
    };

    test("a load-shed timeout run retries and passes when the retry is clean", () => {
      const { verdict, attempts, waits } = driveGate([TIMEOUT_RUN, { exitCode: 0, output: suiteTail(1261, 0) }]);
      expect(verdict).toMatchObject({ green: true, attempts: 2, failCount: 0 });
      expect(attempts).toEqual([1, 2]);
      expect(waits).toEqual([MERGE_GATE_RETRY_WAIT_MS]);
    });

    test("...and the SECOND run's count is what decides -- genuine failures reproduce and stay red", () => {
      const { verdict } = driveGate([TIMEOUT_RUN, { exitCode: 1, output: suiteTail(1252, 9) }]);
      expect(verdict).toMatchObject({ green: false, attempts: 2, failCount: 9 });
      expect(verdict.note).toContain("9 fail");
    });
  });

  // -- review finding 6: the bound on the gauntlet is code, not the SKILL -----
  //
  // The SKILL mandates a 600000ms Bash timeout; the gate now owns a budget
  // under it and hands each attempt what is left, so a killed call is the
  // gate's own honest red instead of a harness kill that stamps nothing and
  // costs the lane one of its MERGE_GATE_MAX_RUNS.
  describe("the gate's wall-clock budget is enforced in code", () => {
    test("the budget leaves real headroom under the SKILL's 10-minute cap", () => {
      expect(MERGE_GATE_BUDGET_MS).toBe(570_000);
      // The whole gate, wait included, must still answer inside the mandated
      // Bash cap -- the budget already covers the wait, so this is the outer
      // bound with the wait double-counted, deliberately conservative.
      expect(MERGE_GATE_BUDGET_MS + MERGE_GATE_RETRY_WAIT_MS).toBeLessThan(600_000);
      // ...and attempt 1 alone gets the WHOLE budget, ~2.4x the 233.6s measured
      // `bun test` on this repo -- a per-attempt half-cap would not, and would
      // kill a slow-but-green suite outright.
      expect(driveGate([{ exitCode: 0, output: suiteTail(1, 0) }]).budgets).toEqual([MERGE_GATE_BUDGET_MS]);
    });

    test("the retry gets what is LEFT of the budget, not a fresh one", () => {
      const { budgets } = driveGate(
        [{ exitCode: 1, output: "error: EBUSY\n" }, { exitCode: 0, output: suiteTail(1, 0) }],
        undefined,
        570_000,
        100_000 // each attempt burns 100s of the clock
      );
      expect(budgets).toEqual([570_000, 570_000 - 100_000 - MERGE_GATE_RETRY_WAIT_MS]);
    });

    // -- QA finding 1 (run 13): the budget cancelled AC2's retry --------------
    //
    // The skip used to read `left() - retryWaitMs < firstTookMs`, i.e. "a retry
    // that cannot be given as long as the first attempt took is not worth the
    // wait". With a single shared budget that is an attempt-1 DURATION cliff at
    // (budget - wait) / 2 -- 262.5s at the old 540s budget, under this repo's
    // own 233.6s suite. The gate hit it on PR #178 itself and refused a branch
    // that ran 0 fail three separate times. The retry is now unconditional.
    test("an attempt 1 past the old (budget - wait) / 2 cliff STILL gets its retry", () => {
      // 300s > (570 - 15) / 2 = 277.5s, and > the old 540s budget's 262.5s.
      const { verdict, attempts, waits, budgets } = driveGate(
        [{ exitCode: 1, output: `(fail) drains a batch [5001.00ms]\n^ this test timed out after 5000ms\n${suiteTail(1259, 3)}` }, { exitCode: 0, output: suiteTail(1262, 0) }],
        undefined,
        570_000,
        300_000
      );
      expect(verdict).toMatchObject({ green: true, attempts: 2, failCount: 0 });
      expect(attempts).toEqual([1, 2]);
      expect(waits).toEqual([MERGE_GATE_RETRY_WAIT_MS]);
      // ...and the retry gets real time, not a token remainder.
      expect(budgets[1]).toBe(570_000 - 300_000 - MERGE_GATE_RETRY_WAIT_MS);
      expect(budgets[1]).toBeGreaterThan(233_600); // the measured suite still fits
    });

    test("only a budget consumed WHOLE skips the retry -- attempt 1 was killed at the cap, so there is no clock left", () => {
      // One scripted run: driveGate THROWS if a second is attempted.
      const { verdict, attempts, waits } = driveGate([{ exitCode: 124, output: "merge gate: `bun run test` was killed after 570s (the gate's wall-clock budget)\n" }], undefined, 570_000, 570_000);
      expect(verdict).toMatchObject({ green: false, attempts: 1 });
      expect(verdict.note).toContain("gauntlet exited 124");
      expect(verdict.note).toContain("consumed the gate's entire 570s budget");
      expect(attempts).toEqual([1]);
      expect(waits).toEqual([]); // not even the 15s is spent on a retry with nothing to run in
    });

    // The boundary itself, both sides, so "the budget cancels the retry" can
    // never creep back as an off-by-one: one ms of run time left is a retry.
    test("boundary: exactly the wait left is no retry, one ms more is a retry", () => {
      const red = { exitCode: 1, output: "error: EBUSY\n" };
      const green = { exitCode: 0, output: suiteTail(1, 0) };
      expect(driveGate([red], undefined, 570_000, 555_000).attempts).toEqual([1]);
      expect(driveGate([red, green], undefined, 570_000, 554_999).attempts).toEqual([1, 2]);
    });
  });

  // AC3 -- the intentional "FAIL merge-order" self-test line (#128) must not
  // block a suite whose summary says 0 fail at exit 0.
  test("a green run whose output contains the literal FAIL merge-order self-test line passes", () => {
    const output =
      "FAIL  merge-order  expected [1,2,3], got [2,1,3]\n" +
      "(fail) out-of-order merge (mergedThisRun [2,1,3]) fails merge-order\n" +
      suiteTail(1261, 0);
    const { verdict, attempts, waits } = driveGate([{ exitCode: 0, output }]);
    expect(verdict.green).toBe(true);
    expect(verdict.attempts).toBe(1);
    expect(waits).toEqual([]);
    expect(attempts).toEqual([1]);
  });

  test("a second nonzero exit is RED -- the retry budget is exactly one", () => {
    const { verdict, attempts } = driveGate([
      { exitCode: 1, output: "error: EBUSY\n" },
      { exitCode: 1, output: "error: EBUSY\n" },
      { exitCode: 0, output: suiteTail(1261, 0) }, // a third attempt would wrongly reach this
    ]);
    expect(verdict.green).toBe(false);
    expect(verdict.attempts).toBe(2);
    expect(attempts).toEqual([1, 2]);
    expect(verdict.note).toContain("exited 1");
  });

  test("contention then real failures is RED with the retry's fail count", () => {
    const { verdict } = driveGate([
      { exitCode: 1, output: "error: EBUSY\n" },
      { exitCode: 1, output: suiteTail(1252, 9) },
    ]);
    expect(verdict.green).toBe(false);
    expect(verdict.failCount).toBe(9);
    expect(verdict.note).toContain("9 fail");
  });

  test("exit 0 with NO summary line is not green -- a suite that did not run never merges", () => {
    const { verdict, attempts } = driveGate([
      { exitCode: 0, output: "bun test v1.3.14\n" },
      { exitCode: 0, output: "bun test v1.3.14\n" },
    ]);
    expect(verdict.green).toBe(false);
    expect(verdict.failCount).toBeNull();
    expect(attempts).toEqual([1, 2]); // treated as contention: one retry, then refuse
    expect(verdict.note).toContain("did not run");
  });

  test("a typecheck-only failure (0 fail, nonzero exit) never merges", () => {
    const tsErr = "lib/loop.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.\n";
    const { verdict } = driveGate([
      { exitCode: 2, output: suiteTail(1261, 0) + tsErr },
      { exitCode: 2, output: suiteTail(1261, 0) + tsErr },
    ]);
    expect(verdict.green).toBe(false);
    expect(verdict.attempts).toBe(2);
  });

  // -- QA finding 1: a summary line does not prove WHOSE summary it is --------
  //
  // Reproduced end-to-end before the fix, on a real project: `a.test.ts` fails,
  // `z.test.ts` shells a nested `bun test` on a passing subproject with inherited
  // stdio and then calls process.exit(0). The outer run never prints its own
  // summary, the inner one prints ` 0 fail`, the process exits 0 -- and the gate
  // returned {"green":true,"failCount":0} on a project with a failing test, the
  // exact "#132 suite did not run" shape it exists to refuse. The two banners
  // were in the stream the whole time; nothing counted them.
  describe("a nested bun test run cannot lend its verdict to the outer one", () => {
    // The captured shape: banner, banner, one summary, exit 0.
    const NESTED_ONLY_SUMMARY = `${SUITE_BANNER}${suiteTail(1, 0)}`;

    test("two runs started, one finished, exit 0, 0 fail -> RED, never a merge", () => {
      const { verdict } = driveGate([
        { exitCode: 0, output: NESTED_ONLY_SUMMARY },
        { exitCode: 0, output: NESTED_ONLY_SUMMARY },
      ]);
      expect(verdict.green).toBe(false);
      expect(verdict.note).toContain("2 `bun test` run(s) started");
      expect(verdict.note).toContain("only 1 finished");
      expect(verdict.note).toContain("refusing the merge");
    });

    test("a nested run that DOES finish is fine -- both summaries are attributable, MAX decides", () => {
      // Two complete runs in one stream: nothing died, so the fail-closed MAX
      // over both summaries is the verdict. Green when both are green...
      expect(driveGate([{ exitCode: 0, output: suiteTail(3, 0) + suiteTail(1261, 0) }]).verdict.green).toBe(true);
      // ...and red the moment either reports a failure.
      const bothRan = { exitCode: 1, output: suiteTail(3, 2) + suiteTail(1261, 0) };
      const red = driveGate([bothRan, bothRan]).verdict;
      expect(red.green).toBe(false);
      expect(red.failCount).toBe(2);
    });

    test("countSuiteRuns counts banners as starts and `Ran N tests` as finishes", () => {
      expect(countSuiteRuns(suiteTail(1, 0))).toEqual({ started: 1, finished: 1 });
      expect(countSuiteRuns(NESTED_ONLY_SUMMARY)).toEqual({ started: 2, finished: 1 });
      expect(countSuiteRuns(suiteTail(1, 0) + suiteTail(2, 0))).toEqual({ started: 2, finished: 2 });
      expect(countSuiteRuns("error: EBUSY\n")).toEqual({ started: 0, finished: 0 });
      // Singular/plural both ways -- bun writes "Ran 1 test across 1 file."
      expect(countSuiteRuns(`${SUITE_BANNER}Ran 1 test across 1 file. [24.00ms]\n`).finished).toBe(1);
    });

    // Review finding 4: the `^` anchors were the fix for a false green, and
    // dropping either of them left the suite green -- in the FAIL-OPEN
    // direction. A stray mid-line match raises `finished`, equalises it with
    // `started`, and re-opens the nested-run hole the started/finished check
    // exists to close. bun writes both of these lines at column 0; anything
    // indented or trailing other text is a test talking ABOUT them.
    describe("the summary parses are anchored to the line start", () => {
      // A `(pass)` line whose test NAME quotes the summary format -- exactly what
      // this very file's fixtures print when a nested suite echoes them.
      const MID_LINE_SUMMARY = `${SUITE_BANNER}${SUITE_BANNER} 1 pass\n 0 fail\n(pass) parse > reads Ran 1 test across 1 file. off the tail\n`;

      test("a mid-line `Ran N tests across M files.` is not a finished run", () => {
        expect(countSuiteRuns(MID_LINE_SUMMARY)).toEqual({ started: 2, finished: 0 });
      });

      // The behavioural half: two runs started, the finish line only quoted, so
      // the fail count on the summary belongs to a run that never reported.
      // Unanchored, `finished` reads 1 -- still short of 2, so pair it with the
      // one-banner shape where the stray match would make started === finished.
      test("a quoted finish line cannot green-light a run that died without reporting", () => {
        const out = `${SUITE_BANNER}${SUITE_BANNER} 1 pass\n 0 fail\nRan 1 test across 1 file. [9.00ms]\n(pass) parse > reads Ran 1 test across 1 file. off the tail\n`;
        const { verdict } = driveGate([
          { exitCode: 0, output: out },
          { exitCode: 0, output: out },
        ]);
        expect(countSuiteRuns(out)).toEqual({ started: 2, finished: 1 });
        expect(verdict.green).toBe(false);
        expect(verdict.note).toContain("only 1 finished");
      });

      test("a mid-line `error: 0 test files matching` is not bun saying so", () => {
        expect(foundNoTestFiles(`${SUITE_BANNER}(pass) gate > error: 0 test files matching is detected\n`)).toBe(false);
        expect(foundNoTestFiles(`${SUITE_BANNER}  error: 0 test files matching **{.test}.{ts}\n`)).toBe(false);
      });

      // The one parse the whole verdict rests on, and the only one anchored at
      // BOTH ends -- previously `^[ \t]*(\d+)[ \t]+fail\b`, where `\b` matches
      // any non-word character. Unlike the two above this one fails CLOSED-on-
      // noise: a phantom summary reads red, the retry reproduces it, and the
      // lane parks Blocked unbypassably. bun's line is ` N fail` and nothing
      // else (measured), so anything with text after `fail` is prose about it.
      // Each string below kills exactly one anchor:
      //   - drop `^`  -> `... 12 fail` at a line's END matches
      //   - drop `$`  -> `3 fail-safe ...` / `12 fail: ...` at a line's START match
      const NOISY_GREEN =
        `${SUITE_BANNER}(pass) parse > a legacy suite reporting 12 fail\n` +
        "  3 fail-safe checks skipped\n" +
        "12 fail: legacy counter\n" +
        " 1500 pass\n 0 fail\n 1 expect() calls\nRan 1500 tests across 3 files. [900.00ms]\n";

      test("only a whole-line ` N fail` is a summary -- neither anchor may go", () => {
        expect(parseSuiteFailCount(NOISY_GREEN)).toBe(0);
        // Head anchor, isolated: the count sits at the end of a `(pass)` line.
        expect(parseSuiteFailCount(`${SUITE_BANNER}(pass) parse > 12 fail\n 0 fail\n`)).toBe(0);
        // Tail anchor, isolated: the count sits at the start of a prose line.
        expect(parseSuiteFailCount(`${SUITE_BANNER}12 fail: legacy counter\n 0 fail\n`)).toBe(0);
        expect(parseSuiteFailCount(`${SUITE_BANNER}  3 fail-safe checks skipped\n 0 fail\n`)).toBe(0);
        // ...and the real line still reads, indented or not, trailing space or not.
        expect(parseSuiteFailCount(" 9 fail\n")).toBe(9);
        expect(parseSuiteFailCount("9 fail  \n")).toBe(9);
      });

      test("a green suite whose output merely mentions fail counts still merges", () => {
        const { verdict, attempts } = driveGate([{ exitCode: 0, output: NOISY_GREEN }]);
        expect(verdict).toMatchObject({ green: true, attempts: 1, failCount: 0 });
        expect(attempts).toEqual([1]); // no retry burned reproducing phantom noise
      });
    });

    // Finding 7's readable half: where the manifest says the `test` script IS
    // `bun test` and the output carries none of bun's bookkeeping, the note has
    // to name that rather than "the suite did not run", which reads like a
    // broken suite. (A repo that never claimed bun's runner takes the
    // foreign-runner path instead -- see review finding 1 below.)
    test("no bun test run in the output at all names the cause instead of blaming the suite", () => {
      const { verdict } = driveGate([
        { exitCode: 0, output: "PASS tests/foo.spec.js\nTests: 12 passed\n" },
        { exitCode: 0, output: "PASS tests/foo.spec.js\nTests: 12 passed\n" },
      ]);
      expect(verdict.green).toBe(false);
      expect(verdict.note).toContain("no `bun test` run at all");
      expect(verdict.note).toContain("died before reporting");
    });
  });

  // -- QA finding 2 (2nd pass): the "not a bun project" note was unreachable ---
  //
  // Two independent reasons, and QA named only the first: the exit-code branch
  // ran ahead of it, AND `bun test` prints its banner BEFORE it looks for test
  // files, so the banner count is 1 on a checkout with no bun tests at all --
  // reordering alone would not have reached it. Captured verbatim from
  // `bun test` in a directory holding only `main.go` (bun 1.3.14): banner,
  // this error, exit 1. The real signal is the error line.
  describe("a checkout with no bun test files says so instead of blaming the suite", () => {
    const NON_BUN_OUTPUT =
      `${SUITE_BANNER}error: 0 test files matching **{.test,.spec,_test_,_spec_}.{js,ts,jsx,tsx} in --cwd="C:\\repo"\n`;

    test("bun still prints its banner, so the banner count cannot detect this", () => {
      expect(countSuiteRuns(NON_BUN_OUTPUT)).toEqual({ started: 1, finished: 0 });
      expect(foundNoTestFiles(NON_BUN_OUTPUT)).toBe(true);
      expect(foundNoTestFiles(suiteTail(1261, 0))).toBe(false);
    });

    test("exit 1 with 0 test files names the cause, not the generic exit code", () => {
      const { verdict, attempts } = driveGate([
        { exitCode: 1, output: NON_BUN_OUTPUT },
        { exitCode: 1, output: NON_BUN_OUTPUT },
      ]);
      expect(verdict.green).toBe(false);
      expect(verdict.note).toContain("no `bun test` run at all");
      expect(verdict.note).toContain("bun found 0 test files");
      expect(verdict.note).toContain("died before reporting");
      expect(verdict.note).not.toContain("no test-summary line");
      expect(attempts).toEqual([1, 2]); // still the contention shape: one retry, then refuse
    });

    // The branch jumps the exit-code queue, so it must not be able to reword a
    // genuine contention kill -- that one is bannerless AND has no error line.
    test("a contention kill with no output keeps the honest `gauntlet exited N` note", () => {
      const { verdict } = driveGate([
        { exitCode: 1, output: "error: EBUSY\n" },
        { exitCode: 1, output: "error: EBUSY\n" },
      ]);
      expect(verdict.note).toContain("gauntlet exited 1 with no test-summary line");
      expect(verdict.note).not.toContain("bun found 0 test files");
    });

    // The whole reordering is note-only by construction: the branch requires
    // failCount === null and green requires a summary line, so no output that
    // used to read green can reach it.
    test("the error line cannot turn a run that reported a summary red", () => {
      const withStray = suiteTail(1261, 0) + "error: 0 test files matching x in --cwd=\"C:\\nested\"\n";
      expect(driveGate([{ exitCode: 0, output: withStray }]).verdict.green).toBe(true);
    });
  });

  // -- QA finding 2: the anchors must not depend on the ambient environment ---
  //
  // bun wraps its summary in SGR escapes whenever the env asks for color, and
  // `\x1b[0m\x1b[2m 0 fail\x1b[0m` matched no anchor: a GREEN project read
  // {"green":false,"failCount":null}, burned both attempts, and parked the lane.
  describe("colorized bun output reads identically to plain output", () => {
    // Captured verbatim from `FORCE_COLOR=1 bun test | cat -v` on a passing project.
    const COLOR = "\x1b[0m\x1b[1mbun test \x1b[0m\x1b[2mv1.3.14 (0d9b296a)\x1b[0m\n\n\x1b[0m\x1b[32m 1 pass\x1b[0m\n\x1b[0m\x1b[2m 0 fail\x1b[0m\n 1 expect() calls\nRan 1 test across 1 file. \x1b[0m\x1b[2m[\x1b[1m24.00ms\x1b[0m\x1b[2m]\x1b[0m\n";

    test("the fail count and the run counts survive the escapes", () => {
      expect(parseSuiteFailCount(COLOR)).toBe(0);
      expect(countSuiteRuns(COLOR)).toEqual({ started: 1, finished: 1 });
      expect(stripAnsi(COLOR)).toContain(" 0 fail\n");
    });

    test("a colorized green run is GREEN on the first attempt, with no retry burned", () => {
      const { verdict, attempts, waits } = driveGate([{ exitCode: 0, output: COLOR }]);
      expect(verdict).toMatchObject({ green: true, attempts: 1, failCount: 0 });
      expect(attempts).toEqual([1]);
      expect(waits).toEqual([]);
    });

    test("a colorized RED run still reports its fail count", () => {
      const red = COLOR.replace("\x1b[2m 0 fail", "\x1b[31m 9 fail");
      const { verdict } = driveGate([{ exitCode: 1, output: red }, { exitCode: 1, output: red }]);
      expect(verdict.green).toBe(false);
      expect(verdict.failCount).toBe(9);
      expect(verdict.note).toContain("9 fail");
    });
  });

  // -- AC4: a provably-absent script is skipped, both absent is a refusal -----
  //
  // Pinning both commands by name made the gate unpassable on any repo without
  // a `typecheck` script: `bun run typecheck` exits 1 with `Script not found`,
  // red is unbypassable, so every lane on such a repo parked Blocked forever.
  // The amended plan skips only what `package.json` PROVES absent, keeps
  // `bun test` mandatory wherever it is defined (so nothing above changes), and
  // refuses outright when neither exists.
  describe("the gauntlet runs only the scripts package.json defines (AC4)", () => {
    test("detectGateScripts reads the two script names, and proves nothing on junk", () => {
      expect(detectGateScripts('{"scripts":{"test":"bun test","typecheck":"tsc --noEmit"}}')).toEqual({ test: true, typecheck: true, bunTest: true });
      expect(detectGateScripts('{"scripts":{"test":"bun test"}}')).toEqual({ test: true, typecheck: false, bunTest: true });
      expect(detectGateScripts('{"scripts":{"typecheck":"tsc"}}')).toEqual({ test: false, typecheck: true, bunTest: false });
      expect(detectGateScripts('{"name":"x"}')).toEqual({ test: false, typecheck: false, bunTest: false });
      // No package.json (a Go checkout), unparseable JSON, and a non-string
      // script value all mean "absent" -- which the gate turns into a REFUSAL,
      // never a skip, so a broken manifest can never buy a merge.
      expect(detectGateScripts(null)).toEqual({ test: false, typecheck: false, bunTest: false });
      expect(detectGateScripts("{not json")).toEqual({ test: false, typecheck: false, bunTest: false });
      expect(detectGateScripts('{"scripts":{"test":true,"typecheck":null}}')).toEqual({ test: false, typecheck: false, bunTest: false });
    });

    // Review finding 1: the gate spawns `bun run test`, so whether bun's own
    // runner is what runs is a fact about the SCRIPT, and the summary reads
    // below hang off it. Positive evidence only -- anything the manifest does
    // not prove runs `bun test` is read as a foreign runner.
    test("detectGateScripts tells bun's own runner from a foreign one", () => {
      const bunTest = (s: string) => detectGateScripts(JSON.stringify({ scripts: { test: s } })).bunTest;
      expect(bunTest("bun test")).toBe(true);
      expect(bunTest("bun test --coverage")).toBe(true);
      expect(bunTest("bun test && bun run lint")).toBe(true);
      expect(bunTest("cross-env CI=1 bun test")).toBe(true);
      expect(bunTest("bun --silent test")).toBe(true);
      expect(bunTest("jest --ci")).toBe(false);
      expect(bunTest("vitest run")).toBe(false);
      expect(bunTest("bunx jest")).toBe(false);
      expect(bunTest("npm run test:unit")).toBe(false);
      // Not a substring match: a script that merely MENTIONS the words is not
      // a promise to print bun's banner and summary.
      expect(bunTest('echo "run bun tests with bun test"')).toBe(false);
      expect(bunTest("rebun testify")).toBe(false);
    });

    // The refuted-AC1 shapes. A skeptic ran three byte-identical fixtures (a
    // failing `a-broken.test.ts` plus a `z-exit.test.ts` calling
    // `process.exit(0)`) through the shipped CLI, differing ONLY in the script
    // string, and the two indirect ones came back
    // `{"green":true,"attempts":1,"failCount":null}` exit 0 -- merge permission
    // on a branch with a failing test, #132's exact shape. Root cause: a
    // literal-only `bun test` match classified bun's runner reached through a
    // hop as foreign, which switched off all three anti-#132 guards at once.
    test("detectGateScripts follows `bun run <name>` hops -- an indirect bun runner is still bun's", () => {
      const bunTest = (scripts: Record<string, string>) => detectGateScripts(JSON.stringify({ scripts })).bunTest;
      expect(bunTest({ test: "bun run inner", inner: "bun test" })).toBe(true);
      expect(bunTest({ test: "bun run test:unit", "test:unit": "bun test" })).toBe(true);
      // Both limbs of a chain are followed, not just the first.
      expect(bunTest({ test: "bun run test:e2e && bun run test:unit", "test:e2e": "echo e2e", "test:unit": "bun test" })).toBe(true);
      // Multi-hop.
      expect(bunTest({ test: "bun run a", a: "bun run b", b: "bun test" })).toBe(true);
      // A hop that lands somewhere foreign stays foreign -- the resolver adds
      // positive evidence, it does not assume any indirection means bun.
      expect(bunTest({ test: "bun run inner", inner: "jest --ci" })).toBe(false);
      // A hop naming a script that does not exist proves nothing.
      expect(bunTest({ test: "bun run missing" })).toBe(false);
    });

    // A hand-edited manifest must not hang the gate: a stalled drain is the
    // failure PROCESS.md ranks alongside a bad merge.
    test("a self-referential or ringed script table terminates instead of recursing forever", () => {
      const bunTest = (scripts: Record<string, string>) => detectGateScripts(JSON.stringify({ scripts })).bunTest;
      expect(bunTest({ test: "bun run test" })).toBe(false);
      expect(bunTest({ test: "bun run a", a: "bun run b", b: "bun run a" })).toBe(false);
      // ...and a ring that DOES reach bun's runner still reports it.
      expect(bunTest({ test: "bun run a", a: "bun run b", b: "bun run a && bun test" })).toBe(true);
    });

    test("`test` defined, `typecheck` absent: the suite alone reads GREEN", () => {
      const { verdict, attempts, waits } = driveGate([{ exitCode: 0, output: suiteTail(1261, 0) }], { test: true, typecheck: false, bunTest: true });
      expect(verdict).toMatchObject({ green: true, attempts: 1, failCount: 0 });
      expect(attempts).toEqual([1]); // no retry burned on a script that is simply not there
      expect(waits).toEqual([]);
      // A DOCUMENTED absence, not a silent pass: the verdict names the limb it
      // did not run, so a green measured on half the gauntlet can be told from
      // one measured on all of it. The skip is only defensible while it says so.
      expect(verdict.note).toContain("no `typecheck` script in package.json");
      expect(verdict.note).toContain("not run");
    });

    test("a green measured on BOTH limbs claims no absence", () => {
      const { verdict } = driveGate([{ exitCode: 0, output: suiteTail(1261, 0) }], { test: true, typecheck: true, bunTest: true });
      expect(verdict.green).toBe(true);
      expect(verdict.note).not.toContain("not run");
    });

    test("`test` defined, `typecheck` absent: a failing suite is still RED -- the skip is not a bypass", () => {
      const nine = { exitCode: 1, output: suiteTail(1252, 9) };
      const { verdict } = driveGate([nine, nine], { test: true, typecheck: false, bunTest: true });
      expect(verdict).toMatchObject({ green: false, failCount: 9 });
      expect(verdict.note).toContain("9 fail");
    });

    test("NEITHER script defined: refused before a single spawn, and never retried", () => {
      // The scripted attempt list is EMPTY: driveGate throws if the gate runs
      // anything at all, so "not run" is proven, not asserted about a counter.
      const { verdict, attempts, waits } = driveGate([], { test: false, typecheck: false, bunTest: false });
      expect(verdict).toMatchObject({ green: false, attempts: 0, failCount: null });
      expect(verdict.note).toContain("neither a `test` nor a `typecheck` script");
      expect(verdict.note).toContain("refusing the merge");
      expect(attempts).toEqual([]);
      expect(waits).toEqual([]);
    });

    // `bun test` never ran, so there is no summary line, no banner and no fail
    // count -- every check the suite path makes would read this as the "did not
    // run" shape. The exit code is the whole verdict.
    test("`typecheck` only: exit 0 is green, nonzero is red, on the exit code alone", () => {
      const green = driveGate([{ exitCode: 0, output: "" }], { test: false, typecheck: true, bunTest: false }).verdict;
      expect(green).toMatchObject({ green: true, attempts: 1, failCount: null });
      expect(green.note).toContain("no `test` script");
      const tsErr = "lib/loop.ts(12,3): error TS2322: nope\n";
      const red = driveGate([{ exitCode: 2, output: tsErr }, { exitCode: 2, output: tsErr }], { test: false, typecheck: true, bunTest: false }).verdict;
      expect(red).toMatchObject({ green: false, attempts: 2 });
      expect(red.note).toContain("exited 2");
      expect(red.note).toContain("refusing the merge");
    });
  });

  // -- review finding 1: the gate runs the DEFINED script, not bun's builtin --
  //
  // Pinning `bun test` gated a command the repo never asked for. A worktree
  // scripting `test` as `jest --ci` had its real suite skipped entirely, and
  // bun's runner then found nothing matching ITS patterns -- measured,
  // `{"scripts":{"test":"jest"}}` + `__tests__/a.js` returned
  // `{"green":false,"...bun found 0 test files"}` at exit 1, unbypassable, so
  // every lane on that repo parked Blocked forever. Same failure AC4 fixed on
  // the typecheck limb, relocated to the test limb.
  describe("a foreign test runner is gated on its own exit code (review finding 1)", () => {
    const FOREIGN = { test: true, typecheck: true, bunTest: false };

    test("a green foreign runner passes -- no bun banner or summary is demanded of it", () => {
      const { verdict, attempts } = driveGate([{ exitCode: 0, output: "PASS tests/foo.spec.js\nTests: 12 passed, 12 total\n" }], FOREIGN);
      expect(verdict).toMatchObject({ green: true, attempts: 1 });
      expect(verdict.note).toContain("not `bun test`");
      expect(attempts).toEqual([1]);
    });

    test("a red foreign runner is refused on its exit code", () => {
      const jestRed = { exitCode: 1, output: "FAIL tests/foo.spec.js\nTests: 1 failed, 11 passed\n" };
      const { verdict } = driveGate([jestRed, jestRed], FOREIGN);
      expect(verdict).toMatchObject({ green: false, attempts: 2 });
      expect(verdict.note).toContain("refusing the merge");
    });

    // The skip is scoped to the bun-shaped bookkeeping only. The two reads that
    // are fail-closed on ANY runner stay on, so a foreign runner that somehow
    // prints a bun summary reporting failures is still refused.
    test("a `N fail` summary reporting failures is still red even off a foreign runner", () => {
      const odd = { exitCode: 0, output: suiteTail(3, 2) };
      expect(driveGate([odd, odd], FOREIGN).verdict).toMatchObject({ green: false, failCount: 2 });
    });

    // And the reverse: where the manifest DOES prove bun's runner, exit 0 with
    // no banner stays red. The bunTest flag must not become a way to buy a
    // green by writing a different script name.
    test("where the script IS `bun test`, a bannerless exit 0 stays red", () => {
      const bare = { exitCode: 0, output: "PASS tests/foo.spec.js\nTests: 12 passed\n" };
      expect(driveGate([bare, bare]).verdict).toMatchObject({ green: false });
    });

    // The other half of the refuted-AC1 fix, and the half that does not depend
    // on static resolution being complete. `detectGateScripts` now follows
    // `bun run <name>` hops, but no manifest read can see through `npm test`, a
    // shell wrapper, or a script that execs a generated command -- and guessing
    // "foreign" on a real bun run is the expensive mistake: it hands exit 0 a
    // pass with the banner count, the fail count and the started-vs-finished
    // check all switched off. A banner in the stream is bun saying its runner
    // started here, so it beats whatever the manifest suggested.
    test("a bun banner in the output overrides a foreign manifest reading -- exit 0 with no summary is RED", () => {
      // The skeptic's fixture B, byte-shaped: bun's banner, a failing test line,
      // and a `process.exit(0)` before the summary ever prints.
      const exitEarly = { exitCode: 0, output: `${SUITE_BANNER}(fail) really broken\n` };
      const { verdict } = driveGate([exitEarly, exitEarly], FOREIGN);
      expect(verdict).toMatchObject({ green: false });
      expect(verdict.note).toContain("the suite did not run");
    });

    test("a bun banner in the output overrides a foreign manifest reading -- a nested run's summary does not vouch", () => {
      // Two runs started, one finished: the surviving ` 0 fail` belongs to the
      // nested run, not to the one that died. Reachable ONLY once the banner
      // overrides the manifest -- the foreign shortcut returned green here.
      const donated = { exitCode: 0, output: `${SUITE_BANNER}${suiteTail(4, 0)}` };
      const { verdict } = driveGate([donated, donated], FOREIGN);
      expect(verdict).toMatchObject({ green: false });
      expect(verdict.note).toContain("finished");
    });

    test("...and a genuinely foreign runner that prints no banner is unaffected", () => {
      // The safe direction of the same rule: no banner, no bun bookkeeping
      // demanded, the repo's own exit code is the verdict.
      const { verdict } = driveGate([{ exitCode: 0, output: "ok 12 - all good\n" }], FOREIGN);
      expect(verdict).toMatchObject({ green: true, attempts: 1 });
    });
  });

  describe("parseSuiteFailCount reads the summary line only", () => {
    test("no summary line -> null", () => {
      expect(parseSuiteFailCount("error: EBUSY\nFAIL  merge-order\n(fail) something\n")).toBeNull();
    });
    test("0 fail -> 0; 9 fail -> 9", () => {
      expect(parseSuiteFailCount(suiteTail(10, 0))).toBe(0);
      expect(parseSuiteFailCount(suiteTail(1, 9))).toBe(9);
    });
    test("two summaries (a test that spawns a nested bun test) -> the MAX, fail-closed", () => {
      expect(parseSuiteFailCount(suiteTail(3, 0) + suiteTail(1, 2))).toBe(2);
      expect(parseSuiteFailCount(suiteTail(1, 2) + suiteTail(3, 0))).toBe(2);
    });
  });

  // -- the real CLI end: it actually runs the gauntlet and exits on its verdict
  describe("loop merge-gate CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "zstack-merge-gate-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    // A throwaway "worktree": one test file plus the two scripts the gate now
    // detects, so the gate's two real spawns stay well inside the gate budget.
    // `typecheck` defaults to a no-op that always exits 0; a caller passing its
    // own script is exercising the typecheck limb of the gauntlet. The scripts
    // block is what runGauntlet keys off (#178 AC4) -- omitting `test` here
    // would silently skip the suite limb in every case below, so it is
    // explicit, and `scripts` overrides let the absent-script cases drop one.
    // A `null` body writes NO test file at all, which is the only way to tell a
    // skipped `bun test` from a spawned one on a typecheck-only worktree.
    function project(name: string, body: string | null, typecheck = "bun --version", scripts?: Record<string, string>): string {
      const p = join(dir, name);
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, "package.json"), JSON.stringify({ name, scripts: scripts ?? { test: "bun test", typecheck } }));
      if (body !== null) writeFileSync(join(p, "x.test.ts"), body);
      return p;
    }

    const runGate = (cwd: string, ...extra: string[]) =>
      Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "loop.ts"), "merge-gate", cwd, ...extra], { stdout: "pipe", stderr: "pipe" });

    const PASSING = 'import {test,expect} from "bun:test";\ntest("a",()=>{expect(1).toBe(1)});\n';
    const FAILING = 'import {test,expect} from "bun:test";\ntest("a",()=>{expect(1).toBe(2)});\n';

    test("green worktree -> exit 0 and a green verdict JSON", () => {
      const proc = runGate(project("green", PASSING));
      expect(proc.exitCode).toBe(0);
      expect(JSON.parse(proc.stdout.toString())).toMatchObject({ green: true, attempts: 1, failCount: 0 });
    });

    test("red worktree -> exit 1, and the retry's fail count is the verdict", () => {
      const proc = runGate(project("red", FAILING), "--retry-wait-ms", "0");
      expect(proc.exitCode).toBe(1);
      // attempts 2: since review finding 2 EVERY red first attempt is retried,
      // because real contention on this repo arrives counted on the summary
      // line (test timeouts) and was being short-circuited as a real failure.
      expect(JSON.parse(proc.stdout.toString())).toMatchObject({ green: false, attempts: 2, failCount: 1 });
    });

    // Review finding 1, end to end on the real deployed path: the gauntlet runs
    // `bun run test`, so a repo whose `test` script is a foreign runner is
    // actually gated by it. Pinning `bun test` skipped this script entirely and
    // then refused the repo for having no bun test files.
    test("a non-bun `test` script is really executed, and its exit code is the verdict", () => {
      const green = project("foreign-green", null, "bun --version", { test: "bun runner.ts", typecheck: "bun --version" });
      writeFileSync(join(green, "runner.ts"), 'console.log("PASS tests/foo.spec.js\\nTests: 12 passed");\n');
      const okProc = runGate(green, "--retry-wait-ms", "0");
      expect(okProc.exitCode).toBe(0);
      expect(JSON.parse(okProc.stdout.toString())).toMatchObject({ green: true, attempts: 1 });

      const red = project("foreign-red", null, "bun --version", { test: "bun runner.ts", typecheck: "bun --version" });
      writeFileSync(join(red, "runner.ts"), 'console.log("FAIL tests/foo.spec.js");\nprocess.exit(1);\n');
      const badProc = runGate(red, "--retry-wait-ms", "0");
      expect(badProc.exitCode).toBe(1);
      expect(JSON.parse(badProc.stdout.toString())).toMatchObject({ green: false });
    });

    test("a missing worktree is a loud refusal, not a silent green", () => {
      const proc = runGate(join(dir, "does-not-exist"));
      expect(proc.exitCode).not.toBe(0);
      expect(proc.stderr.toString()).toContain("does not exist");
    });

    // QA finding 3: the gauntlet is `bun test` AND `bun run typecheck`, and
    // every other CLI project here scripts typecheck as `bun --version` -- so
    // deleting the typecheck spawn outright left the whole suite green. This is
    // the pin: a green suite with a red typecheck must not merge.
    test("a green suite with a FAILING typecheck never merges (the typecheck limb is really run)", () => {
      const p = project("tc-red", PASSING, "bun tc.ts");
      writeFileSync(join(p, "tc.ts"), "process.exit(3);\n");
      const proc = runGate(p, "--retry-wait-ms", "0");
      expect(proc.exitCode).toBe(1);
      const verdict = JSON.parse(proc.stdout.toString());
      // 0 fail from the suite, nonzero from tsc: the exit code alone is the red.
      expect(verdict).toMatchObject({ green: false, failCount: 0, attempts: 2 });
      expect(verdict.note).toContain("exited 3");
    });

    // AC4, end to end on the real deployed path. QA's repro of the pinned
    // gauntlet: `{"scripts":{"test":"bun test"}}` + a PASSING test returned
    // {"green":false,"failCount":0,...gauntlet exited 1 with 0 fail...} because
    // `bun run typecheck` on a missing script exits 1 with `Script not found`,
    // so every lane on such a repo parked Blocked forever.
    test("a passing suite with NO typecheck script is green -- the absent script is skipped, not run", () => {
      const p = project("no-tc", PASSING, "", { test: "bun test" });
      const proc = runGate(p, "--retry-wait-ms", "0");
      expect(proc.exitCode).toBe(0);
      const verdict = JSON.parse(proc.stdout.toString());
      expect(verdict).toMatchObject({ green: true, attempts: 1, failCount: 0 });
      // "not run": bun's `Script not found` never reaches the output the gate reads.
      expect(verdict.note).not.toContain("Script not found");
    });

    test("a FAILING suite with no typecheck script is still red -- skipping typecheck is not a bypass", () => {
      const proc = runGate(project("no-tc-red", FAILING, "", { test: "bun test" }), "--retry-wait-ms", "0");
      expect(proc.exitCode).toBe(1);
      expect(JSON.parse(proc.stdout.toString())).toMatchObject({ green: false, failCount: 1 });
    });

    // Review finding 2: AC4's mirror branch. Every tc-only case here shipped a
    // PASSING x.test.ts, so mutating runGauntlet's `if (scripts.test)` to
    // always-spawn left the whole suite green while a real typecheck-only
    // worktree flipped to {"green":false,...} -- the "every lane parks Blocked
    // forever" failure AC4 exists to prevent. With no test file on disk, a
    // `bun test` the gate must not spawn exits 1 with `0 test files matching`.
    test("a typecheck-only worktree with NO test files is green -- `bun test` is never spawned", () => {
      const proc = runGate(project("tc-only-no-tests", null, "", { typecheck: "bun --version" }), "--retry-wait-ms", "0");
      expect(proc.exitCode).toBe(0);
      const verdict = JSON.parse(proc.stdout.toString());
      expect(verdict).toMatchObject({ green: true, attempts: 1, failCount: null });
      // Proof the suite limb never ran: bun's own "no test files" line is absent.
      expect(verdict.note).not.toContain("0 test files");
      expect(verdict.note).toContain("typecheck only");
    });

    // Review finding 3: a limb killed at the wall-clock budget comes back
    // exitCode null + a signalCode, and runGauntlet normalises that to 124.
    // That single line is FAIL-OPEN if it ever reads 0 -- on the typecheck-only
    // branch (and the foreign-runner branch) the exit code is the ENTIRE
    // verdict, so a gauntlet killed at the cap would read GREEN and authorise
    // the merge, breaking AC1's "merges under NO circumstance while red".
    // Mutating `code: 124` to `code: 0` left the whole suite green before this.
    // --budget-ms is the only way to reach the kill without waiting 570s.
    //
    // The two numbers below are a MEASURED pair, not taste. This started at a
    // 1500ms budget against a 5000ms sleep and failed 2 of 6 full-trio runs
    // (green 4/4 in isolation): bun's own process startup on this Windows
    // machine is ~1s (#252 measured eight sequential bun spawns at ~2s a tick,
    // tests/z-loop-tick.test.ts:31-51), so 1500ms left ~500ms of headroom, and
    // under load attempt 1 sometimes returned a plain nonzero BEFORE the kill
    // -- which the gate then retried, and `attempts: 1` went red on a machine
    // where nothing was broken. It matters more than a normal flake because
    // this diff makes the suite an unbypassable merge blocker: a load-flaky
    // test inside it costs a lane an attempt every time it fires.
    //
    // 3000ms is 3x the measured startup, and the sleep is raised to 20s so the
    // limb is still running by a wide margin when the budget kills it. The test
    // costs ~3s of wall clock by construction (it waits out its own budget).
    // Move either number only with a fresh measurement written here.
    test("a limb killed at the wall-clock budget is RED, never a clean exit 0", () => {
      const p = project("budget-kill", null, "bun slow.ts", { typecheck: "bun slow.ts" });
      // Steps out of the worktree before blocking. The budget kills `bun run
      // typecheck`, not the grandchild it spawned, and on Windows a live
      // process's cwd cannot be removed -- without the chdir this fixture's
      // directory survives its own afterAll with EBUSY.
      writeFileSync(join(p, "slow.ts"), 'process.chdir(require("node:os").tmpdir());\nBun.sleepSync(20000);\n');
      const proc = runGate(p, "--retry-wait-ms", "0", "--budget-ms", "3000");
      expect(proc.exitCode).toBe(1);
      const verdict = JSON.parse(proc.stdout.toString());
      expect(verdict).toMatchObject({ green: false, attempts: 1 });
      expect(verdict.note).toContain("exited 124");
    });

    test("--budget-ms rejects a non-positive value instead of running unbounded", () => {
      const proc = runGate(project("budget-bad", PASSING), "--budget-ms", "0");
      expect(proc.exitCode).not.toBe(0);
      expect(proc.stderr.toString()).toContain("--budget-ms must be a positive number");
    });

    test("a typecheck script with no test script gates on typecheck alone", () => {
      expect(runGate(project("tc-only", PASSING, "", { typecheck: "bun --version" })).exitCode).toBe(0);
      const p = project("tc-only-red", PASSING, "", { typecheck: "bun tc.ts" });
      writeFileSync(join(p, "tc.ts"), "process.exit(3);\n");
      const proc = runGate(p, "--retry-wait-ms", "0");
      expect(proc.exitCode).toBe(1);
      expect(JSON.parse(proc.stdout.toString()).note).toContain("exited 3");
    });

    test("NEITHER script defined -> refused, and a missing package.json refuses the same way", () => {
      for (const p of [project("no-scripts", PASSING, "", {}), mkdtempSync(join(dir, "no-pkg-"))]) {
        const proc = runGate(p, "--retry-wait-ms", "0");
        expect(proc.exitCode).toBe(1);
        const verdict = JSON.parse(proc.stdout.toString());
        expect(verdict).toMatchObject({ green: false, attempts: 0, failCount: null });
        expect(verdict.note).toContain("neither a `test` nor a `typecheck` script");
      }
    });

    // QA finding 1, end to end on the real deployed path: `a.test.ts` fails,
    // `z.test.ts` shells a nested `bun test` on a passing subproject with
    // INHERITED stdio and then process.exit(0)s. Two banners, one summary
    // (` 0 fail`, the nested run's), exit 0 -- and before the run-count check
    // this printed {"green":true,"attempts":1,"failCount":0} and merged.
    test("a nested stdio-inherited bun test cannot green-light a project with a failing test", () => {
      const p = project("nested", FAILING);
      const inner = join(p, "inner");
      mkdirSync(inner, { recursive: true });
      writeFileSync(join(inner, "package.json"), JSON.stringify({ name: "inner" }));
      writeFileSync(join(inner, "i.test.ts"), PASSING);
      writeFileSync(
        join(p, "z.test.ts"),
        'import {test} from "bun:test";\n' +
          'test("nested", () => {\n' +
          '  Bun.spawnSync([process.execPath, "test"], { cwd: import.meta.dir + "/inner", stdout: "inherit", stderr: "inherit" });\n' +
          "  process.exit(0);\n" +
          "});\n"
      );
      const proc = runGate(p, "--retry-wait-ms", "0");
      expect(proc.exitCode).toBe(1);
      expect(JSON.parse(proc.stdout.toString()).green).toBe(false);
    });

    // QA finding 2, end to end: the gate spawns the gauntlet with color pinned
    // off, so an orchestrator launched by a tool that exports FORCE_COLOR reads
    // the same verdict as one launched from a bare shell. Before this, a GREEN
    // worktree returned {"green":false,"failCount":null} and parked the lane.
    const forceColor = (cwd: string) =>
      Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "loop.ts"), "merge-gate", cwd], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, FORCE_COLOR: "1" },
      });

    test("a green worktree is green even when the caller's env forces color", () => {
      const proc = forceColor(project("color", PASSING));
      expect(proc.exitCode).toBe(0);
      expect(JSON.parse(proc.stdout.toString())).toMatchObject({ green: true, attempts: 1, failCount: 0 });
    });

    // ...and the pin is at the SOURCE, not only in the parser: the gauntlet's
    // child process sees color switched off whatever the caller exported, so
    // the bytes the gate reads are plain to begin with. Asserted from inside
    // the gated suite, which is the only place that env is observable.
    test("the gauntlet's child process runs with color pinned off, whatever the caller exported", () => {
      const p = project(
        "color-env",
        'import {test,expect} from "bun:test";\n' +
          'test("env", () => {\n' +
          '  expect(process.env.NO_COLOR).toBe("1");\n' +
          '  expect(process.env.FORCE_COLOR).toBe("0");\n' +
          "});\n"
      );
      expect(forceColor(p).exitCode).toBe(0);
    });

    // A verdict vouches for ONE commit (QA finding 6): the merge agent re-runs
    // the gate after resolving a conflict, and the sha is what makes the re-run
    // a different, checkable fact rather than a repeat of the same claim.
    test("the verdict names the worktree HEAD it tested, and omits it where there is no git", () => {
      const p = project("sha", PASSING);
      // Not a git repo yet: provenance is best-effort, never a refusal to answer.
      const ungit = JSON.parse(runGate(p).stdout.toString());
      expect(ungit.green).toBe(true);
      expect(ungit.commit).toBeUndefined();
      for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"]]) {
        expect(Bun.spawnSync(["git", "-C", p, ...args]).exitCode).toBe(0);
      }
      const head = new TextDecoder().decode(Bun.spawnSync(["git", "-C", p, "rev-parse", "HEAD"], { stdout: "pipe" }).stdout).trim();
      expect(JSON.parse(runGate(p).stdout.toString()).commit).toBe(head);
    });

    // The refuted-AC1 repro, end to end on the real deployed path. Three
    // byte-identical fixtures differing ONLY in the script string used to come
    // back exit 1 / exit 0 / exit 0 -- the two indirect ones handing merge
    // permission to a tree with a failing test. All three are red now.
    // BOTH fixture files matter, which is why they are written together. A
    // failing test ALONE prints ` 1 fail` on the summary line, and that read is
    // unconditional -- so an indirect script is red there whatever the manifest
    // said, and a fixture with only the failing test proves nothing about this
    // fix. `z-exit.test.ts` is what makes the repro discriminating: it calls
    // `process.exit(0)`, killing the run before its summary prints, so the
    // whole gauntlet exits 0 with a banner, a `(fail)` line and no verdict of
    // its own -- #132's "the suite did not run" shape. Only the bun-bookkeeping
    // checks catch that, and those are exactly what a `bunTest: false` reading
    // switches off.
    test("a bun suite reached INDIRECTLY through `bun run` is still gated (refuted AC1)", () => {
      const shapes: Array<[string, Record<string, string>]> = [
        ["direct", { test: "bun test", typecheck: "bun --version" }],
        ["one-hop", { test: "bun run inner", inner: "bun test", typecheck: "bun --version" }],
        ["named-hop", { test: "bun run test:unit", "test:unit": "bun test", typecheck: "bun --version" }],
      ];
      for (const [name, scripts] of shapes) {
        const p = project(`indirect-${name}`, 'import {test,expect} from "bun:test";\ntest("really broken",()=>{expect(1).toBe(2)});\n', "bun --version", scripts);
        writeFileSync(join(p, "z-exit.test.ts"), 'import {test} from "bun:test";\ntest("exit",()=>{process.exit(0)});\n');
        const proc = runGate(p, "--retry-wait-ms", "0");
        expect([name, proc.exitCode]).toEqual([name, 1]);
        expect([name, JSON.parse(proc.stdout.toString()).green]).toEqual([name, false]);
      }
    });

    // -- #248 end to end: `next` binds the verdict to the branch it observes --
    //
    // The reducer tests below drive both arms with synthetic shas. This is the
    // deployed path: a real repo, a real lane worktree at `.worktrees/ticket-7`
    // whose path the loop DERIVES from the ticket number, and the real `next`
    // command reading its own facts. Without it, "the CLI actually supplies the
    // heads" would be prose.
    describe("`next` reads the lane worktree's own HEAD (#248)", () => {
      const repo = join(dir, "bind");
      const wt = join(repo, ".worktrees", "ticket-7");
      const git = (...args: string[]) => {
        const p = Bun.spawnSync(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdout: "pipe", stderr: "pipe" });
        if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
        return new TextDecoder().decode(p.stdout).trim();
      };
      const headOf = (d: string) => new TextDecoder().decode(Bun.spawnSync(["git", "-C", d, "rev-parse", "HEAD"], { stdout: "pipe" }).stdout).trim();

      // One fixture, both arms: the verdict is stamped on `gated`, then the
      // branch takes another commit under it.
      let gated = "";
      let moved = "";
      function setup(): void {
        if (gated) return;
        mkdirSync(repo, { recursive: true });
        git("init", "-q");
        writeFileSync(join(repo, "a.txt"), "one\n");
        git("add", "-A");
        git("commit", "-qm", "base");
        git("worktree", "add", "-q", join(".worktrees", "ticket-7"), "-b", "z/ticket-7");
        gated = headOf(wt);
        writeFileSync(join(wt, "a.txt"), "two\n");
        expect(Bun.spawnSync(["git", "-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-aqm", "after the gate"]).exitCode).toBe(0);
        moved = headOf(wt);
        expect(moved).not.toBe(gated);
      }

      // `next` run FROM the repo root, exactly as z-loop/SKILL.md runs it.
      const runNext = (commit: string) => {
        setup();
        const sp = join(repo, `next-${commit.slice(0, 7)}.json`);
        writeFileSync(sp, JSON.stringify(state([ticket(7, "Review")], [lane(7, "reviewer", { outcome: approve(100), mergeGate: { ...GREEN_GATE, commit } })])));
        const proc = Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "loop.ts"), "next", sp], { cwd: repo, stdout: "pipe", stderr: "pipe" });
        expect(proc.exitCode).toBe(0);
        return JSON.parse(proc.stdout.toString()) as Action;
      };

      test("a verdict naming the branch's current HEAD advances to merge", () => {
        setup();
        expect(runNext(moved)).toMatchObject({ kind: "advance", ticket: 7, to: "merge" });
      });

      test("a verdict naming the commit the branch has since MOVED off does not advance -- it re-gates", () => {
        setup();
        const a = runNext(gated);
        expect(a).toEqual({ kind: "merge-gate", ticket: 7 });
      });

      // The lane bind, on the deployed path: this repo's OWN worktree is at
      // `.worktrees/ticket-7` on `z/ticket-7`, and a gate pointed anywhere else
      // cannot stamp #7 -- which is what stops the re-gate above from becoming
      // a loop.
      test("the stamping form accepts this lane's worktree and refuses the repo root", () => {
        setup();
        const sp = join(repo, "bind-state.json");
        const write = () => writeFileSync(sp, JSON.stringify(state([ticket(7, "Review")], [lane(7, "reviewer", { outcome: approve(100) })])));
        const gate = (target: string) =>
          Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "loop.ts"), "merge-gate", target, "--state", sp, "--ticket", "7", "--retry-wait-ms", "0"], { cwd: repo, stdout: "pipe", stderr: "pipe" });

        write();
        // The repo root is on the DEFAULT branch, not #7's lane branch.
        expect(gate(repo).exitCode).toBe(1);
        expect(JSON.parse(readFileSync(sp, "utf8")).lanes[0].mergeGate.note).toContain("z/ticket-7-");

        write();
        // The lane's own worktree is accepted (green: it defines no scripts, so
        // the gate refuses for THAT reason -- what matters is which reason).
        const own = JSON.parse(gate(wt).stdout.toString());
        expect(own.note).not.toContain("z/ticket-7-");
      });
    });

    // -- the stamping form: the verdict lands on the lane, which is what makes
    // the gate enforceable instead of advisory (QA finding 2).
    // A state.json holding one review-approved lane, ungated.
    function stateFile(name: string): string {
      const p = join(dir, `${name}-state.json`);
      writeFileSync(p, JSON.stringify(state([ticket(7, "Review")], [lane(7, "reviewer", { outcome: approve(100) })])));
      return p;
    }
    const readState = (p: string): LoopState => JSON.parse(readFileSync(p, "utf8"));

    // #248: the stamping form writes onto a LANE, so it only accepts that
    // lane's own worktree -- which means every fixture below that stamps has to
    // be a real git checkout on `z/ticket-<N>-<slug>`, exactly like the real one.
    function laneProject(name: string, body: string | null, ticket = 7): string {
      const p = project(name, body);
      for (const args of [["init", "-q"], ["checkout", "-q", "-b", `z/ticket-${ticket}-${name}`], ["add", "-A"], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"]]) {
        expect(Bun.spawnSync(["git", "-C", p, ...args], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
      }
      return p;
    }

    test("--state/--ticket stamps a GREEN verdict on the lane and the scheduler then advances it to merge", () => {
      const sp = stateFile("stamp-green");
      const proc = runGate(laneProject("stamp-green", PASSING), "--state", sp, "--ticket", "7");
      expect(proc.exitCode).toBe(0);
      const laneAfter = readState(sp).lanes[0];
      expect(laneAfter.mergeGate).toMatchObject({ green: true, failCount: 0 });
      // The attempt marker written BEFORE the gauntlet is cleared by the answer:
      // MERGE_GATE_MAX_RUNS counts CONSECUTIVE SILENT runs, and this one spoke.
      expect(laneAfter.mergeGateRuns).toBeUndefined();
      expect(laneAfter.mergeGateBase).toBe(""); // stamped against the run's merged set
      expect(nextAction(readState(sp), 0)).toMatchObject({ kind: "advance", ticket: 7, to: "merge" });
    });

    test("--state/--ticket stamps a RED verdict and the scheduler parks the lane Blocked with the gate's note", () => {
      const sp = stateFile("stamp-red");
      const proc = runGate(laneProject("stamp-red", FAILING), "--state", sp, "--ticket", "7", "--retry-wait-ms", "0");
      expect(proc.exitCode).toBe(1);
      const laneAfter = readState(sp).lanes[0];
      expect(laneAfter.mergeGate).toMatchObject({ green: false, failCount: 1 });
      const a = nextAction(readState(sp), 0);
      expect(a).toMatchObject({ kind: "park", ticket: 7, status: "Blocked" });
      expect((a as { note: string }).note).toContain("1 fail");
    });

    // A gate that cannot RUN is a red gate, not a crashed tick: stamping it red
    // parks the lane instead of leaving `next` to re-issue a command that will
    // fail identically forever.
    test("a missing worktree in the stamping form stamps RED (and parks) instead of erroring out of the tick", () => {
      const sp = stateFile("stamp-missing");
      const proc = runGate(join(dir, "does-not-exist"), "--state", sp, "--ticket", "7");
      expect(proc.exitCode).toBe(1);
      expect(readState(sp).lanes[0].mergeGate).toMatchObject({ green: false });
      expect(readState(sp).lanes[0].mergeGate!.note).toContain("could not run");
      expect(nextAction(readState(sp), 0)).toMatchObject({ kind: "park", ticket: 7, status: "Blocked" });
    });

    // Blocker 2 of the review, closed where it was raised: `merge-gate` took an
    // arbitrary `<worktreePath>` and stamped its verdict onto whatever
    // `--ticket N` named, so the last latent step before `gh pr merge` was
    // "did the agent type the right path". Reproduced end to end -- a gate run
    // against an unrelated directory, then `next` returning
    // {"kind":"advance","ticket":7,"to":"merge"} on it.
    test("the stamping form refuses a worktree that is not the lane's own branch", () => {
      const sp = stateFile("stamp-foreign");
      // A perfectly green project -- and on someone else's lane branch.
      const proc = runGate(laneProject("stamp-foreign", PASSING, 999), "--state", sp, "--ticket", "7");
      expect(proc.exitCode).toBe(1);
      const stamped = readState(sp).lanes[0].mergeGate!;
      expect(stamped.green).toBe(false); // a green tree does NOT buy #7 a green
      expect(stamped.note).toContain("z/ticket-7-");
      expect(nextAction(readState(sp), 0)).toMatchObject({ kind: "park", ticket: 7, status: "Blocked" });
    });

    test("...and a detached checkout, which names no branch at all, is refused the same way", () => {
      const sp = stateFile("stamp-detached");
      // Not a git repo: `rev-parse --abbrev-ref HEAD` answers nothing, which is
      // unprovable, which is refused rather than assumed fine.
      const proc = runGate(project("stamp-detached", PASSING), "--state", sp, "--ticket", "7");
      expect(proc.exitCode).toBe(1);
      expect(readState(sp).lanes[0].mergeGate).toMatchObject({ green: false });
    });

    // The bind is on the STAMPING form only. The read-only form vouches for
    // nothing and writes nowhere, so a merge agent (or a human) can point it at
    // any tree to ask "is this green?" -- which is what it is for.
    test("the read-only form takes any worktree, since it stamps no lane", () => {
      expect(runGate(project("readonly-any", PASSING)).exitCode).toBe(0);
    });

    test("--state without --ticket (or the reverse) is a usage error, never a half-stamped lane", () => {
      const sp = stateFile("stamp-usage");
      expect(runGate(project("stamp-usage", PASSING), "--state", sp).exitCode).toBe(1);
      expect(runGate(project("stamp-usage2", PASSING), "--ticket", "7").exitCode).toBe(1);
      expect(readState(sp).lanes[0].mergeGate).toBeUndefined();
      expect(readState(sp).lanes[0].mergeGateRuns).toBeUndefined();
    });
  });

  // -- the enforcement itself: no advance to merge without a green stamp ------
  //
  // QA finding 2 on the first pass: the gate ran only because the SKILL's prose
  // said to, and the merge prompt then ASSERTED it had returned green. An
  // orchestrator that skipped the step -- the exact prose-compliance failure
  // that produced #132 -- spawned a merge agent carrying a false assurance.
  // These pin the scheduler-side answer: the gate is the only door.
  describe("nextAction refuses the merge stage without a green gate", () => {
    const approved = (over: Partial<LaneState> = {}) =>
      state([ticket(7, "Review")], [lane(7, "reviewer", { outcome: approve(100), ...over })]);

    test("a review-approved lane with NO verdict gets merge-gate, never an advance to merge", () => {
      expect(nextAction(approved(), 0)).toEqual({ kind: "merge-gate", ticket: 7 });
    });

    test("the merge-gate action repeats until a verdict lands -- applying it changes nothing", () => {
      const s = approved();
      const after = applyAction(s, { kind: "merge-gate", ticket: 7 }, 999);
      expect(after).toEqual(s); // pure no-op: the CLI does the work, like check-worker/probe
      expect(nextAction(after, 0)).toEqual({ kind: "merge-gate", ticket: 7 });
    });

    test("a GREEN verdict unlocks the advance to merge, stacked parents intact", () => {
      const s = state(
        [ticket(7, "Review"), ticket(8, "Review", [7])],
        [
          lane(7, "reviewer", { outcome: approve(100), mergeGate: GREEN_GATE }),
          lane(8, "reviewer", { outcome: approve(100), mergeGate: GREEN_GATE }),
        ]
      );
      expect(nextAction(s, 0)).toEqual({ kind: "advance", ticket: 7, to: "merge", stackedOn: [] });
    });

    test("a RED verdict parks the lane Blocked carrying the gate's own note verbatim -- it merges under NO circumstance", () => {
      const red = { green: false, attempts: 1, failCount: 9, note: "merge gate RED on attempt 1: suite summary reports 9 fail (exit 1) -- refusing the merge" };
      expect(nextAction(approved({ mergeGate: red }), 0)).toEqual({ kind: "park", ticket: 7, status: "Blocked", note: red.note });
    });

    // QA finding 1's consequence, handled in code: a gauntlet killed mid-run
    // (a command timeout shorter than the suite) stamps no verdict, so the
    // action simply repeats -- but it must not repeat forever.
    test("gate runs that never return a verdict park the lane after MERGE_GATE_MAX_RUNS, never spin", () => {
      // Pinned to the literal, like MERGE_GATE_RETRY_WAIT_MS: the loop below is
      // written in terms of the constant, so without this line the bound is
      // asserted against itself and 2 -> 99 stays green. This budget is the only
      // thing between a gate whose process keeps dying and an endless drain.
      expect(MERGE_GATE_MAX_RUNS).toBe(2);
      let s = approved();
      for (let i = 1; i <= MERGE_GATE_MAX_RUNS; i++) {
        expect(nextAction(s, 0)).toEqual({ kind: "merge-gate", ticket: 7 });
        s = recordMergeGate(s, 7, null, 0); // an attempt started, then its process died
        expect(s.lanes[0].mergeGateRuns).toBe(i);
      }
      const a = nextAction(s, 0);
      expect(a).toMatchObject({ kind: "park", ticket: 7, status: "Blocked" });
      expect((a as { note: string }).note).toMatch(/never returned a verdict/);
      expect((a as { note: string }).note).toMatch(/timeout/); // names the usual cause
    });

    test("a verdict that DOES land on the second attempt still merges -- only silent runs consume the budget", () => {
      let s = recordMergeGate(approved(), 7, null, 0); // attempt 1 killed
      s = recordMergeGate(s, 7, null, 0); // attempt 2 starts
      s = recordMergeGate(s, 7, GREEN_GATE, 0); // and answers
      expect(nextAction(s, 0)).toMatchObject({ kind: "advance", ticket: 7, to: "merge" });
    });

    test("a bounce back to the builder clears the verdict -- rebuilt code is gated again", () => {
      const s = state([ticket(7, "Review")], [lane(7, "reviewer", { mergeGate: GREEN_GATE, mergeGateRuns: 1, mergeGateBase: "7" })]);
      const bounced = applyAction(s, { kind: "advance", ticket: 7, to: "builder" }, 0);
      expect(bounced.lanes[0].mergeGate).toBeUndefined();
      expect(bounced.lanes[0].mergeGateRuns).toBeUndefined();
      // The base the dropped verdict was about goes with it. Leaving it behind
      // is not currently reachable as a bug -- recordMergeGate overwrites it
      // with every verdict -- but a lane carrying a base for a verdict that no
      // longer exists is a lie in the state file, and #178 exists because a
      // merge was authorised off exactly that kind of stale bookkeeping.
      expect(bounced.lanes[0].mergeGateBase).toBeUndefined();
      // ...while the advance INTO merge keeps it as the audit trail of the permission.
      const merging = applyAction(s, { kind: "advance", ticket: 7, to: "merge" }, 0);
      expect(merging.lanes[0].mergeGate).toEqual(GREEN_GATE);
      expect(merging.lanes[0].mergeGateBase).toBe("7");
    });

    test("recordMergeGate refuses a ticket with no lane instead of silently doing nothing", () => {
      expect(() => recordMergeGate(approved(), 999, GREEN_GATE, 0)).toThrow(ZError);
    });

    // Review finding 4: `delete lane.mergeGate` in recordMergeGate's null branch
    // was unguarded -- every recordMergeGate(s, n, null, ...) in this suite ran
    // on a lane with NO prior verdict, so deleting the line left 362 pass / 0
    // fail. It is the mitigation for the stale-verdict hole below: the moment a
    // new gauntlet starts, the old answer stops speaking.
    test("starting a new gate run DROPS the previous verdict -- a stale green never covers a run in flight", () => {
      const s = recordMergeGate(approved(), 7, GREEN_GATE, 0);
      expect(s.lanes[0].mergeGate).toEqual(GREEN_GATE);
      expect(nextAction(s, 0)).toMatchObject({ kind: "advance", to: "merge" });
      const restarted = recordMergeGate(s, 7, null, 0); // the gauntlet starts again
      expect(restarted.lanes[0].mergeGate).toBeUndefined();
      expect(restarted.lanes[0].mergeGateBase).toBeUndefined();
      // ...and with the verdict gone there is no advance, only another gate run.
      expect(nextAction(restarted, 0)).toEqual({ kind: "merge-gate", ticket: 7 });
    });

    // -- review finding 3: a green verdict does not survive its base moving ----
    //
    // Reproduced: two review-approved lanes, #8 depending on #7, both stamped
    // green at t0. After #7 merged, `next` still returned
    // {"kind":"advance","ticket":8,"to":"merge","stackedOn":[7]} carrying the t0
    // verdict -- the reducer COMPUTED stackedOn from mergedThisRun, so it knew
    // the base had moved, and handed out merge permission on a pre-parent
    // gauntlet anyway. The only re-gate left was the merge prompt's prose Step
    // 0, which is the latent-compliance path this ticket exists to delete.
    describe("a verdict taken on an older base is not permission to merge", () => {
      const stacked = () =>
        state(
          [ticket(7, "Review"), ticket(8, "Review", [7])],
          [lane(7, "reviewer", { outcome: approve(100) }), lane(8, "reviewer", { outcome: approve(100) })]
        );

      test("the fingerprint is the run's merged set, so it moves exactly when the base does", () => {
        expect(mergeGateBaseKey(stacked())).toBe("");
        expect(mergeGateBaseKey({ ...stacked(), mergedThisRun: [7] })).toBe("7");
        // Order-independent: a key that flipped with read order would re-gate forever.
        expect(mergeGateBaseKey({ ...stacked(), mergedThisRun: [8, 7] })).toBe("7,8");
      });

      test("#7 merging invalidates #8's t0 green -- it re-gates instead of advancing", () => {
        let s = stacked();
        s = recordMergeGate(s, 7, GREEN_GATE, 0);
        s = recordMergeGate(s, 8, GREEN_GATE, 0); // both stamped against an empty base
        expect(s.lanes[1].mergeGateBase).toBe("");
        expect(nextAction(s, 0)).toMatchObject({ kind: "advance", ticket: 7, to: "merge" });
        // #7 merges: its lane leaves, mergedThisRun grows, #8's base moved.
        s = applyAction(s, { kind: "advance", ticket: 7, to: "merge" }, 0);
        s = applyAction(s, { kind: "complete", ticket: 7, note: "merged" }, 0);
        expect(s.mergedThisRun).toEqual([7]);
        expect(nextAction(s, 0)).toEqual({ kind: "merge-gate", ticket: 8 });
      });

      test("...and the re-gate's fresh green then advances, carrying the stacked parent", () => {
        let s = stacked();
        s = recordMergeGate(s, 8, GREEN_GATE, 0);
        s = applyAction(s, { kind: "advance", ticket: 7, to: "merge" }, 0);
        s = applyAction(s, { kind: "complete", ticket: 7, note: "merged" }, 0);
        s = recordMergeGate(s, 8, null, 0); // the re-gate starts...
        s = recordMergeGate(s, 8, GREEN_GATE, 0); // ...and answers on the new base
        expect(s.lanes[0].mergeGateBase).toBe("7");
        expect(nextAction(s, 0)).toEqual({ kind: "advance", ticket: 8, to: "merge", stackedOn: [7] });
      });

      // Terminating, which is why the rule is "the base moved" rather than the
      // literal "stackedOn is non-empty": a lane gated AFTER its parent merged
      // keeps stackedOn:[parent] right up until it merges itself, so the literal
      // form would re-gate forever and the drain would never finish.
      test("re-gating is once per base move, never a loop", () => {
        let s = stacked();
        s = applyAction(s, { kind: "advance", ticket: 7, to: "merge" }, 0);
        s = applyAction(s, { kind: "complete", ticket: 7, note: "merged" }, 0);
        s = recordMergeGate(s, 8, GREEN_GATE, 0);
        for (let i = 0; i < 3; i++) {
          expect(nextAction(s, 0)).toMatchObject({ kind: "advance", ticket: 8, to: "merge" });
        }
      });

      // Fail-closed ordering: a RED verdict parks Blocked whatever the base did.
      // Re-gating a red lane would spend another full gauntlet to reach the same
      // refusal.
      test("a red verdict on a stale base still parks Blocked, it does not re-gate", () => {
        const red = { green: false, attempts: 2, failCount: 9, note: "merge gate RED on attempt 2: suite summary reports 9 fail (exit 1) -- refusing the merge" };
        let s = stacked();
        s = recordMergeGate(s, 8, red, 0);
        s = applyAction(s, { kind: "advance", ticket: 7, to: "merge" }, 0);
        s = applyAction(s, { kind: "complete", ticket: 7, note: "merged" }, 0);
        expect(nextAction(s, 0)).toEqual({ kind: "park", ticket: 8, status: "Blocked", note: red.note });
      });

      // The base-move check reads `mergedThisRun`, which `complete` was the only
      // writer of -- so a merge that resolved through `stop-lane` instead (a
      // human dragging the merging card to Done mid-run) dropped the lane
      // without recording it, the base key stayed "", and every waiting lane's
      // pre-parent green stayed live merge permission. Reproduced end to end:
      // #8 depends on #7, both stamped at t0, #7 resolved by stop-lane, and #8
      // still advanced with `stackedOn:[]` -- the reducer no longer even aware
      // its parent had landed.
      test("a merge that resolves through stop-lane still moves the base (it is not only `complete`)", () => {
        // #7 is in the merge stage and its card is already Done -- the human
        // moved it mid-run, so the lane resolves by stop-lane rather than by
        // `complete`. #8 depends on it and was stamped green at t0.
        let s = state(
          [ticket(7, "Done"), ticket(8, "Review", [7])],
          [lane(7, "merge", { outcome: { kind: "merged", note: "https://x/1" } }), lane(8, "reviewer", { outcome: approve(100) })]
        );
        s = recordMergeGate(s, 8, GREEN_GATE, 0);
        expect(s.lanes[1].mergeGateBase).toBe("");
        const stop = nextAction(s, 0);
        expect(stop).toMatchObject({ kind: "stop-lane", ticket: 7 });
        s = applyAction(s, stop, 0);
        expect(s.mergedThisRun).toEqual([7]); // the landing is recorded, not lost with the lane
        expect(nextAction(s, 0)).toEqual({ kind: "merge-gate", ticket: 8 }); // ...so #8 re-gates
      });

      test("a stop-lane at any OTHER stage records nothing -- only a merge-stage lane on a Done ticket landed", () => {
        const s = state([ticket(7, "Done")], [lane(7, "qa", { outcome: { kind: "qa-pass" } })]);
        const stop = nextAction(s, 0);
        expect(stop).toMatchObject({ kind: "stop-lane", ticket: 7 });
        expect(applyAction(s, stop, 0).mergedThisRun ?? []).toEqual([]);
      });

      test("...and a merge-stage lane whose ticket is NOT Done records nothing either", () => {
        const s = state([ticket(7, "Blocked")], [lane(7, "merge", { outcome: { kind: "merged", note: "https://x/1" } })]);
        const stop = nextAction(s, 0);
        expect(stop).toMatchObject({ kind: "stop-lane", ticket: 7 });
        expect(applyAction(s, stop, 0).mergedThisRun ?? []).toEqual([]);
      });

      // MERGE_GATE_MAX_RUNS bounds CONSECUTIVE silent attempts. Without the
      // reset, a lane legitimately re-gated once per base move would trip the
      // "started N times and never returned a verdict" park on the strength of
      // runs that all returned one.
      test("an answered attempt clears the silent-run budget", () => {
        let s = approved();
        s = recordMergeGate(s, 7, null, 0); // killed
        s = recordMergeGate(s, 7, null, 0); // killed -- at the cap now
        s = recordMergeGate(s, 7, null, 0);
        s = recordMergeGate(s, 7, GREEN_GATE, 0); // ...but this one answered
        expect(s.lanes[0].mergeGateRuns).toBeUndefined();
        expect(nextAction(s, 0)).toMatchObject({ kind: "advance", ticket: 7, to: "merge" });
      });
    });

    // -- #248: the verdict is bound to the commit it was measured on ----------
    //
    // `MergeGateVerdict.commit` was written by the gate and read by NOBODY, so
    // a green stamp taken on commit A authorized a merge of commit B. The base
    // check above covers the base moving under a stamp; this covers the stamp
    // not being about this branch at all -- reproduced by running
    // `merge-gate <someOtherWorktree> --state st.json --ticket 8` and watching
    // `next` hand out {"kind":"advance","ticket":8,"to":"merge"} on it.
    describe("a green verdict measured on a different commit is not permission to merge (#248)", () => {
      const HEAD = "a".repeat(40);
      const OTHER = "b".repeat(40);
      const gateOn = (commit: string) => ({ ...GREEN_GATE, commit });

      test("the stamped commit IS the head: advance, unchanged", () => {
        const s = approved({ mergeGate: gateOn(HEAD) });
        expect(nextAction(s, 0, { 7: HEAD })).toEqual({ kind: "advance", ticket: 7, to: "merge", stackedOn: [] });
      });

      test("the stamped commit is NOT the head: no advance, a re-gate", () => {
        const s = approved({ mergeGate: gateOn(OTHER) });
        // The whole point: it is not merely "not advanced", it is never `merge`.
        expect(nextAction(s, 0, { 7: HEAD })).toEqual({ kind: "merge-gate", ticket: 7 });
      });

      // A re-gate rather than a park, and the reason is the CHAIN. Parking here
      // does not cost one lane, it costs every lane behind it: `deadMergeReady`
      // parks each dependent of a Blocked ticket, so one recoverable mismatch
      // at the head of a stack ends the drain for the whole stack. A branch
      // that moved is recoverable; the fresh gauntlet resolves it.
      test("the re-gate's fresh verdict on the observed head then advances -- the chain keeps draining", () => {
        let s = approved({ mergeGate: gateOn(OTHER) });
        expect(nextAction(s, 0, { 7: HEAD })).toEqual({ kind: "merge-gate", ticket: 7 });
        s = recordMergeGate(s, 7, null, 0); // the re-gate starts...
        s = recordMergeGate(s, 7, gateOn(HEAD), 0); // ...and answers on the head the loop observed
        expect(nextAction(s, 0, { 7: HEAD })).toMatchObject({ kind: "advance", ticket: 7, to: "merge" });
      });

      // Termination is bought at the CLI, not here: the stamping form refuses a
      // worktree that is not this lane's own (`isLaneBranch`), so the one
      // producer that could hand back the same mismatching verdict forever is
      // gone. What is left is the branch moving, and every re-gate measures the
      // head the loop just observed.
      test("the lane bind is what makes the re-gate terminate, and it is by branch not by path", () => {
        expect(isLaneBranch("z/ticket-7-enforce-the-merge-gate", 7)).toBe(true);
        expect(isLaneBranch("z/ticket-7", 7)).toBe(true);
        expect(isLaneBranch("z/ticket-12-other", 7)).toBe(false); // the separator is load-bearing
        expect(isLaneBranch("main", 7)).toBe(false);
        expect(isLaneBranch("z/ticket-7-x", 8)).toBe(false);
      });

      // Fail-closed in both unprovable directions. Neither is a silent pass:
      // an unbindable verdict is precisely what #248 says is not a gate.
      test("a verdict carrying NO commit is refused, not waved through", () => {
        const a = nextAction(approved({ mergeGate: GREEN_GATE }), 0, { 7: HEAD });
        expect(a).toMatchObject({ kind: "park", ticket: 7, status: "Blocked" });
        expect((a as { note: string }).note).toContain("names no commit");
      });

      test("a head the loop LOOKED for and could not read is refused, not waved through", () => {
        const a = nextAction(approved({ mergeGate: gateOn(HEAD) }), 0, { 7: null });
        expect(a).toMatchObject({ kind: "park", ticket: 7, status: "Blocked" });
        expect((a as { note: string }).note).toContain("could not read a HEAD");
      });

      // The absent-argument arm: reducer-only callers (this suite's own several
      // hundred nextAction calls, the e2e sim) made no observation, so there is
      // nothing to compare and the check does not fire. The production path
      // never lands here -- the `next` CLI always supplies the map, which the
      // CLI test below drives against a real git worktree.
      test("no observation supplied means the binding is not checked (and nothing else changes)", () => {
        expect(nextAction(approved({ mergeGate: gateOn(OTHER) }), 0)).toMatchObject({ kind: "advance", to: "merge" });
      });

      // The cascade this re-gate exists to avoid, driven through the reducer:
      // #8 depends on #7, and parking #7 for a moved branch would park #8 too
      // (`deadMergeReady`), ending the drain for the whole chain instead of the
      // one lane. With the re-gate, #7 recovers and #8 merges behind it.
      test("a mismatch at the head of a dependency chain does not take the chain down with it", () => {
        let s = state(
          [ticket(7, "Review"), ticket(8, "Review", [7])],
          [lane(7, "reviewer", { outcome: approve(100), mergeGate: gateOn(OTHER) }), lane(8, "reviewer", { outcome: approve(100), mergeGate: gateOn(HEAD) })]
        );
        const heads = { 7: HEAD, 8: HEAD };
        expect(nextAction(s, 0, heads)).toEqual({ kind: "merge-gate", ticket: 7 });
        // Had #7 parked, #8 would be next -- and it would park too, on its
        // dependency rather than on anything about its own code.
        const parked = applyAction(s, { kind: "park", ticket: 7, status: "Blocked", note: "x" }, 0);
        expect(nextAction(parked, 0, heads)).toMatchObject({ kind: "park", ticket: 8, status: "Blocked" });
        // Instead: #7 re-gates, merges, and #8 follows it in dependency order.
        s = recordMergeGate(s, 7, null, 0);
        s = recordMergeGate(s, 7, gateOn(HEAD), 0);
        expect(nextAction(s, 0, heads)).toMatchObject({ kind: "advance", ticket: 7, to: "merge" });
      });

      // Ordering pin: RED loses to nothing. A red verdict must park on its own
      // note whatever the commit binding says, or the operator reads "the
      // branch moved" for a lane that actually has 9 failing tests.
      test("a RED verdict parks on the gate's own note even when the commit also mismatches", () => {
        const red = { green: false, attempts: 2, failCount: 9, note: "merge gate RED on attempt 2: suite summary reports 9 fail (exit 1) -- refusing the merge", commit: OTHER };
        expect(nextAction(approved({ mergeGate: red }), 0, { 7: HEAD })).toEqual({ kind: "park", ticket: 7, status: "Blocked", note: red.note });
      });

      // observeLaneHeads is the seam's IO half: it must spend a `git` spawn on
      // exactly the lanes whose verdict can be bound, since `next` runs every
      // tick of the drain.
      test("observeLaneHeads reads only lanes carrying a verdict", () => {
        const s = state(
          [ticket(7, "Review"), ticket(8, "Review")],
          [lane(7, "reviewer", { outcome: approve(100), mergeGate: gateOn(HEAD) }), lane(8, "reviewer", { outcome: approve(100) })]
        );
        const heads = observeLaneHeads(s, join(tmpdir(), "zstack-no-such-repo"));
        expect(Object.keys(heads)).toEqual(["7"]); // #8 has no stamp: nothing to bind, no spawn
        expect(heads[7]).toBeNull(); // looked, could not read -- NOT "fine"
      });

      test("the lane worktree is derived from the ticket number, never taken from a caller", () => {
        expect(laneWorktreePath(7, join("R"))).toBe(join("R", ".worktrees", "ticket-7"));
      });
    });

    test("an ingest preserves a stamped verdict across ticks (the gate is not re-run every tick)", () => {
      const s = recordMergeGate(approved(), 7, GREEN_GATE, 0);
      const after = ingestBoardItems(s, [{ number: 7, title: "Ticket 7", fields: { Status: "Review" } }], { "7": "" });
      expect(after.lanes[0].mergeGate).toEqual(GREEN_GATE);
    });
  });

  // -- doc canary: the SKILL is what the orchestrator actually executes -------
  describe("z-loop/SKILL.md wires the gate as the merge-gate action", () => {
    const skill = () => readFileSync(join(REPO_ROOT, "z-loop", "SKILL.md"), "utf8");

    test("the merge-gate action row runs the STAMPING form of the CLI", () => {
      const md = skill();
      expect(md).toContain('bun "$PACK/lib/loop.ts" merge-gate ".worktrees/ticket-<N>" --state "$STATE" --ticket <N>');
      expect(md).toMatch(/\|\s*`merge-gate N`\s*\|/); // it is an action row, not a step buried in the spawn sequence
    });

    // QA finding 1 (#178): step 2b handed the orchestrator a blocking foreground
    // command with no timeout guidance, so the harness's 120s default killed the
    // very contention retry the gate exists to survive and the lane false-parked.
    test("the row states an explicit generous Bash timeout, well past a full gauntlet", () => {
      const row = skill().split("\n").find((l) => l.startsWith("| `merge-gate N` |"))!;
      expect(row).toMatch(/timeout/i);
      const ms = [...row.matchAll(/`(\d{6,})`/g)].map((m) => Number(m[1]));
      expect(Math.max(...ms)).toBeGreaterThanOrEqual(600_000); // >= 10 min: two full gauntlets + the 15s wait, with room to grow
      expect(row).toContain("120000"); // and names the default it must not inherit
    });

    // QA finding 6: without statePath in the merge stage's input JSON the
    // prompt renders the READ-ONLY gate command, so the agent's own Step 0 --
    // and, worse, its re-run after resolving a conflict -- stamps nothing and
    // the lane keeps a verdict for a commit that no longer exists.
    test("the merge stage's input row supplies statePath, so the agent's own gate run stamps", () => {
      const row = skill().split("\n").find((l) => l.startsWith("| `merge` |"))!;
      expect(row).toContain("`statePath`");
      expect(row).toContain('`"$STATE"`');
      expect(row).toMatch(/STAMPING form/);
    });

    test("a red verdict parks the lane Blocked and no merge agent is ever spawned from this row", () => {
      const row = skill().split("\n").find((l) => l.startsWith("| `merge-gate N` |"))!;
      expect(row).toContain("park N Blocked");
      expect(row).toMatch(/do NOT spawn a merge agent/i);
      expect(row).toMatch(/nonzero exit is EXPECTED/i); // exit 1 on red is the contract, not a tick failure
    });
  });
});

// -- #223: a released foreign claim is re-confirmed, never waited on forever ---
//
// `claimedByOther` is a point-in-time observation of ANOTHER login's assignee
// set. ingest carries it forward on every re-ingest and nothing ever un-set it,
// so once the foreign claim is released the step-6 wait branch's reasoning ("the
// other session will finish and re-ingest will unblock it") is false: the ONE
// input that could clear the flag is the one ingest overwrites with its own
// carried-forward `true`. With zero lanes running, every subsequent tick returns
// `wait` forever -- the one shape drainComplete cannot end. Run 12 hit exactly
// this on #138/#149 and needed a hand-edited state.json to resume.
describe("#223: re-confirming a carried-forward claimedByOther flag", () => {
  const WD = 10; // watchdogMinutes on every fixture here
  const MIN = 60_000;
  const T0 = 1_000_000; // non-zero, so "absent timestamp" is distinguishable from "now"
  // The bounded park's deadline, in ms since the anchor. Derived, never spelled
  // out: it is ABANDONED_CLAIM_TICKET_BUDGETS whole-TICKET budgets (every stage
  // summed), not the throttle's single-stage period, so on this scalar-WD fixture
  // it is 4 stages * WD * 3 = 120 minutes rather than 30.
  const BOUND = abandonedClaimBoundMs(WD);
  // How many throttled asks fit inside it -- the read budget a claim gets before
  // its dependents are Blocked.
  const ASKS_BEFORE_PARK = BOUND / (WD * MIN);
  const CLI_DIR = mkdtempSync(join(tmpdir(), "zstack-223-cli-"));
  afterAll(() => rmSync(CLI_DIR, { recursive: true, force: true }));

  // The livelock shape: #1 flagged claimedByOther, #2 depends on it, both Ready,
  // no lanes -- nothing claimable, nothing in flight, work remaining.
  const livelock = (over: Partial<TicketSnapshot> = {}) =>
    state([ticket(1, "Ready", [], { claimedByOther: true, ...over }), ticket(2, "Ready", [1])], [], 3, WD);

  // A flag already confirmed foreign once (the state claimConfirmed leaves
  // behind). A RECORDED CONFIRM ATTEMPT -- claimConfirmingSince -- is the only
  // thing the bounded park will ever act on.
  const confirmedForeign = (login = "someone-else") =>
    livelock({ claimedByOtherAt: T0, claimConfirmingSince: T0, claimedByOtherLogin: login });

  const boardItem = (n: number, status: BoardStatus) => ({ number: n, title: `Ticket ${n}`, fields: { Status: status } });
  const BODIES = { "1": "no deps", "2": "Depends on #1" };

  test("AC1: the livelock -- the flag waits, and a re-ingest showing #1 plain Ready still waits", () => {
    const s = livelock({ claimedByOtherAt: T0, claimConfirmingSince: T0 });
    expect(nextAction(s, T0 + MIN)).toEqual({ kind: "wait" });
    // The bulk board read carries no assignees at all, so a snapshot in which #1
    // is simply Ready is NOT evidence the claim was released -- ingest must keep
    // carrying the flag (dropping it would re-claim another session's ticket).
    // That carry is precisely what pinned the wait forever.
    const re = ingestBoardItems(s, [boardItem(1, "Ready"), boardItem(2, "Ready")], BODIES);
    expect(re.tickets[0].claimedByOther).toBe(true);
    expect(re.tickets[1].dependsOn).toEqual([1]);
    expect(nextAction(re, T0 + 2 * MIN)).toEqual({ kind: "wait" });
    // ...and this is the half that fails against main: the wait is no longer
    // permanent. One watchdog period on, the loop asks the board instead of
    // believing its own stale observation for the rest of the run.
    expect(nextAction(re, T0 + WD * MIN)).toEqual({ kind: "confirm-claim", ticket: 1 });
  });

  test("AC1b: ingest carries the #223 stamps forward, not just the boolean", () => {
    // Dropping them would reset the confirm throttle and the bounded wait on
    // every single tick -- a read storm, and a bound that never arrives.
    const re = ingestBoardItems(confirmedForeign(), [boardItem(1, "Ready"), boardItem(2, "Ready")], BODIES);
    expect(re.tickets[0]).toMatchObject({
      claimedByOther: true,
      claimedByOtherAt: T0,
      claimConfirmingSince: T0,
      claimedByOtherLogin: "someone-else",
    });
  });

  test("AC2: the confirm fires at the watchdog boundary and not before (one read per period)", () => {
    const s = livelock({ claimedByOtherAt: T0, claimConfirmingSince: T0 });
    expect(nextAction(s, T0 + (WD - 1) * MIN)).toEqual({ kind: "wait" });
    expect(nextAction(s, T0 + WD * MIN)).toEqual({ kind: "confirm-claim", ticket: 1 });
  });

  test("AC2b: a state file predating #223 (no stamps at all) confirms rather than waiting or parking", () => {
    // The upgrade path for a run already wedged: absent timestamps read as
    // epoch-old, and with no confirmed login the bounded park cannot fire, so
    // the first tick after the upgrade asks the board.
    expect(nextAction(livelock(), T0)).toEqual({ kind: "confirm-claim", ticket: 1 });
  });

  test("AC3: an empty assignee set clears the flag and #1 becomes claimable", () => {
    const now = T0 + WD * MIN;
    const s = claimConfirmed(livelock({ claimedByOtherAt: T0, claimConfirmingSince: T0 }), 1, [], "me", now);
    for (const k of ["claimedByOther", "claimedByOtherAt", "claimConfirmingSince", "claimedByOtherLogin"]) {
      expect(Object.keys(s.tickets[0])).not.toContain(k);
    }
    expect(nextAction(s, now)).toEqual({ kind: "claim", ticket: 1, stage: "builder" });
  });

  test("AC3b: a set holding only this loop's own login clears it too (Board.claim would succeed)", () => {
    const s = claimConfirmed(livelock({ claimedByOtherAt: T0 }), 1, ["me"], "me", T0 + WD * MIN);
    expect(Object.keys(s.tickets[0])).not.toContain("claimedByOther");
  });

  // AC3, end to end and at the layer the defect actually lives in: two
  // successive ingests, the claim released between them, asserting on
  // claimableTickets (lib/lanes.ts) rather than only on nextAction's verdict.
  // That filter is what excludes a flagged ticket from work; the whole point of
  // the confirm is that its input can now change back.
  test("AC3 end-to-end: ingest, confirm released, re-ingest -- #1 is in claimableTickets and the drain stops waiting", () => {
    const board = [boardItem(1, "Ready"), boardItem(2, "Ready")];
    // Ingest one: the flag stands, #1 is not claimable, #2 depends on it, wait.
    let s = ingestBoardItems(livelock({ claimedByOtherAt: T0, claimConfirmingSince: T0 }), board, BODIES);
    expect(claimableTickets(s.tickets, s.lanes).map((t) => t.number)).toEqual([]);
    expect(nextAction(s, T0 + MIN)).toEqual({ kind: "wait" });
    // A watchdog period on, the loop asks instead of believing itself, and the
    // answer is that nobody holds it any more.
    expect(nextAction(s, T0 + WD * MIN)).toEqual({ kind: "confirm-claim", ticket: 1 });
    s = claimConfirmed(s, 1, [], "me", T0 + WD * MIN);
    // Ingest two carries the cleared flag forward -- there is nothing left to
    // carry -- so #1 is claimable and the drain moves.
    s = ingestBoardItems(s, board, BODIES);
    expect(s.tickets[0].claimedByOther).toBeUndefined();
    expect(claimableTickets(s.tickets, s.lanes).map((t) => t.number)).toEqual([1]);
    const next = nextAction(s, T0 + (WD + 1) * MIN);
    expect(next).toEqual({ kind: "claim", ticket: 1, stage: "builder" });
  });

  // #256 turned watchdogMinutes into a scalar OR a per-stage object. The confirm
  // clock has no stage of OUR own -- nobody here is running anything -- but the
  // holder's stage is readable from the dep's board status, and that is the
  // budget the holding lane is actually working to.
  describe("the confirm clock under a per-stage watchdog config (#256)", () => {
    const PER_STAGE = { builder: 30, qa: 5, reviewer: 40, merge: 15 };
    const flaggedAt = (status: string) =>
      ({
        ...state(
          [ticket(1, status as never, [], { claimedByOther: true, claimedByOtherAt: T0, claimConfirmingSince: T0 }), ticket(2, "Ready", [1])],
          [],
          3,
          WD
        ),
        watchdogMinutes: PER_STAGE,
      }) as LoopState;

    test("resolves the HOLDER's stage from the dep's own status, not a hardcoded builder", () => {
      // Review-time review finding: a claim is taken at whatever stage the ticket
      // resumes at (lanes.ts CLAIMABLE_STAGE), so the holder can be a qa or
      // reviewer lane. Keying every foreign claim to `builder` judged a live
      // reviewer against 30 minutes instead of 40 and asked -- then parked --
      // while it was still inside its own watchdog.
      expect(nextAction(flaggedAt("Ready"), T0 + 29 * MIN)).toEqual({ kind: "wait" });
      expect(nextAction(flaggedAt("Ready"), T0 + 30 * MIN)).toEqual({ kind: "confirm-claim", ticket: 1 });
      expect(nextAction(flaggedAt("QA"), T0 + 4 * MIN)).toEqual({ kind: "wait" }); // qa: 5
      expect(nextAction(flaggedAt("QA"), T0 + 5 * MIN)).toEqual({ kind: "confirm-claim", ticket: 1 });
      expect(nextAction(flaggedAt("Review"), T0 + 39 * MIN)).toEqual({ kind: "wait" }); // reviewer: 40
      expect(nextAction(flaggedAt("Review"), T0 + 40 * MIN)).toEqual({ kind: "confirm-claim", ticket: 1 });
    });

    test("a status outside CLAIMABLE_STAGE falls back to the builder budget instead of throwing", () => {
      // Reachable: the flag rides forward on ingest independently of status, and
      // the other session (or a human) can move the ticket to Backlog. Backlog is
      // neither claimable nor terminal, so step 4's dead-dep park does not catch
      // it first and it reaches wdFor with no stage of its own to resolve.
      expect(nextAction(flaggedAt("Backlog"), T0 + 29 * MIN)).toEqual({ kind: "wait" }); // builder: 30
      expect(nextAction(flaggedAt("Backlog"), T0 + 30 * MIN)).toEqual({ kind: "confirm-claim", ticket: 1 });
    });

    // -- the bound does NOT share that resolver (#223 review) -------------------
    test("the bound sums EVERY stage budget: a claim covers a whole ticket, not one stage of one", () => {
      // Keying the bound to the holder's current stage bounded a whole foreign
      // TICKET by one of its stages. On the pack's own defaults that is 3*25 = 75
      // minutes, against a single-stage ceiling of STAGE_CEILING_MINUTES (480) in
      // the very same file -- so a healthy sibling loop, doing nothing wrong, had
      // its dependents parked Blocked about an hour in and a human had to move
      // them back. The bound is now 3 * (30+5+40+15) whatever the holder is doing.
      const bound = abandonedClaimBoundMs(PER_STAGE);
      expect(bound).toBe(ABANDONED_CLAIM_TICKET_BUDGETS * (30 + 5 + 40 + 15) * MIN);
      const foreign = claimConfirmed(flaggedAt("Review"), 1, ["someone-else"], "me", T0 + 40 * MIN);
      expect(nextAction(foreign, T0 + 120 * MIN)).toEqual({ kind: "confirm-claim", ticket: 1 }); // the OLD bound
      expect(nextAction(foreign, T0 + bound - MIN)).toEqual({ kind: "confirm-claim", ticket: 1 });
      expect(nextAction(foreign, T0 + bound)).toMatchObject({ kind: "park", ticket: 2, status: "Blocked" });
    });

    test("...so the holder's board status moving cannot retroactively cross the bound", () => {
      // Review -> Ready is an ordinary bounce in the OTHER session. Under a
      // stage-keyed bound the elapsed time accrued against a 40-minute stage was
      // suddenly measured against a 30-minute one, so somebody else's progress
      // parked our dependent. One anchor, one deadline, whatever they are doing.
      const bound = abandonedClaimBoundMs(PER_STAGE);
      for (const status of ["Review", "Ready", "QA", "Building"]) {
        expect(nextAction(flaggedAt(status), T0 + bound - MIN)).toMatchObject({ kind: "confirm-claim", ticket: 1 });
        expect(nextAction(flaggedAt(status), T0 + bound)).toMatchObject({ kind: "park", ticket: 2, status: "Blocked" });
      }
    });
  });

  // -- review findings on this diff -----------------------------------------
  //
  // Six defects an independent review of this branch reproduced against the real
  // reducer. Each case below FAILS without its fix.

  test("a NEW claim loss inherits neither the old anchor nor the old login", () => {
    // Reproduced: a ticket carrying a 10-hour-old claimConfirmingSince and
    // `claimedByOtherLogin: "ghost"` (an earlier claim, confirmed foreign, then
    // cleared) took ONE fresh markClaimLost and parked its dependents Blocked on
    // the very next idle tick -- zero reads spent on the new claim, and the note
    // naming a login that no longer held anything. One step from the hand-edit
    // troubleshooting.md documents. Both fields describe re-confirmation of the
    // PREVIOUS observation; a new observation inherits neither.
    const stale = ticket(1, "Ready", [], { claimConfirmingSince: T0, claimedByOtherLogin: "ghost" });
    const now = T0 + 10 * 60 * MIN;
    const s = markClaimLost(state([stale, ticket(2, "Ready", [1])], [], 3, WD), 1, now);
    expect(Object.keys(s.tickets[0])).not.toContain("claimConfirmingSince");
    expect(Object.keys(s.tickets[0])).not.toContain("claimedByOtherLogin");
    expect(s.tickets[0]).toMatchObject({ claimedByOther: true, claimedByOtherAt: now });
    expect(nextAction(s, now)).toEqual({ kind: "wait" }); // asks before it ever Blocks
  });

  test("a NEW RUN re-earns the bound with a fresh read -- the park is not a one-way door", () => {
    // Reproduced: claimConfirmingSince is set once and cleared only by a
    // successful confirm, so the park survived every future run. The operator
    // did exactly what the park note says ("move it back to Ready once that
    // claim is released") and ten days later the first idle tick re-parked with
    // the same note -- confirm-claim not emitted once across 500 ticks. The
    // remediation the loop itself prints could not work.
    let s = state([ticket(1, "Ready", [], { claimedByOther: true, claimedByOtherAt: T0, claimConfirmingSince: T0, claimedByOtherLogin: "alice" }), ticket(2, "Ready", [1])], [], 3, WD);
    const bound = T0 + BOUND;
    const park = nextAction(s, bound);
    expect(park).toMatchObject({ kind: "park", ticket: 2, status: "Blocked" });
    s = applyAction(s, park, bound); // the run really ends this way
    // A new run: #2 is back to Ready, the prior batch drained.
    s = ingestBoardItems(s, [boardItem(1, "Ready"), boardItem(2, "Ready")], BODIES);
    // The THROTTLE resets, not the anchor. Pass 2 reset the anchor here and that
    // handed the bound back to the context-clear cycle to restart forever; the
    // per-run guarantee this test is about is "spend one read", and the park's
    // second gate (a claimedByOtherAt that exists) is what enforces it.
    expect(Object.keys(s.tickets[0])).not.toContain("claimedByOtherAt");
    expect(s.tickets[0]).toMatchObject({ claimedByOther: true, claimConfirmingSince: T0 }); // flag + bound clock carry
    const tenDaysOn = T0 + 10 * 24 * 60 * MIN;
    expect(nextAction(s, tenDaysOn)).toEqual({ kind: "confirm-claim", ticket: 1 }); // asks first, never re-parks blind
    // ...and once that read is on the record, the run may park again -- so the
    // remediation works (one live read) without the bound becoming unreachable.
    const asked = recordConfirmAttempt(s, 1, tenDaysOn);
    expect(nextAction(asked, tenDaysOn)).toMatchObject({ kind: "park", ticket: 2, status: "Blocked" });
  });

  test("a clock that jumps delays the exits, never removes them", () => {
    // Reproduced: a stamp one hour in the FUTURE (NTP step back, VM restore, a
    // state.json from a faster-clocked machine, a stray --now) made both
    // `nowMs - stamp` differences negative, disabling the confirm AND the park
    // together -- `wait` forever with zero lanes, the pre-#223 spin verbatim.
    // The two exits absorb it in opposite directions, each failing safe.
    const ahead = T0 + 60 * MIN;
    const s = state([ticket(1, "Ready", [], { claimedByOther: true, claimedByOtherAt: ahead, claimConfirmingSince: ahead }), ticket(2, "Ready", [1])], [], 3, WD);
    // Throttle: an untrustworthy stamp is not evidence we read recently -> ask.
    for (const m of [0, 30, 59]) expect(nextAction(s, T0 + m * MIN)).toEqual({ kind: "confirm-claim", ticket: 1 });
    // Bound: not evidence we have been asking a long time either -> clamp, so a
    // clock jump can never Block a dependent early.
    expect(nextAction(s, T0 + 60 * MIN)).toEqual({ kind: "wait" });
    // ...and once wall-clock passes the stamp, normal pacing resumes.
    expect(nextAction(s, ahead + WD * MIN)).toEqual({ kind: "confirm-claim", ticket: 1 });
  });

  test("clearing a flag re-admits the freed ticket to a CAPPED batch", () => {
    // Reproduced end to end: selectBatch filters `!claimedByOther`, so a ticket
    // flagged at cut time was never admitted to batchTickets, and that list only
    // shrinks. Clearing the flag left it workable but OUT OF BATCH, and the very
    // next tick -- immediately after the targeted read this feature exists to
    // spend -- parked the dependent with "Likely a dependency cycle in the
    // batch". There is no cycle.
    const prev = { ...state([ticket(1, "Ready", [], { claimedByOther: true, claimedByOtherAt: T0, claimConfirmingSince: T0 })], [], 3, WD), batchTickets: [] as number[] };
    let s = ingestBoardItems(prev, [boardItem(1, "Ready"), boardItem(2, "Ready")], BODIES, { ticketLimit: 5 });
    expect(s.batchTickets).toEqual([2]); // #1 excluded by the flag
    expect(nextAction(s, T0 + WD * MIN)).toEqual({ kind: "confirm-claim", ticket: 1 });
    s = claimConfirmed(s, 1, [], "me", T0 + WD * MIN);
    expect(s.batchTickets).toEqual([1, 2]);
    expect(claimableTickets(s.tickets, s.lanes, s.batchTickets).map((t) => t.number)).toEqual([1]);
    expect(nextAction(s, T0 + (WD + 1) * MIN)).toEqual({ kind: "claim", ticket: 1, stage: "builder" });
  });

  test("an out-of-batch dep nobody depends on is NOT re-admitted (the cap still means something)", () => {
    const prev = { ...state([ticket(1, "Ready", [], { claimedByOther: true, claimedByOtherAt: T0, claimConfirmingSince: T0 })], [], 3, WD), batchTickets: [] as number[] };
    // #2 does NOT depend on #1 here, so freeing #1 must not widen the cap.
    let s = ingestBoardItems(prev, [boardItem(1, "Ready"), boardItem(2, "Ready")], { "1": "no deps", "2": "no deps" }, { ticketLimit: 5 });
    s = claimConfirmed(s, 1, [], "me", T0 + WD * MIN);
    expect(s.batchTickets).not.toContain(1);
  });

  test("the park note reports the REAL elapsed time, not the bound it crossed", () => {
    // A state carried in from an earlier run can be days past `wd * 3`; printing
    // the constant told an operator the loop had tried more recently than it had.
    const s = state([ticket(1, "Ready", [], { claimedByOther: true, claimedByOtherAt: T0, claimConfirmingSince: T0, claimedByOtherLogin: "alice" }), ticket(2, "Ready", [1])], [], 3, WD);
    const note = (nextAction(s, T0 + 600 * MIN) as { note: string }).note;
    expect(note).toContain("600 minutes after the first confirm attempt");
    expect(note).not.toContain(`${BOUND / MIN} minutes`);
  });

  describe("an unverifiable read may CONFIRM a claim, never CLEAR one", () => {
    // The wrong-ticket check only ran when the read carried a number, so the two
    // number-less shapes were accepted for ANY ticket -- and an empty set is
    // exactly what frees one. Requiring the number outright would reject
    // GitHub's own raw node list, so only the CLEARING direction is refused:
    // `me` is passed by the one state-changing caller and by nobody else.
    test("a number-less read that would clear is refused", () => {
      expect(() => parseAssignees([], 7, "me")).toThrow(/carries no issue number/);
      expect(() => parseAssignees({ assignees: [] }, 7, "me")).toThrow(ZError);
      expect(() => parseAssignees(["me"], 7, "me")).toThrow(/would CLEAR the claim/); // solely-me clears too
    });

    test("a number-less read that would NOT clear still works (the debug shapes survive)", () => {
      expect(parseAssignees(["someone-else"], 7, "me")).toEqual(["someone-else"]);
      expect(parseAssignees({ assignees: [{ login: "someone-else" }] }, 7, "me")).toEqual(["someone-else"]);
    });

    test("a VERIFIED read clears exactly as before", () => {
      expect(parseAssignees({ number: 7, assignees: [] }, 7, "me")).toEqual([]);
      expect(() => parseAssignees({ number: 9, assignees: [] }, 7, "me")).toThrow(/for #9/);
    });

    test("read-only inspection (no `me`) is unchanged -- it cannot clear anything", () => {
      expect(parseAssignees([], 7)).toEqual([]);
      expect(parseAssignees({ assignees: [] }, 7)).toEqual([]);
    });

    test("clearsClaim is the ONE rule, shared by the parser guard and the reducer", () => {
      // Two copies of "would this clear?" could disagree, and the direction they
      // would disagree in is the destructive one.
      for (const [set, me, expected] of [
        [[], "me", true],
        [["me"], "me", true],
        [["someone-else"], "me", false],
        [["me", "someone-else"], "me", false],
      ] as [string[], string, boolean][]) {
        expect(clearsClaim(set, me)).toBe(expected);
        const s = claimConfirmed(livelock({ claimedByOtherAt: T0 }), 1, set, me, T0 + WD * MIN);
        expect(s.tickets[0].claimedByOther === undefined).toBe(expected);
      }
    });
  });

  test("`next` prints the action BEFORE it stamps, so a failed write cannot kill the tick", () => {
    // `next` was a pure reader before this ticket, so nothing was built for it
    // failing a write. atomicWrite rethrows after three retries, and
    // bin/z-loop-tick runs under `set -euo pipefail` -- a stamp that threw
    // before the log took the whole drain down, every tick, for as long as the
    // loop sat in the confirm state.
    const src = readFileSync(join(REPO_ROOT, "lib", "loop.ts"), "utf8");
    const arm = src.slice(src.indexOf('if (cmd === "next")'));
    const body = arm.slice(0, arm.indexOf('if (cmd === "apply")'));
    expect(body.indexOf("console.log(JSON.stringify(action))")).toBeLessThan(
      body.indexOf("recordConfirmAttempt(state, action.ticket, nowMs)")
    );
  });

  test("AC4: a live foreign claim is never stolen -- flag stays, stamp refreshes, drain waits", () => {
    const now = T0 + WD * MIN;
    const s = claimConfirmed(livelock({ claimedByOtherAt: T0, claimConfirmingSince: T0 }), 1, ["someone-else"], "me", now);
    expect(s.tickets[0]).toMatchObject({
      claimedByOther: true,
      claimedByOtherAt: now, // re-stamped
      claimConfirmingSince: T0, // NOT re-stamped: the bounded wait's anchor
      claimedByOtherLogin: "someone-else",
    });
    expect(nextAction(s, now)).toEqual({ kind: "wait" });
    // ...and no second read inside the same window.
    expect(nextAction(s, now + (WD - 1) * MIN)).toEqual({ kind: "wait" });
  });

  test("two people on one issue are both recorded, and both reach the park note", () => {
    const s = claimConfirmed(livelock({ claimedByOtherAt: T0, claimConfirmingSince: T0 }), 1, ["alice", "bob"], "me", T0 + WD * MIN);
    expect(s.tickets[0].claimedByOtherLogin).toBe("alice, bob");
    const note = (nextAction(s, T0 + BOUND) as { note: string }).note;
    expect(note).toContain("alice, bob");
  });

  test("two foreign deps both due for a confirm: the lowest ticket is asked first, one at a time", () => {
    // The park branch is covered below; this is the earlier CONFIRM branch, where
    // both deps are past the throttle but neither is past the bound.
    const s = state(
      [
        ticket(3, "Ready", [], { claimedByOther: true, claimedByOtherAt: T0, claimConfirmingSince: T0 }),
        ticket(1, "Ready", [], { claimedByOther: true, claimedByOtherAt: T0, claimConfirmingSince: T0 }),
        ticket(2, "Ready", [1]),
        ticket(4, "Ready", [3]),
      ],
      [],
      3,
      WD
    );
    expect(nextAction(s, T0 + WD * MIN)).toEqual({ kind: "confirm-claim", ticket: 1 });
  });

  test("AC4b: a mixed set that includes us but is not solely us is still foreign", () => {
    const s = claimConfirmed(livelock({ claimedByOtherAt: T0 }), 1, ["me", "someone-else"], "me", T0 + WD * MIN);
    expect(s.tickets[0]).toMatchObject({ claimedByOther: true, claimedByOtherLogin: "someone-else" });
  });

  test("AC5: the wait is bounded -- 3 watchdogs after the FIRST confirm the dependent parks and the run drains", () => {
    const firstConfirm = T0 + WD * MIN;
    let s = claimConfirmed(livelock({ claimedByOtherAt: T0 }), 1, ["someone-else"], "me", firstConfirm);
    // The clock runs from that first confirm, not from when the flag was set:
    // one whole bound after T0 is still inside the window, so it asks again.
    expect(nextAction(s, T0 + BOUND)).toEqual({ kind: "confirm-claim", ticket: 1 });
    const late = firstConfirm + BOUND;
    // With one confirm on record, AC5's literal trigger is satisfied here too:
    // claimedByOtherAt is itself older than the bound.
    expect(late - s.tickets[0].claimedByOtherAt!).toBeGreaterThanOrEqual(BOUND);
    const park = nextAction(s, late);
    // The park is preferred over one more confirm (that read is due here too).
    expect(park).toMatchObject({ kind: "park", ticket: 2, status: "Blocked" });
    expect((park as { note: string }).note).toContain("someone-else");
    expect((park as { note: string }).note).toContain("#1");
    // Strictly older than the bound, not just at it.
    expect(nextAction(s, late + MIN)).toMatchObject({ kind: "park", ticket: 2, status: "Blocked" });
    s = applyAction(s, park, late);
    expect(nextAction(s, late)).toEqual({ kind: "drain-complete" });
  });

  test("AC5's literal anchor is unsatisfiable under AC5's own premise -- claimConfirmingSince is the only workable one", () => {
    // Why the shipped anchor is claimConfirmingSince and not the claimedByOtherAt
    // AC5's summary sentence names. The two clauses of AC5 cannot both hold of
    // claimedByOtherAt:
    //
    //   "the assignee set still foreign"  =>  confirms keep happening, and Plan
    //                                          step 3 REQUIRES each foreign answer
    //                                          to re-stamp claimedByOtherAt;
    //   "claimedByOtherAt older than wd*3" =>  no confirm for three periods.
    //
    // Drive the AC's own scenario -- Plan step 4's "if the confirm KEEPS COMING
    // BACK FOREIGN" -- and watch the stamp stay young forever while the park
    // still arrives on time. A literal claimedByOtherAt gate would never fire
    // here; the wait would be unbounded, which is the exact opposite of the AC.
    let s = livelock({ claimedByOtherAt: T0 });
    let now = T0;
    let parked: Action | undefined;
    let ageAtPark = -1;
    for (let i = 0; i < 200 && !parked; i++) {
      now += MIN;
      const a = nextAction(s, now);
      if (a.kind === "confirm-claim") s = claimConfirmed(s, a.ticket, ["someone-else"], "me", now); // still foreign
      else if (a.kind === "park") {
        parked = a;
        ageAtPark = now - s.tickets[0].claimedByOtherAt!;
      }
    }
    // AC5's observable outcome, which is what the ticket is actually asking for.
    expect(parked).toMatchObject({ kind: "park", ticket: 2, status: "Blocked" });
    expect((parked as { note: string }).note).toContain("someone-else");
    expect(now).toBe(T0 + WD * MIN + BOUND); // one period to the first ask, then the full bound
    // ...and the proof that its literal trigger could not have produced it.
    expect(ageAtPark).toBeLessThan(BOUND);
    expect(ageAtPark).toBe(WD * MIN); // re-stamped by the most recent foreign answer
  });

  test("AC5b: the bound needs a recorded ATTEMPT -- a flag nobody ever asked about confirms, never parks", () => {
    // Otherwise a dependent is Blocked over a claim the loop never once checked.
    // Two shapes reach here, and both must ask first:
    //   a) a pre-#223 state file, no stamps at all (absent = epoch-old);
    expect(nextAction(livelock(), T0 * 1000)).toEqual({ kind: "confirm-claim", ticket: 1 });
    //   b) the #223 QA pass-2 regression, and the run-12 shape verbatim: a claim
    //      lost through the real markClaimLost path long before the drain first
    //      went idle. Pass 1 anchored the bound on a stamp markClaimLost wrote,
    //      so this parked #2 Blocked having spent zero reads -- turning the
    //      state.json hand-edit this ticket removes into a board move instead.
    const lost = markClaimLost(state([ticket(1, "Building"), ticket(2, "Ready", [1])], [], 3, WD), 1, T0);
    const wayLater = T0 + BOUND * 10;
    expect(nextAction({ ...lost, tickets: [{ ...lost.tickets[0], status: "Ready" }, lost.tickets[1]] }, wayLater)).toEqual({
      kind: "confirm-claim",
      ticket: 1,
    });
  });

  // -- the confirm read itself failing --------------------------------------
  // A confirm that cannot complete (deleted/transferred issue, >10 assignees, a
  // gh auth or rate-limit outage -- lib/board.ts throws on all three) decides
  // nothing about the claim. But it must not leave the state untouched either:
  // claimedByOtherAt is the throttle and claimConfirmingSince is the bound, so a
  // no-op re-emits confirm-claim on EVERY tick with nothing able to end it --
  // a gh call plus an agent turn per tick, strictly worse than the pre-#223
  // wait this ticket removed. Recording the ATTEMPT is also the only thing that
  // keeps the park reachable when the read never succeeds and so never yields a
  // login to name.
  describe("a confirm read that fails", () => {
    test("records the attempt without deciding anything: flag, login and anchor survive", () => {
      const s = recordConfirmAttempt(confirmedForeign(), 1, T0 + WD * MIN);
      expect(s.tickets[0]).toMatchObject({
        claimedByOther: true,
        claimedByOtherLogin: "someone-else", // a failed read is never evidence of release
        claimConfirmingSince: T0, // the bound's anchor is never re-anchored
        claimedByOtherAt: T0 + WD * MIN, // ...but the attempt IS stamped
      });
    });

    test("paces the retry: no second read inside the same watchdog period", () => {
      const at = T0 + WD * MIN;
      const s = recordConfirmAttempt(livelock({ claimedByOtherAt: T0, claimConfirmingSince: T0 }), 1, at);
      expect(nextAction(s, at)).toEqual({ kind: "wait" });
      expect(nextAction(s, at + (WD - 1) * MIN)).toEqual({ kind: "wait" });
      expect(nextAction(s, at + WD * MIN)).toEqual({ kind: "confirm-claim", ticket: 1 });
    });

    test("stamps a never-asked flag's anchors, so the very first failure starts the bound", () => {
      const s = recordConfirmAttempt(livelock(), 1, T0);
      expect(s.tickets[0]).toMatchObject({ claimedByOtherAt: T0, claimConfirmingSince: T0 });
      expect(s.tickets[0].claimedByOtherLogin).toBeUndefined();
    });

    test("is a no-op once the flag is gone (a late failure cannot resurrect a cleared claim)", () => {
      const cleared = claimConfirmed(confirmedForeign(), 1, [], "me", T0 + MIN);
      expect(recordConfirmAttempt(cleared, 1, T0 + 2 * MIN)).toEqual(cleared);
    });

    test("a permanently broken read still ends the run, parking on a bound with no login", () => {
      // Tick hourly for 240 simulated hours, every confirm read failing, starting
      // from a flag that has never been asked about. It must ask at least once
      // (the pass-2 rule) and then stop: pre-#223 this returned `wait` forever,
      // and a login-gated bound would return confirm-claim on all 240 ticks.
      let s: LoopState = livelock({ claimedByOtherAt: T0 });
      const log: Action[] = [];
      let now = T0;
      for (let h = 0; h < 240; h++) {
        now += 60 * MIN;
        const a = nextAction(s, now);
        log.push(a);
        if (a.kind === "drain-complete") break;
        if (a.kind === "confirm-claim") s = recordConfirmAttempt(s, a.ticket, now); // the read threw
        else s = applyAction(s, a, now);
      }
      const confirms = log.filter((a) => a.kind === "confirm-claim").length;
      expect(confirms).toBeGreaterThanOrEqual(1); // the board is always asked before a dependent is Blocked
      expect(confirms).toBeLessThan(5);
      const park = log.find((a) => a.kind === "park") as { note: string } | undefined;
      expect(park).toBeDefined();
      expect(park!.note).toContain("#1");
      expect(park!.note).toContain("no confirm read ever returned"); // no login was ever read
      expect(park!.note).not.toContain("undefined");
      expect(log[log.length - 1]).toEqual({ kind: "drain-complete" });
    });

    test("the pure reducer alone cannot end it -- an unrecorded ask is indistinguishable from no ask", () => {
      // Why the driver has to record the emission. nextAction is pure, so
      // "confirm-claim was emitted and ignored" and "the flag was never asked
      // about" are the SAME state to it, and it must not park on that state
      // (Blocking a dependent over a claim nobody checked is the run-12 wedge in
      // a new costume). Left there, the invariant "at most one confirm per
      // watchdog period" would rest entirely on SKILL.md prose. The next test is
      // the fix; this one pins the reason it is needed.
      const s: LoopState = livelock({ claimedByOtherAt: T0 });
      let now = T0;
      for (let h = 0; h < 240; h++) {
        now += 60 * MIN;
        expect(nextAction(s, now)).toEqual({ kind: "confirm-claim", ticket: 1 });
      }
      // One recorded attempt of ANY kind ends it: that is the whole contract.
      expect(nextAction(recordConfirmAttempt(s, 1, now), now + BOUND)).toMatchObject({
        kind: "park",
        ticket: 2,
        status: "Blocked",
      });
    });
  });

  // -- the driver records its own ask ----------------------------------------
  // AC2 ("at most one confirm per ticket per watchdog period") and AC5 ("the
  // wait is bounded") are unqualified, so neither may depend on the orchestrator
  // obeying z-loop/SKILL.md Step 4. `loop next` stamps the attempt as it hands
  // the action over, which is what makes both hold in code.
  describe("an orchestrator that writes back NOTHING is still throttled and still bounded", () => {
    // Exactly what the `next` CLI verb does, minute by minute: ask, and record
    // the ask. Nothing else is ever written -- no claim-confirmed, no
    // claim-confirm-failed, no read performed at all.
    const drive = (s0: LoopState, ticks: number, stepMs: number) => {
      let s = s0;
      const log: Action[] = [];
      let now = T0;
      for (let i = 0; i < ticks; i++) {
        now += stepMs;
        const a = nextAction(s, now);
        log.push(a);
        if (a.kind === "drain-complete") break;
        s = a.kind === "confirm-claim" ? recordConfirmAttempt(s, a.ticket, now) : applyAction(s, a, now);
      }
      return log;
    };

    test("AC2: one confirm per watchdog period, no read storm, with no answer ever recorded", () => {
      const log = drive(livelock({ claimedByOtherAt: T0 }), 200, MIN); // a tick a minute
      // wd = 10 min, so the first 9 minutes are inside the window and wait; the
      // asks land on the watchdog boundaries and nowhere else.
      expect(log.slice(0, 9).every((a) => a.kind === "wait")).toBe(true);
      const confirmAt = log.map((a, i) => (a.kind === "confirm-claim" ? i + 1 : -1)).filter((i) => i > 0);
      // Minute 10, 20, ... up to the bound -- exactly one per period, then the
      // park takes over. The list is derived so the throttle is asserted against
      // the real budget rather than a copied-out number.
      expect(confirmAt).toEqual(Array.from({ length: ASKS_BEFORE_PARK }, (_, i) => (i + 1) * WD));
    });

    test("AC5: bounded -- ABANDONED_CLAIM_TICKET_BUDGETS budgets after the first ask it parks and drains", () => {
      const log = drive(livelock({ claimedByOtherAt: T0 }), 200, MIN);
      const park = log.find((a) => a.kind === "park") as { ticket: number; note: string } | undefined;
      expect(park).toBeDefined();
      expect(park!.ticket).toBe(2); // the DEPENDENT, never the flagged ticket itself
      expect(park!.note).toContain("#1");
      expect(park!.note).toContain("no confirm read ever returned"); // no login was ever read
      expect(park!.note).not.toContain("undefined");
      expect(log[log.length - 1]).toEqual({ kind: "drain-complete" });
      // One ask per watchdog period for the whole bound, and not one more: the
      // read budget a claim gets before its dependents are Blocked.
      expect(log.filter((a) => a.kind === "confirm-claim").length).toBe(ASKS_BEFORE_PARK);
      expect(ASKS_BEFORE_PARK).toBe(4 * ABANDONED_CLAIM_TICKET_BUDGETS); // four stages, three budgets each
    });

    test("the CLI actually performs that write: a second `next` inside the window waits", () => {
      const statePath = join(CLI_DIR, "confirm-emission.json");
      writeFileSync(statePath, JSON.stringify(livelock({ claimedByOtherAt: T0 })));
      const run = (now: number) => {
        const p = Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "loop.ts"), "next", statePath, "--now", String(now)], {
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(p.exitCode).toBe(0);
        return JSON.parse(p.stdout.toString()) as Action;
      };
      const first = T0 + WD * MIN;
      expect(run(first)).toEqual({ kind: "confirm-claim", ticket: 1 });
      const written = JSON.parse(readFileSync(statePath, "utf8")).tickets[0];
      expect(written).toMatchObject({ claimedByOther: true, claimedByOtherAt: first, claimConfirmingSince: first });
      expect(written.claimedByOtherLogin).toBeUndefined(); // an ask is not an answer
      // Same watchdog period: throttled, no second gh call demanded.
      expect(run(first + (WD - 1) * MIN)).toEqual({ kind: "wait" });
      // ...and the bound arrives without a single outcome ever being written back.
      expect(run(first + BOUND)).toMatchObject({ kind: "park", ticket: 2, status: "Blocked" });
    });

    test("`next` writes NOTHING for any other action (it is a reader everywhere else)", () => {
      const statePath = join(CLI_DIR, "next-readonly.json");
      writeFileSync(statePath, JSON.stringify(livelock({ claimedByOtherAt: T0, claimConfirmingSince: T0 })));
      const before = readFileSync(statePath, "utf8");
      const p = Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "loop.ts"), "next", statePath, "--now", String(T0 + MIN)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(JSON.parse(p.stdout.toString())).toEqual({ kind: "wait" });
      expect(readFileSync(statePath, "utf8")).toBe(before);
    });
  });

  // -- coverage the reviewer's mutation pass found missing ---------------------
  test("two foreign deps park BOTH dependents, lowest ticket first, then drain", () => {
    // Pins `.sort()` on foreignDeps and the per-dep `unclaimed.find(...)`: with a
    // single flagged dep in every other fixture, `unclaimed[0]` and an unsorted
    // scan both survive. Two independent claims, two dependents.
    let s = state(
      [
        ticket(1, "Ready", [], { claimedByOther: true, claimedByOtherAt: T0, claimConfirmingSince: T0, claimedByOtherLogin: "alice" }),
        ticket(3, "Ready", [], { claimedByOther: true, claimedByOtherAt: T0, claimConfirmingSince: T0, claimedByOtherLogin: "bob" }),
        ticket(4, "Ready", [3]),
        ticket(2, "Ready", [1]),
      ],
      [],
      3,
      WD
    );
    const late = T0 + BOUND;
    const first = nextAction(s, late);
    expect(first).toMatchObject({ kind: "park", ticket: 2, status: "Blocked" });
    expect((first as { note: string }).note).toContain("alice");
    s = applyAction(s, first, late);
    const second = nextAction(s, late);
    expect(second).toMatchObject({ kind: "park", ticket: 4, status: "Blocked" });
    expect((second as { note: string }).note).toContain("bob");
    s = applyAction(s, second, late);
    expect(nextAction(s, late)).toEqual({ kind: "drain-complete" });
  });

  test("the park targets the DEPENDENT of the foreign dep, not merely the first unclaimed ticket", () => {
    // #5 is unclaimed and lower-numbered than the real dependent #9, but depends
    // on nothing flagged -- it is in a plain cycle with #6. `unclaimed[0]` would
    // park #5 and leave #9 wedged behind the foreign claim forever.
    const s = state(
      [
        ticket(5, "Ready", [6]),
        ticket(6, "Ready", [5]),
        ticket(8, "Ready", [], { claimedByOther: true, claimedByOtherAt: T0, claimConfirmingSince: T0, claimedByOtherLogin: "alice" }),
        ticket(9, "Ready", [8]),
      ],
      [],
      3,
      WD
    );
    const park = nextAction(s, T0 + BOUND);
    expect(park).toMatchObject({ kind: "park", ticket: 9, status: "Blocked" });
    expect((park as { note: string }).note).toContain("#8");
  });

  test("markClaimLost stamps the throttle ONLY -- a claim loss is not a confirm attempt", () => {
    // The pass-1 bug in one assertion. Stamping the bound's anchor here made the
    // park fire on elapsed time since the claim was LOST rather than time spent
    // re-confirming, so a claim lost before the drain went idle parked its
    // dependents with zero reads spent (AC5b case b).
    let s = markClaimLost(state([ticket(1, "Building"), ticket(2, "Ready", [1])], [], 3, WD), 1, T0);
    expect(s.tickets[0]).toMatchObject({ claimedByOther: true, claimedByOtherAt: T0 });
    expect(s.tickets[0].claimConfirmingSince).toBeUndefined();
    s = markClaimLost(s, 1, T0 + 5 * MIN);
    expect(s.tickets[0].claimedByOtherAt).toBe(T0 + 5 * MIN); // the throttle re-paces
    expect(s.tickets[0].claimConfirmingSince).toBeUndefined();
  });

  test("confirm-claim is a pure no-op on state (the orchestrator performs the read)", () => {
    const s = livelock({ claimedByOtherAt: T0 });
    expect(applyAction(s, { kind: "confirm-claim", ticket: 1 }, T0 + WD * MIN)).toEqual(s);
  });

  test("an unflagged deadlock still parks -- #223 changes nothing about a real cycle", () => {
    const s = state([ticket(1, "Ready", [2]), ticket(2, "Ready", [1])], [], 3, WD);
    expect(nextAction(s, T0)).toMatchObject({ kind: "park", ticket: 1, status: "Blocked", note: expect.stringContaining("deadlock") });
  });

  // -- second review pass on this diff ----------------------------------------
  //
  // Four more defects a review of the branch reproduced against the real reducer
  // and the real CLI. Each case below FAILS without its fix.
  describe("a stamp that is not a time", () => {
    // `null` is what JSON.stringify writes for NaN, and NaN is what a bad `--now`
    // produces -- so this shape reaches disk without anybody hand-editing
    // anything. It is neither "never asked" nor a moment: a bare `!== undefined`
    // gate let it through and `Math.min(null, nowMs)` then read it as epoch 0.
    const nulled = () =>
      livelock({ claimedByOtherAt: null as never, claimConfirmingSince: null as never });

    test("a null anchor confirms -- it can NEVER park (no read was ever recorded)", () => {
      // Measured before the fix: {"kind":"park","ticket":2,...,"30000000 minutes
      // after the first confirm attempt"} on the FIRST idle tick, zero board reads
      // spent -- the invariant tests/safety.test.ts asserts by name, broken by one
      // mistyped flag.
      expect(nextAction(nulled(), T0)).toEqual({ kind: "confirm-claim", ticket: 1 });
      expect(nextAction(nulled(), T0 + BOUND * 100)).toEqual({ kind: "confirm-claim", ticket: 1 });
    });

    test("the next recorded attempt REPAIRS it, so the bound starts from that ask", () => {
      const asked = recordConfirmAttempt(nulled(), 1, T0);
      expect(asked.tickets[0]).toMatchObject({ claimedByOtherAt: T0, claimConfirmingSince: T0 });
      expect(nextAction(asked, T0 + BOUND - MIN)).toEqual({ kind: "confirm-claim", ticket: 1 });
      expect(nextAction(asked, T0 + BOUND)).toMatchObject({ kind: "park", ticket: 2, status: "Blocked" });
    });

    test("a FUTURE anchor is repaired too, or the bound never arrives at all", () => {
      // The pass-1 fix clamped the SUBTRACTION and left the field, but `??=` never
      // overwrites a stamp that merely lies -- so `nowMs - Math.min(stamp, nowMs)`
      // stayed 0 on every tick until the wall clock caught up. Measured against an
      // anchor one year ahead: confirm-claim at +0, +1h, +1d and +30d, the anchor
      // unchanged after three recorded asks, and AC5's park unreachable for a year.
      const ahead = T0 + 365 * 24 * 60 * MIN;
      let s: LoopState = livelock({ claimedByOtherAt: ahead, claimConfirmingSince: ahead });
      expect(nextAction(s, T0)).toEqual({ kind: "confirm-claim", ticket: 1 }); // throttle: ask
      s = recordConfirmAttempt(s, 1, T0);
      expect(s.tickets[0].claimConfirmingSince).toBe(T0); // pulled back to now, not left ahead
      expect(nextAction(s, T0 + BOUND)).toMatchObject({ kind: "park", ticket: 2, status: "Blocked" });
    });

    test("claimConfirmed repairs the same two shapes on a foreign answer", () => {
      for (const anchor of [null as never, T0 + 365 * 24 * 60 * MIN]) {
        const s = claimConfirmed(livelock({ claimedByOtherAt: T0, claimConfirmingSince: anchor }), 1, ["someone-else"], "me", T0);
        expect(s.tickets[0].claimConfirmingSince).toBe(T0);
      }
      // ...and a real anchor is still never re-stamped, or a claim that keeps
      // coming back foreign would push its own deadline forever (AC5's premise).
      const kept = claimConfirmed(livelock({ claimedByOtherAt: T0, claimConfirmingSince: T0 }), 1, ["someone-else"], "me", T0 + 5 * MIN);
      expect(kept.tickets[0].claimConfirmingSince).toBe(T0);
    });

    test("the CLI refuses a non-numeric --now instead of persisting NaN", () => {
      // The boundary fix: `next` PERSISTS this number now, so a garbage clock
      // outlives the command. Rejecting it once here beats defending in five
      // reducers -- and it is the only place `--now` is parsed.
      const statePath = join(CLI_DIR, "bad-now.json");
      writeFileSync(statePath, JSON.stringify(livelock({ claimedByOtherAt: T0 })));
      const before = readFileSync(statePath, "utf8");
      // "" / " " / "0x10" matter as much as "soon": Number() maps them to finite
      // numbers (0, 0, 16), and epoch 0 is the WORST value here -- stampAnchor
      // repairs any anchor that leads the clock down to nowMs, so one `--now ""`
      // would drag every foreign ticket's bound clock to 1970 and park its
      // dependents on the next real tick. An ms epoch is an integer; require that.
      // "-1" belongs on this list for the same reason "" does, and is the sharper
      // case: stampAnchor only pulls back a stamp that LEADS the clock, so a
      // pre-epoch anchor is never repaired and the next real tick sees the whole
      // bound elapsed. 9007199254740993 is past the safe-integer range, where
      // Number() silently rounds to a different value than the operator typed.
      for (const bad of ["soon", "", " ", "0x10", "1e3", "12.5", "NaN", "-1", "-1000000", "9007199254740993"]) {
        const p = Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "loop.ts"), "next", statePath, "--now", bad], {
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(p.exitCode).toBe(1);
        expect(p.stderr.toString()).toMatch(/--now must be a non-negative integer number of MILLISECONDS/);
        expect(readFileSync(statePath, "utf8")).toBe(before); // nothing was written
      }
      // ...and a real millisecond epoch still works.
      const ok = Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "loop.ts"), "next", statePath, "--now", String(T0)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(ok.exitCode).toBe(0);
    });
  });

  test("clearing a flag re-admits the freed ticket to the HUMAN-NEEDED scope, not only the batch", () => {
    // batchTickets is what the loop works; initialBatchTickets (#150) is what
    // humanNeededStatus counts, and its capture predicate excludes claimedByOther
    // exactly like selectBatch does. Growing only the first list built the freed
    // ticket and then could not SEE it: park it Questions and the mid-run "a human
    // is needed" notification counts zero for it, so a drain finishes "clean" with
    // a ticket waiting on a person.
    const prev = { ...state([ticket(1, "Ready", [], { claimedByOther: true, claimedByOtherAt: T0, claimConfirmingSince: T0 })], [], 3, WD), batchTickets: [] as number[] };
    let s = ingestBoardItems(prev, [boardItem(1, "Ready"), boardItem(2, "Ready")], BODIES, { ticketLimit: 5 });
    expect(s.initialBatchTickets).toEqual([2]); // #1 excluded by the flag, same as batchTickets
    s = claimConfirmed(s, 1, [], "me", T0 + WD * MIN);
    expect(s.batchTickets).toEqual([1, 2]);
    expect(s.initialBatchTickets).toEqual([1, 2]);
    // The observable consequence: #1 parks Questions and the safety control sees it.
    s = { ...s, tickets: [{ ...s.tickets[0], status: "Questions" }, s.tickets[1]] };
    expect(humanNeededStatus(s).questions).toBe(1);
    expect(humanNeededStatus(s).tickets.questions).toEqual([1]);
  });

  test("...and on an UNCAPPED run too, which is the default path", () => {
    // Pass 2 nested the safety-control re-admission inside the ticket cap's own
    // guard. DEFAULT_TICKET_LIMIT is 0 and bin/z-loop-tick passes no
    // --ticket-limit, so batchTickets is undefined on an ordinary run and the
    // re-admission never ran: measured, humanNeededStatus counted 0 questions for
    // a freed-then-parked ticket, so a drain finishes "clean" with a person
    // waiting -- unfixed on the path everyone actually uses.
    const prev = state([ticket(1, "Ready", [], { claimedByOther: true, claimedByOtherAt: T0, claimConfirmingSince: T0 })], [], 3, WD);
    let s = ingestBoardItems(prev, [boardItem(1, "Ready"), boardItem(2, "Ready")], BODIES); // no ticketLimit
    expect(s.batchTickets).toBeUndefined(); // uncapped
    expect(s.initialBatchTickets).toEqual([2]); // ...but the safety scope IS captured
    s = claimConfirmed(s, 1, [], "me", T0 + WD * MIN);
    expect(s.initialBatchTickets).toEqual([1, 2]);
    s = { ...s, tickets: [{ ...s.tickets[0], status: "Questions" }, s.tickets[1]] };
    expect(humanNeededStatus(s).questions).toBe(1);
  });

  test("re-admission moves the DENOMINATOR with the numerator, so the gate cannot trip early", () => {
    // initialReadyCount is captured from a readyCount that filters
    // `!claimedByOther`, so a ticket flagged at capture is in NEITHER the
    // numerator's scope nor the denominator. Growing only the scope inflates
    // (blocked+skipped+questions)/initialReadyCount, trips the gate below its
    // configured percent, and latches the fire-once flag -- so the real crossing
    // is never announced.
    const prev = state([ticket(1, "Ready", [], { claimedByOther: true, claimedByOtherAt: T0, claimConfirmingSince: T0 })], [], 3, WD);
    const before = ingestBoardItems(prev, [boardItem(1, "Ready"), boardItem(2, "Ready")], BODIES);
    const after = claimConfirmed(before, 1, [], "me", T0 + WD * MIN);
    expect(after.initialBatchTickets!.length).toBe(before.initialBatchTickets!.length + 1);
    expect(after.initialReadyCount).toBe((before.initialReadyCount ?? 0) + 1); // both sides move
  });

  test("a freed ticket NOBODY in the safety scope depends on is not admitted to it either", () => {
    // Same in-scope-because-something-needs-it rule the cap re-admission uses:
    // it would otherwise pad the denominator with work this batch never owned.
    const prev = state([ticket(1, "Ready", [], { claimedByOther: true, claimedByOtherAt: T0, claimConfirmingSince: T0 })], [], 3, WD);
    const before = ingestBoardItems(prev, [boardItem(1, "Ready"), boardItem(2, "Ready")], { "1": "no deps", "2": "no deps" });
    const after = claimConfirmed(before, 1, [], "me", T0 + WD * MIN);
    expect(after.initialBatchTickets).not.toContain(1);
    expect(after.initialReadyCount).toBe(before.initialReadyCount);
  });

  test("a NEW RUN re-earns the bound even mid-batch: startingFreshBatch is not a run boundary", () => {
    // The one-way-door fix keyed on startingFreshBatch, which is a BATCH
    // predicate. A context-clear resume (#131) and a crash resume both re-enter an
    // UN-DRAINED batch, so drainComplete(prev) is false and the reset never fired:
    // an operator who cleared context over lunch came back to an hours-old anchor
    // and got the dependent Blocked on the first idle tick, no read spent.
    const s0 = { ...livelock({ claimedByOtherAt: T0, claimConfirmingSince: T0 }), runSession: "me-1000" };
    const board = [boardItem(1, "Ready"), boardItem(2, "Ready")];
    // Same run (same session, un-drained batch): nothing resets, the bound stands.
    const same = ingestBoardItems(s0, board, BODIES, { session: "me-1000" });
    expect(same.tickets[0].claimedByOtherAt).toBe(T0);
    expect(nextAction(same, T0 + BOUND)).toMatchObject({ kind: "park", ticket: 2, status: "Blocked" });
    // A new invocation, same un-drained batch: the THROTTLE resets, so the first
    // thing that happens is a board read -- never a park.
    const resumed = ingestBoardItems(s0, board, BODIES, { session: "me-2000" });
    expect(Object.keys(resumed.tickets[0])).not.toContain("claimedByOtherAt");
    expect(resumed.tickets[0]).toMatchObject({ claimedByOther: true, claimConfirmingSince: T0 }); // flag + bound carry
    expect(resumed.runSession).toBe("me-2000");
    expect(nextAction(resumed, T0 + BOUND * 10)).toEqual({ kind: "confirm-claim", ticket: 1 });
    // A caller that passes no session at all behaves exactly as before it existed.
    expect(ingestBoardItems(s0, board, BODIES).tickets[0].claimedByOtherAt).toBe(T0);
    expect(ingestBoardItems(s0, board, BODIES).runSession).toBe("me-1000"); // preserved, not dropped
  });

  test("the context-clear cycle TERMINATES: resuming does not restart the bound", () => {
    // Pass 2's regression, and the sharpest one it produced. Step 5b returns
    // context-clear BEFORE step 6's #223 branch is reached, so a loop that crosses
    // contextTokenLimit while waiting out the bound exits and resumes with a fresh
    // SESSION. With the anchor reset per run, the clock restarted every time:
    // measured at 6 resumes / 360 minutes against a 120-minute bound with no park
    // -- the #223 livelock, restored by the fix meant to remove it.
    let s: LoopState = livelock({ claimedByOtherAt: T0, claimConfirmingSince: T0 });
    const board = [boardItem(1, "Ready"), boardItem(2, "Ready")];
    let now = T0;
    let parked = false;
    let confirms = 0;
    for (let run = 1; run <= 6 && !parked; run++) {
      s = ingestBoardItems(s, board, BODIES, { session: `me-${run}` }); // a new invocation
      for (let i = 0; i < 30 && !parked; i++) {
        now += MIN;
        const a = nextAction(s, now);
        if (a.kind === "park") parked = true;
        else if (a.kind === "confirm-claim") { confirms++; s = recordConfirmAttempt(s, a.ticket, now); }
      }
    }
    expect(parked).toBe(true);
    expect(now - T0).toBeLessThanOrEqual(BOUND + 30 * MIN); // the bound accrued ACROSS the resumes
    expect(confirms).toBeGreaterThanOrEqual(3); // ...and each run still spent its own read
  });

  test("the UPGRADE path: a state file with an anchor but NO runSession asks once, then parks", () => {
    // The shape this meets in the field: a run already in flight when the build
    // changed under it, so `state.json` carries a live anchor and no runSession.
    // `newRun` is true on that first tick even though the run did not change --
    // and that is now cheap and correct, because it costs one read rather than a
    // whole fresh bound.
    const legacy = livelock({ claimedByOtherAt: T0, claimConfirmingSince: T0 }); // no runSession
    expect(legacy.runSession).toBeUndefined();
    const board = [boardItem(1, "Ready"), boardItem(2, "Ready")];
    const first = ingestBoardItems(legacy, board, BODIES, { session: "me-1000" });
    expect(Object.keys(first.tickets[0])).not.toContain("claimedByOtherAt");
    expect(first.tickets[0].claimConfirmingSince).toBe(T0); // the bound clock is NOT thrown away
    expect(first.runSession).toBe("me-1000");
    expect(nextAction(first, T0 + BOUND * 10)).toEqual({ kind: "confirm-claim", ticket: 1 }); // asks, never parks
    // Second tick of the SAME run: the session matches, nothing resets, and the
    // already-expired bound is allowed to fire now that a read is on the record.
    const asked = recordConfirmAttempt(first, 1, T0 + BOUND);
    const second = ingestBoardItems(asked, board, BODIES, { session: "me-1000" });
    expect(second.tickets[0].claimConfirmingSince).toBe(T0);
    expect(nextAction(second, T0 + BOUND)).toMatchObject({ kind: "park", ticket: 2, status: "Blocked" });
  });

  test("abandonedClaimBoundMs fills a PARTIAL per-stage config from the defaults", () => {
    // resolveWatchdogMinutes defaults each missing key, and the bound sums all
    // four -- so a config naming one stage must not shorten the bound to that
    // stage. `{qa: 5}` is qa 5 plus the three DEFAULT_STAGE_WATCHDOG_MINUTES.
    const { builder, reviewer, merge } = DEFAULT_STAGE_WATCHDOG_MINUTES;
    expect(abandonedClaimBoundMs({ qa: 5 })).toBe(
      ABANDONED_CLAIM_TICKET_BUDGETS * (builder + 5 + reviewer + merge) * MIN
    );
    // An empty object is every default, and equals the no-config bound.
    expect(abandonedClaimBoundMs({})).toBe(
      ABANDONED_CLAIM_TICKET_BUDGETS * (builder + DEFAULT_STAGE_WATCHDOG_MINUTES.qa + reviewer + merge) * MIN
    );
  });

  test("re-admitting a ticket already in the human-needed scope is a no-op, not a duplicate", () => {
    // Reachable: a ticket Ready-and-unbuilt when the batch was cut IS captured in
    // initialBatchTickets, and can still be foreign-claimed later in the run and
    // then released. Re-admission must dedup, or the safety control's denominator
    // counts it twice.
    const prev = {
      ...state([ticket(1, "Ready"), ticket(2, "Ready", [1])], [], 3, WD),
      batchTickets: [1, 2],
      initialBatchTickets: [1, 2],
    };
    const lost = markClaimLost(prev, 1, T0); // flagged AFTER capture, so it is in both lists
    const freed = claimConfirmed(lost, 1, [], "me", T0 + WD * MIN);
    expect(freed.batchTickets).toEqual([1, 2]);
    expect(freed.initialBatchTickets).toEqual([1, 2]);
  });

  test("re-admission on a pre-#150 state file (no initialBatchTickets) does not throw", () => {
    // undefined there means humanNeededStatus already falls back to counting every
    // ticket, so there is no number to add -- but spreading `undefined` would
    // throw, taking the tick down on the one read this feature exists to spend.
    const prev = { ...state([ticket(1, "Ready", [], { claimedByOther: true, claimedByOtherAt: T0 }), ticket(2, "Ready", [1])], [], 3, WD), batchTickets: [2] };
    delete (prev as { initialBatchTickets?: number[] }).initialBatchTickets;
    const freed = claimConfirmed(prev as LoopState, 1, [], "me", T0 + WD * MIN);
    expect(freed.batchTickets).toEqual([1, 2]);
    expect(freed.initialBatchTickets).toBeUndefined();
    expect(nextAction(freed, T0 + WD * MIN)).toEqual({ kind: "claim", ticket: 1, stage: "builder" });
  });

  test("claimConfirmed stamps an ABSENT anchor on a foreign answer (the other caller's path)", () => {
    // recordConfirmAttempt's equivalent is covered above; this is the same rule
    // reached through the answer rather than the ask, and it is what makes a
    // foreign read start the bound when `next` never got to stamp it.
    const s = claimConfirmed(livelock({ claimedByOtherAt: T0 }), 1, ["someone-else"], "me", T0 + WD * MIN);
    expect(s.tickets[0].claimConfirmingSince).toBe(T0 + WD * MIN);
  });

  describe("parseAssignees: the fail-closed edge (an empty set CLEARS a claim)", () => {
    test("accepts the z-board shape, GitHub's node shape, and a bare login list", () => {
      expect(parseAssignees({ number: 1, assignees: ["a", "b"] }, 1)).toEqual(["a", "b"]);
      expect(parseAssignees({ assignees: [{ login: "a" }] }, 1)).toEqual(["a"]);
      expect(parseAssignees(["a"], 1)).toEqual(["a"]);
      expect(parseAssignees({ assignees: [] }, 1)).toEqual([]);
    });

    test("anything unreadable throws instead of degrading to unassigned", () => {
      for (const bad of [null, undefined, {}, "", 7, { assignees: {} }]) {
        expect(() => parseAssignees(bad, 1)).toThrow(ZError);
      }
      expect(() => parseAssignees({ assignees: [{ name: "a" }] }, 1)).toThrow(/no login/);
      expect(() => parseAssignees([""], 1)).toThrow(/no login/);
    });

    // READABLE-BUT-WRONG is the other half of the same boundary, and the more
    // dangerous one: an EMPTY set read for the wrong issue clears a live foreign
    // claim exactly as a misparse would. z-board assignees prints the number it
    // read for precisely this check; discarding it left the sanctioned path --
    // the only one the orchestrator row actually produces -- wide open.
    test("a read for a DIFFERENT ticket is refused, empty set or not", () => {
      expect(() => parseAssignees({ number: 999, assignees: [] }, 1)).toThrow(/for #999 but it is being applied to #1/);
      expect(() => parseAssignees({ number: 999, assignees: ["x"] }, 1)).toThrow(ZError);
      expect(() => parseAssignees({ number: "1", assignees: [] }, 1)).toThrow(ZError); // a string 1 is not #1
    });

    test("a read that carries no number is still accepted (the debug shapes cannot be checked)", () => {
      expect(parseAssignees({ assignees: [] }, 7)).toEqual([]);
      expect(parseAssignees([], 7)).toEqual([]);
    });
  });
});
