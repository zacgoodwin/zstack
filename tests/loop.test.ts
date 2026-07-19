// Gate tests for C6's deterministic core: the loop state machine (lib/loop.ts)
// and lane scheduling (lib/lanes.ts), driven entirely against in-memory fixture
// snapshots -- no network, no real agents, no wall clock (nowMs injected
// everywhere). Covers the issue #8 acceptance criteria that are unit-testable:
// lane cap (AC2), fresh-stage lane state (AC4), watchdog -> Skipped (AC5),
// Questions never claimable (AC6), plus dependency-order claiming, merge
// ordering with a stacked chain, and drain-complete detection.
import { test, expect, describe, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyAction,
  canTransition,
  drainComplete,
  ingestBoardItems,
  markClaimLost,
  nextAction,
  parseStageResult,
  recordOutcome,
  recordProbe,
  ZError,
  type Action,
  type LaneState,
  type LoopState,
  type Stage,
  type TicketSnapshot,
} from "../lib/loop.ts";
import {
  claimableTickets,
  mergeOrder,
  parseDependsOn,
  watchdogExpired,
} from "../lib/lanes.ts";

const REPO_ROOT = join(import.meta.dir, "..");

// -- fixture builders ---------------------------------------------------------

function ticket(number: number, status: TicketSnapshot["status"], dependsOn: number[] = [], over: Partial<TicketSnapshot> = {}): TicketSnapshot {
  return { number, title: `Ticket ${number}`, status, dependsOn, model: "sonnet", ...over };
}

function lane(ticketNumber: number, stage: Stage, over: Partial<LaneState> = {}): LaneState {
  return { ticket: ticketNumber, stage, lastActivityMs: 0, qaBounces: 0, ...over };
}

function state(tickets: TicketSnapshot[], lanes: LaneState[] = [], maxLanes = 3, watchdogMinutes = 10): LoopState {
  return { tickets, lanes, maxLanes, watchdogMinutes, mergedThisRun: [] };
}

const OPTS = (s: LoopState, nowMs = 0) => ({
  nowMs,
  maxLanes: s.maxLanes,
  watchdogMinutes: s.watchdogMinutes,
  mergedThisRun: s.mergedThisRun,
});

// The happy-path final message per stage, for simulation.
const HAPPY: Record<Stage, string> = {
  builder: "BUILT: all criteria pass",
  qa: "QA-PASS: functional + technical green",
  reviewer: "REVIEW-APPROVE: diff satisfies every criterion",
  merge: "MERGED: https://github.com/x/y/pull/1",
};

// Drives the state machine to drain, feeding every stage a happy-path outcome.
// Returns the action log and the peak concurrent-lane count.
function drainHappy(s: LoopState): { state: LoopState; log: Action[]; maxConcurrent: number } {
  const log: Action[] = [];
  let maxConcurrent = 0;
  for (let i = 0; i < 500; i++) {
    const a = nextAction(s.tickets, s.lanes, OPTS(s));
    log.push(a);
    if (a.kind === "drain-complete") return { state: s, log, maxConcurrent };
    if (a.kind === "wait") {
      const idle = s.lanes.find((l) => !l.outcome);
      if (!idle) throw new Error("wait with no lane to progress -- scheduler stuck");
      s = recordOutcome(s, idle.ticket, HAPPY[idle.stage], 0);
      continue;
    }
    if (a.kind === "check-worker") throw new Error("unexpected watchdog in happy path");
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
    const a = nextAction(s.tickets, s.lanes, OPTS(s));
    expect(a).toEqual({ kind: "claim", ticket: 50, stage: "qa" });
    const s2 = applyAction(s, a, 0);
    expect(nextAction(s2.tickets, s2.lanes, OPTS(s2))).toEqual({ kind: "claim", ticket: 51, stage: "reviewer" });
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
    const a = nextAction(s.tickets, s.lanes, OPTS(s));
    expect(a).toEqual({
      kind: "park",
      ticket: 7,
      status: "Blocked",
      note: expect.stringContaining("#5 (Questions)"),
    });
    const s2 = applyAction(s, a, 0);
    expect(nextAction(s2.tickets, s2.lanes, OPTS(s2))).toEqual({ kind: "drain-complete" });
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
    expect(nextAction(s.tickets, s.lanes, { ...OPTS(s), nowMs: now })).toEqual({ kind: "check-worker", ticket: 1 });
    // Probe says dead: skip with a note.
    s = recordProbe(s, 1, false, now);
    const skip = nextAction(s.tickets, s.lanes, { ...OPTS(s), nowMs: now });
    expect(skip).toEqual({ kind: "skip", ticket: 1, note: expect.stringContaining("watchdog") });
    s = applyAction(s, skip, now);
    expect(s.tickets.find((t) => t.number === 1)!.status).toBe("Skipped");
    // The loop continues with the other lane: ticket 2 finishes normally.
    s = recordOutcome(s, 2, HAPPY.builder, now);
    expect(nextAction(s.tickets, s.lanes, { ...OPTS(s), nowMs: now })).toEqual({ kind: "advance", ticket: 2, to: "qa" });
  });

  test("probe says alive: baseline refreshes and no skip fires", () => {
    let s = state([ticket(1, "Building")], [lane(1, "builder", { lastActivityMs: 0 })]);
    const now = 11 * MIN;
    expect(nextAction(s.tickets, s.lanes, { ...OPTS(s), nowMs: now }).kind).toBe("check-worker");
    s = recordProbe(s, 1, true, now);
    expect(nextAction(s.tickets, s.lanes, { ...OPTS(s), nowMs: now })).toEqual({ kind: "wait" });
  });
});

// -- stage-transition rules ---------------------------------------------------

describe("stage transitions", () => {
  test("builder -> qa -> reviewer -> merge -> Done on the happy path", () => {
    let s = state([ticket(1, "Building")], [lane(1, "builder")]);
    const step = (msg: string): Action => {
      s = recordOutcome(s, 1, msg, 0);
      const a = nextAction(s.tickets, s.lanes, OPTS(s));
      s = applyAction(s, a, 0);
      return a;
    };
    expect(step(HAPPY.builder)).toMatchObject({ kind: "advance", to: "qa" });
    expect(s.tickets[0].status).toBe("QA");
    expect(step(HAPPY.qa)).toMatchObject({ kind: "advance", to: "reviewer" });
    expect(s.tickets[0].status).toBe("Review");
    expect(step(HAPPY.reviewer)).toMatchObject({ kind: "advance", to: "merge", stackedOn: [] });
    expect(s.tickets[0].status).toBe("Review"); // merge runs under Review
    expect(step(HAPPY.merge)).toMatchObject({ kind: "complete", note: "https://github.com/x/y/pull/1" });
    expect(s.tickets[0].status).toBe("Done");
    expect(s.lanes).toEqual([]);
  });

  test("QA bounce ladder: notes, then /investigate first, then Blocked on pass 3", () => {
    let s = state([ticket(3, "QA")], [lane(3, "qa")]);
    const bounce = (): Action => {
      s = recordOutcome(s, 3, "QA-BUGS: 1) save button 500s", 0);
      const a = nextAction(s.tickets, s.lanes, OPTS(s));
      s = applyAction(s, a, 0);
      return a;
    };
    const backToQa = () => {
      s = recordOutcome(s, 3, HAPPY.builder, 0);
      s = applyAction(s, nextAction(s.tickets, s.lanes, OPTS(s)), 0); // advance qa
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
    expect(nextAction(s.tickets, s.lanes, OPTS(s))).toEqual({
      kind: "park", ticket: 1, status: "Questions", note: "which currency should defaults use?",
    });

    let s2 = state([ticket(2, "QA")], [lane(2, "qa")]);
    s2 = recordOutcome(s2, 2, "CONFUSED: ticket describes a service that does not exist", 0);
    expect(nextAction(s2.tickets, s2.lanes, OPTS(s2))).toEqual({
      kind: "skip", ticket: 2, note: "ticket describes a service that does not exist",
    });
  });

  test("reviewer findings bounce to a fresh builder", () => {
    let s = state([ticket(1, "Review")], [lane(1, "reviewer")]);
    s = recordOutcome(s, 1, "REVIEW-FINDINGS: 1) AC3 assertion weakened in tests/x.test.ts:12", 0);
    const a = nextAction(s.tickets, s.lanes, OPTS(s));
    expect(a).toMatchObject({ kind: "advance", to: "builder", note: expect.stringContaining("AC3") });
    s = applyAction(s, a, 0);
    expect(s.lanes[0].qaBounces).toBe(0); // review bounces do not consume QA passes
    expect(s.tickets[0].status).toBe("Building");
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

  test("one merge at a time, in dependency order across approved lanes", () => {
    let s = state(
      [ticket(20, "Review"), ticket(21, "Review", [20])],
      [
        lane(21, "reviewer", { outcome: { kind: "review-approve" } }),
        lane(20, "reviewer", { outcome: { kind: "review-approve" } }),
      ]
    );
    // The parent merges first even though the child's lane comes first in the array.
    const a = nextAction(s.tickets, s.lanes, OPTS(s));
    expect(a).toEqual({ kind: "advance", ticket: 20, to: "merge", stackedOn: [] });
    s = applyAction(s, a, 0);
    // Child stays gated while the parent is mid-merge.
    expect(nextAction(s.tickets, s.lanes, OPTS(s))).toEqual({ kind: "wait" });
    s = recordOutcome(s, 20, HAPPY.merge, 0);
    s = applyAction(s, nextAction(s.tickets, s.lanes, OPTS(s)), 0); // complete #20
    // Now the child advances, carrying its stacked parent for the merge prompt.
    expect(nextAction(s.tickets, s.lanes, OPTS(s))).toEqual({ kind: "advance", ticket: 21, to: "merge", stackedOn: [20] });
  });
});

// -- drain-complete -----------------------------------------------------------

describe("drain-complete", () => {
  test("all terminal statuses and no lanes -> drain-complete", () => {
    const s = state([ticket(1, "Done"), ticket(2, "Questions"), ticket(3, "Blocked"), ticket(4, "Skipped")]);
    expect(nextAction(s.tickets, s.lanes, OPTS(s))).toEqual({ kind: "drain-complete" });
    expect(drainComplete(s.tickets, s.lanes)).toBe(true);
  });

  test("a workable ticket or a live lane blocks the drain", () => {
    const s = state([ticket(1, "Done"), ticket(2, "Building")]);
    expect(drainComplete(s.tickets, s.lanes)).toBe(false);
    expect(nextAction(s.tickets, s.lanes, OPTS(s)).kind).toBe("claim");
    const s2 = state([ticket(1, "Done")], [lane(9, "builder", { lastActivityMs: 0 })]);
    expect(drainComplete(s2.tickets, s2.lanes)).toBe(false);
  });

  test("a ticket claimed by another session is outside this batch", () => {
    let s = state([ticket(1, "Done"), ticket(2, "Building")]);
    s = markClaimLost(s, 2);
    expect(claimableTickets(s.tickets, s.lanes)).toEqual([]);
    expect(nextAction(s.tickets, s.lanes, OPTS(s))).toEqual({ kind: "drain-complete" });
  });

  test("a dependency cycle inside the batch parks instead of spinning forever", () => {
    const s = state([ticket(1, "Building", [2]), ticket(2, "Building", [1])]);
    const a = nextAction(s.tickets, s.lanes, OPTS(s));
    expect(a).toMatchObject({ kind: "park", ticket: 1, status: "Blocked", note: expect.stringContaining("deadlock") });
  });
});

// -- deadlock breaker vs cross-session deps (issue #14 C7) --------------------

describe("deadlock breaker excludes still-completable deps", () => {
  test("a ticket whose only unsatisfied dep is claimedByOther waits, never parks", () => {
    // #2 is being built by another session (claimedByOther, not Done). #1 depends
    // on it. There is no in-batch cycle -- #2 will finish elsewhere -- so #1 must
    // WAIT, not be wrongly parked Blocked as a phantom cycle.
    const s = state([ticket(1, "Building", [2]), ticket(2, "Building", [], { claimedByOther: true })]);
    expect(nextAction(s.tickets, s.lanes, OPTS(s))).toEqual({ kind: "wait" });
  });

  test("a genuine in-batch 2-cycle still parks the lowest ticket Blocked", () => {
    const s = state([ticket(1, "Building", [2]), ticket(2, "Building", [1])]);
    expect(nextAction(s.tickets, s.lanes, OPTS(s))).toMatchObject({
      kind: "park", ticket: 1, status: "Blocked", note: expect.stringContaining("cycle"),
    });
  });

  test("a dep that can never complete in THIS batch (Backlog, not claimed elsewhere) parks, never waits forever", () => {
    // #7 (Ready) depends on #8 which sits in Backlog: the loop never pulls Backlog
    // into the batch and no other session owns it, so waiting would burn tokens
    // forever. It must park Blocked so a human notices -- NOT wait.
    const s = state([ticket(7, "Ready", [8]), ticket(8, "Backlog")]);
    expect(nextAction(s.tickets, s.lanes, OPTS(s))).toMatchObject({ kind: "park", ticket: 7, status: "Blocked" });
  });

  test("a real cycle plus a cross-session dependent waits until the external work resolves", () => {
    // #1<->#2 are a real cycle, but #3 waits on #9 (claimed elsewhere). Not EVERY
    // stuck ticket is mutually blocked, so wait rather than park anything yet; once
    // #9 lands and #3 drains, the residual pure cycle parks on a later tick.
    const s = state([
      ticket(1, "Building", [2]),
      ticket(2, "Building", [1]),
      ticket(3, "Building", [9]),
      ticket(9, "Building", [], { claimedByOther: true }),
    ]);
    expect(nextAction(s.tickets, s.lanes, OPTS(s))).toEqual({ kind: "wait" });
  });
});

// -- dead merge worker: verify PR, don't blind-skip (issue #14 H9) ------------

describe("dead merge worker path", () => {
  const MIN = 60_000;

  test("a dead merge lane is held at check-worker, never blind-skipped", () => {
    const s = state([ticket(1, "Review")], [lane(1, "merge", { workerDead: true, lastActivityMs: 0 })]);
    // Silent past the watchdog AND probed dead: a normal stage would skip here.
    const a = nextAction(s.tickets, s.lanes, { ...OPTS(s), nowMs: 11 * MIN });
    expect(a).toEqual({ kind: "check-worker", ticket: 1 });
  });

  test("recording MERGED on the dead merge lane completes it and counts mergedThisRun", () => {
    let s = state([ticket(1, "Review")], [lane(1, "merge", { workerDead: true })]);
    // The SKILL's gh pr view found the PR landed before the worker died.
    s = recordOutcome(s, 1, "MERGED: https://pr/9", 0);
    const a = nextAction(s.tickets, s.lanes, OPTS(s));
    expect(a).toMatchObject({ kind: "complete", ticket: 1 });
    s = applyAction(s, a, 0);
    expect(s.tickets[0].status).toBe("Done");
    expect(s.mergedThisRun).toContain(1); // retarget/branch-delete logic still sees it
  });

  test("a dead non-merge worker still skips (regression guard)", () => {
    const s = state([ticket(1, "Building")], [lane(1, "builder", { workerDead: true, lastActivityMs: 0 })]);
    expect(nextAction(s.tickets, s.lanes, { ...OPTS(s), nowMs: 11 * MIN }).kind).toBe("skip");
  });
});

// -- ingest drops an orphaned lane (issue #14 H14) ---------------------------

describe("ingest drops a lane whose ticket vanished", () => {
  test("a lane whose ticket left the board is dropped; nextAction/apply never throw", () => {
    const prev: LoopState = {
      tickets: [ticket(1, "Building"), ticket(2, "Building")],
      lanes: [lane(1, "builder"), lane(2, "builder", { outcome: { kind: "built" } })],
      maxLanes: 3,
      watchdogMinutes: 10,
      mergedThisRun: [],
    };
    // #2 was removed from the project mid-run; the snapshot only has #1. Before the
    // fix, lane #2 survived and the next apply threw in findTicket(#2), wedging
    // every subsequent apply.
    const s = ingestBoardItems(prev, [{ number: 1, title: "t1", fields: { Status: "Building" } }], { "1": "" });
    expect(s.tickets.map((t) => t.number)).toEqual([1]);
    expect(s.lanes.map((l) => l.ticket)).toEqual([1]); // lane #2 dropped
    const a = nextAction(s.tickets, s.lanes, OPTS(s));
    expect(() => applyAction(s, a, 0)).not.toThrow();
  });
});

// -- fresh-stage guarantee (AC4): lane state carries no conversation id -------

describe("fresh-stage lane state", () => {
  test("LaneState carries exactly its six scheduling fields and no session/conversation id", () => {
    // Compile-time half: this constant stops typechecking if LaneState's key
    // set ever drifts from the six named here.
    type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
    const _laneKeysExact: Exact<
      keyof LaneState,
      "ticket" | "stage" | "lastActivityMs" | "qaBounces" | "workerDead" | "outcome"
    > = true;
    void _laneKeysExact;
    // Runtime half: a fully-populated lane exposes exactly those keys, and none
    // of them smells like a carried conversation.
    const full: Required<LaneState> = {
      ticket: 1, stage: "builder", lastActivityMs: 0, qaBounces: 0, workerDead: false, outcome: { kind: "built" },
    };
    expect(Object.keys(full).sort()).toEqual(["lastActivityMs", "outcome", "qaBounces", "stage", "ticket", "workerDead"]);
    for (const k of Object.keys(full)) {
      expect(k).not.toMatch(/conversation|session|context|transcript|agent/i);
    }
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
    expect(parseStageResult("reviewer", "REVIEW-APPROVE: verified")).toEqual({ kind: "review-approve" });
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

// -- transition matrix + reducers ---------------------------------------------

describe("transitions and reducers", () => {
  test("canTransition spot checks", () => {
    expect(canTransition("Ready", "Building")).toBe(true);
    expect(canTransition("Review", "Done")).toBe(true);
    expect(canTransition("QA", "Building")).toBe(true);
    expect(canTransition("Building", "Done")).toBe(false); // no skipping QA/Review
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

  test("an unknown board status fails loudly", () => {
    expect(() => ingestBoardItems(null, [{ number: 1, title: "x", fields: { Status: "Doing" } }], {})).toThrow(ZError);
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
});
