## Context

A standalone ticket with no dependencies. Grounded in `lib/config.ts:53` where
`ZError` is defined.

## Plan

Files: `lib/config.ts`.

Steps:

1. Add a one-line JSDoc above `ZError` explaining it is the caught error type.

### Acceptance Criteria

- Setup: open `lib/config.ts` → Action: read line 53 → Expected: a doc comment
  precedes `class ZError`.

## Tests + evals

No test (doc-only, no runtime surface).

## Docs pages touched

none (no user-facing change).

## Out of scope

Any behavior change to error handling.
