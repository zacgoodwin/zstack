# Reviewer finding-classification eval (issue #179)

Answers one question: **when the code is right and only a comment is wrong, does
the reviewer ship-and-file the nit, or bounce the whole ticket?** The dominant
cost driver of loop 13 was the latter — #157 was functionally excellent (0 false
parks in a 60k-graph fuzz, recovered a 393,005-token silent-zero reading) yet
bounced 4× purely on scoped-wrong empirical claims in comments and docs, because
the reviewer's exit grammar has no non-blocking channel.

This is the **paid lane**. It is NOT part of `bun test`. Run it nightly or before
a release. Every LLM call goes through **local Claude Code** — never a hosted API.

## Run it

```bash
# Free structural smoke test (canned outputs, exercises the whole harness):
CLAUDE_CMD="evals/reviewer-severity/mock-claude.sh" evals/reviewer-severity/run.sh 5

# Real paid run (nightly / pre-ship):
evals/reviewer-severity/run.sh 5
```

`RUNS` defaults to 5. The per-fixture bar is `ceil(0.8 * RUNS)` correct trials
(≥ 4 of 5); the run PASSES only when all three fixtures clear it.

Exit 1 = a fixture fell below its bar. **Exit 2 = HARNESS ERROR**: a grade file
could not be read, so nothing was measured — rerun rather than recording it.
Grade extraction is shared with `evals/reviewer/` via `evals/lib/grade.ts`, which
handles the fenced and prose-wrapped JSON a live grader actually emits (#108).

## The three fixtures

| Fixture | Diff | Correct verdict |
|---|---|---|
| `prose-nit` | correct `clamp`, all 4 AC tested, one over-claiming comment | `REVIEW-APPROVE` + the comment as a non-blocking `observation`; **no bounce** |
| `weakened-ac` | `clamp` silently swaps reversed bounds; test asserts the swap | `REVIEW-FINDINGS` (functional AC4 violation blocks) |
| `wrong-runbook` | docs ticket; runbook snapshots AFTER running, not before | `REVIEW-FINDINGS` (prose is the deliverable + operator-damaging) |

`prose-nit` is the load-bearing case: it is the exact shape that bounced #157.
`weakened-ac` and `wrong-runbook` are the guards that the severity split does not
become "approve everything" — a real functional defect and the prose carve-out
must both still block.

Grading is per `rubric.md`: a fresh local grader parses the marker and applies
each fixture's pass rule, returning `{marker, blocked, namesIssue, pass}`.

## Coupling to #179

`prose-nit` requires the `observations:` channel #179 adds to `REVIEW-APPROVE`.
Today's reviewer prompt (`lib/stage-prompts.ts:234-239`) offers only approve or
"findings, each with why it blocks the merge" — a reviewer that spots the false
comment has no non-blocking move, so it bounces and `prose-nit` is RED. This eval
is the independent yardstick #179 must turn green; it is authored before the
implementation on purpose (CLAUDE.md: the plan's acceptance tests are the
independent yardstick the review checks against).

The deterministic half of #179 — that `reviewerPrompt` emits the
blocking-vs-non-blocking classification text and the `observations:` grammar —
belongs in `tests/stage-prompts.test.ts` (the gate lane), added in #179's build
commit. This eval measures only the quality no predicate can.

## Results

Not yet run against real `claude -p` — blocked on #179's `observations:` grammar
(a real run would be RED on `prose-nit` today, which is the expected pre-#179
state). The mock smoke test passes and exercises the full harness. Record the
first real per-fixture score here (`prose-nit N/5`, `weakened-ac N/5`,
`wrong-runbook N/5`) when #179 lands, grounded in the run's `grade-*.json`
artifacts — never fabricated.

## Out of scope

- **Adversarial-mode parity.** This eval drives the single-pass prompt; the
  reconciler must apply the same split to aggregated skeptic findings under
  `--adversarial-mode always`. Add one adversarial trial per fixture as a
  follow-on once the base rubric is green.
- **Builder-side prevention** — a `z-ticket-lint` rule flagging new absolute /
  empirical claims in comments (tracked in #179's Out of scope). This eval
  measures the reviewer's classification, not the builder's restraint.
