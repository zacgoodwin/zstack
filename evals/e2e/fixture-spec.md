# Spec: fixture-app observability

`fixture-app` (see `../fixture-app/`) is a tiny Bun HTTP server. Today it serves
three routes from a single pure dispatcher (`src/routes.ts`): `/`, `/health`, and
`/echo`. We want basic observability, built in the order the pieces depend on
each other, so the end-to-end loop has a real three-ticket dependency chain to
walk.

## What we want

1. **A structured response helper.** Every route hand-builds its JSON shape.
   Add `src/respond.ts` with `ok(body)` and `err(status, message)` so success and
   error responses are consistent, and route `src/routes.ts` through it. This is
   the foundation the next two build on. Depends on nothing.

2. **A richer `/health`.** `GET /health` currently returns a bare
   `{ status: "ok" }`. Make it report process uptime and the package version,
   returned through the `ok()` helper from ticket 1. Depends on ticket 1.

3. **A `/metrics` route.** Count requests per route (a small in-memory counter
   wrapping `handle()` in `src/routes.ts`), and expose the counts at
   `GET /metrics` through the `ok()` helper. Depends on ticket 2 (it reuses the
   response shape the health work settles).

## Constraints

- Bun + TypeScript, matching the existing `src/routes.ts` style. No frameworks,
  no third-party deps (ponytail: the platform already ships an HTTP server and a
  JSON serializer).
- Each ticket ships its own gate tests alongside the code, and updates
  `docs/user-guide/index.md` for any user-visible change.
- Deploy is stubbed (`scripts/deploy` echoes and exits 0); the loop's end-of-loop
  deploy chain runs against that stub, never a real environment.

## Notes for the planner

The three behaviors form a strict chain: the response helper is the foundation,
`/health` uses it, and `/metrics` builds on the shape `/health` settles. Plan
them in build order and record which waits on which (`Depends on:` lines). Ground
every plan in the real `src/routes.ts` (cite the `route()`/`handle()` functions
and line refs you rely on).
