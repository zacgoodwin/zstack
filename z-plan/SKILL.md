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
REPO_ROOT="$(pwd -P)"        # the TARGET project repo (this skill always runs
                             # from inside it, same dir `gh repo view` just
                             # resolved) -- distinct from $PACK, the skill's own
                             # install dir. Step 4's `## Files` grounding gate
                             # checks paths against this root.
```

---

## Step 0 — Preconditions (stop on any failure)

1. **Board configured.** `bun "$PACK/lib/board.ts" quota --slug "$SLUG" >/dev/null`
   must succeed. If it fails, /z-setup has not run for this repo — stop and run it.
2. **gh authenticated with project scope.** `gh auth status` clean (same probe as
   /z-setup Step 1). Stop and fix before continuing.
3. **bun present.** `command -v bun`.

---

## Step 1 — Resolve the input spec(s), and the `--backlog` / `--ticket` / `--dry-run` / `--reestimate` flags

Four flags are recognized ahead of any spec path arguments; parse them first
and collect every remaining non-flag argument into an ordered list,
first-is-primary (below). `--ticket` takes a value (the issue number), so it
consumes the next argument rather than standing alone like the others:

```bash
BACKLOG_ONLY=""
TICKET_ONLY=""
DRY_RUN=""
REESTIMATE_ONLY=""
SPECS=()
WANT_TICKET=""
for arg in "$@"; do
  if [ -n "$WANT_TICKET" ]; then
    TICKET_ONLY="$arg"
    WANT_TICKET=""
    continue
  fi
  case "$arg" in
    --backlog) BACKLOG_ONLY=1 ;;
    --ticket) WANT_TICKET=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --reestimate) REESTIMATE_ONLY=1 ;;
    *) SPECS+=("$arg") ;;
  esac
done
[ -z "$WANT_TICKET" ] || { echo "z-plan: --ticket requires a value (the issue number)." >&2; exit 1; }
```

**When `--backlog` or `--ticket <N>` is set:** skip straight to Step 10 — no
spec resolution, and no "No spec file found" failure (AC4). Steps 2–9 do not
run; `--dry-run` still applies (Dry-run / eval mode below).

**When `--reestimate` is set:** skip straight to the reestimate scan (Step
12) — no spec resolution, and no "No spec file found" failure, the same
bypass `--backlog` gets. It is a mode of its own: it does **not** run Steps
2–9, and it does **not** run Step 10's Backlog gate (that lint/draft/split
pass is `--backlog`'s job, not this one); `--dry-run` still applies (Dry-run
/ eval mode below).

**`--ticket <N>` (issue #78)** is the single-ticket form of `--backlog`'s
scoping: it implies the same bypass above, but scopes Step 10's loop to
exactly ticket `N` instead of the whole Backlog list — every other Step 10
behavior (the lint gate, the fields, the split gates, the idempotent
zero-write rerun, never promoting to Ready) is identical between the two
forms. `--backlog` with no `--ticket` still scans the whole Backlog list, any
status. To find `N`, fetch the whole board once — no `--status` filter, since
`N` can be sitting in any status — and select the entry whose number equals
`N`.

Zero matches (no ticket `N` on the board) or a `Status` of `Done` are both
errors, not a silent skip: fail loud naming `N` and exit 1 with no board
writes ("z-plan: no ticket #N found on the board." / "z-plan: ticket #N is
Done; nothing to plan." — Step 10 never re-plans a Done ticket). Any other
status runs Step 10 exactly as written, scoped to that one item instead of
the Backlog list (Step 10's own list step below shows the branch):

```bash
if [ -n "$TICKET_ONLY" ]; then
  TICKET_MATCH_JSON=$("$Z_BOARD" list --json --slug "$SLUG" | bun -e '
    const items = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const n = Number(process.argv[1]);
    const m = items.filter((i) => i.number === n);
    if (m.length === 0) { console.error(`z-plan: no ticket #${n} found on the board.`); process.exit(1); }
    if (m[0].fields.Status === "Done") { console.error(`z-plan: ticket #${n} is Done; nothing to plan.`); process.exit(1); }
    console.log(JSON.stringify(m));
  ' "$TICKET_ONLY") || exit 1
fi
```

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
- `## Files` — optional; one top-level bullet per file the grounding pass
  (Step 2) discovered, each a path like `lib/board.ts` in the bullet's FIRST
  backticked span followed by a one-clause role (anything else in the bullet
  is prose). This is the map the builder/QA/reviewer stages reuse instead of
  re-discovering the same files with fresh glob/grep in every stage spawn — pay
  the discovery cost once, here. A file this ticket will CREATE (does not
  exist yet) gets its bullet suffixed literally `(new)`, exempting it from the
  existence gate below.
- `Depends on: #A, #B` — optional line; omit it when the ticket has no
  dependencies. When present it names the issues this ticket waits on.

Gate every body before it touches the board — this is deterministic, so run the
script, never eyeball it. Always pass `--check-paths` with the repo root so a
hallucinated or stale `## Files` path fails here, at plan time, not at build
time in a fresh worktree:

```bash
"$Z_LINT" /path/to/ticket-body.md --check-paths "$REPO_ROOT"   # exit 0 = valid; exit 1 prints each gap on stderr
```

Do not file a ticket whose body does not pass `z-ticket-lint`. The gate is the
same one the loop's planning pass runs, so "all mandatory sections present"
means one thing everywhere.

**Plan-time edges → a `## Needs input —` comment.** Once the body passes the
lint gate, name every chosen default, spec-ambiguous call, or data-loss-ish
behavior the PLAN itself introduces — PROCESS.md step 6's plan-time
counterpart to step 20's completion-note edges — as a `{check, doStep,
expect}` `CompletionEdge`. When that list is non-empty, render it with
`planEdgesComment` (`lib/stage-prompts.ts`, reusing the `CompletionEdge` shape)
and post it at the bottom of the plan comment. Informational only: the ticket
stays exactly where it already is — this never moves it to Questions, that is
Step 8's job for a genuine blocking question, not a plan-time edge.

```bash
bun "$PACK/lib/stage-prompts.ts" plan-edges "$TMP/edges-<N>.json" > "$TMP/edges-<N>.md"
[ -s "$TMP/edges-<N>.md" ] && "$Z_BOARD" comment <N> --body-file "$TMP/edges-<N>.md" --slug "$SLUG"
```

`edges-<N>.json` is a `CompletionEdge[]` array. An empty list renders `""`
(the CLI prints nothing), so `[ -s ... ]` skips the comment entirely — a plan
that introduced no edges posts nothing.

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
   | `haiku-low`   | haiku  | low    | 30%    | $1.86    |
   | `sonnet-medium` | sonnet | medium | 30%  | $10.27   |
   | `opus-high`   | opus   | high   | 30%    | $9.44    |
   | `opus-xhigh`  | opus   | xhigh  | 30%    | $15.77   |
   | `fable-xhigh` | fable  | xhigh  | 50%    | $45.22   |

   Calibrated 2026-07-20 (issue #81) from measured loop-run actuals — the
   buckets behind these totals are per-tier medians from real ticket
   transcripts (`z-plan/tiers.json`'s `_comment` has the derivation recipe),
   not the directional guesses the tiers started from.

2. Copy that tier's entry verbatim into a `buckets.json` and shell it to
   `z-estimate`. You produce the bucket **counts** by tier lookup (no
   arithmetic); `z-estimate` does the only arithmetic (buckets × rates + buffer):

   ```bash
   bun -e "require('fs').writeFileSync('/tmp/bk.json',
     JSON.stringify(require('$TIERS').tiers['opus-xhigh']))"
   "$Z_ESTIMATE" /tmp/bk.json          # -> $15.77 (subtotal $12.13, buffer 30%, model opus)
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
"$Z_BOARD" field-set <N> Estimate 15.77       --slug "$SLUG"
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

**Fold-in gate (PROCESS.md step 6).** Applies every time this skill touches a
ticket that may already carry human comments — Step 9's idempotent re-plan and
Step 10's Backlog scan, not just a first pass. Before drafting or updating a
body, read its comments and find the newest one authored by someone other than
this session's own login (`gh api user -q .login`, the board's known
bot/session identity — the only distinction this gate draws; no further
human-vs-bot detection):

```bash
gh issue view <N> --json comments -q '.comments'
```

If that comment postdates the plan already on the ticket, fold in its
suggestion and rebuild the plan if it changed. **If it raises a NEW question
the plan doesn't already answer, do not start:** post it as a `## Needs input
—` comment and move the ticket to Questions, exactly like the block above —
never guess it into the plan.

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
file needed either way, AC4), or scoped to one ticket via `/z-plan --ticket <N>`
(issue #78, Step 1).

```bash
TMP="$HOME/.zstack/projects/$SLUG/z-plan/tmp"; mkdir -p "$TMP"
if [ -n "$TICKET_ONLY" ]; then
  # --ticket <N>: this scan is scoped to exactly the one ticket Step 1 already
  # found and validated (exists, not Done) -- no other Backlog ticket is read
  # or written this run.
  echo "$TICKET_MATCH_JSON" > "$TMP/backlog.json"   # the single-element array Step 1 built
else
  "$Z_BOARD" list --status Backlog --json --slug "$SLUG" > "$TMP/backlog.json"
fi
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
     applies here too — no file ref you have not opened) and draft the body to
     the Step 4 schema. Before filing it, evaluate splitting with BOTH gates
     against this draft (issue #78) — `needsSplit(F, S)` (Step 5's context
     gate: F = distinct files the plan reads/modifies, S = ordered `## Plan`
     steps) and `shouldSplitForCost(parentTier, childTiers)`
     (`lib/ticket-schema.ts` — `parentTier` is the Model/Effort tier this
     single-ticket draft would carry per Step 6's rules of thumb; `childTiers`
     is the tier each ticket in a proposed decomposition would carry; it
     splits only when the children's Estimate sum is strictly below the
     parent's):
     - **Neither gate trips:** update the ticket with
       `gh issue edit <N> --body-file ...`, re-run `"$Z_LINT"` on the
       rewritten body to confirm it now passes, and comment that the scan
       added the plan (`"$Z_BOARD" comment <N> --body-file note.md --slug
       "$SLUG"`; one line: the scan added the plan above, the ticket is still
       in Backlog for a human to promote).
     - **Either gate trips:** break the draft into the subtasks the gate
       implies — the same convention Step 5 uses for spec-derived tickets:
       each child falls under `needsSplit`'s thresholds, and when the cost
       gate tripped, each carries a tier `shouldSplitForCost` confirmed is
       cheaper in total than the parent's. File each child to the Step 4
       schema (gated by `"$Z_LINT"`, fielded per Step 6, same as any other
       ticket this step files). Link parent<->child both directions (Step 7).
       Write a `## Subtasks (in order)` list (Step 5's convention) into the
       PARENT's body alongside its own Step 4 sections
       (`gh issue edit <N> --body-file ...`), then comment on the parent that
       it should be closed by a human once every child lands (`"$Z_BOARD"
       comment <N> --body-file close-me.md --slug "$SLUG"`). Never call a
       close on the parent, never move it, and never promote the parent or
       any child to Ready — item 6 below applies to every ticket a split
       touches, parent and children alike.
4. **Fields:** before fielding, check the ticket's CURRENT body for a
   `## Subtasks (in order)` heading — whichever body is current right now:
   the one item 3's either-gate-trips path just filed this iteration, or
   (when that path did not run this iteration) the body item 1 fetched into
   `$TMP/body-<N>.md`. This is a durable signal independent of iteration: a
   parent split on a PRIOR Step 10 pass still carries the heading (it still
   passes `$Z_LINT`'s section-presence check, so item 3 never re-runs the
   split branch on it), so a second pass over an already-split parent sees
   the heading too, not only the run that wrote it. If the heading is
   present, this ticket is a split parent: skip the rest of this step for it
   unconditionally — Step 5's convention holds here too: it carries no Estimate of its
   own beyond the sum its children report; item 4 fields only the children,
   each through Step 6's tier chain, when filing them. Otherwise, read Model,
   Model Effort, and Estimate (`"$Z_BOARD" field-get <N> <Field> --slug
   "$SLUG"`, once each). If ANY is empty, choose Model +
   Model Effort per Step 6's rules of thumb and run the full Step 6 tier
   chain (`z-plan/tiers.json` → `"$Z_ESTIMATE"`) to `field-set` all three —
   no arithmetic in prose, same rule as Step 6.
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

- total batch estimate is $74.98 across 5 tickets.
- #105 ("...") is fable-xhigh ($45.22) — confirm the tier is warranted or
  split it.
- lib/config.ts is touched by 3 tickets (#103, #104, #105) — sequencing them
  reduces re-review churn.
- #101, #102 are haiku-low mechanical work — batch them in one lane.

---

## Step 12 — Reestimate scan (`--reestimate`)

`/z-plan --reestimate` (Step 1's flag parsing) re-runs Step 6's tier chain
over EVERY Backlog and EVERY Ready ticket from what is currently in its
body — even one that already carries an Estimate. Where Step 10 item 4 only
re-fields a ticket when Model, Model Effort, or Estimate is EMPTY, this step
never skips on that ground: a number already on the board can be stale (the
body's scope changed under a human's edit, or `z-plan/tiers.json` was
recalibrated, issue #81), and this is the deliberate pass that catches it.
It never runs as part of a normal spec run, `--backlog`, or `--ticket <N>` —
only `/z-plan --reestimate` triggers it (Step 1's bypass), and it does not
run Step 10's lint/draft/split gate.

```bash
TMP="$HOME/.zstack/projects/$SLUG/z-plan/tmp"; mkdir -p "$TMP"
"$Z_BOARD" list --status Backlog --json --slug "$SLUG" > "$TMP/reest-backlog.json"
"$Z_BOARD" list --status Ready --json --slug "$SLUG" > "$TMP/reest-ready.json"
```

Every other status (Building/QA/Review/Blocked/Skipped/Done) is left
untouched — this step reads and writes nothing outside Backlog + Ready.

For each ticket number `<N>` in the combined Backlog + Ready list:

1. **Fetch the current body:** `gh issue view <N> --json body -q .body > "$TMP/body-<N>.md"`
   (the same read Step 10 item 1 uses).
2. **Skip split parents.** If that body carries a `## Subtasks (in order)`
   heading, this ticket is a split parent and carries no Estimate of its own
   (Step 10 item 4's durable signal) — skip it: no estimate, no field-set, no
   comment.
3. **Re-estimate unconditionally.** Ground in the body and the code it names
   (Step 2 applies — no file ref not opened) and pick Model + Model Effort
   from what the body says NOW, per Step 6's rules of thumb — that choice is
   the tier. Run Step 6's chain unchanged (copy `z-plan/tiers.json`'s entry
   for that tier into a `buckets.json`, shell `"$Z_ESTIMATE"`) to get the new
   dollar total. **This runs even when the ticket already has an Estimate** —
   unlike Step 10 item 4, which only re-fields a ticket when a field is
   empty, this step never skips on that ground.
4. **Compare and write.** Read the current fields once each:
   `"$Z_BOARD" field-get <N> Estimate --slug "$SLUG"`,
   `"$Z_BOARD" field-get <N> Model --slug "$SLUG"`,
   `"$Z_BOARD" field-get <N> "Model Effort" --slug "$SLUG"`. Compare the new
   total against the stored Estimate as a to-the-cent numeric comparison —
   the new number comes straight off `z-estimate`'s `$X (subtotal …, model
   …)` output line, no arithmetic in prose:
   - **Equal:** write nothing — no field-set, no comment. Same body + same
     tier → same dollars, so a second `--reestimate` over an unchanged board
     is a no-op (idempotent, reproducible).
   - **Different, and a prior Estimate was present:** `field-set` Estimate to
     the new number (`"$Z_BOARD" field-set <N> Estimate <new> --slug
     "$SLUG"`). If the newly picked tier differs from the stored Model +
     Model Effort, `field-set` those two as well, so the fields keep
     selecting the number they price (Step 6 writes all three together).
     Then post exactly one board comment naming the change and its cause
     (`"$Z_BOARD" comment <N> --body-file ... --slug "$SLUG"`):
     - tier changed → `Estimate $OLD → $NEW: recommended tier changed
       <oldtier> → <newtier> (scope grew per the current body).` when the new
       total is higher than the old, or `(scope shrank per the current
       body).` when it is lower.
     - tier unchanged → `Estimate $OLD → $NEW: recalibration (same <tier>
       tier; z-plan/tiers.json buckets or references/rates.json updated
       since the last estimate).`
   - **Different, but no prior Estimate** (the field was empty): `field-set`
     all three fields, exactly like Step 10 item 4's empty-field path, but
     post **no** "changed" comment — the comment fires only when an estimate
     was already present and the number differs.
5. **Never promote, never re-draft.** Like Step 10 item 6, this step never
   moves a ticket to Ready and never edits a body — Status is unchanged and
   the body is unchanged; it only writes the three number/tier fields and,
   at most, one comment.

**Terminal summary.** End the run with a short line naming how many tickets
were re-estimated and how many changed — the old → new figures are already
in hand, so nothing new is computed. This step does **not** invoke Step 11's
`z-cost-suggest` helper: that needs the per-ticket file lists Step 5 builds,
which a pure re-estimate pass never assembles.

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

**`--dry-run --ticket <N>`** (issue #78) composes the same way: identical to
`--dry-run --backlog` above, scoped to exactly ticket `N` per `--ticket`'s
Step 1/Step 10 contract — the same lookup-and-validate (exists, not Done)
runs before anything is emitted; a missing or Done `N` still fails loud with
no output, dry run or not.

**`--dry-run --reestimate`** (issue #134) composes like `--dry-run --backlog`:
decide per ticket exactly as Step 12 describes, but instead of `field-set` or
`comment`, emit each ticket whose estimate would change to stdout as one
block — its number, `$OLD → $NEW`, and the why line. No board writes, no
GitHub writes.

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
  Effort, and Estimate (Step 10) — except a split parent, which fields only
  its children (next item). This step never promotes a ticket to Ready —
  the only path anywhere in this skill that ever moves a Backlog ticket to
  Ready remains Step 7.4's dependency pull.
- A ticket Step 10 split on either gate (`needsSplit` or `shouldSplitForCost`,
  issue #78) carries a `## Subtasks (in order)` list and both-direction links
  to its filed children; the parent stays OPEN and un-promoted — never
  auto-closed, never moved to Ready — with a comment that a human should
  close it once every child lands.
- `/z-plan --reestimate` (issue #134) re-runs Step 6's tier chain over every
  Backlog and Ready ticket, even one that already carries an Estimate; a
  changed number is written and commented (old → new, and why), an unchanged
  one writes nothing, a split parent is skipped, and it never promotes a
  ticket or edits its body (Step 12).

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
