# /z-plan Step 11 cost-suggest eval rubric

Scores one Step 11 prose pass (z-plan/SKILL.md, "Cost-saving suggestions") against
the `CostBreakdown` JSON `lib/cost-suggest.ts`'s real `costSuggestions()` computes
for `fixture-batch.json`. Three dimensions, 0–2 each, **6 points total**. **Pass
threshold: average ≥ 5/6** across the scored runs; below that, the prose step
regressed and the change does not ship.

The grader is a fresh local `claude -p` pass (never a hosted API — PRINCIPLES.md
"LLM access") given: this rubric, the `CostBreakdown` JSON the prose was built
from, and the prose itself. It returns a JSON object
`{groundedInBatch, noGenericFiller, actionable, total, notes}`.

## Dimensions

### 1. Grounded in the batch (0–2)
Every number, ticket reference, and file path in the prose traces back to the
`CostBreakdown` JSON — no invented ticket, no invented dollar figure, no invented
file.
- 2 — every ticket number, dollar figure, and file path in the prose appears
  verbatim in the JSON (`totalEstimate`, `byTier`, `sharedFileClusters`,
  `topCostTicket`, or a `suggestions[].fact`).
- 1 — mostly grounded, but one figure or reference does not trace back to the JSON.
- 0 — the prose reads as generic advice disconnected from this batch's actual data.

### 2. No generic filler (0–2)
The prose never falls back to boilerplate the JSON does not support (e.g. "write
more efficient code", "optimize your prompts", "consider reducing scope").
- 2 — every line names a concrete fact from the JSON; zero generic filler lines.
- 1 — mostly concrete, but one line is generic/unconnected filler.
- 0 — the prose is dominated by generic advice.

### 3. Actionable (0–2)
The prose reads as 3–6 short lines a human can act on immediately (confirm a
tier, sequence tickets touching the same file, batch mechanical work) — not a
data dump or a restatement of the raw JSON.
- 2 — 3–6 short, clear lines, each suggesting a concrete next step tied to a
  batch fact (matching z-plan/SKILL.md Step 11's example shape).
- 1 — the content is right but it is either too terse to act on or padded well
  past 6 lines.
- 0 — unreadable, or just a JSON/data dump with no actionable framing.

## Expected shape of a passing run

Given `fixture-batch.json`'s 5-ticket batch (total $28.75; #105 fable-xhigh
$19.50; `lib/config.ts` shared by #103/#104/#105; #101/#102 haiku-low), a
passing run's prose:

- states the $28.75 total across 5 tickets;
- flags #105 ("Redesign the config subsystem end to end") as fable-xhigh
  ($19.50) worth a second look;
- flags `lib/config.ts` as shared by #103, #104, #105;
- flags #101, #102 as haiku-low mechanical work worth batching;
- names no ticket number, file, or dollar figure absent from the JSON.

Scores 6/6.
