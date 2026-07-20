---
name: z-update
description: |
  Pulls the latest zstack pack source via git and re-runs ./setup so every
  registered skill refreshes. Thin wrapper over `bin/z-update`, the
  deterministic script that resolves which git clone backs this install (the
  clone itself, a symlinked registration, or -- on Windows -- the source
  recorded in a sentinel copy's marker), runs `git pull --ff-only` against it,
  then re-execs that clone's `setup`. Refuses with a reinstall message when no
  git source can be resolved (ZIP/manual installs) and touches nothing on
  disk in that case. If the pull itself fails (e.g. diverged local commits),
  it stops before running setup and surfaces git's error.
  Use when asked to "update zstack", "/z-update", "pull the latest zstack",
  "refresh zstack", or to bring an install up to date after the source repo
  changed.
---

# /z-update — Pull the latest zstack and re-run setup

Brings this machine's zstack install up to date: pulls the git source that
backs it, then re-runs that source's `./setup` so every host's skill
registrations refresh to match. This is the update flow; it is not uninstall
(`/z-uninstall`, #37) and it does not touch the GitHub board.

Resolve the pack directory once (same pattern as the other z-skills):

```bash
PACK="$HOME/.claude/skills/zstack"
[ -d "$PACK" ] || PACK="$(cd "$(dirname "${BASH_SOURCE:-$0}")/.." && pwd -P)"
```

---

## Step 1 — Run the update script

The deterministic half is `bin/z-update` at the pack root. It resolves the git
source, pulls `--ff-only`, prints the VERSION it moved from and to, then
re-execs that source's `setup --team`.

```bash
"$PACK/bin/z-update"
```

Do not re-implement any of its logic (source resolution, the pull, or the
re-exec into setup) in prose — the script is the sole owner of that decision,
and its self-replacement handling (wrapping the pull-onward logic so bash
can't misread its own file mid-pull) only holds if it runs unmodified.

Three outcomes:

1. **Success** — exit 0, output ends with `zstack setup complete.` after a line
   like `zstack update: 0.1.1.0 -> 0.1.2.0`. Skill registrations for every host
   `setup` covers (Claude Code, and Codex/Factory if installed) are refreshed.
2. **No resolvable git source** — exit non-zero, a message naming the exact
   `git clone` + `cd ... && ./setup` commands to reinstall from git. Nothing on
   disk was touched (this only happens for ZIP/manual installs with no `.git`
   anywhere and no recorded source). Tell the human this install can't
   self-update and point them at the printed reinstall commands.
3. **`git pull --ff-only` fails** (diverged local commits in the clone) — exit
   non-zero, git's own error shown. `setup` never ran; registrations are
   unchanged. Tell the human the clone has local changes or diverged history
   that need resolving by hand (e.g. `git -C <clone> status`) before the next
   `/z-update` attempt.

Show the human the script's output verbatim in every case.

## Step 2 — Report the result

State plainly:

- Whether the update succeeded, and the old → new VERSION if so.
- If it failed, which of the two failure modes above, and the exact next step
  (reinstall commands, or resolve the clone's git state).
- That the GitHub board, milestones, and labels are remote data this skill
  never touches, and that gstack (a separate pack) is unaffected.

## Done criteria

Report DONE only when:

- `bin/z-update` ran and its output (including any error) was shown verbatim.
- On success: the old → new VERSION was reported and `setup` re-ran to
  completion (its own "zstack setup complete." banner appeared).
- On failure: the human was told exactly which failure mode occurred and the
  concrete next step to take.
