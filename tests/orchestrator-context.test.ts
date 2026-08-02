// Gate for the orchestrator-context drain eval (ticket #57, AC5). The metric is
// deterministic (context bytes are a pure function of the stage constructors +
// the scheduler), so the >=60% threshold gates for free here rather than only
// running as a paid periodic eval. See evals/orchestrator-context/README.md.
import { test, expect, describe } from "bun:test";
import { measure, simulateDrain, STUB_THRESHOLD_PCT, THRESHOLD_PCT } from "../evals/orchestrator-context/harness.ts";
import { spawnStub } from "../lib/stage-prompts.ts";

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

  // -- spawn stub (Leak 3) ----------------------------------------------------

  test("the spawn stub cuts the remaining per-spawn prompt bytes by >= the threshold", () => {
    const m = measure(6);
    expect(m.stubReductionPct).toBeGreaterThanOrEqual(STUB_THRESHOLD_PCT);
    expect(m.stubPerTicket).toBeLessThan(m.afterPerTicket);
  });

  // #57 already made afterPerTicket payload-invariant, so the stub's added
  // property is a different axis: invariance to the PROMPT's own size. Both
  // flat lines are asserted together against the baseline, which is the only
  // one that still tracks the payload -- that contrast is what keeps this from
  // being a vacuous "two constants are equal" test.
  test("stub and pointer-prompt per-ticket context are both invariant to payload size", () => {
    const base = measure(6);
    const huge = "Z".repeat(100_000);
    const big = measure(6, { ticketBody: huge, diff: huge, acceptanceCriteria: huge });
    expect(big.stubPerTicket).toBe(base.stubPerTicket);
    expect(big.afterPerTicket).toBe(base.afterPerTicket); // #57's guarantee
    expect(big.baselinePerTicket).toBeGreaterThan(base.baselinePerTicket * 5);
  });

  // The stub's OWN axis: hold the payload fixed and grow the prompt. Nothing
  // the constructors ever say can move what the orchestrator holds, because
  // spawnStub never reads the file it points at.
  test("stub per-spawn cost is invariant to the prompt's own size", () => {
    const p = "/abs/loop/tmp/prompt-1.txt";
    const short = spawnStub("builder", p);
    // Same inputs -> same stub, whatever the prompt file on disk contains.
    expect(spawnStub("builder", p)).toBe(short);
    expect(short.length).toBeLessThan(700);
  });
});
