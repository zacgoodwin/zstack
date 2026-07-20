#!/usr/bin/env bash
# Canned stand-in for `claude -p` (issue #64, mirrors evals/planner/mock-claude.sh):
# verifies run.sh's plumbing end-to-end with zero cost and zero network. run.sh
# calls "$CLAUDE_CMD "$prompt" --add-dir ..." for both the prose and grade
# steps; this script IS that command when CLAUDE_CMD points here. Real
# claude -p reads the prompt exactly the same way (its first argument), so
# run.sh is byte-for-byte identical whether CLAUDE_CMD is this stub or the
# real `claude -p`.
#
# Which canned output to emit is decided by sniffing the prompt text -- the
# two shapes run.sh's prose/grade prompts always send, no special flag, so
# real claude -p and this stub see the identical invocation.
set -euo pipefail
PROMPT="${1:-}"

if [[ "$PROMPT" == *"Score the prose"* ]]; then
  # GRADE step: rubric.md's JSON shape, {groundedInBatch, noGenericFiller,
  # actionable, total, notes}. Every dimension is fixed at a passing score;
  # only `total` is overridable (MOCK_CLAUDE_TOTAL) so a test can drive the
  # >= 5/6 pass gate both ways without touching the dimension breakdown.
  cat << SCORE
{"groundedInBatch":2,"noGenericFiller":2,"actionable":2,"total":${MOCK_CLAUDE_TOTAL:-6},"notes":"mock-claude canned score (issue #64 structural check)"}
SCORE
else
  # PROSE step: canned Step 11 output naming real figures from
  # fixture-batch.json, standing in for what a real claude -p run would print
  # from the CostBreakdown JSON.
  cat << PROSE
Total batch estimate is \$28.75 across 5 tickets.
#105 ("Redesign the config subsystem end to end") is fable-xhigh (\$19.50) -- confirm the tier is warranted or split it.
lib/config.ts is touched by 3 tickets (#103, #104, #105) -- sequencing them reduces re-review churn.
#101, #102 are haiku-low mechanical work -- batch them in one lane.
PROSE
fi
