#!/usr/bin/env bash
# Canned stand-in for `claude -p` (issue #71, mirroring evals/planner/mock-
# claude.sh's pattern). run.sh calls "$CLAUDE_CMD "$prompt" --add-dir ..." for
# the single-pass, adversarial, and grade steps; this script IS that command
# when CLAUDE_CMD is pointed here. Real claude -p reads the prompt exactly the
# same way (its first argument), so run.sh is byte-for-byte identical whether
# CLAUDE_CMD is this stub or the real `claude -p` -- swapping CLAUDE_CMD is the
# only difference between this build's free structural smoke test and the
# nightly eval's real (paid) run.
#
# Which canned output to emit is decided by sniffing the prompt text, exactly
# the three shapes run.sh's own prompts use -- no special flag, so real
# claude -p and this stub see the identical invocation. The canned outputs
# emit the intended-design outcome (single-pass approves, adversarial finds
# it) so a smoke run exercises every branch of run.sh's plumbing (both prompt
# shapes, the grade JSON parse, the >=4 threshold, the exit code) with zero
# cost; it says nothing about real model quality (evals/reviewer/run.md's
# "## Results" section holds that).
set -euo pipefail
PROMPT="${1:-}"

if [[ "$PROMPT" == *"Grade one reviewer trial"* ]]; then
  # GRADE step: rubric.md's JSON shape. Only `pass` is overridable
  # (MOCK_CLAUDE_PASS) so a test can drive the >=4/5 threshold both ways
  # without touching the other fields.
  cat << GRADE
{"adversarialMarker":"REVIEW-FINDINGS","singlePassMarker":"REVIEW-APPROVE","namesDefect":true,"adversarialConfidence":0,"pass":${MOCK_CLAUDE_PASS:-true}}
GRADE
elif [[ "$PROMPT" == *"Super-truth pass"* ]]; then
  # ADVERSARIAL prompt (only the adversarial branch carries this section
  # header, per lib/stage-prompts.ts's reviewerPrompt): canned fan-out finding
  # naming criterion 3's boundary defect, confidence below 100.
  cat << ADVERSARIAL
REVIEW-FINDINGS: confidence=0 1. src/window.ts -- the end-of-window check uses
an inclusive \`<=\` instead of the half-open \`<\`, violating acceptance
criterion 3 (withinWindow(1500, 1000, 500) must be false). 2. window.test.ts
has no test for criterion 3, so the shipped suite is green despite the bug.
(mock-claude canned finding, issue #71 structural check)
ADVERSARIAL
else
  # SINGLE-PASS prompt: canned unconditional approval, the intended-design
  # outcome the eval measures a delta against.
  cat << SINGLE
REVIEW-APPROVE: confidence=90 all four acceptance criteria read as satisfied
against the diff and the shipped tests are green. (mock-claude canned
approval, issue #71 structural check)
SINGLE
fi
