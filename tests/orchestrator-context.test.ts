// Gate for the orchestrator-context drain eval (ticket #57, AC5). The metric is
// deterministic (context bytes are a pure function of the stage constructors +
// the scheduler), so the >=60% threshold gates for free here rather than only
// running as a paid periodic eval. See evals/orchestrator-context/README.md.
import { test, expect, describe } from "bun:test";
import { measure, simulateDrain, THRESHOLD_PCT } from "../evals/orchestrator-context/harness.ts";

describe("orchestrator-context eval (AC5)", () => {
  test("a synthetic 6-ticket happy-path drain cuts peak orchestrator context per ticket by >= 60%", () => {
    const m = measure(6);
    expect(m.ticketsDrained).toBe(6);
    expect(m.spawns).toBeGreaterThanOrEqual(24); // 4 stages x 6 tickets on the happy path
    expect(m.reductionPct).toBeGreaterThanOrEqual(THRESHOLD_PCT);
    // The recorded baseline ceiling must actually be payload-inflated -- guards a
    // vacuous pass where both sides are already tiny.
    expect(m.baselinePerTicket).toBeGreaterThan(m.afterPerTicket * 2);
    // The after per-ticket ceiling is bounded (pointer prompts + one-line ticks).
    expect(m.afterPerTicket).toBeLessThan(m.baselinePerTicket);
  });

  test("the cut only grows with payload size (100 KB body/diff vs the realistic default)", () => {
    const huge = "Z".repeat(100_000);
    const big = measure(6, { ticketBody: huge, diff: huge, acceptanceCriteria: huge });
    expect(big.reductionPct).toBeGreaterThan(measure(6).reductionPct);
    expect(big.reductionPct).toBeGreaterThanOrEqual(THRESHOLD_PCT);
  });

  test("the drain simulation reaches drain-complete and spawns all four stages for every ticket", () => {
    const { spawns, ticketsDrained, iterations } = simulateDrain(6);
    expect(ticketsDrained).toBe(6);
    expect(iterations).toBeGreaterThan(0);
    for (let t = 1; t <= 6; t++) {
      const stages = spawns.filter((s) => s.ticket === t).map((s) => s.stage);
      expect(new Set(stages)).toEqual(new Set(["builder", "qa", "reviewer", "merge"]));
    }
  });
});
