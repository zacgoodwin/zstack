---
name: z-loop
description: |
  Drain-and-exit orchestrator for the zstack develop stage (PROCESS.md): runs a
  planning pass over Ready tickets, batch-commits the workable ones to Building,
  then drives up to maxLanes concurrent worktree lanes through four fresh-agent
  stages (builder, QA, adversarial reviewer, merge) until the batch is drained
  (every ticket Done, Questions, Blocked, or Skipped), writes a run report, and
  exits. No daemon. Every scheduling, transition, watchdog, and merge-order
  decision is computed by lib/loop.ts / lib/lanes.ts / lib/stage-prompts.ts --
  never in prose. Use when asked to "run the loop", "z-loop", "work the board",
  or "drain the Ready queue" on a repo /z-setup has configured.
---

# /z-loop — Drain the batch: build → QA → review → merge, then exit

You are the ORCHESTRATOR. You never do product work, never patch a worker's
output, never hold a ticket's context yourself. Your whole job is a loop of
three moves: ask the state machine what to do next, perform that action's side
effects (z-board, git, one fresh agent spawn), record the result back into the
state file. The deterministic core decides; you execute (PRINCIPLES.md, latent
vs deterministic).

**Global rules (PROCESS.md, non-negotiable):**

- **No token burn.** Nothing may sit stuck. Every ticket ends this run in
  Done, Questions, Blocked, or Skipped — the state machine guarantees a path
  to one of them; your job is to keep feeding it.
- **One fresh agent per stage.** Every stage is a NEW harness Agent spawn built
  from a pure prompt constructor. Never reuse or SendMessage a previous stage's
  agent; nothing latent travels between stages (gate-tested: the constructors
  are pure and the lane state carries no conversation id).
- **Never re-derive a decision in prose.** Which ticket next, lane caps,
  watchdog expiry, QA bounce counts, merge order: always `loop.ts next`. If you
  are about to reason out a scheduling choice, stop and run the CLI instead.
- Every board write goes through `z-board`; every dollar through `z-cost` /
  `z-estimate`; every ticket-body gate through `z-ticket-lint`.

Resolve the pack directory once (the skill and bins are installed together):

```bash
PACK="$HOME/.claude/skills/zstack"
[ -d "$PACK" ] || PACK="$(cd "$(dirname "${BASH_SOURCE:-$0}")/.." && pwd -P)"
Z_BOARD="$PACK/bin/z-board"; Z_COST="$PACK/bin/z-cost"
Z_ESTIMATE="$PACK/bin/z-estimate"; Z_LINT="$PACK/bin/z-ticket-lint"
SLUG=$(gh repo view --json name -q .name)
BASE=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
ME=$(gh api user -q .login)
SESSION="$ME-$(date +%s)"   # names this loop in the lock (second-invocation refusal)
STATE_DIR="$HOME/.zstack/projects/$SLUG/loop"
STATE="$STATE_DIR/state.json"; TMP="$STATE_DIR/tmp"
LOCKS="$HOME/.zstack/projects/$SLUG/locks"
mkdir -p "$TMP" "$STATE_DIR/transcripts" "$HOME/.zstack/projects/$SLUG/reports" "$LOCKS"
```

---

## Step 0 — Preconditions (stop on any failure)

1. **Board configured:** `bun "$PACK/lib/board.ts" quota --slug "$SLUG" >/dev/null`
   succeeds. If not, run /z-setup first.
2. **gh authenticated** with the project scope (`gh auth status` clean).
3. **bun present:** `command -v bun`.
4. Read the loop knobs from config (defaults 3 lanes / 10 minutes):

```bash
read -r MAX_LANES WATCHDOG <<<"$(bun -e "import {loadConfig} from '$PACK/lib/config.ts';
  const c = loadConfig('$SLUG'); console.log(c.maxLanes, c.watchdogMinutes)")"
```

5. **Startup orphan scan (C7).** A crashed prior loop leaves lane locks in
   `$LOCKS` and worktrees in `.worktrees/`; a still-running loop holds
   `loop.lock`. Refuse to start on either unless the human passed `--reconcile`
   (see the `--reconcile` section below for the full contract):

```bash
# a) Second-invocation guard: refuse if another loop is live, naming its session.
#    A crashed loop leaves a STALE lock; --reconcile clears it (a LIVE lock never
#    clears -- you cannot reconcile over a running loop).
bun "$PACK/lib/locks.ts" acquire --slug "$SLUG" --session "$SESSION" ${RECONCILE:+--reconcile} \
  || exit 1   # the CLI already printed which session holds it and what to do

# b) Orphan scan: refuse if orphans exist and --reconcile was not passed.
HAS_ORPHANS=$(bun "$PACK/lib/reconcile.ts" scan --slug "$SLUG" | jq -r .hasOrphans)
if [ "$HAS_ORPHANS" = "true" ] && [ -z "$RECONCILE" ]; then
  echo "Orphans present (crashed lanes / stray worktrees / Building tickets with no state)."
  echo "Re-run /z-loop with --reconcile to release claims, park them to Ready, and prune."
  bun "$PACK/lib/locks.ts" release --slug "$SLUG"   # don't hold the lock while refusing
  exit 1
fi
[ -n "$RECONCILE" ] && bun "$PACK/lib/reconcile.ts" apply --slug "$SLUG"
```

Set `RECONCILE=1` when the human invoked `/z-loop --reconcile`; leave it empty
otherwise.

---

## Step 1 — Planning pass (PROCESS.md steps 1–4)

For every ticket in Ready (`"$Z_BOARD" list --status Ready --json --slug "$SLUG"`):

1. Fetch the body: `gh issue view <N> --json body -q .body > "$TMP/body-<N>.md"`.
2. **Gate it:** `"$Z_LINT" "$TMP/body-<N>.md"`. On failure the plan is missing
   or invalid: ground yourself in the actual code (open the files the ticket
   touches), draft the body to the C5 schema (z-plan/SKILL.md Step 4 — Context,
   Plan with real file refs, `### Acceptance Criteria` as setup → action →
   expected outcome, Tests + evals, Docs pages touched, Out of scope), update
   the body with `gh issue edit <N> --body-file ...`, re-run the gate, and
   comment that the loop's planning pass added the plan.
3. **Human needed?** A genuine ambiguity, contradiction, or missing decision
   (Confusion Protocol bar): `"$Z_BOARD" comment <N> --body-file question.md`
   then `"$Z_BOARD" move <N> Questions`. Never guess it into the plan.
4. **Estimate absent?** `"$Z_BOARD" field-get <N> Estimate` empty → set Model +
   Model Effort if missing (ESTIMATION.md rules of thumb), then the z-plan
   Step 6 tier chain: copy the `<model>-<effort>` tier verbatim from
   `$PACK/z-plan/tiers.json` into a buckets file, `"$Z_ESTIMATE"` it, and
   `field-set` the result. No arithmetic in prose.

## Step 2 — Batch commit (PROCESS.md step 7)

Move EVERY Ready ticket that passed Step 1 (body gated, no open questions) to
Building, all at once, before any lane starts — the board shows the full
committed queue:

```bash
"$Z_BOARD" move <N> Building --slug "$SLUG"   # once per workable ticket
```

## Step 3 — Build the state file

Snapshot the whole board plus bodies (deps parse from `Depends on:` lines):

```bash
for S in Backlog Ready Questions Building QA Review Blocked Skipped Done; do
  "$Z_BOARD" list --status "$S" --json --slug "$SLUG" > "$TMP/items-$S.json"
done
jq -s 'add' "$TMP"/items-*.json > "$TMP/items.json"
jq -r '.[].number' "$TMP/items.json" | while read -r N; do
  gh issue view "$N" --json body -q .body > "$TMP/body-$N.md"
done
bun -e "import {readFileSync, readdirSync, writeFileSync} from 'node:fs';
  const b = {}; for (const f of readdirSync('$TMP')) {
    const m = f.match(/^body-(\d+)\.md\$/); if (m) b[m[1]] = readFileSync('$TMP/' + f, 'utf8'); }
  writeFileSync('$TMP/bodies.json', JSON.stringify(b));"
bun "$PACK/lib/loop.ts" ingest "$STATE" "$TMP/items.json" "$TMP/bodies.json" \
  --max-lanes "$MAX_LANES" --watchdog-minutes "$WATCHDOG"
```

`ingest` preserves lanes and lost-claim flags across re-ingests, so re-running
it after board writes is always safe.

## Step 4 — The drain loop

Repeat until `next` returns `drain-complete`:

```bash
bun "$PACK/lib/loop.ts" next "$STATE"    # prints ONE Action as JSON
```

Perform exactly that action, then record it. Action → side effects:

| Action | What you do |
|---|---|
| `claim N` | 1. `"$Z_BOARD" claim <N> "$ME"` **before anything else**. Claim lost → `bun "$PACK/lib/loop.ts" claim-lost "$STATE" <N>` and re-run `next` (next ticket). 2. **Write the lane lock ONLY after the claim succeeds** (C7 — a claim loser never leaves a lock): `bun "$PACK/lib/locks.ts" lane-write --slug "$SLUG" <N> <stage> --session "$SESSION"`. 3. Worktree (skip if it exists — a resume claim at stage qa/reviewer reuses it): `TSLUG=$(bun -e "import {slugifyTitle} from '$PACK/lib/ticket-schema.ts'; console.log(slugifyTitle(process.argv[1]))" "<title>")` then `git worktree add ".worktrees/ticket-<N>" -b "z/ticket-<N>-$TSLUG" "$BASE"`. 4. Apply: write the action JSON to a file, `bun "$PACK/lib/loop.ts" apply "$STATE" action.json`. 5. Spawn the action's stage (table below). |
| `advance N to S` | **Re-stamp the lane lock** to the new stage: `bun "$PACK/lib/locks.ts" lane-write --slug "$SLUG" <N> <S> --session "$SESSION"`. Apply, then spawn stage S fresh. Before applying, read the lane's CURRENT stage from the state file: an advance to `builder` from `qa` passes the action's `note` as `qaNotes` (+ `investigateFirst`); from `reviewer`, as `reviewNotes`. |
| `park N Questions` | Comment the note as `## Needs input --` + the question, `"$Z_BOARD" move <N> Questions`, apply, then **remove the lane lock** (`bun "$PACK/lib/locks.ts" lane-remove --slug "$SLUG" <N>`). Tell the human in the comment which status to return the ticket to. Keep the worktree. |
| `park N Blocked` | Comment the note (what was wrong + recommended next steps), `move <N> Blocked`, apply, remove the lane lock. |
| `skip N` | Comment the note (the confusion or the dead-worker evidence), `move <N> Skipped`, apply, remove the lane lock. (PROCESS.md global rule.) |
| `stop-lane N` | A human moved #N to a stop status (Blocked/Questions/Skipped/Done) mid-run; the board already reflects it — do NOT move or comment it. Tear down the lane's background agent, remove the lane lock (`lane-remove`), keep the worktree for inspection, and apply (drops the lane, leaves the human's status). Other lanes are unaffected. |
| `check-worker N` | Is the lane's background agent still running (harness task list)? Alive → `bun "$PACK/lib/loop.ts" probe "$STATE" <N> alive`. Dead with no final message → `probe "$STATE" <N> dead` (the next `next` returns the skip). |
| `complete N` | The completion flow — Step 6 — then apply, then **remove the lane lock**. |
| `wait` | Block until a background stage agent finishes (the harness notifies you) or one minute passes, then re-run `next` — the watchdog only fires if `next` is called with a fresh clock. When an agent finishes: save its final message to a file and `bun "$PACK/lib/loop.ts" outcome "$STATE" <N> msg.txt`, then update Actual (below), then re-run `next`. |
| `drain-complete` | Step 7. |

**Spawning a stage** (all four the same way):

1. Assemble the stage's typed input JSON (table below) into `"$TMP/input-<N>.json"`.
2. `bun "$PACK/lib/stage-prompts.ts" prompt <stage> "$TMP/input-<N>.json" > "$TMP/prompt-<N>.txt"`
   — the constructor is the contract; if it exits non-zero the input is wrong,
   fix the input, never hand-write the prompt.
3. Spawn a FRESH harness Agent (Agent tool), `run_in_background: true`, with
   that prompt and `model` = the ticket's Model field
   (`"$Z_BOARD" field-get <N> Model`; the Model Effort field selected the
   estimate tier — the Agent call has no per-spawn effort knob, a known
   ceiling).

| Stage | Input JSON fields |
|---|---|
| `builder` | `ticketNumber`, `ticketTitle`, `ticketBody` (fresh `gh issue view`), `worktreePath` (`.worktrees/ticket-<N>`), `branch`, `baseBranch`; on a bounce also `qaNotes`/`investigateFirst` or `reviewNotes` per the advance row above. |
| `qa` | `ticketNumber`, `ticketBody`, `worktreePath`, `branch`, `qaPass` (the lane's `qaBounces` in the state file + 1), `webTarget` (true when the ticket changes a web-served surface — your judgment; QA then drives gstack /qa). |
| `reviewer` | **BLINDED — exactly** `ticketBody`, `acceptanceCriteria` (the `### Acceptance Criteria` section: `awk '/^### Acceptance Criteria/{f=1;next} /^#/{f=0} f' body.md`), `diff` (`git -C .worktrees/ticket-<N> diff "$BASE"...HEAD`), `worktreePath` = a THROWAWAY worktree of the head commit (`git worktree add "$TMP/review-<N>" <head-sha>`; remove it after the stage). No PR description, no plan rationale, no transcripts — the constructor rejects any other key set. |
| `merge` | `ticketNumber`, `prTitle` (the ticket title), `branch`, `baseBranch`, `worktreePath`, `stackedOn` (from the advance action — parents whose branches this PR stacks on; the prompt carries the PROCESS.md step 18 chain rules: parents first, no branch deletion mid-batch, retarget, delete last). |

**Per-stage Actual (every stage, no exceptions):** when a stage agent finishes,
copy its transcript jsonl into `"$STATE_DIR/transcripts/ticket-<N>/"` (the
harness writes session transcripts under `~/.claude/projects/`; take the file
for that spawn). Then price the ticket's whole directory — the glob accumulates
every stage so far, and z-cost dedupes by requestId, so its total IS the
cumulative and you never add dollars in prose:

```bash
"$Z_COST" "$STATE_DIR/transcripts/ticket-<N>/*.jsonl"     # -> "$X.XX total ..."
"$Z_BOARD" field-set <N> Actual <that X.XX> --slug "$SLUG"
```

## Step 5 — Watchdog (PROCESS.md global rule)

The expiry decision is inside `next` (silent past `watchdogMinutes` →
`check-worker`; probe recorded dead → `skip`). Your only duties: keep calling
`next` at least once a minute while waiting, answer `check-worker` honestly
from the harness's task list, and never let a lane idle unprobed. A stage that
returns a `CONFUSED:` final message routes to `skip` automatically — comment
its confusion note into the ticket when you execute the skip.

## Step 6 — Completion (PROCESS.md steps 19–21), on `complete N`

1. Final Actual update (Step 4 flow), then read it back:
   `ACTUAL=$("$Z_BOARD" field-get <N> Actual)`.
2. **File every surfaced use case** that needs a human decision (a gap, an
   out-of-scope affordance, a limitation a user will hit — from the builder/QA/
   review final messages): body through `"$Z_LINT"`, then
   `"$Z_BOARD" create --title ... --body-file ... --milestone <the ticket's milestone>`,
   `"$Z_BOARD" move <new> Backlog`, and `"$Z_BOARD" link` it to related
   tickets. Never silently drop one.
3. Build the note deterministically and post it:

```bash
bun "$PACK/lib/stage-prompts.ts" note "$TMP/note-<N>.json" > "$TMP/note-<N>.md"
"$Z_BOARD" comment <N> --body-file "$TMP/note-<N>.md" --slug "$SLUG"
```

   `note-<N>.json` (CompletionNoteInput): `shipped` (behavior + key files),
   `prUrl` (the merge outcome's note), `acceptancePassed` (the AC cases QA and
   review verified, as written), `edges` (every intended-but-surprising,
   data-loss-ish, spec-ambiguous, or default-chosen behavior, each as
   `{check, doStep, expect}` so the template renders "to check X, do Y,
   expect Z"), `filedTickets` (from 2), `actualDollars` = `$ACTUAL`.
4. `"$Z_BOARD" move <N> Done` and apply the action. The issue stays OPEN — a
   human reviews Done tickets and closes them (never `gh issue close`).
5. `git worktree remove ".worktrees/ticket-<N>"`. Do NOT delete the branch yet
   — a dependent PR may stack on it (branch cleanup is Step 7).

## Step 7 — Exit (on `drain-complete`)

1. **Batch cleanup:** every dependent PR has landed, so delete the merged
   `z/ticket-*` branches now (PROCESS.md step 18: delete last), and remove any
   leftover throwaway review worktrees.
2. **End-of-loop handoff:** run the End-of-Loop section — C8 (full regression
   on the merged base; every 5th loop, the security audit). C8 lands next;
   until it exists, write "end-of-loop stage pending (C8)" in the report and
   continue.
3. **Report:** write `~/.zstack/projects/$SLUG/reports/loop-$(date +%Y%m%d-%H%M%S).md`:
   a per-ticket table (number, title, final status, PR, Actual), each parked
   Questions ticket with its question, each Blocked/Skipped ticket with its
   note, tickets left to other sessions (lost claims), total spend
   (`"$Z_COST" "$STATE_DIR/transcripts/*/*.jsonl"`), and the C8 handoff line.
4. **Release the loop lock** so the next invocation can start:
   `bun "$PACK/lib/locks.ts" release --slug "$SLUG"`. (Do this even on an early
   exit — wrap the run so a crash is the only way the lock survives, which is
   exactly what the next run's orphan scan is for.)
5. **Exit.** No daemon, no polling for new work. The next batch is the next
   /z-loop invocation.

---

## `--reconcile` and the safety locks (C7, issue #2)

Two lock kinds live under `$LOCKS` (`~/.zstack/projects/<slug>/locks/`):

- **Lane locks** `ticket-<N>.json` `{ticket, stage, session, claimedAt}` — one per
  in-flight lane, written right after a successful claim, re-stamped on each
  stage transition, removed at lane end. They survive a crash, which is how the
  next run knows a lane was mid-flight.
- **Loop lock** `loop.lock` `{session, startedAt, pid?}` — one per project. A
  second `/z-loop` on the same project reads it and **refuses to start, naming
  the live session**: `Refusing to start: a /z-loop is already running on this
  project in session "<session>" ...`. A crashed loop's lock is judged *stale*
  (dead pid, or older than the config `lockStalenessMinutes`) and reported as
  such rather than live.

**Startup, without `--reconcile`:** if `loop.lock` is live → refuse (name the
session). If it is stale, or any orphans exist (lane locks with no running loop,
worktrees with no lock, Building tickets with neither) → refuse and tell the
human to re-run with `--reconcile`.

**Startup, with `--reconcile`:** `bun "$PACK/lib/reconcile.ts" apply --slug "$SLUG"`
first clears the wedge, then the loop starts normally. Reconcile:

- **releases claims** — `z-board release <N>` unassigns the ticket so it can be
  re-claimed;
- **parks tickets back to Ready** — `z-board move <N> Ready`;
- **prunes worktrees** — `git worktree remove --force` (a crashed builder's
  uncommitted work is discarded; the ticket rebuilds fresh from Ready);
- **removes stale lane locks** — and clears the stale `loop.lock`.

Reconcile **never**: deletes a branch, deletes a board comment, or touches a
ticket that has a live lane. It only undoes the parts of a crashed run that a
human would otherwise have to unwind by hand.

**Mid-loop human moves (wave reconciliation).** The board is re-read (ingest)
before every stage transition, so a human who drags a Building/QA ticket to
Blocked or Questions mid-run is respected: `loop.ts next` returns `stop-lane`
for that ticket at its next stage boundary. The lane stops cleanly (agent torn
down, lock removed, worktree kept, the human's status honored) and every other
lane keeps running. This replaces super-board's 120-second tick.

---

## Done criteria

Report DONE only when all hold:

- Every ticket that was Ready or in flight at Step 3 is now Done, Questions,
  Blocked, or Skipped (or provably claimed by another session).
- Every Done ticket is still OPEN and carries a completion note with
  acceptance criteria passed, to-check-X-do-Y-expect-Z edges, filed Backlog
  tickets, and an Actual set from z-cost.
- Every Questions/Blocked/Skipped ticket carries the comment explaining why
  and what a human should do next.
- Merged branches are deleted, worktrees removed, and the loop report exists
  at the printed path.
- You made zero scheduling decisions in prose: every claim/advance/park/skip
  came from `loop.ts next`.
