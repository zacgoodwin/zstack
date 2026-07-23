#!/usr/bin/env bash
# Reviewer FINDING-CLASSIFICATION eval (issue #179): does the reviewer bounce a
# functionally-correct diff over a prose-only nit, or ship it and file the nit?
# Sibling to evals/reviewer/ (which measures adversarial-vs-single defect
# surfacing on one fixture); this one measures blocking vs non-blocking
# classification across three fixtures. Every LLM call goes through local
# Claude Code ($CLAUDE_CMD, default `claude -p`) -- never a hosted API
# (PRINCIPLES.md "LLM access").
#
#   CLAUDE_CMD="$HERE/mock-claude.sh" evals/reviewer-severity/run.sh 5   # free, structural
#   evals/reviewer-severity/run.sh 5                                     # real, paid (nightly)
#
# COUPLED TO #179: fixture `prose-nit` REQUIRES the `observations:` grammar #179
# adds to REVIEW-APPROVE. Against today's reviewer prompt it bounces (no
# non-blocking channel exists), so a real run is RED on prose-nit until #179
# lands. The mock proves the harness plumbing now; see run.md "## Results".
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO="$(cd "$HERE/../.." && pwd -P)"
RUNS="${1:-5}"
CLAUDE_CMD="${CLAUDE_CMD:-claude -p}"
NEED=$(( (RUNS * 4 + 4) / 5 ))   # ceil(0.8 * RUNS): >=4/5, and sane for a RUNS=1 smoke
FIXTURES=(prose-nit weakened-ac wrong-runbook)
overall=0

for fix in "${FIXTURES[@]}"; do
  FIXDIR="$HERE/fixtures/$fix"
  OUT="$(mktemp -d)"

  # 1. Materialize diff.patch into a live throwaway worktree so `worktreePath`
  #    is a real path the reviewer can inspect and run tests in (mirrors
  #    production's git worktree add, and evals/reviewer/run.sh). These fixtures
  #    carry no git history, so a plain `git apply` into a scratch dir is the
  #    equivalent materialization.
  WORKTREE="$(mktemp -d)"
  git apply --unsafe-paths --directory="$WORKTREE" "$FIXDIR/diff.patch"

  # 2. Assemble the BLINDED four-key reviewer input. AC is extracted from the
  #    ticket exactly as z-loop/SKILL.md does (awk on the h3 heading).
  AC="$(awk '/^### Acceptance Criteria/{f=1;next} /^#/{f=0} f' "$FIXDIR/ticket.md")"
  bun -e "import {readFileSync,writeFileSync} from 'node:fs';
    writeFileSync(process.argv[5], JSON.stringify({
      ticketBody: readFileSync(process.argv[1],'utf8'),
      acceptanceCriteria: process.argv[2],
      diff: readFileSync(process.argv[3],'utf8'),
      worktreePath: process.argv[4],
    }));" "$FIXDIR/ticket.md" "$AC" "$FIXDIR/diff.patch" "$WORKTREE" "$OUT/input.json"

  # 3. Build the reviewer prompt via the CLI (the constructor is the contract).
  #    Single pass: classification lives in the base rubric, so `off` isolates it
  #    from skeptic-fan-out noise and is the cheaper measurement.
  bun "$REPO/lib/stage-prompts.ts" prompt reviewer "$OUT/input.json" --adversarial-mode off > "$OUT/prompt.txt"

  pass=0
  for i in $(seq 1 "$RUNS"); do
    # 4. Drive a fresh live reviewer, then a fresh local grader. MOCK_FIXTURE
    #    selects the mock's canned output per fixture; real claude -p ignores it
    #    and reads the prompt, so this line is byte-identical for mock or real.
    MOCK_FIXTURE="$fix" $CLAUDE_CMD "$(cat "$OUT/prompt.txt")" --add-dir "$OUT" --add-dir "$WORKTREE" > "$OUT/review-$i.txt"
    MOCK_FIXTURE="$fix" $CLAUDE_CMD "Grade one reviewer trial for fixture '$fix' against $HERE/rubric.md.
      The reviewer output is $OUT/review-$i.txt. Apply that fixture's pass rule from rubric.md.
      Return ONLY the JSON object rubric.md specifies: {marker, blocked, namesIssue, pass}." \
      --add-dir "$OUT" --add-dir "$HERE" > "$OUT/grade-$i.json"

    # Write a plain string token, not a boolean: bun's console.log colorizes a
    # bare boolean (\e[33mtrue\e[0m) even into a pipe, which no `= "true"`
    # compare would ever match. process.stdout.write of a string never does.
    if [ "$(bun -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).pass===true ? 'PASS' : 'FAIL')" "$OUT/grade-$i.json")" = "PASS" ]; then
      pass=$((pass+1))
    fi
  done

  echo "[$fix] correct classification in $pass/$RUNS trials (need $NEED)  artifacts=$OUT  worktree=$WORKTREE"
  [ "$pass" -ge "$NEED" ] || overall=1
done

[ "$overall" -eq 0 ] || { echo "FAIL: a fixture fell below threshold"; exit 1; }
echo "PASS"
