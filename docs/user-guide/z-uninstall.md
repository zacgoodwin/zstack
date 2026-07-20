# /z-uninstall

Removes what zstack's `./setup` installed on this machine, honoring the same
ownership rule setup uses: it never deletes a directory it cannot prove it
created. Destructive, so it confirms with you first. GitHub-side data (the board,
its milestones, its labels) is remote and never touched.

Full skill contract: `z-uninstall/SKILL.md`. The deterministic half is the
`uninstall` script at the pack root, a sibling of `setup`.

## When to run it

When you want zstack off this machine, or to undo a specific install. It is safe
to run more than once: once a symlink install, or a copy whose registration you
remove from the source clone, is gone, a second run finds nothing to remove. Two
installs are the exception — a clone you put straight into the skills dir, and the
Windows copy `/z-uninstall` runs from — because there the pack directory the
command executes from IS the registration, and it cannot delete itself. Each run
(the second included) reports that directory left with the manual `rm -rf`, not
"nothing to remove"; see below.

## What it removes (and what it deliberately does not)

1. **Host skill registrations.** For each host skills dir that exists
   (`~/.codex/skills`, `~/.factory/skills`, then `~/.claude/skills` last, so the
   command deletes its own registration as its final act), it removes the `zstack`
   pack entry and any `z-*` skill entry **only when it owns them**:
   - a **symlink whose target resolves into the pack** (the macOS/Linux install) —
     setup only ever links to the pack or a skill dir inside it, so a link that
     lands there is provably ours; removing the link never touches its target;
   - a **copy carrying the `.zstack-registered` sentinel** (the Windows install) —
     setup drops that marker into every copy so a copy is distinguishable from a
     user's own same-named directory.

   A same-named directory with neither proof — **or a symlink pointing OUTSIDE the
   pack** (your own `z-*` link that merely shares the name) — is **left in place
   and named**, the mirror of setup's "already exists as a separate install;
   skipping" refusal. Neither tool touches a directory or link it did not create.

2. **The clone itself is never deleted.** If the pack IS the git clone at
   `~/.claude/skills/zstack` (you cloned straight into the skills dir), that clone
   is left alone — it may be your only copy — and the exact `rm -rf` command is
   printed for you to run by hand. The Windows registered copy that `/z-uninstall`
   runs from is likewise left — the command cannot delete the copy it is executing
   from — but it is named a registered copy (its source elsewhere owns the install),
   with its own `rm -rf`, not the "only copy" warning.

3. **`~/.zstack` only under `--purge`.** Per-project state (board config, loop
   counter, locks, run reports) is kept by default, with its path and the purge
   command printed. `/z-uninstall`'s Step 1 asks whether to purge; the script's
   `--purge` flag does it. Purging a project's config means the next `/z-loop` on
   that repo needs `/z-setup` again — but the board and its ticket statuses live
   on GitHub and are unaffected.

4. **Claude Code auto-approvals, only if present.** `/z-setup` Step 7 optionally
   wrote permission entries into `~/.claude/settings.json` (an allow hook,
   `bypassPermissions` + skip flags, and the git/gh/bun/bunx allow rules).
   `bin/z-setup-permissions --remove` strips **exactly** those and nothing else —
   a foreign allow rule, your own `defaultMode`, and any other hook survive. It
   writes atomically, re-reads to verify, and is idempotent. `--check` first tells
   you whether anything of ours is there; if all three layers are ABSENT, there is
   nothing to remove. These settings are machine-wide, so removing them restores
   prompting for every project, not just this repo.

5. **Not touched:** the GitHub board, milestones, and labels (remote data — delete
   them yourself on github.com if you want them gone), and gstack (a separate
   pack). This is uninstall, not the update flow (#36).

## Running it again

For a symlink install, or a copy whose registration you remove from the source
clone, the first run removes everything it owns, so a second run exits 0 and
prints "Nothing to remove -- no zstack registrations found". There is no error, no
partial state.

Two installs are the exception, and in both the pack directory the command runs
from IS the registration it cannot delete out from under itself:

- A **clone you put straight into the skills dir** (`~/.claude/skills/zstack` **is**
  the git clone, no sentinel). It may be your only copy, so it is deliberately
  never deleted; every run reports it left and prints the exact `rm -rf`.
- The **Windows registered copy `/z-uninstall` runs from.** The command resolves the
  pack to `~/.claude/skills/zstack` and executes that copy's own `uninstall`, so the
  running directory is a sentinel-carrying copy it cannot self-delete; every run
  names it a registered copy and prints the `rm -rf` to run from the source or by
  hand.

That is expected, not an error: "Nothing to remove" prints only once there is
genuinely nothing left that we own, and a deliberately-retained running directory
is something we keep, not something we failed to remove.

## Done when

- You confirmed the uninstall, the `uninstall` script exited 0 and its output was
  shown, the auto-approval settings were removed if present (or confirmed absent),
  and you were told the GitHub-side artifacts were not touched.

## Common snags

See `troubleshooting.md`: "uninstall left a directory it did not create" — the
ownership rule in action, and how to remove such a directory yourself.
