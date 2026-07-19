# /z-plan eval harness

The harness C10 wires fully. It is the **paid lane** (LLM calls) and is NOT part
of the gate suite (`bun test`). Every LLM call goes through **local Claude Code
(`claude -p`)** — never a hosted API (PRINCIPLES.md "LLM access").

Two passes: **plan** (run the planner in dry-run mode on the fixture spec) and
**grade** (score the output against `rubric.md`). Repeat for N runs and average
the totals; pass when the average total ≥ 8/10 (`rubric.md`).

## Inputs

- `fixture-spec.md` — the spec fed to the planner.
- `fixture-app/` — the target codebase the planner grounds against (contains only
  `src/store.ts` so far, so grounding is checkable).
- `rubric.md` — the scoring contract.
- `../../z-plan/SKILL.md` — the planner under test.
- `../../bin/z-ticket-lint` — the deterministic half of dimension 1.

## Stub (shape only; C10 makes it robust)

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO="$(cd "$HERE/../.." && pwd -P)"
RUNS="${1:-3}"
OUT="$(mktemp -d)"

for i in $(seq 1 "$RUNS"); do
  # PLAN: run /z-plan in dry-run mode against the fixture app + spec.
  # --add-dir grants read access to the fixture app tree for grounding.
  claude -p "/z-plan --dry-run $HERE/fixture-spec.md" \
    --add-dir "$HERE/fixture-app" \
    > "$OUT/plan-$i.md"

  # SCHEMA GATE (deterministic, dimension 1): split the dry-run output into its
  # per-ticket bodies and lint each. C10 owns the splitter; each body must exit 0.
  # "$REPO/bin/z-ticket-lint" "$OUT/ticket-<n>.md"

  # GRADE: a fresh grader scores the plan against the rubric, returning JSON.
  claude -p "Score the plan in $OUT/plan-$i.md against the rubric in
    $HERE/rubric.md, grounded on the app in $HERE/fixture-app. Return only the
    JSON object the rubric specifies." \
    --add-dir "$OUT" --add-dir "$HERE" \
    > "$OUT/score-$i.json"
done

# AGGREGATE: average the .total fields; pass when the mean >= 8.
# C10 wires the jq/bun aggregation and the pass/fail exit code here.
echo "scores in $OUT"
```

## What C10 finishes

- The dry-run output splitter (one file per ticket) feeding `z-ticket-lint`.
- The aggregation of `score-*.json` totals and the ≥8 pass gate (exit code).
- Determinism guard: the same fixture spec must yield the same Estimate values
  across runs (issue #7 AC2), so the harness also asserts the Estimate fields are
  identical run-to-run — the reproducible half, separate from the graded quality.
- Nightly scheduling alongside the other periodic evals.
