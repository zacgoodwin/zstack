# evals/orchestrator-context — /z-loop orchestrator-context drain eval

The eval for ticket #57 (**Control orchestrator context growth in /z-loop**). It
measures the metric the ticket names: **peak orchestrator resident-context bytes
per drained ticket**, before (pre-#57) vs after (pointer-prompts + one-line
`z-loop-tick`), over a synthetic 6-ticket happy-path drain.

## Deterministic, not paid

Unlike `evals/planner` (which grades LLM output), this eval makes **no LLM
calls**. The quantity it measures — how many bytes of context the orchestrator
accumulates per ticket — is a pure function of the two things #57 changes:

1. **Leak 1 (stage prompts).** The prompt the orchestrator reads back to spawn
   each stage Agent. Pre-#57 it inlined the full `ticketBody`/`diff`; now it is a
   pointer to `input-<N>.json`, so its length is payload-independent (AC1).
2. **Leak 2 (per-iteration tick).** The bash text re-read every drain iteration.
   Pre-#57 a ~15-line snapshot+ingest+next block; now the single `z-loop-tick`
   line.

Both are computed from the **real** stage constructors (`lib/stage-prompts.ts`)
and the **real** scheduler (`lib/loop.ts` drives the drain), so the number is
reproducible and free. Per PRINCIPLES.md (latent vs deterministic), forcing an
LLM call to measure a byte count would be theater — the threshold gates in
`tests/orchestrator-context.test.ts` instead.

## Files

| File | Role |
|------|------|
| `harness.ts` | Pure measurement: `simulateDrain` (drives the real scheduler), `measure` (baseline vs after bytes/ticket), `report`, and a `check <nTickets>` CLI that exits non-zero below the threshold. |

## How to run

```bash
bun evals/orchestrator-context/harness.ts        # 6-ticket drain, prints the report
bun evals/orchestrator-context/harness.ts 12     # any batch size
```

Prints the recorded **baseline per-ticket ceiling**, the after ceiling, and the
reduction; exits `0` iff the cut is **>= 60%**.

## What "pass" means

- Reduction in peak orchestrator context per drained ticket **>= 60%** vs the
  pre-#57 baseline (`THRESHOLD_PCT` in `harness.ts`).
- The baseline ceiling is genuinely payload-inflated (the gate asserts
  `baselinePerTicket > 2 x afterPerTicket`), so the pass is never vacuous.
- The cut only grows with payload size — the 100 KB case exceeds the realistic
  default's cut (gate-tested).
