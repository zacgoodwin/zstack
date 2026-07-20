---
name: z-loop
description: |
  Drain-and-exit orchestrator for the zstack develop stage (PROCESS.md): runs a
  planning pass over Ready tickets, batch-commits the workable ones to Building,
  then drives up to maxLanes concurrent worktree lanes through four fresh-agent
  stages (builder, QA, adversarial reviewer, merge) until the batch is drained
  (every ticket Done, Questions, Blocked, or Skipped), then runs an end-of-loop
  stage on the merged base -- regression first; red files bugs and stops (no
  deploy), green ships (land-and-deploy -> canary -> document-release) and,
  every Nth loop (config `auditEveryNLoops`, default 5), runs the security +
  quality audits -- writes a run report, and exits. No daemon. Every
  scheduling, transition, watchdog, merge-order, and end-of-loop decision is
  computed by lib/loop.ts / lib/lanes.ts /
  lib/stage-prompts.ts / lib/endloop.ts -- never in prose. Use when asked to
  "run the loop", "z-loop", "work the board", or "drain the Ready queue" on a
  repo /z-setup has configured.
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
export ZSTACK_SLUG="$SLUG"   # H13: every z-board / lib call resolves the slug from
                             # here, so a call that omits --slug never dies with
                             # "Multiple zstack projects" mid-drain (resolveSlug
                             # honors ZSTACK_SLUG; lib/config.ts). Keep passing
                             # --slug where already present -- explicit still wins.
BASE=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
BASE_SHA_START=$(git rev-parse "origin/$BASE" 2>/dev/null || git rev-parse "$BASE")  # C8: the e2e-detection diff base
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
4. Read the loop knobs from config (defaults 3 lanes / 10 minutes / audits
   every 5th loop / 3 QA passes before Blocked / investigate from QA bounce 2 /
   human-needed at 30% parked / reviewer-confidence floor 70, block a
   sub-floor approve / 2 reviewer->builder bounces before Blocked):

```bash
read -r MAX_LANES WATCHDOG AUDIT_EVERY_N MAX_QA_PASSES QA_INVESTIGATE_AFTER HUMAN_NEEDED_PERCENT MIN_REVIEWER_CONFIDENCE REVIEWER_BELOW_ACTION MAX_REVIEW_BOUNCES <<<"$(bun -e "import {loadConfig} from '$PACK/lib/config.ts';
  const c = loadConfig('$SLUG'); console.log(c.maxLanes, c.watchdogMinutes, c.auditEveryNLoops, c.maxQaPasses, c.qaInvestigateAfter, c.humanNeededPercent, c.minReviewerConfidence, c.reviewerBelowThresholdAction, c.maxReviewBounces)")"
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

## Step 1 — Planning pass (PROCESS.md steps 1–4, 6)

For every ticket in Ready (`"$Z_BOARD" list --status Ready --json --slug "$SLUG"`):

1. Fetch the body: `gh issue view <N> --json body -q .body > "$TMP/body-<N>.md"`.
2. **Fold-in gate (PROCESS.md step 6) — before this ticket can reach Step 2's
   batch commit.** Read its comments and find the newest one authored by
   someone other than `$ME` (the board's known bot/session login — the only
   distinction this gate draws; no further human-vs-bot detection):
   `gh issue view <N> --json comments -q '.comments' > "$TMP/comments-<N>.json"`.
   If that comment postdates whatever plan is already on the ticket, fold in
   its suggestion and rebuild the plan (step 3 below) if it changed. **If it
   raises a NEW question the plan doesn't already answer, do not start:** post
   it as a `## Needs input —` comment (`"$Z_BOARD" comment <N> --body-file
   needs-input.md`), `"$Z_BOARD" move <N> Questions`, and skip the rest of this
   loop's steps for this ticket — it never reaches Step 2's batch commit. A
   ticket with no comments newer than its own plan skips this gate with no
   writes.
3. **Gate it:** `"$Z_LINT" "$TMP/body-<N>.md"`. On failure the plan is missing
   or invalid: ground yourself in the actual code (open the files the ticket
   touches), draft the body to the C5 schema (z-plan/SKILL.md Step 4 — Context,
   Plan with real file refs, `### Acceptance Criteria` as setup → action →
   expected outcome, Tests + evals, Docs pages touched, Out of scope), update
   the body with `gh issue edit <N> --body-file ...`, re-run the gate, and
   comment that the loop's planning pass added the plan.
4. **Human needed?** A genuine ambiguity, contradiction, or missing decision
   (Confusion Protocol bar): `"$Z_BOARD" comment <N> --body-file question.md`
   then `"$Z_BOARD" move <N> Questions`. Never guess it into the plan.
5. **Estimate absent?** `"$Z_BOARD" field-get <N> Estimate` empty → set Model +
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
  --max-lanes "$MAX_LANES" --watchdog-minutes "$WATCHDOG" \
  --max-qa-passes "$MAX_QA_PASSES" --qa-investigate-after "$QA_INVESTIGATE_AFTER" \
  --human-needed-percent "$HUMAN_NEEDED_PERCENT" \
  --min-reviewer-confidence "$MIN_REVIEWER_CONFIDENCE" --reviewer-below-threshold-action "$REVIEWER_BELOW_ACTION" \
  --max-review-bounces "$MAX_REVIEW_BOUNCES"
```

This is the ONE ingest call that captures `initialReadyCount` for the batch --
Step 2 has already moved every workable Ready ticket to Building, so this is
ingest-time-zero for the safety control below.

`ingest` preserves lanes and lost-claim flags across re-ingests, so re-running
it after board writes is always safe.

## Step 4 — The drain loop

Repeat until `next` returns `drain-complete`. **Re-read the board before every
iteration** — this is what makes wave reconciliation reachable (C3 / issue #14).
One `bin/z-loop-tick` call IS that iteration: it does snapshot → ingest → `next`
and prints **only** the one-line Action JSON, so on a long drain's 100+ iterations
the repeated bash command text never re-enters your context (ticket #57, Leak 2):

```bash
ACTION=$("$PACK/bin/z-loop-tick" --slug "$SLUG" --state "$STATE" --tmp "$TMP")
```

`z-loop-tick` re-reads the board FIRST every iteration — refreshing each ticket's
status so a human's mid-loop move to Blocked/Questions/Skipped/Done is seen by
`reconcileBoardMoves` and turned into a `stop-lane` at the next boundary (skipping
this would let `next` decide off a stale snapshot and clobber the human's move,
defeating C7 safety control #6). It shells only `z-board` and `bun`, never gh:
`z-board snapshot` fetches items + bodies in one call through `lib/board.ts` (the
sole sanctioned gh caller), and its `ingest` preserves lanes + lost-claim flags
(and drops a lane whose ticket left the board mid-run, H14). Run it before EVERY
`next` — especially before any advance/park/complete, so no stage transition acts
on a board the human has since changed.

**Human-needed safety control (issue #63).** `z-loop-tick` also recomputes the
parked-tickets breakdown every iteration and fires a ONE-TIME mid-run Discord
notification (`human-needed` event) the moment `(Blocked + Skipped +
Questions) / initialReadyCount * 100` first crosses `humanNeededPercent`
(default 30, 0 disables) — the same per-call cadence as everything else in
this step, so the check never re-enters your context as a second bash block.
It marks the fire-once flag only after the send actually succeeds, so an
unconfigured project or a down webhook never wedges it — the notification
still fires once delivery is possible. See
[z-loop.md → Human-needed safety control](../docs/user-guide/z-loop.md#human-needed-safety-control)
for the full contract; nothing in this step re-derives it in prose.

Perform exactly that action, then record it. Action → side effects:

| Action | What you do |
|---|---|
| `claim N` | 1. `"$Z_BOARD" claim <N> "$ME"` **before anything else**. Claim lost → `bun "$PACK/lib/loop.ts" claim-lost "$STATE" <N>` and re-run `next` (next ticket). 2. **Write the lane lock ONLY after the claim succeeds** (C7 — a claim loser never leaves a lock): `bun "$PACK/lib/locks.ts" lane-write --slug "$SLUG" <N> <stage> --session "$SESSION"`. 3. Worktree (skip if it exists — a resume claim at stage qa/reviewer reuses it): `TSLUG=$(bun -e "import {slugifyTitle} from '$PACK/lib/ticket-schema.ts'; console.log(slugifyTitle(process.argv[1]))" "<title>")` then `git worktree add ".worktrees/ticket-<N>" -b "z/ticket-<N>-$TSLUG" "$BASE"`. 4. Apply: write the action JSON to a file, `bun "$PACK/lib/loop.ts" apply "$STATE" action.json`. 5. Spawn the action's stage (table below). |
| `advance N to S` | **Re-stamp the lane lock** to the new stage: `bun "$PACK/lib/locks.ts" lane-write --slug "$SLUG" <N> <S> --session "$SESSION"`. Apply, then spawn stage S fresh. Before applying, read the lane's CURRENT stage from the state file: an advance to `builder` from `qa` passes the action's `note` as `qaNotes` (+ `investigateFirst`); from `reviewer`, as `reviewNotes`. |
| `park N Questions` | Comment the note as `## Needs input --` + the question, `"$Z_BOARD" move <N> Questions`, apply, then **remove the lane lock** (`bun "$PACK/lib/locks.ts" lane-remove --slug "$SLUG" <N>`). Tell the human in the comment which status to return the ticket to. Keep the worktree. **Notify** `human-pause` (`{ticket,title,note}`; see the Notify block below). |
| `park N Blocked` | Comment the note (what was wrong + recommended next steps), `move <N> Blocked`, apply, remove the lane lock. **Notify** `token-burn` (`{ticket,detail:note}`) when the note begins `Dependency deadlock:` (the step-6 deadlock break); otherwise `ticket-parked` (`{ticket,title,status:"Blocked",note}`). |
| `skip N` | Comment the note (the confusion or the dead-worker evidence), `move <N> Skipped`, apply, remove the lane lock. (PROCESS.md global rule.) **Notify** `safety-violation` (`{control:"watchdog",ticket,detail:note}`) when the note begins `Worker died mid-` (a watchdog dead-worker skip); otherwise `ticket-parked` (`{ticket,title,status:"Skipped",note}`). |
| `stop-lane N` | A human moved #N to a stop status (Blocked/Questions/Skipped/Done) mid-run; the board already reflects it — do NOT move or comment it. Tear down the lane's background agent, remove the lane lock (`lane-remove`), keep the worktree for inspection, and apply (drops the lane, leaves the human's status). Other lanes are unaffected. |
| `check-worker N` | Is the lane's background agent still running (harness task list)? Alive → `bun "$PACK/lib/loop.ts" probe "$STATE" <N> alive`. Dead with no final message: **if the lane's stage is `merge`, do NOT probe-dead/skip** — verify PR state first (H9): `gh pr view <branch> --json state,url -q '.state'`. If `MERGED`, the PR landed before the worker died, so record it as merged (`printf 'MERGED: %s\n' "$prUrl" > msg.txt; bun "$PACK/lib/loop.ts" outcome "$STATE" <N> msg.txt`) → the reducer completes it and counts it in `mergedThisRun` (so a stacked child still retargets and the batch-end branch delete can't close its PR). If NOT merged, record `printf 'BLOCKED: merge worker died with the PR unmerged (%s)\n' "$state" > msg.txt; outcome ...` → parks it Blocked for a human, and **Notify** `safety-violation` (`{control:"watchdog",ticket,detail:"merge worker died with the PR unmerged"}`). For any OTHER stage, dead with no final message → `probe "$STATE" <N> dead` (the next `next` returns the skip). |
| `complete N` | The completion flow — Step 6 — then apply, then **remove the lane lock**. |
| `wait` | Block until a background stage agent finishes (the harness notifies you) or one minute passes, then re-run `next` — the watchdog only fires if `next` is called with a fresh clock. When an agent finishes: save its final message to a file and `bun "$PACK/lib/loop.ts" outcome "$STATE" <N> msg.txt`, then update Actual (below), then re-run `next`. |
| `drain-complete` | Step 7. |

**Notify (best-effort, one event per moment).** The park/skip/safety rows above
each `send` exactly ONE Discord event through the single notification edge
(`lib/notify.ts`) — build the payload JSON and post it:

```bash
jq -n --argjson t <N> --arg title "<title>" --arg note "<note>" \
  '{ticket:$t, title:$title, note:$note}' > "$TMP/notify-<N>.json"
bun "$PACK/lib/notify.ts" send <event> "$TMP/notify-<N>.json" --slug "$SLUG"   # prints sent/skipped
```

It is a **no-op** when the project has no `notifications` config
(docs/user-guide/z-loop.md) and it NEVER blocks the drain — a failed post is
logged and dropped, so the send outcome never changes what you do next; the
webhook URL is a secret and is never logged. One more moment lives outside the
table: any `z-board` call that aborts with `GraphQL quota exhausted` (quota mode
`abort`, `lib/board.ts`) → `send safety-violation`
`{control:"quota",detail:"<the error text>"}` before the loop exits.
`safety-violation` and `token-burn` are the shared hooks the sibling
safety-control tickets (#58/#59/#61/#62) and #63 emit through; this skill ships
only the transport and those two events.

**Spawning a stage** (all four the same way — the payload reaches the worker via
the input file, never through your context; ticket #57, Leak 1):

1. **Assemble the input off-context (1a).** Build `"$TMP/input-<N>.json"` by
   injecting the large fields FROM FILES with `jq --rawfile`, never by inlining
   body/diff in a command whose text you read back. The body is on disk at
   `"$TMP/body-<N>.md"` (the builder row's `gh issue view` redirect / the initial
   snapshot); redirect the reviewer's diff and acceptance-criteria slice to files
   too (see the reviewer row). Example (builder):

   ```bash
   jq -n --rawfile body "$TMP/body-<N>.md" \
     --arg title "<title>" --arg branch "<branch>" \
     '{ticketNumber: <N>, ticketTitle: $title, ticketBody: $body,
       worktreePath: ".worktrees/ticket-<N>", branch: $branch, baseBranch: "'"$BASE"'"}' \
     > "$TMP/input-<N>.json"
   ```
   The `git diff … > "$TMP/diff-<N>.txt"` redirect means the diff never enters
   your context; `--rawfile diff "$TMP/diff-<N>.txt"` injects it. The reviewer's
   `input-<N>.json` stays EXACTLY the four blinded keys `{ticketBody,
   acceptanceCriteria, diff, worktreePath}` — `input-<N>.json`'s path is a
   constructor argument, not a key, so blindness is untouched.
2. `bun "$PACK/lib/stage-prompts.ts" prompt <stage> "$TMP/input-<N>.json" > "$TMP/prompt-<N>.txt"`
   (1b) — the constructor prints a POINTER prompt: small/fixed fields inline plus
   an instruction to read `ticketBody`/`diff`/`acceptanceCriteria` from the
   ABSOLUTE path of `input-<N>.json`. `prompt-<N>.txt` stays small (payload-
   independent), so reading it to spawn the Agent is cheap. The constructor is the
   contract; if it exits non-zero the input is wrong, fix the input, never
   hand-write the prompt. The `reviewer` stage is the one exception that takes two
   extra flags (`--adversarial-mode`, `--labels`) — see its row below; they decide
   the super-truth fan-out and NEVER become input keys.
3. Spawn a FRESH harness Agent (Agent tool), `run_in_background: true`, with
   that prompt and `model` = the ticket's Model field
   (`"$Z_BOARD" field-get <N> Model`; the Model Effort field selected the
   estimate tier — the Agent call has no per-spawn effort knob, a known
   ceiling).

| Stage | Input JSON fields |
|---|---|
| `builder` | `ticketNumber`, `ticketTitle`, `ticketBody` (fresh `gh issue view` → `"$TMP/body-<N>.md"`, injected `--rawfile`), `worktreePath` (`.worktrees/ticket-<N>`), `branch`, `baseBranch`; on a bounce also `qaNotes`/`investigateFirst` or `reviewNotes` per the advance row above. |
| `qa` | `ticketNumber`, `ticketBody` (`--rawfile "$TMP/body-<N>.md"`), `worktreePath`, `branch`, `qaPass` (the lane's `qaBounces` in the state file + 1), `webTarget` (true when the ticket changes a web-served surface — your judgment; QA then drives gstack /qa). |
| `reviewer` | **BLINDED — exactly** `ticketBody` (`--rawfile "$TMP/body-<N>.md"`), `acceptanceCriteria` (the `### Acceptance Criteria` section to a file: `awk '/^### Acceptance Criteria/{f=1;next} /^#/{f=0} f' "$TMP/body-<N>.md" > "$TMP/ac-<N>.md"`, injected `--rawfile`), `diff` (`git -C .worktrees/ticket-<N> diff "$BASE"...HEAD > "$TMP/diff-<N>.txt"`, injected `--rawfile` so it never enters your context), `worktreePath` = a THROWAWAY worktree of the head commit (`git worktree add "$TMP/review-<N>" <head-sha>`; remove it after the stage). No PR description, no plan rationale, no transcripts — the constructor rejects any other key set. **Adversarial control (#59):** build this stage's prompt with two extra flags — `MODE=$("$Z_BOARD" ... )` the project's `adversarialMode` (read it from `~/.zstack/projects/$SLUG/config.json`; `loadConfig` defaults it to `non-trivial`) and `LABELS=$(gh issue view <N> --json labels -q '[.labels[].name]')` (a JSON array — labels live on the GitHub issue, NOT on the board item, so `board.list` never fetched them; get them here). Then `bun "$PACK/lib/stage-prompts.ts" prompt reviewer "$TMP/input-<N>.json" --adversarial-mode "$MODE" --labels "$LABELS" > "$TMP/prompt-<N>.txt"`. The predicate (`adversarialActive`) reads the diff's own changed-line count from the blinded input — `always`/`non-trivial`-on-a-big-or-labeled diff spawns the skeptic fan-out (and stamps a `confidence=` token onto `REVIEW-FINDINGS` too); `off`/small-unlabeled is the single pass. Either way `REVIEW-APPROVE` always carries a `confidence=` token (issue #62's safety gate reads it regardless) — see `/z-loop`'s reviewer-confidence-gate section for what a sub-floor score does. Mode + labels ride as FLAGS; the four-key input JSON is untouched. |
| `merge` | `ticketNumber`, `prTitle` (the ticket title), `branch`, `baseBranch`, `worktreePath`, `stackedOn` (from the advance action — parents whose branches this PR stacks on; the prompt carries the PROCESS.md step 18 chain rules: parents first, no branch deletion mid-batch, retarget, delete last). |

**Per-stage Actual (every stage, no exceptions):** when a stage agent finishes,
copy its transcript jsonl into `"$STATE_DIR/transcripts/ticket-<N>/"` (the
harness writes session transcripts under `~/.claude/projects/`; take the file
for that spawn). Then price the ticket's whole directory — the glob accumulates
every stage so far, and z-cost dedupes by requestId, so its total IS the
cumulative and you never add dollars in prose:

```bash
ACTUAL=$("$Z_COST" --json "$STATE_DIR/transcripts/ticket-<N>/*.jsonl" | jq -r .total)
"$Z_BOARD" field-set <N> Actual "$ACTUAL" --slug "$SLUG"
```

## Step 5 — Watchdog (PROCESS.md global rule)

The expiry decision is inside `next` (silent past `watchdogMinutes` →
`check-worker`; probe recorded dead → `skip`). Your only duties: keep calling
`next` at least once a minute while waiting, answer `check-worker` honestly
from the harness's task list, and never let a lane idle unprobed. A stage that
returns a `CONFUSED:` final message routes to `skip` automatically — comment
its confusion note into the ticket when you execute the skip.

**Merge lanes are the one exception (H9):** `next` never auto-skips a dead
`merge` lane (it returns `check-worker` instead), because `gh pr merge` may have
landed the PR before the worker died. Resolve a dead merge lane by verifying PR
state (`gh pr view`) and recording a `MERGED:` or `BLOCKED:` outcome per the
`check-worker` row — never a dead probe. Skipping a landed merge would drop it
from `mergedThisRun` and let batch-end branch deletion close a dependent PR.

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
2. **End-of-loop (PROCESS.md steps 22–23, C8):** run Step 7a below in full.
   It decides red/green from a real regression on the merged base, never
   deploys on red, walks the deploy chain in order on green, runs the Nth-loop
   audits (config `auditEveryNLoops`, default 5), and writes the loop report --
   Step 7's old "build a report" duty lives there now, not here.
3. **Release the loop lock** so the next invocation can start:
   `bun "$PACK/lib/locks.ts" release --slug "$SLUG"`. (Do this even on an early
   exit — wrap the run so a crash is the only way the lock survives, which is
   exactly what the next run's orphan scan is for.)
4. **Exit.** No daemon, no polling for new work. The next batch is the next
   /z-loop invocation.

## Step 7a — End-of-Loop: regression, deploy, canary, docs, Nth-loop audits (C8)

PROCESS.md steps 22–23 as a fixed sequence: `lib/endloop.ts` decides red/green
consequences and the audit cadence (config `auditEveryNLoops`, default 5 --
issue #18); you perform the side effects it names and never re-derive the order
in prose. Nothing here may edit `$BASE` except through `/land-and-deploy` on
the green path -- the regression pass itself (gates + `/qa-only`) is read-only
by construction.

**1. Peek the loop counter (do NOT persist yet)** — every loop counts toward the
audit cadence, red or green, and the count sizes the plan below. But the
persist happens LAST, after the report (step 6), so a crash mid-stage re-runs the
same loop id instead of drifting the audit cadence forward by one (H17):

```bash
LOOP_COUNTER_PATH="$HOME/.zstack/projects/$SLUG/loop-counter"
LOOP_COUNT=$(bun "$PACK/lib/endloop.ts" counter peek "$LOOP_COUNTER_PATH")  # read+1, no write
```

**2. Regression on merged main** (step 22). Sync the checkout to what actually
landed, then run every gate the target repo has — detected from its
`package.json`, never assumed:

```bash
git checkout "$BASE" && git pull --ff-only origin "$BASE"
SCRIPTS=$(jq -c '.scripts // {}' package.json 2>/dev/null || echo '{}')
HAS() { echo "$SCRIPTS" | jq -e --arg s "$1" 'has($s)' >/dev/null 2>&1; }
```

Run, and record pass/fail plus a one-line evidence fragment, for each gate
that EXISTS; a gate that doesn't exist gets its own "no `<name>` script" line
in the evidence — that line **is** the required detection documentation, not
an afterthought:

- `HAS typecheck` → run it.
- `HAS test` → the full suite.
- `HAS build` → the build.
- e2e, ONLY when both hold: the batch touched a web-served surface
  (`git diff "$BASE_SHA_START"..HEAD --name-only` matches
  `app/|src/|public/|pages/|components/|\.tsx$|\.jsx$|\.css$|\.html$` — your
  judgment, the same heuristic the QA stage's `webTarget` already uses) AND a
  `test:e2e` or `e2e` script exists.

Then, always, gstack `/qa-only` against the merged `$BASE` — report-only, so
this stage can never edit main. Fold any findings in as regression findings.

Assemble `"$TMP/regression.json"` (the `RegressionResult` shape): `verdict` is
`"red"` if any gate failed or `/qa-only` found anything, else `"green"`;
`evidence` is one line per gate (including the skipped-for-absence ones);
`findings` is one `{title, repro, firstSuspectFile}` per failure (a failing
test is its own finding; typecheck errors group by file; an e2e or `/qa-only`
finding names the page/flow as the repro).

```bash
PLAN=$(bun "$PACK/lib/endloop.ts" plan "$TMP/regression.json" "$LOOP_COUNT" "$AUDIT_EVERY_N")   # e.g. ["file-bugs","report"]
```

**3a. Red path** (`$PLAN` is `["file-bugs","report"]`) — every finding becomes
a Backlog bug, NO deploy Skill is ever invoked:

```bash
jq -c '.findings[]' "$TMP/regression.json" | while read -r FINDING; do
  echo "$FINDING" > "$TMP/finding.json"
  bun "$PACK/lib/endloop.ts" bug "$TMP/finding.json" regression "$LOOP_COUNT" > "$TMP/bug.json"
  jq -r .body "$TMP/bug.json" > "$TMP/bug-body.md"
  NEW=$("$Z_BOARD" create --title "$(jq -r .title "$TMP/bug.json")" --body-file "$TMP/bug-body.md" \
    --milestone <the batch's milestone> --slug "$SLUG")   # "#<N> <url>"
  BUG_N=${NEW%% *}; BUG_N=${BUG_N#\#}   # M22: the NEW bug's number, NOT the drained ticket's
  "$Z_BOARD" move "$BUG_N" Backlog --slug "$SLUG"
  # append {number: $BUG_N, title} to "$TMP/endloop-bugs.json" for the report (step 5)
done
```

Report this plainly (Step 5 handles the wording) and stop — no `/land-and-deploy`,
`/canary`, or `/document-release` runs this loop.

**3b. Green path, in order** (`$PLAN` starts `["land-and-deploy","canary","document-release",...]`):
invoke each Skill in exactly that order, logging every invocation immediately
after it returns so the order is auditable even if the session dies mid-chain:

```bash
INVOKE_LOG="$HOME/.zstack/projects/$SLUG/reports/invocations-$(date +%Y%m%d-%H%M%S).jsonl"
```

For `land-and-deploy`, then `canary`, then `document-release`:
1. Invoke it (Skill tool). `/land-and-deploy` waits CI + deploy and verifies
   production health; `/canary` is post-deploy monitoring; `/document-release`
   updates docs for what shipped, every release.
2. `bun "$PACK/lib/skill-invoker.ts" record --log "$INVOKE_LOG" --skill <name> --note "<one-line result>"`
   — before starting the next one, so a crash mid-chain leaves a log that ends
   exactly where the chain actually stopped.

**4. Nth-loop audits** (only when `$PLAN` contains `cso`, i.e.
`$LOOP_COUNT % $AUDIT_EVERY_N == 0`, step 23): invoke `/cso` then `/health`, logging each
the same way as 3b. Every finding from either becomes a Backlog bug the same
way as 3a (`bun "$PACK/lib/endloop.ts" bug finding.json cso "$LOOP_COUNT"` /
`... health "$LOOP_COUNT"`, then `z-board create` + `move ... Backlog`). File a
bug for everything found — step 23 has no exceptions.

**5. Report:** assemble the `EndLoopReportInput` and render it:

- `regression`: `"$TMP/regression.json"` verbatim.
- `loopCount`: `$LOOP_COUNT`.
- `auditsRan`: `true` iff `$PLAN` contains `cso`.
- `tickets`: `{number, title, status}` for every ticket in the drained state
  (`jq '.tickets'` on `$STATE` already carries each one's final status), plus
  `actualDollars` from `"$Z_BOARD" field-get <N> Actual` for each.
- `edges`: `{ticket, edges}` per ticket, read back from each
  `"$TMP/note-<N>.json"` written in Step 6 (its `.edges` field) — this IS the
  completion-note edges rollup.
- `bugsFiled`: every `filedTickets` entry from those same `note-<N>.json`
  files (the per-ticket surfaced use cases), plus every bug this stage just
  filed in 3a/4 (`"$TMP/endloop-bugs.json"`) — the full picture of what this
  run added to Backlog.

```bash
bun "$PACK/lib/endloop.ts" report "$TMP/report-input.json" \
  > "$HOME/.zstack/projects/$SLUG/reports/loop-$(date +%Y%m%d-%H%M%S).md"
```

That file is the loop's report — nothing else builds one.

Then **Notify** `work-complete` with the SAME `EndLoopReportInput` numbers so the
message can never disagree with the report — slug `$SLUG`, `loopCount`
`$LOOP_COUNT`, the per-status counts (`done`/`questions`/`blocked`/`skipped`)
from the drained state, `totalDollars` = the sum of ticket Actuals, and
`verdict` = `regression.verdict`:

```bash
jq -n --arg slug "$SLUG" --argjson lc "$LOOP_COUNT" \
  --argjson done "$DONE" --argjson q "$QUESTIONS" --argjson b "$BLOCKED" --argjson s "$SKIPPED" \
  --argjson dollars "$TOTAL" --arg verdict "$VERDICT" \
  '{slug:$slug, loopCount:$lc, done:$done, questions:$q, blocked:$b, skipped:$s, totalDollars:$dollars, verdict:$verdict}' \
  > "$TMP/notify-work-complete.json"
bun "$PACK/lib/notify.ts" send work-complete "$TMP/notify-work-complete.json" --slug "$SLUG"
```

**6. Persist the loop counter LAST** (H17) — only now that the report is written
does the loop count actually advance, so a crash anywhere above re-runs this loop
id cleanly instead of drifting the audit cadence:

```bash
bun "$PACK/lib/endloop.ts" counter bump "$LOOP_COUNTER_PATH"   # matches the peek in step 1
```

---

## `--reconcile` and the safety locks (C7, issue #2)

Two lock kinds live under `$LOCKS` (`~/.zstack/projects/<slug>/locks/`):

- **Lane locks** `ticket-<N>.json` `{ticket, stage, session, claimedAt}` — one per
  in-flight lane, written right after a successful claim, re-stamped on each
  stage transition, removed at lane end. They survive a crash, which is how the
  next run knows a lane was mid-flight.
- **Loop lock** `loop.lock` `{session, startedAt, pid?, host?}` — one per project. A
  second `/z-loop` on the same project reads it and **refuses to start, naming
  the live session**: `Refusing to start: a /z-loop is already running on this
  project in session "<session>" ...`. A crashed loop's lock is judged *stale*
  (dead pid on the SAME host, or older than the config `lockStalenessMinutes`) and
  reported as such rather than live.

> **UNSUPPORTED: two loops under the same GitHub login on different machines.**
> The second-invocation guard is the `loop.lock`, and that lock lives in local
> `~/.zstack` — it is **per machine**. Board claims are keyed on the GitHub login
> (assignees are logins; a per-run session id cannot be stored as an assignee), so
> two loops running as the SAME login on DIFFERENT machines each see "the sole
> assignee is me", treat every ticket as already-ours, and both proceed —
> duplicate lanes, duplicate branches, racing merges. Do not do this. A safe
> cross-machine claim needs shared board-held state (a claim marker both loops
> check), which is deliberately out of scope for this remediation (issue #14 C8).
> Run one loop per (login, project) at a time; if you must parallelize, use
> distinct logins or distinct projects.

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
- The End-of-Loop stage ran to a verdict: red means every finding is filed to
  Backlog and NO deploy Skill was invoked; green means `/land-and-deploy` →
  `/canary` → `/document-release` ran in that order (invocation log on disk),
  plus `/cso` + `/health` on every Nth loop (config `auditEveryNLoops`, default
  5) with their findings filed too.
- The loop counter was bumped and persisted at
  `~/.zstack/projects/<slug>/loop-counter`.
- You made zero scheduling decisions in prose: every claim/advance/park/skip
  came from `loop.ts next`, and the end-of-loop sequencing came from
  `endloop.ts plan`.
