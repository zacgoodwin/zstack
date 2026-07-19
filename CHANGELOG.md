# Changelog

All notable changes to zstack are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/); versions use `MAJOR.MINOR.PATCH.MICRO`.

## [0.1.0.0] - 2026-07-19

First release of the zstack dev-loop skill pack. Installs at `~/.claude/skills/zstack` alongside gstack (required) and runs the [PROCESS.md](references/PROCESS.md) development loop after planning, deploying at end of loop. GitHub Projects backed; solo-dev, any repo.

### Added

- **`/z-setup`** — creates or adopts a GitHub Projects board with the nine PROCESS.md statuses (Backlog, Ready, Questions, Building, QA, Review, Blocked, Skipped, Done) and four fields (Model, Model Effort, Estimate, Actual), disables the auto-close workflow, and offers an optional auto-approvals step so the loop runs unattended.
- **`/z-plan`** — turns a spec or plan into board-ready tickets: code-grounded plans with `### Acceptance Criteria`, dependency links, reproducible dollar estimates (per [ESTIMATION.md](references/ESTIMATION.md)), and a model/effort recommendation per ticket. Oversized tickets split at a 400K-token context gate.
- **`/z-loop`** — the development loop: per-ticket worktree lanes (max 3 concurrent), a fresh agent per stage (Build → QA → Adversarial Review → Merge) with the reviewer blinded to everything but the ticket, acceptance criteria, diff, and a throwaway worktree. Drains the Ready batch, then runs regression → `/land-and-deploy` → `/canary` → `/document-release`, with `/cso` + `/health` audits every fifth loop. Drain-and-exit; `--reconcile` recovers a crashed run.
- **`/z-status`** — read-only board dashboard: status counts, in-flight lanes, last-loop verdict, and Estimate-vs-Actual totals.
- **`bin/z-board`** — the single GitHub Projects contract every skill speaks through, with a built-in GraphQL quota guard.
- **`bin/z-estimate` / `bin/z-cost`** — deterministic token-math estimates and transcript-based actual-spend accounting (dedupes multi-block API responses by request id; a format-drift canary fails loudly if Claude Code renames its usage keys).
- **Safety controls** — restart-surviving lockfiles, startup orphan scan, atomic pre-spawn claim, lane cap, per-stage watchdog (dead worker → Skipped, never a stuck loop), and refusal of a second concurrent loop on the same project.
- Gate-test suite (320 tests, deterministic, offline) plus two eval lanes: a planner eval and a full-loop e2e checker exercised against a fixture run.
- Install via `git clone` → `./setup` (requires gstack + bun).

### Known limitations

- Not yet merge-ready to a production main: the pre-landing review filed remediation issue #14 (pagination beyond 100 board items, epicStyle `issue-type` create path, cross-session claim identity, and others). See #14 before running against a real board at scale.
- Board creation, real multi-session lock concurrency, and issue-stays-open-on-Done are validated by design and gate tests but need one live run (`gh auth refresh -s project`, then `/z-setup`) to confirm end to end.
