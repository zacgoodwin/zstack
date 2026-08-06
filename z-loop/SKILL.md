---
name: z-loop
description: |
  Drain-and-exit orchestrator for the zstack develop stage (PROCESS.md): runs a
  planning pass over Ready tickets, leaves the workable ones in Ready and moves
  each to Building when its builder lane claims it, then drives up to maxLanes
  concurrent worktree lanes through four fresh-agent
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
# issue #66: whoever `gh` is authed as -- a dedicated bot account is the
# supported way to give the loop its own identity; see
# docs/user-guide/bot-identity.md and z-setup/SKILL.md Step 7. No code here
# prefers or hardcodes the owner -- this line is the single source of truth
# for the session name, lane locks, claims, AND the git commit author.
#
# ME_EMAIL is the git AUTHOR half. `gh` auth decides who calls the API and who
# pushes; it does NOT decide the author stamped into a commit object -- that is
# git's own user.name/user.email, which on a developer machine is the human. So
# a bot-authed loop with no ME_EMAIL still lands commits authored by the owner,
# breaking "if the bot takes an action it shows up as that GH user". Both come
# out of the SAME single `gh api user` request, so they can never disagree with
# the live auth and neither is stored in config.json. The <id>+<login> form is
# GitHub's noreply address, which links the commit to the account even when its
# email is private. Applied PER-WORKTREE at claim time (Step 4's `claim` row),
# never repo-wide -- see the WARNING there for why that distinction matters.
ME=$(gh api user -q .login)
ME_ID=$(gh api user -q .id)
ME_EMAIL="$ME_ID+$ME@users.noreply.github.com"
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
4. Read the loop knobs from config (defaults 3 lanes / per-stage watchdog
   budgets — builder 25, qa 15, reviewer 40, merge 15 minutes of subtree
   SILENCE (#256), which `$WATCHDOG` carries as compact JSON and passes to
   `ingest` verbatim; a project whose config holds a plain number keeps that one
   budget for every stage / audits
   every 5th loop / 3 QA passes before Blocked / investigate from QA bounce 2 /
   human-needed at 30% parked / reviewer-confidence floor 70, block a
   sub-floor approve / 2 reviewer->builder bounces before Blocked / 2 of 3
   skeptic verdicts required for an adversarial approve to merge / no per-loop
   ticket cap / context ceiling 550000 tokens):

```bash
read -r MAX_LANES WATCHDOG AUDIT_EVERY_N MAX_QA_PASSES QA_INVESTIGATE_AFTER HUMAN_NEEDED_PERCENT MIN_REVIEWER_CONFIDENCE REVIEWER_BELOW_ACTION MAX_REVIEW_BOUNCES MIN_SKEPTIC_QUORUM TICKET_LIMIT CONTEXT_TOKEN_LIMIT <<<"$(bun -e "import {loadConfig} from '$PACK/lib/config.ts';
  const c = loadConfig('$SLUG'); console.log(c.maxLanes, JSON.stringify(c.watchdogMinutes), c.auditEveryNLoops, c.maxQaPasses, c.qaInvestigateAfter, c.humanNeededPercent, c.minReviewerConfidence, c.reviewerBelowThresholdAction, c.maxReviewBounces, c.minSkepticQuorum, c.ticketLimit, c.contextTokenLimit)")"
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

# a2) Sweep leftover throwaway review worktrees (#209). The command removes
#     nothing while any sub-agent of THIS session is still unproven (a skeptic
#     reading `.worktrees/review-<N>` must never have it pulled out from under it
#     -- #66); the acquire above proves no OTHER loop is running. A fresh session
#     has spawned nothing and sweeps everything, but /z-loop can also be invoked
#     inside a session that already holds sub-agent transcripts (a context-clear
#     resume keeps the session id), so this is a CHECK, not an assumption: read
#     what it prints. It is the catch-all for the exits Step 7's batch cleanup
#     never reaches -- a context-clear pause and any crash -- and it is not part
#     of the orphan gate below: a scratch checkout nobody owns is leftover litter,
#     never a wedge. Refusing to start over one would refuse to start almost
#     always. `--worktrees` defaults to `<cwd>/.worktrees`, so run this from the
#     repo root (a wrong cwd sweeps nothing and still reports 0).
bun "$PACK/lib/reconcile.ts" sweep-review

# b) Orphan scan: refuse if orphans exist and --reconcile was not passed.
HAS_ORPHANS=$(bun "$PACK/lib/reconcile.ts" scan --slug "$SLUG" | jq -r .hasOrphans)
if [ "$HAS_ORPHANS" = "true" ] && [ -z "$RECONCILE" ]; then
  echo "Orphans present (crashed lanes / stray worktrees / Building tickets with no state)."
  echo "Re-run /z-loop with --reconcile to release claims, park them to Ready, and prune."
  bun "$PACK/lib/locks.ts" release --slug "$SLUG"   # don't hold the lock while refusing
  exit 1
fi
[ -n "$RECONCILE" ] && bun "$PACK/lib/reconcile.ts" apply --slug "$SLUG" --session "$SESSION"
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

## Step 2 — Commit the queue (in place) (PROCESS.md step 7)

The committed queue is EVERY Ready ticket that passed Step 1 (body gated, no
open questions). **Leave them in Ready — Step 2 issues NO `z-board move` (no
board writes at all, #133).** Their work order is the deterministic claim order
`next` already computes (dependency-gated, ascending issue number,
`lib/lanes.ts` `claimableTickets`); no separate work-order list is needed. Each
ticket moves to Building only when its builder lane actually claims it (Step 4's
`claim` row), so Building means "being built now" and Ready means "queued."

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
  --max-review-bounces "$MAX_REVIEW_BOUNCES" --min-skeptic-quorum "$MIN_SKEPTIC_QUORUM" \
  --ticket-limit "$TICKET_LIMIT" --context-token-limit "$CONTEXT_TOKEN_LIMIT"
```

This is the ONE ingest call that captures `initialReadyCount` for the batch --
the committed queue is the gated Ready tickets from Step 2, still in Ready
(nothing has been claimed yet, #133), so `initialReadyCount` is captured from
that Ready count and this is ingest-time-zero for the safety control below. It
is also where the **per-loop ticket cap** (`--ticket-limit`, #131) flags this
run's batch: with a non-zero limit, `ingest` captures `batchTickets` -- the
dependency-self-contained allow-list of at most that many tickets (except when
nothing at all is closable -- every workable ticket depends on a board ticket
that is not Done: a cycle, a dep another session is building, or a dep no run
can start such as one still in Backlog -- where it admits the lowest workable
tickets CLOSED OVER their workable deps, which can exceed the cap, so the run
waits on the other session or parks them Blocked rather than exiting clean,
#157) -- once here
and preserves it across every re-ingest and context clear. At the default `0`
there is no cap (`batchTickets` stays unset, byte-identical to today). The
**context ceiling** (`--context-token-limit`, #131) is captured the same way;
the live per-tick reading that trips it is threaded by `z-loop-tick` in Step 4.

`ingest` preserves lanes and lost-claim flags across re-ingests, so re-running
it after board writes is always safe.

## Step 4 — The drain loop

Repeat until `next` returns `drain-complete`. **Re-read the board before every
iteration** — this is what makes wave reconciliation reachable (C3 / issue #14).
One `bin/z-loop-tick` call IS that iteration: it does snapshot → ingest → `next`
and prints **only** the one-line Action JSON, so on a long drain's 100+ iterations
the repeated bash command text never re-enters your context (ticket #57, Leak 2):

```bash
ACTION=$("$PACK/bin/z-loop-tick" --slug "$SLUG" --state "$STATE" --tmp "$TMP" --session "$SESSION")
```

`z-loop-tick` re-reads the board FIRST every iteration — refreshing each ticket's
status so a human's mid-loop move to Blocked/Questions/Skipped/Done is seen by
`reconcileBoardMoves` and turned into a `stop-lane` at the next boundary (skipping
this would let `next` decide off a stale snapshot and clobber the human's move,
defeating C7 safety control #6). It shells only `z-board` and `bun`, never gh:
`z-board snapshot` fetches items + bodies in one call through `lib/board.ts` (the
sole sanctioned gh caller), and its `ingest` preserves lanes + lost-claim flags.
Run it before EVERY `next` — especially before any advance/park/complete, so no
stage transition acts on a board the human has since changed.

**Positive evidence only (#138).** The board changes loop state ONLY through
things it positively showed. A ticket **absent** from a bulk read is never a
signal: `snapshot` pages the GitHub API, so a short page and a real removal are
indistinguishable, and every "believe the board or hold" rule that tried to tell
them apart failed. So an unobserved ticket carries forward unchanged — status,
flags, deps — and `state.json` stays authoritative for in-flight lanes, with the
board status a write-through projection. `z-loop-tick` then spends ONE
`z-board item <N>` lookup on each lane/batch ticket the read missed (that call
resolves an issue straight to its project item, so its "not on this project" IS
proof): found → spliced into the read, positively gone → removed from state. Its
notes ride the tick's stderr. Nothing here is yours to judge — no re-reading, no
"the board looks short", no waiting a tick to see.

**A gone ticket's LANE is stopped, never silently released (#273).** Two positive
observations take a ticket out of the loop's reach: that confirmed removal, and a
ticket observed sitting in a board status the loop does not drive (a column a
human added — `partitionKnownStatus`). When the ticket has no lane, the tick just
removes it and prints its stderr note; that is the whole story. When it DOES have
a lane, the tick does **not** release anything on its own — it marks the lane
(`goneReason`) and keeps it, and the very next `next` returns a **`stop-lane`**
whose note names the observed status or the removal proof. Run that action's row
below like any other: tear down the lane's background agent, `lane-remove` the
lock, then apply (which drops the lane and its ticket together). Until you do,
the lane still counts as running, so `drain-complete` cannot fire and Step 7
cannot delete the branch that worker is still committing to. The stop does not
wait for a stage boundary the way a human's move to Blocked/Questions/Skipped
does — that ticket is still on the board and observable next tick, a gone one is
not.

**Lane moves are `--if-present` (#138).** Every `z-board move` below that belongs
to a lane takes `--if-present`, which prints `{"moved":true}` or
`{"moved":false,"reason":"not-on-project"}` (exit 0) instead of aborting the tick
on a ticket removed from the board between two confirm passes. On `moved:false`:
for a lane that exists (park/skip, and the `advance` row's step-3 move), comment
the note anyway where the row has one (the issue is still
there), `lane-remove`, and apply a **`stop-lane`** action instead of the park —
`{"kind":"stop-lane","ticket":<N>,"dropTicket":true,"note":"#<N> is no longer on the project board; releasing its lane."}`
— which drops the lane and writes no status. **`dropTicket` is not optional here**
(#273): the move just proved this ticket is off the project, and without the flag
it stays in `state.json` at whatever workable status it last held, so the very
next `next` returns a **`claim`** for it and spawns a fresh paid agent into a
ticket the board does not have. For the `claim` row (no lane yet)
take the claim-lost path already in that row. For Step 6's Done move the recovery
is the opposite one — apply `complete` anyway, never `stop-lane`; see Step 6
item 4 for why the merge record cannot be dropped.

**Skip QA (#130).** The board snapshot now carries each issue's labels. When a
ticket has the `skip-qa` label, a finished builder advances straight to Review
(Building → Review), skipping the QA stage — a human sets that label at triage
for an error fix, a question answer, or a blocker resolution. The QA
bounce/investigate machinery is unchanged for every ticket without the label.

**BUILT verification (#177).** A `BUILT` marker is a claim, not proof: run 9's
#155 builder emitted it with everything still uncommitted, so QA reviewed the
BASE tree and passed a diff that did not exist. Recording a **builder** lane's
outcome therefore REQUIRES that lane worktree's own git facts, and
`loop outcome` refuses (exit 1, with these commands) without them:

```bash
WT=".worktrees/ticket-<N>"
git -C "$WT" status --porcelain --branch > "$TMP/porcelain-<N>.txt"
bun "$PACK/lib/loop.ts" outcome "$STATE" <N> msg.txt \
  --porcelain "$TMP/porcelain-<N>.txt" \
  --head-sha "$(git -C "$WT" rev-parse HEAD)" \
  --base-sha "$(git -C "$WT" merge-base "$BASE" HEAD)"
```

Both flags in that command are load-bearing, and neither is interchangeable with
the obvious shorter form:

- `--branch` — git always emits a `## <branch>` header with it, and the guard
  REQUIRES that header. A `> file` redirect creates the file before git runs, so
  a `git status` that failed leaves an EMPTY file, which a bare `--porcelain`
  payload cannot tell apart from a clean tree.
- `merge-base "$BASE" HEAD`, not `rev-parse "$BASE"` — the check is "does HEAD
  carry a commit `$BASE` does not". The base TIP only answers that while it has
  not moved since the worktree was created; a leftover worktree re-claimed in a
  later loop sits under a `$BASE` that step 7 already pulled forward, so a lane
  that committed NOTHING would read as moved.

The three facts are all it takes; the verdict is the state machine's
(`builtGuardFailure`), never yours. A `BUILT` with a dirty tree OR a HEAD still
an ancestor of `$BASE` does not advance to QA (nor to Review under `skip-qa`): the
lane re-spawns its own builder ONCE with an `uncommitted work` note asking it to
commit, and a second such `BUILT` parks the ticket Blocked with that note (see the
`park N Blocked` row for the salvage dump that park REQUIRES first). Every other
stage has nothing to verify, so its `outcome` call is unchanged.

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
| `claim N` | 1. `"$Z_BOARD" claim <N> "$ME"` **before anything else**. Claim lost → `bun "$PACK/lib/loop.ts" claim-lost "$STATE" <N>` and re-run `next` (next ticket). 2. **Deferred commit (#133) — move the ticket to its claimed stage's status, ONLY after the claim succeeds** (a claim loser must never move a ticket, same C7 reason as the lock below): `"$Z_BOARD" move <N> <status> --if-present --slug "$SLUG"` (`moved:false` → the ticket left the board between confirms: take the claim-lost path in step 1 and re-run `next`, claiming nothing) where `<status>` mirrors the reducer's `STATUS_FOR_STAGE[stage]` — `builder`→`Building`, `qa`→`QA`, `reviewer`→`Review`. A fresh `builder` claim moves Ready→Building (the old Step 2 up-front move, now deferred to here); a resume claim at `qa`/`reviewer` is already at its stage's status, so the move is a no-op. 3. **Write the lane lock** (C7 — a claim loser never leaves a lock): `bun "$PACK/lib/locks.ts" lane-write --slug "$SLUG" <N> <stage> --session "$SESSION"`. 4. Worktree (skip if it exists — a resume claim at stage qa/reviewer reuses it): `TSLUG=$(bun -e "import {slugifyTitle} from '$PACK/lib/ticket-schema.ts'; console.log(slugifyTitle(process.argv[1]))" "<title>")` then `git worktree add ".worktrees/ticket-<N>" -b "z/ticket-<N>-$TSLUG" "$BASE"`. 4b. **Stamp the lane's git author (#66) — every commit this lane makes must be authored by the account `gh` is authed as, not by this machine's global git identity:** `git config extensions.worktreeConfig true` then `git -C ".worktrees/ticket-<N>" config --worktree user.name "$ME"` and `git -C ".worktrees/ticket-<N>" config --worktree user.email "$ME_EMAIL"`. **WARNING — `--worktree` is load-bearing, do not drop it.** Git worktrees SHARE the main repo's `.git/config`, so the plain `git -C <worktree> config user.name` form silently rewrites the identity of the human's OWN checkout too, re-authoring their personal commits in this repo. `--worktree` scopes the write to `.git/worktrees/<name>/config.worktree`, leaving the main checkout untouched; it hard-fails unless `extensions.worktreeConfig` is on, which is why that line comes first (idempotent, additive, and safe at repo format version 0 — verified on git 2.55). Re-running on an existing worktree (a resume claim) just rewrites the same two values. 5. Apply: write the action JSON to a file, `bun "$PACK/lib/loop.ts" apply "$STATE" action.json` (its `claim` reducer sets the state-file status to `STATUS_FOR_STAGE[stage]`, matching the board move above). 6. Spawn the action's stage (table below). |
| `advance N to S` | 1. **Re-stamp the lane lock** to the new stage: `bun "$PACK/lib/locks.ts" lane-write --slug "$SLUG" <N> <S> --session "$SESSION"`. 2. Apply. Before applying, read the lane's CURRENT stage from the state file: an advance to `builder` from `qa` passes the action's `note` as `qaNotes` (+ `investigateFirst`); from `reviewer`, as `reviewNotes`; from `builder` (the #177 commit re-spawn), as `commitNotes`. 3. **Move the ticket to the new stage's status (#205) — never skip this**: `"$Z_BOARD" move <N> <status> --if-present --slug "$SLUG"` where `<status>` mirrors the reducer's `STATUS_FOR_STAGE[S]`, exactly as the `claim` row above does — `builder`→`Building`, `qa`→`QA`, `reviewer`→`Review`, and `merge`→`Review` too (merge has no status of its own; it runs under Review because Done means the PR landed). Three advances therefore re-write the status the board already shows and are no-ops on it: `reviewer`→`merge`, and the two self-advances (`reviewer`→`reviewer`, #191's quorum retry; `builder`→`builder`, #177's commit re-spawn). Issue them anyway — the derivation stays total, and an `--if-present` move that changes nothing costs one call. `apply` prints the move for you (`board write for #<N> = <status> …`, derived from `STATUS_FOR_STAGE` in code) — run exactly what it names. The move comes AFTER the apply, unlike the `claim` row: an advance's apply is what validates the transition (`canTransition` — an illegal one throws and the board is never touched) and stamps the lane's `lastWroteStatus`, so a crash in the gap leaves the board one hop BEHIND a lane that names the write it owes — the shape the #125/#116 desync guard resyncs, at this lane's **next stage boundary** (the guard only judges a lane with a recorded outcome, so the board stays behind for the rest of the running stage — and if the crash also cost the step-4 spawn, no worker exists to produce that outcome until the watchdog's #209 re-spawn supplies one), keeping the lane, its stage and its bounce counters: no stop-lane, no re-claim, no rebuild. **One advance is not one hop and is NOT recovered**: a `skip-qa` ticket (#130) walks `builder`→`reviewer`, i.e. Building→Review, and `isOneHopLag` maps a reviewer lane's lag to `QA` alone — so a missed step-3 move there stop-lanes at the reviewer boundary and the ticket is re-claimed as a *builder*. That is the pre-#205 outcome for every skip-qa advance, now narrowed to this window, but it is the one window the move must not be skipped in. (`moved:false` → the ticket left the board: take the shared `--if-present` recovery above and do **not** spawn stage S. A move that fails any OTHER way is not `moved:false` — re-run it; the state file has already advanced and the board is the half still owed.) The move is a blind write, not a compare-and-set: `z-board move` sets the field without reading it, so a human who drags this card between this tick's ingest and step 3 has that move overwritten. The window is seconds and the loop re-reads the board every tick, but it is the reason a human's real escape hatch is a move to a TERMINAL status, which the next ingest honors. Skipping the move leaves the board a stage behind the lane forever — the marker never clears, `/z-status` lies, and every later claim of this ticket reads the BOARD for its stage (`lanes.ts` `claimStage`), so a lane that reached QA comes back as a *builder* and rebuilds work already committed. 4. Spawn stage S fresh. |
| `respawn N at S` | #209: this lane's worker died without an exit marker while its worktree still holds uncommitted changes, so the stage is re-spawned ONCE at the SAME stage instead of the ticket being skipped with finished work in it. Re-stamp the lane lock at that same stage (`lane-write --slug "$SLUG" <N> <S> --session "$SESSION"`), tear down the dead agent if the harness still lists it, apply (the reducer spends this lane's one `respawns[S]` budget; there is **no board move** — the ticket never left this stage's status), then spawn stage S FRESH with the action's `note` passed as `respawnNotes` in the input JSON, and with `<attempt>` = the action's own `attempt` field (the dead spawn already used the previous number; a re-used spawn tag makes `transcripts collect` refuse and a re-used transcript name overwrites its predecessor). **The dead spawn is already priced** — the `check-worker` row collected its transcripts before the probe, while `loop attempt` still returned its number; do NOT re-run `collect` for it after applying (the attempt has moved on and the tag would name the spawn you are about to make). **Never SendMessage the dead agent** — a fresh spawn is the point: the guarantee that nothing latent travels between stages is worth more than the tokens a resume would save. The cap is **one re-spawn per stage per lane**: a second silent death at stage S skips the ticket (`next` returns `skip`), while a later death at a DIFFERENT stage of the same lane still gets its own — a builder that died silently is no evidence about the QA agent that runs after it. |
| `park N Questions` | Comment the note as `## Needs input --` + the question, `"$Z_BOARD" move <N> Questions --if-present`, apply, then **remove the lane lock** (`bun "$PACK/lib/locks.ts" lane-remove --slug "$SLUG" <N>`). Tell the human in the comment which status to return the ticket to. Keep the worktree. **Notify** `human-pause` (`{ticket,title,note}`; see the Notify block below). |
| `park N Blocked` | **First**, when the action carries `"salvage": true` (#177's exhausted commit retry): run the **Salvage dump** block below before anything else. Then: comment the note (what was wrong + recommended next steps), `move <N> Blocked --if-present`, apply, remove the lane lock. Leave any `.worktrees/review-<N>` alone (**Removing a review worktree** below). **Notify** `token-burn` (`{ticket,detail:note}`) when the note begins `Dependency deadlock:` (the step-6 deadlock break); otherwise `ticket-parked` (`{ticket,title,status:"Blocked",note}`). |
| `skip N` | **First**, when the action carries `"salvage": true` (#209's exhausted dead-worker respawn): run the **Salvage dump** block below before anything else. Then: comment the note (the confusion or the dead-worker evidence), `move <N> Skipped --if-present`, apply, remove the lane lock. Leave any `.worktrees/review-<N>` alone (**Removing a review worktree** below). (PROCESS.md global rule.) **Notify** `safety-violation` (`{control:"watchdog",ticket,detail:note}`) when the note begins `Worker died mid-` (a watchdog dead-worker skip); otherwise `ticket-parked` (`{ticket,title,status:"Skipped",note}`). |
| `stop-lane N` | A human moved #N to a stop status (Blocked/Questions/Skipped/Done) mid-run, **or** #N left the loop's reach entirely — dragged into a board column the loop does not drive, or removed from the project outright (#273; the note names which). Read the two structural flags off the action JSON, never off the note: **`"dropTicket": true`** means applying it removes the ticket from `state.json` along with the lane (the #273 kind — without it a ticket proved off the board stays claimable and the next tick spawns a paid agent into it), and the **ingest-marked** #273 kind is also the ONE stop-lane that fires **mid-stage** rather than at a stage boundary, so that one always carries **`"salvage": true`** too (the hand-built `moved:false` recoveries above fire at a boundary and carry `dropTicket` alone). **Dump the worktree first anyway when the recovery interrupts #177's commit retry** — that advance is issued *because* `builtGuardFailure` found an uncommitted tree, so releasing its lane lock strands real work the next reconcile force-removes; run the `park N Blocked` **Salvage dump** block before `lane-remove`. Either way the board already reflects it — do NOT move or comment it. **First**, when the action carries `"salvage": true` (#209 — the lane's worker died silently and its worktree held uncommitted work): run the **Salvage dump** block below. Then tear down the lane's background agent, remove the lane lock (`lane-remove`), and apply (drops the lane, leaves the human's status). Other lanes are unaffected, and any `.worktrees/review-<N>` is left alone (**Removing a review worktree** below). This also answers a lane whose worker died silently on a ticket a human had already parked (#209): the human's move wins over the dead-worker re-spawn, so no paid agent is spawned into it. The lane worktree is left in place, but **it is not durable** — releasing the lane lock makes it an orphan the next run's reconcile force-removes, which is why the salvage dump above is not optional when the flag is set. |
| `merge-gate N` | **The loop-owned green gate (#178) — the only door into the merge stage.** Run it; do NOT spawn a merge agent from this row and do NOT judge any test output yourself. Run 9's merge worker read a suite reporting 9 failures, called it green in prose, merged, and broke `$BASE` (reverted in PR #158). <br>`bun "$PACK/lib/loop.ts" merge-gate ".worktrees/ticket-<N>" --state "$STATE" --ticket <N>` <br>**Give this Bash call an explicit `timeout` of `600000` (10 min, the tool's maximum) — never the harness default of 120000ms.** It runs `bun run test` + `bun run typecheck` in the worktree -- whichever of the two that worktree's `package.json` defines, neither defined being a refusal. **Measured, not estimated:** the suite alone runs 128-234s on this repo across three timed runs (`tsc --noEmit` adds ~1s), and EVERY red first attempt is retried once after a 15s wait, so the worst case is ~2x234s + 15s ~= **8.1 min** against the tool's 10-minute maximum. The harness default of 120000ms kills it inside the first attempt. The gate does not rely on this number: it owns a 570s wall-clock budget in code (`MERGE_GATE_BUDGET_MS`), hands attempt 1 all of it and the retry whatever is left -- so the worst thing a too-short Bash timeout can do is cost the lane an attempt, never merge something ungated. The budget can never cancel the retry; only attempt 1 consuming all 570s (i.e. being killed at the cap) leaves no clock to run a second in. Nonzero exit is EXPECTED on a red verdict — it is the gate's answer, not a tick failure, so run it as a bare command (no `set -e` script, nothing that aborts the tick on exit 1). The command stamps the verdict on the lane, so you never parse its output: just re-run `next`, which returns `advance N to merge` on green and `park N Blocked` (carrying the gate's own note, fail count included) on red. A killed call stamps no verdict and `next` simply returns `merge-gate N` again; the second silent attempt parks the lane Blocked, so a too-short timeout costs the lane. The gate already retried once for process contention, so a red verdict is never "try again": nothing merges until a rebuild or a human makes the suite green. **Run it against the lane's OWN worktree** — with `--state`/`--ticket` the gate REFUSES (stamps red) any worktree not on that lane's `z/ticket-<N>-<slug>` branch, so a verdict can never be measured on one tree and stamped on another lane (#248). The verdict also records the commit it was measured on, and `next` compares that against the head it reads from `.worktrees/ticket-<N>` itself: a branch that has moved since the stamp returns `merge-gate N` again (re-gate, so a stacked chain keeps draining in dependency order rather than parking), while a verdict naming no commit, or a head the loop cannot read, parks the lane Blocked. That comparison is also why nothing is lost by re-running the gate after a conflict resolution and everything is lost by skipping it. |
| `check-worker N` | Is the lane's background agent still running (harness task list)? Alive → `bun "$PACK/lib/loop.ts" probe "$STATE" <N> alive`. Dead with no final message: **price the dead spawn FIRST, before the probe and before anything else (#209)** — run the **Per-stage Actual** block below (`attempt` → `tag` → `transcripts.ts collect --tag …`) for this lane's CURRENT stage, exactly as the `wait` row does for an agent that finished normally. A dead agent still spent money, and this is the LAST moment its spend is reachable: the tag is a digest of `<attempt>`, `loop attempt` still returns the dead spawn's number here, and the `respawn` apply that follows spends `respawns[<stage>]` and moves that number on — after which nothing can recompute the dead spawn's tag and its `.jsonl` never lands in the ticket's transcripts dir, so `z-cost`'s directory glob never sees it and the recovered ticket goes Done with an Actual covering only the spawn that survived (the same silent undercount #190 exists to prevent). Collect here and the recovery is priced whichever way it lands — `respawn` or `skip`. A non-zero `collect` is possible here and is NOT a reason to stop (the agent may have died before writing anything, or before the tag reached it): note it in the eventual comment and carry on to the probe. **Then:** **if the lane's stage is `merge`, do NOT probe-dead/skip** — verify PR state first (H9): `gh pr view <branch> --json state,url -q '.state'`. If `MERGED`, the PR landed before the worker died, so record it as merged (`printf 'MERGED: %s\n' "$prUrl" > msg.txt; bun "$PACK/lib/loop.ts" outcome "$STATE" <N> msg.txt`) → the reducer completes it and counts it in `mergedThisRun` (so a stacked child still retargets and the batch-end branch delete can't close its PR). If NOT merged, record `printf 'BLOCKED: merge worker died with the PR unmerged (%s)\n' "$state" > msg.txt; outcome ...` → parks it Blocked for a human, and **Notify** `safety-violation` (`{control:"watchdog",ticket,detail:"merge worker died with the PR unmerged"}`). For any OTHER stage, dead with no final message → collect the lane worktree's own dirtiness FIRST, then probe dead with it (#209 — a stage that died holding finished work is re-spawned instead of skipped, and without this flag the lane can only ever be skipped): `git -C ".worktrees/ticket-<N>" status --porcelain --branch > "$TMP/porcelain-<N>.txt"` then `bun "$PACK/lib/loop.ts" probe "$STATE" <N> dead --porcelain "$TMP/porcelain-<N>.txt"`. `--branch` is load-bearing for the same reason as the BUILT verification above: the header is the proof git actually ran. A payload with output but no header is unreadable, not clean, and fails toward keeping the work (a re-spawn); an EMPTY file is neither — the redirect creates it before git runs, and git prints the header whenever it runs at all, so zero bytes means git failed outright, which is what a MISSING or broken worktree gives you. That records no work (the pre-#209 skip), because there is nothing there to recover and no worktree to spawn into. The next `next` returns `respawn` (dirty, respawn budget unspent), `stop-lane` (a human moved the ticket to a stop status mid-run — respected, no paid re-spawn), or `skip`. |
| `complete N` | The completion flow — Step 6 — then apply, then **remove the lane lock**. |
| `wait` | Block until a background stage agent finishes (the harness notifies you) or one minute passes, then re-run `next` — the watchdog only fires if `next` is called with a fresh clock. When an agent finishes: save its final message to a file and `bun "$PACK/lib/loop.ts" outcome "$STATE" <N> msg.txt` — a **builder** lane additionally requires the three git-fact flags (see **BUILT verification (#177)** above; the command refuses without them) — then update Actual (below), then re-run `next`. |
| `context-clear` | The context ceiling (`contextTokenLimit`, #131) is reached, every lane is idle, and the batch still has unbuilt tickets — a mid-batch PAUSE, distinct from `drain-complete`. Apply it (a pure no-op on state). Then: release the loop lock (`bun "$PACK/lib/locks.ts" release --slug "$SLUG"`), **keep** every worktree/branch and `state.json` (the batch is un-drained — `batchTickets` still holds the unbuilt tickets), and **exit WITHOUT running Step 7 end-of-loop** (no regression, no deploy — the batch isn't done). Print the resume instruction: the operator (or harness) clears this session's context and re-invokes `/z-loop`; the fresh orchestrator reads a small context on its first tick, so the gate is open and Step 3's ingest (seeing the un-drained `state.json`, `startingFreshBatch` false) preserves `batchTickets` and resumes claiming the next flagged-but-unbuilt ticket. In-flight lanes are never cut short — `context-clear` only fires with all lanes idle. |
| `drain-complete` | Step 7. |

**Salvage dump (`"salvage": true`).** Three actions drop a lane — `park`, `skip`,
`stop-lane` — and every one of them removes the lane lock, which turns
`.worktrees/ticket-<N>` into an orphan the next run's reconcile scan force-removes
(`git worktree remove --force`, uncommitted work discarded). When the lane worktree
still holds uncommitted work at that moment, the action carries `"salvage": true`
and you dump it FIRST, before the comment, the board move, the apply, or the lock
removal:

```bash
git -C ".worktrees/ticket-<N>" add -A \
  && git -C ".worktrees/ticket-<N>" diff --cached --binary HEAD \
     > "$HOME/.zstack/projects/$SLUG/reports/uncommitted-<N>.patch"
```

`add -A` so untracked files land in the patch too; the worktree is doomed, so
mutating its index costs nothing. The action's note already names that path, so
this dump is what makes the note true. Read the flag off the action JSON — do NOT
match a phrase in the note (#209): the stop-lane note contains the words
"uncommitted work" and used to route to a row that dumped nothing, so one prose
key meant two different things.

**Removing a review worktree.** `.worktrees/review-<N>` is removed in exactly two
places: the gated block in the **Per-stage Actual** step below, and
`reconcile.ts sweep-review`. Nowhere else — not in a park, not in a skip, not in a
stop-lane, not "while cleaning up". Both sanctioned paths first check that no agent
of this session is still unproven, because the reviewer's skeptics execute inside
that directory and outlive the reviewer that spawned them; a removal anywhere else
is #66's failure (a skeptic watching its own workspace vanish mid-review) with a new
trigger, and it was reproduced during this ticket's own review by a `park N Blocked`
cleanup that force-removed `.worktrees/review-209` under a live skeptic. Leftovers
are litter, never a wedge: leave them and let the sweep take them.

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
2. **Stamp the spawn, then build the prompt (1b).** `<attempt>` is that lane's
   1-based spawn count for its CURRENT stage. **Compute it, never count it in
   prose** (#209) — it is arithmetic over five state-file counters that grows
   every time a re-spawn route is added, and two spawns of one stage that compute
   the same number mint the same tag (`collect` then refuses, unable to tell their
   spend apart) and overwrite each other's transcript. Read it AFTER `apply`, so
   the counter that re-spawn just spent is already in the file:

   ```bash
   ATTEMPT=$(bun "$PACK/lib/loop.ts" attempt "$STATE" <N>)
   TAG=$(bun "$PACK/lib/transcripts.ts" tag --slug "$SLUG" --ticket <N> --stage <stage> --attempt "$ATTEMPT")
   bun "$PACK/lib/stage-prompts.ts" prompt <stage> "$TMP/input-<N>.json" > "$TMP/prompt-<N>.txt"
   STUB=$(bun "$PACK/lib/stage-prompts.ts" stub <stage> "$TMP/prompt-<N>.txt" --spawn-tag "$TAG")
   ```

   **Never read `prompt-<N>.txt` yourself, and never pass its contents to the
   Agent.** `$STUB` is a ~480-byte pointer at that file and is the ONLY thing
   that goes into the spawn. The prompt averages ~2.9 KB, and anything you read
   or send stays in your window for the rest of the drain, so reading it back
   cost ~8% of all orchestrator tokens across 35 measured drains for text you
   never reason about. `stub` fails loudly if the prompt file is missing, which
   is why step 2 writes it first. `--spawn-tag` moves to `stub` because the stub,
   not the prompt, is now the worker's first message and that is where
   `transcripts collect` looks for the marker.

   `$ATTEMPT` is `stageAttempt` in `lib/loop.ts`, whose header carries the full
   derivation — every arrow into every stage and the counter it spends. Do not
   re-derive it here; three duplicate-tag defects have already come from a prose
   copy drifting. For orientation only:
   `builder` = `qaBounces + reviewBounces + commitRetries + respawns.builder + 1`,
   `qa` = `qaBounces + reviewBounces + respawns.qa + 1` (a reviewer bounce sends the
   lane back through the builder and into QA a second time, which is why
   `reviewBounces` is in both), `reviewer` =
   `reviewBounces + quorumRetries + respawns.reviewer + 1` (#191's quorum retry
   re-spawns the reviewer at the same stage), `merge` = `respawns.merge + 1`
   (nothing re-enters merge). `respawns` is keyed BY STAGE, so #209's builder
   re-spawn never shifts QA's numbering. On a `respawn` action use the action's own
   `attempt` field instead — the same number, without an extra call. The QA prompt's
   `qaPass` is a different quantity (`qaBounces + 1`, the QA pass number) and is
   unchanged.

   The tag is an opaque digest of those four facts and nothing else, so it is
   **recomputable** — the per-stage Actual step below re-runs the identical `tag`
   command instead of depending on `$TAG` surviving between calls. It is what lets
   that step find this spawn's transcript deterministically (#190); skip it and
   the stage's dollars go uncounted. Never invent a tag by hand.

   The constructor prints a POINTER prompt: small/fixed fields inline plus an
   instruction to read `ticketBody`/`diff`/`acceptanceCriteria` from the
   ABSOLUTE path of `input-<N>.json`, so `prompt-<N>.txt` is payload-independent.
   The stub above then makes your own context prompt-independent too. The
   constructor is the
   contract; if it exits non-zero the input is wrong, fix the input, never
   hand-write the prompt. The `reviewer` stage additionally takes two flags
   (`--adversarial-mode`, `--labels`) — see its row below. All three ride as
   FLAGS and NEVER become input keys, so the reviewer's four-key blindness gate is
   untouched (the tag is a digest for that reason too: a readable
   `<slug>/t<n>/<stage>/<attempt>` would tell the reviewer which review attempt
   this is).
3. Spawn a FRESH harness Agent (Agent tool), `run_in_background: true`, passing
   `$STUB` as the prompt and `model` resolved through the per-stage router (issue #82:
   the merge stage is mechanical — a PR create, a conflict check, a PR merge —
   and never needs the ticket's build-tier model, a direct, zero-quality-risk
   cost cut):

   ```bash
   TICKET_MODEL=$("$Z_BOARD" field-get <N> Model)
   MODEL=$(bun "$PACK/lib/loop.ts" stage-model <stage> "$TICKET_MODEL" --slug "$SLUG")
   ```

   Pass `$MODEL` as the Agent spawn's `model` param — never the raw
   `TICKET_MODEL` directly. `stage-model` reads the project's `stageModels`
   config (`lib/loop.ts resolveStageModel`): absent entirely, only `merge`
   downshifts to `haiku`; present (even `{}`), used exactly as configured, no
   default layered on. The Model Effort field selected the estimate tier —
   the Agent call has no per-spawn effort knob, a known ceiling.

| Stage | Input JSON fields |
|---|---|
| `builder` | `ticketNumber`, `ticketTitle`, `ticketBody` (fresh `gh issue view` → `"$TMP/body-<N>.md"`, injected `--rawfile`), `worktreePath` (`.worktrees/ticket-<N>`), `branch`, `baseBranch`; on a bounce also `qaNotes`/`investigateFirst`, `reviewNotes`, or `commitNotes` per the advance row above; on a `respawn N at builder`, `respawnNotes` (the action's own `note`) per the respawn row above. |
| `qa` | `ticketNumber`, `ticketBody` (`--rawfile "$TMP/body-<N>.md"`), `worktreePath`, `branch`, `qaPass` (the lane's `qaBounces` in the state file + 1), `webTarget` (true when the ticket changes a web-served surface — your judgment; QA then drives gstack /qa); on a `respawn N at qa`, `respawnNotes` (the action's own `note`) per the respawn row above. |
| `reviewer` | **BLINDED — exactly** `ticketBody` (`--rawfile "$TMP/body-<N>.md"`), `acceptanceCriteria` (the `### Acceptance Criteria` section to a file: `awk '/^### Acceptance Criteria/{f=1;next} /^#/{f=0} f' "$TMP/body-<N>.md" > "$TMP/ac-<N>.md"`, injected `--rawfile`), `diff` (exclude lockfiles to avoid flooding the reviewer with generated code: `git -C .worktrees/ticket-<N> diff "$BASE"...HEAD -- . ':(exclude)*.lock' ':(exclude)package-lock.json' ':(exclude)pnpm-lock.yaml' ':(exclude)yarn.lock' > "$TMP/diff-<N>.txt"`; if the filtered diff is empty — a lockfile-only change — fall back to the unfiltered diff: `[ ! -s "$TMP/diff-<N>.txt" ] && git -C .worktrees/ticket-<N> diff "$BASE"...HEAD > "$TMP/diff-<N>.txt"`. Injected `--rawfile` so it never enters your context), `worktreePath` = a THROWAWAY worktree of the head commit, placed under the repo's own `.worktrees/` — NEVER under `$TMP` / `~/.zstack` (issue #118: the reviewer runs the full `bun test` suite in this worktree, and several tests write to/delete real `~/.zstack` subtrees via `homedir()`; a throwaway worktree rooted there lets that suite's cleanup destroy the loop's own live state.json/locks/transcripts mid-run) — `git worktree add ".worktrees/review-<N>" <head-sha>`; remove it only once the whole spawn SUBTREE has finished, never when the reviewer itself returns (#209 — see **Per-stage Actual** below for the gate; the skeptics execute inside this worktree and outlive their parent, and #66's review removed it out from under two live skeptics). No PR description, no plan rationale, no transcripts — the constructor rejects any other key set. **Adversarial control (#59):** build this stage's prompt with two extra flags — `MODE=$("$Z_BOARD" ... )` the project's `adversarialMode` (read it from `~/.zstack/projects/$SLUG/config.json`; `loadConfig` defaults it to `non-trivial`) and `LABELS=$(gh issue view <N> --json labels -q '[.labels[].name]')` (a JSON array — labels live on the GitHub issue, NOT on the board item, so `board.list` never fetched them; get them here). Then `bun "$PACK/lib/stage-prompts.ts" prompt reviewer "$TMP/input-<N>.json" --adversarial-mode "$MODE" --labels "$LABELS" > "$TMP/prompt-<N>.txt"`, followed by the same `stub reviewer "$TMP/prompt-<N>.txt" --spawn-tag "$TAG"` every other stage runs (`--spawn-tag` rides on the stub per step 1b — required here like every other stage, and #190's skeptic transcripts are the reason it exists at all). The predicate (`adversarialActive`) reads the diff's own changed-line count from the blinded input — `always`/`non-trivial`-on-a-big-or-labeled diff spawns the skeptic fan-out (and stamps a `confidence=` token onto `REVIEW-FINDINGS` too); `off`/small-unlabeled is the single pass. Either way `REVIEW-APPROVE` always carries a `confidence=` token (issue #62's safety gate reads it regardless) — see `/z-loop`'s reviewer-confidence-gate section for what a sub-floor score does. Mode + labels ride as FLAGS; the four-key input JSON is untouched. |
| `merge` | `ticketNumber`, `prTitle` (the ticket title), `branch`, `baseBranch`, `worktreePath`, `statePath` (`"$STATE"` — makes the prompt's Step 0 render the STAMPING form of the gate, so the agent's own run, including the re-run after a conflict resolution, lands a verdict naming the commit sha it tested), `stackedOn` (from the advance action — parents whose branches this PR stacks on; the prompt carries the PROCESS.md step 18 chain rules: parents first, no branch deletion mid-batch, retarget, delete last). **You cannot reach this spawn without a green gate** — `next` only emits `advance N to merge` for a lane carrying a green `merge-gate` verdict (see that action's row), so the permission is enforced by the reducer, not by this table. The prompt still makes the agent run the gate itself as its Step 0 — the STAMPING form, so a post-conflict re-gate lands on the lane too — covering the code it is actually merging. |

**Per-stage Actual (every stage, no exceptions):** when a stage agent finishes —
or is found DEAD at `check-worker`, which spent money just the same (#209) —
collect its transcripts with `lib/transcripts.ts` — never by picking files
yourself. Recompute the same tag the spawn was stamped with (step 1b above; same
four facts, same digest), then collect:

```bash
ATTEMPT=$(bun "$PACK/lib/loop.ts" attempt "$STATE" <N>)
TAG=$(bun "$PACK/lib/transcripts.ts" tag --slug "$SLUG" --ticket <N> --stage <stage> --attempt "$ATTEMPT")
bun "$PACK/lib/transcripts.ts" collect --tag "$TAG" \
  --dest "$STATE_DIR/transcripts/ticket-<N>" --name "<stage>-$ATTEMPT" > "$TMP/collected-<N>.json"
```

`collect` finds the stage agent by its stamped tag and copies **it plus every
sub-agent it spawned, transitively** — `<stage>-<attempt>.jsonl` for the stage
itself and `<stage>-<attempt>-sub-<agentId>.jsonl` for each descendant. `<stage>`
is one of `builder`/`qa`/`reviewer`/`merge` (the `tag` verb rejects anything else,
since only those four have a spend-by-stage row); `<attempt>` is the same 1-based
spawn count step 1b computed. Sub-agents are the
whole point (#190): the adversarial reviewer spawns 3 skeptics whose tokens ARE
reviewer spend, and the old prose here said "take the file for that spawn" — a
latent step, so they were collected by nobody and every adversarial review's
Actual undercounted by most of what it spent. Do NOT sweep by modification time:
three lanes run concurrently, so sibling reviewers' skeptics interleave in one
flat directory, and that sweep gave a reviewer with 3 skeptics 8 transcripts.

It exits non-zero rather than writing a partial set — a missing stage transcript
is exactly the silent undercount #190 filed. If it fails, the tag never reached
the agent (step 1b was skipped, or `<attempt>` disagrees between the two calls):
say so in the completion note instead of guessing a number, price whatever the
directory does hold, and keep the drain moving.

**Worktree teardown is gated on that manifest (#209).** Only the `reviewer` stage
has a throwaway worktree, and this is where it goes — every other stage's worktree
is the lane's own and survives the stage, so skip this block for `builder`/`qa`/
`merge`. A stage's sub-agents outlive the stage: `.worktrees/review-<N>` was
removed as soon as the reviewer returned, and in #66's review that fired while two
of its three skeptics were still executing inside it (one reported the worktree
vanishing from `git worktree list` mid-review — indistinguishable, from the
outside, from a skeptic that simply failed). The subtree walk `collect` already
does is the signal, so it also reports whether every descendant has been observed
finishing — read from each descendant's OWN transcript, because the skeptics are
background spawns and the reviewer's transcript holds only their spawn
acknowledgements. Remove the reviewer's throwaway worktree only when it says so:

```bash
# reviewer stage only
if [ "$(jq -r .subtreeDone "$TMP/collected-<N>.json")" = "true" ]; then
  git worktree remove ".worktrees/review-<N>" --force
fi   # else leave it: the two sweeps below remove it
```

Never poll or wait on that flag. A skeptic that is still working, one that is
narrating between tool calls, one that died mid-tool-call, and one whose
`agent-<id>.meta.json` could not be parsed (parentage unknown, so possibly one of
these skeptics — and a half-written sidecar is likeliest at spawn, when the child
is youngest) all read `false` — and `false` means leave it and move on, never
retry. `true` is the common answer for a skeptic that actually returned: a
turn-ending `stop_reason` in its own transcript is proof on its own and needs no
settling window (measured: 1,310 of this machine's 1,532 finished sub-agent
transcripts end that way, and ZERO of 10,517 mid-work records carry one). The
15-minute window (`SUBTREE_QUIET_MS`) covers only the ~15% of real returns whose
last record carries no stop reason, and an 8-hour ceiling (`SUBTREE_STALE_MS`)
eventually clears a transcript nobody has written to at all — without it, one agent
killed mid-tool-call held the sweep open forever. All three failure directions are
the cheap one: the cost is a leftover directory, against destroying a running
skeptic's workspace.

The sweep that collects the leftovers is a **command, not a habit** (#209 — it used
to be one sentence in Step 7 with nothing to run, and nine `review-*` worktrees had
piled up in this repo by the time anyone counted). `bun "$PACK/lib/reconcile.ts"
sweep-review` removes them and nothing else, and it **carries this same gate rather
than working around it**: it removes nothing while any sub-agent of this session is
still unproven, and prints who is live instead. That is not belt-and-braces — an
ungated sweep would re-create #66's failure at a different moment, because a
reviewer returning with skeptics still executing is the DESIGNED case: it checks
each skeptic at most once and stops waiting. It is called twice so no exit path
leaks: **Step 7's batch cleanup** on drain-complete, and **Step 0** of the next run,
right after the loop-lock acquire proves no other loop is running. Neither call
asserts the session is quiet — both ASK, and print what they found; a fresh session
with no `subagents/` directory sweeps everything, a session mid-flight sweeps
nothing and says who is live. Step 0 is also what covers the exits Step 7 never
reaches, a `context-clear` pause and any crash. `reconcile apply` prunes them too
(they are in the orphan scan now), under the same hold and never in place of the
lane recovery it is there for; but they never count toward `hasOrphans`: a
leftover scratch checkout is litter, not a wedge, and gating startup on one would
refuse to start after almost every run.

Then price the ticket's whole directory — the glob accumulates every stage so far,
and z-cost dedupes by requestId, so its total IS the cumulative and you never add
dollars in prose. This deterministic naming is also what lets the end-of-loop
spend-by-stage table (Step 7a item 5) attribute dollars per stage instead of only
per ticket (`stageOfFile` splits on the first `-`, so a `-sub-` file buckets under
the stage that spawned it):

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

**Per-stage budgets and the ceiling (#256).** `watchdogMinutes` is resolved per
STAGE, not once per run: the shipped defaults are builder 25 / qa 15 /
reviewer 40 / merge 15 minutes, each derived from that stage family's own
measured worst silence and floored at the 15 minutes every agent needs (a
reviewer blocked on three background skeptics legitimately goes 19 minutes
quiet; a merge stage never goes 2). A config holding a plain number still means
one budget for every stage. Nothing here is yours to compute — `next` resolves
it. Separately, a lane whose CURRENT stage has held it for
**480 minutes** parks Blocked no matter how many times its worker answered
ALIVE; that park is what makes the alive path terminate, and its note names the
stage, the elapsed minutes and the ceiling. Run it like any other `park N
Blocked` row (it carries `"salvage": true`, so dump the worktree patch first).

**Silence, not stage age (#256).** `watchdogMinutes` measures how long a lane's
stage-spawn subtree has appended NOTHING to its transcripts — not how long the
stage has been running. `z-loop-tick` reads that for you: every tick, after the
ingest and before `next`, it runs
`bun "$PACK/lib/loop.ts" heartbeat "$STATE" --slug "$SLUG" --project-dir "$PWD"`,
which resolves each live lane's spawn tag (`spawnTag(slug, ticket, stage,
attempt)` — recomputed from the lane, never stored) and moves its baseline
forward to the newest record in that subtree, the stage agent's own plus every
descendant's. Nothing here is yours to judge and there is no extra command to
run. Two properties worth knowing when you read a tick's stderr: the move is
**monotonic** (an observation older than the baseline changes nothing), and an
unresolvable subtree is a **no-op that says so on stderr** — that lane silently
falls back to the pre-#256 stage-age behavior, which is why the note is worth
reading rather than ignoring. Before this, a healthy QA stage crossed the budget
on age alone (its mandatory typecheck + suite + build runs 121s idle, 234s
loaded) and got probed while working.

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
4. `"$Z_BOARD" move <N> Done --if-present` and apply the action. The issue stays
   OPEN — a human reviews Done tickets and closes them (never `gh issue close`).
   On `moved:false` (#138 — the ticket left the board after this tick's last
   confirm pass) apply the **`complete`** action anyway, NOT the `stop-lane` the
   park/skip rows use: the PR really landed, and `complete` is the only reducer
   that records #N in `mergedThisRun`. Dropping that record breaks a stacked
   child's step-18 retarget and lets Step 7's branch delete close the child's PR
   — the same H9 reason a dead merge lane is never blind-skipped. The board
   cannot show Done for a ticket that is no longer on it; `state.json` carries
   the truth and the lane is released either way, so the completion flow
   finishes normally instead of aborting on the move.
5. `git worktree remove ".worktrees/ticket-<N>"`. Do NOT delete the branch yet
   — a dependent PR may stack on it (branch cleanup is Step 7).

## Step 7 — Exit (on `drain-complete`)

1. **Batch cleanup:** every dependent PR has landed, so delete the merged
   `z/ticket-*` branches now (PROCESS.md step 18: delete last), then sweep the
   leftover throwaway review worktrees with the command that owns them (#209 —
   this used to be a sentence with nothing to run, and nine `review-*` worktrees
   had piled up in this repo by the time anyone counted):

   ```bash
   bun "$PACK/lib/reconcile.ts" sweep-review
   ```

   No board read, no slug, no locks — it removes `.worktrees/review-<N>` (and the
   `-lead`/`-base` variants) and nothing else, so it is safe with the loop lock
   still held. Every LANE is finished by the time this runs, but their sub-agents
   need not be: the last reviewer's skeptics can still be executing minutes later
   (the reviewer checks each at most once and stops waiting), so the command
   applies its own liveness gate here and prints `swept 0 …` instead of removing a
   worktree out from under one. A stage agent that returned normally does NOT hold
   it open — its transcript ends on a turn-ending `stop_reason`, which reads
   finished immediately — so a genuinely quiet session sweeps here. Do not treat
   `swept 0` as a failure and do not retry it: those leftovers go to Step 0 of the
   next run. Exits that never reach Step 7 (`context-clear`, a crash) are covered
   by that same Step 0 sweep and by its `reconcile apply`.
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
a Backlog bug, NO deploy Skill is ever invoked. Iterate
`bun "$PACK/lib/endloop.ts" findings "$TMP/regression.json"`, NEVER
`regression.json`'s raw `.findings` directly -- a red verdict with an empty
`findings[]` (a gate-wiring anomaly, not a real "nothing to file") degrades to
one generic bug there instead of this step silently doing nothing (issue #151):

```bash
bun "$PACK/lib/endloop.ts" findings "$TMP/regression.json" | jq -c '.[]' | while read -r FINDING; do
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
- `spendByStage`: price the WHOLE batch's transcripts per-file, then fold
  per-file into per-stage — this is what answers "which stage eats the
  money" instead of just "how much did the ticket cost":

  ```bash
  "$Z_COST" --json --by-file "$STATE_DIR/transcripts/*/*.jsonl" > "$TMP/cost-by-file.json"
  bun "$PACK/lib/endloop.ts" spend-by-stage "$TMP/cost-by-file.json" > "$TMP/spend-by-stage.json"
  ```

  Splice `"$TMP/spend-by-stage.json"`'s array into `report-input.json` as
  `spendByStage` verbatim — omit the key entirely on a batch with zero
  drained tickets (no transcripts glob to price) rather than pricing an
  empty pattern.

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
> distinct logins or distinct projects. A dedicated bot GitHub identity per
> loop (issue #66; see docs/user-guide/bot-identity.md and z-setup/SKILL.md
> Step 7) is the supported way to get that distinct login without creating a
> second human account -- it does not add cross-machine coordination (a
> second loop under a DIFFERENT bot login still needs a distinct project, or
> the same race above), it just makes "distinct logins" cheap and
> attributable instead of a spare personal account.

**Startup, without `--reconcile`:** if `loop.lock` is live → refuse (name the
session). If it is stale, or any orphans exist (lane locks with no running loop,
worktrees with no lock, Building tickets with neither) → refuse and tell the
human to re-run with `--reconcile`.

**Startup, with `--reconcile`:** `bun "$PACK/lib/reconcile.ts" apply --slug "$SLUG" --session "$SESSION"`
first clears the wedge, then the loop starts normally. Reconcile:

- **releases claims** — `z-board release <N>` unassigns the ticket so it can be
  re-claimed;
- **parks tickets back to Ready** — `z-board move <N> Ready`;
- **prunes worktrees** — `git worktree remove --force` (a crashed builder's
  uncommitted work is discarded; the ticket rebuilds fresh from Ready);
- **prunes leftover throwaway review worktrees** — `.worktrees/review-<N>` and its
  `-lead`/`-base` variants (#209). Prune only, never a release or a park: the
  number names the ticket the review was FOR, which is very likely Done by now,
  and there is no work inside to lose. Since #209 gates in-run removal on the
  reviewer's whole spawn subtree going quiet, leftovers are the norm rather than
  the exception, so this scan (plus the `sweep-review` calls at Step 0 and Step 7)
  is what keeps them from accumulating across runs. These prunes take the same
  liveness hold as `sweep-review` — held back, never the whole reconcile, if any
  sub-agent of this session is still unproven — so no path removes a review
  worktree while something may be inside it;
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
