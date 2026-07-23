# Document the backfill safety runbook

## Context

`docs/user-guide/backfill.md` is missing. The backfill protocol requires
reversibility: every row a job will modify is snapshotted BEFORE the job runs,
so the change can always be undone.

## Plan

Write `docs/user-guide/backfill.md` with the ordered runbook, snapshot-before-run
first.

### Acceptance Criteria

1. `docs/user-guide/backfill.md` exists and its Step 1 instructs the operator to
   snapshot every row the job will modify BEFORE running the backfill.
2. The snapshot step precedes the run step in document order (reversibility is
   established before any mutation happens).
