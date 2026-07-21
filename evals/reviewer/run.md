# /z-loop adversarial reviewer eval

Measures issue #59's REVIEW QUALITY claim: adversarial mode surfaces a subtle
planted defect that single-pass review approves. **Paid lane** (LLM calls), NOT
in the gate suite (`bun test`). Every LLM call goes through **local Claude Code
(`claude -p`)** — never a hosted API (PRINCIPLES.md "LLM access"). The
deterministic half of #59 is gate-tested in `tests/stage-prompts.test.ts`; this
eval covers only the latent half a predicate can't.

The reviewer's active prompt spawns skeptic sub-agents via the **Agent tool**
(nested `claude -p` is denied by the classifier — MEMORY). The outer `claude -p`
here is a first-level headless run from the shell (same as `evals/planner`), so
the reviewer's inner Agent-tool fan-out is allowed.

## Inputs

- `fixtures/planted-defect/ticket.md` — the ticket body, carrying its
  `### Acceptance Criteria`. Criterion 3 is the boundary the defect violates.
- `fixtures/planted-defect/diff.patch` — a two-file diff (`src/window.ts` +
  `src/window.test.ts`) that typechecks, is green, and hides a `<=`-vs-`<`
  off-by-one on the half-open window's end. The test file skips the boundary
  case, so nothing green exercises the bug.
- `rubric.md` — the per-trial pass contract and the ≥ 4/5 threshold (AC11).
- `../../lib/stage-prompts.ts` — the prompt constructor under test.

## What the harness does

Both prompts are built from the SAME blinded four-key input (blindness intact:
mode rides as a `--adversarial-mode` flag, never a fifth key), then each is
driven through a fresh live Agent for N trials:

- **single-pass** ← `--adversarial-mode off` → `reviewerPrompt(input, false)`.
- **adversarial** ← `--adversarial-mode always` → `reviewerPrompt(input, true)`.

A trial passes when the adversarial run ends `REVIEW-FINDINGS:` naming
criterion 3's boundary defect with a below-100 `confidence=`, AND the single-pass
run ends `REVIEW-APPROVE:` (rubric.md). Pass the eval at ≥ 4/5.

## Running it

`run.sh` (issue #71) is the runnable harness, extracted verbatim from this
section's former inline bash to match `evals/planner/run.sh`'s shape. Every
LLM call goes through `$CLAUDE_CMD` (default `claude -p`) — never a hosted API
(PRINCIPLES.md "LLM access").

```bash
# The real (paid) run -- nightly, or before ship:
evals/reviewer/run.sh 5

# The free, structural smoke test (exercises every branch of run.sh's
# plumbing -- both prompt shapes, the grade JSON parse, the >=4/5 threshold,
# the exit code -- with a canned mock-claude.sh instead of real claude -p.
# Says nothing about real model quality; see "## Results" below for that):
CLAUDE_CMD="evals/reviewer/mock-claude.sh" evals/reviewer/run.sh 5
```

Exit 0 = the fan-out beat single-pass on the planted defect in ≥ 4/5 trials;
exit 1 = below threshold, with the per-trial grades in the run's temp output
dir (printed on stdout) either way.

## Verifying the harness offline (free)

The fixture and both prompts are checkable with zero cost — this asserts the
input stays four-key-blinded and the two branches diverge exactly as the gate
tests pin, without any `claude -p`:

```bash
FIX=evals/reviewer/fixtures/planted-defect
AC="$(awk '/^### Acceptance Criteria/{f=1;next} /^#/{f=0} f' "$FIX/ticket.md")"
bun -e "import {readFileSync,writeFileSync} from 'node:fs';
  writeFileSync('/tmp/rv.json', JSON.stringify({ticketBody:readFileSync('$FIX/ticket.md','utf8'),
    acceptanceCriteria:process.argv[1],diff:readFileSync('$FIX/diff.patch','utf8'),
    worktreePath:'/tmp/x'}));" "$AC"
bun lib/stage-prompts.ts prompt reviewer /tmp/rv.json --adversarial-mode off    | grep -qv skeptic && echo "single pass: ok"
bun lib/stage-prompts.ts prompt reviewer /tmp/rv.json --adversarial-mode always | grep -q  skeptic && echo "adversarial: ok"
```

## Nightly scheduling

Documentation only — the command; scheduling is the user's cron/routine:

```cron
# Nightly, real claude -p, 5 trials:
0 4 * * * cd /path/to/zstack-1 && evals/reviewer/run.sh 5
```

## Results

**2026-07-20, 5 trials, ticket #102 (real paid run, AC3 of #88).** Ran
`evals/reviewer/run.sh 5` (real `claude -p`, `CLAUDE_CMD` not overridden to
`mock-claude.sh`) against the post-#88 fixture. All 5 trials completed with a
graded score and no harness or materialization error. Headline, `run.sh`'s
own output: "adversarial surfaced the defect in 0/5 trials (pass threshold:
4/5)" followed by "FAIL: below threshold" (exit 1).

**Score: 0/5.** Per-trial grades (`grade-1.json` .. `grade-5.json`) are
identical in shape across all 5 trials:

```json
{
  "adversarialMarker": "REVIEW-FINDINGS",
  "singlePassMarker": "REVIEW-FINDINGS",
  "namesDefect": true,
  "adversarialConfidence": 0,
  "pass": false
}
```

**Single-pass-vs-adversarial delta: none — single-pass also caught it.**
Adversarial mode worked exactly as designed in all 5 trials —
`REVIEW-FINDINGS: confidence=0`, 3/3 skeptics refuting, naming criterion 3's
`<=`-vs-`<` boundary defect with file:line evidence and an executed
counter-example (`withinWindow(1500,1000,500)` returns `true`, must be
`false`). But per `rubric.md`'s per-trial contract, a trial only passes when
adversarial catches the defect AND single-pass does not — and single-pass
ALSO ended `REVIEW-FINDINGS` (never `REVIEW-APPROVE`) in all 5 trials,
independently reproducing the same file:line, the same executed
counter-example, and the same fix (e.g. single-1: "AC3 fails: the boundary
is inclusive, not exclusive... Fix is `now < end`."). No trial shows the
delta the fan-out is meant to buy, because there is none to show here.

**Interpretation (AC3): the fixture does not discriminate.** Not a harness
defect — #88's AC1/AC2 fixes hold, and all 5 trials completed cleanly
against a real materialized worktree. Not an adversarial-mode failure —
adversarial named the defect correctly, with below-100 confidence, every
single time. The planted `<=`-vs-`<` boundary defect is too mechanically
obvious for a frontier single-pass reviewer with real code execution to
miss, regardless of #88's de-spoiled AC3 prose: the reviewer runs the
function against the stated acceptance criteria and the boundary case
fails, full stop. The ≥4/5 threshold is unchanged and was NOT weakened to
force a pass. **Follow-up filed:
[#108](https://github.com/zacgoodwin/zstack/issues/108)** — design a
subtler planted defect for this fixture, so the eval can actually
discriminate adversarial from single-pass review quality.

