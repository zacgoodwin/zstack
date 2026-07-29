# Add a `chunk(items, size)` list-splitting helper

## Context

Three call sites split a list into fixed-size batches by hand, each with its own
off-by-one. Add one shared `src/chunk.ts` so the batching logic lives in one
place.

## Plan

Implement `chunk(items, size)` returning the items split into consecutive
sub-arrays of at most `size`, and reject a non-positive `size` rather than
looping forever on it.

### Acceptance Criteria

1. `chunk([1, 2, 3, 4], 2)` returns `[[1, 2], [3, 4]]` (an exact multiple splits
   evenly).
2. `chunk([1, 2, 3], 2)` returns `[[1, 2], [3]]` (the final chunk is short, not
   padded).
3. `chunk([], 2)` returns `[]` (an empty list yields no chunks, not `[[]]`).
4. `chunk([1, 2], 0)` throws a `RangeError` (a non-positive `size` is rejected
   rather than producing an infinite loop).

## Tests + evals

`src/chunk.test.ts` covers all four criteria.

## Docs pages touched

None.

## Out of scope

Lazy/iterator chunking, and changing the three existing call sites — this ticket
adds the helper only.
