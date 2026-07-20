# Changelog

All notable changes to zstack are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/); versions use `MAJOR.MINOR.PATCH.MICRO`.

## [Unreleased]

### Fixed

- `uninstall`/`setup` symlink-ownership resolution is now portable to pre-12.3 macOS. BSD `readlink` there lacks `-f`, so `readlink -f` returned empty and a genuinely-owned `z-*` symlink was never swept (`uninstall`), and `setup` refused to refresh it — the safe direction (no foreign target was ever deleted), but incomplete. A shared `_realpath` helper in both scripts now prefers `readlink -f` (GNU coreutils, macOS 12.3+) and falls back to a POSIX resolve loop (`while [ -L ]` + `cd "$(dirname)" && pwd -P`) where `-f` is unavailable. The invariant is unchanged: any failure to canonicalize a target still falls to leave-and-name, never to deletion. POSIX-gated tests run the resolution under a shimmed BSD `readlink` and assert an owned-into-pack link is still removed and a foreign-outside link is still left.
- `./setup` now exits non-zero with a clear "run setup from `~/.claude/skills/zstack`" message instead of printing `zstack setup complete.` when it refused to register the Claude Code host. That refusal happens when setup is run from a second checkout (a dev clone, a worktree) while a separate install occupies `~/.claude/skills/zstack`: the primary host registers nothing, but the success banner over that no-op read as "setup ran fine" while the skills never appeared. A Codex/Factory separate-install refusal still exits 0 (Claude Code itself registered) — only a refused primary host fails the run.

## [0.1.1.0] - 2026-07-19

Installing zstack now actually surfaces its skills. Also adds a `/z-uninstall` command, releases the issue #14 remediation (all 22 items closed), and includes an adversarial hardening pass (OpenAI Codex challenge + independent refute review, every fix mutation-tested).

### Added

- `/z-uninstall` (and the `uninstall` script beside `setup`) reverses `./setup`, honoring the same ownership rule setup uses: it removes only the host registrations it can prove it created — a symlink, or a copy carrying the `.zstack-registered` sentinel — and leaves any same-named directory it did not create, naming it. It never deletes the git clone at `~/.claude/skills/zstack` itself (it may be your only copy) — the exact `rm -rf` is printed instead. `--purge` also removes `~/.zstack` (config, loop state, locks, reports); `bin/z-setup-permissions --remove` strips exactly the auto-approval settings `/z-setup` wrote, leaving foreign keys/rules/hooks intact. The GitHub board, milestones, and labels are remote data and are never touched.
- Board shape (nine statuses, four custom fields, intended views) is data now (issue #20): the shipped `z-setup/board-template.json`, loaded and validated by `lib/board-template.ts` before any board mutation. The default is 1:1 with the previously hardcoded shape (same statuses in order, same fields + option colors). `z-setup-board plan|apply|verify --template <file>` ships a variant; the loader refuses a template whose status set is not the canonical nine or that drops/renames a required field (Model, Model Effort, Estimate, Actual), naming the field and the tool that breaks. GitHub's API has no view-creation mutation, so the template's views are printed as explicit manual steps rather than silently dropped.
- Two QA-loop knobs are per-project config now (#41): `maxQaPasses` (default 3 — QA passes before a still-buggy ticket parks Blocked) and `qaInvestigateAfter` (default 2 — the QA pass from which builder bounces carry `investigateFirst`). Set them in `~/.zstack/projects/<slug>/config.json` beside `maxLanes`; defaults reproduce the old hardcoded behavior exactly.

### Fixed

- `./setup` now registers each skill (`z-setup`, `z-plan`, `z-loop`, `z-status`, `z-uninstall`) as its own top-level entry in the host's skills directory. Hosts discover `skills/<name>/SKILL.md` one level deep only, so registering just the pack directory left all five skills invisible — worst on the documented clone-straight-into-`~/.claude/skills/zstack` path, which early-returned before registering anything. Run `./setup` after every install or update, then restart Claude Code; on Windows run it from Git Bash (`cmd.exe` leaves a literal `~` folder).
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
- The gh-direct-call code gate no longer scans `evals/` (#40): the planner eval harness quotes `gh` invocations in comments without ever shelling the real gh, and the widened detector from #23 flagged it after a cross-branch merge left main red. The gate's file filter is now a named `gateScans` predicate with a canary test pinning exactly which surfaces are excluded, so dropping the exclusion (or adding a new double) fails pre-merge instead of after the next merge collision.

### Changed

- `z-board list --status` is now optional: omitted lists the whole board in one paginated call (the atomic snapshot z-status consumes).
- `z-cost --json` emits machine-readable totals; z-loop's Actual write consumes it instead of parsing prose.
- `epicStyle "issue-type"` is rejected at config validation and z-setup until a sub-issue create path exists; epic style is always `milestones`.
- `field-get` on a nonexistent issue throws the same not-found error as other subcommands (was a silent empty value), and never falls back to another project's same-named field.
- Root strict `tsconfig` + `bun run typecheck` wired into the gate suite; shared CLI plumbing consolidated into `lib/cli.ts`; board statuses single-sourced in `lib/config.ts`.
- 100+ new gate tests (682 total), each proven to bite via mutation testing.

## [0.1.0.0] - 2026-07-19

First release of the zstack dev-loop skill pack. Installs at `~/.claude/skills/zstack` alongside gstack (required) and runs the [PROCESS.md](docs/user-guide/spec/PROCESS.md) development loop after planning, deploying at end of loop. GitHub Projects backed; solo-dev, any repo.

### Added

- **`/z-setup`** — creates or adopts a GitHub Projects board with the nine PROCESS.md statuses (Backlog, Ready, Questions, Building, QA, Review, Blocked, Skipped, Done) and four fields (Model, Model Effort, Estimate, Actual), disables the auto-close workflow, and offers an optional auto-approvals step so the loop runs unattended.
- **`/z-plan`** — turns a spec or plan into board-ready tickets: code-grounded plans with `### Acceptance Criteria`, dependency links, reproducible dollar estimates (per [ESTIMATION.md](docs/user-guide/spec/ESTIMATION.md)), and a model/effort recommendation per ticket. Oversized tickets split at a 400K-token context gate.
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
