# /z-plan eval harness

Wired (issue #25). It is the **paid lane** (LLM calls) and is NOT part of
the gate suite (`bun test`). Every LLM call goes through **local Claude Code
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

## The harness

- `harness.ts` (bun) — the deterministic pipeline as pure functions: splits a
  dry-run plan document into per-ticket bodies (`splitDryRunOutput`), lints
  each through `bin/z-ticket-lint` (`lintTicketBody`), aggregates the graded
  score JSON against the ≥ 8/10 pass threshold (`aggregateScores`,
  `PASS_THRESHOLD`), and asserts Estimate reproducibility run-to-run
  (`extractEstimates`, `checkReproducibility`, issue #7 AC2). `checkRun` ties
  these into one report over a run directory; `computeExitCode` turns the
  three gates (score, lint, reproducibility) into the one exit code the pass
  gate is (AC4: "a run whose average total is below 8" → non-zero, not
  prose). Gate-tested in `../../tests/planner-harness.test.ts` — fixture in,
  expected out, no `claude -p` involved.
- `run.sh` — the runnable orchestrator, generalized over both passes:
  `run.sh <spec|backlog> [runs]`. Shells `$CLAUDE_CMD` (default `claude -p`)
  for the plan/grade steps, writes `plan-<i>.md` / `score-<i>.json` to a temp
  dir, then calls `bun harness.ts check <dir> <runs>` for the pipeline above.
- `mock-claude.sh` — a canned stand-in for `claude -p`: emits a fixed plan or
  score by sniffing the prompt text (the same two prompt shapes `run.sh`
  always sends), so the whole paid-lane orchestration can be verified
  end-to-end with zero cost and zero network. Point `CLAUDE_CMD` at it to
  swap it in — `run.sh` itself is byte-for-byte identical either way.
- `board-double.ts` — the backlog-scan pass's board double (see below).

## Running it

```bash
# The real (paid) run -- nightly, or before ship:
evals/planner/run.sh spec 3
evals/planner/run.sh backlog 3

# The free, structural verification (this build's AC1/AC2/AC4; see
# tests/planner-harness.test.ts for the automated version of this):
CLAUDE_CMD="evals/planner/mock-claude.sh" evals/planner/run.sh spec 1
CLAUDE_CMD="evals/planner/mock-claude.sh" evals/planner/run.sh backlog 1
```

Exit 0 = pass (score ≥ 8/10 AND every ticket body lints clean AND Estimates
reproduced); exit 1 = fail, with the report (per-run totals, mean, lint
failures if any, reproducibility detail) on stdout either way.

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

### The board double (issue #25)

`/z-plan --backlog --dry-run` must run with no live GitHub project and no
network. `board-double.ts` is a fake `gh` CLI (not a fake `lib/board.ts`
GraphQLExecutor — see the file's own header comment for why: z-board's
`ghExecutor()` shells `gh api /graphql` directly, and the skill's Step 0/
Step 10 also shell `gh repo view` / gh's issue-view subcommand directly, so
faking `gh` itself is the one seam that covers both call paths without
touching `lib/board.ts` (a sibling lane's file) or the skill text (out of
scope)). It serves `fixture-backlog-ticket.md` as the sole Backlog item —
Status = Backlog, no Model/Model Effort/Estimate set, exactly the unplanned
brain-dump Step 10 exists to gate.

`run.sh`'s `backlog` case wires it in: it writes two shim files onto PATH —
`gh` (a bash shebang script, for the skill's own bash-typed `gh` calls) and
`gh.cmd` (a Windows batch file, for `lib/board.ts`'s `Bun.spawnSync(["gh",
...])` call, which goes straight through the OS's CreateProcess with no shell
in between and cannot follow a shebang on an extension-less file on Windows)
— both delegating to `bun board-double.ts`.

### Prerequisites for the REAL (non-mocked) run

The board double covers every `gh` call the dry-run pass makes. It does NOT
by itself satisfy Step 0's `bun lib/board.ts quota --slug <slug>`
precondition, which also needs a readable
`~/.zstack/projects/<slug>/config.json` (`/z-setup`'s output) before it will
even attempt a call `board-double.ts` could answer. For a real nightly run,
either point `$HOME` at a throwaway directory carrying a minimal config.json
shaped like `tests/board.test.ts`'s `CFG` fixture (quota fields matter most —
the double's `RateLimit` response is always healthy), or run once against a
real scratch project (same caveat `../e2e/run.md` names for its own live-only
board setup). This is the one gap the board double does not close; everything
else in the backlog-scan pass runs fully offline.

### Reproducibility (issue #7 AC2)

The tier → `z-estimate` chain is deterministic by design (`z-plan/SKILL.md`
Step 6), so the harness asserts the Estimate fields are identical run-to-run
— the reproducible half, separate from the graded quality (`checkReproducibility`
in `harness.ts`).

## Multi-document pass (issue #16)

A third, independent pass scores z-plan/SKILL.md Step 1's multi-document
discovery (`lib/spec-sources.ts`) rather than either flow above: a no-argument
`/z-plan --dry-run` run must read EVERY gstack planning document for the
project, not default to a single newest file. Same paid lane, same `claude -p`
rule, same `bin/z-ticket-lint` deterministic half, same ≥8/10 pass threshold
(`rubric.md`'s "Multi-document coverage pass" section).

### Multi-document inputs

- `fixture-spec.md` — the same shortener spec the spec-to-tickets pass above
  uses.
- `fixture-spec-2.md` — a second, independent document for the SAME project
  naming distinct scope (link expiration/TTL) that appears in neither
  `fixture-spec.md` nor anywhere else -- simulates gstack's real per-project
  layout (an older `ceo-plans/` file plus a newer `specs/` file, issue #16's
  context) where a plan grounded on only the newest file misses scope recorded
  in the other.
- `fixture-app/` — the same grounding target as the other passes.

### Stub (shape only; a project-dir double is the follow-on that makes this robust)

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO="$(cd "$HERE/../.." && pwd -P)"
RUNS="${1:-3}"
OUT="$(mktemp -d)"

# PROJECT-DIR DOUBLE: a temp dir shaped like gstack's real
# ~/.gstack/projects/<slug>/ layout, standing in for what a live project would
# hold -- fixture-spec.md as the OLDER ceo-plans/ entry, fixture-spec-2.md as
# the NEWER specs/ entry (so the primary-spec pick in Step 1 lands on the
# document carrying the TTL scope, proving z-plan reads past just the primary
# into the older grounding document too, not only the other direction).
PROJECT="$OUT/gstack-project"
mkdir -p "$PROJECT/ceo-plans" "$PROJECT/specs"
cp "$HERE/fixture-spec.md" "$PROJECT/ceo-plans/plan.md"
cp "$HERE/fixture-spec-2.md" "$PROJECT/specs/plan.md"
touch -d "1 hour ago" "$PROJECT/ceo-plans/plan.md"   # older
# specs/plan.md keeps "now" as its mtime -- newer, so it is the primary spec

for i in $(seq 1 "$RUNS"); do
  # PLAN: run /z-plan with NO spec argument so Step 1 discovers both
  # documents via lib/spec-sources.ts instead of taking an explicit path.
  # Wiring this fully needs $HOME/$SLUG pointed at $PROJECT for the run (the
  # project-dir double named above) so this pass never touches a real
  # gstack project on the host.
  claude -p "/z-plan --dry-run" \
    --add-dir "$HERE/fixture-app" \
    --add-dir "$PROJECT" \
    > "$OUT/multidoc-plan-$i.md"

  # GRADE: a fresh grader scores the plan against the 'Multi-document
  # coverage pass' section of the rubric, returning the same JSON shape as
  # the other passes.
  claude -p "Score the plan in $OUT/multidoc-plan-$i.md against the
    'Multi-document coverage pass' section of the rubric in $HERE/rubric.md,
    grounded on the app in $HERE/fixture-app and BOTH fixture-spec.md and
    fixture-spec-2.md. Return only the JSON object the rubric specifies." \
    --add-dir "$OUT" --add-dir "$HERE" \
    > "$OUT/multidoc-score-$i.json"
done

echo "multi-document scores in $OUT"
```

### What's left to wire for the multi-document pass

The shared machinery (splitter, `z-ticket-lint` gate, score aggregation, the
≥8/10 threshold exit code, and Estimate reproducibility) is wired and
generic — `harness.ts check <outDir> <runs>` covers this pass exactly the
same way it covers the spec and backlog-scan passes above; only the
plan/grade loop shown here (issuing this pass's own two prompts into the
shared `OUT` directory naming convention) is still a manual stub, not a
`run.sh` case, pending the one gap named below.

- **Pointing the planner at the `$PROJECT` double** (`$HOME`/`ZSTACK_SLUG`
  resolution, or an equivalent override) instead of a real
  `~/.gstack/projects/<slug>/` — unlike the backlog-scan pass's board double
  (a `gh` PATH-shim, issue #25), this needs `lib/spec-sources.ts`'s project
  directory argument to resolve to `$PROJECT`, which has no existing
  override hook and is out of this ticket's scope (title: "board double,
  splitter, score gate (spec + backlog passes)"). A follow-on ticket scoped
  to this pass should add it once the resolution mechanism is decided.

## Explicit two-path variant (issue #19)

The pass above exercises the no-argument discovery route into the same
cross-document-coverage check. Issue #19 adds a second, independent route to
that identical rubric dimension: two explicit path arguments
(`/z-plan a.md b.md`), where the FIRST path is the primary spec and the
second is mandatory grounding context (z-plan/SKILL.md Step 1) -- no
`lib/spec-sources.ts` discovery involved at all, so this variant needs no
project-dir double, just the two fixtures already on disk. Same paid lane,
same `claude -p` rule, same `bin/z-ticket-lint` deterministic half, scored
against the SAME "Multi-document coverage pass" rubric section (dimension 5,
cross-document coverage) as the no-arg variant above -- the check is "did
both documents' scope reach the plan", regardless of which Step 1 route
resolved them.

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO="$(cd "$HERE/../.." && pwd -P)"
RUNS="${1:-3}"
OUT="$(mktemp -d)"

for i in $(seq 1 "$RUNS"); do
  # PLAN: run /z-plan with TWO explicit paths -- fixture-spec.md first (the
  # primary spec) and fixture-spec-2.md second (mandatory grounding context,
  # Step 1's issue #19 contract). No project-dir double needed: explicit
  # paths bypass spec-sources discovery entirely.
  claude -p "/z-plan --dry-run $HERE/fixture-spec.md $HERE/fixture-spec-2.md" \
    --add-dir "$HERE/fixture-app" \
    --add-dir "$HERE" \
    > "$OUT/multidoc-explicit-plan-$i.md"

  # GRADE: same rubric section as the no-arg variant -- the expiration scope
  # from the SECOND path (fixture-spec-2.md) must reach the plan alongside
  # the persistence/shorten/resolve/CLI scope from the first, proving the
  # explicit-path route reads past the primary spec too, not just the no-arg
  # discovery route above.
  claude -p "Score the plan in $OUT/multidoc-explicit-plan-$i.md against the
    'Multi-document coverage pass' section of the rubric in $HERE/rubric.md,
    grounded on the app in $HERE/fixture-app and BOTH fixture-spec.md and
    fixture-spec-2.md. Return only the JSON object the rubric specifies." \
    --add-dir "$OUT" --add-dir "$HERE" \
    > "$OUT/multidoc-explicit-score-$i.json"
done

echo "explicit two-path multi-document scores in $OUT"
```

### What's left to wire for the explicit two-path variant

Same as the no-arg variant directly above: the shared machinery
(`harness.ts check`) already covers the splitter/lint/aggregation/threshold/
reproducibility contract for this pass unchanged (it needs no project-dir
double at all, since explicit paths bypass discovery) — only turning the
plan/grade loop above into a `run.sh` case is still open, and is the smaller
half of the multi-document follow-on work named above.

## Nightly scheduling

Documentation only (per this ticket's scope) — the command to run; scheduling
itself is the user's cron/routine:

```cron
# Nightly, all four passes, real claude -p:
0 3 * * * cd /path/to/zstack-1 && evals/planner/run.sh spec 3 && evals/planner/run.sh backlog 3
```
