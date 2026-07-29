# /z-loop reviewer finding-classification rubric (issue #179)

Scores whether the adversarial reviewer **classifies findings by severity**:
does it ship a functionally-correct diff and FILE a prose-only nit, or does it
bounce the whole ticket over that nit? Sibling to `evals/reviewer/` (which
measures adversarial-vs-single defect surfacing on the `planted-defect`
fixture); this eval measures the blocking-vs-non-blocking split #179 adds.

This is the **paid lane** (LLM calls) and is NOT part of the gate suite
(`bun test`). Every LLM call goes through **local Claude Code** — never a hosted
API (PRINCIPLES.md "LLM access"). The deterministic half of #179 (the
prompt-constructor's classification text and the `observations:` grammar) is
gate-tested in `tests/stage-prompts.test.ts`; this eval measures only the REVIEW
QUALITY no predicate can — whether a real reviewer holds the line between a
functional defect and a prose nit.

## The three fixtures

Each fixture is a `{ticket.md, diff.patch}` pair driven through the reviewer as
the blinded four-key input (`ticketBody`, extracted `### Acceptance Criteria`,
`diff.patch`, a throwaway worktree). The diffs typecheck and their test suites
(where present) are green — the question is purely how the reviewer classifies
what it finds.

- **`prose-nit`** — the load-bearing case (the #157 class). `src/clamp.ts` is
  functionally correct: all four acceptance criteria hold and `clamp.test.ts`
  covers all four. The ONLY defect is a comment that over-claims ("branch-free
  on every JS engine", "never mispredicts") while the body uses two ternary
  branches — a false empirical claim with zero behavioral effect.
- **`weakened-ac`** — a functional defect. The diff silently swaps reversed
  bounds instead of throwing, and the test asserts the swapped value, so
  acceptance criterion 4 (`clamp(5, 10, 0)` must throw `RangeError`) is
  weakened behind a green suite.
- **`wrong-runbook`** — the prose carve-out. A DOCS ticket whose AC requires the
  runbook to snapshot BEFORE running; the diff runs first and snapshots only
  "if something looks wrong afterward". Prose IS the deliverable AND a wrong
  safety runbook drives the operator into an unreversible data-loss action.

## Per-trial grading

Each trial drives the single-pass reviewer prompt (`reviewerPrompt(input,
false)`, built via `stage-prompts.ts prompt reviewer <input> --adversarial-mode
off`) through a fresh live Agent, then a fresh local grader parses the marker
and applies that fixture's pass rule. The grader returns ONLY:

```json
{"marker": "REVIEW-APPROVE|REVIEW-FINDINGS|NEEDS-HUMAN|BLOCKED|CONFUSED",
 "blocked": true|false,
 "namesIssue": true|false,
 "pass": true|false}
```

- `marker` — the marker the reviewer's final message starts with.
- `blocked` — did the verdict bounce the ticket to the builder (`REVIEW-FINDINGS`
  ⇒ `true`) or let it ship (`REVIEW-APPROVE` ⇒ `false`)?
- `namesIssue` — does the reviewer actually name that fixture's target issue (the
  false comment / the weakened AC4 / the reversed snapshot order), not some
  unrelated nit?

**Pass rule per fixture:**

- `prose-nit` passes when `marker == "REVIEW-APPROVE"` AND `blocked == false` AND
  `namesIssue == true` — i.e. it ships the correct code and records the false
  comment as a non-blocking observation (to be filed), never bouncing over it.
- `weakened-ac` passes when `marker == "REVIEW-FINDINGS"` AND `blocked == true`
  AND `namesIssue == true` — a functional AC violation still blocks.
- `wrong-runbook` passes when `marker == "REVIEW-FINDINGS"` AND `blocked == true`
  AND `namesIssue == true` — the prose carve-out (deliverable / operator-damaging)
  still blocks.

## Pass threshold

**Each fixture must pass in ≥ 80% of trials (≥ 4 of 5).** The harness computes
`need = ceil(0.8 * RUNS)` so a smaller `RUNS` for the free mock smoke test still
has a sensible bar. The overall run PASSES only when all three fixtures clear
their threshold. Documented as periodic / pre-ship (nightly or before release),
never on every commit.

## Coupling to #179

`prose-nit` REQUIRES the `observations:` channel #179 adds to `REVIEW-APPROVE`.
Against today's reviewer prompt — whose only verdicts are approve or
"findings, each with why it blocks" — a reviewer that spots the false comment has
no non-blocking move and bounces, so `prose-nit` is RED until #179 lands. That
is the point: this eval is the independent yardstick #179 must turn green. The
mock (`mock-claude.sh`) emits the intended post-#179 outputs so the harness
plumbing is exercisable for free now; a real paid run is the acceptance gate for
#179.
