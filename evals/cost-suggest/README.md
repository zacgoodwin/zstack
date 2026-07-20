# /z-plan Step 11 cost-suggest eval

Wired (issue #64). It is the **paid lane** (LLM calls) and is NOT part of the
gate suite (`bun test`) -- the deterministic half (`costSuggestions`,
`loadPlannedTickets`, `main`) is fully gate-tested in
`../../tests/cost-suggest.test.ts`. Every LLM call goes through **local
Claude Code (`claude -p`)** -- never a hosted API (PRINCIPLES.md "LLM
access").

This eval is self-contained: it does not touch `evals/planner/`'s shared
rubric, harness, or `PASS_THRESHOLD` (a 6th dimension there would change that
suite's existing 8/10 pass semantics for every other planner eval pass -- out
of scope, see the ticket's Out of scope). It also needs no board double and
no `gh` shim at all -- `costSuggestions` is a pure function on a JSON file, no
board/network involved anywhere in this ticket.

## Two passes

1. **PROSE** -- turn the real `CostBreakdown` JSON (`lib/cost-suggest.ts`'s
   `costSuggestions()`, computed fresh from `fixture-batch.json`, never
   hand-written) into the 3-6 short lines z-plan/SKILL.md's Step 11
   specifies.
2. **GRADE** -- a fresh `claude -p` pass scores that prose against
   `rubric.md`'s three dimensions (grounded-in-batch, no-generic-filler,
   actionable; 0-2 each, 6 total).

Repeat for N runs and average; pass when the mean total ≥ 5/6 (`rubric.md`).

## Inputs

- `fixture-batch.json` -- the case-1 5-ticket `PlannedTicket[]` batch (also
  the fixture `../../tests/cost-suggest.test.ts` cases 1-6 read -- one
  fixture for both lanes): #101/#102 haiku-low ($0.23 each), #103
  sonnet-medium ($1.64, `lib/config.ts`), #104 opus-xhigh ($7.15,
  `lib/config.ts`+`lib/loop.ts`), #105 fable-xhigh ($19.50, `lib/config.ts`).
- `rubric.md` -- the scoring contract.
- `../../z-plan/SKILL.md`'s Step 11 -- the prose contract under test.
- `../../lib/cost-suggest.ts` -- the deterministic helper that produces the
  JSON the prose pass is graded against.

## The harness

No `harness.ts` here -- unlike `evals/planner/`, there is no board double, no
markdown ticket-body splitter, and no `bin/z-ticket-lint` gate to wire; the
two-pass loop and score aggregation live directly in `run.sh` (bash + one
`bun -e` pass to average the graded totals and apply the ≥ 5/6 threshold).

- `run.sh` -- the runnable orchestrator: `run.sh [runs]` (default 3). Prices
  `fixture-batch.json` once via the real `lib/cost-suggest.ts`, then shells
  `$CLAUDE_CMD` (default `claude -p`) for the prose/grade steps per run,
  writes `prose-<i>.txt` / `score-<i>.json` to a temp dir, and averages the
  graded totals against the pass threshold.
- `mock-claude.sh` -- a canned stand-in for `claude -p`: emits a fixed prose
  block or score by sniffing the prompt text (the same two prompt shapes
  `run.sh` always sends), so the whole paid-lane orchestration is verifiable
  end-to-end with zero cost and zero network. Point `CLAUDE_CMD` at it to
  swap it in -- `run.sh` itself is byte-for-byte identical either way.

## Running it

```bash
# The real (paid) run -- nightly, or before ship:
evals/cost-suggest/run.sh 3

# The free, structural verification:
CLAUDE_CMD="evals/cost-suggest/mock-claude.sh" evals/cost-suggest/run.sh 1
```

Exit 0 = pass (mean total ≥ 5/6); exit 1 = fail, with the per-run scores in
the printed temp dir either way.

## Nightly scheduling

Documentation only -- the command to run; scheduling itself is the user's
cron/routine:

```cron
# Nightly, real claude -p:
0 5 * * * cd /path/to/zstack-1 && evals/cost-suggest/run.sh 3
```
