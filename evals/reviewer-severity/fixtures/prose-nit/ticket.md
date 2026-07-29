# Add a `clamp(n, lo, hi)` numeric helper

## Context

Several call sites clamp a value into a range by hand. Add one shared
`src/clamp.ts` helper so the bounds logic lives in one place.

## Plan

Implement `clamp(n, lo, hi)` returning `n` bounded to `[lo, hi]`, and reject
reversed bounds rather than silently accepting them.

### Acceptance Criteria

1. `clamp(5, 0, 10)` returns `5` (a value within bounds passes through).
2. `clamp(-3, 0, 10)` returns `0` (below the floor clamps up to `lo`).
3. `clamp(42, 0, 10)` returns `10` (above the ceiling clamps down to `hi`).
4. `clamp(5, 10, 0)` throws a `RangeError` (reversed bounds `lo > hi` are
   rejected, not silently accepted).
