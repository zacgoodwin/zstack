# /z-loop adversarial reviewer eval

Measures issue #59's REVIEW QUALITY claim: adversarial mode surfaces a subtle
planted defect that single-pass review approves. **Paid lane** (LLM calls), NOT
in the gate suite (`bun test`). Every LLM call goes through **local Claude Code
(`claude -p`)** — never a hosted API (PRINCIPLES.md "LLM access"). The
deterministic half of #59 is gate-tested in `tests/stage-prompts.test.ts`; this
eval covers only the latent half a predicate can't.

The reviewer's active prompt spawns skeptic sub-agents via the **Agent tool**
(nested `claude -p` is denied by the classifier — MEMORY). The outer `claude -p`
here is a first-level headless run from the shell (same as `evals/planner`), so
the reviewer's inner Agent-tool fan-out is allowed.

## Inputs

- `fixtures/planted-defect/ticket.md` — the ticket body, carrying its
  `### Acceptance Criteria`. Criterion 3 is the boundary the defect violates.
- `fixtures/planted-defect/diff.patch` — a two-file diff (`src/window.ts` +
  `src/window.test.ts`) that typechecks, is green, and hides a `<=`-vs-`<`
  off-by-one on the half-open window's end. The test file skips the boundary
  case, so nothing green exercises the bug.
- `rubric.md` — the per-trial pass contract and the ≥ 4/5 threshold (AC11).
- `../../lib/stage-prompts.ts` — the prompt constructor under test.

## What the harness does

Both prompts are built from the SAME blinded four-key input (blindness intact:
mode rides as a `--adversarial-mode` flag, never a fifth key), then each is
driven through a fresh live Agent for N trials:

- **single-pass** ← `--adversarial-mode off` → `reviewerPrompt(input, false)`.
- **adversarial** ← `--adversarial-mode always` → `reviewerPrompt(input, true)`.

A trial passes when the adversarial run ends `REVIEW-FINDINGS:` naming
criterion 3's boundary defect with a below-100 `confidence=`, AND the single-pass
run ends `REVIEW-APPROVE:` (rubric.md). Pass the eval at ≥ 4/5.

## Running it

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO="$(cd "$HERE/../.." && pwd -P)"
FIX="$HERE/fixtures/planted-defect"
RUNS="${1:-5}"
OUT="$(mktemp -d)"

# 1. Assemble the BLINDED four-key reviewer input from the fixture. The AC
#    section is extracted exactly as z-loop/SKILL.md does (awk on the heading).
AC="$(awk '/^### Acceptance Criteria/{f=1;next} /^#/{f=0} f' "$FIX/ticket.md")"
bun -e "import {readFileSync,writeFileSync} from 'node:fs';
  writeFileSync(process.argv[4], JSON.stringify({
    ticketBody: readFileSync(process.argv[1],'utf8'),
    acceptanceCriteria: process.argv[2],
    diff: readFileSync(process.argv[3],'utf8'),
    worktreePath: '/tmp/review-throwaway-planted',
  }));" "$FIX/ticket.md" "$AC" "$FIX/diff.patch" "$OUT/input.json"

# 2. Build BOTH prompts via the CLI (the constructor is the contract). off = the
#    single pass; always = the super-truth fan-out. Same input file, no key added.
bun "$REPO/lib/stage-prompts.ts" prompt reviewer "$OUT/input.json" --adversarial-mode off    > "$OUT/single.txt"
bun "$REPO/lib/stage-prompts.ts" prompt reviewer "$OUT/input.json" --adversarial-mode always  > "$OUT/adversarial.txt"

pass=0
for i in $(seq 1 "$RUNS"); do
  # 3. Drive each prompt through a fresh live Agent (local Claude Code). The
  #    adversarial run fans out skeptics via the Agent tool from inside this run.
  claude -p "$(cat "$OUT/single.txt")"       --add-dir "$OUT" > "$OUT/single-$i.txt"
  claude -p "$(cat "$OUT/adversarial.txt")"  --add-dir "$OUT" > "$OUT/adversarial-$i.txt"

  # 4. Grade markers + defect-naming with a fresh local grader (deterministic
  #    marker parse; the grader confirms the findings name criterion 3).
  claude -p "Grade one reviewer trial against $HERE/rubric.md. The single-pass
    reviewer output is $OUT/single-$i.txt and the adversarial output is
    $OUT/adversarial-$i.txt. Return ONLY the JSON object rubric.md specifies:
    {adversarialMarker, singlePassMarker, namesDefect, adversarialConfidence, pass}." \
    --add-dir "$OUT" --add-dir "$HERE" > "$OUT/grade-$i.json"

  if [ "$(bun -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).pass===true)" "$OUT/grade-$i.json")" = "true" ]; then
    pass=$((pass+1))
  fi
done

echo "adversarial surfaced the defect in $pass/$RUNS trials (pass threshold: 4/5)"
[ "$pass" -ge 4 ] || { echo "FAIL: below threshold"; exit 1; }
echo "PASS"
```

Exit 0 = the fan-out beat single-pass on the planted defect in ≥ 4/5 trials;
exit 1 = below threshold, with the per-trial grades in `$OUT` either way.

## Verifying the harness offline (free)

The fixture and both prompts are checkable with zero cost — this asserts the
input stays four-key-blinded and the two branches diverge exactly as the gate
tests pin, without any `claude -p`:

```bash
FIX=evals/reviewer/fixtures/planted-defect
AC="$(awk '/^### Acceptance Criteria/{f=1;next} /^#/{f=0} f' "$FIX/ticket.md")"
bun -e "import {readFileSync,writeFileSync} from 'node:fs';
  writeFileSync('/tmp/rv.json', JSON.stringify({ticketBody:readFileSync('$FIX/ticket.md','utf8'),
    acceptanceCriteria:process.argv[1],diff:readFileSync('$FIX/diff.patch','utf8'),
    worktreePath:'/tmp/x'}));" "$AC"
bun lib/stage-prompts.ts prompt reviewer /tmp/rv.json --adversarial-mode off    | grep -qv skeptic && echo "single pass: ok"
bun lib/stage-prompts.ts prompt reviewer /tmp/rv.json --adversarial-mode always | grep -q  skeptic && echo "adversarial: ok"
```

## Nightly scheduling

Documentation only — the command; scheduling is the user's cron/routine:

```cron
# Nightly, real claude -p, 5 trials:
0 4 * * * cd /path/to/zstack-1 && evals/reviewer/run.sh 5
```
