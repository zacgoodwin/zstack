# Changelog

All notable changes to zstack are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/); versions use `MAJOR.MINOR.PATCH.MICRO`.

## [0.1.1.0] - 2026-07-19

Installing zstack now actually surfaces the four skills. Also releases the issue #14 remediation (all 22 items closed) plus an adversarial hardening pass (OpenAI Codex challenge + independent refute review, every fix mutation-tested).

### Fixed

- `./setup` now registers each skill (`z-setup`, `z-plan`, `z-loop`, `z-status`) as its own top-level entry in the host's skills directory. Hosts discover `skills/<name>/SKILL.md` one level deep only, so registering just the pack directory left all four skills invisible — worst on the documented clone-straight-into-`~/.claude/skills/zstack` path, which early-returned before registering anything. Run `./setup` after every install or update, then restart Claude Code; on Windows run it from Git Bash (`cmd.exe` leaves a literal `~` folder).
- Registration is now safe around things setup didn't create. Every copy carries a `.zstack-registered` sentinel and only sentinel-carrying dirs (or symlinks) are refreshed: a separate zstack checkout at `~/.claude/skills/zstack` (including git worktrees, where `.git` is a file) or a ZIP/manual install refuses the whole host with the fix command printed and skips Codex/Factory, so no host ends up driving another install's `bin/lib`; a third-party skill that happens to be named `z-*` is skipped with a warning and left untouched. Nothing setup didn't create gets deleted.
- Windows registration copies are staged and swapped by rename, so a locked file or mid-copy failure can't leave a half-registered skill, and they filter `.git` / `node_modules` / `.worktrees` / `.gstack` (~75MB of repo baggage the skills never read). A pack with no skills in it now fails setup loudly instead of printing the success banner over an empty registration.
- `Board.list()` paginates past 100 items with cursor-loop hardening (empty/repeated cursor and missing `pageInfo` throw loudly); single-page ceilings (fieldValues, projectItems, milestones, labels) guard with loud throws.
- Destructive board adopt now refuses without `--force` when non-canonical options on ANY single-select field (Status, Model, Model Effort) still hold items, names each option and count before any mutation, and rechecks immediately before mutating (refuses even under `--force` if the board moved).
- Setup's project/field lookups paginate — a project past page one is adopted, not duplicated.
- `link` (Depends-on) survives lost updates: line-exact verification (no more `#12` false-verifying `#1`), bounded re-append retries, per-issue in-process serialization; comment posts only after a verified write.
- Cost accounting prices a response exactly once even when its transcript lines mix requestId and message.id presence; blank or non-finite values are rejected before any NUMBER field write (a failed pipeline can no longer zero `Actual`).
- z-status reads ONE atomic board snapshot (no more mid-scan double-count/vanish), cleans up its temp dir, and dedupes by issue number with a visible warning.
- Lock/report reads distinguish "missing" from "unreadable": I/O failures raise errors instead of rendering a false idle dashboard.
- `atomicWrite` hardened for Windows: exclusive tmp create, bounded retry on transient rename errors, tmp cleanup on failure.
- The two skill-file grep gates scan the real `*/SKILL.md` targets with canary assertions and an exact allowlist; the scanner joins backslash continuations and covers all `gh` invocations (both proven evasions now self-tested).

### Changed

- `z-board list --status` is now optional: omitted lists the whole board in one paginated call (the atomic snapshot z-status consumes).
- `z-cost --json` emits machine-readable totals; z-loop's Actual write consumes it instead of parsing prose.
- `epicStyle "issue-type"` is rejected at config validation and z-setup until a sub-issue create path exists; epic style is always `milestones`.
- `field-get` on a nonexistent issue throws the same not-found error as other subcommands (was a silent empty value), and never falls back to another project's same-named field.
- Root strict `tsconfig` + `bun run typecheck` wired into the gate suite; shared CLI plumbing consolidated into `lib/cli.ts`; board statuses single-sourced in `lib/config.ts`.
- 100+ new gate tests (481 total), each proven to bite via mutation testing.

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

- The pre-landing review filed remediation issue #14 (pagination beyond 100 board items, epicStyle `issue-type` create path, cross-session claim identity, and others); all 22 items are closed in [0.1.1.0] above.
- Board creation, real multi-session lock concurrency, and issue-stays-open-on-Done are validated by design and gate tests but need one live run (`gh auth refresh -s project`, then `/z-setup`) to confirm end to end.
