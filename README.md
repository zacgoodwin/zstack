# zstack: The Part Gary Forgot

zstack came about for two reason: 
1. I am poor (but if you want to fix that Mr. Tan....). gstack is great at making a robust design but once I asked claude to "Make the thing" my usage shot through the roof.
2. When I was learning the AI development loop I came across gstack but I kept wondering "How do I make the agent make the code in the best way possible?". gstack provided the skills, the design framework but after that left me guessing.

## This is my loop. There are many like it, but this one is mine.

The loop makes decisions in the way that I would make decisions. I've taken inspiration from many different places (Thanks EricTech) and baked in those opinions to the loop. If you like my opinions great! If not feel free to swipe them and use them to make your own.

I left what I fed into the machine to generate this skill under doc/spec. All the changes I have made are filed as tickets under issues. 

## My loop, without me, is useless. Without my loop, I am still useful

Something that is often overlooked is AI is only as good as the person running it. You don't know what to ask, or how to ask it then you will never truly get what you're looking for out of it. A good portion of the "new" AI products out there are simply wrappers around the model APIs with a neat interface containing the founder's opinions baked it. Extremely useful for some people, but since you're here on github I assume you want more. 

What zstack aims to do is to put into focus the things humans are good at and let AI do the things it is good at. gstack is great in that way because it asks questions to get the most out of you, the expert in whatever it is you're looking to build. Not to go too deep into Plato's allegory of the cave but AI doesn't exist in the world. You do. In that spirit z-loop errors on the side of caution letting you make all the judgment calls about the "What" and "Why" while it sticks to the "How" of the code. 

## My loop and myself know that what counts to executives is not the lines we write. We know it is the ticket count.

I am a recovering Product Manager; so having everything live in PRs and commit messages was unsettling to me. Thus the plan is broken into workable tickets and then the loop works those tickets as if I was a PM working with a development team. This helps traceability, searching, and leveraging other tools for planning. It can quantify In the future other ticket systems can be added like JIRA (Everyone loves to hate JIRA but when asked for what's better few can reply with anything).

## Help me, Help you

Got a suggestion? File a ticket. The neat part about that is it will show up in the attached project. Then next time I run a z-plan it will get speced and estimated. When I run the z-loop it will get built then GitHub will let you know. We take care of each other :)

# AI Generated Read Me

An installable Claude Code skill pack that runs the **Develop** and **Merge**
stages of a dev loop unattended. gstack covers planning (`/office-hours` through
`/plan-devex-review`) and single actions (`/ship`, `/qa`, `/review`); zstack is
the missing part that *loops* them. Fill a GitHub Projects board's Ready column
with tickets, run `/z-loop`, and walk away — the loop plans, builds, QAs, reviews,
merges, deploys, and comes back with tickets in Done, merged PRs, and filled
Estimate/Actual dollar fields. Nothing burns tokens while stuck.

Solo dev, any repo with a GitHub Projects board. Laid out like gstack: one
directory per skill (`SKILL.md`, `bin/`, `lib/`), a `setup` script, a `VERSION`.

New here? Read the [user guide](docs/user-guide/README.md) — it walks the whole
lifecycle from install to your first green loop.

## Requirements

- **[gstack](https://github.com/garrytan/gstack)** at `~/.claude/skills/gstack`
  (zstack invokes its `/setup-deploy`, `/land-and-deploy`, `/canary`,
  `/document-release`, `/qa-only`, `/cso`, `/health`):

  ```bash
  git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
  cd ~/.claude/skills/gstack && ./setup --team
  ```

- **[bun](https://bun.sh)** — the deterministic core is bun TypeScript.
- **[gh](https://cli.github.com)** — all board access is GitHub-only, and the
  token needs the `project` scope (`/z-setup` refreshes it for you).

## Install (once per machine)

```bash
git clone https://github.com/zacgoodwin/zstack.git ~/.claude/skills/zstack
cd ~/.claude/skills/zstack && ./setup
```

On Windows, run both commands from **Git Bash** — `cmd.exe` doesn't expand `~`,
so the clone lands in a literal `~` folder instead of your home directory.

`./setup` checks every precondition (bun, gstack, gh) and refuses with the exact
fix command if one is missing. It then registers each of the six skills
(`/z-setup`, `/z-plan`, `/z-loop`, `/z-status`, `/z-uninstall`, `/z-update`) as
its own top-level entry in the host's skills directory — hosts discover
`skills/<name>/SKILL.md` exactly one level deep, so the pack directory alone is
never enough:

- **Claude Code** — the pack at `~/.claude/skills/zstack` (runtime assets)
  plus `~/.claude/skills/z-setup`, `z-plan`, `z-loop`, `z-status`, `z-uninstall`,
  `z-update`. Running `./setup` is mandatory even when you cloned straight into place.
- **Codex / Factory** — auto-detected by binary on PATH (`codex` / `droid`) and
  registered the same way under `~/.codex/skills` / `~/.factory/skills`.
  `--team` prints the team-mode note; the six skills need no session hooks.

Restart Claude Code after install — the skill list is scanned at session start.

Run `/z-update` (or `bin/z-update` at the pack root) to update — it resolves
the git clone behind your install, `git pull --ff-only`s it, and re-runs
`./setup` to refresh every registration in one step. Refuses with reinstall
instructions when no git source can be resolved (ZIP/manual installs), and
stops before touching setup if the pull itself fails (e.g. diverged local
commits). Manual equivalent: `git pull` in the pack directory, then re-run
`./setup` — required on Windows, where registrations are copies, not
symlinks (symlinks need Developer Mode); either way, a pull that adds a NEW
skill needs one `./setup` re-run to register it. Details:
[z-update](docs/user-guide/z-update.md).

Installing the pack changes nothing else — no repo is touched until you run
`/z-setup` inside one.

## Set up a project (once per repo): what `/z-setup` does and asks

Run `/z-setup` from the repo you want the loop to work on. It is idempotent —
re-running on a configured repo makes zero changes.

What it **does**, in order:

1. **Checks preconditions** — gstack, bun, gh auth, and that your gh token has
   the `project` scope (runs `gh auth refresh -s project` for you if not).
2. **Records the epic style** — fixed to `milestones` today (one GitHub
   milestone per epic); the sub-issue style is not yet supported.
3. **Creates or adopts the board** — a ProjectV2 titled after the repo, driven
   to nine statuses (Backlog, Ready, Questions, Building, QA, Review, Blocked,
   Skipped, Done) and four custom fields (Model, Model Effort, Estimate,
   Actual). Previews every change first; `apply` executes zero mutations when
   the board already matches.
4. **Walks you through the manual workflow toggles** — GitHub has no API for
   built-in project workflows, so you flip two off in the web UI (see the
   question below).
5. **Verifies by script** — `z-setup-board verify` walks the live board and
   exits non-zero on any drift. No eyeballing.
6. **Wires deploy** — invokes gstack `/setup-deploy` so the loop can ship at
   end of run.
7. **Offers auto-approvals** — optional, machine-wide permission changes so the
   loop can run unattended (the second question below).

It writes one file: `~/.zstack/projects/<slug>/config.json`. Every other z-tool
only reads it.

What it **asks** — exactly two questions:

- **"Are both workflows off?"** After printing the exact clicks (project → ⋯ →
  Workflows), it asks you to confirm **Auto-archive items** and any
  **close-issue-on-Done** workflow are disabled. Both fight the loop: archived
  items vanish from its view, and the loop deliberately leaves Done tickets
  open for you to review and close. Setup will not report done until you
  confirm.
- **"How permissive should Claude Code be on this machine?"** Running the loop
  with default permissions turns you into a click-through machine — every novel
  command re-prompts. Three options, applied via `bin/z-setup-permissions`
  (atomic, JSON-validated, never clobbers existing settings):

  | Option | What it configures | Trade-off |
  | --- | --- | --- |
  | **A) Full auto-approvals** | Permission-allow hook + `bypassPermissions` default mode + the allowlist from B | Zero prompts, fully unattended — but **machine-wide**: every project on this machine runs unprompted until you undo it |
  | **B) Loop allowlist** | Allow rules for `git`/`gh`/`bun`/`bunx` commands only; no hook, no mode change | Smallest blast radius; Edit, Write, and novel commands still prompt, so not fully unattended |
  | **C) Skip** | Nothing | Today's behavior; one-off approvals keep piling up |

  This edits `~/.claude/settings.json`, which affects **every project on the
  machine**, not just this repo. Undo with `bin/z-setup-permissions --remove`
  (strips exactly the auto-approval settings `/z-setup` wrote);
  `z-setup-permissions --check` reports which layers are active. Details in the
  [z-setup guide](docs/user-guide/z-setup.md).

## Commands and options

| Command | What it does | Options |
| ------- | ------------ | ------- |
| **`/z-setup`** | One-time per repo: board + statuses + fields, workflows off, deploy wired, config written. Idempotent. | `--project-number <N>` adopt a specific existing project instead of matching by title. `--force` proceed past the destructive-adopt guard (deletes non-canonical field options that still have items — only after you've read the printed list). |
| **`/z-plan [spec]`** | Turn a spec into milestones + board-ready tickets: grounded plans, `### Acceptance Criteria`, Model/Effort, a reproducible dollar Estimate, dependencies linked both ways. Idempotent by title slug. No arg → newest gstack CEO plan for the repo. | `--dry-run` emits tickets to stdout with zero board writes (what `evals/planner/` grades). |
| **`/z-loop`** | Drain the Ready batch: plan → build → QA → adversarial review → merge in dependency order, then end-of-loop regression + deploy (green) or bug-filing (red), report, exit. No daemon. | `--reconcile` clears a crashed run's locks/worktrees, parks its tickets back to Ready, then starts. Never clears a live loop's lock. |
| **`/z-status`** | Read-only dashboard: status counts, Questions/Blocked waiting on you, in-flight lanes with age, last loop's verdict, Estimate vs Actual totals. | — |
| **`/z-uninstall`** | Reverse `./setup`: remove the host registrations it owns (a symlink into the pack, or a copy carrying `.zstack-registered`), leaving any dir — or a symlink pointing outside the pack — it did not create; strip `/z-setup`'s auto-approval settings when present. Confirms first; the GitHub board is remote and untouched. | `--purge` also deletes `~/.zstack` (config, loop state, locks, reports). |
| **`/z-update`** | Update the install: resolve the git clone backing it, `git pull --ff-only`, re-run `./setup` to refresh every registration. Refuses with reinstall instructions when no git source resolves; stops before touching setup if the pull fails. | — |

Tunables live in `~/.zstack/projects/<slug>/config.json`: `maxLanes` (default 3),
`watchdogMinutes` (default 10), `lockStalenessMinutes` (default 60),
`maxQaPasses` (default 3), `qaInvestigateAfter` (default 2),
`auditEveryNLoops` (default 5). See the
[configuration reference](docs/user-guide/README.md#configuration-reference).

## The loop in one diagram

```text
                 ┌──────────────────────── /z-setup (once per repo) ───────────────────────┐
                 │  board + 9 statuses + 4 fields · workflows off · deploy wired · approvals │
                 └───────────────────────────────────────────────────────────────────────┘
                                              │
   spec ──► /z-plan ──► tickets in Ready ──►  │
   (grounded plans, AC, Model/Effort/$Estimate, deps linked)
                                              │
                                        ┌──── /z-loop ──── drain the batch, then exit ────┐
                                        │                                                  │
   Ready ─► Building ─► QA ─► Review ─► Done          (up to maxLanes=3 lanes, one         │
              ▲          │       │                     FRESH agent per stage, merges in    │
              └─ bugs ───┘       └─ findings ─┐        dependency order)                   │
                (bounce)          (bounce)    ▼                                            │
                                        end-of-loop:                                       │
                                   regression on merged main                               │
                                    ├─ RED  → file bugs to Backlog, NO deploy              │
                                    └─ GREEN→ land-and-deploy → canary → document-release  │
                                              (+ cso + health every Nth loop, default 5)   │
                                        write report · bump loop counter · exit            │
                                        └──────────────────────────────────────────────────┘

   /z-status — read-only dashboard of the board at any moment (no mutations)
```

The stage diagrams the loop implements are in `docs/user-guide/spec/`
(`develop stage.png`, `merge stage.png`, `planning Process.png`). Anything the loop cannot resolve
(a genuine ambiguity, a dead worker, a third QA failure) parks in
Questions / Blocked / Skipped with a comment — never a silent guess, never a stall.

## Quickstart

```bash
# 0. Install the pack (once per machine)
git clone https://github.com/zacgoodwin/zstack.git ~/.claude/skills/zstack
cd ~/.claude/skills/zstack && ./setup

# 1. Make sure your gh token can see projects
gh auth refresh -s project

# 2. In the target repo, set up the board (creates statuses + fields, wires deploy)
cd /path/to/your/repo
/z-setup
#   → answers the two questions above: workflows off, auto-approvals level.

# 3. Turn a spec into tickets
/z-plan docs/specs/my-feature.md
#   → tickets land in Ready with plans, acceptance criteria, fields, and deps.

# 4. Run the loop and walk away
/z-loop
#   → come back to Done tickets with merged PRs, filled Actuals, a loop report,
#     and any open questions parked in Questions.

# 5. Check where things stand any time
/z-status
```

If a run wedges (a crash left locks or stray worktrees), `/z-loop --reconcile`
clears it and restarts. See [troubleshooting](docs/user-guide/troubleshooting.md).

## Documentation

- [**User guide**](docs/user-guide/README.md) — the detailed walkthrough:
  concepts, install, board setup, planning, running the loop, recovery, and the
  configuration reference.
- Per-skill pages: [z-setup](docs/user-guide/z-setup.md) ·
  [z-plan](docs/user-guide/z-plan.md) · [z-loop](docs/user-guide/z-loop.md) ·
  [z-status](docs/user-guide/z-status.md) ·
  [z-update](docs/user-guide/z-update.md) ·
  [z-uninstall](docs/user-guide/z-uninstall.md) ·
  [troubleshooting](docs/user-guide/troubleshooting.md)

## Layout

- `z-setup/`, `z-plan/`, `z-loop/`, `z-status/`, `z-update/`, `z-uninstall/` —
  the six skills (`SKILL.md`). `setup` registers the pack; `uninstall` (its
  sibling) reverses it.
- `bin/` — bash entry shims; `lib/` — the bun TypeScript deterministic core
  (board contract, scheduler, estimator, cost accounting, stage prompts).
- `references/` — `rates.json`, the per-model dollar rates for `z-estimate`/`z-cost`.
- `evals/` — the paid, periodic lanes: `planner/` (graded `/z-plan` quality) and
  `e2e/` (the full-loop check). See [`evals/e2e/README.md`](evals/e2e/README.md).
- `tests/` — deterministic gate tests, run via `bun test` (free, <2s).
- `docs/user-guide/` — the pages linked above, plus `spec/`: process docs
  (`PROCESS.md`, `PRINCIPLES.md`, `ESTIMATION.md`, `ORCHESTRATOR.md`, sample
  transcripts) and the dev-loop diagrams.

## Testing

Two lanes, per `docs/user-guide/spec/PRINCIPLES.md`:

- **Gate tests** — `bun test`. Deterministic, free, fast; run on every commit.
- **Evals** — paid (LLM calls), run before ship and nightly. Every LLM call goes
  through **local Claude Code (`claude -p`)**, never a hosted API. The planner
  eval grades quality (`evals/planner/`); the e2e eval proves the whole loop
  against a fixture (`evals/e2e/`), with `check.ts` gate-tested against a
  hand-authored sample run.

## Uninstall

Run `/z-uninstall` (or the `uninstall` script at the pack root directly). It
reverses `./setup`, honoring the same ownership rule: it removes only the host
registrations it can prove it created — a symlink whose target resolves into the
pack, or a copy carrying the `.zstack-registered` sentinel — and leaves any
same-named directory (or a symlink pointing outside the pack) it did not create,
naming it. If the pack IS the git clone at `~/.claude/skills/zstack`, it leaves
the clone (it may be your only copy) and prints the exact `rm -rf` command.

```bash
"$HOME/.claude/skills/zstack/uninstall"           # remove registrations, keep ~/.zstack
"$HOME/.claude/skills/zstack/uninstall" --purge   # also delete ~/.zstack (config, loop state)
```

`--purge` additionally removes `~/.zstack` (per-project config, loop counter,
locks, reports); without it, that path and the purge command are printed. The
skill also runs `bin/z-setup-permissions --remove` to strip the auto-approval
settings `/z-setup` Step 7 wrote, when present. The GitHub board, milestones, and
labels are remote data — never touched; delete them yourself if you want them
gone. See [z-uninstall](docs/user-guide/z-uninstall.md). Board statuses are the
recoverable state; worktrees are disposable; locks clear via `/z-loop --reconcile`.

## AI Disclosure

Written by AI, for AI with Zac co-driving 

## Credits
Designed and maintained by Zac Goodwin. Skill inspired by ErichTech's [super-board](https://github.com/EricTechPro/super-board)
