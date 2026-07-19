# zstack

An installable Claude Code skill pack that runs the **Develop** and **Merge**
stages of a dev loop unattended. gstack covers planning (`/office-hours` through
`/plan-devex-review`) and single actions (`/ship`, `/qa`, `/review`); zstack is
the missing part that *loops* them. Fill a GitHub Projects board's Ready column
with tickets, run `/z-loop`, and walk away — the loop plans, builds, QAs, reviews,
merges, deploys, and comes back with tickets in Done, merged PRs, and filled
Estimate/Actual dollar fields. Nothing burns tokens while stuck.

Solo dev, any repo with a GitHub Projects board. Laid out like gstack: one
directory per skill (`SKILL.md`, `bin/`, `lib/`), a `setup` script, a `VERSION`.

## Install

```bash
git clone <this-repo> ~/.claude/skills/zstack
cd ~/.claude/skills/zstack && ./setup          # add --team to also register Codex/Factory
```

Requires:

- **[gstack](https://github.com/garrytan/gstack)** at `~/.claude/skills/gstack`
  (zstack invokes its `/setup-deploy`, `/land-and-deploy`, `/canary`,
  `/document-release`, `/qa-only`, `/cso`, `/health`)
- **[bun](https://bun.sh)** — the deterministic core is bun TypeScript
- **[gh](https://cli.github.com)** — all board access is GitHub-only, and the
  token needs the `project` scope (`/z-setup` refreshes it for you)

`./setup` checks every precondition and refuses with the exact fix command if one
is missing.

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

The stage diagrams the loop implements are in `references/` (`develop stage.png`,
`merge stage.png`, `planning Process.png`). Anything the loop cannot resolve
(a genuine ambiguity, a dead worker, a third QA failure) parks in
Questions / Blocked / Skipped with a comment — never a silent guess, never a stall.

## Command reference

| Command | What it does | Key options |
|---------|--------------|-------------|
| **`/z-setup`** | One-time per repo: create/adopt the board (9 statuses, 4 fields Model/Model Effort/Estimate/Actual), turn off the auto-archive + auto-close workflows, wire deploy, write `~/.zstack/projects/<slug>/config.json`. Idempotent. | Step 7 **auto-approvals**: optionally reduce Claude Code permission prompts so the loop runs unattended (A full / B loop-allowlist / C skip). Machine-wide — see [z-setup docs](docs/user-guide/z-setup.md). |
| **`/z-plan [spec]`** | Turn a spec into milestones + board-ready tickets: grounded plans, `### Acceptance Criteria`, Model/Effort, a reproducible dollar Estimate, dependencies linked both ways. Idempotent by title slug. | `--dry-run` emits tickets to stdout with no board writes (used by `evals/planner/`). |
| **`/z-loop`** | Drain the Ready batch: plan → build → QA → adversarial review → merge in dependency order, then end-of-loop regression + deploy (green) or bug-filing (red), report, exit. No daemon. | `--reconcile` clears a crashed run's locks/worktrees and parks its tickets back to Ready, then starts (C7). |
| **`/z-status`** | Read-only dashboard: status counts, Questions/Blocked waiting on you, in-flight lanes with age, last loop's verdict, Estimate vs Actual totals. | — |

Per-skill detail: [`docs/user-guide/`](docs/user-guide/) — one page each for
[z-setup](docs/user-guide/z-setup.md), [z-plan](docs/user-guide/z-plan.md),
[z-loop](docs/user-guide/z-loop.md), [z-status](docs/user-guide/z-status.md), and
[troubleshooting](docs/user-guide/troubleshooting.md).

## Quickstart

From a repo with a GitHub Projects board you can write to:

```bash
# 0. Install the pack (once)
git clone <this-repo> ~/.claude/skills/zstack
cd ~/.claude/skills/zstack && ./setup

# 1. Make sure your gh token can see projects
gh auth refresh -s project

# 2. In the target repo, set up the board (creates statuses + fields, wires deploy)
cd /path/to/your/repo
/z-setup
#   → toggle the two workflows OFF in the web UI and choose an auto-approvals
#     level so the loop can run unattended (epic style is always milestones).

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

## Layout

- `z-setup/`, `z-plan/`, `z-loop/`, `z-status/` — the four skills (`SKILL.md`).
- `bin/` — bash entry shims; `lib/` — the bun TypeScript deterministic core
  (board contract, scheduler, estimator, cost accounting, stage prompts).
- `references/` — process docs (`PROCESS.md`, `PRINCIPLES.md`, `ESTIMATION.md`,
  `ORCHESTRATOR.md`, sample transcripts) and the dev-loop diagrams; `rates.json`.
- `evals/` — the paid, periodic lanes: `planner/` (graded `/z-plan` quality) and
  `e2e/` (the full-loop check). See [`evals/e2e/README.md`](evals/e2e/README.md).
- `tests/` — deterministic gate tests, run via `bun test` (free, <2s).
- `docs/user-guide/` — the pages linked above.

## Testing

Two lanes, per `references/PRINCIPLES.md`:

- **Gate tests** — `bun test`. Deterministic, free, fast; run on every commit.
- **Evals** — paid (LLM calls), run before ship and nightly. Every LLM call goes
  through **local Claude Code (`claude -p`)**, never a hosted API. The planner
  eval grades quality (`evals/planner/`); the e2e eval proves the whole loop
  against a fixture (`evals/e2e/`), with `check.ts` gate-tested against a
  hand-authored sample run.

## Uninstall

Local tooling only: `rm -rf ~/.claude/skills/zstack`. Board statuses are the
recoverable state; worktrees are disposable; locks clear via `/z-loop --reconcile`.
