## Context

The rate limiter counts each request against the budget of a fixed time
window. The timeline is tiled into windows of `durationMs` starting at tick 0,
and each window is **half-open** `[k*durationMs, (k+1)*durationMs)`: the tick
that opens a window is a member of it, and the tick `durationMs` later opens
the NEXT window, never this one. Getting the edge wrong is what lets a burst
straddle a window boundary and slip the limit, or rejects a legitimate
request that lands exactly on the tick.

Add to `src/window.ts`:

- `windowStartFor(now, durationMs)` — the start tick of the window `now`
  falls in.
- `withinWindow(now, start, durationMs)` — whether `now` is a member of the
  half-open window that opens at `start`.
- `FixedWindowLimiter(limit, durationMs)` with `allow(now): boolean` — admits
  the request at tick `now` if the window its tick falls in has budget left,
  else rejects it. Callers pass a monotonic clock: `now` never decreases
  across calls. Ticks and durations are integer milliseconds.

### Acceptance Criteria

1. **The budget is enforced within one window.** With `limit 2, durationMs
   500`: `allow(1100)` → `true`, `allow(1200)` → `true`, `allow(1300)` →
   `false`.
2. **A fresh window restores the budget.** Continuing criterion 1's sequence:
   `allow(1600)` → `true` (1600 falls in the window that opened at 1500).
3. **Windows are half-open.** A boundary tick belongs to the window it OPENS,
   never the one it ends: `windowStartFor(1500, 500)` → `1500`,
   `withinWindow(1500, 1000, 500)` → `false`, and the limiter judges every
   request against the window its tick falls in.
4. **The constructor validates its contract.** A non-positive or non-integer
   `limit` or `durationMs` throws a `RangeError`.

### Model

sonnet / medium

### Estimate

$0.10

### Out of scope

- Sliding-window or distributed limiting; a single in-process limiter only.
- Out-of-order timestamps (the caller's clock is monotonic by contract).
