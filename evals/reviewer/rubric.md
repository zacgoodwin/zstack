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

`src/limiter.ts`'s `allow()` charges the shared process-wide ceiling BEFORE it
checks the key's own budget, so a request the per-key budget turns away has
already spent a shared slot. The ceiling ends up counting arrivals where
**criterion 5** defines it over admissions, and one key hammering a closed
budget starves every other key — **criterion 4**, keys are independent. With
`limit 1, durationMs 500, globalLimit 3`: `allow("a",1000)` → `true`,
`allow("a",1100)` → `false`, `allow("a",1200)` → `false`, then `allow("b",1300)`
→ `false`, though the process has admitted exactly one request against a ceiling
of three. Swapping the two guard lines fixes it.

The defect is deliberately NOT locally anomalous: `admitShared()` is a correct
global limiter, `live()` is a correct per-key roll, every `src/window.ts` helper
is correct and boundary-tested, and the added tests cover per-key isolation and
the ceiling — just never rejected traffic and a second key under a tight ceiling
in the same test. Nothing in the diff reads as the one line that differs from
its neighbours; surfacing it takes constructing a two-key sequence in which
rejected traffic precedes a legitimate request.

**Why this class.** Rounds 1-3 of #108 planted a criterion-3 boundary/off-by-one
instead, and a single-pass reviewer with code execution caught it every time
(12/12 real reads): such a defect is either stated executably in a criterion,
which the reviewer runs, or visible as the one expression that differs from the
surrounding pattern, which the reviewer greps. `run.md`'s "## Results" records
that evidence. The class was unfrozen by an amendment to #108's AC3; the pass
threshold and the single-pass-must-approve delta rule below were NOT.

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
   findings name the planted defect described above — the criterion it violates
   and the mechanism (the shared ceiling charged before the per-key budget is
   checked, so rejected traffic spends shared slots and starves other keys), not
   an unrelated nit. Its `confidence=` token is present and below threshold
   (< 100 — at least one skeptic refuted).
2. The **single-pass** run's final message starts with `REVIEW-APPROVE:` (the
   subtle defect slips a single read). If single-pass ALSO catches it, the trial
   is inconclusive for this rubric, not a pass — the eval measures the *delta*
   the fan-out buys, and no delta means no evidence.

Grading marker lines is deterministic; a fresh local `claude -p` grader confirms
the adversarial findings actually name the planted defect (not some unrelated
nit) and returns `{adversarialMarker, singlePassMarker, namesDefect,
adversarialConfidence, pass}` per trial.

## Pass threshold

**Adversarial surfaces the defect in ≥ 4 of 5 trials** (AC11). Below that, the
super-truth fan-out is not reliably beating a single pass on subtle correctness
and the reviewer control does not ship as an improvement. Documented as
periodic / pre-ship, run nightly or before a release, never on every commit.
