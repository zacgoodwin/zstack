# /z-loop

The drain-and-exit orchestrator. Runs a planning pass over Ready tickets,
leaves the workable ones in Ready and moves each to Building when its builder
lane claims it, then drives up to `maxLanes`
concurrent worktree lanes through four fresh-agent stages (builder → QA →
adversarial reviewer → merge) until the batch is drained, runs the end-of-loop
stage on the merged base, writes a report, and exits. No daemon.

Full skill contract: `z-loop/SKILL.md`.

## When to run it

Fill Ready with planned tickets, then:

```bash
/z-loop              # drain the Ready queue once and exit
/z-loop --reconcile  # clear a crashed prior run's wedge, then start
```

## How it works

You are not in the loop; the deterministic core is. The orchestrator only ever
asks the state machine what to do next (`lib/loop.ts next`), performs that one
action's side effects (a `z-board` write, a git move, one fresh Agent spawn), and
records the result. It never re-derives a scheduling decision in prose.

- **One fresh agent per stage.** Every stage is a new harness Agent built from a
  pure prompt constructor (`lib/stage-prompts.ts`). Nothing latent travels between
  stages; the reviewer is blinded to exactly the ticket, its acceptance criteria,
  the diff, and a throwaway worktree.
- **Planning-pass fold-in gate (PROCESS.md step 6).** Before a Ready ticket can
  reach Step 2's batch commit, the planning pass reads its comments and folds
  in the newest one from anyone other than the loop's own session login. If
  that comment raises a new question the plan doesn't already answer, the
  ticket never enters the batch: it's posted back as a `## Needs input —`
  comment and parked in Questions instead — the same don't-start mechanism
  as any other open question, never a silent guess into the plan.
- **Bounded orchestrator context.** The orchestrator holds no ticket context. Each
  stage's payload (body, diff) is assembled off-context into `input-<N>.json` and
  the printed prompt is a *pointer* to that file — small and payload-independent —
  so reading it to spawn the Agent stays cheap. And each drain iteration is a
  single `bin/z-loop-tick` call (snapshot → ingest → `next`) that prints only the
  one-line next Action, so the repeated bash never re-enters context. A long
  batch drains in one session without tripping auto-compaction.
- **Adversarial review, when the card earns it.** When `adversarialMode` is
  active for a card, the Review stage runs a super-truth pass: it fans out
  independent skeptic sub-agents that each try to REFUTE the diff against the
  acceptance criteria, then reconciles them into an aggregated `confidence`
  (0–100). When inactive it is today's single pass. Activation is deterministic —
  a pure function of the diff's changed-line count, the issue's labels, and the
  `adversarialMode` knob (default `non-trivial`: a ≥ 10-line diff OR a
  `security`/`migration`/`payments`/`auth` label; `off` never, `always` every
  card). The confidence rides in the reviewer's exit marker.
- **A low-confidence approval does not merge.** The reviewer always reports a
  self-assessed (or, on a super-truth pass, skeptic-aggregated) `confidence`
  0–100 on its `REVIEW-APPROVE`. An approval below `minReviewerConfidence`
  (default 70) never reaches the merge gate: per `reviewerBelowThresholdAction`
  (default `block`) it parks the ticket Blocked with
  `truth-check failed (confidence X/100)`, bounces it back to the builder
  (`retry`), or is ignored entirely (`off`). A `REVIEW-APPROVE` with no
  parseable confidence is treated the same as a sub-floor score — fail-closed,
  never a silent merge — whenever the gate is on.
- **Reviewer->builder bounces are capped.** A `REVIEW-FINDINGS` and a
  `reviewerBelowThresholdAction: "retry"` both send the ticket back to the
  builder from Review, and both draw on the same per-lane budget: at config
  `maxReviewBounces` (default 2), the ticket parks Blocked with
  `review bounce cap reached (N/N)` instead of bouncing again — the same
  no-token-burn discipline as the QA-bounce cap below, closing the one retry
  path (issue #62) that could otherwise loop builder->QA->review forever on a
  ticket the reviewer never gets confident about (issue #76).
- **Dependency-ordered, capped concurrency.** A dependent is not claimable until
  its dependencies are Done; at most `maxLanes` (default 3) lanes run at once;
  merges happen one at a time in topological order (stacked chains retarget the
  base and delete branches only at batch end).
- **Optional tick throttle.** `bin/z-loop-tick` sleeps out the remainder of
  the `tickThrottleSeconds` config knob (default `0`, off) before starting its
  next snapshot+ingest+`next` cycle, once the knob is set above its default.
- **No token burn.** Every ticket ends the run in Done, Questions, Blocked, or
  Skipped. QA bugs bounce to a fresh builder: from QA-bounce config
  `qaInvestigateAfter` (default 2) onward, the rebuild runs `/investigate`
  first; at config `maxQaPasses` (default 3), the ticket parks Blocked instead
  of bouncing again. A worker silent past the watchdog (default 10 min) is
  probed and then Skipped with a note. Exception: a dead merge lane is verified
  via PR state and ends Merged or Blocked, never Skipped.
- **Actual per ticket.** After each stage the ticket's transcripts are priced with
  `bin/z-cost` (dedup by requestId) and written to the Actual field.
- **Per-stage transcript layout.** Each stage's copy lands at
  `~/.zstack/projects/<slug>/state/transcripts/ticket-<N>/<stage>-<attempt>.jsonl`
  — `<stage>` is `builder`/`qa`/`reviewer`/`merge`, `<attempt>` is that lane's
  1-based spawn count for the stage (a QA bounce or a reviewer bounce, either
  one, re-spawns builder — so `builder-3.jsonl` might follow one bounce of
  each kind, not necessarily three QA passes). This naming is what lets the
  end-of-loop report break spend down by stage instead of only by ticket.
- **Per-stage model routing.** The merge stage is mechanical (`gh pr create`, a
  conflict check, `gh pr merge`) and doesn't need the ticket's build-tier
  model; the `stageModels` config knob (default `{"merge": "haiku"}`)
  downshifts it for a direct cost cut. See below.

## Skip QA

Add the `skip-qa` label to a GitHub issue and a finished builder advances
straight to Review (Building → Review), skipping the QA stage entirely. Use it
when QA adds little over the reviewer's own correctness pass — an error fix,
answering a question, or resolving a blocker — where a human at triage has
already decided the change is low-risk. The label rides the board snapshot, so
the decision is a one-click human classification, not the builder's own call.

The reviewer still runs: `skip-qa` skips QA, never the last correctness gate.
Every ticket without the label runs the full builder → QA → reviewer → merge
pipeline, and the QA bounce/investigate machinery is unchanged.

## Ticket and context limits

Two knobs cap a single `/z-loop` run so a large Ready queue or a long drain
never runs away with itself. Both are hand-edited in
`~/.zstack/projects/<slug>/config.json` (see
[z-setup.md → Config knobs](z-setup.md#config-knobs-hand-edit-configjson-after-setup))
and both default to today's behavior.

### `ticketLimit` — a per-loop ticket cap

`ticketLimit` (default `0` = no cap) caps how many tickets one run works. At the
default, every gated Ready ticket is workable, exactly as before. Set it to `3`
and the run flags **the batch**: a dependency-self-contained allow-list of at
most three tickets, captured once at Step 3's ingest and held on
`state.batchTickets`. The remaining Ready tickets stay Ready and are simply
picked up by a future run — they are never claimed, never counted against this
run's drain, and never mis-parked as blocked.

The batch is chosen by a Kahn walk in ascending issue number: a ticket is
flagged only when every dependency is already Done or already flagged, so a
flagged ticket never depends on an un-flagged one. A dependent whose dependency
doesn't fit under the cap just waits — it stays Ready (a Ready dependency is not
terminal), so the dead-dependency park never touches it. The allow-list
persists verbatim across every re-ingest and across a context clear, so the run
always finishes the exact batch it started.

### `contextTokenLimit` — a context ceiling with clear-and-resume

The orchestrator is one long-lived session that holds no ticket context by
design, but its own window still fills across a long drain (per-tick ticks,
stage final messages, completion notes). `contextTokenLimit` (default `550000`,
`0` disables) pauses the run before the harness auto-compacts.

Every tick, `bin/z-loop-tick` measures the orchestrator's **current** window
occupancy deterministically — the input side (input + cache-read +
cache-creation tokens) of its session transcript's most recent request, via
`lib/context-budget.ts`. This is *not* cumulative billed spend (that is
`z-cost`); it is how full the window is right now, the only thing a context
clear actually changes. The reading is **fail-open**: an unresolvable or
unreadable transcript reads `0`, so a measurement hiccup degrades to no gating
and never wedges a drain.

When the reading reaches the limit, the scheduler stops **claiming** new
tickets — no new ticket enters Building — while in-flight lanes keep draining
normally to their terminal state. Once every lane is idle with batch work still
remaining, `next` returns a `context-clear` action instead of waiting forever:
the loop releases its lock, keeps every worktree, branch, and the un-drained
`state.json`, and exits **without** running the end-of-loop stage (the batch
isn't done, so nothing deploys). The operator or harness then clears the
session's context and re-invokes `/z-loop`. The fresh orchestrator reads a small
context on its first tick, so claiming resumes immediately — on the *same*
batch, because the built tickets have left Ready and `batchTickets` persisted in
`state.json`. If the batch happens to finish exactly at the ceiling, normal
`drain-complete` wins; `context-clear` fires only when work genuinely remains.

The two knobs are independent: the ticket cap bounds *which* tickets a run
touches, the context ceiling bounds *when within* a run the orchestrator pauses
to clear.

## End of loop

After the batch drains, the end-of-loop stage runs a regression on merged main
(typecheck / test / build detected from `package.json`, plus gstack `/qa-only`):

- **Red** → every finding is filed as a Backlog bug with repro + first-suspect
  file, and **no deploy skill runs**.
- **Green** → `/land-and-deploy` → `/canary` → `/document-release`, in that order,
  each logged as it returns.
- **Every Nth loop** (the persisted loop counter, red or green) → `/cso` +
  `/health`, findings filed to Backlog. `N` is the config knob
  `auditEveryNLoops` (default 5) in `~/.zstack/projects/<slug>/config.json` —
  set it lower (e.g. 3) for a high-churn repo, higher (e.g. 10) for a
  docs-only one. Must be a positive integer; invalid values fail `loadConfig`
  loudly rather than silently falling back.

It writes `reports/loop-<ts>.md` and bumps `~/.zstack/projects/<slug>/loop-counter`.

### Reading the spend-by-stage table

The report's `## Spend by stage` section answers "which stage ate the money"
for the batch just drained, not just "how much did each ticket cost":

```text
## Spend by stage

| Stage | Spend |
|---|---|
| builder | $12.40 |
| qa | $3.10 |
| reviewer | $0.85 |
| merge | $0.20 |
| other | $0.00 |
```

It's built from `bin/z-cost --json --by-file` over every stage transcript in
the batch (`state/transcripts/*/*.jsonl`), folded per-stage by
`lib/endloop.ts`'s `sumByStage`. All five rows always render, `$0.00`
included — a run with no reviewer bounces still shows the full shape instead
of a table that grows and shrinks between loops. `other` catches any
transcript file whose name doesn't match `<stage>-<attempt>.jsonl` (e.g. a
manually-dropped file). A loop run's report predating this feature simply has
no `## Spend by stage` section at all — the field is optional and the rest of
the report is unaffected.

Every other cost-cutting change (stage model routing, trimming the Files
section, tighter diff hygiene) can point at this table before/after to prove
it actually moved the needle, instead of eyeballing the total.

## Per-stage model routing

Every stage spawn — builder, QA, reviewer, merge — normally runs at the
ticket's board **Model** field. The merge stage is mechanical (`gh pr create`,
a conflict check, `gh pr merge`) and never needs the builder's model tier; QA
on a small ticket often doesn't either. The `stageModels` config knob lets a
project override any stage's model, resolved once per spawn by
`bun lib/loop.ts stage-model <stage> <ticketModel> --slug <s>`
(`resolveStageModel` in `lib/loop.ts`) — never re-derived in prose.

**Absent vs `{}` — the two states mean opposite things:**

- **Key absent from `config.json` entirely** — the pack default applies:
  `{"merge": "haiku"}`. Every other stage still resolves to the ticket's Model
  field.
- **Key present, even as `{}`** — used exactly as written, no default layered
  on top. An empty object opts every stage back to the ticket's Model field.

```json
{ "stageModels": { "merge": "haiku" } }
```

Only `builder`, `qa`, `reviewer`, `merge` are valid keys. Each value must be a
model rate key defined in `references/rates.json` (the same lookup
`z-cost`/`z-estimate` use — `opus`, `sonnet`, `haiku`, `fable`, or a matching
family substring); an unknown value fails `validateConfig` loudly, naming
`stageModels.<stage>`, never silently at spawn time.

`/z-setup` writes `{"merge": "haiku"}` into every newly-created project's
config. An adopted or already-configured project keeps whatever it already
has — add the key by hand to opt in (see
[z-setup.md → Config knobs](z-setup.md#config-knobs-hand-edit-configjson-after-setup)).

**It survives a later `z-setup` re-apply (issue #97).** Re-running `/z-setup`
against an already-set-up project can still genuinely rewrite `config.json`
(the board's shape drifted — a field was added, a status renamed). That
re-apply preserves whatever `stageModels` already sits in the file instead of
resetting it to the pack default or dropping it; the same holds for
`quota`/`notifications`/`adversarialMode`. Only a board that has never had a
config written for it (first-time setup) starts from the default above.

## Notifications

The loop can run for hours unattended. Point it at a Discord webhook and it posts
a message the moment something needs you or the batch finishes — no more watching
the terminal. Notifications are **off until configured**; an unconfigured project
is a silent no-op.

**1. Create a Discord webhook.** In Discord: **Server Settings → Integrations →
Webhooks → New Webhook**, pick the channel, then **Copy Webhook URL**. That URL is
a secret — anyone holding it can post to your channel.

**2. Give the URL to zstack**, either way:

- **Environment variable (recommended)** — keeps the secret out of every file:

  ```bash
  export ZSTACK_DISCORD_WEBHOOK="https://discord.com/api/webhooks/…"
  ```

  and turn notifications on in `~/.zstack/projects/<slug>/config.json`:

  ```json
  { "notifications": { "enabled": true } }
  ```

- **Config only** — put the URL directly in `config.json` (this file lives under
  `~/.zstack`, outside your repo, so it is never committed):

  ```json
  { "notifications": { "enabled": true, "discordWebhookUrl": "https://discord.com/api/webhooks/…" } }
  ```

  When both are set, `ZSTACK_DISCORD_WEBHOOK` wins. The URL must begin with
  `https://`; a pasted bare token is rejected by `loadConfig` (its error names the
  field only, never the value).

**3. The seven events**, each posted once at the moment the state machine
reaches it:

| Event | Fires when |
| --- | --- |
| `work-complete` | a `/z-loop` drain finishes — counts + spend + regression verdict |
| `plan-complete` | a `/z-plan` run finishes — tickets created/updated, no loop counts or spend |
| `human-pause` | a ticket parks to **Questions** waiting on your input |
| `ticket-parked` | a ticket is moved to **Blocked** or **Skipped** by the work |
| `safety-violation` | a safety control tripped (a wedged/dead worker; GraphQL quota exhausted) |
| `token-burn` | a spend/deadlock anomaly (no lane can make progress) |
| `human-needed` | a batch's parked tickets cross `humanNeededPercent` mid-run (once per batch — see below) |

Every event defaults **on**. Toggle any of them under `notifications.events`
(a missing key stays on):

```json
{ "notifications": { "enabled": true, "events": { "work-complete": false, "human-pause": true } } }
```

Set `"enabled": false` to mute everything without deleting the block.

**Security.** `config.json` sits under `~/.zstack`, outside the repo, so the URL
is never committed. zstack never writes the URL to a log line or into a message
body. Treat the webhook like a password: anyone with it can post to your channel.
To rotate or revoke, delete the webhook in Discord (Server Settings → Integrations
→ Webhooks) and create a new one. A failed post is logged (event + error, never
the URL) and dropped — a down webhook never stalls or crashes the loop.

## Human-needed safety control

`PROCESS.md`'s no-token-burn rule guarantees every ticket ends a batch in Done,
Questions, Blocked, or Skipped — but a batch can still be quietly going
sideways mid-run, e.g. 6 of 10 committed tickets piled up in
Blocked/Skipped/Questions while the loop happily keeps draining the rest. The
`humanNeededPercent` config knob (default 30, `0` disables) pages you the
moment that happens instead of leaving you to discover it only at the
drain-complete report.

**Threshold.** Every drain tick (`bin/z-loop-tick`, right after it re-ingests
the board), the loop recomputes:

```text
(Blocked + Skipped + Questions) / initialReadyCount * 100
```

`initialReadyCount` is the number of workable Ready tickets the batch committed
to work, held in Ready until each is claimed — the batch's size at
ingest-time-zero (Step 3's ingest, before Step 4 claims anything), captured once
from the Ready count and carried across every re-ingest for the rest of that
batch. The instant this percentage first exceeds `humanNeededPercent`, the
control trips.

**Once per batch.** The first tick that trips the control fires exactly one
`human-needed` Discord notification — the exact parked counts and which
ticket numbers — through the same `lib/notify.ts` transport as the other
events above, then sets a fire-once flag so it never re-fires for the same
crossing. A fresh batch resets both the committed-size baseline and the
fire-once flag, so the control is live again from zero — but "fresh" is a
two-part test, not just "the prior batch fully drained": there must be no
prior state at all, OR the prior state was fully drained **and** the
incoming board snapshot shows new, **unclaimed** Ready tickets (the committed
queue now sits in Ready until each ticket is claimed, so any unclaimed Ready
ticket in a post-drain snapshot IS that new batch; a lingering `claimedByOther`
Ready ticket belongs to another session's batch and does not count). The prior
batch being drained is
necessary but not sufficient: a tick that merely re-confirms the SAME drained
batch (no new, unclaimed tickets committed — e.g. the very tick right after
that batch's own last ticket parks or completes, which is what first makes it
"drained") is not a new batch, so it keeps that batch's baseline and
fire-once flag rather than resetting them — otherwise the batch's
highest-value crossing, its last ticket tipping it over the threshold, would
reset to a zero baseline the instant it happens and never trip. It is **not**
re-evaluated again within the same tick after that tick's one scheduling
action applies — same once-per-iteration cadence as every other signal in the
drain loop.

**Depends on `notifications`.** Like the other six events, `human-needed` is
governed by the `notifications` block above: absent/disabled/unconfigured means
the send is a silent no-op, and because the fire-once flag is set only after a
send actually reports delivered, the control keeps trying every tick without
ever wedging — the moment `notifications` IS configured, the next tick's send
succeeds and the notification finally reaches you. It is independently
toggle-able via `notifications.events["human-needed"]` the same as any other
event; see
[z-setup.md → Config knobs](z-setup.md#config-knobs-hand-edit-configjson-after-setup)
for the `humanNeededPercent` knob itself.

## Stopping a running loop (z-stop)

`/z-loop` drains the whole batch before it exits — there is no early "stop after
this" flag inside the run. To stop a drain **gracefully**, open a second terminal
on the same machine and run:

```bash
bin/z-stop            # or: bin/z-stop --slug <slug>
```

`z-stop` finds the running loop through its `loop.lock` and, when that lock is
live, drops a single sentinel file (`~/.zstack/projects/<slug>/loop/stop-requested`,
next to `state.json`). It writes nothing to the board and nothing to the loop's
state file, so it can never race the loop's single writer — it just leaves the
sentinel for the loop to notice.

On its **next tick** the loop sees the sentinel and switches to stop mode:

- **pulls no new tickets** — nothing new enters Building;
- **lets in-flight lanes finish** — a lane already building/QA-ing/reviewing/merging
  runs through to Done exactly as it would have; workers are never killed;
- **returns unworked tickets to Ready** — anything committed to the batch but not
  yet claimed goes back to the Ready queue for the next run;
- **exits through the normal end-of-loop** — once every lane is done it reaches
  `drain-complete` and runs Step 7a (regression → deploy-on-green → report) like
  any other drain, then clears the sentinel.

If no loop is running, `z-stop` says so and does nothing. If the loop **crashed**
(a stale lock), there is no live process to observe the signal, so `z-stop` tells
you to run `/z-loop --reconcile` instead and writes no sentinel.

**Per machine, like the loop lock.** `z-stop` targets a loop running on *this*
machine. A loop running under the same login on another machine is not reachable —
the same limitation the `loop.lock` second-invocation guard has. To stop a
mid-stage worker *now* (not gracefully), kill the loop session and run
`/z-loop --reconcile` to clean up.

## --reconcile (crash recovery)

A crashed loop leaves lane locks, stray worktrees, or Building tickets with no
live lane, and its `loop.lock` goes stale. A normal `/z-loop` **refuses to start**
on any orphan (or names the live session if a loop is genuinely running).
`/z-loop --reconcile` releases claims, parks affected tickets back to Ready,
prunes worktrees, and clears the stale lock — then starts. It never deletes a
branch, never touches a ticket with a live lane. A running loop's lock is never
cleared: you cannot reconcile over a live loop.

Mid-run, dragging a Building/QA ticket to Blocked or Questions on the board is
respected: the loop stops that one lane cleanly at its next stage boundary and
keeps the others running.

## Done when

Every in-flight ticket is Done/Questions/Blocked/Skipped; Done tickets stay OPEN
with a completion note (acceptance criteria passed, to-check-X-do-Y-expect-Z
edges, filed Backlog tickets, Actual); the end-of-loop verdict ran; the report
exists; the counter was bumped; and every scheduling decision came from the CLI,
not prose.
