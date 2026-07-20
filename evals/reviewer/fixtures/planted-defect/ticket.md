## Context

The rate limiter counts requests into fixed time windows. Each window is
**half-open** `[start, start + durationMs)`: a request landing at exactly the
next window's boundary belongs to the NEXT window, not this one. Getting the
boundary wrong double-counts the request that lands on the tick, which is the
exact case that makes a limiter reject a legitimate request once per window.

Add `withinWindow(now, start, durationMs)` in `src/window.ts` returning whether
`now` falls inside the half-open window that opens at `start`.

### Acceptance Criteria

1. **Window includes its start.** `withinWindow(1000, 1000, 500)` → `true`
   (a request at the exact open of the window is inside it).
2. **Just inside the end.** `withinWindow(1499, 1000, 500)` → `true`
   (one millisecond before the boundary is still this window).
3. **The boundary is exclusive.** `withinWindow(1500, 1000, 500)` → `false`
   — the window is half-open, so `start + durationMs` belongs to the NEXT
   window, never this one.
4. **Before the window.** `withinWindow(999, 1000, 500)` → `false`.

### Model

sonnet / medium

### Estimate

$0.10

### Out of scope

- The limiter's counting/eviction loop; this ticket adds only the membership
  predicate the loop will call.
