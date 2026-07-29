## Context

Add per-key fixed-window rate limiting with a process-wide ceiling. Each key
gets a budget of `limit` requests per `durationMs` window, and every request is
judged against the budget of the window its tick falls in.

The timeline is tiled into windows of `durationMs` starting at tick 0, and each
window is **half-open**: `[k*durationMs, (k+1)*durationMs)`. The tick that
opens a window is a member of it, and the tick `durationMs` later opens the
NEXT window, never the one it ends. Getting that edge wrong is what lets a
burst straddle a boundary and slip the limit, or rejects a legitimate request
that lands exactly on the tick.

On top of the per-key budgets sits one shared ceiling, `globalLimit`: the most
the process will admit in a window across every key put together. Per-key
budgets keep one client from crowding out the others; the ceiling keeps the box
as a whole inside what it can actually carry.

Add `src/window.ts` with the tiling helpers:

- `windowStartFor(now, durationMs)` — the start tick of the window `now` falls in.
- `withinWindow(now, start, durationMs)` — whether `now` is a member of the
  half-open window opening at `start`.
- `msUntilWindowEnd(now, start, durationMs)` — how long until that window closes.

Add `src/limiter.ts` with `KeyedRateLimiter`, constructed from `{ limit,
durationMs, globalLimit?, idleTtlMs? }`:

- `allow(key, now): boolean` — admit and charge a request, or reject it.
- `peek(key, now): boolean` — whether a request would be admitted, without
  charging it. For callers that need to decide something (queue, shed, log)
  before committing to spend the key's quota.
- `remaining(key, now): number` — the key's own budget left.
- `retryAfterMs(key, now): number` — how long to wait before retrying.
- `reset(key)` / `resetAll()` — drop buckets, restoring budget immediately.
- `sweep(now): number` — reclaim buckets idle for at least `idleTtlMs`, so a
  process seeing many short-lived keys does not grow without bound.
- `size` — how many keys currently hold a bucket.

Callers pass a monotonic clock: `now` never decreases across calls. Ticks and
durations are integer milliseconds.

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
   refills with the window like any other budget. With `limit 2, durationMs
   500, globalLimit 3`: `allow("a", 1000)`, `allow("b", 1000)`,
   `allow("c", 1000)` → `true`, then `allow("d", 1000)` → `false`, and
   `allow("d", 1500)` → `true`. Leaving `globalLimit` unset means no ceiling.
6. **`remaining` reports the key's own budget left** in the window `now` falls
   in, and the full `limit` for a key with no bucket. With `limit 2,
   durationMs 500` after `allow("a", 1000)`: `remaining("a", 1100)` → `1`.
7. **`retryAfterMs` reports how long until the key can be served**, and `0`
   whenever it can be served right now. With `limit 1, durationMs 500` after
   `allow("a", 1000)`: `retryAfterMs("a", 1100)` → `400`.
8. **`peek` reports without charging.** It reports whether the key would be
   admitted right now, and leaves every budget exactly as it found it: with
   `limit 2, durationMs 500` after `allow("a", 1000)`, calling
   `peek("a", 1100)` twice returns `true` both times and `remaining("a", 1100)`
   is still `1`.
9. **`sweep` reclaims only idle keys.** It drops buckets untouched for at
   least `idleTtlMs` and returns how many it dropped; a key whose window is
   still open is never reclaimed, and a rejected request counts as touching
   the key.
10. **The constructor validates its contract.** A non-positive or non-integer
    `limit`, `durationMs`, or `globalLimit` throws a `RangeError`, as does an
    `idleTtlMs` shorter than one window.

### Model

sonnet / medium

### Estimate

$0.30

### Out of scope

- Sliding-window, token-bucket, or distributed limiting; a single in-process
  fixed-window limiter only.
- Out-of-order timestamps (the caller's clock is monotonic by contract).
- Bounding the key count by capacity (an LRU or `maxKeys`); `sweep` is the only
  reclamation path in this ticket.
