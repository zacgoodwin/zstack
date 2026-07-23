#!/usr/bin/env bash
# Canned stand-in for `claude -p` (mirrors evals/reviewer/mock-claude.sh). The
# reviewer step's canned output is chosen by MOCK_FIXTURE, which run.sh sets per
# fixture; real `claude -p` ignores that env var and reads the prompt text, so
# run.sh is byte-for-byte identical whether CLAUDE_CMD is this stub or the real
# thing. The canned outputs emit the INTENDED post-#179 classification (prose
# nit -> approve + observation; functional / runbook defect -> findings) so a
# mock run exercises every branch of run.sh's plumbing (marker parse, per-fixture
# pass rule, ceil-0.8 threshold, exit code) at zero cost; it says nothing about
# real model quality (run.md "## Results" holds that).
set -euo pipefail
PROMPT="${1:-}"

if [[ "$PROMPT" == *"Grade one reviewer trial"* ]]; then
  # GRADE step: rubric.md's JSON shape. Only `pass` is overridable
  # (MOCK_CLAUDE_PASS) so a test can drive the threshold both ways without
  # touching the other fields.
  case "${MOCK_FIXTURE:-}" in
    prose-nit) m=REVIEW-APPROVE;  b=false ;;
    *)         m=REVIEW-FINDINGS; b=true  ;;
  esac
  cat << GRADE
{"marker":"$m","blocked":$b,"namesIssue":true,"pass":${MOCK_CLAUDE_PASS:-true}}
GRADE
  exit 0
fi

# REVIEWER step: the intended post-#179 verdict for each fixture.
case "${MOCK_FIXTURE:-}" in
  prose-nit)
    cat << 'A'
REVIEW-APPROVE: confidence=95 all four acceptance criteria verified against the diff (within / below / above / reversed-bounds-throws), src/clamp.test.ts covers all four and is green, typecheck clean.
observations:
1. src/clamp.ts:2-3 -- the comment claims clamp is "branch-free on every JS engine" and "never mispredicts", but the body uses two ternary branches; the claim is unproven and false. Non-blocking (comment only, no behavior change) -- file as a follow-up, do NOT bounce.
A
    ;;
  weakened-ac)
    cat << 'B'
REVIEW-FINDINGS: 1. src/clamp.ts:3 -- acceptance criterion 4 requires clamp(5, 10, 0) to THROW a RangeError on reversed bounds; the diff silently swaps lo/hi instead and src/clamp.test.ts:13 asserts it returns 5. The criterion is silently weakened behind a green suite -- a functional defect. Blocks the merge.
B
    ;;
  wrong-runbook)
    cat << 'C'
REVIEW-FINDINGS: 1. docs/user-guide/backfill.md -- acceptance criteria 1 and 2 require Step 1 to snapshot every row BEFORE running the backfill; the diff runs the backfill first and snapshots only "if something looks wrong afterward", the reverse order. The prose IS the deliverable and a wrong safety runbook drives the operator into an unreversible data-loss action -- the carve-out applies. Blocks the merge.
C
    ;;
  *)
    echo "REVIEW-CONFUSED: mock-claude received no MOCK_FIXTURE"
    ;;
esac
