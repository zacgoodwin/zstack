## Context

Add per-key rate limiting and wire it into the HTTP edge.

Each client gets a budget of `limit` requests per `durationMs` window, and every
request is judged against the budget of the window its tick falls in. The
timeline is tiled into windows of `durationMs` starting at tick 0, and each
window is **half-open**: `[k*durationMs, (k+1)*durationMs)`. The tick that opens
a window is a member of it, and the tick `durationMs` later opens the NEXT
window, never the one it ends.

On top of the per-key budgets sits one shared ceiling, `globalLimit`: the most
the process will admit in a window across every key put together. Per-key
budgets keep one client from crowding out the others; the ceiling keeps the box
as a whole inside what it can carry.

Add `src/window.ts` with the tiling helpers (`windowStartFor`, `withinWindow`,
`msUntilWindowEnd`).

Add `src/limiter.ts` with `KeyedRateLimiter`, constructed from `{ limit,
durationMs, globalLimit?, idleTtlMs? }`: `allow`, `peek`, `remaining`,
`retryAfterMs`, `reset`, `resetAll`, `sweep`, `size`.

Add `src/middleware.ts` with `rateLimitMiddleware({ limiter, now, header?,
anonymousKey? })`, returning `{ handle(req, res, next), metrics }`. It derives
the client key from a request header, asks the limiter, and either calls
`next()` or answers 429.

Callers pass a monotonic clock: `now` never decreases across calls. Ticks and
durations are integer milliseconds. This service runs on a box with a bounded
key table; a client id is caller-supplied and untrusted.

### Acceptance Criteria

1. **The budget is enforced within one window.** With `limit 2, durationMs
   500`: `allow("a", 1100)` → `true`, `allow("a", 1200)` → `true`,
   `allow("a", 1300)` → `false`.
2. **A fresh window restores the budget.** Continuing criterion 1's sequence:
   `allow("a", 1600)` → `true`, because 1600 falls in the window that opened
   at 1500.
3. **Windows are half-open.** A boundary tick belongs to the window it OPENS,
   never the one it ends: `windowStartFor(1500, 500)` → `1500`,
   `withinWindow(1500, 1000, 500)` → `false`, and with `limit 1, durationMs
   500` after `allow("a", 1000)`: `allow("a", 1400)` → `false` but
   `allow("a", 1500)` → `true`.
4. **Keys are independent.** One key exhausting its budget has no effect on
   another key's budget.
5. **The shared ceiling bounds the whole process.** `globalLimit` caps how many
   requests the limiter admits per window across all keys together, and it
   refills with the window. With `limit 2, durationMs 500, globalLimit 3`:
   `allow("a", 1000)`, `allow("b", 1000)`, `allow("c", 1000)` → `true`, then
   `allow("d", 1000)` → `false`, and `allow("d", 1500)` → `true`. Leaving
   `globalLimit` unset means no ceiling.
6. **`remaining`, `retryAfterMs` and `peek` report without charging.**
   `remaining` gives the key's own budget left in the window `now` falls in;
   `retryAfterMs` gives the wait until the key can be served, `0` when it can
   be served now; `peek` reports whether a request would be admitted and leaves
   every budget exactly as it found it.
7. **Idle keys are reclaimed, and the key table stays bounded.** `sweep(now)`
   drops buckets untouched for at least `idleTtlMs` and returns how many it
   dropped; a key whose window is still open is never reclaimed, and a rejected
   request counts as touching the key. A process serving many short-lived
   client ids must not grow its key table without bound: reclamation has to
   actually run in the shipped path, not merely be available to call.
8. **The constructor validates its contract.** A non-positive or non-integer
   `limit`, `durationMs`, or `globalLimit` throws a `RangeError`, as does an
   `idleTtlMs` shorter than one window.
9. **A throttled request is answered 429, and the handler never runs.** The
   response carries the body `rate limited` and a `Retry-After` header **in
   seconds** (HTTP's unit), rounded so the client never retries before its
   budget has actually returned.
10. **The client key is normalized before it is used.** Client ids arrive from
    an untrusted header; `acme`, `ACME` and `acme ` are the same client and
    must share one budget. Requests with no client id share the anonymous
    budget.
11. **A limiter failure is not a free pass.** If the limiter throws, the
    request is refused, not admitted — an unavailable limiter must never become
    an open door.
12. **Metrics report what happened.** `metrics.admitted` counts the requests
    the middleware passed to the handler chain and `metrics.rejected` counts
    the ones it answered 429; each request increments exactly one of them.

### Model

sonnet / medium

### Estimate

$0.60

### Out of scope

- Sliding-window, token-bucket, or distributed limiting; a single in-process
  fixed-window limiter only.
- Out-of-order timestamps (the caller's clock is monotonic by contract).
- Bounding the key count by capacity (an LRU or `maxKeys`); `sweep` is the only
  reclamation path in this ticket.
- Authentication: the client id header is taken at face value as an identity.
