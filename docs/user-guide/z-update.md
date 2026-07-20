# /z-update

Pulls the latest zstack pack source via git and re-runs `./setup` so every
registered skill refreshes. This is the update flow; it is not
[/z-uninstall](z-uninstall.md) and it never touches the GitHub board.

Full skill contract: `z-update/SKILL.md`. The deterministic half is
`bin/z-update` at the pack root, a sibling of `setup` and `uninstall`.

## When to run it

After the source repo (or your local clone of it) changes — a new release, a
`git pull` you haven't followed up with `./setup` yet, or just to make sure
you're current. Safe to run any time; a no-op pull (already up to date) still
re-runs `setup`, which is itself idempotent.

## How source resolution works

`bin/z-update` has to figure out which git clone backs the CURRENT install
before it can pull anything, in priority order:

1. **The pack directory itself is a git checkout.** Covers both a direct
   clone (`git clone ... ~/.claude/skills/zstack`) and the macOS/Linux
   install, where `~/.claude/skills/zstack` is a symlink into the real clone —
   resolving the symlink is automatic (`pwd -P` follows it), no separate case
   needed.
2. **A sentinel copy names its source.** The Windows install path copies the
   pack instead of symlinking it; every copy `./setup` creates carries a
   `.zstack-registered` marker whose second line records the absolute path of
   the clone it came from (`source: /c/Users/you/...`). `bin/z-update` reads
   that line and pulls the clone it points at.

If neither resolves — a ZIP download, a hand-copied directory, or a legacy
marker written before this line existed — there is no git history to pull
from. `bin/z-update` refuses immediately, prints the exact `git clone` +
`cd ... && ./setup` commands to reinstall from git, and **touches nothing on
disk**.

## What a run does

1. Resolve the source clone (above).
2. `git -C <clone> pull --ff-only`. A clean fast-forward is the only outcome
   accepted — if the clone has diverged local commits, the pull fails, its
   error is shown verbatim, and `bin/z-update` stops there. `setup` never
   runs; nothing already registered changes. Resolve the clone's git state by
   hand (`git -C <clone> status`, then `pull`/`rebase`/`reset` as appropriate)
   and run `/z-update` again.
3. Print the VERSION before and after the pull.
4. Re-run that clone's `setup --team`, which refreshes every host's
   registrations ($HOME/.claude/skills, plus Codex/Factory if installed) the
   same way a fresh install would.

## Self-replacement, handled

`bin/z-update` and `setup` both live inside the git source `git pull` just
rewrote. The pull-onward logic runs from inside a single wrapping function so
bash has already read the whole thing into its parser before any of it
executes, and the function's own last statement replaces the process
(`exec`) into the freshly-pulled `setup` — nothing here re-reads its own
(possibly just-rewritten) script file after the pull.

## Done when

- `bin/z-update` (or `/z-update`) exited 0, the old → new VERSION was shown,
  and `setup`'s own "zstack setup complete." banner appeared.
- Or it refused cleanly: either a reinstall message with nothing touched on
  disk, or a surfaced `git pull` failure with registrations unchanged.

## Common snags

- **"no git source found for this install"** — a ZIP or manually-copied
  install has no `.git` to pull. Reinstall from git (the printed commands) to
  get an updatable install.
- **`git pull --ff-only` fails** — the clone has local commits that aren't on
  the remote. This is your working copy, not a managed cache: reconcile it by
  hand (`git status`, then merge/rebase/reset) before re-running `/z-update`.
