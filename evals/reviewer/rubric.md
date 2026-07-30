# /z-loop reviewer eval rubric

Scores the adversarial reviewer (issue #59) against the `multi-defect` fixture:
one realistic diff that typechecks, ships a green 54-test suite, and hides eight
independent defects. The question this eval answers is **how much of what is
wrong does one review cycle surface?** — so the metric is RECALL over a known
defect list, and the pass contract is a trial-count threshold.

This is the **paid lane** (LLM calls) and is NOT part of the gate suite
(`bun test`). Every LLM call goes through **local Claude Code** — never a hosted
API (PRINCIPLES.md "LLM access"). The deterministic half of #59 (the activation
predicate, the diff counter, the prompt-branch content, the four-key gate) is
gate-tested in `tests/stage-prompts.test.ts`, and this eval's own scoring is
gate-tested in `tests/reviewer-recall.test.ts`; the paid lane measures only the
REVIEW QUALITY no predicate can.

## What this eval used to ask, and why it changed

Until #108 the contract was: adversarial mode surfaces one planted needle that
single-pass **approves**. A trial passed only when the fan-out caught the defect
AND the single pass missed it. Four fixture redesigns and **16 real single-pass
reads** could not produce a single such trial (`run.md` "## Results" has the
per-round evidence, including the differentials proving each planted defect was
real and unexercised by the shipped tests).

The reason is structural, not a fixture-authoring failure. A planted defect must
violate a stated acceptance criterion, or this rubric cannot grade it — so the
criteria list is a complete index into where the defect can be. A reviewer with
code execution audits each criterion against the code that implements it, which
walks it onto the defect's home function under suspicion however the defect is
written: stated executably (round 1), locally anomalous (rounds 2-3), or
non-anomalous but criterion-indexed (round 4). Diff size is not the lever; the
audit is driven by the criteria list, not the line count.

The arithmetic agreed. Single-pass and the skeptics are the same model on the
same blinded inputs, so if catching were independent with probability *p*, a
trial passed with probability `(1-p)(1-(1-p)³)` — peaking near 47%, which puts
P(≥4/5) around 0.15 even at the optimum, and correlated draws make it worse.

So the eval now measures what the fan-out plausibly does buy and what the loop
actually pays for: **breadth per review cycle**. A review that names six of
eight defects sends the builder back once; a review that names two sends it back
three times. That difference is the product claim worth defending.

## The fixture

`fixtures/multi-defect/` is a 771-line diff adding a keyed rate limiter
(`src/window.ts`, `src/limiter.ts`) and its HTTP edge (`src/middleware.ts`),
against a 12-criterion ticket. Its 55 shipped tests are green with every defect
present. `defects.json` is the answer key: eight entries, each with the site,
the mechanism, the criterion it violates, and a reproduction. Every one is
verified to reproduce and to be unexercised by the shipped suite before the
fixture ships (`run.md` records the verification run).

The mix is weighted by measurement, not variety for its own sake. The first
paid run (run.md, 2026-07-28) showed site-local defects — a grep-able wrong
line at the site a criterion names — are caught 5/5 by BOTH modes and carry no
delta, while the one stateful-interaction defect carried all of it. This
iteration therefore fixes the four saturated site-local plants outright (the
fail-open catch, the ms-unit header, metrics-on-arrival, sweep-never-called are
now correct code) and plants four interaction defects in their place: defects
that only misbehave when two individually-correct paths meet under a specific
multi-call construction.

| id | class | criterion |
|----|-------|-----------|
| D1 | ordering interaction (ceiling charged before the per-key check) | 4, 5 |
| D2 | missing input validation | 8 |
| D3 | reset interaction breaches the shared ceiling | 5 |
| D4 | stale-state interaction: "retry now" while blocked by the ceiling | 6 |
| D5 | unnormalized input at a trust boundary | 10 |
| D6 | rounding direction lets clients retry early | 9 |
| D7 | the error path's own repair re-enters the failed dependency | 11 |
| D8 | a test that passes without the change | none directly |

`defects.json` never enters the reviewer's input. The reviewer stays blinded to
the same four keys as in production: the ticket body, its extracted
`### Acceptance Criteria`, the diff, and a throwaway worktree.

## Per-trial grading

Each trial drives BOTH prompts, built from the SAME blinded four-key input,
through a fresh live Agent:

- **single-pass** = `reviewerPrompt(input, false)` (built via
  `stage-prompts.ts prompt reviewer <input> --adversarial-mode off`).
- **adversarial** = `reviewerPrompt(input, true)` (built via `--adversarial-mode
  always`).

A fresh local `claude -p` grader then does the ONE latent job in this eval:
matching. For each defect id it decides whether each output actually names that
defect — same site, same mechanism, in the reviewer's own words. A finding that
gestures at the right file while describing a different problem is not a match.
It returns only:

```json
{"single": {"D1": true, ...}, "adversarial": {"D1": true, ...},
 "singleUnmatched": 0, "adversarialUnmatched": 0,
 "singleMarker": "REVIEW-FINDINGS", "adversarialMarker": "REVIEW-FINDINGS"}
```

Everything after that is code. `evals/lib/recall.ts` counts, aggregates and
thresholds; no number in the report is read out of a model's prose. Two
invariants it holds, both gate-tested:

1. **Grader schema drift is UNREADABLE, never a graded miss.** A missing defect
   id or a non-boolean verdict fails the run with exit 2 instead of silently
   scoring that defect as missed. Scoring it `false` would understate recall and
   turn a harness fault into a measurement — the #108 failure mode.
2. **The pass rule is a trial count, not a mean**, so one lopsided trial cannot
   carry a run that lost the rest.

**A trial passes when the adversarial run names STRICTLY MORE planted defects
than the single pass.** A tie is not a pass: equal recall is no evidence for a
mode that costs four times as much. Unmatched findings are reported for
diagnosis and never enter the pass rule.

## Pass threshold

**Adversarial names strictly more in ≥ 4 of 5 trials** (AC11's shape, applied to
the new metric). The bar is the RATIO: a run of N trials needs
`ceil(0.8 × N)` wins, so a 1-trial or 3-trial run is scored on its own terms
rather than being structurally unpassable. Below the bar, the fan-out is not
reliably beating a single pass on breadth and the reviewer control does not ship
as an improvement. Documented as periodic / pre-ship, run nightly or before a
release, never on every commit.

The report also prints, for diagnosis and never as a gate: each mode's mean
recall, the per-defect catch rate (which defects each mode systematically
misses), and how many findings matched no planted defect.
