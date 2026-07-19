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

```bash
/z-status
```

The skill assembles a snapshot from:
- `z-board list --status <Status>` for each of the nine statuses
- `locks/` directory (lane locks listing)
- `reports/loop-*.md` (newest report, if present)

Then renders the dashboard to stdout as markdown.

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
