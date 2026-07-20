# /z-loop

The drain-and-exit orchestrator. Runs a planning pass over Ready tickets,
batch-commits the workable ones to Building, then drives up to `maxLanes`
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

`initialReadyCount` is the number of tickets the batch committed to Building
at Step 2/3 — the batch's size at ingest-time-zero, captured once and carried
across every re-ingest for the rest of that batch. The instant this percentage
first exceeds `humanNeededPercent`, the control trips.

**Once per batch.** The first tick that trips the control fires exactly one
`human-needed` Discord notification — the exact parked counts and which
ticket numbers — through the same `lib/notify.ts` transport as the other
events above, then sets a fire-once flag so it never re-fires for the same
crossing. A fresh batch resets both the committed-size baseline and the
fire-once flag, so the control is live again from zero — but "fresh" is a
two-part test, not just "the prior batch fully drained": there must be no
prior state at all, OR the prior state was fully drained **and** the
incoming board snapshot shows new, **unclaimed** Building tickets (the
batch-commit step moves the whole new batch to Building before its first
ingest, so any unclaimed Building ticket in a post-drain snapshot IS that new
batch; a lingering `claimedByOther` Building ticket belongs to another
session's batch and does not count). The prior batch being drained is
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
