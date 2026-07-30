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
   like `zstack update: 1.0.0.0 -> 1.0.1.0`. Skill registrations for every host
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

## Step 2 — Identity re-check (issue #66)

Runs only when Step 1 succeeded (outcome 1: exit 0) — a refused or failed
update (outcomes 2-3) skips this step; report the failure per Step 3 and stop.

`/z-setup`'s identity step (its own SKILL.md Step 7) raises the loop's GitHub
identity choice — a dedicated bot account, or continuing as the owner's own
login (issue #66) — once per project, and states the issue #204 consequence
("a standing human instruction left in a comment is invisible to the
planning pass") before accepting "continue as human." This step exists for
what that can't catch: a project's `config.json` written before issue #66
shipped has no recorded choice at all, and a bot's token can be
rotated/revoked later. It never re-asks a project that has already
answered, either way (AC6).

First, find every project this machine has configured that has not yet
answered — not just whichever repo `/z-update` happened to run from. This
half is pure enumeration, no decision, so it is safe to run as bash:

```bash
for SLUG in $(ls "$HOME/.zstack/projects" 2>/dev/null); do
  STATE=$(bun "$PACK/lib/identity.ts" state --slug "$SLUG" --raw 2>&1)
  CODE=$?
  if [ "$CODE" -ne 0 ]; then
    # A real failure (corrupt/unreadable config.json, or bun itself
    # erroring) -- NEVER treated the same as "unset" or as "already
    # answered". Warn on stderr (never stdout, which is the slug list the
    # prose below iterates) and leave the project for the next /z-update to
    # retry. The bug this replaces piped the JSON form through `jq` with
    # both halves' stderr suppressed by `2>/dev/null`: any failure (jq
    # missing -- it is not a checked prerequisite of this pack -- bun
    # erroring, an unreadable config) silently produced an empty $STATE,
    # which never matched "unset" and was never echoed -- indistinguishable
    # from "already answered", forever, with no error surfaced.
    echo "WARN: could not read identity state for '$SLUG' (exit $CODE): $STATE" >&2
    continue
  fi
  [ "$STATE" = "unset" ] && echo "$SLUG"
done
```

A machine with no configured projects at all (`~/.zstack/projects` empty or
missing), or none in state `"unset"`, prints nothing — Step 2 has nothing to
re-check, and Step 3 runs next. A `WARN` line means one project's state
couldn't be determined this run — name it in Step 3's report; it is neither
raised nor recorded as answered, so the next `/z-update` run tries again.

For EACH slug the enumeration above printed, ask the owner directly in your
own reply — do not wrap the ask in a bash conditional or let a bash variable
stand in for a human answer. (That is the exact bug this step used to have:
an `if` branching on `$OWNER_ANSWER`, a variable nothing ever assigned, so
the `else` fired unconditionally and recorded "human" with zero human
interaction.) Load that project's owner/repo for the brief:

```bash
read -r OWNER REPO <<<"$(bun -e "import {loadConfig} from '$PACK/lib/config.ts'; const c = loadConfig('$SLUG'); console.log(c.owner, c.repo)")"
```

Then ask via AskUserQuestion, decision-brief, condensed (full rationale
lives at z-setup/SKILL.md Step 7 and docs/user-guide/bot-identity.md, not
repeated here):

```
Should $OWNER/$REPO's loop run as its own bot GitHub account, or continue as
yours? This project predates issue #66 (or was never asked). "Continue as
yours" is fully supported, but leaves issue #204 live: a standing human
instruction left in a ticket comment is invisible to the planning pass
while the loop's login is your own. See docs/user-guide/bot-identity.md for
the bot-account walkthrough.
[A) Set up a bot account / B) Continue as my own account]
```

Record EXACTLY the branch the owner answered — never both, never a default:

- **Answer A (bot).** Confirm `gh` is authenticated as the bot
  (`gh api user -q .login` prints the bot's login, not `$OWNER`), then:

  ```bash
  bun "$PACK/lib/identity.ts" record --slug "$SLUG" --mode bot --token-location "<what the owner told you>"
  ```

- **Answer B (human).**

  ```bash
  bun "$PACK/lib/identity.ts" record --slug "$SLUG" --mode human
  ```

Repeat for every slug the enumeration printed.

## Step 3 — Report the result

State plainly:

- Whether the update succeeded, and the old → new VERSION if so.
- If it failed, which of the two failure modes above, and the exact next step
  (reinstall commands, or resolve the clone's git state).
- That the GitHub board, milestones, and labels are remote data this skill
  never touches, and that gstack (a separate pack) is unaffected.
- On success, which projects (if any) were raised by Step 2's identity
  re-check and what was recorded for each; a run with nothing to re-check
  states that plainly too.
- On success, name any project Step 2 could not read the identity state for
  (a `WARN` line) — it was neither asked nor recorded, and stays eligible
  for the next `/z-update` run.

## Done criteria

Report DONE only when:

- `bin/z-update` ran and its output (including any error) was shown verbatim.
- On success: the old → new VERSION was reported and `setup` re-ran to
  completion (its own "zstack setup complete." banner appeared).
- On success: Step 2 ran — every configured project with `identity` state
  `"unset"` was raised exactly once and its answer recorded; every project
  that had already answered (bot or human) was left untouched, unprompted;
  any project whose state could not be read (a `WARN` line, e.g. a corrupt
  `config.json`) was surfaced rather than silently treated as answered.
- On failure: the human was told exactly which failure mode occurred and the
  concrete next step to take (Step 2 does not run on a failed update).
