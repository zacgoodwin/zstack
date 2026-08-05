# /z-loop

The drain-and-exit orchestrator. Runs a planning pass over Ready tickets,
leaves the workable ones in Ready and moves each to Building when its builder
lane claims it, then drives up to `maxLanes`
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
- **Planning-pass fold-in gate (PROCESS.md step 6).** Before a Ready ticket can
  reach Step 2's batch commit, the planning pass reads its comments and folds
  in the newest one from anyone other than the loop's own session login. If
  that comment raises a new question the plan doesn't already answer, the
  ticket never enters the batch: it's posted back as a `## Needs input —`
  comment and parked in Questions instead — the same don't-start mechanism
  as any other open question, never a silent guess into the plan.
- **Bounded orchestrator context.** The orchestrator holds no ticket context. Each
  stage's payload (body, diff) is assembled off-context into `input-<N>.json` and
  the printed prompt is a *pointer* to that file — small and payload-independent —
  so reading it to spawn the Agent stays cheap. And each drain iteration is a
  single `bin/z-loop-tick` call (snapshot → confirm → ingest → `next`) that prints
  only the one-line next Action, so the repeated bash never re-enters context. A
  long batch drains in one session without tripping auto-compaction.
- **The board re-read is positive evidence, never a census.** Every iteration
  re-reads the board so a human's mid-loop move is seen at the next boundary. But
  that read is *paginated*, so a ticket **missing** from it proves nothing — a
  short page and a genuinely removed ticket are identical at that boundary, and
  no "the read looks too small" heuristic can tell them apart (several were tried;
  each one either hung the drain on an honest read or believed a truncated one).
  So the rule is one line: **absence from a board read is never a signal.** A
  ticket the read did not show carries forward exactly as it was — status, flags,
  dependencies, its lane — which makes correctness independent of which read path
  ran and of how badly one read got truncated, up to and including a read that
  came back empty. `state.json` is authoritative for in-flight lanes; the board
  status is a write-through projection of it.
  Carry-forward alone is safe but not complete, so the tick adds a **targeted
  confirm**: for each lane or batch ticket the read missed (and only those), it
  spends one `z-board item <N>` — a lookup that resolves the issue straight to its
  project item with no pagination on the path, so it either returns the ticket or
  positively answers "not on this project". Found → that fresh observation is
  spliced into the read and wins over carry-forward; positively gone → the ticket
  leaves loop state, the only thing that ever removes one mid-run (and if it had
  a lane, that lane is stopped by an action — see below). A lookup that fails
  outright changes nothing (the ticket just carries forward), and each tick logs
  only what was proven: `read missed #N; single-ticket lookup confirms it is
  still on the board`, or `... confirms it is gone from the board
  (not-on-project)`.
  On the write side the same rule gets a backstop: every lane's board move runs
  as `z-board move <N> <S> --if-present`, which reports
  `{"moved":false,"reason":"not-on-project"}` (exit 0) instead of aborting the
  tick when a ticket was removed between two confirms. The lane is released
  instead of the drain wedging — including on the final move to Done, where the
  merge is still recorded even though the board can no longer show it, so a
  stacked child's PR retarget survives.
- **A board status the loop does not know is evidence, not an error.** The nine
  canonical statuses are the whole state machine, but the board is yours: add a
  staging queue or a triage column and the loop ignores any ticket sitting in
  one, logging `#N sits in board status "X", which the loop does not drive` per
  ignored ticket. That skip is a *removal*, not a pass — the ticket is dropped
  from loop state rather than carried forward, because the read positively
  observed where it sits, and carrying its last known status forward would leave
  the loop still seeing a Ready ticket a human deliberately moved out. Same rule
  as above, not an exception to it: a positive observation wins, an absence
  proves nothing. Moving a ticket into a column of your own therefore pulls it
  out of a running batch, lane and all.
- **An in-flight lane is stopped by an action, never by bookkeeping.** Both ways
  a ticket can leave the loop's reach mid-run — a confirmed removal from the
  board, or a move into a column the loop does not drive — take the same path
  when the ticket has a **lane**. The tick does not quietly forget the lane; it
  marks it and the next `next` returns a **`stop-lane`** naming the observed
  status or the removal proof, ahead of every other lane's work so the stray
  agent is torn down first. The orchestrator then does what only an action can
  do: kill that lane's background agent, remove its `locks/ticket-<N>.json`, and
  apply — which drops the lane and the ticket together (`"dropTicket": true` on
  the action; without it the ticket would linger at a workable status and the
  next tick would claim it, spawning a paid agent into a ticket the board does
  not have). The lane counts as *running* until then, so `drain-complete` cannot
  fire and the end-of-loop branch cleanup cannot delete a branch a live worker is
  still committing to. This is the one `stop-lane` that fires **mid-stage** rather
  than at a stage boundary, so it also carries `"salvage": true`: the worker may
  be halfway through writing files it never committed, and releasing the lane lock
  makes the worktree an orphan the next reconcile force-removes — the dump to
  `reports/uncommitted-<N>.patch` is what stands between your column drag and a
  builder's lost work. A ticket with **no** lane needs none of this: there is
  nothing to tear down, so it is simply removed with its one stderr note.
- **A `BUILT` that shipped nothing does not reach QA.** `BUILT` is a claim, and
  the loop verifies it against the lane worktree's own git facts before the lane
  advances: `git status --porcelain --branch` must report a clean tree, untracked
  files included — a new test file the builder never `git add`ed is exactly the
  work that would go missing — **and** `HEAD` must have moved off the base branch
  (at least one commit of its own). Both halves fail closed. The status payload is
  read `--branch`, so git's own `## <branch>` header is required and a `git status`
  that failed (an empty file) can never read as "clean"; the commit half compares
  `HEAD` against `git merge-base <base> HEAD`, not the base tip, so a leftover
  worktree re-claimed under a base branch that has since been pulled forward
  cannot read as having committed something it never did. Run 9 produced the
  failure this closes: a builder reported `BUILT` with everything still
  uncommitted, so QA reviewed the BASE tree and passed a diff that did not exist.
  On a failure the ticket does not advance to QA — nor to Review under `skip-qa`,
  which would hand the reviewer the same empty diff. The lane re-spawns its **own
  builder** once with an `uncommitted work` note naming what it left behind (dirty
  paths, a HEAD with no commit of its own) and telling it to commit what is already
  in the worktree rather than rebuild it. A second `BUILT` with nothing committed
  parks the ticket Blocked with that note, and because parking releases the lane
  lock — which makes the worktree an orphan the next run's reconcile scan
  force-removes — the park first dumps the worktree's uncommitted state to
  `~/.zstack/projects/<slug>/reports/uncommitted-<N>.patch`. Re-apply it with
  `git apply` in a fresh worktree, or commit/stash the worktree yourself **before**
  the next `/z-loop` run. That retry has its own budget — "you forgot to commit" is
  neither a QA bug nor a reviewer finding, so it never consumes a rebuild those
  caps are holding.
- **Adversarial review, when the card earns it.** When `adversarialMode` is
  active for a card, the Review stage runs a super-truth pass: it fans out
  independent skeptic sub-agents that each try to REFUTE the diff against the
  acceptance criteria, then reconciles them into an aggregated `confidence`
  (0–100). When inactive it is today's single pass. Activation is deterministic —
  a pure function of the diff's changed-line count, the issue's labels, and the
  `adversarialMode` knob (default `non-trivial`: a ≥ 10-line diff OR a
  `security`/`migration`/`payments`/`auth` label; `off` never, `always` every
  card). The confidence rides in the reviewer's exit marker.
- **A low-confidence approval does not merge.** The reviewer always reports a
  self-assessed (or, on a super-truth pass, skeptic-aggregated) `confidence`
  0–100 on its `REVIEW-APPROVE`. An approval below `minReviewerConfidence`
  (default 70) never reaches the merge gate: per `reviewerBelowThresholdAction`
  (default `block`) it parks the ticket Blocked with
  `truth-check failed (confidence X/100)`, bounces it back to the builder
  (`retry`), or is ignored entirely (`off`). A `REVIEW-APPROVE` with no
  parseable confidence is treated the same as a sub-floor score — fail-closed,
  never a silent merge — whenever the gate is on.
- **A confidence with nobody behind it does not merge either.** The aggregated
  confidence is computed over the skeptics that actually *reported*, so ONE
  skeptic answering "cannot refute" is `confidence=100` — which clears the
  default floor of 70 and merges as though three independent reviews agreed. Sub-
  agent delivery is best-effort (run 10 measured deliveries of 0 of 3), so the
  reviewer now reports the denominator too: `skeptics=<k>/3`. Below config
  `minSkepticQuorum` (default 2) the ticket does not merge; it re-spawns the
  **reviewer** once — a thin review is not a bad diff, and rebuilding something
  nobody faulted fixes nothing — and if the second reviewer also cannot reach
  quorum, parks Blocked naming the delivery failure and saying the diff itself was
  never faulted. That retry has its own budget, separate from `maxReviewBounces`,
  so a delivery race never consumes the rebuild a genuine finding needs. A
  single-pass review reports no `skeptics=` token and is untouched by this gate.
- **Reviewer->builder bounces are capped.** A `REVIEW-FINDINGS` and a
  `reviewerBelowThresholdAction: "retry"` both send the ticket back to the
  builder from Review, and both draw on the same per-lane budget: at config
  `maxReviewBounces` (default 2), the ticket parks Blocked with
  `review bounce cap reached (N/N)` instead of bouncing again — the same
  no-token-burn discipline as the QA-bounce cap below, closing the one retry
  path (issue #62) that could otherwise loop builder->QA->review forever on a
  ticket the reviewer never gets confident about (issue #76).
- **Dependency-ordered, capped concurrency.** A dependent is not claimable until
  its dependencies are Done; at most `maxLanes` (default 3) lanes run at once;
  merges happen one at a time in topological order (stacked chains retarget the
  base and delete branches only at batch end). A dependency cycle among
  review-approved lanes — a planning bug, since z-plan links deps both ways,
  but a bug can still produce one — can't be ordered at all: it parks the
  stuck tickets Blocked with a note naming the cycle instead of throwing and
  killing the whole drain; any other lane the cycle doesn't reach still merges
  normally in the same run.
- **Optional tick throttle.** `bin/z-loop-tick` sleeps out the remainder of
  the `tickThrottleSeconds` config knob (default `0`, off) before starting its
  next snapshot+ingest+`next` cycle, once the knob is set above its default.
- **No token burn.** Every ticket ends the run in Done, Questions, Blocked, or
  Skipped. QA bugs bounce to a fresh builder: from QA-bounce config
  `qaInvestigateAfter` (default 2) onward, the rebuild runs `/investigate`
  first; at config `maxQaPasses` (default 3), the ticket parks Blocked instead
  of bouncing again. A worker silent past the watchdog (default 15 min) is
  probed and then Skipped with a note. Exception: a dead merge lane is verified
  via PR state and ends Merged or Blocked, never Skipped.
- **Each stage gets its own budget, and no stage runs forever.** The shipped
  defaults are builder **25**, qa **15**, reviewer **40**, merge **15** minutes,
  each derived from that stage family's own measured worst silence over 1,143
  real stage subtrees and floored at the 15 minutes every agent needs: a
  reviewer blocked on three background skeptics legitimately goes 19 minutes
  without anyone in its subtree writing, while a merge stage that runs
  `gh pr merge` never goes 2. Set `watchdogMinutes` to a plain number to apply
  one budget to every stage (what every config written before this did), or to
  an object like `{"reviewer": 90}` to raise one stage and leave the rest on the
  pack's defaults. Separately, a lane whose current stage has held it for
  **480 minutes** parks Blocked whatever its worker says. That ceiling is what
  makes the watchdog's alive path terminate: an ALIVE probe refreshes the
  silence baseline with no memory of the probes before it, so a wedged-but-
  registered agent was otherwise probed alive every budget-period forever,
  holding its ticket, worktree, lock and one of the `maxLanes` slots. 480 is 2x
  the longest stage that ever finished normally on this machine (3.7 hours), and
  the park keeps the branch and worktree intact with a salvage patch — nothing
  is skipped, a human just decides.
- **The watchdog measures silence, not stage age.** `watchdogMinutes` counts
  minutes in which a lane's stage agent and every sub-agent it spawned appended
  NOTHING to their transcripts. Each tick reads that subtree and moves the lane's
  baseline forward, so a stage that works for an hour is never probed while a
  stage that goes quiet is. Until #256 nothing observed a worker at all: the
  baseline was stamped only when a stage STARTED, so the timer fired
  `watchdogMinutes` after a claim however hard the agent was working — and every
  QA stage crossed it while healthy, since its mandatory typecheck + full suite +
  build takes 121s idle and 234s under load on this repo before it reaches the
  first acceptance criterion. The default is derived, not chosen: the longest
  measured gap between a working agent's own transcript records is 423s (9,589
  mid-work samples over 1,388 sub-agent transcripts), and a silence budget must
  clear that ceiling by 2x, which is 15 minutes. If a lane's subtree cannot be
  resolved (no session transcript yet, a stage spawned without its tag), the tick
  says so on stderr and that lane falls back to the old stage-age behavior — the
  observation never parks a lane on its own absence.
- **A stage that died without ever reporting can still be recovered.** A stage
  agent's exit contract is parsed from its final message, so a worker that ends
  its turn with no marker reads as CONFUSED — and a CONFUSED skips the ticket.
  That is the right answer when the agent could not do the job and the wrong one
  when it simply never said it did: run 11's #170 builder addressed both reviewer
  findings, backgrounded its own `bun test`, and stopped to wait for a run nobody
  could report back to, with the finished diff sitting uncommitted in its
  worktree. So the dead-worker probe now collects that worktree's
  `git status --porcelain --branch` too, and a lane whose worker died holding
  **uncommitted changes** re-spawns that same stage ONCE (`respawn`) instead of
  being skipped — a fresh agent, never a resumed conversation, so nothing latent
  travels between stages. It is told plainly that the prior attempt's changes are
  uncommitted and UNVERIFIED and that keeping, fixing, or dropping them is its own
  call: carrying them forward as trusted would defeat the fresh-agent guarantee,
  and dropping them silently is the waste being fixed. The re-spawn has its own
  budget — **one per stage, per lane** — separate from the QA, reviewer, and commit
  caps, and the cap is what keeps this from becoming an unbounded retry. Per stage,
  not per lane: a builder that died silently says nothing about the QA agent that
  runs after it, so burning the builder's re-spawn still leaves QA's
  intact. After the stage's one re-spawn is spent the
  skip applies, and because skipping releases the lane lock — which makes the
  worktree an orphan the next run's reconcile scan force-removes — the skip first
  dumps the uncommitted state to
  `~/.zstack/projects/<slug>/reports/uncommitted-<N>.patch`, same salvage contract
  as the uncommitted-work park above. A worktree with nothing uncommitted in it is
  skipped exactly as before: there is nothing to recover, so no re-spawn is spent.
  So is one whose `git status` produced **no output at all** — that is what a
  missing or broken worktree yields (git always prints its `## <branch>` header
  when it runs), so there is provably nothing there and no fresh agent is briefed
  about changes that do not exist. The reviewer is excluded (it executes in a
  throwaway worktree, and its blinded
  four-key input has nowhere to put a briefing about a prior attempt), and a dead
  merge lane keeps its own PR-state resolution. A ticket a **human** moved to a
  stop status mid-run is never re-spawned either: that move is respected, so the
  lane stops cleanly at the dead worker, spends nothing, and leaves the human's
  own status alone — with the same patch dumped first if that lane's worktree held
  uncommitted work, since stopping the lane releases its lock and the worktree is
  no more durable there than after a skip.
  Every stage prompt that runs the gauntlet now also states the other half: run
  verification in the FOREGROUND, because ending a turn with a background job
  still pending is parsed as CONFUSED.
- **Actual per ticket.** After each stage the ticket's transcripts are priced with
  `bin/z-cost` (dedup by requestId) and written to the Actual field. A stage that
  died without reporting is priced too, at the moment it is found dead and before
  its replacement is spawned — that is the last instant its transcript can be
  located, since the spawn tag is keyed on the attempt number and the re-spawn
  moves that number on. So a ticket recovered by a re-spawn carries the cost of
  **both** spawns, not just the one that finished.
- **Per-stage transcript layout.** Each stage's copy lands at
  `~/.zstack/projects/<slug>/state/transcripts/ticket-<N>/<stage>-<attempt>.jsonl`
  — `<stage>` is `builder`/`qa`/`reviewer`/`merge`, `<attempt>` is that lane's
  1-based spawn count for the stage (a QA bounce, a reviewer bounce, an
  uncommitted-work re-spawn, and a dead-worker re-spawn each re-spawn builder —
  so `builder-3.jsonl` might follow two bounces of different kinds, not
  necessarily three QA passes; and a reviewer bounce sends the lane back through
  the builder and into QA a second time, so `qa-2.jsonl` need not mean a QA bug
  either). The count is computed by `lib/loop.ts attempt`,
  never by hand: two spawns of one stage that compute the same number mint the
  same spawn tag, which makes collection refuse and would overwrite the earlier
  transcript. This naming is what lets the end-of-loop report break spend down by
  stage instead of only by ticket.
- **Sub-agent transcripts count too.** A stage that spawns its own sub-agents —
  the adversarial reviewer's 3 skeptics are the case that matters — lands each
  one beside its parent as `<stage>-<attempt>-sub-<agentId>.jsonl`, and those
  tokens are that stage's spend. Collection is by **parentage**, not by
  timestamp: `lib/transcripts.ts` walks the harness's own `parentAgentId` links
  from the stage agent's transcript, found by an opaque spawn tag the prompt
  carries. Before this (#190), a prose step said "take the file for that spawn"
  and the skeptics were collected by nobody, so every adversarial review's
  Actual undercounted by the majority of what it spent. A modification-time
  sweep is not a substitute — three lanes drain concurrently, so sibling
  reviewers' skeptics interleave in one flat directory, and the sweep tried by
  hand during a real run gave a reviewer with 3 skeptics 8 transcripts.
- **The review worktree survives until the whole subtree does.** The reviewer's
  throwaway `.worktrees/review-<N>` used to be removed as soon as the reviewer
  returned — but the skeptics execute inside it and outlive their parent, and in
  #66's review that removal fired while two of the three were still running (one
  reported the worktree disappearing from `git worktree list` mid-review, which
  is indistinguishable from a skeptic that simply failed). Removal is now gated
  on the same parentage walk that collects the transcripts: a stage's worktree
  goes only once every descendant has been observed finishing.
  "Finishing" is read from each descendant's **own** transcript, three ways, in
  order of how strong the evidence is. A turn-ending stop reason on the last
  record is proof by itself and needs no wait — measured over all 1,546 sub-agent
  transcripts on this machine, 1,310 of the 1,532 finished ones end that way and
  none of the 10,517 mid-work records carry one. Failing that, a final-answer
  shape (text, no pending tool call) counts once nothing has been appended for 15
  minutes; that window is measured too, since an agent that narrated mid-work and
  kept going went quiet for as long as 423 seconds before its next record, so a
  shorter one declares a working skeptic finished. And whatever the shape, a
  transcript nobody has written to for 8 hours reads finished — without that
  ceiling an agent killed mid-tool-call could never satisfy the shape check at any
  age, and a single one of those (17 of 1,490 transcripts here) held the sweep
  open forever. `sweep-review --stale-ms` overrides that ceiling for a session you
  know is dead, and `sweep-review --quiet-ms` overrides the 15-minute settling
  window the same way; `--quiet-ms 0` collapses the gate entirely, so it is only
  safe when you know nothing is mid-turn. The parent's transcript
  cannot answer it either: the skeptics
  are background spawns, so the only record the reviewer ever gets for one is the
  "launched successfully" acknowledgement written the instant it starts, and
  reading that as a result would remove the worktree at the exact moment #66 did.
  Anything unproven — an unreadable or half-written transcript, one still parked
  on a tool call, or a sub-agent whose **metadata sidecar** could not be parsed
  (its parentage is unknown, so it may well be one of these skeptics, and a
  half-written sidecar is likeliest at spawn when the child is youngest) — counts
  as still running. That never stalls the drain: nothing
  waits on the flag, and a leftover directory is the cheap direction to be wrong
  in.
  Whatever the in-stage gate declines to remove is collected by a command
  (`bun lib/reconcile.ts sweep-review`, which touches `.worktrees/review-<N>` and
  nothing else). It carries the same guard rather than working around it: it
  removes nothing while **any** sub-agent of the session is still unproven, since
  a reviewer returning with skeptics still executing is the designed case, not an
  anomaly — the reviewer checks each skeptic at most once and stops waiting. It is
  called at batch cleanup when the drain completes, and at the start of the next
  run right after the loop lock is acquired, which covers the exits batch cleanup
  never reaches (a context-clear pause, a crash). Neither call assumes the session
  is quiet — both check and print what they found, because `/z-loop` can be invoked
  inside a session that already holds sub-agent transcripts. Those are the only
  two places the loop removes a review worktree by hand; a park, a skip, or a
  stop-lane never does, because the same live skeptic is at stake whichever action
  is being taken. `--reconcile` prunes them too, under the same hold. They never
  block startup: a scratch checkout nobody owns is litter, not a wedge, so it is
  swept rather than reported as an orphan.
- **Per-stage model routing.** The merge stage is mechanical (`gh pr create`, a
  conflict check, `gh pr merge`) and doesn't need the ticket's build-tier
  model; the `stageModels` config knob (default `{"merge": "haiku"}`)
  downshifts it for a direct cost cut. See below.

## Skip QA

Add the `skip-qa` label to a GitHub issue and a finished builder advances
straight to Review (Building → Review), skipping the QA stage entirely. Use it
when QA adds little over the reviewer's own correctness pass — an error fix,
answering a question, or resolving a blocker — where a human at triage has
already decided the change is low-risk. The label rides the board snapshot, so
the decision is a one-click human classification, not the builder's own call.

The reviewer still runs: `skip-qa` skips QA, never the last correctness gate.
Every ticket without the label runs the full builder → QA → reviewer → merge
pipeline, and the QA bounce/investigate machinery is unchanged.

## Ticket and context limits

Two knobs cap a single `/z-loop` run so a large Ready queue or a long drain
never runs away with itself. Both are hand-edited in
`~/.zstack/projects/<slug>/config.json` (see
[z-setup.md → Config knobs](z-setup.md#config-knobs-hand-edit-configjson-after-setup))
and both default to today's behavior.

### `ticketLimit` — a per-loop ticket cap

`ticketLimit` (default `0` = no cap) caps how many tickets one run works. At the
default, every gated Ready ticket is workable, exactly as before. Set it to `3`
and the run flags **the batch**: an allow-list of at most three tickets —
dependency-self-contained, with the one exception below — captured once at
Step 3's ingest and held on
`state.batchTickets`. The remaining Ready tickets stay Ready and are simply
picked up by a future run — they are never claimed, never counted against this
run's drain, and never mis-parked as blocked.

The batch is chosen by a Kahn walk in ascending issue number: a ticket is
flagged only when every dependency is already Done or already flagged, so a
flagged ticket never depends on an un-flagged one. **Whenever the walk flags at
least one ticket**, a dependent whose dependency doesn't fit under the cap just
waits — it stays Ready, outside the allow-list, and the loop's park steps only
ever consider in-batch tickets, so the dead-dependency park never touches it.
The allow-list persists verbatim across every re-ingest and across a context
clear, so the run always finishes the exact batch it started.

One case cannot be self-contained: when the walk can flag **nothing**, because
every workable ticket depends on a board ticket that is not Done. That covers
more than a cycle — the dependency can be one another live session is building,
or one no run can start at all, such as a ticket still sitting in Backlog. An
empty allow-list would read as "drained" and exit the run without ever surfacing
that, so the cap admits the stuck tickets instead: the lowest `ticketLimit`
workable ones, **closed over their workable dependencies**. That closure can
exceed the cap, and it has to. The drain loop's park-versus-wait decision reads
only the *direct* dependencies of what was admitted, so a bare cut at the cap
can amputate the very ticket holding the dependency that explains the block —
`#1 → #2 → #3`, with `#3` another session's in-flight work, admitted `#1` alone
under a cap of 1 and parked it Blocked as a dependency cycle that does not
exist. Closing over the dependencies makes every cap decide that shape the way
no cap decides it (verified at caps 1–4 and uncapped), and keeps it right after
the other session lands `#3`: `#2` is in the allow-list, so it becomes claimable
and the chain drains instead of parking. That is a fix for the false park, not a
general guarantee that a cap never changes the outcome — with two disjoint stuck
components, a capped run can still park a genuine cycle on a tick where an
uncapped run is still waiting on the unrelated component.

On the tick the fallback fires, over-admitting changes nothing: every ticket in
the admitted set is stuck by definition, so none of them is claimable. It is not
free across the run, though — the allow-list is captured once and persisted, so
whatever the closure admitted is what this run works. That is the first
consequence below.

What happens next is the ordinary drain loop, in this order: a dependency that
can never complete in the batch (one already parked Blocked or Skipped) parks
the dependent with a `Blocked by dependencies that cannot complete in this
batch` note; otherwise, if any admitted ticket waits on another session's
in-flight ticket, the whole set **waits**; otherwise the deadlock break parks
the lowest-numbered admitted ticket with a `Dependency deadlock … likely a
dependency cycle` note. Only that *first* park carries the deadlock note — once
one cycle member is Blocked, the rest fall to the dead-dependency park above and
carry its wording instead.

The fallback is blunt on purpose, and it has four consequences worth knowing
before you set a cap:

- **The cap can be exceeded by a lot.** The closure is persisted as the batch,
  so once the block clears the run works all of it — not `ticketLimit` of it. A
  50-long chain `#1 → … → #50` whose tail `#50` is another session's in-flight
  ticket admits 49 tickets under `ticketLimit: 1`, and drains all 49 once `#50`
  lands. That set is exactly what an uncapped run would work, which is the
  point, but a cap of 1 is not a promise of one ticket on this path.
- It parks tickets that a capped run used to leave alone. Before it existed, a
  cap over a stuck set produced an empty allow-list and the run exited clean with
  those tickets still Ready. Now a ticket whose only problem is a dependency
  still sitting in **Backlog** is parked Blocked and a human has to move it back.
  (An uncapped run has always parked that ticket — this makes the capped run
  agree with it.)
- It fires only when *nothing* is closable. A cap that still flags one closable
  ticket leaves the stuck set for a later run, so a Ready queue that keeps
  refilling can defer a cycle indefinitely.
- The wait wins over the deadlock break for the *whole* admitted set, not per
  ticket. If one admitted ticket waits on another session's in-flight work, a
  genuine cycle admitted alongside it waits too — every tick, for as long as
  that session holds its ticket — and is only parked once that ticket lands and
  the wait clears. An uncapped run behaves the same way; the capped shape used
  to exit clean instead.

### `contextTokenLimit` — a context ceiling with clear-and-resume

The orchestrator is one long-lived session that holds no ticket context by
design, but its own window still fills across a long drain (per-tick ticks,
stage final messages, completion notes). `contextTokenLimit` (default `550000`,
`0` disables) pauses the run before the harness auto-compacts.

Every tick, `bin/z-loop-tick` measures the orchestrator's **current** window
occupancy deterministically — the input side (input + cache-read +
cache-creation tokens) of its session transcript's most recent request, via
`lib/context-budget.ts`. This is *not* cumulative billed spend (that is
`z-cost`); it is how full the window is right now, the only thing a context
clear actually changes. The reading is **fail-open**: an unresolvable or
unreadable transcript reads `0`, so a measurement hiccup degrades to no gating
and never wedges a drain. A transcript caught mid-write (its last line
truncated) falls back to the last complete reading rather than failing — that
value is a real measurement of an earlier turn. So does a transcript whose last
entry is one of Claude Code's **synthetic** assistant records: it writes one
inline on a rate-limited, API-errored or interrupted turn, carrying model
`<synthetic>` and a usage object of four zeros. Those are skipped rather than
read as an empty window, because they appear exactly when the window is
fullest — 7 of the 1,185 transcripts on this machine read a silent `0` that way
before the skip, five of them hiding a real last reading, one at 393,005 tokens.

When *no* usable reading survives, the tick prints a line on stderr saying the
size is unknown: no transcript resolved, a transcript that can't be read, one
with no assistant usage line at all, one whose only lines were unparseable, and
one whose only usage lines were synthetic. A `0` from this measurement means
"could not measure", not "the window is small" — an empirical claim, not a
structural one: it holds because no real usage line sums its input, cache-read
and cache-creation tokens to zero (0 of 78,930 non-synthetic usage lines in this
machine's corpus; the smallest real reading is 14,239 tokens). Note that only
the operator gets that distinction — the ceiling gates on
the integer alone and treats an unknown `0` exactly like a genuine small
reading, which is what keeps the run draining. A renamed usage key still fails
loud, as before.

When the reading reaches the limit, the scheduler stops **claiming** new
tickets — no new ticket enters Building — while in-flight lanes keep draining
normally to their terminal state. Once every lane is idle with batch work still
remaining, `next` returns a `context-clear` action instead of waiting forever:
the loop releases its lock, keeps every worktree, branch, and the un-drained
`state.json`, and exits **without** running the end-of-loop stage (the batch
isn't done, so nothing deploys). The operator or harness then clears the
session's context and re-invokes `/z-loop`. The fresh orchestrator reads a small
context on its first tick, so claiming resumes immediately — on the *same*
batch, because the built tickets have left Ready and `batchTickets` persisted in
`state.json`. If the batch happens to finish exactly at the ceiling, normal
`drain-complete` wins; `context-clear` fires only when work genuinely remains.

The two knobs are independent: the ticket cap bounds *which* tickets a run
touches, the context ceiling bounds *when within* a run the orchestrator pauses
to clear.

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

### Reading the spend-by-stage table

The report's `## Spend by stage` section answers "which stage ate the money"
for the batch just drained, not just "how much did each ticket cost":

```text
## Spend by stage

| Stage | Spend |
|---|---|
| builder | $12.40 |
| qa | $3.10 |
| reviewer | $0.85 |
| merge | $0.20 |
| other | $0.00 |
```

It's built from `bin/z-cost --json --by-file` over every stage transcript in
the batch (`state/transcripts/*/*.jsonl`), folded per-stage by
`lib/endloop.ts`'s `sumByStage`. All five rows always render, `$0.00`
included — a run with no reviewer bounces still shows the full shape instead
of a table that grows and shrinks between loops. `other` catches any
transcript file whose name doesn't match `<stage>-<attempt>.jsonl` or
`<stage>-<attempt>-sub-<agentId>.jsonl` (e.g. a manually-dropped file); stage
attribution splits on the first `-`, so a sub-agent's spend lands in the row of
the stage that spawned it. A loop run's report predating this feature simply has
no `## Spend by stage` section at all — the field is optional and the rest of
the report is unaffected.

Every other cost-cutting change (stage model routing, trimming the Files
section, tighter diff hygiene) can point at this table before/after to prove
it actually moved the needle, instead of eyeballing the total.

## Per-stage model routing

Every stage spawn — builder, QA, reviewer, merge — normally runs at the
ticket's board **Model** field. The merge stage is mechanical (`gh pr create`,
a conflict check, `gh pr merge`) and never needs the builder's model tier; QA
on a small ticket often doesn't either. The `stageModels` config knob lets a
project override any stage's model, resolved once per spawn by
`bun lib/loop.ts stage-model <stage> <ticketModel> --slug <s>`
(`resolveStageModel` in `lib/loop.ts`) — never re-derived in prose.

**Absent vs `{}` — the two states mean opposite things:**

- **Key absent from `config.json` entirely** — the pack default applies:
  `{"merge": "haiku"}`. Every other stage still resolves to the ticket's Model
  field.
- **Key present, even as `{}`** — used exactly as written, no default layered
  on top. An empty object opts every stage back to the ticket's Model field.

```json
{ "stageModels": { "merge": "haiku" } }
```

Only `builder`, `qa`, `reviewer`, `merge` are valid keys. Each value must be a
model rate key defined in `references/rates.json` (the same lookup
`z-cost`/`z-estimate` use — `opus`, `sonnet`, `haiku`, `fable`, or a matching
family substring); an unknown value fails `validateConfig` loudly, naming
`stageModels.<stage>`, never silently at spawn time.

`/z-setup` writes `{"merge": "haiku"}` into every project's config, whether it
creates the project or adopts an existing one (issue #156) — hand-edit
`config.json` to change it (see
[z-setup.md → Config knobs](z-setup.md#config-knobs-hand-edit-configjson-after-setup)).

**It survives a later `z-setup` re-apply (issue #97).** Re-running `/z-setup`
against an already-set-up project can still genuinely rewrite `config.json`
(the board's shape drifted — a field was added, a status renamed). That
re-apply preserves whatever `stageModels` already sits in the file instead of
resetting it to the pack default or dropping it; the same holds for
`quota`/`notifications`/`adversarialMode`. Only a board that has never had a
config written for it (first-time setup) starts from the default above.

## Notifications

The loop can run for hours unattended. Point it at a Discord webhook and it posts
a message the moment something needs you or the batch finishes — no more watching
the terminal. Notifications are **off until configured**; an unconfigured project
is a silent no-op.

**1. Create a Discord webhook.** In Discord: **Server Settings → Integrations →
Webhooks → New Webhook**, pick the channel, then **Copy Webhook URL**. That URL is
a secret — anyone holding it can post to your channel.

**2. Give the URL to zstack**, either way:

- **Environment variable (recommended)** — keeps the secret out of every file:

  ```bash
  export ZSTACK_DISCORD_WEBHOOK="https://discord.com/api/webhooks/…"
  ```

  and turn notifications on in `~/.zstack/projects/<slug>/config.json`:

  ```json
  { "notifications": { "enabled": true } }
  ```

- **Config only** — put the URL directly in `config.json` (this file lives under
  `~/.zstack`, outside your repo, so it is never committed):

  ```json
  { "notifications": { "enabled": true, "discordWebhookUrl": "https://discord.com/api/webhooks/…" } }
  ```

  When both are set, `ZSTACK_DISCORD_WEBHOOK` wins. The URL must begin with
  `https://`; a pasted bare token is rejected by `loadConfig` (its error names the
  field only, never the value).

**3. The seven events**, each posted once at the moment the state machine
reaches it:

| Event | Fires when |
| --- | --- |
| `work-complete` | a `/z-loop` drain finishes — counts + spend + regression verdict |
| `plan-complete` | a `/z-plan` run finishes — tickets created/updated, no loop counts or spend |
| `human-pause` | a ticket parks to **Questions** waiting on your input |
| `ticket-parked` | a ticket is moved to **Blocked** or **Skipped** by the work |
| `safety-violation` | a safety control tripped (a wedged/dead worker; GraphQL quota exhausted) |
| `token-burn` | a spend/deadlock anomaly (no lane can make progress) |
| `human-needed` | a batch's parked tickets cross `humanNeededPercent` mid-run (once per batch — see below) |

Every event defaults **on**. Toggle any of them under `notifications.events`
(a missing key stays on):

```json
{ "notifications": { "enabled": true, "events": { "work-complete": false, "human-pause": true } } }
```

Set `"enabled": false` to mute everything without deleting the block.

**Security.** `config.json` sits under `~/.zstack`, outside the repo, so the URL
is never committed. zstack never writes the URL to a log line or into a message
body. Treat the webhook like a password: anyone with it can post to your channel.
To rotate or revoke, delete the webhook in Discord (Server Settings → Integrations
→ Webhooks) and create a new one. A failed post is logged (event + error, never
the URL) and dropped — a down webhook never stalls or crashes the loop.

## Human-needed safety control

`PROCESS.md`'s no-token-burn rule guarantees every ticket ends a batch in Done,
Questions, Blocked, or Skipped — but a batch can still be quietly going
sideways mid-run, e.g. 6 of 10 committed tickets piled up in
Blocked/Skipped/Questions while the loop happily keeps draining the rest. The
`humanNeededPercent` config knob (default 30, `0` disables) pages you the
moment that happens instead of leaving you to discover it only at the
drain-complete report.

**Threshold.** Every drain tick (`bin/z-loop-tick`, right after it re-ingests
the board), the loop recomputes:

```text
(Blocked + Skipped + Questions) / initialReadyCount * 100
```

`initialReadyCount` is the number of workable Ready tickets the batch committed
to work, held in Ready until each is claimed — the batch's size at
ingest-time-zero (Step 3's ingest, before Step 4 claims anything), captured once
from the Ready count and carried across every re-ingest for the rest of that
batch. The instant this percentage first exceeds `humanNeededPercent`, the
control trips.

**The numerator is this batch's own parks, never the board's.** Only tickets
this batch itself parked are counted: a ticket already sitting in
Blocked/Skipped/Questions before the batch started, and a `claimedByOther`
ticket parked by another session, are both excluded. That holds on a project's
**first** run too — with no prior `state.json`, the batch is exactly the
unclaimed Ready queue at ingest-time-zero, so a board carrying old parked work
starts the run at 0%, not tripped. (One deliberate consequence on that first run
only: a ticket the planning pass parks straight to Questions before the first
ingest is indistinguishable from an older park, so it is not counted either.
Every later run has a prior state and does count it.)

**Once per batch.** The first tick that trips the control fires exactly one
`human-needed` Discord notification — the exact parked counts and which
ticket numbers — through the same `lib/notify.ts` transport as the other
events above, then sets a fire-once flag so it never re-fires for the same
crossing. A fresh batch resets both the committed-size baseline and the
fire-once flag, so the control is live again from zero — but "fresh" is a
two-part test, not just "the prior batch fully drained": there must be no
prior state at all, OR the prior state was fully drained **and** the
incoming board snapshot shows new, **unclaimed** Ready tickets (the committed
queue now sits in Ready until each ticket is claimed, so any unclaimed Ready
ticket in a post-drain snapshot IS that new batch; a lingering `claimedByOther`
Ready ticket belongs to another session's batch and does not count). The prior
batch being drained is
necessary but not sufficient: a tick that merely re-confirms the SAME drained
batch (no new, unclaimed tickets committed — e.g. the very tick right after
that batch's own last ticket parks or completes, which is what first makes it
"drained") is not a new batch, so it keeps that batch's baseline and
fire-once flag rather than resetting them — otherwise the batch's
highest-value crossing, its last ticket tipping it over the threshold, would
reset to a zero baseline the instant it happens and never trip. It is **not**
re-evaluated again within the same tick after that tick's one scheduling
action applies — same once-per-iteration cadence as every other signal in the
drain loop.

**Depends on `notifications`.** Like the other six events, `human-needed` is
governed by the `notifications` block above: absent/disabled/unconfigured means
the send is a silent no-op, and because the fire-once flag is set only after a
send actually reports delivered, the control keeps trying every tick without
ever wedging — the moment `notifications` IS configured, the next tick's send
succeeds and the notification finally reaches you. It is independently
toggle-able via `notifications.events["human-needed"]` the same as any other
event; see
[z-setup.md → Config knobs](z-setup.md#config-knobs-hand-edit-configjson-after-setup)
for the `humanNeededPercent` knob itself.

## Context audit (where the orchestrator's tokens went)

`z-cost` answers what a drain cost in dollars. The context ceiling
(`contextTokenLimit`) answers how full the window is right now. Neither answers
the question that decides what to optimize: **of the tokens the orchestrator
paid for, which content was responsible.**

```bash
bin/z-context-audit audit                       # this session (resolved from cwd)
bin/z-context-audit audit path/to/*.jsonl       # specific transcripts
bin/z-context-audit audit --drain-only          # loop steady-state only
bin/z-context-audit audit --json                # machine-readable
```

The orchestrator is where the money is: **~83% of the loop's billed input
tokens**, against every lane subagent combined. It is one long session that
re-sends its whole window every turn, so a byte entering early is paid for again
on every later turn. The audit weights each block by the turns it rides in,
which is why its ranking differs sharply from a naive byte count.

Reproduce the ratio rather than trusting the figure. The corpus is a live
directory that grows every session, so absolutes move between runs; only the
ratio is stable:

```bash
# orchestrator side
bin/z-context-audit audit ~/.claude/projects/<mangled-cwd>/*.jsonl --json | jq .totalBilled
# lane-subagent side (z-cost, which has always deduped)
bin/z-cost '~/.zstack/projects/<slug>/loop/transcripts/*/*.jsonl' --json \
  | jq '[.by_model[].tokens | .fresh_input_tokens + .cached_input_tokens] | add'
```

On 2026-08-02 that returned 2.67B against 548M.

> Figures published before 2026-08-01 (the earlier "90%, 3.23B" reading) came
> from the pre-dedup tool, which summed a split response's usage snapshot once
> per content-block line and so over-reported orchestrator absolutes ~1.87x.
> Component ranking was unaffected. Absolutes from the two eras are not
> comparable; re-measure rather than mixing them.

A sweep (several paths, or any glob) skips a transcript carrying no assistant
usage line and names it in the report, and under `unauditable` in `--json`. A
single literal path is a question about that file, so the same empty transcript
is an error there instead. Every other failure, a renamed usage key included,
aborts the run in both modes.

### Drain vs dev

Output is split by phase and the two are never blended:

- **drain** — commands the loop itself issues (`z-loop-tick`, `bun lib/*.ts`,
  `z-board`/`z-cost`, Agent spawns and returns, `git`/`gh` scoped to a lane
  worktree).
- **dev** — everything else in the same session, i.e. an operator debugging the
  pack in the window that happened to run a drain.

Only the drain figure is a claim about `/z-loop`. This distinction is not
cosmetic: across the corpus, **all** `Read` cost and most `Bash` cost landed in
`dev`. Tool results looked like 22.7% of orchestrator spend blended, but the
loop's own share is **6.6%**. Optimizing the blended number would have been
optimizing someone's debugging session.

### How to read the numbers

`totalBilled`, the static floor, and total accretion are real tokenizer
readings from billed usage. The split *between* components is a `chars/4`
estimate normalized onto real accretion, so a single component's absolute
number carries whatever bias `chars/4` has for that content type. **Read the
ranking, not the absolute values.**

Every audit asserts `staticFloor + sum(components) == totalBilled`. That check
exists because the ad-hoc script this replaced reported tool results at 41% —
it had omitted tool-call parameters from its pool, which silently inflated every
other component by ~1.9x. A component set that fails to reconcile is a bug in
`lib/context-audit.ts`, never a finding about the loop, and it throws rather
than printing.

### The `--json` rollup

`--json` prints the rollup object in place of the table: `sessions`, `turns`,
`totalBilled`, `staticFloorCost`, and `components` (each `{component, phase,
cost, calls, rawTokens}`, sorted by cost). It is the unfiltered set — the table
drops rows under 0.02% and obeys `--drain-only`, the JSON does neither. Four
more fields exist so a caller can tell a complete run from a partial one:

- `drainedTickets` — the sorted **union** of ticket ids the drain touched. Two
  sessions that both worked #201 contribute one id, not two.
- `unauditable` — the paths a sweep skipped. Named, never merely counted: a
  dropped session is spend missing from the totals.
- `skippedLines` / `skippedBeyondFinalLine` — unparseable transcript lines, and
  how many of those sat somewhere other than end-of-file. All-at-EOF is a live
  transcript caught mid-write. Anything beyond it is corruption, those lines'
  spend is missing from the numbers, and the run says so on stderr too, since a
  `--json` caller never sees the report's warning.

```bash
bin/z-context-audit audit '<glob>' --json \
  | jq '{tickets: (.drainedTickets | length), skipped: .unauditable, corrupt: .skippedBeyondFinalLine}'
```

> **Contract change in 1.0.1.0.** `drainedTickets` used to be a count and is now
> an array of ids. `.drainedTickets | length` gives the old number back, but not
> the old value: the count summed per session and double-counted any ticket two
> sessions touched.

## --reconcile (crash recovery)

A crashed loop leaves lane locks, stray worktrees, or Building tickets with no
live lane, and its `loop.lock` goes stale. A normal `/z-loop` **refuses to start**
on any orphan (or names the live session if a loop is genuinely running).
`/z-loop --reconcile` releases claims, parks affected tickets back to Ready,
prunes worktrees, and clears the stale lock — then starts. It never deletes a
branch, never touches a ticket with a live lane. A running loop's lock is never
cleared: you cannot reconcile over a live loop.

Leftover throwaway review worktrees (`.worktrees/review-<N>` and its
`-lead`/`-base` variants) are pruned too, but they are never an orphan that
refuses startup — they hold no work and belong to no lane, and every run sweeps
them at Step 0 anyway.

Mid-run, dragging a Building/QA ticket to Blocked or Questions on the board is
respected: the loop stops that one lane cleanly at its next stage boundary and
keeps the others running.

## Done when

Every in-flight ticket is Done/Questions/Blocked/Skipped; Done tickets stay OPEN
with a completion note (acceptance criteria passed, to-check-X-do-Y-expect-Z
edges, filed Backlog tickets, Actual); the end-of-loop verdict ran; the report
exists; the counter was bumped; and every scheduling decision came from the CLI,
not prose.
