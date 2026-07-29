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
# emit the intended-design outcome (the fan-out names more planted defects than
# the single pass) so a smoke run exercises every branch of run.sh's plumbing
# (both prompt shapes, the per-defect grade parse, recall.ts's threshold, the
# exit code) with zero cost; it says nothing about real model quality
# (evals/reviewer/run.md's "## Results" section holds that).
set -euo pipefail
PROMPT="${1:-}"

if [[ "$PROMPT" == *"MATCHING findings to a known defect list"* ]]; then
  # GRADE step: the per-defect map recall.ts scores. MOCK_CLAUDE_PASS drives the
  # threshold both ways -- true gives the fan-out a strictly larger defect set
  # (trial passes), false makes the two modes tie (trial fails). Every defect id
  # in fixtures/multi-defect/defects.json must appear in BOTH maps, because
  # recall.ts treats a missing id as UNREADABLE rather than as a miss.
  if [[ "${MOCK_CLAUDE_PASS:-true}" == "true" ]]; then
    ADV='{"D1":true,"D2":true,"D3":true,"D4":true,"D5":true,"D6":true,"D7":false,"D8":false}'
  else
    ADV='{"D1":true,"D2":true,"D3":false,"D4":false,"D5":false,"D6":false,"D7":false,"D8":false}'
  fi
  SINGLE='{"D1":true,"D2":true,"D3":false,"D4":false,"D5":false,"D6":false,"D7":false,"D8":false}'
  GRADE_JSON="{\"single\":$SINGLE,\"adversarial\":$ADV,\"singleUnmatched\":1,\"adversarialUnmatched\":2,\"singleMarker\":\"REVIEW-FINDINGS\",\"adversarialMarker\":\"REVIEW-FINDINGS\"}"
  # MOCK_CLAUDE_GRADE_WRAP reproduces how the REAL grader formats its reply.
  # Bare JSON was the only shape this mock ever emitted, which is why the paid
  # run on #108 hit a fence-parse bug the free smoke test could not see: 4 of 5
  # real grade files came back fenced and scored FAIL regardless of verdict.
  case "${MOCK_CLAUDE_GRADE_WRAP:-none}" in
    fence)  printf '```json\n%s\n```\n' "$GRADE_JSON" ;;
    prose)  printf 'Here is the mapping for this trial:\n\n%s\n\nLet me know if you need the reasoning.\n' "$GRADE_JSON" ;;
    garbage) printf 'I was unable to grade this trial.\n' ;;
    drift)  printf '{"single":{"D1":true},"adversarial":{"D1":true}}\n' ;;
    *)      printf '%s\n' "$GRADE_JSON" ;;
  esac
elif [[ "$PROMPT" == *"Super-truth pass"* ]]; then
  # ADVERSARIAL prompt (only the adversarial branch carries this section
  # header, per lib/stage-prompts.ts's reviewerPrompt): canned fan-out finding
  # a wider set than the single pass, confidence below 100.
  cat << ADVERSARIAL
REVIEW-FINDINGS: confidence=0 1. src/limiter.ts -- allow() charges the shared
ceiling before checking the key's own budget, so rejected traffic spends
globalLimit slots and starves other keys (criteria 4 and 5). 2. The constructor
never validates globalLimit, so 0 is accepted and rejects everything (criterion
8). 3. Nothing in the shipped path calls sweep(), so the key table grows without
bound (criterion 7). 4. The middleware admits the request when the limiter
throws (criterion 11). 5. The client id is used unnormalized, so case and
whitespace variants each get their own budget (criterion 10). 6. Retry-After is
emitted in milliseconds, not seconds (criterion 9).
(mock-claude canned finding, issue #71 structural check)
ADVERSARIAL
else
  # SINGLE-PASS prompt: canned narrower finding set, the intended-design
  # outcome the eval measures a recall delta against.
  cat << SINGLE
REVIEW-FINDINGS: 1. src/limiter.ts -- allow() charges the shared ceiling before
the per-key check, so rejected traffic starves other keys (criteria 4 and 5).
2. The constructor never validates globalLimit (criterion 8).
(mock-claude canned finding, issue #71 structural check)
SINGLE
fi
