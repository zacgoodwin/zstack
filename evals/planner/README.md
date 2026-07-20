# evals/planner — /z-plan quality eval

The **paid, periodic** eval for the `/z-plan` skill (`z-plan/SKILL.md`). It
measures whether the planner turns a spec into good tickets: grounded file refs,
testable acceptance criteria, correct model tiers, and a complete dependency
chain — plus, separately, whether its Step 10 Backlog scan (issue #13) gates
and fields an already-filed Backlog ticket correctly. This is NOT a gate test —
it makes LLM calls and never runs in `bun test`. The deterministic half of the
schema (validator + `z-ticket-lint`) is gated in `tests/plan-schema.test.ts`;
this eval covers the latent half. The harness that runs it (issue #25) has its
own gate tests in `../../tests/planner-harness.test.ts` — the splitter, score
aggregation, exit-code gate, reproducibility check, and board double are pure
functions, fixture in/expected out, no `claude -p` involved.

## Files

| File | Role |
|------|------|
| `fixture-spec.md` | The spec fed to the planner — a toy link-shortener with a 3-ticket dependency chain latent in it (persistence ← service ← CLI). |
| `fixture-spec-2.md` | A second, independent document for the multi-document pass (issue #16). |
| `fixture-app/` | The target codebase the planner grounds against. Only `src/store.ts` exists, so "grounded file refs" is checkable. |
| `fixture-backlog-ticket.md` | A two-line brain-dump Backlog ticket body (fails `z-ticket-lint` as-is), fed to the Step 10 backlog-scan pass. |
| `rubric.md` | Five scored dimensions (0–2 each, /10) and the **pass threshold: avg ≥ 8/10**, for both the spec pass and the "Backlog scan pass" section. |
| `harness.ts` | The deterministic pipeline (issue #25): splitter, `z-ticket-lint` wiring, score aggregation, the ≥8/10 exit-code gate, Estimate reproducibility. Pure functions + a `check <outDir> <runs>` CLI. |
| `board-double.ts` | A fake `gh` CLI serving `fixture-backlog-ticket.md` as the sole Backlog item, so the backlog-scan pass needs no live GitHub project. |
| `mock-claude.sh` | A canned stand-in for `claude -p`, so `run.sh` can be verified end-to-end with zero cost. |
| `run.sh` | The runnable harness: `run.sh <spec\|backlog> [runs]`. |
| `run.md` | The full contract for every pass (spec, backlog-scan, multi-document, explicit two-path) and how to run each. |

## How to run

Everything routes through **local Claude Code (`claude -p`)** — never a hosted
LLM API (PRINCIPLES.md "LLM access"). See `run.md` for the full contract. In short:

```bash
evals/planner/run.sh spec 3      # real, paid
evals/planner/run.sh backlog 3   # real, paid
```

1. **Plan** — run `/z-plan --dry-run` (or `--backlog --dry-run`) capturing the
   emitted ticket bodies + fields + dependencies.
2. **Gate** — `harness.ts` splits the output into per-ticket bodies and lints
   each with `../../bin/z-ticket-lint` (dimension 1, deterministic).
3. **Grade** — a fresh `claude -p` scorer grades the output against `rubric.md`
   and returns the rubric's JSON.
4. **Aggregate** — `harness.ts` averages the totals over N runs and checks
   Estimate reproducibility; pass is one exit code, not prose.

## What "pass" means

- Quality: average rubric total ≥ 8/10 (`rubric.md`).
- Schema: every emitted ticket body lints clean through `bin/z-ticket-lint` —
  a deterministic ground truth the harness holds independently of what the
  LLM grader self-reports for the rubric's own schema-gate dimension.
- Reproducibility (issue #7 AC2): the Estimate values are identical across runs
  on the same spec — checked by the harness separately from the graded score,
  because the estimate chain (tier → `z-estimate`) is deterministic by design
  (`z-plan/SKILL.md` Step 6).

All three gate the same exit code (`computeExitCode` in `harness.ts`).
Nightly scheduling is documentation only (`run.md`'s last section) — the
command to run; scheduling itself is the user's cron/routine.
