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

## A ticket was Skipped with a dead-worker note but its worktree has real uncommitted changes

The stage agent died without emitting an exit marker. That parses as CONFUSED,
which skips the ticket — the right answer when the agent could not do the job, the
wrong one when it simply never said it did (a builder that backgrounds its own test
run and stops to wait for it is the case that started this).

What the loop does now: the dead-worker probe collects the lane worktree's
`git status --porcelain --branch`, and a lane whose worker died holding uncommitted
changes re-spawns that stage **once** — a fresh agent, told the prior attempt's
changes are uncommitted and UNVERIFIED and that keeping, fixing, or dropping them
is its own call. The budget is one re-spawn **per stage, per lane**, so a ticket
whose builder was recovered this way still has a re-spawn left if its QA agent later
dies the same way. Only after that stage's one re-spawn is spent does the skip
apply, and that skip dumps the worktree's uncommitted state first:

```bash
git apply ~/.zstack/projects/<slug>/reports/uncommitted-<N>.patch   # in a fresh worktree
```

Do that **before** the next `/z-loop` run. Skipping releases the lane lock, and a
lockless worktree is an orphan the next run's reconcile scan force-removes
(`git worktree remove --force`, uncommitted work discarded) before the loop will
start — so the patch, not the worktree, is the durable copy. Then return the ticket
to Ready.

If you are seeing this on a run that predates the fix, or the skip note says
`worktree left for inspection` with no patch path, the worktree facts were never
collected — recover by hand from `.worktrees/ticket-<N>` immediately, before the
next run's orphan scan prunes it. The same note appears when `git status` in that
worktree produced no output at all (a missing or broken checkout: git always
prints its `## <branch>` header when it runs), which is treated as "nothing to
recover" rather than re-spawning an agent into a directory that is not there.

Two cases deliberately do **not** re-spawn even with changes in the worktree: a
dead **merge** worker (its PR state is verified first, so it ends Merged or
Blocked, never Skipped), and a ticket a human moved to Blocked/Questions during
the run — that move is respected, so the lane just stops, keeps the human's status
and its worktree, and spends nothing.

If a stage keeps dying silently, the cause is usually upstream of the loop: check
whether the ticket is large enough to exhaust the agent's context window, and
whether the stage prompt's foreground rule is being honored (verification must
finish before the final message — a backgrounded gate can never report back,
because the loop sends each stage agent exactly one message by design).

## A healthy stage was probed (or Skipped) while it was still working

Before #256 this was the expected behavior, not a fault: `watchdogMinutes` was
compared against the moment the stage STARTED, because nothing in the pack ever
observed a worker. So the timer fired that many minutes after the claim however
hard the agent was working, and a QA stage — ordered to run typecheck, the full
suite, and the build before touching its first acceptance criterion, which is
121s idle and 234s under load on this repo — routinely crossed the old 10-minute
default while perfectly healthy. If the harness had already forgotten the agent
by then, the probe answered dead and the ticket was Skipped with real work in it.

Now the baseline is real silence. Every tick reads the newest transcript record
across the lane's stage agent and every sub-agent it spawned, and moves the
lane's baseline forward to it, so only a lane that has written nothing for
`watchdogMinutes` is probed. The default is 15, derived as 2x the longest
measured gap between a working agent's own records (423s over 9,589 mid-work
samples).

If you still see a working stage probed, read the tick's stderr for:

```text
loop heartbeat: no session transcript directory resolved; every lane keeps its current watchdog baseline.
#<N> <stage> no subtree observed; baseline unchanged
```

Either line means the observation is not happening for that lane and it has
fallen back to the old stage-age timer. The usual causes: the loop is running in
a directory whose Claude Code session transcript cannot be resolved, or the stage
was spawned without its `--spawn-tag` stub (the tag is how a lane finds its own
agent among every other lane's in one flat `subagents/` directory). Until it is
fixed, raising `watchdogMinutes` in `~/.zstack/projects/<slug>/config.json` is
the safe stopgap — it costs nothing but a longer wait before a genuinely dead
worker is noticed.

## A lane was parked Blocked for passing the 480-minute stage ceiling

The note reads "The `<stage>` stage has held this lane for N minutes, past the
480-minute per-stage ceiling". Nothing is proven broken — that park is a bound,
not a verdict.

Why it exists: an ALIVE probe refreshes the silence baseline with no memory of
the probes before it, so a worker that is wedged but still registered in the
harness task list answers alive, the baseline resets, and the lane is probed
again one budget later. Forever. Every other retry in the pack is outcome-driven
(QA bounces, reviewer bounces, quorum retries, commit retries, re-spawns);
elapsed time had none, so nothing ended that sequence but a human noticing a
ticket that had been "in progress" since yesterday. The ceiling is the only
thing in the loop that ends it.

480 minutes is 2x the longest stage that ever finished normally on this machine
(3.7 hours, measured over 939 stage agents), so a stage that was going to land is
not parked by it.

What to do: the branch and worktree are intact and any uncommitted work was
dumped to `~/.zstack/projects/<slug>/reports/uncommitted-<N>.patch`. Look at what
the agent actually did, then return the ticket to Ready. If it was a **merge**
stage, check `gh pr view` first — the PR may have landed before the agent wedged,
in which case the ticket is Done rather than Blocked, and the note says so.

If healthy stages on your project genuinely run this long, the fix is not raising
the ceiling: split the ticket. A stage that needs 8 hours has more in it than one
agent's context window can hold.

## `git worktree list` is full of leftover `review-*` worktrees

Those are the reviewer's throwaway checkouts. They hold no work — each is a
detached checkout of the head commit the reviewer and its skeptics read — so
removing them is always safe.

They pile up because in-run removal waits for the reviewer's whole spawn subtree
to finish (the skeptics execute inside the worktree and outlive their parent;
removing it under a live one is what #66 hit), and a skeptic that was still working
when the reviewer returned holds it back. The loop sweeps them with a command on
every exit path — batch cleanup on drain-complete, and Step 0 of the next run for
the exits that never reach it — but a pack older than that fix, or a directory the
loop no longer scans, can leave a backlog. Clear it by hand:

```bash
bun ~/.claude/skills/zstack/lib/reconcile.ts sweep-review
```

It removes `.worktrees/review-<N>` (and the `-lead`/`-base` variants) and nothing
else: no board read, no locks, no slug. Run it from the repo root — `--worktrees`
defaults to `<cwd>/.worktrees`, so from anywhere else it scans a directory that
does not exist and reports 0 without saying why. It is safe to run at any time: it
checks the same liveness evidence the in-run gate does and removes **nothing**
while any sub-agent of the current session is still unproven, printing who is live
instead.

If it reports `swept 0` for that reason, look at the ids it named. An agent that
returned normally does not hold the sweep back (its transcript ends on a
turn-ending stop reason, which reads finished at once); one that was **killed
mid-tool-call** never reports finished on shape at all, so it holds the sweep until
its transcript goes stale — 8 hours by default. When you know the session is dead,
say so:

```bash
bun ~/.claude/skills/zstack/lib/reconcile.ts sweep-review --stale-ms 1000
```

That treats any transcript untouched for a second as finished. Do not use it while
a review is genuinely running: it is the same removal, without the protection.

`--quiet-ms` is the other half of the same gate and carries the same warning. It
sets the settling window applied to an agent whose transcript already *looks*
finished (a final answer, no pending tool call) — 15 minutes by default, measured
rather than picked. `--quiet-ms 0` accepts any such agent immediately, which
collapses the gate for the population it protects: an agent that narrated and then
kept working reads as done, and the sweep removes the worktree it is still reading
from. Reach for `--stale-ms` when you know a session is dead; reach for
`--quiet-ms` only when you also know nothing is mid-turn.

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

## The board says Building for a ticket the loop is actually QA-ing or reviewing — and a resumed ticket rebuilt work that was already committed

Fixed in #205; if you are on an older pack, update (`/z-update`).

The two symptoms are one defect. `/z-loop`'s `advance N to S` row re-stamped the
lane lock and spawned the next stage but never moved the ticket, so from the
first transition onward the board sat a stage behind the lane for the rest of the
run: `/z-status` showed Building for a ticket in QA or Review, and the in-flight
write marker the loop stamps on each move (`lastWroteStatus`) never cleared,
because clearing it requires seeing the write land.

The expensive half is the second symptom. `state.json` is authoritative for a
lane the loop still holds, but a ticket sitting on the board with **no** lane
behind it is re-claimed at the stage its **board status** names
(`lib/lanes.ts` `claimStage`) — that is how a crashed or stopped run picks a
ticket back up at `qa`/`reviewer` instead of rebuilding it. With the board frozen
at Building, that re-claim spawns a *builder* into a ticket whose build already
finished, so it redoes work that is committed and pushed on the lane branch. It
is silent: nothing errors, you just pay for the stage twice (#164 burned $1.35
this way).

The advance row now issues `z-board move <N> <STATUS_FOR_STAGE[S]> --if-present`
as part of the transition, and `bun lib/loop.ts apply` prints the write each
action owes (`board write for #N = QA — …`) so a skipped move shows up in the
tick output instead of a stage later as a rebuild.

To repair a run that already drifted, move the ticket to the status its lane is
actually at — `bin/z-board move <N> QA --if-present --slug <slug>` — and the next
tick's ingest clears the marker. Nothing else needs undoing; the move is
idempotent, and running it when the board already agrees costs one no-op call.

Not this: a crashed run whose lane **lock** is still on disk does not take the
re-claim path at all. `/z-loop` refuses to start on orphans, and `--reconcile`
parks an in-flight ticket back to Ready by design (see
`--reconcile (crash recovery)` in the z-loop guide) — a full rebuild, and a
separate question from this one. A crashed lane whose ticket already reached a
terminal status is only pruned and unlocked; reconcile never reopens it.

## Done tickets are still open on the board

That is intended. The loop never calls `gh issue close`; it leaves Done tickets
OPEN with a completion note so a human validates the edges the note names, then
closes them. If you want them to auto-close, that fights the loop — leave the
"close issue on Done" workflow OFF (see `/z-setup` Step 4).

## "#N sits in board status …, which the loop does not drive; ignoring it"

You added a column to the board that is not one of the canonical nine, and a
ticket is sitting in it. The line is informational: the loop skips that ticket
for the whole run and touches nothing else. If the ticket was mid-flight when
you moved it, its lane stops too — that is the intended way to pull a ticket out
of a running batch by hand, and the run report will carry a `stop-lane` for it
naming the column you moved it to. Move it back to Ready to hand it to the loop.

If you did not expect the message, check the ticket's Status field for a typo or
a renamed column: the loop matches status names exactly.

## I moved a Building ticket to my own column and the loop finished without it, leaving a lock behind

Fixed in #273; if you are on an older pack, update (`/z-update`).

The symptom: you drag a mid-flight ticket into a column you added yourself. The
loop prints the "does not drive" line above, the run then reports drained and
runs its end-of-loop stage, and afterwards `~/.zstack/projects/<slug>/locks/`
still holds a `ticket-<N>.json`. The next `/z-loop` refuses to start with
"orphans present" and demands `--reconcile`, which then parks that ticket back to
Ready — undoing the move you made on purpose. Meanwhile the ticket's builder was
never stopped: it kept running and kept committing to `z/ticket-<N>-…`, a branch
the end-of-loop cleanup deletes.

The cause was that the loop removed such a lane by filtering it out of its own
state file instead of emitting an action. Nothing tore the agent down, nothing
removed the lock, and the drain — which measures "still running" by counting
lanes — went true the moment the lane vanished.

Now the loop keeps the lane, emits a `stop-lane` for it, and only removes it once
that action has killed the background agent and released the lock. The drain
cannot complete while one is outstanding.

To clean up after an affected run: delete the stale `ticket-<N>.json` in the
locks directory (or run `/z-loop --reconcile` and move the ticket back to your
column afterwards), and check `git worktree list` for a leftover
`.worktrees/ticket-<N>` — see "orphans present" above.

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
