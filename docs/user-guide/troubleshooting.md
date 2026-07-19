# Troubleshooting

The failure modes zstack surfaces on purpose, and what to do about each. All of
these are deliberate stops — the loop refuses to guess or to burn tokens while
wedged.

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
- It crashed and the lock is stale (dead pid, or older than
  `lockStalenessMinutes`) → the message says so; start with `/z-loop --reconcile`.

A **live** lock never clears via reconcile — you cannot reconcile over a running
loop, by design.

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
