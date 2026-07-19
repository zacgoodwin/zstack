# evals/e2e — the full-loop eval

The end-to-end proof for the zstack pack: it drives the whole loop
(`/z-setup` → `/z-plan` → `/z-loop`) against the fixture app and asserts the
epic's Definition of Done programmatically. The planner has its own standalone
lane — see **`../planner/run.md`** (dry-run `/z-plan` graded against a rubric);
this directory is the *loop* lane that exercises every stage after planning.

Two lanes, two budgets (PRINCIPLES.md):

- **Gate lane (free, deterministic, in `bun test`):** `check.ts` run against
  `fixtures/sample-run/`, driven by `../../tests/e2e-check.test.ts`. No LLM calls,
  no network, well under 2s.
- **Paid lane (periodic, LLM calls):** the live procedure in `run.md`, which runs
  the real skills through **local `claude -p`** (never a hosted API) and then runs
  `check.ts` over the live run's artifacts.

## Files

| File | Role |
|------|------|
| `fixture-spec.md` | The spec fed to `/z-plan`: three tickets in a strict dependency chain (response helper ← `/health` ← `/metrics`), grounded in `../fixture-app/src/routes.ts`. |
| `run.md` | The operator procedure (live + fixture modes) and the pass threshold. |
| `assertions.ts` | The assertion library. Re-derives the run through the real scheduler and validates the recorded artifacts. |
| `check.ts` | Runnable checker (`bun evals/e2e/check.ts [runDir]`); exits non-zero on any failed assertion. Defaults to `fixtures/sample-run/`. |
| `fixtures/sample-run/` | A hand-authored artifact set representing one successful live run, so `check.ts` is itself gate-testable. |

## Pass threshold

**`check.ts` exits 0** — all ten assertions green. `check.ts` is deterministic
(no LLM in the checker), so there is no averaging: one green run clears the bar.
Run it before ship and nightly. The planner quality lane (`../planner/`) keeps its
own separate threshold (average rubric ≥ 8/10).

## How the checker works

The load-bearing idea: the `walk`, `lane-cap`, and `fresh-context` assertions do
not trust a recorded trace. They **re-derive the run** by driving the real
scheduler (`lib/loop.ts` `nextAction`/`applyAction`/`recordOutcome`) from the
recorded starting board (`state-initial.json`) with a happy-path outcome oracle,
then assert the emergent properties. So the checker exercises the actual state
machine, not a transcript of it. The remaining assertions validate the recorded
outputs (board, report, notes, transcripts, invocation log) and cross-reference
them against that derivation — e.g. `actuals` re-prices each ticket's transcripts
with `lib/cost.ts` and asserts the board's Actual equals it to the cent.

### Artifacts the checker reads

A live run's state dir (`~/.zstack/projects/<slug>/`) must expose the same names
the `sample-run` fixture uses:

| Path | Produced by | Read for |
|------|-------------|----------|
| `state-initial.json` | loop ingest after batch-commit (all workable tickets Building) | walk / lane-cap / fresh-context derivation |
| `state-final.json` | loop state at drain (`mergedThisRun` = completion order) | merge-order |
| `board-final.json` | `z-board list` snapshot (per-ticket Status + fields) | actuals / report |
| `loop-counter` | `endloop.ts counter bump` | loop-counter cadence |
| `reports/loop-*.md` | `endloop.ts report` | report verdict + dollars |
| `reports/invocations-*.jsonl` | `skill-invoker record` | deploy-chain / audit cadence |
| `notes/note-<N>.json` | completion-note input per Done ticket | completion-notes edges |
| `stage-inputs/ticket-<N>-reviewer.json` | reviewer stage input | reviewer-blindness |
| `transcripts/ticket-<N>/*.jsonl` | per-stage Claude Code transcripts | actuals (z-cost) |

## Traceability: every Definition of Done item → its assertion

Each epic DoD item (issue #3) maps to at least one executable check. "check.ts
(e2e)" = an assertion in this directory; "gate test" = a deterministic test
elsewhere in `tests/`; "live-run-only" = requires a real GitHub board and cannot
be asserted offline (called out, never silently skipped).

| DoD | Requirement | Covered by | Kind |
|-----|-------------|------------|------|
| 1 | `/z-setup` creates project/board/9 statuses/4 fields; auto-close off; scripted verify | `tests/setup.test.ts` (scripted `verify` against GraphQL fixtures); `board-final.json` shape asserted by `actuals`/`report` in `check.ts`. **Live board creation + the manual workflow-rule toggle are live-run-only** (GitHub exposes no API for the workflows). | gate test + live-run-only |
| 2 | `/z-plan` tickets carry `### Acceptance Criteria`, dep links, Model/Effort/Estimate; re-plan reproduces estimates | `../planner/` eval (quality, paid) + `tests/plan-schema.test.ts` (schema gate + per-tier estimate reproducibility) + `tests/estimate.test.ts`. `reviewer-blindness` inputs in `check.ts` carry the AC sections; `board-final.json` carries the fields. | gate test + paid eval |
| 3 | 3 tickets reach Done via Building→QA→Review, merged in dependency order; ≤3 concurrent; fresh context per stage | `check.ts`: `walk`, `merge-order`, `lane-cap`, `fresh-context`. Binding-cap case also in `tests/loop.test.ts`. | check.ts (e2e) |
| 4 | Reviewer blindness enforced by a gate test on prompt construction | `tests/stage-prompts.test.ts` (compile + runtime exact-keys) + `check.ts` `reviewer-blindness` (over recorded inputs). | gate test + check.ts |
| 5 | A ticket with an open question parks in Questions, commented; loop never works it | `tests/loop.test.ts` "Questions tickets" (never claimable) + park→Questions on `needs-input`. **Not in the happy-path sample-run** (all three tickets succeed). | gate test |
| 6 | Dead worker past 10 min → Skipped with note | `tests/loop.test.ts` watchdog → skip. **Not in the sample-run** (no stall on the happy path). | gate test |
| 7 | Regression red → no deploy, bugs to Backlog; green → land-and-deploy → canary → document-release in order | `check.ts` `deploy-chain` (green order) + `tests/endloop.test.ts` (red files bugs, no deploy; green order). | check.ts (e2e) + gate test |
| 8 | Loop counter: cso + health on loop 5, not loop 4 | `check.ts` `loop-counter` (audits present iff counter %5==0; sample-run is loop 3 → correctly absent) + `tests/endloop.test.ts` (loop 4 none, loop 5 both). | check.ts (e2e) + gate test |
| 9 | Every Done ticket's Actual = transcript-accounted dollars; drift gate present | `check.ts` `actuals` (board Actual == `z-cost` of the ticket's transcripts, to the cent) + `tests/cost.test.ts` (format-drift canary). | check.ts (e2e) + gate test |
| 10 | Second concurrent `/z-loop` on the same project refuses to start | `tests/safety.test.ts` (loop-lock acquire / second-invocation refusal). **Real concurrency is live-run-only**; the lock logic is gate-tested. | gate test + live-run-only |
| 11 | Every child ships gate tests + evals same diff; the C10 full-loop eval passes its threshold | `check.ts` exits 0 (this eval's threshold) + `tests/e2e-check.test.ts` (the checker is itself gate-tested, good run passes / mutated runs fail). | check.ts (e2e) + gate test |
| 12 | Done tickets stay OPEN with completion notes naming edges; surfaced use cases filed to Backlog | `check.ts` `completion-notes` (edges present, rendered, rolled into the report) + report `bugsFiled` (#4 filed). **"Issue stays open" is live-run-only** (the loop never calls `gh issue close`; only a live board proves the issue is still open). | check.ts (e2e) + live-run-only |

No silent gaps: items 5, 6, and 10 are not exercised by the happy-path
`sample-run` (it is a clean success by construction) and are covered by the
deterministic gate tests named above; the board-creation half of items 1, 10, and
12 is inherently live-run-only and labeled as such.
