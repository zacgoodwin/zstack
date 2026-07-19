# /z-plan

Turns a plan/spec file into milestones and board-ready GitHub tickets: each
grounded in the real codebase, written to the enforced body schema, fielded with
a Model / Model Effort recommendation and a reproducible dollar Estimate, and
linked to its dependencies both directions. Idempotent: re-running on the same
spec updates tickets in place instead of duplicating.

Full skill contract: `z-plan/SKILL.md`. Usable outside the loop (it is the
"planner" box of the develop stage) or automatically as the loop's planning pass.

## When to run it

After `/z-setup`, whenever you have a spec to turn into tickets:

```bash
/z-plan path/to/spec.md
```

An explicit path always wins unchanged (back-compat) -- exactly that file is
used, no discovery run.

With no argument it discovers and reads **every** gstack planning document for
the repo, not just the newest one: `specs/*.md`, `ceo-plans/*.md`, loose
`*-test-plan-*.md` files, and `checkpoints/*.md` under
`~/.gstack/projects/<slug>/` (`lib/spec-sources.ts`, newest-first within each
kind). The newest entry across just `specs`/`ceo-plans` becomes the primary
spec -- the source of the milestones and tickets, same as a single-file run --
and every other document returned is mandatory grounding context: scope named
only in one of those other documents still makes it into the plan. If no
planning documents exist in any searched directory, it fails loud, naming
every directory it searched, instead of the old "No spec file found" dead end
(no board writes on this path).

There is a second, distinct failure mode: documents were found, but none of
them live under `specs/` or `ceo-plans/` -- only `checkpoints/` and/or loose
test-plan files exist. `/z-plan` never auto-plans from checkpoints or test
plans alone; they are grounding context, not a substitute primary spec. In
that case it stops with a separate error naming exactly what it found (kind
and path for each) and asks you to pass an explicit spec path instead.

Separately, whenever you want every ticket already sitting in Backlog —
human brain-dumps, or the surfaced use cases the loop's completion flow files
there — gated and fielded without a spec, run:

```bash
/z-plan --backlog
```

This needs no spec file and no CEO plan on disk; it runs the Backlog scan
(below) alone. A normal `/z-plan path/to/spec.md` run performs the same scan
too, as its final step, so Backlog never falls behind just because you keep
planning new specs.

## What it does

1. **Grounds in the codebase first.** Reads the files the spec touches; every
   ticket's `## Plan` cites real paths and line refs, not guesses.
2. **Milestones per `epicStyle`.** Groups work into epics. Only `milestones` is
   supported today; the `issue-type` style (epic issue + sub-issues) is not yet
   supported (issue #14).
3. **Drafts each ticket to the schema and gates it.** Mandatory sections:
   `## Context`, `## Plan`, `### Acceptance Criteria` (setup → action → expected,
   authored before any code), `## Tests + evals`, `## Docs pages touched`,
   `## Out of scope`, and an optional `Depends on:` line. Every body must pass
   `bin/z-ticket-lint` before it hits the board.
4. **Splits oversized tickets.** A ticket needing more than a 400K-token context
   is broken into ordered subtasks (the `needsSplit` gate), with the order
   recorded in the parent.
5. **Fields and a reproducible Estimate.** Model + Model Effort per the
   ESTIMATION.md rules of thumb (when in doubt, tier up — rework is expensive).
   The tier selects a fixed bucket entry that `bin/z-estimate` prices, so the same
   spec always yields the same dollar figure. No arithmetic in prose.
6. **Dependencies both directions.** Finds or creates each dependency, links
   "N Depends on #M" and "M Blocks #N", and pulls the next-to-analyze dependents
   into Ready.
7. **Questions to a human.** A genuine ambiguity (Confusion Protocol bar) is
   commented on the ticket and the ticket moved to Questions — never guessed into
   the plan.
8. **Backlog scan.** Every ticket already in Backlog gets the same lint gate and
   the same fields (Model/Model Effort/Estimate) a Ready ticket gets — without
   being promoted. A ticket that already passes and is already fielded gets zero
   writes (idempotent). A genuine ambiguity still goes to Questions, same as
   step 7. Runs as the final step of every spec run, and alone via
   `/z-plan --backlog`.

## Dry-run / eval mode

`/z-plan --dry-run <spec>` emits the full result (each ticket body + fields +
`Depends on:` lines) to stdout with no board writes, so a scorer can grade it
offline. This is what the planner eval (`evals/planner/`) runs through local
`claude -p`.

`/z-plan --dry-run --backlog` does the same for the Backlog scan: no
`gh issue edit`, no `z-board` writes, no comments — just each ticket that
needed a change, emitted to stdout as one markdown block.

## Done when

Every filed ticket passes the lint gate, carries Model/Effort/Estimate via
`z-board`, links its dependencies both ways, splits anything over the context
gate, parks open questions, and a re-run creates zero duplicates. Every ticket
still in Backlog after the scan — i.e., not moved to Questions by a genuine
ambiguity — passes the same lint gate and carries the same three fields; this
step never promotes a ticket to Ready.
