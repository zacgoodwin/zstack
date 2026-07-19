# TODOS

Organized by component, then priority (P0 highest). Completed items at the bottom.

## Completed

- zstack v1 remediation, GitHub issue **#14** (filed by the `/ship` pre-landing review): all 22 items closed — board-read pagination, vacuous gate tests, unreachable wave-reconciliation, `--reconcile` regression of merged work, Status-option clobber on adopt, epicStyle `issue-type` honesty (rejected until a create path exists), cross-session claim identity, and the P2 backfill (error-path tests, root `tsconfig` + `typecheck` gate, DRY consolidation). `spec/zstack-v1` merged via PR #15. **Completed:** v0.1.1.0 (2026-07-19)
- zstack v1 core: C1–C11 (pack scaffold, board contract, estimator, /z-setup, /z-plan, /z-loop, safety controls, end-of-loop, /z-status, e2e evals, auto-approvals). **Completed:** v0.1.0.0 (2026-07-19)
- /ship review: 8 self-contained findings fixed (shell-injection escape, quota fail-closed, NaN guard, allowlist tier honesty, hook-detection FP, 0600 file modes, corrupt-state loud-fail, reviewer BLOCKED marker). **Completed:** v0.1.0.0 (2026-07-19)
