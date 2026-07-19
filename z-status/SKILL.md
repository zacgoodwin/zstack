---
name: z-status
description: |
  Read-only board dashboard showing the current state between loop runs.
  Renders ticket counts per status, questions/blocked tickets waiting on
  humans, in-flight lane activity with age, last loop result, and milestone
  cost totals (Estimate vs Actual). No mutations; pure render of the board state.
---

# /z-status — Read-only Board Dashboard

One-screen view of the board at any moment between loop runs. Shows:

- **Ticket counts** per all nine statuses (Backlog, Ready, Questions, Building,
  QA, Review, Blocked, Skipped, Done).
- **Questions and Blocked tickets** (the two statuses waiting on the human) listed
  by number and title — exactly what needs a decision before the next loop can
  proceed.
- **In-flight lanes** from the locks directory when the loop is live (ticket number,
  current stage, time elapsed since last activity).
- **Last loop summary** (path to the report file + its verdict line) so you know
  what the prior run decided.
- **Milestone totals** (Estimate vs Actual spend) for cost calibration.

**Read-only.** Zero mutations: the dashboard observes the board, locks dir, and
prior reports. The /z-loop skill mutation gates ensure nothing in this code path
can touch a ticket.

## How to run

Invoked as `/z-status`. Run the pipeline below and present its stdout as the
dashboard, verbatim. Every number on the dashboard — counts, sums, ages — is
computed by `lib/status-report.ts`, never in prose: do not count tickets, add
dollars, or re-derive any figure yourself. Your only latent work is optional
commentary AFTER the rendered report (e.g. flagging a long-running lane).

```bash
PACK="$HOME/.claude/skills/zstack"
[ -d "$PACK" ] || PACK="$(cd "$(dirname "${BASH_SOURCE:-$0}")/.." && pwd -P)"
Z_BOARD="$PACK/bin/z-board"
SLUG=$(gh repo view --json name -q .name)
export ZSTACK_SLUG="$SLUG"
DIR="$HOME/.zstack/projects/$SLUG"
TMP=$(mktemp -d)

# Snapshot: all nine statuses -> one BoardItem[] file (same shape z-loop ingests)
for S in Backlog Ready Questions Building QA Review Blocked Skipped Done; do
  "$Z_BOARD" list --status "$S" --json --slug "$SLUG" > "$TMP/items-$S.json"
done
jq -s 'add' "$TMP"/items-*.json > "$TMP/items.json"

# Newest loop report, if any prior loop has run
LAST=$(ls -t "$DIR/reports"/loop-*.md 2>/dev/null | head -1)

# Render: the ONLY place counts/sums/ages are computed (tests/status-report.test.ts
# gates both the numbers and this pipeline reference)
bun "$PACK/lib/status-report.ts" report --board-items "$TMP/items.json" \
  --locks-dir "$DIR/locks" ${LAST:+--last-report "$LAST"}
```

## Understanding the output

### Ticket Counts

All nine statuses with their counts. Sums to the total tickets across the board
(excluding archived/closed issues).

### Waiting on Human

Two subsections:

- **Questions**: tickets where an agent hit an ambiguous decision point and parked
  the ticket for a human to clarify (PROCESS.md: the loop never auto-resolves
  Questions).
- **Blocked**: tickets waiting for an external blocker to clear (a dependency,
  waiting for a human's decision, or a resource constraint).

Each lists the ticket number and title so you know what decision or action to take.

### In-Flight Lanes

Shows active work. Each line is one lane running one ticket through one stage
(builder → qa → reviewer → merge). Age is time elapsed since the lane last
reported progress (the lock's `claimedAt` timestamp). If a lane runs for more
than the configured watchdog timeout (default 10 minutes), the /z-loop
orchestrator marks it dead and parks the ticket so the next loop can try again.

"None (board is idle)" means no lanes are running — the loop is waiting for
human input or has completed a batch.

### Last Loop

Path to the newest `reports/loop-*.md` file (if one exists) plus its verdict
line. Shows whether the most recent loop was GREEN (deployed successfully) or
RED (regressions found, no deploy).

"(no prior loops)" when the board has no history yet.

### Milestone Totals

Sum of the **Estimate** and **Actual** fields across all tickets on the board.
- **Estimate**: original cost estimate (set at planning time).
- **Actual**: real cost observed (set by the loop, usually via `/z-cost` gate
  tests or manually).

Use this to calibrate your estimates: if Actual routinely exceeds Estimate,
your planning is undercharging (see references/ESTIMATION.md).

## Done criteria

The dashboard is live when:

- It renders the board's current state (all nine statuses, counts accurate).
- It lists Questions and Blocked tickets by number + title.
- It shows in-flight lanes with age (from lock timestamps).
- It displays the last loop's verdict line (if a prior loop exists).
- It sums Estimate and Actual totals correctly.
- Zero mutations: the grep gate test confirms no z-board mutating commands
  (move/field-set/create/comment/claim/release) appear in the code.
