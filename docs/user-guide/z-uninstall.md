# /z-uninstall

Removes what zstack's `./setup` installed on this machine, honoring the same
ownership rule setup uses: it never deletes a directory it cannot prove it
created. Destructive, so it confirms with you first. GitHub-side data (the board,
its milestones, its labels) is remote and never touched.

Full skill contract: `z-uninstall/SKILL.md`. The deterministic half is the
`uninstall` script at the pack root, a sibling of `setup`.

## When to run it

When you want zstack off this machine, or to undo a specific install. It is safe
to run more than once — a second run is a clean no-op ("nothing to remove").

## What it removes (and what it deliberately does not)

1. **Host skill registrations.** For each host skills dir that exists
   (`~/.codex/skills`, `~/.factory/skills`, then `~/.claude/skills` last, so the
   command deletes its own registration as its final act), it removes the `zstack`
   pack entry and any `z-*` skill entry **only when it owns them**:
   - a **symlink** (the macOS/Linux install) — self-evidently ours, and removing
     the link never touches its target;
   - a **copy carrying the `.zstack-registered` sentinel** (the Windows install) —
     setup drops that marker into every copy so a copy is distinguishable from a
     user's own same-named directory.

   A same-named directory with neither proof is **left in place and named** — the
   mirror of setup's "already exists as a separate install; skipping" refusal.
   Neither tool touches a directory it did not create.

2. **The clone itself is never deleted.** If the pack IS the git clone at
   `~/.claude/skills/zstack` (you cloned straight into the skills dir), that clone
   is left alone — it may be your only copy — and the exact `rm -rf` command is
   printed for you to run by hand.

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

## Second run is a clean no-op

Running `uninstall` again after everything is gone exits 0 and prints "nothing to
remove". There is no error, no partial state.

## Done when

- You confirmed the uninstall, the `uninstall` script exited 0 and its output was
  shown, the auto-approval settings were removed if present (or confirmed absent),
  and you were told the GitHub-side artifacts were not touched.

## Common snags

See `troubleshooting.md`: "uninstall left a directory it did not create" — the
ownership rule in action, and how to remove such a directory yourself.
