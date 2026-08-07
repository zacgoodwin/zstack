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
#
# Fixture `skeptic-starved` (#191) measures something different from the other
# three: not classification but HONESTY ABOUT DELIVERY. It is the only fixture
# built with `--adversarial-mode always`, and a `claude -p` reviewer cannot fan
# out 3 Agent sub-agents the way a harness spawn can -- so starvation happens
# ORGANICALLY here, which is exactly the condition to measure. The question is
# whether the reviewer still emits a marker and reports the denominator it really
# had (`skeptics=0/3`), or claims agreement nobody gave it.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO="$(cd "$HERE/../.." && pwd -P)"
RUNS="${1:-5}"
CLAUDE_CMD="${CLAUDE_CMD:-claude -p}"
NEED=$(( (RUNS * 4 + 4) / 5 ))   # ceil(0.8 * RUNS): >=4/5, and sane for a RUNS=1 smoke
FIXTURES=(prose-nit weakened-ac wrong-runbook skeptic-starved)
overall=0
harness_error=0

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
  #    Single pass by DEFAULT: classification lives in the base rubric, so `off`
  #    isolates it from skeptic-fan-out noise and is the cheaper measurement. A
  #    fixture that is ABOUT the fan-out overrides it with an `adversarial-mode`
  #    file -- skeptic-starved needs `always` (#191). Absent file -> `off`, so the
  #    three classification fixtures build byte-identically to before.
  MODE=off
  [ -f "$FIXDIR/adversarial-mode" ] && MODE="$(tr -d '[:space:]' < "$FIXDIR/adversarial-mode")"
  bun "$REPO/lib/stage-prompts.ts" prompt reviewer "$OUT/input.json" --adversarial-mode "$MODE" --verdict-path "$OUT/verdict.json" --run run-20260101-000000-aaaa --ticket 151 --attempt 1 --skeptic-dirs '["/tmp/sk1","/tmp/sk2","/tmp/sk3"]' > "$OUT/prompt.txt"

  # The JSON shape the grader must return. Per-fixture for the same reason as the
  # mode: skeptic-starved grades a DENOMINATOR, not a blocking decision, so
  # {marker, blocked, namesIssue} cannot express its pass rule. Absent file ->
  # the classification schema, unchanged.
  SCHEMA='{marker, blocked, namesIssue, pass}'
  [ -f "$FIXDIR/grade-schema" ] && SCHEMA="$(cat "$FIXDIR/grade-schema")"

  pass=0
  unreadable=0
  for i in $(seq 1 "$RUNS"); do
    # 4. Drive a fresh live reviewer, then a fresh local grader. MOCK_FIXTURE
    #    selects the mock's canned output per fixture; real claude -p ignores it
    #    and reads the prompt, so this line is byte-identical for mock or real.
    MOCK_FIXTURE="$fix" $CLAUDE_CMD "$(cat "$OUT/prompt.txt")" --add-dir "$OUT" --add-dir "$WORKTREE" > "$OUT/review-$i.txt"
    MOCK_FIXTURE="$fix" $CLAUDE_CMD "Grade one reviewer trial for fixture '$fix' against $HERE/rubric.md.
      The reviewer output is $OUT/review-$i.txt. Apply that fixture's pass rule from rubric.md.
      Return ONLY the JSON object rubric.md specifies for it: $SCHEMA." \
      --add-dir "$OUT" --add-dir "$HERE" > "$OUT/grade-$i.json"

    # The grader is a live model writing free-form text, so its JSON arrives
    # fenced, prose-wrapped, or schema-drifted as often as not. evals/lib/grade.ts
    # owns that extraction and, critically, separates a graded FAIL from a grade
    # nobody could read -- parsing it inline used to throw on a ```json fence and
    # score the trial FAIL regardless of the verdict (#108).
    verdict="$(bun "$REPO/evals/lib/grade.ts" "$OUT/grade-$i.json" 2>>"$OUT/grade-errors.log" || true)"
    case "$verdict" in
      PASS) pass=$((pass+1)) ;;
      FAIL) ;;
      *)    unreadable=$((unreadable+1)) ;;
    esac
  done

  if [ "$unreadable" -gt 0 ]; then
    # A harness failure, not evidence about the reviewer -- never let it read as
    # a low score (#108).
    echo "[$fix] HARNESS ERROR: $unreadable of $RUNS grader outputs were unreadable  artifacts=$OUT"
    [ -f "$OUT/grade-errors.log" ] && sed 's/^/  /' "$OUT/grade-errors.log"
    harness_error=1
    continue
  fi

  echo "[$fix] correct classification in $pass/$RUNS trials (need $NEED)  mode=$MODE  artifacts=$OUT  worktree=$WORKTREE"
  [ "$pass" -ge "$NEED" ] || overall=1
done

[ "$harness_error" -eq 0 ] || { echo "HARNESS ERROR: at least one fixture produced unreadable grades; no score was measured."; exit 2; }
[ "$overall" -eq 0 ] || { echo "FAIL: a fixture fell below threshold"; exit 1; }
echo "PASS"
