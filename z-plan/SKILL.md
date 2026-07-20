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
Z_COST_SUGGEST="$PACK/bin/z-cost-suggest"
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

## Step 1 — Resolve the input spec(s), and the `--backlog` / `--dry-run` flags

Two flags are recognized ahead of any spec path arguments; parse them first
and collect every remaining non-flag argument into an ordered list,
first-is-primary (below):

```bash
BACKLOG_ONLY=""
DRY_RUN=""
SPECS=()
for arg in "$@"; do
  case "$arg" in
    --backlog) BACKLOG_ONLY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    *) SPECS+=("$arg") ;;
  esac
done
```

**When `--backlog` is set:** skip straight to Step 10 — no spec resolution, and
no "No spec file found" failure (AC4). Steps 2–9 do not run; `--dry-run` still
applies (Dry-run / eval mode below).

**Otherwise**, resolve the spec(s):

**An explicit path argument wins unchanged** (back-compat, AC2 of issue #16):
when exactly one non-flag argument is given, `$SPECS` holds that one path —
use exactly that file, no discovery run, no reading of any other document.
Identical to the behavior before this ticket (issue #19).

**More than one explicit path argument is also supported**
(`/z-plan a.md b.md c.md`, issue #19): `${SPECS[0]}` — the FIRST path — is the
**primary spec**, the source of the milestones and tickets, same as the
single-path case above. Every subsequent path is **mandatory grounding
context**, the identical contract the no-arg discovery case below gives its
non-primary documents: read every one of them, and scope named ONLY in one of
these other files still belongs in the plan — nothing named on the command
line is optional background reading, and nothing is silently dropped. (Before
this ticket, Step 1's flag-parsing loop assigned every non-flag argument to a
single `SPEC` variable, so only the LAST path survived and the rest were
silently dropped — the bug issue #19 fixes.) Explicit paths, whether one or
several, still bypass `lib/spec-sources.ts` discovery entirely — discovery
(below) only runs with zero path arguments.

**Every named path must exist before any of them is read** — checked up
front, not discovered mid-plan:

```bash
for p in "${SPECS[@]}"; do
  [ -f "$p" ] || { echo "z-plan: spec file not found: $p" >&2; exit 1; }
done
```

A missing file fails loud, naming exactly which path does not exist, and
exits 1 with no board writes — it does NOT fall back to planning from the
paths that do exist: `/z-plan a.md missing.md` never plans from `a.md` alone.

**With no argument** (`$SPECS` is empty), gstack writes several planning artifacts per project
under `~/.gstack/projects/<slug>/` — not only the newest `ceo-plans/` file:
`specs/`, `ceo-plans/`, loose `*-test-plan-*.md` files, and `checkpoints/`. A
plan grounded on only the single newest file misses scope recorded in the
others (issue #16), so discover and read EVERY one of them:

```bash
DOCS_JSON=$(bun "$PACK/lib/spec-sources.ts" "$HOME/.gstack/projects/$SLUG") || exit 1
```

`lib/spec-sources.ts` (issue #16) is the deterministic half: it lists
`specs/*.md`, `ceo-plans/*.md`, `*-test-plan-*.md`, and `checkpoints/*.md`
under the project dir, newest-first within each kind. On success it prints a
JSON array of `{path, kind, mtimeMs}`; **read every file it names** — the
newest entry whose `kind` is `specs` or `ceo-plans` (compare `mtimeMs` across
just those two kinds; do not simply take the array's first element, since
`specs` entries are always listed before `ceo-plans` entries regardless of
which is actually newer) is the **primary spec** — the source of the
milestones and tickets, same as a single-file run. Every other document
returned (the rest of `specs`/`ceo-plans`, all of `test-plan`, all of
`checkpoints`) is **mandatory grounding context**: do not invent scope no
document contains, but scope named ONLY in one of these other documents still
belongs in the plan (AC1) — it is not optional background reading.

**On failure** (`lib/spec-sources.ts` exits non-zero: no planning documents
exist in any searched directory), there is no "No spec file found" dead end
(the bug that motivated this ticket) — the command substitution above only
captures stdout, so its stderr message, already naming every directory it
searched (AC3), has printed directly; just `exit 1`. No board writes happen on
this path.

**A second, distinct failure**: `lib/spec-sources.ts` also exits non-zero when
it found documents but ZERO of them are `specs`/`ceo-plans` (only `test-plan`
and/or `checkpoints` entries exist) — there is no primary-spec candidate,
since the primary spec is picked from `specs`/`ceo-plans` only. Its stderr
message is DISTINCT from the empty-result one above: it names every kind and
path it did find and states plainly that no specs/ceo-plans primary-spec
candidate exists. Echo that message and `exit 1` — do NOT auto-plan from
checkpoints or test plans alone; those two kinds are mandatory grounding
context only, never a substitute primary spec. Stop with no board writes on
this path either; the caller must re-run with an explicit spec path instead.

Run Steps 2–9 on the primary spec (grounded with the other documents' scope
folded in), then Step 10 — the
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

## Step 11 — Cost-saving suggestions (terminal output)

Every run that files/updates at least one ticket ends with a short cost-saving
report for the human running /z-plan — advisory only, never a board write,
never a comment, never routed through any notification transport.

"The batch" for this step is exactly: every ticket Steps 4-9 filed or updated
in this run, plus every ticket Step 10 drafted a body for (its "otherwise"
branch) — explicitly EXCLUDING Step 10's untouched already-fielded tickets
("nothing needed, nothing written") and any ticket this run parked to
Questions (neither carries a fresh Estimate this run stands behind). A run
whose batch is empty (a `--backlog` run where every ticket already passed and
was already fielded) skips this step and prints nothing.

Assemble one entry per batch ticket from data already in hand THIS run — no
new field-get, no re-reading any body:

- number, title: already known from filing/drafting it.
- model, modelEffort, estimate: the exact values just written via Step 6's
  `"$Z_BOARD"` field-set calls (or already-passing values Step 10 read).
- files: the exact file list already assembled for THIS ticket's Step 5
  needsSplit file count — reused, never re-derived.

Write that array to a temp `planned-batch.json` and shell it to the
deterministic helper — the arithmetic is computed, never eyeballed, same
discipline as Step 6's tier → z-estimate chain:

```bash
"$Z_COST_SUGGEST" planned-batch.json   # -> one CostBreakdown JSON object on stdout
```

Only the WORDING below is your own prose. Turn `totalEstimate`, `byTier`,
`sharedFileClusters`, `topCostTicket`, and each `suggestions[]` entry's `fact`
into 3-6 short lines printed to the human — name the real ticket numbers,
files, and dollar figures the JSON gave you; never generic advice the JSON
does not support (no "write more efficient code", no boilerplate unconnected
to this batch's actual numbers). Example shape (not literal wording):

- total batch estimate is $28.75 across 5 tickets.
- #105 ("...") is fable-xhigh ($19.50) — confirm the tier is warranted or
  split it.
- lib/config.ts is touched by 3 tickets (#103, #104, #105) — sequencing them
  reduces re-review churn.
- #101, #102 are haiku-low mechanical work — batch them in one lane.

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

**Notify.** Once DONE, `send plan-complete` through the shared notification edge
(`lib/notify.ts`) so a `/z-plan` run pings the same Discord channel as the loop —
a no-op when the project has no `notifications` config
(docs/user-guide/z-loop.md). A plan run has no drain loop, no per-status
counts, and no spend, so it is its own event (#68) rather than a `work-complete`
with a fake `loopCount: 0` — the message names the plan run and the count of
tickets created/updated this run, and toggles independently of loop
completions under `notifications.events`:

```bash
jq -n --arg slug "$SLUG" --argjson created "$CREATED" \
  '{slug:$slug, ticketsCreated:$created}' \
  > "$TMP/notify-plan.json"
bun "$PACK/lib/notify.ts" send plan-complete "$TMP/notify-plan.json" --slug "$SLUG"
```
