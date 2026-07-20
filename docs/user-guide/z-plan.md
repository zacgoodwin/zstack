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

**More than one explicit path is also supported**:

```bash
/z-plan path/to/a.md path/to/b.md path/to/c.md
```

The FIRST path given is the primary spec -- the source of the milestones and
tickets, same as passing one path. Every path after it is mandatory grounding
context: read in full, and scope named only in one of those other files still
makes it into the plan, exactly like the no-argument discovery case below --
nothing named on the command line is ever silently dropped. (Passing several
paths used to silently keep only the last one; every named path now
contributes.) Explicit paths, one or several, always bypass discovery -- it
only runs with zero path arguments. Every named path must exist: if any one
doesn't, `/z-plan` fails loud naming exactly which path is missing and makes
no board writes -- it never falls back to planning from just the paths that
do exist.

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

To run that same scan against a single ticket instead of the whole Backlog:

```bash
/z-plan --ticket 42
```

`--ticket <N>` is the single-ticket form of `--backlog` — it needs no spec
file either, and shares every Backlog-scan behavior with `--backlog` (the
lint gate, the fields, the split gates below, the idempotent zero-write
rerun, never promoting to Ready). The difference is scope: `--ticket 42`
reads and writes only issue #42, wherever it currently sits (any status
except Done), and leaves every other Backlog ticket untouched. A ticket
number that isn't on the board, or that's already Done, fails loud with no
board writes rather than silently skipping.

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
4. **Plan-time edges comment.** Once the body passes the lint gate, chosen
   defaults, spec-ambiguous calls, and data-loss-ish behaviors the PLAN itself
   introduces are collected as `{check, doStep, expect}` edges and, when
   non-empty, rendered by `planEdgesComment` (`lib/stage-prompts.ts`, reusing
   completion-note's `CompletionEdge` shape) and posted as a `## Needs input —`
   comment at the bottom of the plan. Informational only — the ticket stays
   wherever it already is; an empty edge list posts no comment.
5. **Splits oversized tickets.** A ticket needing more than a 400K-token context
   is broken into ordered subtasks (the `needsSplit` gate), with the order
   recorded in the parent.
6. **Fields and a reproducible Estimate.** Model + Model Effort per the
   ESTIMATION.md rules of thumb (when in doubt, tier up — rework is expensive).
   The tier selects a fixed bucket entry that `bin/z-estimate` prices, so the same
   spec always yields the same dollar figure. No arithmetic in prose.
7. **Dependencies both directions.** Finds or creates each dependency, links
   "N Depends on #M" and "M Blocks #N", and pulls the next-to-analyze dependents
   into Ready.
8. **Questions to a human, and a fold-in gate.** A genuine ambiguity (Confusion
   Protocol bar) is commented on the ticket and the ticket moved to Questions —
   never guessed into the plan. Whenever this skill touches a ticket that may
   already carry human comments (a re-plan below, or the Backlog scan), it also
   folds in the newest comment authored by someone other than its own session
   login and rebuilds the plan if that comment changed it; a comment raising a
   NEW question the plan doesn't already answer is posted as `## Needs input —`
   and the ticket moves to Questions, same as any other open question
   (PROCESS.md step 6).
9. **Backlog scan, with two split gates.** Every ticket already in Backlog gets
   the same lint gate and the same fields (Model/Model Effort/Estimate) a
   Ready ticket gets — without being promoted. A ticket that already passes
   and is already fielded gets zero writes (idempotent). A genuine ambiguity
   still goes to Questions, same as step 8. When a scan drafts a fresh body
   (the ticket didn't already pass lint), it's checked against BOTH split
   gates before filing: `needsSplit` (context, same as item 4 above) and
   `shouldSplitForCost` (`lib/ticket-schema.ts`) — splitting only when a
   proposed decomposition's children would cost strictly less, combined, than
   the single ticket's own tier. Either gate tripping files the children to
   the same schema/fields/links as any other ticket, adds a
   `## Subtasks (in order)` list to the parent, and comments on the parent
   that a human should close it once every child lands — the parent is never
   auto-closed, moved, or promoted. Runs as the final step of every spec run,
   alone via `/z-plan --backlog`, or scoped to one ticket via
   `/z-plan --ticket <N>`.
10. **Cost-saving suggestions.** A terminal, batch-specific report for the human
   running `/z-plan` — the ticket numbers, real dollar figures, and shared files
   from *this run's own batch* (every ticket this run filed, updated, or drafted
   a body for in the Backlog scan, excluding tickets the scan left untouched or
   parked to Questions). It flags the most expensive ticket, any file touched by
   several tickets worth sequencing, and mechanical work cheap enough to batch
   in one lane. Advisory only — never a board write, a comment, or a
   notification. A run whose batch is empty (e.g. a `--backlog` run where every
   ticket already passed and was already fielded) prints nothing. The
   arithmetic (`lib/cost-suggest.ts`, `bin/z-cost-suggest`) is computed, never
   eyeballed; only the wording is written by the run itself.

## Dry-run / eval mode

`/z-plan --dry-run <spec>` emits the full result (each ticket body + fields +
`Depends on:` lines) to stdout with no board writes, so a scorer can grade it
offline. This is what the planner eval (`evals/planner/`) runs through local
`claude -p`.

`/z-plan --dry-run --backlog` does the same for the Backlog scan: no
`gh issue edit`, no `z-board` writes, no comments — just each ticket that
needed a change, emitted to stdout as one markdown block. `/z-plan --dry-run
--ticket <N>` composes the same way, scoped to that one ticket.

## Done when

Every filed ticket passes the lint gate, carries Model/Effort/Estimate via
`z-board`, links its dependencies both ways, splits anything over the context
gate, parks open questions, and a re-run creates zero duplicates. Every ticket
still in Backlog after the scan — i.e., not moved to Questions by a genuine
ambiguity — passes the same lint gate and carries the same three fields —
except a split parent, which fields only its children (below); this
step never promotes a ticket to Ready. A ticket split by either gate carries
a `## Subtasks (in order)` list and both-direction links to its filed
children, and stays open and un-promoted for a human to close once every
child lands. A run that plants at least one Estimate this run also ends with
the cost-saving report above, printed once, after everything else is written.
