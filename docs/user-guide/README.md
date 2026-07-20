# zstack user guide

The full walkthrough, from a bare machine to your first green loop. The
[README](../../README.md) is the summary; this is the detail. Per-skill
contracts live next to each skill (`z-setup/SKILL.md` etc.) and each has a
shorter reference page here: [z-setup](z-setup.md) · [z-plan](z-plan.md) ·
[z-loop](z-loop.md) · [z-status](z-status.md) · [z-uninstall](z-uninstall.md) ·
[troubleshooting](troubleshooting.md).

## The mental model

You do the thinking at the edges; the loop does the work in the middle.

1. You write (or generate) a spec.
2. `/z-plan` turns it into tickets on a GitHub Projects board, each with a
   grounded plan, acceptance criteria, a model recommendation, and a dollar
   estimate. They land in **Ready**.
3. `/z-loop` drains Ready: for each ticket it spawns a fresh builder agent, a
   fresh QA agent, a fresh adversarial reviewer, and a fresh merge agent, in a
   git worktree, up to three tickets at a time, merging in dependency order.
   Then it regression-tests merged main and either deploys (green) or files
   bugs (red), writes a report, and exits.
4. You come back, answer anything parked in **Questions**, review the **Done**
   tickets, close them, and start the next batch.

Two design rules explain most of what you'll see:

- **Deterministic core decides, agents execute.** Which ticket runs next, when
  a worker is dead, what order merges happen, whether to deploy — all computed
  by TypeScript under `lib/`, never reasoned out in prose. Agents only do the
  latent work: writing code, judging QA results, reviewing diffs.
- **Nothing burns tokens while stuck.** Every ticket ends every run in exactly
  one of Done, Questions, Blocked, or Skipped, always with a comment saying
  why and what to do next. The loop never idles, never guesses, never stalls.

## Concepts

### The board

One GitHub ProjectV2 per repo, titled after the repo, with nine statuses:

| Status | Meaning | Who moves tickets in |
| --- | --- | --- |
| **Backlog** | Filed but not yet committed to a batch | You, `/z-plan`, end-of-loop bug filing |
| **Ready** | Planned and queued for the next loop | You, `/z-plan`, `--reconcile` |
| **Questions** | Parked: an agent hit a genuine ambiguity and needs you | The loop / planner |
| **Building** | A builder lane is (or was) working it | The loop |
| **QA** | The QA stage is verifying acceptance criteria | The loop |
| **Review** | The blinded adversarial reviewer is on it | The loop |
| **Blocked** | Parked: something external must clear first (e.g., unmet dependencies, third QA failure) | The loop, or you mid-run |
| **Skipped** | Parked: dead worker or confusion | The loop |
| **Done** | Merged and complete — left OPEN for you to review and close | The loop |

And four custom fields per ticket:

- **Model** (`haiku` / `sonnet` / `opus` / `fable`) — which model executes it.
- **Model Effort** (`low` / `medium` / `high` / `xhigh`) — reasoning effort.
- **Estimate** (number, dollars) — set at planning time, reproducibly.
- **Actual** (number, dollars) — written by the loop from real transcript costs.

### Where state lives

| Path | What it holds |
| --- | --- |
| `~/.claude/skills/zstack/` | The pack itself (skills, `bin/`, `lib/`) |
| `~/.zstack/projects/<slug>/config.json` | Per-repo config, written only by `/z-setup` |
| `~/.zstack/projects/<slug>/locks/` | Lane locks + the loop lock (crash evidence) |
| `~/.zstack/projects/<slug>/loop/` | The drain state file + stage transcripts |
| `~/.zstack/projects/<slug>/reports/` | One `loop-<timestamp>.md` per run + invocation logs |
| `~/.zstack/projects/<slug>/loop-counter` | How many loops have completed (drives the 5th-loop audits) |
| `<repo>/.worktrees/ticket-<N>/` | Each lane's isolated git worktree (disposable) |

`<slug>` is the repo name. The board is the recoverable source of truth;
everything local is either config, cache, or disposable.

## 1. Install the pack (once per machine)

Prerequisites, and why each is required:

- **gstack** at `~/.claude/skills/gstack` — zstack does not reimplement deploy,
  QA, or audits; it invokes gstack's `/setup-deploy`, `/land-and-deploy`,
  `/canary`, `/document-release`, `/qa-only`, `/cso`, and `/health`.
- **bun** — every deterministic decision (scheduling, estimates, costs, report
  rendering) is bun TypeScript in `lib/`.
- **gh** — all board access goes through the GitHub CLI. The token needs the
  `project` scope; `/z-setup` checks and refreshes it.

```bash
git clone https://github.com/zacgoodwin/zstack.git ~/.claude/skills/zstack
cd ~/.claude/skills/zstack && ./setup
```

On Windows, run both commands from **Git Bash** — `cmd.exe` doesn't expand `~`,
so the clone lands in a literal `~` folder instead of your home directory.

`./setup` verifies the three prerequisites (refusing with the exact fix command
if one is missing), then registers the skills. Hosts discover skills at
`skills/<name>/SKILL.md` exactly one level deep, so each of the five skills
gets its own top-level entry — the pack directory alone is never enough,
which is why running `./setup` is mandatory even when you cloned straight
into `~/.claude/skills/zstack`:

- **Claude Code**: the pack at `~/.claude/skills/zstack` (runtime assets:
  `bin/`, `lib/`) plus `~/.claude/skills/z-setup`, `z-plan`, `z-loop`,
  `z-status`, `z-uninstall` (symlinks on macOS/Linux, copies on Windows).
- **Codex** (`~/.codex/skills`) and **Factory** (`~/.factory/skills`) are
  registered the same way when their binaries (`codex` / `droid`) are on PATH.

Restart Claude Code afterwards — the skill list is scanned at session start,
so `/z-setup` and friends appear in the next session, not the current one.

**Updating:** `git pull` in the pack directory. On macOS/Linux that's the whole
update for existing skills (symlinks). On Windows the registrations are copies,
so re-run `./setup` after pulling. Either way, a pull that adds a NEW skill
needs one `./setup` re-run to register it.

**Uninstalling:** run `/z-uninstall` to reverse `./setup`: it removes the host
registrations the pack created (symlinks on macOS/Linux, copies on Windows),
leaves any directory it did not create, and strips the auto-approval settings
when present. Confirm first; the GitHub board is remote and untouched:

```bash
/z-uninstall           # reverse ./setup and remove host registrations
/z-uninstall --purge   # also delete ~/.zstack (config, loop state, locks, reports)
```

For pre-sentinel installs (before z-uninstall existed), remove by hand:

```bash
rm -rf ~/.claude/skills/zstack ~/.claude/skills/z-{setup,plan,loop,status,uninstall}
rm -rf ~/.codex/skills/zstack ~/.codex/skills/z-{setup,plan,loop,status,uninstall}
rm -rf ~/.factory/skills/zstack ~/.factory/skills/z-{setup,plan,loop,status,uninstall}
```

Only delete entries zstack created: symlinks into the pack, or copies carrying
a `.zstack-registered` file. If setup warned about a colliding non-zstack
`z-*` skill it left in place, that one is not yours to remove.

The board keeps all recoverable state; `~/.zstack` holds only per-repo config
and disposable run state you can also delete.

Installing changes nothing else. No repo is touched until you run `/z-setup`
inside one.

## 2. Set up a repo: `/z-setup`

Run once per repo, before the first `/z-plan`. If
`~/.zstack/projects/<slug>/config.json` doesn't exist, you need this. It is
idempotent: re-running on a configured repo plans and executes zero changes.

### Step by step

1. **Preconditions.** gstack, bun, gh auth, and the `project` token scope. The
   scope is the one that actually bites: GraphQL fails with
   `missing required scopes [read:project]`. Setup prints and runs
   `gh auth refresh -s project`, then proves it with a scoped GraphQL probe
   before continuing.
2. **Epic style.** Recorded as `milestones`: one GitHub milestone per epic,
   with GitHub's free progress bar. The alternative (an epic issue with
   sub-issues) is not yet supported; setup and config validation reject it
   until a create path exists (issue #14).
3. **Create or adopt the board.** First a **plan** pass prints exactly what
   would change, with zero writes. Then **apply**: creates the project if
   missing, otherwise adopts the one whose title matches the repo name (or a
   specific one via `--project-number <N>`), drives Status to the nine
   canonical options, and creates the four fields. Also writes `config.json`.

   **Destructive adopt guard:** replacing a single-select field's options on an
   adopted board deletes every non-canonical option (e.g. GitHub's default
   Todo / In Progress), and items assigned to a deleted option silently lose
   that value. If populated options would be deleted, apply refuses and lists
   each field, option, and item count. Only re-run with `--force` after you've
   read that list and accept the loss — and do it while nobody else is moving
   items on the board (the API has no conditional mutation, so a small race
   window exists).
4. **Workflow toggles (manual — the first question).** GitHub exposes no API
   for a project's built-in workflows, so setup prints the clicks and waits:
   open the project → **⋯ → Workflows** → disable **Auto-archive items** and
   any workflow that **closes the issue when Status = Done**. Auto-archive
   makes items invisible to the loop; auto-close removes Done tickets before
   you've reviewed them (the loop leaves them open on purpose). Setup then
   asks you to confirm both are off and will not finish until you do. Leave
   "item added → set status" style workflows alone.
5. **Verify, by script.** `z-setup-board verify` walks the live board and
   prints `OK` or `DRIFT` per item, exiting non-zero on any drift. Setup also
   proves `config.json` loads and validates. Nothing is eyeballed.
6. **Wire deploy.** Invokes gstack's `/setup-deploy` for this repo, so the
   end-of-loop green path (`/land-and-deploy` → `/canary` →
   `/document-release`) works.
7. **Auto-approvals (the second question).** Optional, offered every time.

### The auto-approvals question, in full

The problem it solves: an unattended loop runs many never-seen-before commands,
and with default permissions each one re-prompts you and stacks a one-off allow
rule in `~/.claude/settings.json` forever. You become a click-through machine.

The stakes: the fix edits `~/.claude/settings.json`, which is **machine-wide**.
Every project on the machine inherits whatever you pick, not just this repo.

| Option | What it configures | Result |
| --- | --- | --- |
| **A) Full auto-approvals** | A `PermissionRequest` hook that answers "allow" to everything, plus `defaultMode: bypassPermissions`, the startup skip flags, and B's allowlist | Zero prompts in this and every future session. The loop runs fully unattended. Recommended for a machine dedicated to the loop. |
| **B) Loop allowlist** | Allow rules for `Bash(git *)`, `Bash(gh *)`, `Bash(bun *)`, `Bash(bunx *)` only. No hook, no mode change, deliberately no blanket `bash`/`claude`/Edit/Write | The loop's most common commands run unprompted; everything else (including every Edit and Write) still asks. Smallest blast radius, not fully unattended. |
| **C) Skip** | Nothing | Today's behavior continues; one-off rules keep accumulating. Right answer for a shared machine or if you're not ready. |

Whatever you pick is applied by `bin/z-setup-permissions`, never by hand-editing:
it merges without clobbering existing keys or rules, validates JSON before and
after, and writes atomically so a crash can't corrupt your settings. Re-running
it when everything is already configured makes zero changes.
`z-setup-permissions --check` reports each layer (hook / bypass mode /
allowlist) present or absent, with zero writes.

Two things worth knowing after choosing A:

- The hook takes effect immediately (settings watcher), but `defaultMode` and
  the skip flags are read **at session startup only**. A session that was
  already running keeps prompting until restarted — that's a straggler, not a
  bug.
- **Undo** is atomic via `bin/z-setup-permissions --remove`, which strips the
  auto-approval settings and validates JSON before writing. For hand-editing
  (not recommended): remove the `hooks.PermissionRequest` entry whose command
  contains `"permissionDecision":"allow"`, restore or delete
  `permissions.defaultMode`, remove the two skip flags, and optionally drop the
  five allow rules. Re-validate as JSON afterward.

### Done when

The scoped probe passed, verify exited 0, you confirmed both workflows off,
`config.json` loads, `/setup-deploy` ran, and the auto-approvals offer was made
(its answer doesn't gate completion).

## 3. Plan work: `/z-plan`

```bash
/z-plan path/to/spec.md     # or no argument → newest gstack CEO plan for the repo
```

Input: any plan/spec file (a gstack CEO plan, a spec document, a design doc).
Output: milestones plus board-ready tickets in Ready, dependencies linked.

What makes a zstack ticket different from a hand-filed issue:

- **Grounded before written.** The planner reads the actual code the spec
  touches first. Every ticket's `## Plan` cites real file paths and line refs
  the planner opened, not guesses.
- **Schema-gated body.** Every body must contain `## Context`, `## Plan`,
  `### Acceptance Criteria` (concrete setup → action → expected-outcome cases,
  authored before any code — they're the yardstick QA and review check
  against), `## Tests + evals`, `## Docs pages touched`, `## Out of scope`, and
  optionally `Depends on: #A, #B`. The gate is `bin/z-ticket-lint`; a body that
  fails it never reaches the board. The loop's own planning pass runs the same
  gate, so "valid ticket" means one thing everywhere.
- **Sized to fit a context window.** A ticket whose plan would need more than
  ~400K tokens of live context (measured by file and step counts through the
  `needsSplit` gate, not vibes) is split into ordered subtasks, with the order
  recorded in the parent.
- **Model + Effort + a reproducible Estimate.** The planner picks the cheapest
  tier that finishes the ticket *including rework* (when in doubt between two
  tiers, it takes the higher). The tier maps to a fixed bucket entry in
  `z-plan/tiers.json` that `bin/z-estimate` prices deterministically — same
  spec in, same dollars out, every run:

  | Tier | Model | Effort | Estimate |
  | --- | --- | --- | --- |
  | `haiku-low` | haiku | low | $0.23 |
  | `sonnet-medium` | sonnet | medium | $1.64 |
  | `opus-high` | opus | high | $4.36 |
  | `opus-xhigh` | opus | xhigh | $7.15 |
  | `fable-xhigh` | fable | xhigh | $19.50 |

  (Full-lifecycle: plan + build + QA + review + merge, with buffer. Rules of
  thumb per tier are in `spec/ESTIMATION.md`.)
- **Dependencies linked both directions.** "N Depends on #M" on the dependent,
  "M Blocks #N" on the dependency, existing tickets found by title slug so a
  reworded title doesn't create a duplicate.
- **Questions, not guesses.** A genuine ambiguity becomes a comment plus a move
  to Questions. The planner never guesses an architectural decision into a plan.

**Idempotent re-plan:** running `/z-plan` again on the same spec matches
existing tickets by title slug and updates them in place. Zero duplicates.

**`--dry-run`:** emits every ticket body, its fields, and its `Depends on:`
lines to stdout with no board writes. This is what the planner eval
(`evals/planner/`) grades offline.

## 4. Run the loop: `/z-loop`

```bash
/z-loop              # drain the Ready queue once, then exit
/z-loop --reconcile  # clear a crashed prior run first, then start
```

No daemon: the loop drains the batch that exists when it starts, then exits.
The next batch is the next invocation.

### What a run looks like

1. **Planning pass.** Every Ready ticket's body is gated with `z-ticket-lint`.
   A missing or invalid plan gets drafted (grounded in the code) by the loop
   itself; a genuine ambiguity parks the ticket to Questions; a missing
   Estimate gets the tier treatment from `/z-plan`.
2. **Batch commit.** Every workable ticket moves to Building at once, so the
   board shows the full committed queue before any lane starts.
3. **Lanes.** Up to `maxLanes` (default 3) tickets run concurrently, each in
   its own git worktree (`.worktrees/ticket-<N>`) on its own branch. A ticket
   whose dependencies aren't Done yet isn't claimable until they are.
4. **Four stages per ticket, one fresh agent each:**
   - **Builder** implements the plan and makes the acceptance criteria pass as
     written. Runs on the ticket's Model field.
   - **QA** verifies each acceptance criterion. Findings bounce the ticket back
     to a fresh builder; from the `qaInvestigateAfter`-th bounce onward (default
     2), the rebuild runs `/investigate` first; at `maxQaPasses` failures (default
     3), the ticket parks Blocked instead of bouncing.
   - **Reviewer** is deliberately **blinded**: it sees exactly the ticket body,
     the acceptance criteria, the diff, and a throwaway worktree — no PR
     description, no plan rationale, no transcripts. Findings bounce to a fresh
     builder.
   - **Merge** lands the PR. Merges happen one at a time in dependency
     (topological) order; stacked chains retarget the base, and branches are
     deleted only at batch end so a dependent PR is never orphaned.

   Nothing latent travels between stages — each is a new agent built from a
   pure prompt constructor. The reviewer can't be talked into leniency by the
   builder because it never sees the builder.
5. **Watchdog.** A worker silent past `watchdogMinutes` (default 10) is probed;
   if dead, the ticket is Skipped with a note (except a dead merge lane, where
   the loop first checks whether the PR actually landed before deciding).
6. **Costs.** After every stage, the ticket's transcripts are priced by
   `bin/z-cost` (deduped by request id) and written to its Actual field. By
   Done, Actual is the ticket's real cumulative dollar cost.

**You can intervene mid-run.** Drag a Building/QA/Review ticket to Blocked,
Questions, or Skipped on the board and the loop respects it: that lane stops
cleanly at its next stage boundary, its agent is torn down, and every other
lane keeps running.

### End of loop

After the batch drains, the loop syncs merged main and runs a regression: every
gate the repo declares in `package.json` (`typecheck`, `test`, `build`, e2e
when a web surface changed), plus gstack `/qa-only` (report-only, so this pass
cannot edit main).

- **Red** (any gate failed or QA found anything): every finding is filed as a
  Backlog bug with a repro and first-suspect file. **No deploy skill runs.**
- **Green**: `/land-and-deploy` → `/canary` → `/document-release`, in that
  order, each invocation logged as it returns.
- **Every Nth loop** (red or green, driven by config `auditEveryNLoops`, default
  5): `/cso` (security) + `/health` (quality) run too, and their findings are
  filed to Backlog the same way.

The run report lands at `~/.zstack/projects/<slug>/reports/loop-<timestamp>.md`:
verdict and evidence per gate, every ticket's final status and Actual, the
edges rollup from completion notes, and every bug the run filed.

### Crashes and `--reconcile`

Two guards keep runs from stepping on each other:

- **A live loop refuses a second invocation**, naming the running session. Its
  lock is `~/.zstack/projects/<slug>/locks/loop.lock`. A live lock is never
  cleared by anything — you cannot reconcile over a running loop.
- **A crashed loop leaves evidence** — lane locks with no live loop, worktrees
  with no lock, Building tickets with neither — and a fresh `/z-loop` refuses
  to start on any of it rather than guess.

`/z-loop --reconcile` unwinds a crash: releases claims, parks affected tickets
back to Ready, prunes stray worktrees (a crashed builder's uncommitted work is
discarded; the ticket rebuilds fresh), clears the stale lock, then starts
normally. It never deletes a branch, never removes a comment, never touches a
ticket with a live lane.

**One loop per (GitHub login, project) at a time.** The loop lock is per
machine, but board claims are keyed on your GitHub login — two loops as the
same login on different machines will both think every ticket is theirs and
race. Use distinct logins or distinct projects to parallelize.

## 5. Watch the board: `/z-status`

Read-only, any time — before a loop, during one, or after:

- Ticket counts across all nine statuses.
- **Waiting on human**: the Questions and Blocked tickets by number and title —
  exactly what needs you before the next loop can make progress.
- In-flight lanes with ticket, stage, and age (a lane older than the watchdog
  is about to be probed).
- The last loop's report path and verdict line (GREEN or RED).
- Estimate vs Actual totals, for calibration.

Zero mutations, guaranteed by a gate test: no mutating board command exists in
the status code path.

## 6. Your job between loops

The loop hands work back deliberately. After each run:

1. **Answer Questions.** Each parked ticket carries a comment with the specific
   question. Reply on the ticket, then move it back to the status the comment
   names (usually Ready).
2. **Clear Blocked.** The comment says what was wrong and the recommended next
   step. Fix the blocker, move the ticket to Ready.
3. **Review Done tickets, then close them.** Each Done ticket is left OPEN with
   a completion note: what shipped, the PR, which acceptance criteria passed,
   and an **edges** list — every surprising, default-chosen, or spec-ambiguous
   behavior, each as "to check X, do Y, expect Z". Walk the edges, then close
   the issue yourself. (This is why the auto-close workflow must stay off.)
4. **Read the loop report**, especially on red: the filed bugs are already in
   Backlog with repros — promote to Ready what the next batch should fix.
5. **Calibrate.** If Actual routinely exceeds Estimate on `/z-status`, planning
   is undercharging — see `spec/ESTIMATION.md`.

Then fill Ready and run `/z-loop` again.

## Configuration reference

`~/.zstack/projects/<slug>/config.json` — written by `/z-setup`, read by
everything else. Identity fields (`owner`, `repo`, `projectNumber`, field ids)
are managed by setup; don't hand-edit them. The tunables:

| Key | Default | What it does |
| --- | --- | --- |
| `epicStyle` | `"milestones"` | How epics are modeled. Only `milestones` is supported today. |
| `maxLanes` | `3` | Max concurrent lanes in a loop run. |
| `watchdogMinutes` | `10` | Minutes of worker silence before the loop probes and, if dead, skips the lane. |
| `lockStalenessMinutes` | `60` | Age past which a crashed loop's lock is judged stale (also stale immediately when its pid is dead on the same host). |
| `maxQaPasses` | `3` | QA passes on a ticket before it parks Blocked instead of bouncing to a fresh builder. |
| `qaInvestigateAfter` | `2` | QA-bounce count at/after which the rebuild runs `/investigate` first. |
| `auditEveryNLoops` | `5` | How often (modulo loop count) the end-of-loop stage runs `/cso` + `/health` audits. Must be a positive integer. |

Also on disk:

- `references/rates.json` — per-model dollar rates for `z-estimate`/`z-cost`,
  with a `checked_at` date. Both tools warn (not fail) when it's over 14 days
  old; update the rates and bump the date.
- `~/.zstack/projects/<slug>/loop-counter` — a single integer. It drives the
  5th-loop `/cso` + `/health` cadence; if corrupted, the loop fails loudly
  rather than silently resetting. Fix it to the number of completed loops.

## When something goes wrong

[troubleshooting.md](troubleshooting.md) covers the deliberate stops: the gh
`project` scope failure, the two "refuses to start" messages and when
`--reconcile` is the answer, the stale-rates warning, the corrupt loop counter,
the auto-approvals straggler session, and why Done tickets stay open.
