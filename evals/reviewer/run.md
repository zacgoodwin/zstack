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

