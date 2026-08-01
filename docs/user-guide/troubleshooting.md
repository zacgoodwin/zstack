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

## The board says Building for a ticket the loop is actually QA-ing or reviewing

A stage transition skipped its board write. Every `advance` is two writes — the
orchestrator moves the ticket to the new stage's status, then the apply stamps
`state.json` — and `bun lib/loop.ts apply` prints the status the board must now
read:

```text
applied advance #168
board must now read #168 = QA -- this action's row moves it; repair a mismatch with: z-board move 168 QA --if-present --slug <slug>
```

If that move never ran, the board keeps showing the previous stage. Confirm it
from the state file: the lane is at the newer stage and still carries the
in-flight-write marker.

```bash
jq '.lanes[] | select(.ticket==168)' ~/.zstack/projects/<slug>/loop/state.json
# {"ticket":168,"stage":"qa",…,"lastWroteStatus":"QA"}   <- board never showed QA
```

Fix it by hand and the next tick's ingest clears the marker:

```bash
z-board move 168 QA --if-present --slug <slug>
```

A `lastWroteStatus` that survives tick after tick is always this bug — the marker
exists to name a write still in flight, and ingest drops it the moment a board
read shows that status land.

## A resumed run rebuilt work that was already committed

The symptom above is what costs money. A ticket is always claimed at the stage
its **board** status names (Building → builder, QA → qa, Review → reviewer;
`lanes.ts` `claimStage`), so a lane that had reached QA while the board still
said Building comes back as a *builder*, spawns a fresh build agent on a branch
whose work is already committed, and pays for it again.

Which recovery a dead run gets depends on whether it left a lane lock behind:

- **Lock left behind** (the usual hard crash): startup refuses to run until you
  pass `/z-loop --reconcile`, which releases the claim, prunes the worktree, and
  parks the ticket back to **Ready**. That is a deliberate rebuild — reconcile
  will not guess a stage from a lock whose worker is gone — and a correct board
  status does not change it.
- **No lock** (the lane was dropped cleanly by a `stop-lane`, a previous
  `--reconcile` already pruned it, or the lock was cleared by hand): nothing
  marks the ticket as crashed, so the next tick simply claims it at the stage its
  board status names. This is the path a stale board turns into a rebuild, and it
  is the one the board write protects.

So before re-running: check that every in-flight ticket's board status matches
the stage its lane reached (`jq '.lanes' …/state.json` against `/z-status`) and
move any that disagree; then pass `--reconcile` if the crash left lane locks or
orphan worktrees.

If a rebuild already happened, the branch is intact (the loop never deletes
branches) and the duplicate work is in the same worktree; the cost is the wasted
build, not lost code.

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
