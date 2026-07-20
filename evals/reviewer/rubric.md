# /z-loop reviewer eval rubric

Scores the adversarial reviewer (issue #59) against the `planted-defect` fixture:
a diff that typechecks and superficially satisfies its acceptance criteria but
hides one subtle correctness defect. The question this eval answers is narrow and
binary per trial — **does adversarial mode surface the defect that single-pass
approves?** — so the pass contract is a trial-count threshold, not a 0–10 score.

This is the **paid lane** (LLM calls) and is NOT part of the gate suite
(`bun test`). Every LLM call goes through **local Claude Code** — never a hosted
API (PRINCIPLES.md "LLM access"). The deterministic half of #59 (the activation
predicate, the diff counter, the prompt-branch content, the four-key gate) is
fully gate-tested in `tests/stage-prompts.test.ts`; this eval measures only the
REVIEW QUALITY that no predicate can — whether the skeptic fan-out actually finds
a bug a single read misses.

## The planted defect

`src/window.ts` implements a half-open rate-limit window `[start, start+duration)`
but writes the end check as `now <= end` instead of `now < end`. That inclusive
`<=` makes the boundary tick `start + durationMs` read as *inside* the window,
violating **acceptance criterion 3** (`withinWindow(1500, 1000, 500)` must be
`false`). The added `window.test.ts` exercises criteria 1, 2, and 4 but NOT the
boundary case (criterion 3), so the suite is green and the defect hides — a real
"a path the diff adds that no test exercises" for the reviewer to catch.

## Per-trial grading

Each trial drives BOTH prompts built from the same blinded four-key input
(`ticket.md` body, its extracted `### Acceptance Criteria`, `diff.patch`, a
throwaway worktree path) through a fresh live Agent:

- **single-pass** = `reviewerPrompt(input, false)` (built via
  `stage-prompts.ts prompt reviewer <input> --adversarial-mode off`).
- **adversarial** = `reviewerPrompt(input, true)` (built via `--adversarial-mode
  always`).

A trial **passes** when BOTH hold:

1. The **adversarial** run's final message starts with `REVIEW-FINDINGS:` and the
   findings name the boundary/off-by-one defect on criterion 3 (the `<=`-vs-`<`
   end check, or the untested boundary case). Its `confidence=` token is present
   and below threshold (< 100 — at least one skeptic refuted).
2. The **single-pass** run's final message starts with `REVIEW-APPROVE:` (the
   subtle defect slips a single read). If single-pass ALSO catches it, the trial
   is inconclusive for this rubric, not a pass — the eval measures the *delta*
   the fan-out buys, and no delta means no evidence.

Grading marker lines is deterministic; a fresh local `claude -p` grader confirms
the adversarial findings actually name criterion 3's boundary defect (not some
unrelated nit) and returns `{adversarialMarker, singlePassMarker, namesDefect,
adversarialConfidence, pass}` per trial.

## Pass threshold

**Adversarial surfaces the defect in ≥ 4 of 5 trials** (AC11). Below that, the
super-truth fan-out is not reliably beating a single pass on subtle correctness
and the reviewer control does not ship as an improvement. Documented as
periodic / pre-ship, run nightly or before a release, never on every commit.
