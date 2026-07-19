## Context

The board list command has no `--json` flag, so the loop cannot machine-read
statuses. Add it, grounded in `lib/board.ts:565` where `list` is dispatched.

## Plan

Files: `lib/board.ts` (the `list` case at line 565), `tests/board.test.ts`.

```bash
# grounding: confirm the existing shape before touching it
# z-board list --status Ready
```

Steps:

1. Add a `--json` boolean to the `list` flag parser (`parseFlags`, line 515).
2. When set, print `JSON.stringify(items)` instead of the table.

### Acceptance Criteria

- Setup: a board with two Ready items → Action: `z-board list --status Ready
  --json` → Expected: valid JSON array of length 2 on stdout, exit 0.
- Setup: no items in a status → Action: same with `--json` → Expected: `[]`.

## Tests + evals

Gate test in `tests/board.test.ts`: `list --json` returns parseable JSON for a
fixture item set. No eval (deterministic transform).

## Docs pages touched

none (no user-facing change; internal loop tooling only).

## Out of scope

Filtering by field value; only `--status` is supported here.

Depends on: #5, #6
