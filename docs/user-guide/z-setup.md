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
2. **Epic style (D1).** Asks how epics are modeled: a GitHub milestone per epic
   (recommended) or an epic issue with sub-issues. Written to `epicStyle`.
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
   the three layers are present. Undo is a documented hand-edit (see the SKILL).

## Done when

- The scoped GraphQL probe passed, `verify` exited 0, the two workflows are OFF,
  `config.json` exists and loads, `/setup-deploy` ran, and the auto-approvals
  offer was made (its A/B/C answer does not gate Done). A re-run makes zero
  changes.

## Common snags

See `troubleshooting.md`: gh scope refresh, and the settings.json write-race note
if a prompt slips through right after choosing A (restart the straggler session).
