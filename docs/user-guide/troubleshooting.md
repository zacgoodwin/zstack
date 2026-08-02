# Troubleshooting

The failure modes zstack surfaces on purpose, and what to do about each. All of
these are deliberate stops — the loop refuses to guess or to burn tokens while
wedged.

## Installed the pack but /z-setup, /z-plan, /z-loop, /z-status, /z-uninstall, /z-update don't appear

Claude Code builds its skill list from `~/.claude/skills/<name>/SKILL.md`,
exactly one level deep — SKILL.md files nested inside the pack directory are
invisible. `./setup` registers each skill as its own top-level entry
(`~/.claude/skills/z-setup` etc.), so:

1. Run `./setup` from the pack directory (mandatory even if you cloned straight
   into `~/.claude/skills/zstack` — early versions skipped registration
   entirely on that path; `git pull` first if yours does).
2. Restart Claude Code: the skill list is scanned at session start.
3. On Windows, check for a literal `~` folder in `~/.claude/skills` — it means
   the install commands ran in `cmd.exe`, which doesn't expand `~`. Delete it
   and re-run the install from Git Bash.
4. If `./setup` printed `is a separate zstack install we didn't create; leaving
   Claude Code untouched`, another clone or manual copy already owns
   `~/.claude/skills/zstack`, and setup refuses to register this pack's skills
   against it (it also skips Codex/Factory until that is resolved — re-running
   from here keeps refusing, by design). Either run `./setup` from that install
   instead, or replace it with this one:
   `rm -rf ~/.claude/skills/zstack`, then re-run `./setup` from your clone.

Verify: `ls ~/.claude/skills/z-*/SKILL.md` should list six files.

## gh: "missing required scopes [read:project]"

The board lives in GitHub ProjectV2, which needs the `project` scope on your gh
token. `/z-setup` checks this first and will refresh it for you, but if you hit it
elsewhere:

```bash
gh auth refresh -s project
gh api graphql -f query='query { viewer { login } }' >/dev/null && echo "scopes OK"
```

The scoped GraphQL probe is the real proof — a clean `gh auth status` alone is not
enough. Do not proceed until the probe passes.

## /z-loop refuses to start: "a /z-loop is already running"

The loop lock (`~/.zstack/projects/<slug>/locks/loop.lock`) names a live session.
This is the **second-invocation guard**: two loops on one project would fight over
the same tickets and worktrees. Options:

- It really is running elsewhere → let it finish, or stop that session.
- It crashed and the lock is stale → the message says so, and names the evidence
  ("no sign of life for N minutes", or "no heartbeat was ever recorded"); start
  with `/z-loop --reconcile`.

A **live** lock never clears via reconcile — you cannot reconcile over a running
loop, by design. Since #198 that is enforced in code as well: `reconcile apply`
itself refuses while the lock is live, rather than trusting the caller to have
checked. The loop passes its own `--session` so its Step 0 recovery pass still
works; a bare human invocation has no session and is refused.

### The liveness heartbeat (`locks/loop.lock.beat`)

Liveness is judged against a **heartbeat**, not against the lock's creation time.
`bin/z-loop-tick` re-stamps `locks/loop.lock.beat` every iteration, so the
question the lock answers is "was this loop seen recently" rather than "did it
start recently".

That distinction matters because `loop.lock` is written once and never
re-stamped. Before #198 a loop that simply ran longer than `lockStalenessMinutes`
(default 60) read as **stale while it was still running**, and the refusal
message told the next operator the loop "likely crashed. Re-run /z-loop with
--reconcile" — which parks the live run's tickets back to Ready and deletes its
worktrees. Real drains run for hours, so this was the ordinary case, not an edge:
it was reproduced against a live run at `age_minutes: 198` with a 60-minute
window.

**Do not delete `loop.lock.beat` while a loop is running** — you would make a
live loop look crashed. It is removed automatically on release and by
`--reconcile`. A beat naming a session that does not match the lock is ignored,
so a leftover file from an earlier run is harmless, and a corrupt one degrades to
the old creation-time behaviour rather than failing the run.

`--reconcile` serializes its clear-and-replace through a one-shot claim file,
`locks/loop.lock.reconcile`. If a run is killed mid-reconcile the claim can be left
behind; it carries the same payload as the loop lock, so the next `--reconcile`
judges it the same way — a claim whose process is dead (or that is older than
`lockStalenessMinutes`) is superseded automatically and the run proceeds. Superseding
writes the next generation next to it (`loop.lock.reconcile.1`, `.2`, …) rather than
deleting the orphan, so two runs racing the same orphan can never both win; the winner
removes every generation when it is done. Do not delete any of them by hand; a claim
that is *not* superseded belongs to a reconcile that is still running.

## /z-loop refuses to start: orphans present

A crashed prior run left lane locks with no live loop, worktrees with no lock, or
Building tickets with neither. The loop refuses rather than step on half-finished
state:

```bash
/z-loop --reconcile
```

Reconcile releases claims, parks the affected tickets back to Ready, prunes the
stray worktrees (a crashed builder's uncommitted work is discarded — the ticket
rebuilds fresh), and clears the stale lock, then starts normally. It never deletes
a branch, never removes a board comment, and never touches a ticket that still has
a live lane.

## "Rates last checked … over the 14-day limit"

`bin/z-estimate` / `bin/z-cost` warn when `references/rates.json`'s `checked_at`
is more than 14 days old. The dollar figures are still computed, but the published
model prices may have moved. Verify current rates and update `references/rates.json`
(bump `checked_at` to today). The warning is a nudge, not a hard stop.

## `z-context-audit` aborts instead of printing a number

The audit exists to produce a figure you can act on, so it refuses to print one
it cannot stand behind. Each message below stops the whole run — a sweep reports
nothing rather than a rollup that quietly understates the corpus, and names how
far it got first (`aborted on <path> (file 12 of 91; 11 audited cleanly before
it)`). None of them are input you can fix by retrying: each says the transcript
format moved under an assumption the arithmetic rests on, so the fix is in
`lib/context-audit.ts`, not in your invocation. File it.

- **"two lines of one API response disagree about billed input"** — dedup keeps
  the first usage snapshot a response shows, which is only sound because Claude
  Code repeats one snapshot verbatim on every content-block line of that
  response. Zero disagreements when it was measured across this machine's 18,340
  lines, which is exactly why it would go unnoticed the day it changed.
- **"assistant usage line carries neither `requestId` nor `message.id`"** — with
  no stable response id, dedup falls back to a file-and-line key, which is
  unique per line and restores the ~1.87x per-block overcount dedup removes.
- **"carries N assistant usage line(s), but none yielded a billable window"** —
  the usage lines are there, but each reads 0 or dedups into one that does. That
  is spend the tool cannot read; skipping it would drop a session at exit 0.
- **"holds N assistant message(s) carrying no recognized usage object"** — a
  session that got real replies, so this reads as a usage-schema rename rather
  than an empty transcript.
- **"has no parseable line at all (N skipped)"** — corruption. A transcript
  caught mid-write still leaves the earlier complete lines behind.

Two neighboring messages are *not* format drift:

- **"carries no assistant usage line, so there is nothing to attribute"** — an
  abandoned prompt. A sweep (several paths, or any glob) skips it and lists it
  under `unauditable`; one literal path is a question about that file, so there
  it is an error. A wholly-sidechain transcript reads the same way — that is a
  subagent's window, not the orchestrator's; price those with `bin/z-cost`.
- **"No files matched …"** — the glob expanded to nothing, usually a mistyped
  extension or directory. Quote the pattern so your shell doesn't expand it
  first, and note that a path that exists on disk is always treated as a literal
  even when its name contains `*`, `?`, or brackets.

Mid-file corruption warns rather than aborts: `N unparseable line(s) sit BEFORE
end-of-file` goes to stderr and `skippedBeyondFinalLine` into `--json`. The
rollup still prints, short by whatever those lines held.

## "Loop counter … is corrupt"

`~/.zstack/projects/<slug>/loop-counter` must be a single non-negative integer. If
it is anything else, `endloop.ts` throws loudly instead of silently resetting to 0
— a silent reset would re-run the Nth-loop `/cso` + `/health` audits (config
`auditEveryNLoops`, default 5) on the wrong cadence. Fix the file by hand: set it
to the number of loops actually completed
(a missing file correctly reads as 0). Never blank it to "skip" the audits.

## A permission prompt slips through right after choosing auto-approvals (A)

`/z-setup`'s auto-approvals (option A) sets `defaultMode` and the skip flags, which
Claude Code reads **at session startup only**. A session already running keeps
prompting until it restarts. If a prompt appears right after you answered A, that
is a straggler session, not a bug — restart it. `bin/z-setup-permissions --check`
confirms all three layers (hook / bypass mode / allowlist) are present.

## Done tickets are still open on the board

That is intended. The loop never calls `gh issue close`; it leaves Done tickets
OPEN with a completion note so a human validates the edges the note names, then
closes them. If you want them to auto-close, that fights the loop — leave the
"close issue on Done" workflow OFF (see `/z-setup` Step 4).

## "#N sits in board status …, which the loop does not drive; ignoring it"

You added a column to the board that is not one of the canonical nine, and a
ticket is sitting in it. The line is informational: the loop skips that ticket
for the whole run and touches nothing else. If the ticket was mid-flight when
you moved it, its lane also stops — that is the intended way to pull a ticket
out of a running batch by hand. Move it back to Ready to hand it to the loop.

If you did not expect the message, check the ticket's Status field for a typo or
a renamed column: the loop matches status names exactly.

## setup: "already exists as a separate install; skipping" — and its uninstall mirror

Both ends of install honor one rule: **never touch a directory we did not
create.** `./setup` refuses to register when `~/.claude/skills/zstack` is already
a real (non-symlink) directory pointing at a different install — it prints
"already exists as a separate install; skipping … registration" and leaves your
directory alone rather than clobbering it.

`/z-uninstall` is the mirror. It removes a host registration only when it can
prove ownership — a **symlink whose target resolves into the pack**, or a **copy
carrying the `.zstack-registered` sentinel** setup drops into every copied
install. A same-named directory — or a symlink pointing outside the pack — with
neither proof is **left in place and named**:

```text
  left /…/.claude/skills/zstack -- not created by zstack (no symlink, no .zstack-registered); left untouched.
```

If that directory really is a stale or unwanted zstack copy you want gone, remove
it yourself: `rm -rf ~/.claude/skills/zstack`. The tool won't do it for you
because it cannot tell your directory apart from a same-named one it never made.

One special case: when the pack **is** the git clone at `~/.claude/skills/zstack`
(you cloned straight into the skills dir), `/z-uninstall` leaves the clone — it may
be your only copy — and prints the exact `rm -rf` command for you to run by hand.
Run it only if you have another copy or don't need the source.

## "OVER-CEILING: #N … exceeded a per-item pagination ceiling" / "exceeds its single query page and would be silently truncated"

`z-board` reads each item's labels, custom-field values, and (per issue) assignees
in one GraphQL page each — 20 labels, 20 field values, 10 assignees. Those ceilings
never move (raising them isn't the fix), but what happens when a ticket blows past
one depends on where it happens:

- **`z-board snapshot`** (the drain loop's per-tick board read): an item over its
  labels or field-values ceiling is **skipped from that snapshot only** — every
  other item still comes back, and the offending ticket number is printed on
  stderr as `OVER-CEILING: #N …`. The tick is never wedged over one runaway
  ticket. Fix the named ticket (see below) and it rejoins the next snapshot.
- **`claim` / `move` / `comment` / `field-get` / `field-set` / `link` / `release`**
  (anything that looks up a single issue): an assignees list over 10 throws loud —
  `assignees for issue #N (ceiling: 10 assignees per issue) exceeds its single
  query page and would be silently truncated` — and refuses to act. This guards
  `claim()`'s "sole assignee is me" ownership check: a silently truncated
  10-assignee page could otherwise misjudge a ticket it should have refused.

Either way, the fix is the same: reduce what's on the issue.

```bash
gh issue edit <N> --remove-label <one-of-the-labels>
gh issue edit <N> --remove-assignee <one-of-the-logins>
```

Trim labels to 20 or fewer, custom field values to 20 or fewer, and assignees to
10 or fewer, then re-run the failing command. Full cursor pagination of these
per-item connections is out of scope — the ceilings are a deliberate bound on a
per-ticket query shape, not a bug to paginate away.
