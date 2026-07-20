---
name: z-uninstall
description: |
  Remove what zstack's ./setup installed on this machine: the pack registration
  (and any z-* skill entries) from each host skills dir it owns, and -- with
  --purge -- ~/.zstack (project configs, loop state, locks, reports). Honors the
  same ownership rule setup uses: it never deletes a directory it cannot prove it
  created (a symlink, or a copy carrying the .zstack-registered sentinel). Also
  strips the Claude Code auto-approval entries /z-setup's Step 7 wrote, when they
  are present. Destructive: confirms with you first. GitHub-side data (the board,
  milestones, labels) is remote and never touched.
  Use when asked to "uninstall zstack", "remove zstack", "z-uninstall", or to undo
  a zstack install on this machine.
---

# /z-uninstall — Remove zstack from this machine

You are removing the zstack install `./setup` created. This reverses `./setup`
(and, optionally, the auto-approvals `/z-setup` Step 7 wrote). It is destructive,
so **confirm with the human before doing anything**. It touches only local files:
the GitHub board, its milestones, and its labels are remote data this skill never
reaches — say so, and leave them to the human.

Resolve the pack directory once (same pattern as the other z-skills):

```bash
PACK="$HOME/.claude/skills/zstack"
[ -d "$PACK" ] || PACK="$(cd "$(dirname "${BASH_SOURCE:-$0}")/.." && pwd -P)"
```

---

## Step 1 — Confirm (destructive)

Ask via AskUserQuestion before removing anything. Two decisions in one:

1. **Proceed with uninstall?** Removing the skill registrations means `/z-setup`,
   `/z-plan`, `/z-loop`, `/z-status`, and this command stop being available on
   this machine until re-installed.
2. **Also purge `~/.zstack`?** That is per-project state: board config, loop
   counter, locks, and run reports. Without purge it stays, and its path plus the
   removal command are printed. **Purging a project's config means the next
   `/z-loop` on that repo needs `/z-setup` again** (the board itself, and its
   ticket statuses, are unaffected — they live on GitHub).

Options to present:
- **A) Uninstall, keep `~/.zstack`** (recommended) — registrations removed, local
  project state preserved.
- **B) Uninstall and `--purge`** — also delete `~/.zstack`.
- **C) Cancel** — do nothing.

If C, stop. Do not run anything below.

---

## Step 2 — Run the uninstall script

The deterministic half is `uninstall` at the pack root. It removes only what it
owns (a symlink, or a copy carrying `.zstack-registered`); a same-named directory
it cannot prove it created is left in place and named. If the pack IS the git
clone at `~/.claude/skills/zstack`, that clone is left alone (it may be your only
copy) and the exact `rm -rf` command is printed for you to run by hand.

```bash
# A) keep ~/.zstack
"$PACK/uninstall"
# B) also purge ~/.zstack
"$PACK/uninstall" --purge
```

Show the human its output verbatim: what was removed, what was left and why, and
any printed `rm -rf` command for a clone or for `~/.zstack`.

---

## Step 3 — Remove the auto-approval settings (only if present)

`/z-setup` Step 7 optionally wrote Claude Code permission entries into
`~/.claude/settings.json` (an allow hook, `bypassPermissions` default mode + skip
flags, and the git/gh/bun/bunx allow rules). Check whether any are present, and
strip exactly those — leaving every other setting intact — only when they are:

```bash
"$PACK/bin/z-setup-permissions" --check    # reports hook / bypassMode / allowlist
"$PACK/bin/z-setup-permissions" --remove   # strips ONLY zstack's entries
```

`--remove` is a read-modify-write that removes only the allow rules, bypass keys,
and the PermissionRequest hook carrying zstack's own reason marker; it preserves
foreign rules, a user's own `defaultMode`, and any other hook. It writes
atomically and re-reads to verify, and is idempotent (a second `--remove` reports
zero changes). Default path is `~/.claude/settings.json`; pass `--path` to target
another file (tests always do). If `--check` shows all three layers ABSENT, there
is nothing to remove — skip this step and say so.

Note the machine-wide caveat: these settings are shared by every project on this
machine, so removing them restores prompting everywhere, not just for this repo.

---

## Step 4 — Report what remains

Tell the human plainly:

- Which host registrations were removed, and any left untouched (with the reason).
- Whether `~/.zstack` was purged or kept (and, if kept, its path + the purge
  command).
- Whether the auto-approval settings were removed or were already absent.
- That the **GitHub board, milestones, and labels are remote data this skill does
  not touch** — if they want those gone, they delete them themselves on
  github.com. gstack is a separate pack and is likewise untouched (see #36 for the
  update flow; this is uninstall, not update).

## Done criteria

Report DONE only when:

- The human confirmed the uninstall (Step 1), and this ran the matching command.
- `uninstall` exited 0 and its output was shown.
- The auto-approval settings were removed if present, or confirmed already absent.
- The human was told the GitHub-side artifacts are remote and were not touched.
