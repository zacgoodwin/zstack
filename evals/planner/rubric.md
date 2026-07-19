# /z-plan eval rubric

Scores one /z-plan run on `fixture-spec.md` (dry-run mode: ticket bodies + fields
+ dependencies emitted as markdown, no live board). Five dimensions, 0–2 each,
**10 points total**. **Pass threshold: average ≥ 8/10** across the scored runs;
below that, the planner regressed and the change does not ship.

The grader is a fresh local `claude -p` pass (never a hosted API — PRINCIPLES.md
"LLM access") given: this rubric, the fixture spec, the fixture app tree
(`fixture-app/`), and the planner's output. It returns a JSON object
`{schema, grounding, acceptance, tiers, dependencies, total, notes}`.

## Dimensions

### 1. Schema gate (0–2)
Every emitted ticket body passes the schema. This is checkable deterministically:
pipe each ticket body through `bin/z-ticket-lint`.
- 2 — every ticket passes `z-ticket-lint` (exit 0).
- 1 — one ticket fails the gate.
- 0 — two or more fail.

### 2. Grounded file refs (0–2)
Plans cite the real fixture-app files they build on, not invented paths.
- 2 — the persistence and service tickets both cite `src/store.ts` and the
  `Store` class (ideally with line refs); new files use plausible paths
  (`src/shortener.ts`, `src/cli.ts`).
- 1 — some grounding, but a ticket references a file that does not exist or omits
  the existing `store.ts` where it clearly builds on it.
- 0 — refs are generic or invented; no evidence the codebase was read.

### 3. Testable acceptance criteria (0–2)
Each `### Acceptance Criteria` case reads as setup → action → expected outcome and
could be executed as-is.
- 2 — every ticket has ≥2 concrete setup→action→expected cases (e.g. "create a
  code, restart, resolve it → same URL").
- 1 — cases exist but some are vague ("works correctly") or not executable.
- 0 — AC missing or purely aspirational.

### 4. Correct model tier (0–2)
Model + Model Effort match the ESTIMATION.md rules of thumb for these tickets.
These are small, single-file, well-specified units on a tiny codebase with a test
harness → `sonnet`/`medium` is the expected default; `haiku`/`low` is acceptable
for the most mechanical (persistence I/O pinned by tests). `opus`+ is over-tiering
here and loses a point.
- 2 — every ticket at `sonnet` or `haiku` with a defensible effort.
- 1 — one ticket mis-tiered (e.g. opus for a trivial CLI wrapper).
- 0 — tiers absent or systematically wrong.

### 5. Dependency completeness (0–2)
The latent 3-ticket chain is discovered and linked in the right order.
- 2 — persistence ← shortener ← CLI, with each dependent naming its dependency in
  a `Depends on:` line and the build order stated; no cycle.
- 1 — the chain is present but a link is one-directional or the order is off.
- 0 — dependencies missing or wrong (e.g. CLI planned with no dependency on the
  service).

## Expected shape of a passing run

Three tickets, in build order:
1. **Persist the store to disk** — extends `src/store.ts`; depends on nothing.
2. **Shorten/resolve service** (`src/shortener.ts`) — depends on #1.
3. **CLI commands** (`src/cli.ts`) — depends on #2.

A run that emits these three, each passing `z-ticket-lint`, grounded in
`store.ts`, tiered at sonnet/haiku, with the chain linked, scores 10/10.

## Backlog scan pass (issue #13)

Scores one `/z-plan --backlog --dry-run` run against `fixture-backlog-ticket.md`
— Step 10's scan (z-plan/SKILL.md), not the spec-to-tickets flow above. Same
five dimensions, same 0–2 each, **10 points total, pass threshold: average ≥
8/10** — scored against the single ticket this pass plans instead of the
three-ticket chain.

The grader is the same fresh local `claude -p` pass, given this rubric, the
fixture Backlog ticket body (`fixture-backlog-ticket.md` — a two-line brain-dump
that fails `z-ticket-lint` as-is), `fixture-app/`, and the pass's output.

1. **Schema gate (0–2).** The one emitted body passes `bin/z-ticket-lint` (exit
   0). This is the deterministic half issue #13's Tests + evals names directly
   — check it with the lint CLI, don't eyeball it.
2. **Grounded file refs (0–2).** The drafted ticket cites `src/store.ts` (the
   `Store` class, ideally with line refs) rather than inventing a file or
   ignoring the codebase — the graded half issue #13 names directly.
3. **Testable acceptance criteria (0–2).** Same bar as dimension 3 above,
   applied to the one ticket.
4. **Correct model tier (0–2).** Same bar as dimension 4 above; the fixture's
   ask (delete-by-code on an existing in-memory store) is small and
   single-file, so `sonnet`/`haiku` is expected.
5. **Dependency completeness (0–2).** The fixture ticket is standalone — full
   marks means no invented `Depends on:` line; inventing a dependency it does
   not need loses the point.

### Expected shape of a passing backlog-scan run

One ticket, body rewritten to the schema, passing `z-ticket-lint`, grounded in
`src/store.ts`, tiered at sonnet or haiku, no invented dependency, all three
fields (Model, Model Effort, Estimate) filled via the Step 6 tier chain, and the
ticket left in Backlog (Step 10 never promotes) — scores 10/10.
