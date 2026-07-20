#!/usr/bin/env bash
# The runnable adversarial-reviewer eval harness (issue #59, packaged by #71),
# extracted verbatim from run.md's inline bash to match evals/planner/run.sh's
# shape. Every LLM call goes through **local Claude Code** ($CLAUDE_CMD,
# default `claude -p`) -- never a hosted API (PRINCIPLES.md "LLM access").
#
#   CLAUDE_CMD="$HERE/mock-claude.sh" evals/reviewer/run.sh 1   # free, structural
#   evals/reviewer/run.sh 5                                     # real, paid (nightly)
#
# See run.md for the full contract (per-trial pass rule, >=4/5 threshold, and
# the "## Results" section's recorded real-run score and known fixture gaps).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO="$(cd "$HERE/../.." && pwd -P)"
FIX="$HERE/fixtures/planted-defect"
RUNS="${1:-5}"
CLAUDE_CMD="${CLAUDE_CMD:-claude -p}"
OUT="$(mktemp -d)"

# 1. Materialize diff.patch into a real throwaway directory so `worktreePath`
#    is a live filesystem path the reviewer can actually inspect and run tests
#    in -- mirroring production's `git worktree add "$TMP/review-<N>" <head-sha>`
#    (z-loop/SKILL.md) -- instead of the dead /tmp placeholder neither prompt's
#    unconditional "run the typecheck and tests this diff touches here" could
#    ever act on (#88). This fixture carries no real git history, so a plain
#    `git apply` into a fresh scratch dir is the equivalent materialization.
WORKTREE="$(mktemp -d)"
git apply --unsafe-paths --directory="$WORKTREE" "$FIX/diff.patch"

# 2. Assemble the BLINDED four-key reviewer input from the fixture. The AC
#    section is extracted exactly as z-loop/SKILL.md does (awk on the heading).
AC="$(awk '/^### Acceptance Criteria/{f=1;next} /^#/{f=0} f' "$FIX/ticket.md")"
bun -e "import {readFileSync,writeFileSync} from 'node:fs';
  writeFileSync(process.argv[5], JSON.stringify({
    ticketBody: readFileSync(process.argv[1],'utf8'),
    acceptanceCriteria: process.argv[2],
    diff: readFileSync(process.argv[3],'utf8'),
    worktreePath: process.argv[4],
  }));" "$FIX/ticket.md" "$AC" "$FIX/diff.patch" "$WORKTREE" "$OUT/input.json"

# 3. Build BOTH prompts via the CLI (the constructor is the contract). off = the
#    single pass; always = the super-truth fan-out. Same input file, no key added.
bun "$REPO/lib/stage-prompts.ts" prompt reviewer "$OUT/input.json" --adversarial-mode off    > "$OUT/single.txt"
bun "$REPO/lib/stage-prompts.ts" prompt reviewer "$OUT/input.json" --adversarial-mode always  > "$OUT/adversarial.txt"

pass=0
for i in $(seq 1 "$RUNS"); do
  # 4. Drive each prompt through a fresh live Agent (local Claude Code). The
  #    adversarial run fans out skeptics via the Agent tool from inside this run.
  #    --add-dir "$WORKTREE" grants the "run the typecheck and tests" step from
  #    step 1 real filesystem access, same as --add-dir "$OUT" grants for I/O.
  $CLAUDE_CMD "$(cat "$OUT/single.txt")"       --add-dir "$OUT" --add-dir "$WORKTREE" > "$OUT/single-$i.txt"
  $CLAUDE_CMD "$(cat "$OUT/adversarial.txt")"  --add-dir "$OUT" --add-dir "$WORKTREE" > "$OUT/adversarial-$i.txt"

  # 5. Grade markers + defect-naming with a fresh local grader (deterministic
  #    marker parse; the grader confirms the findings name criterion 3).
  $CLAUDE_CMD "Grade one reviewer trial against $HERE/rubric.md. The single-pass
    reviewer output is $OUT/single-$i.txt and the adversarial output is
    $OUT/adversarial-$i.txt. Return ONLY the JSON object rubric.md specifies:
    {adversarialMarker, singlePassMarker, namesDefect, adversarialConfidence, pass}." \
    --add-dir "$OUT" --add-dir "$HERE" > "$OUT/grade-$i.json"

  if [ "$(bun -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).pass===true)" "$OUT/grade-$i.json")" = "true" ]; then
    pass=$((pass+1))
  fi
done

echo "adversarial surfaced the defect in $pass/$RUNS trials (pass threshold: 4/5)"
echo "artifacts in $OUT"
echo "materialized worktree in $WORKTREE"
[ "$pass" -ge 4 ] || { echo "FAIL: below threshold"; exit 1; }
echo "PASS"
