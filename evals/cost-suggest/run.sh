#!/usr/bin/env bash
# The runnable eval for issue #64's Step 11 prose (z-plan/SKILL.md,
# "Cost-saving suggestions"). Every LLM call goes through **local Claude
# Code** ($CLAUDE_CMD, default `claude -p`) -- never a hosted API
# (PRINCIPLES.md "LLM access"). Mirrors evals/planner/run.sh's two-pass shape
# (PROSE then GRADE), but needs no board double and no `gh` shim at all --
# costSuggestions is a pure function on a JSON file, no board/network
# involved anywhere in this ticket.
#
#   CLAUDE_CMD="$HERE/mock-claude.sh" evals/cost-suggest/run.sh 1   # free, structural
#   evals/cost-suggest/run.sh 3                                     # real, paid (nightly)
#
# See README.md for the full contract (pass threshold, dimensions, inputs).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO="$(cd "$HERE/../.." && pwd -P)"
RUNS="${1:-3}"
CLAUDE_CMD="${CLAUDE_CMD:-claude -p}"
OUT="$(mktemp -d)"

# Deterministic half: the real costSuggestions() prices the fixture batch.
# Never hand-write this JSON -- it must be exactly what lib/cost-suggest.ts
# computes, the same discipline Step 11 itself follows against a live batch.
bun "$REPO/lib/cost-suggest.ts" "$HERE/fixture-batch.json" > "$OUT/breakdown.json"

PROSE_PROMPT="You are the /z-plan skill's Step 11 (z-plan/SKILL.md, 'Cost-saving
suggestions'). You are given one CostBreakdown JSON object at $OUT/breakdown.json,
already computed by the deterministic helper -- do not recompute or
second-guess any number in it. Turn totalEstimate, byTier, sharedFileClusters,
topCostTicket, and each suggestions[] entry's fact into 3-6 short lines for the
human running /z-plan. Name the real ticket numbers, files, and dollar figures
the JSON gives you; never generic advice the JSON does not support (no 'write
more efficient code', no boilerplate unconnected to this batch's actual
numbers). Print only the 3-6 lines, nothing else."

for i in $(seq 1 "$RUNS"); do
  # PROSE: turn the computed CostBreakdown into Step 11's human-readable report.
  $CLAUDE_CMD "$PROSE_PROMPT" --add-dir "$OUT" > "$OUT/prose-$i.txt"

  # GRADE: a fresh grader scores the prose against rubric.md, grounded on the
  # same breakdown.json the prose pass was given.
  $CLAUDE_CMD "Score the prose in $OUT/prose-$i.txt against the rubric in
    $HERE/rubric.md, grounded on the batch facts in $OUT/breakdown.json. Return
    only the JSON object the rubric specifies: {groundedInBatch,
    noGenericFiller, actionable, total, notes}." \
    --add-dir "$OUT" --add-dir "$HERE" > "$OUT/score-$i.json"
done

set +e
bun -e '
  const fs = require("fs");
  const runs = Number(process.argv[1]);
  const dir = process.argv[2];
  let sum = 0;
  for (let i = 1; i <= runs; i++) {
    const s = JSON.parse(fs.readFileSync(`${dir}/score-${i}.json`, "utf8"));
    sum += s.total;
  }
  const mean = sum / runs;
  console.log(`mean cost-suggest prose score: ${mean.toFixed(2)}/6 across ${runs} run(s) (pass threshold: 5/6)`);
  process.exit(mean >= 5 ? 0 : 1);
' "$RUNS" "$OUT"
CODE=$?
set -e

echo "artifacts in $OUT"
exit "$CODE"
