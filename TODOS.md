# TODOS

Organized by component, then priority (P0 highest). Completed items at the bottom.

## zstack v1 remediation

All open remediation is tracked in detail on GitHub issue **#14** (filed by the `/ship` pre-landing review). The headline items:

- **Priority:** P0 — `lib/board.ts`: paginate board reads (currently truncates silently past 100 items). #14
- **Priority:** P0 — `tests/status.test.ts` + `tests/board.test.ts`: two gate tests are vacuous (exclude the `.md` skill files they claim to guard). #14
- **Priority:** P0 — `z-loop/SKILL.md`: wave-reconciliation is unreachable (Step 4 never re-runs `list`+`ingest`), defeating the mid-loop human-move safety control. #14
- **Priority:** P0 — `lib/reconcile.ts`: `--reconcile` can move already-merged work back to Ready. #14
- **Priority:** P0 — `lib/setup-board.ts`: adopt path wholesale-replaces Status options, silently dropping live items' status. #14
- **Priority:** P1 — `lib/board.ts`: epicStyle `issue-type` is advertised but has no create path. #14
- **Priority:** P1 — cross-session claim identity, dead-merge-worker PR-state check, addRelation body race, loop-lock pid-reuse, `--slug` on every call. #14
- **Priority:** P2 — error-path test backfill, root `tsconfig` + `typecheck` gate, DRY consolidation (`atomicWrite`, CLI plumbing, status lists). #14

Do not merge `spec/zstack-v1` to a production main until the P0 items are cleared.

## Completed

- zstack v1 core: C1–C11 (pack scaffold, board contract, estimator, /z-setup, /z-plan, /z-loop, safety controls, end-of-loop, /z-status, e2e evals, auto-approvals). **Completed:** v0.1.0.0 (2026-07-19)
- /ship review: 8 self-contained findings fixed (shell-injection escape, quota fail-closed, NaN guard, allowlist tier honesty, hook-detection FP, 0600 file modes, corrupt-state loud-fail, reviewer BLOCKED marker). **Completed:** v0.1.0.0 (2026-07-19)
