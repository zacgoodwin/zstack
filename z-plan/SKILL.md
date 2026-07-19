---
name: z-plan
description: |
  Turns a plan/spec file (a gstack CEO plan, a Spec Document, or any plan file)
  into milestones and board-ready GitHub tickets for the zstack dev loop: each
  ticket grounded in the real codebase, written to the enforced body schema,
  fielded with a Model / Model Effort recommendation and a reproducible dollar
  Estimate, and linked to its dependencies both directions. Idempotent: re-running
  on the same spec matches existing tickets by title slug and updates them instead
  of duplicating. Also plan-gates the Backlog itself (Step 10): every ticket
  already sitting in Backlog — human brain-dumps, and the surfaced use cases the
  loop's completion flow files there — gets the same schema gate and fields
  without being promoted; `/z-plan --backlog` runs this scan alone, with no spec
  file needed. This is the "planner" box of the develop stage, usable outside
  the loop. Use when asked to "plan this spec", "z-plan", "turn the plan into
  tickets", "scan the backlog", "plan-gate the backlog", or before the first
  build pass on a repo whose board is already set up by /z-setup.
---

# /z-plan — Spec to milestones + board-ready tickets

You are the planner. Given a plan/spec file you produce milestones (epics) and
the tickets under them: each grounded in the actual code, each body passing the
schema gate, each fielded with Model + Model Effort + a reproducible Estimate,
each linked to what it depends on. You AUTHOR and file tickets here; you do not
build them. Reads `~/.zstack/projects/<slug>/config.json` (written by /z-setup);
every write to the board goes through `bin/z-board`, every dollar figure through
`bin/z-estimate`, every ticket body through `bin/z-ticket-lint`. No arithmetic
and no board mutation ever happens in your prose.

Resolve the pack directory once (the skill and bins are installed together):

```bash
PACK="$HOME/.claude/skills/zstack"
[ -d "$PACK" ] || PACK="$(cd "$(dirname "${BASH_SOURCE:-$0}")/.." && pwd -P)"
Z_BOARD="$PACK/bin/z-board"
Z_ESTIMATE="$PACK/bin/z-estimate"
Z_LINT="$PACK/bin/z-ticket-lint"
TIERS="$PACK/z-plan/tiers.json"
SLUG=$(gh repo view --json name -q .name)   # one board per repo; matches /z-setup
export ZSTACK_SLUG="$SLUG"   # H13: so any z-board call that omits --slug still
                             # resolves the right project (resolveSlug honors
                             # ZSTACK_SLUG) instead of throwing "Multiple zstack
                             # projects" on a multi-project machine.
```

---

## Step 0 — Preconditions (stop on any failure)

1. **Board configured.** `bun "$PACK/lib/board.ts" quota --slug "$SLUG" >/dev/null`
   must succeed. If it fails, /z-setup has not run for this repo — stop and run it.
2. **gh authenticated with project scope.** `gh auth status` clean (same probe as
   /z-setup Step 1). Stop and fix before continuing.
3. **bun present.** `command -v bun`.

---

## Step 1 — Resolve the input spec, and the `--backlog` / `--dry-run` flags

Two flags are recognized ahead of the spec path; parse them first and treat
whatever argument remains as the spec:

```bash
BACKLOG_ONLY=""
DRY_RUN=""
SPEC=""
for arg in "$@"; do
  case "$arg" in
    --backlog) BACKLOG_ONLY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    *) SPEC="$arg" ;;
  esac
done
```

**When `--backlog` is set:** skip straight to Step 10 — no spec resolution, and
no "No spec file found" failure (AC4). Steps 2–9 do not run; `--dry-run` still
applies (Dry-run / eval mode below).

**Otherwise**, resolve the spec as always: when none is given, default to the
newest file in gstack's CEO-plans directory for this project:

```bash
if [ -z "$SPEC" ]; then
  PLANS="$HOME/.gstack/projects/$SLUG/ceo-plans"
  SPEC=$(ls -t "$PLANS"/* 2>/dev/null | head -1)
fi
[ -n "$SPEC" ] && [ -f "$SPEC" ] || { echo "No spec file found; pass a path." >&2; exit 1; }
```

Read the whole spec. It is the source of the milestones and tickets; do not
invent scope it does not contain. Run Steps 2–9 on it, then Step 10 — the
Backlog scan runs as the final step of every normal spec run too, not only via
`--backlog`.

---

## Step 2 — Ground in the codebase BEFORE writing any plan

PROCESS.md step 1: a plan is only acceptable when it is grounded in the actual
code — files, line refs, the real flow end to end. Read the target repo first:
the areas the spec touches, the existing patterns to reuse (PRINCIPLES.md
ponytail ladder), the tests already in place. Every ticket's `## Plan` cites
**real files and line refs** you have opened, not guesses. A plan whose file
refs you did not read is not grounded and does not ship.

---

## Step 3 — Milestones (epics) per config.json `epicStyle`

Read `epicStyle` from config.json and model each epic from the spec accordingly:

- `milestones` — one GitHub milestone per epic; `z-board create --milestone <M>`
  files each child under it. This is the /z-setup default and the only style
  supported today.
- `issue-type` — an epic issue whose children are linked as sub-issues. **Not
  yet supported**: no sub-issue create path exists, and config validation
  rejects `epicStyle: "issue-type"` until one is implemented (issue #14), so a
  config read here always says `milestones`.

Group the spec's work into these epics before drafting individual tickets.

---

## Step 4 — Draft each ticket body to the schema, then gate it

Every ticket body MUST contain these sections (the schema in
`lib/ticket-schema.ts`; `### Acceptance Criteria` is an h3 subsection of Plan,
the rest are h2):

- `## Context` — why this ticket exists, tied to the spec.
- `## Plan` — the files it touches (real paths + line refs from Step 2) and the
  ordered steps.
- `### Acceptance Criteria` — concrete cases as **setup → action → expected
  outcome**, authored NOW, before any implementation. These are the independent
  yardstick the review checks against (CLAUDE.md); the builder makes them pass
  as written, and weakening one is a spec question, never a silent edit.
- `## Tests + evals` — the gate tests and, where the work is latent, the eval to
  add in the same diff.
- `## Docs pages touched` — the `docs/user-guide/` pages to update when the
  ticket changes what users see or do; "none (no user-facing change)" otherwise.
- `## Out of scope` — what this ticket deliberately does not do.
- `Depends on: #A, #B` — optional line; omit it when the ticket has no
  dependencies. When present it names the issues this ticket waits on.

Gate every body before it touches the board — this is deterministic, so run the
script, never eyeball it:

```bash
"$Z_LINT" /path/to/ticket-body.md   # exit 0 = valid; exit 1 prints each gap on stderr
```

Do not file a ticket whose body does not pass `z-ticket-lint`. The gate is the
same one the loop's planning pass runs, so "all mandatory sections present"
means one thing everywhere.

---

## Step 5 — Chunking: split anything that needs more than 400K tokens of context

PROCESS.md step 3: a ticket whose plan needs more than 400K tokens of live
context to complete is split into ordered subtasks, and the order is recorded in
the parent. Estimate context with the same bucket approach as the estimator (C4)
— count, then compare against thresholds; do not multiply in prose:

- `F` = distinct files the plan reads or modifies.
- `S` = ordered steps in `## Plan`.

The derivation (documented, not run in your head): peak context ≈ 50K grounding
baseline + ~10K per file read + ~8K of working context per step. Setting that
over 400K and solving gives the operational split thresholds. The decision is a
comparison on two integers, so it is deterministic space — call the codified
gate, don't eyeball it:

```bash
bun -e "import {needsSplit} from '$PACK/lib/ticket-schema.ts';
  console.log(JSON.stringify(needsSplit(/*files*/ 20, /*steps*/ 12)))"
# -> {"split":true,"reason":"20 files > 15; over the 400000-token context budget."}
```

`needsSplit(F, S)` splits when `F > 15`, or `S > 30`, or (`F > 8` **and**
`S > 20`). When a ticket trips the gate, break it into subtasks that each fall under the
thresholds, file each subtask as its own ticket, and record the completion order
in the parent (a `## Subtasks (in order)` list of `#N` refs). Link parent↔child
per Step 7. Re-estimate each subtask on its own (Step 6); the parent then carries
no Estimate of its own beyond the sum its children report.

---

## Step 6 — Fields: Model, Model Effort, and a reproducible Estimate

**Model + Model Effort** per ESTIMATION.md's rules of thumb — the most
cost-efficient tier that finishes the ticket with minimal rework, and *cost
efficiency includes rework*, so **when in doubt between two tiers, pick the
higher one**:

- `haiku` — mechanical, tightly-specified, low-blast-radius (renames, config/doc
  edits, small fixes already pinned by tests).
- `sonnet` — standard single-service feature on familiar patterns with a test
  harness that catches mistakes cheaply.
- `opus` — cross-service or schema/engine/migration work, security-sensitive
  code, ambiguous specs, gnarly debugging.
- `fable` — the hardest tickets where even Opus likely needs a second attempt;
  earns its 2× Opus price only when one clean pass replaces two.

**Estimate** is arithmetic, so it is computed, never eyeballed (ESTIMATION.md).
The chain that makes two runs on the same spec land on the same dollar figure:

1. The Model + Model Effort you chose selects one **tier** in
   `z-plan/tiers.json`. The five tiers and their pre-computed full-lifecycle
   dollar totals (plan + build + QA + review + merge, buffered):

   | Tier          | Model  | Effort | Buffer | Estimate |
   |---------------|--------|--------|--------|----------|
   | `haiku-low`   | haiku  | low    | 30%    | $0.23    |
   | `sonnet-medium` | sonnet | medium | 30%  | $1.64    |
   | `opus-high`   | opus   | high   | 30%    | $4.36    |
   | `opus-xhigh`  | opus   | xhigh  | 30%    | $7.15    |
   | `fable-xhigh` | fable  | xhigh  | 50%    | $19.50   |

2. Copy that tier's entry verbatim into a `buckets.json` and shell it to
   `z-estimate`. You produce the bucket **counts** by tier lookup (no
   arithmetic); `z-estimate` does the only arithmetic (buckets × rates + buffer):

   ```bash
   bun -e "require('fs').writeFileSync('/tmp/bk.json',
     JSON.stringify(require('$TIERS').tiers['opus-xhigh']))"
   "$Z_ESTIMATE" /tmp/bk.json          # -> $7.15 (subtotal $5.50, buffer 30%, model opus)
   ```

**Why this is reproducible (issue #7 AC2):** the tier is a function of the
ticket's blast radius and ambiguity (the ESTIMATION.md table), its buckets are a
fixed lookup, and `z-estimate` is deterministic (`lib/estimate.ts` — same buckets
+ same rates → same dollars, proven in `tests/estimate.test.ts` and pinned per
tier in `tests/plan-schema.test.ts`). Record the tier in Model + Model Effort so
a re-plan (Step 9) reuses it rather than re-deriving, closing the loop on
determinism. Directional accuracy is fine (ESTIMATION.md); reproducibility is not
optional.

Write all three fields through the board contract — never hand-edit the board:

```bash
"$Z_BOARD" field-set <N> Model "opus"        --slug "$SLUG"
"$Z_BOARD" field-set <N> "Model Effort" xhigh --slug "$SLUG"
"$Z_BOARD" field-set <N> Estimate 7.15        --slug "$SLUG"
```

---

## Step 7 — Dependencies: discover, create, link both directions

For each ticket, identify what it depends on (a schema it needs, a service it
calls, an earlier ticket in the chain). For each dependency:

1. **Find it** — search Backlog and Ready for an existing ticket
   (`"$Z_BOARD" list --status Backlog --json` / `--status Ready --json`), matching
   by title slug (Step 9's `slugifyTitle`) so you don't miss one under a reworded
   title.
2. **Create it if missing** — `"$Z_BOARD" create --title ... --body-file ...
   --milestone ...` (its body must pass `z-ticket-lint` too).
3. **Link both directions** — `"$Z_BOARD" link <N> <M>` records "N Depends on
   #M" on N and "M Blocks #N" on M (idempotent; re-running never double-links).
4. **Pull dependents into Ready** — a dependency that must be analyzed next moves
   to Ready: `"$Z_BOARD" move <M> Ready --slug "$SLUG"`.

A 3-ticket chain A→B→C ends with A depending on nothing, B depending on #A, C
depending on #B, and the reverse "Blocks" line on each of A and B.

---

## Step 8 — Questions for a human → comment + Questions status

Anything you cannot resolve from the spec and the code (a genuine ambiguity, a
contradicting pattern, a missing decision that changes the approach — the
Confusion Protocol bar, not routine choices): write the question as a comment and
move the ticket to Questions. Do not guess it into the plan.

```bash
"$Z_BOARD" comment <N> --body-file question.md --slug "$SLUG"
"$Z_BOARD" move <N> Questions --slug "$SLUG"
```

---

## Step 9 — Idempotent re-plan

Re-running /z-plan on the same spec must update tickets, not duplicate them.
Match by the kebab-case title slug (`slugifyTitle` in `lib/ticket-schema.ts`,
stable and ASCII):

```bash
bun -e "import {slugifyTitle} from '$PACK/lib/ticket-schema.ts';
  console.log(slugifyTitle('C5: /z-plan, spec to milestones'))"   # c5-z-plan-spec-to-milestones
```

For each planned ticket, compute its slug and compare against the slugs of
existing board items (list per status, slugify each title). On a match, update
that ticket's body and fields in place; only `create` when no slug matches. Same
spec in → same set of tickets, no dupes.

---

## Step 10 — Backlog scan

z-loop's planning pass (z-loop/SKILL.md Step 1) gates only Ready; Backlog
tickets — human brain-dumps, and the surfaced use cases the loop's completion
flow files there (z-loop/SKILL.md Step 6.2) — otherwise sit unplanned until a
human hand-promotes them. This step closes that gap: every ticket already in
Backlog gets the same schema gate and fields a Ready ticket gets, without being
promoted. It runs as the final step of a normal spec run (right after Step 9)
and it also runs alone via `/z-plan --backlog` (Step 1's flag parsing — no spec
file needed either way, AC4).

```bash
TMP="$HOME/.zstack/projects/$SLUG/z-plan/tmp"; mkdir -p "$TMP"
"$Z_BOARD" list --status Backlog --json --slug "$SLUG" > "$TMP/backlog.json"
```

For each ticket number `<N>` in that list:

1. **Fetch the body:** `gh issue view <N> --json body -q .body > "$TMP/body-<N>.md"`
   (the same read the loop's planning pass uses; z-board has no body-read
   subcommand).
2. **Gate it:** `"$Z_LINT" "$TMP/body-<N>.md"` — `bin/z-ticket-lint`, the same
   validator contract as everywhere else (`lib/ticket-schema.ts:97-144`).
3. **On a lint failure**, one of two paths applies:
   - **Genuine ambiguity** (the ask contradicts an existing pattern, or a
     decision is missing that changes the approach — the Confusion Protocol
     bar, same test Step 8 uses): write the question as a comment and
     `"$Z_BOARD" move <N> Questions --slug "$SLUG"`. Do not draft a body. This
     is the ONE case in this step that moves a Backlog ticket off Backlog.
   - **Otherwise**, ground in the actual code this ticket's ask touches (Step 2
     applies here too — no file ref you have not opened), draft the body to
     the Step 4 schema, update it with `gh issue edit <N> --body-file ...`,
     re-run `"$Z_LINT"` on the rewritten body to confirm it now passes, and
     comment that the scan added the plan
     (`"$Z_BOARD" comment <N> --body-file note.md --slug "$SLUG"`; one line:
     the scan added the plan above, the ticket is still in Backlog for a human
     to promote).
4. **Fields**, independent of whether step 3 ran: read Model, Model Effort, and
   Estimate (`"$Z_BOARD" field-get <N> <Field> --slug "$SLUG"`, once each). If
   ANY is empty, choose Model + Model Effort per Step 6's rules of thumb and run
   the full Step 6 tier chain (`z-plan/tiers.json` → `"$Z_ESTIMATE"`) to
   `field-set` all three — no arithmetic in prose, same rule as Step 6.
5. **Nothing needed, nothing written.** A Backlog ticket whose body already
   passes lint AND already carries all three fields gets zero body edits, zero
   field writes, and zero comments this run — the same idempotent-rerun
   guarantee Step 9 gives spec-derived tickets.
6. **Never promotes to Ready.** Every ticket this step plans (step 3's draft
   path, step 4's fields) stays exactly where it was found, unless step 3's
   ambiguity path moved it to Questions. Step 10 never calls
   `"$Z_BOARD" move <N> Ready`; promotion is a human decision, and the only
   path anywhere in this skill that ever moves a Backlog ticket to Ready
   remains Step 7.4's dependency pull (a dependency discovered while planning
   OTHER work that must be analyzed next) — Step 10 does not add a second one.
   Moving a ticket to Questions (this step's item 3, and the pre-existing
   Step 8) is a different, allowed movement; Step 10 does not claim
   exclusivity over that one, only over Ready.

---

## Dry-run / eval mode

For the planner eval (`evals/planner/`, wired by C10) and any offline check,
support a **dry run**: do Steps 1–7 but instead of calling `z-board`, emit the
full result as one markdown document to stdout — each ticket's body, its chosen
Model / Model Effort / Estimate, and its `Depends on:` lines — so a scorer can
grade the output with no live board and no network. The eval harness runs this
through local `claude -p` (never a hosted API, PRINCIPLES.md) and scores it
against `evals/planner/rubric.md`.

**`--dry-run --backlog`** applies the identical contract to Step 10: list
Backlog, decide per ticket exactly as Step 10 describes, but instead of
`gh issue edit <N> --body-file ...`, `"$Z_BOARD" field-set`, or
`"$Z_BOARD" comment`, emit each ticket that needed a change as one markdown
block to stdout — its number, the drafted body, the fields it would set, and
(on the ambiguity path) the question that would be commented. No board writes,
no GitHub writes. This is what `evals/planner/`'s backlog-scan pass
(`fixture-backlog-ticket.md`) grades.

---

## Done criteria

Report DONE only when all hold:

- Every filed ticket body passes `z-ticket-lint` (Step 4 gate).
- Every ticket has Model, Model Effort, and an Estimate written via `z-board`,
  the Estimate produced by the tier→`z-estimate` chain (Step 6), reproducible on
  a re-run.
- Every dependency is linked both directions and dependents that need analysis
  are in Ready (Step 7).
- Any ticket over the 400K context gate is split into ordered subtasks with the
  order recorded in the parent (Step 5).
- Open questions are commented and their tickets are in Questions (Step 8).
- A re-run on the same spec updates in place and creates zero duplicates (Step 9).
- Every ticket still in Backlog after the scan — i.e., not moved to Questions
  by item 3's ambiguity path — passes `z-ticket-lint` and carries Model, Model
  Effort, and Estimate (Step 10). This step never promotes a ticket to Ready —
  the only path anywhere in this skill that ever moves a Backlog ticket to
  Ready remains Step 7.4's dependency pull.
