# evals/planner — /z-plan quality eval

The **paid, periodic** eval for the `/z-plan` skill (`z-plan/SKILL.md`). It
measures whether the planner turns a spec into good tickets: grounded file refs,
testable acceptance criteria, correct model tiers, and a complete dependency
chain — plus, separately, whether its Step 10 Backlog scan (issue #13) gates
and fields an already-filed Backlog ticket correctly. This is NOT a gate test —
it makes LLM calls and never runs in `bun test`. The deterministic half of the
schema (validator + `z-ticket-lint`) is gated in `tests/plan-schema.test.ts`;
this eval covers the latent half.

## Files

| File | Role |
|------|------|
| `fixture-spec.md` | The spec fed to the planner — a toy link-shortener with a 3-ticket dependency chain latent in it (persistence ← service ← CLI). |
| `fixture-app/` | The target codebase the planner grounds against. Only `src/store.ts` exists, so "grounded file refs" is checkable. |
| `fixture-backlog-ticket.md` | A two-line brain-dump Backlog ticket body (fails `z-ticket-lint` as-is), fed to the Step 10 backlog-scan pass. |
| `rubric.md` | Five scored dimensions (0–2 each, /10) and the **pass threshold: avg ≥ 8/10**, for both the spec pass and the "Backlog scan pass" section. |
| `run.md` | The two passes (spec plan→grade, and Backlog-scan plan→grade) and the stubs C10 (and its Step 10 follow-on) wire fully. |

## How to run

Everything routes through **local Claude Code (`claude -p`)** — never a hosted
LLM API (PRINCIPLES.md "LLM access"). See `run.md` for the harness and the stub.
In short:

1. **Plan** — run `/z-plan --dry-run` on `fixture-spec.md` with `fixture-app/`
   readable, capturing the emitted ticket bodies + fields + dependencies.
2. **Gate** — lint each emitted ticket body with `../../bin/z-ticket-lint`
   (dimension 1, deterministic).
3. **Grade** — a fresh `claude -p` scorer grades the output against `rubric.md`
   and returns the rubric's JSON.
4. **Aggregate** — average the totals over N runs; pass when the mean ≥ 8/10.

## What "pass" means

- Quality: average rubric total ≥ 8/10 (`rubric.md`).
- Reproducibility (issue #7 AC2): the Estimate values are identical across runs
  on the same spec — checked by the harness separately from the graded score,
  because the estimate chain (tier → `z-estimate`) is deterministic by design
  (`z-plan/SKILL.md` Step 6).

C10 owns wiring the harness end to end (output splitter, aggregation, pass/fail
exit code, nightly scheduling); this directory is the complete definition it
executes against.
