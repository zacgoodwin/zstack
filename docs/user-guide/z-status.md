# /z-status

A read-only, one-screen dashboard of the board between loop runs. Zero mutations —
it only observes the board, the locks directory, and prior reports.

Full skill contract: `z-status/SKILL.md`.

## When to run it

Any time you want to know where things stand — before starting a loop, or to see
what a finished loop left behind:

```bash
/z-status
```

## What it shows

- **Ticket counts** for all nine statuses (Backlog, Ready, Questions, Building,
  QA, Review, Blocked, Skipped, Done).
- **Waiting on human** — the Questions and Blocked tickets by number + title;
  exactly what needs a decision before the next loop can make progress.
- **In-flight lanes** — when a loop is live, each lane's ticket, current stage,
  and age since its last activity (from the lock timestamps). A lane older than the
  watchdog is about to be marked dead by the orchestrator. "None (board is idle)"
  when nothing is running.
- **Last loop** — the path to the newest `reports/loop-*.md` and its verdict line
  (GREEN = deployed, RED = regressions filed, no deploy).
- **Milestone Totals** — Estimate vs Actual, grouped by milestone (the epic
  style is one milestone per epic): one subtotal row per milestone, a
  `(no milestone)` row for unmilestoned tickets (always shown, even at $0.00),
  and a `Board total` row for the whole-board sum. Use `Board total` to
  calibrate your estimates (if Actual routinely exceeds Estimate, planning is
  undercharging); use the per-milestone rows to see which epic is driving it.

## Read-only guarantee

A grep gate test confirms no mutating `z-board` command (move / field-set /
create / comment / claim / release) appears anywhere in the status code path, so
running `/z-status` can never change the board.
