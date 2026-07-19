# Spec: shortcli — link expiration (TTL)

A second, independent document for the same `shortcli` project as
`fixture-spec.md`. Simulates gstack's real layout (issue #16): a project has
more than one planning document -- e.g. an older `ceo-plans/` file and a
newer `specs/` file -- each naming distinct scope. This document's scope
(expiration) does not appear anywhere in `fixture-spec.md`, and vice versa
(persistence/shorten/resolve/CLI); a planner that reads only one of the two
misses half the project.

## What we want

Shortened links should be able to expire. Today (per `fixture-spec.md`) a code
resolves forever once created; some links should stop working after a set
number of days.

### Behaviors

1. **Optional TTL on shorten.** `shortcli shorten <url> --ttl <days>` records an
   expiry alongside the mapping. No `--ttl` means the link never expires (the
   `fixture-spec.md` default behavior is unchanged).
2. **Expired resolve is not found.** Resolving a code whose expiry has passed
   returns the same "unknown code" result as a code that was never created --
   it must not still return the URL. This builds on the existing `Store` class
   in `src/store.ts` (`put`/`get`/`has`/`all`); storing an expiry needs either
   a second map keyed the same way or an extended mapping shape, not a
   parallel lookup structure.

## Constraints

- Bun + TypeScript, matching the existing `src/store.ts` style.
- No network calls, no third-party dependencies (ponytail: reuse the stdlib
  and the existing `Store` class).
- Each behavior ships with its own gate tests.

## Notes for the planner

This is grounding scope for the SAME `shortcli` project as `fixture-spec.md`,
not a competing or replacement spec -- a plan built from both documents should
include tickets for persistence/shorten/resolve/CLI (from `fixture-spec.md`)
AND expiration (from this document), grounded in the same `src/store.ts`.
