// Gate tests for contract C3 (#324, epic #321): the board is authoritative and
// state.json is a derived cache. Done requires the PR observed merged (#313),
// dependencies satisfy on positive evidence only (#274/#292 -- covered in
// loop.test.ts's dep suite), a ghost lane stops with the divergence named
// (#202), the skip-qa crash window resyncs (#297 -- loop.test.ts), a confirmed
// pid must also beat (#300), clean-retained is scoped and previewed (#301),
// and a same-login operator claim is not stolen (#204). No LLM calls, no gh.
import { test, expect, describe } from "bun:test";
import { ZError } from "../lib/config.ts";
import {
  MAX_MERGE_CONFIRM_ATTEMPTS,
  applyAction,
  claimConfirmed,
  confirmMerged,
  nextAction,
  prNumberFromUrl,
  recordMergeConfirmAsk,
  recordOutcome,
  type LaneState,
  type LoopState,
  type TicketSnapshot,
} from "../lib/loop.ts";
import { loopLockLiveness, type LoopLock } from "../lib/locks.ts";
import { planCleanRetained } from "../lib/reconcile.ts";

const RUN_A = "run-20260101-000000-aaaa";

function ticket(number: number, status: TicketSnapshot["status"], dependsOn: number[] = []): TicketSnapshot {
  return { number, title: `Ticket ${number}`, status, dependsOn };
}
function lane(ticketNo: number, stage: LaneState["stage"], over: Partial<LaneState> = {}): LaneState {
  return { ticket: ticketNo, stage, lastActivityMs: 0, qaBounces: 0, reviewBounces: 0, ...over };
}
function state(tickets: TicketSnapshot[], lanes: LaneState[] = []): LoopState {
  return { schemaVersion: 2, runId: RUN_A, tickets, lanes, maxLanes: 3, watchdogMinutes: 10, mergedThisRun: [] };
}

const MERGED_LANE = () => state([ticket(1, "Review")], [lane(1, "merge", { outcome: { kind: "merged", note: "https://x/pull/9" } })]);

// -- prNumberFromUrl -----------------------------------------------------------

describe("prNumberFromUrl", () => {
  test("reads GitHub's canonical /pull/<n> shape and nothing else", () => {
    expect(prNumberFromUrl("https://github.com/a/b/pull/326")).toBe(326);
    expect(prNumberFromUrl("https://github.com/a/b/pull/326#issuecomment-1")).toBe(326);
    expect(prNumberFromUrl(" https://x/pull/9\n")).toBe(9);
    expect(prNumberFromUrl("https://pr/9")).toBeNull();
    expect(prNumberFromUrl("merged as 9")).toBeNull();
    expect(prNumberFromUrl("")).toBeNull();
  });
});

// -- the Done gate (#313) ------------------------------------------------------

describe("Done requires the PR observed merged (#313)", () => {
  test("a merged verdict alone emits confirm-merge, never complete", () => {
    expect(nextAction(MERGED_LANE(), 0)).toEqual({ kind: "confirm-merge", ticket: 1, pr: 9 });
  });

  test("the MERGED read unlocks complete, and the sha rides the observation", () => {
    let s = MERGED_LANE();
    s = confirmMerged(s, 1, { found: true, state: "MERGED", url: "https://x/pull/9", number: 9, mergeSha: "abc1234" }, 9);
    expect(s.lanes[0].mergeObserved).toEqual({ number: 9, url: "https://x/pull/9", mergeSha: "abc1234" });
    const a = nextAction(s, 0);
    expect(a).toMatchObject({ kind: "complete", ticket: 1 });
    const done = applyAction(s, a, 0);
    expect(done.tickets[0].status).toBe("Done");
    expect(done.mergedThisRun).toContain(1);
  });

  test("#313's exact scenario: a positive NOT-merged answer parks the divergence, never Done", () => {
    let s = MERGED_LANE();
    s = confirmMerged(s, 1, { found: true, state: "OPEN", url: "https://x/pull/9", number: 9 }, 9);
    expect(s.lanes[0].mergeObserved).toBeUndefined();
    expect(s.lanes[0].mergeConfirmAttempts).toBe(MAX_MERGE_CONFIRM_ATTEMPTS);
    const a = nextAction(s, 0);
    expect(a).toMatchObject({ kind: "park", ticket: 1, status: "Blocked" });
    expect((a as { note: string }).note).toContain("could not observe it merged");
    expect(applyAction(s, a, 0).tickets[0].status).toBe("Blocked");
  });

  test("found:false proves nothing (#138): the flag is untouched and the bounded ask-cycle decides", () => {
    let s = MERGED_LANE();
    for (let i = 1; i <= MAX_MERGE_CONFIRM_ATTEMPTS; i++) {
      expect(nextAction(s, 0)).toEqual({ kind: "confirm-merge", ticket: 1, pr: 9 });
      s = recordMergeConfirmAsk(s, 1); // what `loop next` stamps as it emits
      s = confirmMerged(s, 1, { found: false }, 9);
      expect(s.lanes[0].mergeObserved).toBeUndefined();
      expect(s.lanes[0].mergeConfirmAttempts).toBe(i);
    }
    expect(nextAction(s, 0)).toMatchObject({ kind: "park", ticket: 1, status: "Blocked" });
  });

  test("a read answering a DIFFERENT PR is refused loudly -- never folded into this lane", () => {
    const s = MERGED_LANE();
    expect(() => confirmMerged(s, 1, { found: true, state: "MERGED", url: "https://x/pull/8", number: 8 }, 9)).toThrow(ZError);
  });

  test("a verdict whose URL names no PR parks immediately -- there is nothing to confirm against", () => {
    const s = state([ticket(1, "Review")], [lane(1, "merge", { outcome: { kind: "merged", note: "merged it, trust me" } })]);
    expect(nextAction(s, 0)).toMatchObject({ kind: "park", ticket: 1, status: "Blocked", note: expect.stringContaining("no readable PR number") });
  });

  test("recordOutcome carrying merged never bypasses the gate (recovery verdicts walk the same door)", () => {
    let s = state([ticket(1, "Review")], [lane(1, "merge")]);
    s = recordOutcome(s, 1, { kind: "merged", note: "https://x/pull/9" }, 0);
    expect(nextAction(s, 0)).toEqual({ kind: "confirm-merge", ticket: 1, pr: 9 });
  });
});

// -- ghost lane (#202) ---------------------------------------------------------

describe("ghost lane stops with the divergence named (#202)", () => {
  test("a lane with no ticket snapshot is stopped and dropped, not crashed on or skipped", () => {
    const s = state([ticket(2, "Ready")], [lane(1, "builder")]); // #1 has a lane, no snapshot
    const a = nextAction(s, 0);
    expect(a).toMatchObject({ kind: "stop-lane", ticket: 1, dropTicket: true, note: expect.stringContaining("ghost lane") });
    const after = applyAction(s, a, 0);
    expect(after.lanes).toEqual([]);
    // ...and the healthy ticket proceeds on the very next tick.
    expect(nextAction(after, 0)).toEqual({ kind: "claim", ticket: 2, stage: "builder" });
  });
});

// -- lock liveness: pid must also beat (#300, extends #198/H12) ----------------

describe("a confirmed pid must also beat (#300)", () => {
  const LOCK: LoopLock = { session: "s", startedAt: 0, pid: 1234, host: "h", startTime: "t0" };
  const alive = () => true;
  const dead = () => false;
  const confirmed = () => "confirmed" as const;
  const HOUR = 3_600_000;

  test("dead pid: stale immediately, whatever the age (#288's remedy)", () => {
    expect(loopLockLiveness(LOCK, 1_000, HOUR, dead, confirmed, 500)).toBe("stale");
  });

  test("confirmed pid + fresh beat: live", () => {
    expect(loopLockLiveness(LOCK, HOUR * 10, HOUR, alive, confirmed, HOUR * 10 - 1_000)).toBe("live");
  });

  test("#300's exact scenario: confirmed pid (the harness outliving its drain) + stale beat -> stale", () => {
    expect(loopLockLiveness(LOCK, HOUR * 10, HOUR, alive, confirmed, HOUR * 2)).toBe("stale");
  });

  test("legacy caller with no beat anchor: the confirmed pid still decides alone", () => {
    expect(loopLockLiveness(LOCK, HOUR * 10, HOUR, alive, confirmed)).toBe("live");
  });
});

// -- clean-retained is scoped (#301) -------------------------------------------

describe("clean-retained is scoped, never a blanket (#301)", () => {
  const ORPHANS = {
    crashedLanes: [],
    locklessWorktrees: [],
    buildingNoState: [],
    retainedWorktrees: [
      { ticket: 7, worktreePath: ".worktrees/ticket-7" },
      { ticket: 9, worktreePath: ".worktrees/ticket-9" },
    ],
  } as never;

  test("--ticket filters the plan to exactly that worktree", () => {
    expect(planCleanRetained(ORPHANS).map((a) => a.ticket)).toEqual([7, 9]);
    expect(planCleanRetained(ORPHANS, 9).map((a) => a.ticket)).toEqual([9]);
    expect(planCleanRetained(ORPHANS, 999)).toEqual([]);
  });
});

// -- same-login operator claims are not stolen (#204) --------------------------

describe("the fold-in gate keys on this session's lane lock, not the login string (#204)", () => {
  const flagged = (): LoopState => {
    const s = state([ticket(5, "Ready")]);
    s.tickets[0].claimedByOther = true;
    s.tickets[0].claimedByOtherAt = 0;
    return s;
  };

  test("me-only WITH our lane lock clears (our own claim, confirmed)", () => {
    const next = claimConfirmed(flagged(), 5, ["tordek-ai"], "tordek-ai", 0, true);
    expect(next.tickets[0].claimedByOther).toBeUndefined();
  });

  test("#204's exact scenario: me-only WITHOUT our lane lock is the operator's own claim -- held, named", () => {
    const next = claimConfirmed(flagged(), 5, ["tordek-ai"], "tordek-ai", 0, false);
    expect(next.tickets[0].claimedByOther).toBe(true);
    expect(next.tickets[0].claimedByOtherLogin).toContain("same login, no lane lock");
  });

  test("an EMPTY assignee set clears regardless -- nobody holds it, there is nothing to steal", () => {
    const next = claimConfirmed(flagged(), 5, [], "tordek-ai", 0, false);
    expect(next.tickets[0].claimedByOther).toBeUndefined();
  });

  test("legacy caller (no lock evidence) keeps the pre-#324 behavior", () => {
    const next = claimConfirmed(flagged(), 5, ["tordek-ai"], "tordek-ai", 0);
    expect(next.tickets[0].claimedByOther).toBeUndefined();
  });
});
