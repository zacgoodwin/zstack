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

## Backlog-scan pass (issue #13)

A second, independent pass scores Step 10 (`z-plan/SKILL.md`'s Backlog scan)
rather than the spec-to-tickets flow above. Same paid lane, same `claude -p`
rule, same `bin/z-ticket-lint` deterministic half, same ≥8/10 pass threshold
(`rubric.md`'s "Backlog scan pass" section).

### Backlog-scan inputs

- `fixture-backlog-ticket.md` — a two-line human brain-dump with none of the
  schema sections (fails `bin/z-ticket-lint` as-is). Simulates the ticket
  Step 10 exists for: an unplanned Backlog ticket sitting unpromoted.
- `fixture-app/` — the same grounding target as the spec pass; the fixture's
  ask (delete a code from the store) builds on `src/store.ts`'s `Store` class.

### Stub (shape only; a live-board double is the follow-on that makes this robust)

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO="$(cd "$HERE/../.." && pwd -P)"
RUNS="${1:-3}"
OUT="$(mktemp -d)"

for i in $(seq 1 "$RUNS"); do
  # PLAN: run /z-plan --backlog in dry-run mode with fixture-backlog-ticket.md
  # standing in for the sole item "$Z_BOARD" list --status Backlog would
  # return in a live project. Wiring this fully needs a board double (a fake
  # $Z_BOARD executor, the same pattern tests/board.test.ts already uses for
  # lib/board.ts) so this pass never touches a real GitHub project.
  claude -p "/z-plan --backlog --dry-run" \
    --add-dir "$HERE/fixture-app" \
    --add-dir "$HERE" \
    > "$OUT/backlog-plan-$i.md"

  # SCHEMA GATE (deterministic, dimension 1): the one emitted body must exit 0.
  # "$REPO/bin/z-ticket-lint" "$OUT/backlog-ticket-$i.md"

  # GRADE: a fresh grader scores the plan against the rubric's Backlog scan
  # pass section, returning the same JSON shape as the spec pass.
  claude -p "Score the plan in $OUT/backlog-plan-$i.md against the 'Backlog
    scan pass' section of the rubric in $HERE/rubric.md, grounded on the app in
    $HERE/fixture-app. Return only the JSON object the rubric specifies." \
    --add-dir "$OUT" --add-dir "$HERE" \
    > "$OUT/backlog-score-$i.json"
done

echo "backlog-scan scores in $OUT"
```

### What's left to wire (same follow-on that finishes the stub above)

- A board double so `/z-plan --backlog` sees exactly one Backlog ticket
  (`fixture-backlog-ticket.md`'s body) with no live GitHub project.
- The dry-run output splitter feeding `bin/z-ticket-lint`.
- Aggregation of `backlog-score-*.json` totals against the same ≥8/10
  threshold, and nightly scheduling alongside the spec pass.
