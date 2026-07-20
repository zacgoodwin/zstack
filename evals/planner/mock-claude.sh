#!/usr/bin/env bash
# Canned stand-in for `claude -p` (issue #25, AC1 clarification: "verify the
# harness end-to-end with a MOCKED claude -p ... so the paid path is exercised
# structurally without cost"). run.sh calls "$CLAUDE_CMD "$prompt" --add-dir
# ..." for both the plan and grade steps; this script IS that command when
# CLAUDE_CMD is pointed here. Real claude -p reads the prompt exactly the same
# way (its first argument), so run.sh is byte-for-byte identical whether
# CLAUDE_CMD is this stub or the real `claude -p` -- swapping CLAUDE_CMD is
# the only difference between this build's structural verification and the
# nightly eval's real (paid) run.
#
# Which canned output to emit is decided by sniffing the prompt text, exactly
# the two shapes run.sh's plan/grade prompts already use -- no special flag,
# so real claude -p and this stub see the identical invocation.
set -euo pipefail
PROMPT="${1:-}"

ticket() {
  local title="$1" estimate="$2" depends="$3"
  # issue #84: the grounding pass' `## Files` path -- normally
  # `src/store.ts`, which is real under evals/planner/fixture-app. Overridable
  # to a nonexistent path so a test can prove the harness's --check-paths
  # grounding gate (evals/planner/harness.ts checkRun) actually catches a
  # planner that lists a plausible-but-wrong path.
  local files_path="${MOCK_CLAUDE_BAD_FILES:+src/does-not-exist.ts}"
  files_path="${files_path:-src/store.ts}"
  cat << TICKET
# Ticket: $title

## Context

Canned mock-claude context for "$title" (evals/planner harness structural
check, issue #25) -- grounds on fixture-app/src/store.ts's Store class.

## Plan

- Extend \`src/store.ts\`'s \`Store\` class per the fixture spec/backlog ask.

### Acceptance Criteria

- Setup: the fixture Store is empty. Action: call the new method. Expected:
  the documented behavior, verified by a gate test.

## Tests + evals

- A gate test exercising the new method.

## Docs pages touched

- none.

## Out of scope

- anything not named above.

## Files

- \`$files_path\` -- the Store class this ticket extends.

Model: sonnet
Model Effort: medium
Estimate: ${MOCK_CLAUDE_ESTIMATE:-1.64}
Depends on: $depends
TICKET
}

if [[ "$PROMPT" == *"Score the plan"* ]]; then
  # GRADE step: rubric.md's JSON shape, {schema,grounding,acceptance,tiers,
  # dependencies,total,notes}. Every dimension field is fixed; only `total` is
  # overridable (MOCK_CLAUDE_TOTAL) so a test can drive the >= 8/10 pass gate
  # both ways (AC4) without touching the dimension breakdown.
  cat << SCORE
{"schema":2,"grounding":2,"acceptance":2,"tiers":1,"dependencies":2,"total":${MOCK_CLAUDE_TOTAL:-9},"notes":"mock-claude canned score (issue #25 structural check)"}
SCORE
elif [[ "$PROMPT" == *"--backlog"* ]]; then
  # PLAN step, backlog-scan pass: one ticket, standing in for what a real
  # /z-plan --backlog --dry-run would draft from fixture-backlog-ticket.md
  # against the board double.
  ticket "Delete a code from the store" "${MOCK_CLAUDE_ESTIMATE:-1.64}" "none"
else
  # PLAN step, spec pass: two tickets in a dependency chain, proving the
  # splitter handles more than one ticket per document.
  ticket "Persist the store to disk" "${MOCK_CLAUDE_ESTIMATE:-1.64}" "none"
  echo
  ticket "Shorten/resolve service" "${MOCK_CLAUDE_ESTIMATE:-1.64}" "#1"
fi
