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
7. **Auto-approvals (optional).** Offers to reduce Claude Code permission prompts
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
assembles the rest of the config fresh from the live board every run, but four
fields have no CLI flag and exist only because you hand-edited them in:
`stageModels`, `quota`, `notifications`, `adversarialMode`. Whatever value one
of these carries in the config file on disk wins over the freshly-assembled
default the next time `apply` genuinely rewrites the file (a board-shape
change forced a real `writeConfig`, not the common no-op re-run). A field you
never added stays exactly as it would today. `maxLanes`/`watchdogMinutes` are
not in this set — they have a `--max-lanes`/`--watchdog-minutes` CLI flag, so
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
- `quota.threshold` (default 100) — the GitHub GraphQL rate-limit guard trips
  when remaining points fall below this before any board call.
- `quota.mode` (default `"sleep"`) — `"sleep"` waits until the rate-limit window
  resets (`resetAt`) and then proceeds; `"abort"` fails the call immediately
  instead of waiting.
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
- `maxReviewBounces` (default 2) — reviewer->builder bounces (a
  `REVIEW-FINDINGS`, or a `reviewerBelowThresholdAction: "retry"`) on a ticket
  before it parks Blocked with `review bounce cap reached (N/N)` instead of
  bouncing again (issue #76). Both routes share one budget on the lane. Must
  be a positive integer — a fraction, zero, or a negative is a loud config
  error, never a silent fallback.
- `stageModels` (default `{"merge": "haiku"}` on a brand-new project's
  config; omitted entirely on an adopted/pre-existing one) — per-stage model
  overrides for the loop's four stage spawns (builder/qa/reviewer/merge). Key
  absent -> the default above applies; key present, even as `{}` -> used
  exactly as written, no default layered on. Each value must be a model
  rate key in `references/rates.json` (the same lookup `z-cost`/`z-estimate`
  use), checked by `validateConfig`. An already-set-up project that predates
  this knob (or was adopted) never gets it auto-added — add it to
  `config.json` by hand to opt in, and it survives every later `z-setup`
  re-apply (issue #97 — see the note above). Full semantics:
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
  `config.json` exists and loads, `/setup-deploy` ran, and the auto-approvals
  offer was made (its A/B/C answer does not gate Done). A re-run makes zero
  changes.

## Common snags

See `troubleshooting.md`: gh scope refresh, and the settings.json write-race note
if a prompt slips through right after choosing A (restart the straggler session).
