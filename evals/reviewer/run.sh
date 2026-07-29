#!/usr/bin/env bash
# The runnable adversarial-reviewer eval harness (issue #59, packaged by #71,
# re-targeted after #108). Every LLM call goes through **local Claude Code**
# ($CLAUDE_CMD, default `claude -p`) -- never a hosted API (PRINCIPLES.md "LLM
# access").
#
#   CLAUDE_CMD="$HERE/mock-claude.sh" evals/reviewer/run.sh 1   # free, structural
#   evals/reviewer/run.sh 5                                     # real, paid (nightly)
#
# What it measures (rubric.md holds the contract): RECALL. Both modes review one
# diff carrying many independent planted defects, and a trial passes when the
# adversarial fan-out names strictly more of them than the single pass. The old
# contract -- one planted needle single-pass had to MISS -- was abandoned after
# four fixture redesigns and 16 real single-pass reads showed it cannot be
# satisfied (run.md "## Results"): a planted defect must violate a stated
# criterion or the rubric cannot grade it, so the criteria index the defect and
# a code-executing reviewer audits its way to it every time.
#
# The latent/deterministic split is the point (PRINCIPLES.md): the live grader
# answers ONLY "did this output name defect D3?", and every count, mean, delta
# and threshold is computed by evals/lib/recall.ts under gate tests
# (tests/reviewer-recall.test.ts). No score is ever read out of a model's prose.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO="$(cd "$HERE/../.." && pwd -P)"
FIX="$HERE/fixtures/multi-defect"
RUNS="${1:-5}"
CLAUDE_CMD="${CLAUDE_CMD:-claude -p}"
OUT="$(mktemp -d)"

# CLAUDE_CMD may be a repo-relative script (the mock, per run.md's smoke
# command). The reviewer passes below run from inside the throwaway worktree,
# so absolutize a relative script path now or the cd would break it.
CMD_FIRST="${CLAUDE_CMD%% *}"
if [ -f "$CMD_FIRST" ]; then
  CMD_REST="${CLAUDE_CMD#"$CMD_FIRST"}"
  CLAUDE_CMD="$(cd "$(dirname "$CMD_FIRST")" && pwd -P)/$(basename "$CMD_FIRST")$CMD_REST"
fi

# 1. Materialize diff.patch into a real throwaway directory so `worktreePath`
#    is a live filesystem path the reviewer can actually inspect and run tests
#    in -- mirroring production's `git worktree add ".worktrees/review-<N>" <head-sha>`
#    (z-loop/SKILL.md, issue #118: outside ~/.zstack so the reviewer's full test
#    suite run can never resolve onto live loop state) -- instead of the dead
#    /tmp placeholder neither prompt's
#    unconditional "run the typecheck and tests this diff touches here" could
#    ever act on (#88). This fixture carries no real git history, so a plain
#    `git apply` into a fresh scratch dir is the equivalent materialization.
WORKTREE="$(mktemp -d)"
git apply --unsafe-paths --directory="$WORKTREE" "$FIX/diff.patch"

# 2. Assemble the BLINDED four-key reviewer input from the fixture. The AC
#    section is extracted exactly as z-loop/SKILL.md does (awk on the heading).
#    defects.json is NEVER part of this input -- it is the grader's answer key
#    and the reviewer must never see it.
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

for i in $(seq 1 "$RUNS"); do
  # 4. Drive each prompt through a fresh live Agent (local Claude Code). The
  #    adversarial run fans out skeptics via the Agent tool from inside this run.
  #    Each reviewer runs FROM the throwaway worktree (same as production) and
  #    is granted only $OUT on top: this fixture is the first to ship an answer
  #    key (defects.json) in the repo tree, and a reviewer whose cwd is the repo
  #    could read the very list it is scored against. Blindness must not rest
  #    on the subject honoring "do not look anywhere else" (gate-tested in
  #    tests/reviewer-recall.test.ts).
  ( cd "$WORKTREE" && $CLAUDE_CMD "$(cat "$OUT/single.txt")"      --add-dir "$OUT" ) > "$OUT/single-$i.txt"
  ( cd "$WORKTREE" && $CLAUDE_CMD "$(cat "$OUT/adversarial.txt")" --add-dir "$OUT" ) > "$OUT/adversarial-$i.txt"

  # 5. Map BOTH outputs onto the answer key with a fresh local grader. This is
  #    the only latent step, and it is deliberately a matching task: no scoring,
  #    no thresholds, no judgement about which mode won.
  $CLAUDE_CMD "Grade one reviewer trial by MATCHING findings to a known defect list.
    The defect list is $FIX/defects.json. The single-pass reviewer output is
    $OUT/single-$i.txt and the adversarial output is $OUT/adversarial-$i.txt.
    For EACH defect id in the list, decide whether that reviewer output actually
    names that defect -- the same site and the same mechanism, in its own words.
    A finding that gestures at the right file but describes a different problem
    is NOT a match. Count findings matching no listed defect separately.
    Return ONLY this JSON object, with every defect id present in both maps:
    {\"single\":{\"D1\":true|false,...},\"adversarial\":{\"D1\":true|false,...},
     \"singleUnmatched\":<int>,\"adversarialUnmatched\":<int>,
     \"singleMarker\":\"<the marker its final message starts with>\",
     \"adversarialMarker\":\"<same>\"}" \
    --add-dir "$OUT" --add-dir "$HERE" > "$OUT/grade-$i.json"
done

# 6. Score deterministically. recall.ts prints the per-defect catch table, both
#    means, and the trial count against the threshold, then exits 0 (pass), 1
#    (below threshold) or 2 (HARNESS ERROR -- at least one grade was unreadable,
#    so no measurement was taken and a tally would mean nothing). An unreadable
#    grade is never folded into a score: that is the #108 failure mode.
set +e
bun "$REPO/evals/lib/recall.ts" "$FIX/defects.json" "$OUT"/grade-*.json
STATUS=$?
set -e

echo "artifacts in $OUT"
echo "materialized worktree in $WORKTREE"
case "$STATUS" in
  0) echo "PASS" ;;
  1) echo "FAIL: below threshold" ;;
  *) echo "HARNESS ERROR: no score was taken -- rerun; do not record this run in run.md" ;;
esac
exit "$STATUS"
