# /z-setup

One-time, per-repo setup for the zstack dev loop. It creates (or adopts) a GitHub
ProjectV2 board with the canonical nine statuses and four custom fields, turns off
the workflow rules that fight the loop, wires deploy, and writes the config every
other z-tool reads. Idempotent: re-running adopts what already exists and changes
nothing.

Full skill contract: `z-setup/SKILL.md`.

## When to run it

Once per repo, before the first `/z-plan`. If `~/.zstack/projects/<slug>/config.json`
does not exist yet, you need `/z-setup`.

## What it does

1. **Preconditions.** Checks gstack, bun, gh, and — the one that actually bit us
   live — that your gh token has the `project` scope. If not, it prints and runs
   `gh auth refresh -s project` and re-probes before continuing.
2. **Epic style (D1).** Records `epicStyle: "milestones"` (one GitHub milestone
   per epic). The sub-issue alternative (`issue-type`) is not yet supported —
   setup and config validation reject it until a create path exists (issue #14).
3. **Create/adopt the board.** Previews the exact changes (`z-setup-board plan`,
   zero writes), then applies: nine statuses (Backlog, Ready, Questions, Building,
   QA, Review, Blocked, Skipped, Done) and four fields (Model, Model Effort,
   Estimate, Actual). Idempotent.
4. **Workflow rules (manual).** GitHub exposes no API for built-in workflows, so
   it prints exact steps and requires you to confirm two are OFF: **auto-archive**
   and **auto-close-issue-on-Done**. The loop leaves Done tickets open for human
   review; auto-close would pull them out of view.
5. **Verify (scripted).** `z-setup-board verify` walks the live board and exits
   non-zero on any drift — no eyeballing.
6. **Wire deploy.** Invokes gstack `/setup-deploy` so `/land-and-deploy` works at
   end of loop.
7. **GitHub identity (issue #66, not optional).** Should `/z-loop` run as its
   own dedicated bot GitHub account, or continue under the owner's own login?
   A fresh project (or one that predates this step) must leave with an
   explicit answer recorded in `config.json` — this DOES gate Done, unlike
   Step 8 below. A project that already answered is left untouched and the
   step reports so (idempotent). Continuing as the owner's account is fully
   supported, but the step states its cost first: issue #204's fold-in gate
   can never see the owner's own ticket comments as "someone else's" while
   the loop shares their login, so a standing instruction left in a comment
   is invisible to the planning pass. On an **organization-owned** repo, the
   re-verification that runs on every later re-run can't compare the active
   `gh` login against a personal owner login (an org has no such login) —
   it reports the raw facts and asks you to eyeball them instead of guessing.
   Full walkthrough (account, permissions, token, `gh` auth, verification,
   the org caveat): [bot-identity](bot-identity.md).
8. **Auto-approvals (optional).** Offers to reduce Claude Code permission prompts
   so the loop runs unattended. **This edits `~/.claude/settings.json`, which is
   machine-wide.** Three choices:
   - **A) Full auto-approvals** — a permission-allow hook + `bypassPermissions`
     default mode + broad allow rules. Zero prompts, this session and every future
     one. Biggest blast radius.
   - **B) Loop allowlist only** — specific allow rules for `git/gh/bun/bunx`
     only, no hook, no mode change. Deliberately excludes `bash`/`claude` and
     blanket Edit/Write, so Edit, Write, and any novel command still prompt —
     the smallest blast radius, not fully unattended.
   - **C) Skip** — no permission changes.
   Applied only through `bin/z-setup-permissions` (atomic write, JSON-validated,
   never clobbers existing keys). `z-setup-permissions --check` reports which of
   the three layers are present. Undo with `bin/z-setup-permissions --remove`.

## Board shape template

The board shape — the nine statuses and four custom fields — is data, not code:
it lives in the shipped `z-setup/board-template.json` and is loaded and validated
by `lib/board-template.ts` before any board mutation runs. The default template is
1:1 with the shape `/z-setup` created when it was hardcoded (same statuses in
order, same fields and options, same option colors).

The file has three sections:

- **`statuses`** — each with a `name`, a GitHub option `color` (one of GRAY,
  BLUE, GREEN, YELLOW, ORANGE, RED, PURPLE, PINK), and a `description`. The status
  set must equal the canonical nine (`lib/config.ts` `BOARD_STATUSES`); the loop's
  state machine only knows those, so extra or renamed statuses are refused.
- **`fields`** — each with a `name`, a `dataType` (SINGLE_SELECT / NUMBER — the
  only types `/z-setup` can create; any other type, e.g. `TEXT`, is refused),
  and, for single-select, an ordered `options` list. The four fields the loop and
  z-tools hard-depend on — Model, Model Effort, Estimate, Actual — must be present
  with their dataTypes; dropping or renaming any of them is refused loudly, naming
  the field and the tool that breaks.
- **`views`** — the intended board views (a Status kanban, a milestone cost
  table). Validated shape-only.

**Override with `--template`.** Pass `--template <file>` to `z-setup-board plan`,
`apply`, or `verify` to use a variant instead of the packaged default. It goes
through the same validation, so an override that drops a required field or changes
the status set fails before touching the board.

**Views are manual.** GitHub's GraphQL API has no view-creation mutation (only a
read-only `ProjectV2View`), so `plan`/`apply` print the template's views as
explicit manual setup steps rather than creating them — never silently dropping
them. Add them by hand on github.com after setup.

## Config knobs (hand-edit `config.json` after setup)

Beyond the board IDs, `config.json` carries optional per-project tuning knobs,
each defaulted by `loadConfig` when absent:

**A re-apply preserves your hand-edits (issue #97).** `z-setup-board apply`
assembles the rest of the config fresh from the live board every run, but five
fields are instead carried forward from the prior config.json on disk:
`stageModels`, `quota`, `notifications`, `adversarialMode`, `identity`.
Whatever value one of these carries wins over the freshly-assembled default
the next time `apply` genuinely rewrites the file (a board-shape change forced
a real `writeConfig`, not the common no-op re-run). Of these, `stageModels`/
`notifications`/`adversarialMode` have no CLI flag and are absent unless you
hand-edit them in — a field you never added stays exactly as it would today.
`identity` (issue #66) likewise has no CLI flag, but isn't meant to be
hand-edited either — it's written by Step 7's identity step
(`bun lib/identity.ts record`) and preserved here for the same reason: a
later board-shape-drift re-apply must not silently erase a recorded
bot/human choice and force a re-prompt. `quota` is
different: `buildConfig` writes `{...DEFAULT_QUOTA}` into every config.json
unconditionally, hand-edited or not, so it is carried forward on every
re-apply from day one — including a *future* release changing `DEFAULT_QUOTA`,
whose new default an existing project's `config.json` would then never pick up
through this path (a known follow-up, not addressed here). A field whose value
on disk fails its own shape check (a corrupt hand-edit, e.g. `quota` as a
string) is treated as though it were absent — the fresh default wins for that
field only, the others are unaffected. `maxLanes`/`watchdogMinutes` are not in
this set — they have a `--max-lanes`/`--watchdog-minutes` CLI flag, so
re-running `/z-setup` with (or without) that flag is the supported way to
change them.

- `maxLanes` (default 3) — concurrent worktree lanes.
- `watchdogMinutes` (default 10) — silent-worker timeout.
- `lockStalenessMinutes` (default 60) — when a crashed loop's lock is judged stale.
- `auditEveryNLoops` (default 5) — how often the end-of-loop stage runs the
  `/cso` + `/health` audits (`loopCount % auditEveryNLoops === 0`). Lower it
  (e.g. 3) for a high-churn repo, raise it (e.g. 10) for a docs-only one. Must
  be a positive integer — `/z-loop` refuses to start with a loud error
  otherwise, never a silent fallback.
- `maxQaPasses` (default 3) — QA passes on a ticket before it parks Blocked
  instead of bouncing back to the builder (PROCESS.md step 16).
- `qaInvestigateAfter` (default 2) — the QA-bounce count at/after which the
  rebuild runs `/investigate` first instead of patching straight from QA's
  notes (PROCESS.md step 15).
- `humanNeededPercent` (default 30, 0 disables) — the mid-run breakdown
  notification's trip threshold: when `(Blocked + Skipped + Questions) /
  initialReadyCount * 100` exceeds this percent, the batch is judged to be
  going sideways and a human is paged once, through the same notify transport
  as the other loop events (issue #63/#60). See
  [z-loop.md → Human-needed safety control](z-loop.md#human-needed-safety-control).
- `ticketLimit` (default 0 = no cap, issue #131) — the maximum number of
  tickets a single `/z-loop` run works. Non-zero caps the run to a
  dependency-self-contained batch of at most that many tickets (the lowest
  issue numbers whose dependencies close within the cap); the rest stay Ready
  for a future run. Must be a non-negative integer — a fraction or negative is
  a loud config error. See
  [z-loop.md → Ticket and context limits](z-loop.md#ticket-and-context-limits).
- `contextTokenLimit` (default 550000, 0 disables, issue #131) — the
  orchestrator context-window occupancy (measured live each tick from its
  session transcript) at/above which the loop stops claiming new tickets and,
  once every lane is idle with batch work remaining, pauses with a
  `context-clear` so the operator can clear context and re-invoke to resume the
  same batch. Must be a non-negative integer. See
  [z-loop.md → Ticket and context limits](z-loop.md#ticket-and-context-limits).
- `quota.threshold` (default 100) — the GitHub GraphQL rate-limit guard trips
  when remaining points fall below this before any board call.
- `quota.mode` (default `"sleep"`) — `"sleep"` waits until the rate-limit window
  resets, re-probes the quota, and retries up to 3 bounded rounds. If the quota
  is still below threshold after 3 rounds, it aborts the run loudly with both
  readings (first and final) rather than proceeding on an unverified quota;
  `"abort"` fails the call immediately instead of waiting.
- `adversarialMode` (default `"non-trivial"`, values `off` | `non-trivial` |
  `always`) — when the Review stage fans out independent skeptic sub-agents
  (super-truth) instead of a single pass. `non-trivial` activates on a diff of
  ≥ 10 changed lines OR a `security` / `migration` / `payments` / `auth` label
  on the issue; `always` fans out on every card; `off` never does. An invalid
  value is a loud config error, never a silent fallback.
- `tickThrottleSeconds` (default `0`, off) — minimum wall-clock seconds
  between `bin/z-loop-tick` invocations. Set it to `120` to keep ProjectsV2
  GraphQL spend under GitHub's 5k/hr budget (~103 pts/tick × ~30 ticks/hr ≈
  3.1k/hr). Complements the reactive `enforceQuota()` backstop, which only
  intervenes once remaining points are already low. Hand-edited in
  `config.json`, same as `auditEveryNLoops`/`maxQaPasses`/`qaInvestigateAfter`
  — no `/z-setup` CLI flag.
- `minReviewerConfidence` (default 70) — the aggregated reviewer confidence
  (0–100) a `REVIEW-APPROVE` must clear to merge.
- `reviewerBelowThresholdAction` (default `"block"`, values `block` | `retry`
  | `off`) — what a sub-floor approval does: `block` parks Blocked with
  `truth-check failed (confidence X/100)`; `retry` bounces it back to the
  builder; `off` disables the gate entirely (a low-confidence or unparseable
  approval merges, the pre-#62 behavior).
- `minSkepticQuorum` (default 2, values 0–3) — how many of the 3 skeptic
  verdicts an **adversarial** `REVIEW-APPROVE` must actually have received for
  its aggregated confidence to merge (issue #191). One skeptic reporting "cannot
  refute" is `confidence=100`, which clears `minReviewerConfidence` and merges as
  though three reviews agreed; this is the denominator that stops it. A short
  quorum re-spawns the reviewer once, then parks Blocked. `0` disables the gate;
  `1` accepts a single opinion as an adversarial pass, which is the hole this
  closes — lower it only deliberately. Must be an integer 0–3: a floor above the
  fan-out could never be met, so it is a loud config error rather than a drain
  where every adversarial review parks Blocked. Projects with `adversarialMode:
  "off"` are unaffected (no fan-out, no token, nothing to judge).
- `maxReviewBounces` (default 2) — reviewer->builder bounces (a
  `REVIEW-FINDINGS`, or a `reviewerBelowThresholdAction: "retry"`) on a ticket
  before it parks Blocked with `review bounce cap reached (N/N)` instead of
  bouncing again (issue #76). Both routes share one budget on the lane. Must
  be a positive integer — a fraction, zero, or a negative is a loud config
  error, never a silent fallback.
- `stageModels` (default `{"merge": "haiku"}`, written into `config.json` on
  both a brand-new project and an adopted/pre-existing one — issue #156)
  — per-stage model overrides for the loop's four stage spawns
  (builder/qa/reviewer/merge). Key absent -> the default above applies; key
  present, even as `{}` -> used exactly as written, no default layered on.
  Each value must be a model rate key in `references/rates.json` (the same
  lookup `z-cost`/`z-estimate` use), checked by `validateConfig`. Want a
  different default? Hand-edit `config.json`; it survives every later
  `z-setup` re-apply (issue #97 — see the note above). Full semantics:
  [z-loop.md → Per-stage model routing](z-loop.md#per-stage-model-routing).
- `notifications` (absent = off) — Discord notifications for the seven loop/plan
  events (including `human-needed` — issue #63). Shape: `{ "enabled": true, "discordWebhookUrl": "https://…",
  "events": { "human-pause": false } }`. `enabled` is the master switch; each
  key under `events` toggles one event (all default on). The webhook URL is a
  **secret**: prefer the `ZSTACK_DISCORD_WEBHOOK` env var (it wins over the
  config value) so it never lands in a file, and note the URL must begin with
  `https://` or `loadConfig` rejects it (without echoing the value). Full setup:
  [z-loop.md → Notifications](z-loop.md#notifications).

`maxLanes` and `watchdogMinutes` can also be set at setup time with
`--max-lanes` / `--watchdog-minutes`; the others are hand-edited in
`config.json` directly.

## Done when

- The scoped GraphQL probe passed, `verify` exited 0, the two workflows are OFF,
  `config.json` exists and loads, `/setup-deploy` ran, the GitHub identity
  question was answered and recorded (Step 7, issue #66 — this DOES gate
  Done), and the auto-approvals offer was made (Step 8; its A/B/C answer does
  not gate Done). A re-run makes zero changes.

## Common snags

See `troubleshooting.md`: gh scope refresh, and the settings.json write-race note
if a prompt slips through right after choosing A (restart the straggler session).
