# /z-loop

The drain-and-exit orchestrator. Runs a planning pass over Ready tickets,
batch-commits the workable ones to Building, then drives up to `maxLanes`
concurrent worktree lanes through four fresh-agent stages (builder → QA →
adversarial reviewer → merge) until the batch is drained, runs the end-of-loop
stage on the merged base, writes a report, and exits. No daemon.

Full skill contract: `z-loop/SKILL.md`.

## When to run it

Fill Ready with planned tickets, then:

```bash
/z-loop              # drain the Ready queue once and exit
/z-loop --reconcile  # clear a crashed prior run's wedge, then start
```

## How it works

You are not in the loop; the deterministic core is. The orchestrator only ever
asks the state machine what to do next (`lib/loop.ts next`), performs that one
action's side effects (a `z-board` write, a git move, one fresh Agent spawn), and
records the result. It never re-derives a scheduling decision in prose.

- **One fresh agent per stage.** Every stage is a new harness Agent built from a
  pure prompt constructor (`lib/stage-prompts.ts`). Nothing latent travels between
  stages; the reviewer is blinded to exactly the ticket, its acceptance criteria,
  the diff, and a throwaway worktree.
- **Dependency-ordered, capped concurrency.** A dependent is not claimable until
  its dependencies are Done; at most `maxLanes` (default 3) lanes run at once;
  merges happen one at a time in topological order (stacked chains retarget the
  base and delete branches only at batch end).
- **No token burn.** Every ticket ends the run in Done, Questions, Blocked, or
  Skipped. QA bugs bounce to a fresh builder: from QA-bounce config
  `qaInvestigateAfter` (default 2) onward, the rebuild runs `/investigate`
  first; at config `maxQaPasses` (default 3), the ticket parks Blocked instead
  of bouncing again. A worker silent past the watchdog (default 10 min) is
  probed and then Skipped with a note.
- **Actual per ticket.** After each stage the ticket's transcripts are priced with
  `bin/z-cost` (dedup by requestId) and written to the Actual field.

## End of loop

After the batch drains, the end-of-loop stage runs a regression on merged main
(typecheck / test / build detected from `package.json`, plus gstack `/qa-only`):

- **Red** → every finding is filed as a Backlog bug with repro + first-suspect
  file, and **no deploy skill runs**.
- **Green** → `/land-and-deploy` → `/canary` → `/document-release`, in that order,
  each logged as it returns.
- **Every Nth loop** (the persisted loop counter, red or green) → `/cso` +
  `/health`, findings filed to Backlog. `N` is the config knob
  `auditEveryNLoops` (default 5) in `~/.zstack/projects/<slug>/config.json` —
  set it lower (e.g. 3) for a high-churn repo, higher (e.g. 10) for a
  docs-only one. Must be a positive integer; invalid values fail `loadConfig`
  loudly rather than silently falling back.

It writes `reports/loop-<ts>.md` and bumps `~/.zstack/projects/<slug>/loop-counter`.

## --reconcile (crash recovery)

A crashed loop leaves lane locks, stray worktrees, or Building tickets with no
live lane, and its `loop.lock` goes stale. A normal `/z-loop` **refuses to start**
on any orphan (or names the live session if a loop is genuinely running).
`/z-loop --reconcile` releases claims, parks affected tickets back to Ready,
prunes worktrees, and clears the stale lock — then starts. It never deletes a
branch, never touches a ticket with a live lane. A running loop's lock is never
cleared: you cannot reconcile over a live loop.

Mid-run, dragging a Building/QA ticket to Blocked or Questions on the board is
respected: the loop stops that one lane cleanly at its next stage boundary and
keeps the others running.

## Done when

Every in-flight ticket is Done/Questions/Blocked/Skipped; Done tickets stay OPEN
with a completion note (acceptance criteria passed, to-check-X-do-Y-expect-Z
edges, filed Backlog tickets, Actual); the end-of-loop verdict ran; the report
exists; the counter was bumped; and every scheduling decision came from the CLI,
not prose.
