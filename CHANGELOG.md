# Changelog

All notable changes to zstack are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/); versions use `MAJOR.MINOR.PATCH.MICRO`.

## [Unreleased]

Remediation of issue #14 (all 22 items now closed) plus an adversarial hardening pass (OpenAI Codex challenge + independent refute review, every fix mutation-tested).

### Added

- Board shape (nine statuses, four custom fields, intended views) is data now (issue #20): the shipped `z-setup/board-template.json`, loaded and validated by `lib/board-template.ts` before any board mutation. The default is 1:1 with the previously hardcoded shape (same statuses in order, same fields + option colors). `z-setup-board plan|apply|verify --template <file>` ships a variant; the loader refuses a template whose status set is not the canonical nine or that drops/renames a required field (Model, Model Effort, Estimate, Actual), naming the field and the tool that breaks. GitHub's API has no view-creation mutation, so the template's views are printed as explicit manual steps rather than silently dropped.
- **`/z-uninstall`** — you can now remove everything `./setup` created with one command (#37). The pack-root `uninstall` script removes the pack and each `z-*` skill entry from every host (Claude Code, Codex, Factory) only when ownership is proven: a symlink, or the `.zstack-registered` sentinel that `setup` now stamps into every copied registration. `--purge` also removes `~/.zstack` state; `bin/z-setup-permissions --remove` strips exactly the permission entries the auto-approvals step wrote, preserving everything else. A clone at `~/.claude/skills/zstack` is never deleted; the exact removal command is printed instead. GitHub-side artifacts (board, milestones, labels) are never touched.
- Two QA-loop knobs are per-project config now (#41): `maxQaPasses` (default 3 — QA passes before a still-buggy ticket parks Blocked) and `qaInvestigateAfter` (default 2 — the QA pass from which builder bounces carry `investigateFirst`). Set them in `~/.zstack/projects/<slug>/config.json` beside `maxLanes`; defaults reproduce the old hardcoded behavior exactly.

### Fixed

- `Board.list()` paginates past 100 items with cursor-loop hardening (empty/repeated cursor and missing `pageInfo` throw loudly); single-page ceilings (fieldValues, projectItems, milestones, labels) guard with loud throws.
- Destructive board adopt now refuses without `--force` when non-canonical options on ANY single-select field (Status, Model, Model Effort) still hold items, names each option and count before any mutation, and rechecks immediately before mutating (refuses even under `--force` if the board moved).
- Setup's project/field lookups paginate — a project past page one is adopted, not duplicated.
- `link` (Depends-on) survives lost updates: line-exact verification (no more `#12` false-verifying `#1`), bounded re-append retries, per-issue in-process serialization; comment posts only after a verified write.
- Cost accounting prices a response exactly once even when its transcript lines mix requestId and message.id presence; blank or non-finite values are rejected before any NUMBER field write (a failed pipeline can no longer zero `Actual`).
- z-status reads ONE atomic board snapshot (no more mid-scan double-count/vanish), cleans up its temp dir, and dedupes by issue number with a visible warning.
- Lock/report reads distinguish "missing" from "unreadable": I/O failures raise errors instead of rendering a false idle dashboard.
- `atomicWrite` hardened for Windows: exclusive tmp create, bounded retry on transient rename errors, tmp cleanup on failure.
- The two skill-file grep gates scan the real `*/SKILL.md` targets with canary assertions and an exact allowlist; the scanner joins backslash continuations and covers all `gh` invocations (both proven evasions now self-tested).
- The gh-direct-call code gate no longer scans `evals/` (#40): the planner eval harness quotes `gh` invocations in comments without ever shelling the real gh, and the widened detector from #23 flagged it after a cross-branch merge left main red. The gate's file filter is now a named `gateScans` predicate with a canary test pinning exactly which surfaces are excluded, so dropping the exclusion (or adding a new double) fails pre-merge instead of after the next merge collision.

### Changed

- `z-board list --status` is now optional: omitted lists the whole board in one paginated call (the atomic snapshot z-status consumes).
- `z-cost --json` emits machine-readable totals; z-loop's Actual write consumes it instead of parsing prose.
- `epicStyle "issue-type"` is rejected at config validation and z-setup until a sub-issue create path exists; epic style is always `milestones`.
- `field-get` on a nonexistent issue throws the same not-found error as other subcommands (was a silent empty value), and never falls back to another project's same-named field.
- Root strict `tsconfig` + `bun run typecheck` wired into the gate suite; shared CLI plumbing consolidated into `lib/cli.ts`; board statuses single-sourced in `lib/config.ts`.
- 100+ new gate tests (456 total), each proven to bite via mutation testing.

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

- The pre-landing review filed remediation issue #14 (pagination beyond 100 board items, epicStyle `issue-type` create path, cross-session claim identity, and others); all 22 items are closed in [Unreleased] above.
- Board creation, real multi-session lock concurrency, and issue-stays-open-on-Done are validated by design and gate tests but need one live run (`gh auth refresh -s project`, then `/z-setup`) to confirm end to end.
