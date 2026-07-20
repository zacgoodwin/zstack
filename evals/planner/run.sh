#!/usr/bin/env bash
# The runnable planner eval harness (issue #25), generalized over both passes.
# Every LLM call goes through **local Claude Code** (`$CLAUDE_CMD`, default
# `claude -p`) -- never a hosted API (PRINCIPLES.md "LLM access").
#
#   CLAUDE_CMD="$HERE/mock-claude.sh" evals/planner/run.sh backlog 1   # free, structural
#   evals/planner/run.sh spec 3                                        # real, paid (nightly)
#
# See run.md for the full contract (pass threshold, reproducibility, the
# board double's remaining real-run prerequisite).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO="$(cd "$HERE/../.." && pwd -P)"
PASS="${1:?usage: run.sh <spec|backlog> [runs]}"
RUNS="${2:-3}"
CLAUDE_CMD="${CLAUDE_CMD:-claude -p}"
OUT="$(mktemp -d)"

case "$PASS" in
  spec)
    for i in $(seq 1 "$RUNS"); do
      $CLAUDE_CMD "/z-plan --dry-run $HERE/fixture-spec.md" \
        --add-dir "$HERE/fixture-app" \
        > "$OUT/plan-$i.md"

      $CLAUDE_CMD "Score the plan in $OUT/plan-$i.md against the rubric in
        $HERE/rubric.md, grounded on the app in $HERE/fixture-app. Return only the
        JSON object the rubric specifies." \
        --add-dir "$OUT" --add-dir "$HERE" \
        > "$OUT/score-$i.json"
    done
    ;;

  backlog)
    # Board double (issue #25): PATH-shim `gh` so Step 0's `gh repo view` /
    # `gh auth status`, z-board's `list --status Backlog` (routed through
    # `gh api /graphql`), and Step 10's issue-body fetch (gh's issue-view
    # subcommand) all resolve to board-double.ts, which serves
    # fixture-backlog-ticket.md as the sole Backlog item -- zero network, no
    # live GitHub project.
    #
    # Two shim files, not one: the skill's own bash snippets (`gh repo view`,
    # `gh auth status`, gh's issue-view subcommand) exec a bare "gh" the way
    # bash always resolves PATH -- an exact-name match, shebang included. But
    # z-board's ghExecutor (lib/board.ts) calls `gh api /graphql` via
    # Bun.spawnSync, which on Windows goes straight through the OS's
    # CreateProcess (no shell in between) and cannot follow a shebang on an
    # extension-less file (confirmed: the same ENOENT bin/z-ticket-lint hits
    # under Bun.spawnSync without a "bash" prefix) -- it needs a
    # PATHEXT-recognized extension instead. `gh.cmd` covers that second call
    # path; `gh` (bare) covers the first. Both delegate to the same
    # board-double.ts.
    GHDIR="$(mktemp -d)"
    trap 'rm -rf "$GHDIR"' EXIT
    cat > "$GHDIR/gh" << SHIM
#!/usr/bin/env bash
exec bun "$REPO/evals/planner/board-double.ts" "\$@"
SHIM
    chmod +x "$GHDIR/gh"
    # gh.cmd is run by native cmd.exe (via Bun.spawnSync, no MSYS in between),
    # so its embedded path must be Windows-style, not the POSIX $REPO form --
    # cygpath is the standard MSYS converter; on a non-Windows nightly host
    # neither cygpath nor gh.cmd itself is ever consulted (bash's bare "gh"
    # shebang above is what POSIX resolves), so falling back to $REPO there is
    # inert, not a silent correctness gap. `-m` (not `-w`): forward slashes
    # throughout (cmd.exe and bun both accept them in a quoted script path),
    # so the emitted file never contains a backslash at all.
    if command -v cygpath >/dev/null 2>&1; then
      REPO_FOR_CMD="$(cygpath -m "$REPO")"
    else
      REPO_FOR_CMD="$REPO"
    fi
    # Content and write both live in harness.ts's `gh-cmd-shim` (backed by the
    # pure, unit-tested ghCmdShimContent) -- NOT a bash `printf FORMAT` string.
    # printf's FORMAT argument interprets its own escape sequences ("\e" ->
    # ESC 0x1B, "\b" -> backspace 0x08) wherever they appear in FORMAT,
    # including inside a Windows path's escaped backslashes, which silently
    # corrupted this exact line into a dead path (confirmed:
    # `printf 'X\evals\board.ts\n'` -> "Xvalsoard.ts") until this fix.
    bun "$HERE/harness.ts" gh-cmd-shim "$REPO_FOR_CMD" "$GHDIR/gh.cmd"
    export PATH="$GHDIR:$PATH"
    export ZPLANNER_DOUBLE_SLUG="zstack-planner-eval"
    export ZPLANNER_DOUBLE_ISSUE="501"
    export ZPLANNER_DOUBLE_BODY_FILE="$HERE/fixture-backlog-ticket.md"

    for i in $(seq 1 "$RUNS"); do
      $CLAUDE_CMD "/z-plan --backlog --dry-run" \
        --add-dir "$HERE/fixture-app" \
        --add-dir "$HERE" \
        > "$OUT/plan-$i.md"

      $CLAUDE_CMD "Score the plan in $OUT/plan-$i.md against the 'Backlog
        scan pass' section of the rubric in $HERE/rubric.md, grounded on the app in
        $HERE/fixture-app. Return only the JSON object the rubric specifies." \
        --add-dir "$OUT" --add-dir "$HERE" \
        > "$OUT/score-$i.json"
    done
    ;;

  *)
    echo "unknown pass \"$PASS\" (expected spec|backlog)" >&2
    exit 1
    ;;
esac

set +e
bun "$HERE/harness.ts" check "$OUT" "$RUNS"
CODE=$?
set -e
echo "artifacts in $OUT"
exit "$CODE"
