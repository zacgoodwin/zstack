// The /z-loop state machine (C6): ticket states, legal transitions, and
// nextAction() -- the ONE pure function that decides what the orchestrating
// session does next (claim / advance a lane / park / skip / drain-complete).
// Everything here is deterministic space (PRINCIPLES.md): the skill shells in
// through the CLI at the bottom, feeds stage results through recordOutcome, and
// applies the returned Action with applyAction -- it never re-derives a
// scheduling or transition decision in prose. No Date.now() outside the CLI
// edge; every pure function takes nowMs.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, handleCliError, parseFlags, readJson, str } from "./cli.ts";
import {
  BOARD_STATUSES,
  DEFAULT_CONTEXT_TOKEN_LIMIT,
  DEFAULT_HUMAN_NEEDED_PERCENT,
  DEFAULT_MAX_LANES,
  DEFAULT_MAX_QA_PASSES,
  DEFAULT_MAX_REVIEW_BOUNCES,
  DEFAULT_MIN_SKEPTIC_QUORUM,
  DEFAULT_MIN_REVIEWER_CONFIDENCE,
  DEFAULT_QA_INVESTIGATE_AFTER,
  DEFAULT_REVIEWER_BELOW_THRESHOLD_ACTION,
  DEFAULT_TICKET_LIMIT,
  DEFAULT_WATCHDOG_MINUTES,
  DEFAULT_STAGE_WATCHDOG_MINUTES,
  loadConfig,
  resolveWatchdogMinutes,
  ZError,
  type BoardStatus,
  type StageWatchdogMinutes,
} from "./config.ts";
import {
  claimStage,
  claimableTickets,
  deadDeps,
  isWorkableStatus,
  mergeOrderProbe,
  parseDependsOn,
  selectBatch,
  watchdogExpired,
} from "./lanes.ts";
import { reconcileBoardMoves } from "./reconcile.ts";
// #256: the CLI's --watchdog-minutes takes the same two shapes config.json does,
// so it validates through the same function rather than a looser second parser.
// No cycle: config-schema.ts reaches only config.ts / estimate.ts / notify.ts.
import { validateWatchdogMinutes } from "./config-schema.ts";
// #256: the watchdog's silence baseline is read off the harness's own sub-agent
// transcripts. Runtime-safe in this direction -- transcripts.ts reaches back into
// this file only through stage-prompts.ts's `import type { Stage }`, which is
// erased, so there is no import cycle at run time.
import { readAgentMetas, subagentsDirFor, subtreeActivityMs, spawnTag, type AgentMeta } from "./transcripts.ts";

// -- ticket states ------------------------------------------------------------

// The canonical nine statuses and the terminal-for-this-batch subset live in
// lib/config.ts (single source, issue #14 item 21); re-exported here so every
// existing importer of the state machine keeps its import path.
export { BOARD_STATUSES, TERMINAL_STATUSES } from "./config.ts";
export type { BoardStatus } from "./config.ts";

// The GitHub issue label a human sets at triage (#130) to route a finished
// builder straight to Review, skipping the QA stage. Rides the board snapshot
// onto TicketSnapshot.skipQa (see ingestBoardItems); the label is the whole
// mechanism -- no board field, no per-project knob.
const SKIP_QA_LABEL = "skip-qa";

// Legal status transitions (PROCESS.md). Questions/Blocked/Skipped/Done exits
// are the human's moves (bounce back to Ready, or return a parked ticket to its
// stage) -- the loop itself only ever walks the workable path plus the parks.
// Building -> Review is the #130 skip-QA walk: a label-gated advance past QA,
// deliberately legal (Building -> Done stays absent -- never skip Review too).
const LEGAL_TRANSITIONS: Record<BoardStatus, BoardStatus[]> = {
  Backlog: ["Ready"],
  Ready: ["Building", "Questions", "Blocked", "Skipped"],
  Building: ["QA", "Review", "Questions", "Blocked", "Skipped"],
  QA: ["Building", "Review", "Questions", "Blocked", "Skipped"],
  Review: ["Building", "Done", "Questions", "Blocked", "Skipped"],
  Questions: ["Ready", "Building", "QA", "Review"],
  Blocked: ["Ready"],
  Skipped: ["Ready"],
  Done: ["Ready"],
};

export function canTransition(from: BoardStatus, to: BoardStatus): boolean {
  return from === to || (LEGAL_TRANSITIONS[from] ?? []).includes(to);
}

// -- lane model ---------------------------------------------------------------

export type Stage = "builder" | "qa" | "reviewer" | "merge";

// The board status a ticket shows while a lane runs a given stage. merge runs
// under Review (PROCESS.md: Done only after the PR lands).
export const STATUS_FOR_STAGE: Record<Stage, BoardStatus> = {
  builder: "Building",
  qa: "QA",
  reviewer: "Review",
  merge: "Review",
};

// The board status one hop EARLIER in the fixed pipeline (builder -> qa ->
// reviewer -> merge) than a stage's own STATUS_FOR_STAGE (issue #116, the
// nextAction desync guard below). Only the two FORWARD advances live in this
// single-status map: each has ONE preceding status that is always present
// (every qa lane came from Building, every reviewer lane from QA). builder is
// deliberately absent here -- not because it is unreachable by an advance (the
// #116 claim, wrong: reviewerBounceAction and the qa-bugs case both advance TO
// builder), but because it is reached by a BOUNCE-back whose lagged status is
// NOT unique: a qa-bugs bounce lags at QA, a review-findings bounce lags at
// Review (issue #124). isOneHopLag handles builder directly, gating each source
// on the matching bounce counter. merge is omitted too: its own status is ALSO
// "Review" (same as reviewer's), so a merge lane can never be one hop behind
// its own expected status -- the guard's mismatch check already excludes it.
const PRECEDING_BOARD_STATUS: Partial<Record<Stage, BoardStatus>> = {
  qa: "Building",
  reviewer: "QA",
};

// True when a lane's lagging board status is exactly one advance-write behind
// its own stage -- the loop's own not-yet-landed write, safe to resync (#116),
// versus a genuine human move that must stop-lane. Forward advances (qa,
// reviewer) have a single preceding status in PRECEDING_BOARD_STATUS. builder
// is reached only by a bounce-back (#124): a qa-bugs bounce lags at QA, a
// review-findings bounce lags at Review -- each a legal one-hop lag, but only
// when that bounce actually happened (its counter > 0), so a human drag onto a
// never-bounced builder lane (counters at 0, or a status that is neither) still
// stop-lanes.
function isOneHopLag(lane: LaneState, boardStatus: BoardStatus): boolean {
  if (lane.stage === "builder") {
    return (boardStatus === "QA" && lane.qaBounces > 0) || (boardStatus === "Review" && lane.reviewBounces > 0);
  }
  return boardStatus === PRECEDING_BOARD_STATUS[lane.stage];
}

// Per-stage model routing (issue #82). The merge stage is mechanical (`gh pr
// create`, a conflict check, `gh pr merge`) and never needs the ticket's
// build-tier model -- Loop run 2 billed every merge spawn at the ticket's full
// tier for $73/10 tickets. This is the pack default applied ONLY when a
// project's config omits `stageModels` entirely; a project that sets it
// explicitly (including `{}`) opts out of the default completely -- see
// resolveStageModel below for why "absent" and "present-as-{}" must stay
// distinguishable this far from the JSON on disk.
export const DEFAULT_STAGE_MODELS: Partial<Record<Stage, string>> = { merge: "haiku" };

// Pure: the ticket's board Model field is the fallback for every stage;
// `stageModels[stage]`, when set, overrides it. `stageModels === undefined`
// (the config key is absent) is the ONE case that falls back to
// DEFAULT_STAGE_MODELS -- an explicit `{}` is used as-written (no default
// merged in), so a project can opt every stage back to the ticket's Model
// with an empty object. Values are already validated against rates.json by
// config-schema.ts's validateConfig at config-write/load time, so this never
// re-validates -- an unknown key here can only mean a hand-edited config that
// bypassed loadConfig.
export function resolveStageModel(
  stage: Stage,
  ticketModel: string,
  stageModels: Partial<Record<Stage, string>> | undefined
): string {
  const effective = stageModels === undefined ? DEFAULT_STAGE_MODELS : stageModels;
  return effective[stage] ?? ticketModel;
}

export interface TicketSnapshot {
  number: number;
  title: string;
  status: BoardStatus;
  dependsOn: number[];
  model?: string; // board Model field; the harness Agent spawn's model param
  modelEffort?: string; // board Model Effort field
  claimedByOther?: boolean; // z-board claim lost to another session
  skipQa?: boolean; // #130: carries the `skip-qa` issue label -> builder advances straight to reviewer
}

// One concurrent lane. DELIBERATELY carries no conversation/session/context id:
// every stage is a FRESH harness agent spawn, and the only things that travel
// between stages are these fields (a gate test pins the exact key set so a
// conversation id can never sneak in).
export interface LaneState {
  ticket: number;
  stage: Stage;
  // The watchdog baseline: the newest transcript append observed anywhere in this
  // lane's stage-spawn subtree (#256, recordActivity below), floored at the
  // moment the stage started. Before #256 nothing observed a worker at all: every
  // writer was a stage EVENT -- the claim, an advance, a #209 re-spawn, a
  // recorded outcome, an ALIVE probe -- so `watchdogExpired` was a stage-age
  // timer that fired watchdogMinutes after the stage began however hard the agent
  // was working.
  // The floor is deliberate and one-directional: a heartbeat only ever moves this
  // FORWARD (never backwards, see recordActivity), so an unobservable subtree
  // degrades to exactly that stage-age behavior and the watchdog can only be
  // made more patient by an observation, never less.
  lastActivityMs: number;
  // #256: when the CURRENT stage spawn began -- set by the three actions that
  // place an agent on this lane (claim, advance, respawn) and by nothing else.
  //
  // Deliberately NOT the same field as lastActivityMs, which the heartbeat moves
  // forward: this one must stay still, because it is the only thing that can
  // bound a lane whose worker answers ALIVE to every probe. Each ALIVE resets the
  // silence baseline with no cumulative limit (recordProbe), so before this a
  // wedged-but-registered agent was probed alive every budget-period forever.
  // STAGE_CEILING_MINUTES reads it; see stageCeilingAction.
  //
  // Optional so state files written before #256 load unchanged. Absent means the
  // ceiling cannot be evaluated for that lane, which reads as "no ceiling" -- the
  // pre-#256 behavior, and the fail-open direction: a lane the loop cannot age
  // must never be parked on a number it does not have.
  stageStartedMs?: number;
  qaBounces: number; // completed QA passes that found bugs
  reviewBounces: number; // completed reviewer->builder bounces (issue #76)
  // #191: reviewer->REVIEWER re-spawns this lane has spent on a short skeptic
  // quorum, capped by MAX_QUORUM_RETRIES. Optional so state files written before
  // #191 load unchanged (absent reads as 0). Deliberately NOT folded into
  // reviewBounces -- see quorumAction for why one budget cannot serve both.
  quorumRetries?: number;
  // #177: builder->BUILDER re-spawns this lane has spent on a BUILT that shipped
  // nothing (dirty tree / HEAD still at base), capped by MAX_COMMIT_RETRIES.
  // Optional so pre-#177 state files load unchanged (absent reads as 0), and its
  // own budget for the same reason quorumRetries is: "you forgot to commit" is
  // not a QA bug or a reviewer finding, so it must not consume a rebuild those
  // caps are holding, nor park the ticket under their notes.
  commitRetries?: number;
  // #209: SAME-stage re-spawns this lane has spent on a worker that died without
  // ever emitting an exit marker while its worktree still held uncommitted work,
  // capped by MAX_DEAD_RESPAWNS. Optional so pre-#209 state files load unchanged
  // (absent reads as 0), and its own budget for the same reason quorumRetries and
  // commitRetries have theirs: "the agent forgot to say it was done" is not a QA
  // bug, not a reviewer finding, and not a builder that skipped committing, so it
  // must not consume a rebuild those caps are holding nor park under their notes.
  //
  // Keyed BY STAGE, not a single lane-wide number: the budget is one re-spawn per
  // stage per lane. A builder that died silently says nothing about the QA agent
  // that runs after it, so spending the builder's re-spawn must not leave a later
  // QA death with no recovery -- that is one lane-wide retry wearing the name of a
  // per-stage one. It also keeps stageAttempt honest: a builder re-spawn is not a
  // qa spawn, so it must not shift qa's attempt numbering (see stageAttempt).
  respawns?: Partial<Record<Stage, number>>;
  workerDead?: boolean; // set by the orchestrator after an aliveness probe
  // #209: did the lane worktree still hold uncommitted changes when the DEAD
  // probe was recorded? Set by recordProbe from the worktree's own
  // `git status --porcelain --branch` payload, never by a judgment call. Absent
  // means the orchestrator supplied no worktree facts, which reads as "nothing to
  // recover" and skips exactly as it did before this ticket.
  worktreeDirty?: boolean;
  outcome?: StageOutcome; // set when the stage agent's final message is parsed
  // #125: the board status the loop itself last wrote for this lane (set by
  // applyAction's claim/advance). It is the ORIGIN marker the one-hop desync
  // guard needs: while set, the loop's own write is still in flight and has NOT
  // been observed to land; ingestBoardItems clears it the moment the board
  // shows that status. A one-hop-behind read only resyncs when this still
  // points at the lane's own stage status (a genuine human move-back, which the
  // loop never wrote, leaves it cleared -> safe stop-lane). See the guard below.
  lastWroteStatus?: BoardStatus;
  // #273: this lane's ticket left the loop's reach while the lane was still
  // running -- either it landed in a board status the loop does not drive (a
  // column a human added; partitionKnownStatus) or a confirm-pass lookup PROVED
  // it off the board (confirmedGone). Set by ingestBoardItems, which now KEEPS
  // such a lane instead of filtering it away, because removing a lane is an
  // ACTION the orchestrator executes -- the stop-lane row tears down the
  // background agent and removes the ticket-<N>.json lane lock -- and never
  // something a reducer may do behind its back. A silent filter left an
  // unsupervised worker still committing to the lane branch, an orphan lock that
  // wedged the next run's Step 0, and a drain free to declare itself finished
  // and delete that worker's branch out from under it.
  //
  // Lifetime: normally ONE tick -- the ingest that sets it, the `next` that
  // returns its stop (step 1a, its own pass ahead of every other per-lane
  // transition, so no neighbouring lane can defer it), the apply that drops lane
  // and tombstone together. It survives longer only when a run dies between that
  // ingest and that apply, which is why ingestBoardItems also CLEARS it on
  // positive proof the ticket is back in a driven status (see the revival clause
  // there); an absence never clears it.
  goneReason?: { kind: "unsupported-status"; status: string } | { kind: "confirmed-gone" };
  // #178: the loop-owned merge gate's verdict for this lane, stamped by
  // `loop merge-gate --state <state.json> --ticket <N>`. nextAction will not
  // emit an advance to the merge stage until this reads green, so a merge agent
  // is never spawned on a suite nobody mechanically verified -- the enforcement
  // is here, in the reducer, not in the orchestrator's compliance with prose.
  // Cleared by any advance OFF the merge path (a lane bounced back to the
  // builder must re-gate the code it comes back with).
  mergeGate?: MergeGateVerdict;
  // Gate attempts STARTED (stamped before the gauntlet runs, so a run killed
  // mid-gauntlet -- a command timeout shorter than the suite -- still leaves a
  // trace). Bounds the retry so a gate that never returns parks the lane
  // instead of spinning the drain forever (PROCESS.md: park, never stall).
  // Counts CONSECUTIVE SILENT attempts: any verdict, green or red, clears it.
  mergeGateRuns?: number;
  // #178: the merge base `mergeGate` was taken against -- the sorted list of
  // tickets already merged in this run at stamping time. A verdict vouches for
  // one branch on top of one base, and every merge moves that base under every
  // other lane, so a stamp taken before a parent landed is not permission to
  // merge after it landed (reproduced: two review-approved lanes, #8 depending
  // on #7, both stamped green at t0; after #7 merged, #8's advance still
  // carried the t0 verdict and `stackedOn:[7]`). A mismatch here re-gates.
  mergeGateBase?: string;
}

export interface LoopState {
  tickets: TicketSnapshot[];
  lanes: LaneState[];
  maxLanes: number;
  // #256: a scalar (one budget for every stage, every pre-#256 state file) or the
  // per-stage object. Never read directly -- resolveWatchdogMinutes(state, stage)
  // is the only reader, so both shapes reach the decision as one number.
  watchdogMinutes: number | StageWatchdogMinutes;
  // QA bounce knobs (issue #41). Optional on the type so hand-built fixtures
  // that predate this ticket keep compiling; ingestBoardItems always fills a
  // concrete value (cfg -> preserved-from-prev -> DEFAULT_*, same fallback
  // chain as maxLanes/watchdogMinutes) so a real ingested state always carries
  // both.
  maxQaPasses?: number;
  qaInvestigateAfter?: number;
  // Reviewer-confidence safety gate (issue #62), same optional-with-fallback
  // treatment as the QA knobs above: ingestBoardItems always fills a concrete
  // value (cfg -> preserved-from-prev -> DEFAULT_*).
  minReviewerConfidence?: number;
  reviewerBelowThresholdAction?: "block" | "retry" | "off";
  // Reviewer->builder bounce cap (issue #76), same optional-with-fallback
  // treatment as the gate knobs above (cfg -> preserved-from-prev ->
  // DEFAULT_MAX_REVIEW_BOUNCES).
  maxReviewBounces?: number;
  // Skeptic quorum floor (issue #191), same optional-with-fallback treatment: the
  // number of skeptic verdicts an ADVERSARIAL review must actually have received
  // for its aggregated confidence to be allowed to merge. 0 disables the gate.
  minSkepticQuorum?: number;
  // Tickets whose PRs landed during THIS run. Their branches still exist
  // (stacked-chain rule: branches are deleted only after the whole batch), so a
  // dependent's merge stage must know to retarget onto the base branch.
  mergedThisRun?: number[];
  // Safety control (issue #63): the batch's committed size at ingest-time-zero,
  // and whether the mid-run breakdown notification already fired for THIS
  // batch's threshold crossing. Both are captured once and carried across
  // re-ingests like lanes are; see ingestBoardItems below for the exact reset
  // boundary (a fresh batch after a full drain, not merely "prev is null").
  initialReadyCount?: number;
  // #150: this batch's own ticket numbers, captured at the same ingest-time-
  // zero boundary as initialReadyCount (same capture-once/preserve-across-
  // re-ingest lifecycle) so humanNeededStatus's numerator can be scoped to
  // THIS batch instead of the whole board. A ticket belongs here when it is
  // brand new to the snapshot (absent from the prior state's tickets -- covers
  // a Step-1 pre-commit park straight to Questions/Blocked/Skipped, same batch,
  // #133 AC4; only meaningful when there IS a prior state, #203) or currently
  // Ready-and-unclaimed (the committed queue, same
  // filter initialReadyCount uses). A ticket already sitting Blocked/Skipped/
  // Questions from before this batch started, or a foreign claimedByOther
  // park, is neither, so it never inflates this batch's trip. undefined = a
  // state file that predates this field, which humanNeededStatus treats as
  // "count every ticket" -- the old board-wide behavior -- for one transition
  // batch until the next fresh-batch capture.
  initialBatchTickets?: number[];
  humanNeededPercent?: number;
  humanNeededNotified?: boolean;
  // Per-loop ticket cap (issue #131): the flagged, dependency-self-contained
  // allow-list of ticket numbers this run works (lib/lanes.ts selectBatch),
  // captured ONCE at the fresh-batch boundary and preserved across every
  // re-ingest and across a context clear (state.json survives both) -- same
  // per-batch lifecycle as initialReadyCount/mergedThisRun. undefined = no cap
  // (ticketLimit 0): every workable ticket is in the batch, byte-identical to
  // pre-#131.
  batchTickets?: number[];
  // Context ceiling (issue #131). contextTokens is the LIVE orchestrator
  // context-window occupancy, recomputed every tick by bin/z-loop-tick
  // (lib/context-budget.ts) and threaded in fresh -- never preserved from
  // prev, so the gate needs no sticky flag or reset. contextTokenLimit is the
  // ceiling, captured once like the other knobs; 0/absent disables the gate.
  contextTokens?: number;
  contextTokenLimit?: number;
}

// -- stage outcomes -----------------------------------------------------------

export type StageOutcome =
  // #177: `unverified` carries the reason a BUILT shipped nothing (see
  // builtGuardFailure). Set by recordOutcome from the lane worktree's own git
  // facts, never by the marker parser -- a BUILT recorded without those facts is
  // a plain `built`, exactly as before.
  | { kind: "built"; unverified?: string }
  | { kind: "needs-input"; note: string }
  | { kind: "qa-pass" }
  | { kind: "qa-bugs"; note: string }
  | { kind: "review-approve"; confidence: number | null; skeptics: { received: number; of: number } | null }
  | { kind: "review-findings"; note: string }
  | { kind: "human-question"; note: string }
  | { kind: "stage-blocked"; note: string }
  | { kind: "confused"; note: string }
  | { kind: "merged"; note: string };

// Confidence token off a REVIEW-APPROVE marker note: `confidence=NN` where NN
// is 0-100 (issue #62's safety gate). `\d{1,3}` matched at a FIXED position
// right after the literal "confidence=" backtracks over 3/2/1 digits, so the
// trailing `(?!\d)` rejects every length at that position when a 4th digit
// follows -- `confidence=1000` has no match, not a truncated 100. A missing
// token or a value outside 0-100 both return null; the caller (the gate)
// decides what null means, never a parse-time throw on user-authored prose.
export function parseReviewerConfidence(note: string): number | null {
  const m = note.match(/\bconfidence=(\d{1,3})(?!\d)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 100 ? n : null;
}

// Skeptic-delivery denominator off a reviewer marker note: `skeptics=<k>/<of>`
// (issue #191), the number of skeptic verdicts the reviewer actually held out of
// the 3 it spawned. The confidence token alone cannot express this and hides the
// exact case that made #62's gate unsafe: ONE skeptic reporting "cannot refute"
// aggregates to confidence=100, clears the default floor of 70, and merges as
// though three independent reviews agreed. The denominator is the missing fact.
//
// Absent token -> null, which the gate reads as "this review had no fan-out" and
// never blocks on (a single-pass prompt emits no `skeptics=`, by design). Same
// no-throw contract as parseReviewerConfidence: these are model-authored prose,
// so an unparseable value is a decision for the gate, not a crash. `of` is
// carried rather than assumed 3 so a future skeptic count needs no reparse; a
// received count above `of` is incoherent (nobody delivered 4 of 3) and reads as
// null rather than being clamped into a pass.
export function parseSkepticQuorum(note: string): { received: number; of: number } | null {
  const m = note.match(/\bskeptics=(\d{1,2})\/(\d{1,2})(?!\d)/i);
  if (!m) return null;
  const received = Number(m[1]);
  const of = Number(m[2]);
  if (of < 1 || received > of) return null;
  return { received, of };
}

// The three git facts a BUILT claim is checked against (#177), read from the
// lane's OWN worktree by the orchestrator (z-loop/SKILL.md collects them).
// Passed in as data so the guard below stays pure and gate-testable with no real
// repository.
export interface BuilderCommitFacts {
  // `git status --porcelain --branch`. `--branch` is load-bearing, not decoration:
  // git ALWAYS emits a leading `## <branch>` line, so a payload without one means
  // `git status` never produced output (a `> file` redirect creates the file
  // BEFORE git runs, so a failed status leaves an empty file). Judging the bare
  // porcelain string would read that empty file as "clean tree" -- the dirtiness
  // half failing open, while the SHA half already fails closed.
  porcelain: string;
  headSha: string; // `git rev-parse HEAD`
  // `git merge-base <baseBranch> HEAD` -- NOT `git rev-parse <baseBranch>`. The
  // question is "does HEAD carry a commit the base branch does not", and the base
  // TIP only answers it while the tip has not moved since the worktree was made.
  // A leftover worktree re-claimed by a later loop (the claim row reuses one that
  // exists) sits under a base that Step 7 has since pulled forward, so a lane
  // that committed NOTHING reads as moved -- the guard failing open on the exact
  // build it exists to catch. The merge-base equals HEAD precisely when HEAD is
  // an ancestor of the base, i.e. when the branch has no commit of its own,
  // whatever the tip did in the meantime.
  baseSha: string;
}

// The shortest prefix that may be read as naming a commit. git's own default
// abbreviation is 7, and anything shorter is treated as "no SHA reported" rather
// than as a match against every commit that happens to start with it.
const MIN_SHA_LENGTH = 7;

// Do two SHAs name the same commit? Both sides come from git (full 40-char
// OIDs), but an abbreviated one still names the same commit, and reading an
// abbreviation as "different" would fail OPEN -- the guard would report a moved
// HEAD for a branch still sitting on base, which is the exact bug #177 exists to
// catch. Prefix compare, case-folded, so length mismatch cannot slip a no-commit
// build past.
function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

// Did a builder that reported BUILT actually ship anything? Returns null when it
// did (clean tree AND at least one commit of its own), else the reason, phrased
// for the human who reads it on the board and for the builder that is re-prompted
// with it.
//
// Run 9's #155 builder emitted BUILT with everything still uncommitted; QA then
// reviewed the BASE tree and passed, because a lane with no commit ships no diff.
// Both halves are load-bearing: a dirty tree means work is still sitting in the
// worktree, and a HEAD that is still an ancestor of the base means nothing was
// committed at all. Either alone still holds the lane (a builder that commits half
// its work and leaves the rest unstaged has shipped an incomplete diff).
//
// The status payload is judged by its DIRTY lines, untracked files included: a
// brand-new test or docs file the builder never `git add`ed is precisely the work
// that would go missing, so `??` lines count. Files matched by .gitignore never
// appear (no --ignored), so real scratch output -- graphify-out/ under this repo's
// mandatory hook, for one -- does not trip this.
//
// Every unreadable input fails CLOSED, on both halves: a status payload with no
// `## <branch>` header cannot prove a clean tree, and an absent/short SHA cannot
// prove a commit exists. A git call that returned nothing must never be the reason
// a no-commit build walks to QA.
// The two facts a `git status --porcelain --branch` payload carries: whether git
// ran at all (its `## <branch>` header is present -- see BuilderCommitFacts.porcelain
// for why an empty file is NOT a clean tree) and the dirty paths it reported.
// One parse, shared by #177's BUILT guard and #209's dead-worker recovery, so the
// two can never disagree about what "dirty" means.
function readPorcelain(porcelain: string): { statusRan: boolean; dirty: string[] } {
  const lines = porcelain.split(/\r?\n/).filter((l) => l.trim() !== "");
  return { statusRan: lines.some((l) => l.startsWith("## ")), dirty: lines.filter((l) => !l.startsWith("## ")) };
}

// #209: does this worktree hold work that would be DISCARDED by skipping the
// lane? True when git reported at least one dirty path (untracked included --
// a test file the dead agent never `git add`ed is exactly the work at stake),
// and true again when git printed SOMETHING that carries no `## <branch>`
// header -- a truncated or garbled status cannot prove the tree is clean, and
// the two ways to be wrong there are not symmetric: reading it as clean SKIPS a
// ticket whose finished work is sitting in the worktree (the exact loss this
// ticket exists to stop), while reading it as dirty spends at most ONE re-spawn
// (MAX_DEAD_RESPAWNS) on a lane that may have nothing in it -- and that agent is
// told the prior work is unverified and may be dropped.
//
// An EMPTY payload is the one case that is not a judgment call, and it is not
// "unreadable": `git status --porcelain --branch` ALWAYS prints its header when
// it runs at all, so zero bytes means git produced no output whatsoever. The way
// that happens is the orchestrator's redirect creating the file and git then
// failing outright (exit 128) -- which is exactly what a MISSING or broken
// worktree yields. There is provably nothing there to recover, so this reports
// no work rather than briefing a fresh agent that "its worktree still holds
// uncommitted changes" and spawning it into a directory that does not exist.
// It also means a re-spawn only ever happens on a worktree git successfully read
// seconds earlier, which is what makes the briefing true.
export function worktreeHoldsWork(porcelain: string): boolean {
  if (porcelain.trim() === "") return false;
  const { statusRan, dirty } = readPorcelain(porcelain);
  return dirty.length > 0 || !statusRan;
}

export function builtGuardFailure(facts: BuilderCommitFacts): string | null {
  const { statusRan, dirty } = readPorcelain(facts.porcelain);
  const head = facts.headSha.trim();
  const base = facts.baseSha.trim();
  const readable = head.length >= MIN_SHA_LENGTH && base.length >= MIN_SHA_LENGTH;
  const moved = readable && !sameCommit(head, base);
  if (statusRan && dirty.length === 0 && moved) return null;
  const parts: string[] = [];
  if (dirty.length > 0) {
    parts.push(`${dirty.length} uncommitted path(s) in its worktree (${dirty.slice(0, 5).map((l) => l.trim()).join(", ")}${dirty.length > 5 ? ", ..." : ""})`);
  }
  if (!statusRan) {
    parts.push(
      `no readable \`git status --porcelain --branch\` output (its \`## <branch>\` header is missing), so a clean tree cannot be proven`
    );
  }
  if (!moved) {
    parts.push(
      readable
        ? `HEAD (${head.slice(0, MIN_SHA_LENGTH)}) still an ancestor of the base branch, so the branch carries no commit of its own`
        : `no readable HEAD/base SHA, so no commit can be proven either way`
    );
  }
  // The fix line has to be true in EVERY shape: a dirty tree means the work exists
  // and only needs committing; a clean tree with no commit means the lane holds
  // nothing at all, and telling that builder to "commit its work" would send it
  // looking for files nobody wrote; an unreadable fact means the lane's state is
  // unknown, so the only honest instruction is "look first".
  const fix =
    dirty.length > 0
      ? `Commit what is already in the worktree onto this lane's branch -- nothing is lost, the files are still there -- then report BUILT again.`
      : statusRan && readable
        ? `Nothing at all is on this branch: build the ticket and COMMIT it, then report BUILT again.`
        : `The worktree's state could not be read at all, so look before you build (\`git status\`, \`git log\`): commit whatever is already there, build the rest, then report BUILT again.`;
  return (
    `uncommitted work: the builder reported BUILT but left ${parts.join(" and ")}. ` +
    `QA and the reviewer read the branch's committed diff, so they would review the base tree and pass a diff that does not exist. ` +
    fix
  );
}

// The machine-parsed exit contract every stage prompt ends with
// (lib/stage-prompts.ts). Marker -> outcome, per stage; a final message that
// starts with none of its stage's markers is CONFUSED by definition -- the
// no-token-burn rule turns unparseable output into a skip, never a retry loop.
const MARKERS: Record<Stage, Record<string, (note: string) => StageOutcome>> = {
  builder: {
    "BUILT": () => ({ kind: "built" }),
    "NEEDS-INPUT": (note) => ({ kind: "needs-input", note }),
    "BLOCKED": (note) => ({ kind: "stage-blocked", note }),
    "CONFUSED": (note) => ({ kind: "confused", note }),
  },
  qa: {
    "QA-PASS": () => ({ kind: "qa-pass" }),
    "QA-BUGS": (note) => ({ kind: "qa-bugs", note }),
    "NEEDS-HUMAN": (note) => ({ kind: "human-question", note }),
    "BLOCKED": (note) => ({ kind: "stage-blocked", note }),
    "CONFUSED": (note) => ({ kind: "confused", note }),
  },
  reviewer: {
    "REVIEW-APPROVE": (note) => ({
      kind: "review-approve",
      confidence: parseReviewerConfidence(note),
      skeptics: parseSkepticQuorum(note),
    }),
    "REVIEW-FINDINGS": (note) => ({ kind: "review-findings", note }),
    "NEEDS-HUMAN": (note) => ({ kind: "human-question", note }),
    "BLOCKED": (note) => ({ kind: "stage-blocked", note }),
    "CONFUSED": (note) => ({ kind: "confused", note }),
  },
  merge: {
    "MERGED": (note) => ({ kind: "merged", note }),
    "NEEDS-HUMAN": (note) => ({ kind: "human-question", note }),
    "BLOCKED": (note) => ({ kind: "stage-blocked", note }),
    "CONFUSED": (note) => ({ kind: "confused", note }),
  },
};

export function parseStageResult(stage: Stage, finalMessage: string): StageOutcome {
  const lines = finalMessage.split(/\r?\n/);
  const first = lines.find((l) => l.trim() !== "")?.trim() ?? "";
  const m = first.match(/^([A-Z][A-Z-]*):\s*(.*)$/);
  const make = m ? MARKERS[stage][m[1]] : undefined;
  if (!m || !make) {
    const snippet = finalMessage.trim().slice(0, 200);
    return {
      kind: "confused",
      note: `Stage "${stage}" ended without a recognized exit marker (${Object.keys(MARKERS[stage]).join(", ")}). Message began: ${JSON.stringify(snippet)}`,
    };
  }
  const restIdx = lines.indexOf(lines.find((l) => l.trim() !== "")!);
  const note = [m[2], ...lines.slice(restIdx + 1)].join("\n").trim();
  return make(note);
}

// -- actions ------------------------------------------------------------------

export type Action =
  | { kind: "claim"; ticket: number; stage: Stage }
  | {
      kind: "advance";
      ticket: number;
      to: Stage;
      note?: string;
      investigateFirst?: boolean;
      stackedOn?: number[];
      resyncStatus?: BoardStatus; // #116: correct a one-hop-lagged board status before this advance's setStatus, bypassing canTransition -- see the nextAction desync guard for why this is safe
    }
  // #209: re-spawn THIS lane's current stage after its worker died without an
  // exit marker while the worktree still held uncommitted work. Carries the
  // attempt number the fresh spawn must be tagged with (the dead spawn already
  // used the previous one, and a re-used spawn tag makes `transcripts collect`
  // refuse to guess), and the note the fresh agent is briefed with.
  | { kind: "respawn"; ticket: number; stage: Stage; attempt: number; note: string }
  // `salvage` (#209): the lane worktree holds UNCOMMITTED work that this action
  // is about to strand, so the orchestrator must dump
  // `reports/uncommitted-<N>.patch` BEFORE it removes the lane lock. Every one of
  // these three actions drops the lane, and a lockless worktree is an orphan the
  // next run's reconcile scan force-removes -- so "the worktree survives for you
  // to look at" is only ever true until the next `--reconcile`.
  //
  // It is a FIELD rather than a phrase in the note (which is how the two salvage
  // rows keyed it first) because a prose trigger is matched by whatever sentence
  // happens to contain it: the stop-lane note below carries the words
  // "uncommitted work" while routing to a row that dumped nothing, so the same
  // key meant two different things one edit apart. The orchestrator now reads
  // `.salvage` off the action JSON -- one structural key, three rows, no
  // substring in it.
  // `dropTicket` (#273): this stop-lane is stopping a lane whose TICKET has left
  // the loop's reach -- proved off the board, or observed in a status the loop
  // does not drive -- so applying it must remove the ticket from state along with
  // the lane. Without it the ticket lingers at whatever workable status it last
  // held and the very next `next` returns a `claim` for it: a fresh PAID agent
  // spawned into a ticket that is not on the board.
  //
  // A FIELD on the action, for the same reason `salvage` is one directly above:
  // the two stop-lane kinds are otherwise indistinguishable to the orchestrator,
  // and the SKILL hand-builds a stop-lane of this kind itself (the `--if-present`
  // moved:false row) where no lane state exists to consult. Keying off hidden
  // state -- `lane.goneReason` -- made the same real-world event resolve two
  // different ways depending on which path reached it.
  | { kind: "park"; ticket: number; status: "Questions" | "Blocked"; note: string; salvage?: true }
  | { kind: "skip"; ticket: number; note: string; salvage?: true }
  | { kind: "stop-lane"; ticket: number; note: string; salvage?: true; dropTicket?: true }
  | { kind: "check-worker"; ticket: number }
  // #178: run the loop-owned merge gate for this lane and stamp its verdict
  // (`loop merge-gate <worktree> --state <state.json> --ticket <N>`), exactly
  // as check-worker asks for a probe. The ONLY door to the merge stage: this
  // action repeats until a verdict lands, and nothing advances to merge
  // without a green one.
  | { kind: "merge-gate"; ticket: number }
  | { kind: "complete"; ticket: number; note: string }
  | { kind: "wait" }
  | { kind: "context-clear" }
  | { kind: "drain-complete" };

// The two config-driven QA bounce knobs resolveOutcome needs. Threaded in by
// nextAction (already defaulted there) rather than read off a global, so the
// reducer stays a pure function of its inputs.
interface QaBounceLimits {
  maxQaPasses: number;
  qaInvestigateAfter: number;
}

// The reviewer-confidence safety gate resolveOutcome needs (issue #62): the
// floor a REVIEW-APPROVE's confidence must clear to merge, and what a
// sub-floor (or unparseable) approve does. Threaded in by nextAction, same as
// QaBounceLimits, so the reducer stays a pure function of its inputs.
interface ReviewerGate {
  minConfidence: number;
  belowAction: "block" | "retry" | "off";
  maxReviewBounces: number;
  minSkepticQuorum: number; // #191: skeptic verdicts an adversarial approve needs
}

// #191: how many times ONE lane may re-spawn its reviewer over a short skeptic
// quorum before the ticket parks Blocked. Fixed at 1, deliberately: a starved
// quorum is a delivery race, and one retry is the whole value of retrying -- if a
// second independent reviewer also cannot get verdicts from 2 of 3 sub-agents,
// the cause is environmental and another paid pass will not fix it. No config
// knob for the same reason N=3 skeptics has none (lib/stage-prompts.ts).
export const MAX_QUORUM_RETRIES = 1;

// #177: how many times ONE lane may re-spawn its BUILDER over a BUILT that
// shipped nothing before the ticket parks Blocked. Fixed at 1 for the same reason
// MAX_QUORUM_RETRIES is: committing is a single command, so one honest retry is
// the whole value of retrying -- a second builder that also reports BUILT with
// nothing committed is not going to be fixed by a third paid pass.
export const MAX_COMMIT_RETRIES = 1;

// #209: how many times ONE lane may re-spawn ONE stage after a worker died
// without an exit marker while its worktree held uncommitted work. Fixed at 1,
// for the same reason the two caps above are: the failure being recovered from is
// "the agent forgot to say it finished", and one fresh agent handed the
// half-finished worktree is the whole value of retrying. A second silent death at
// the same stage is a pattern (a wedged environment, a ticket that keeps blowing a
// context window), and a third paid pass will not fix it -- which is exactly why
// the pre-#209 machine went straight to skip. The cap, not the absence of the
// transition, is what keeps this bounded.
//
// The budget is per (lane, stage): LaneState.respawns is keyed by stage, so a
// builder that burned this lane's builder re-spawn leaves QA's intact. A lane-wide
// counter would bound the whole lane at 1, which is a strictly smaller recovery for
// no extra safety -- the worst case is still one wasted spawn per stage, and the
// stages are at most four.
export const MAX_DEAD_RESPAWNS = 1;

// Which stages a dead worker may be re-spawned into (#209). The lane worktree is
// the BUILDER's workspace, and QA's own prompt tells it to report rather than fix,
// so builder is the case that actually recovers work -- but a QA agent that DID
// leave uncommitted changes left exactly the same unverified state, and its prompt
// can carry the same briefing, so it takes the same path.
//
// `reviewer` is excluded on purpose, and not because reviewers never die (run 11's
// markerless exits were mostly reviewers): the reviewer executes in a THROWAWAY
// worktree, so a dirty lane worktree is never its work, and its input is pinned to
// exactly four blinded keys (lib/stage-prompts.ts assertReviewerInput) -- there is
// no way to tell a fresh reviewer "your predecessor left this behind" without
// breaking the blindness contract, which is worth more than this recovery. A short
// review is #191's quorum retry, not this one. `merge` never reaches here at all:
// H9's check-worker hold above returns first.
const RESPAWN_STAGES: readonly Stage[] = ["builder", "qa"];

// #177's guard failure, resolved: re-spawn THIS lane's builder to commit its work
// (a self-advance -- the lane is already at builder, the board already shows
// Building, so the move is a no-op), and once the retry is spent, park Blocked
// with the same "uncommitted work" note a human needs to see.
//
// The re-spawn targets the builder rather than parking straight away because the
// observed failure (run 9's #155) was fixed by one instruction to commit; parking
// would spend a human trip on a one-command fix. The note travels to that builder
// as `commitNotes` (lib/stage-prompts.ts) so the fresh agent is told what its
// predecessor left behind instead of guessing.
//
// The park note must not promise a worktree the loop itself deletes. Parking
// removes the lane lock, and a LOCKLESS worktree is an orphan to the next run's
// reconcile scan (lib/reconcile.ts) whatever the board says: its plan prunes it
// with `git worktree remove --force`, and Step 0(b) refuses to start until that
// prune has run. Every other park's work is already committed on a branch, and
// branches are never deleted (issue #2) -- this is the ONE park whose only copy of
// real work is uncommitted, so the note names the salvage patch the orchestrator
// dumps first (z-loop/SKILL.md `park N Blocked`, triggered by the action's own
// `salvage` field) and says plainly that the worktree does not survive the next
// run.
function commitRetryAction(lane: LaneState, detail: string): Action {
  const spent = lane.commitRetries ?? 0;
  if (spent >= MAX_COMMIT_RETRIES) {
    return {
      kind: "park",
      ticket: lane.ticket,
      status: "Blocked",
      salvage: true,
      note:
        `${detail}\n\nA re-prompted builder reported BUILT with nothing committed again ` +
        `(${spent + 1} attempt(s)), so this is not a slip. The work was dumped to ` +
        `\`~/.zstack/projects/<slug>/reports/uncommitted-${lane.ticket}.patch\` ` +
        `(re-apply it in a fresh worktree with \`git apply\`) because the lane worktree does NOT survive: ` +
        `parking released its lane lock, so the next run's reconcile scan force-removes it ` +
        `(\`git worktree remove --force\` -- uncommitted work discarded) before the loop will start. ` +
        `Salvage it BEFORE the next /z-loop run: commit it onto this lane's branch (branches are never deleted) ` +
        `or stash it, then return the ticket to Ready.`,
    };
  }
  return { kind: "advance", ticket: lane.ticket, to: "builder", note: detail };
}

// Re-spawns this lane has spent AT ONE STAGE (#209). Absent reads as 0, which is
// both the pre-#209 state file and every stage that has never re-spawned.
export function respawnsAt(lane: LaneState, stage: Stage): number {
  return lane.respawns?.[stage] ?? 0;
}

// The 1-based number of times this lane has spawned an agent at its CURRENT
// stage, counting every route that re-spawns that stage (#209). It is the
// `<attempt>` half of a spawn tag (lib/transcripts.ts spawnTag) and of the
// `<stage>-<attempt>.jsonl` transcript name, so two spawns of one stage on one
// lane must never compute the same value: a re-used tag makes `collect` refuse
// (it cannot tell the two spawns' spend apart) and a re-used name overwrites the
// predecessor's transcript, silently undercounting the ticket's Actual.
//
// It lives here rather than in the SKILL's prose because it is arithmetic over
// five counters that grows every time a re-spawn route is added -- exactly the
// kind of derivation PRINCIPLES.md keeps out of a model reply. Read AFTER the
// action is applied (the counters are spent by applyAction), which is where the
// orchestrator spawns from anyway.
//
// DERIVATION, exhaustive over the machine's spawn routes rather than patched per
// bug -- three separate duplicate-tag defects have already come out of guessing at
// this sum. There are exactly three action kinds that put an agent at a stage
// (`claim`, `advance`, `respawn`), so enumerate every arrow into each stage and
// name the counter applyAction spends on it. The requirement is UNIQUENESS, not
// density: the count must strictly increase between any two spawns of one stage
// on one lane. Gaps are harmless (a lane claimed straight into Review and bounced
// back reaches QA for the first time at attempt 2 -- an unused number, never a
// collision).
//
//   builder  <- claim (Ready/Building)              base 1
//              qa -> builder      (qa bugs)         qaBounces++
//              reviewer -> builder(findings/retry)  reviewBounces++
//              builder -> builder (#177 no commit)  commitRetries++
//              respawn @builder   (#209)            respawns.builder++
//   qa       <- claim (QA)                          base 1
//              builder -> qa      (verified BUILT)  see below
//              respawn @qa        (#209)            respawns.qa++
//   reviewer <- claim (Review)                      base 1
//              qa -> reviewer     (QA pass)         see below
//              builder -> reviewer(#130 skip-qa)    see below
//              reviewer -> reviewer(#191 quorum)    quorumRetries++
//              respawn @reviewer                    respawns.reviewer++ (see RESPAWN_STAGES)
//   merge    <- reviewer -> merge (the merge gate)  base 1
//              respawn @merge                       respawns.merge++ (see RESPAWN_STAGES)
//
// The two "see below" arrows are the ones that have no counter of their own, and
// they are why the sums below are not one term per arrow:
//   * builder -> qa fires once per verified BUILT, and the lane can only be back
//     at builder to produce another one by having spent a qaBounces (qa->builder)
//     or a reviewBounces (reviewer->builder). So the number of qa arrivals is
//     qaBounces + reviewBounces + 1. commitRetries and respawns.builder do NOT
//     belong: they re-spawn the builder without adding a builder->qa arrow.
//     Missing reviewBounces here is the collision QA reproduced -- BUILT, qa(1),
//     QA-PASS, findings, builder, BUILT, qa(1) again.
//   * qa -> reviewer / builder -> reviewer likewise: after a review the lane can
//     only return to the reviewer through reviewer->builder, so those arrows total
//     reviewBounces + 1 on skip-qa and non-skip-qa lanes alike (of the
//     qaBounces + reviewBounces + 1 qa arrivals, exactly qaBounces bounce).
//     qaBounces does NOT belong: a QA bounce reaches the reviewer no more often.
//   * merge has no arrow back into it at all: `merged` completes the lane, a dead
//     merge worker holds at check-worker (H9), and every other merge outcome parks
//     or skips. So merge is spawned at most once per lane.
//
// The respawn terms are per-stage (LaneState.respawns) precisely so each stage's
// sum sees only its own -- and each stage carries its term even where
// RESPAWN_STAGES currently makes it structurally 0, so adding a stage to that list
// cannot silently reintroduce a duplicate tag.
//
// Scope of the invariant: ONE LANE. A lane destroyed by park/skip/complete or by a
// reconcile takes its counters with it, so a ticket re-claimed in a later run
// starts over at attempt 1. That is safe because a tag is only ever resolved
// against the CURRENT orchestrator session's sub-agent directory (transcripts
// collect), which a new run does not share.
export function stageAttempt(lane: LaneState): number {
  const respawns = respawnsAt(lane, lane.stage);
  switch (lane.stage) {
    case "builder":
      return lane.qaBounces + lane.reviewBounces + (lane.commitRetries ?? 0) + respawns + 1;
    case "qa":
      return lane.qaBounces + lane.reviewBounces + respawns + 1;
    case "reviewer":
      return lane.reviewBounces + (lane.quorumRetries ?? 0) + respawns + 1;
    case "merge":
      return respawns + 1;
  }
}

// What the fresh agent of a #209 re-spawn is told. The judgment call is handed to
// it explicitly: carrying the dead attempt's work forward as trusted would defeat
// the fresh-agent guarantee (nothing latent travels between stages, and nothing
// verified this), while discarding it silently is the waste this whole transition
// exists to stop. So the note states what is there, states that NOTHING confirmed
// it, and puts keep/fix/drop on the agent that can actually look.
function deadRespawnNote(lane: LaneState): string {
  return (
    `Your predecessor on this lane died without reporting: it went silent past the watchdog, was not ` +
    `alive on probe, and never emitted an exit marker -- so nothing it did was verified by anyone. Its ` +
    `worktree still holds UNCOMMITTED changes. Treat them as unverified work in progress, not as a head ` +
    `start you must keep: look first (\`git status\`, \`git diff\`, \`git log\`), then decide for yourself ` +
    `whether to keep, fix, or drop them -- that call is yours, and so is this stage's outcome either way. ` +
    `This lane's ${lane.stage} stage has ONE re-spawn and it is now spent; a second silent death here skips the ticket.`
  );
}

// The cumulative wall-clock a single stage spawn may occupy a lane, however
// alive it keeps answering (#256). 8 hours.
//
// This bound is what makes the watchdog's alive path TERMINATE. An ALIVE probe
// refreshes lastActivityMs (recordProbe) with no memory of how many probes came
// before, so a worker that is wedged but still registered in the harness task
// list answers alive, the baseline resets, and the same lane is probed again one
// budget later -- forever, holding its ticket, its worktree, its lane lock and
// one of maxLanes slots. Every other retry in the pack is outcome-driven
// (qaBounces, reviewBounces, quorumRetries, commitRetries, respawns); elapsed
// time had none, so nothing ended that sequence but a human noticing.
//
// A MEASUREMENT, like every other constant here. The population: every
// orchestrator-spawned agent on this machine that came to rest on a final answer
// -- 939 stage-described ones, p50 8.0m, p95 27.8m, p99 48.6m, and a long tail of
// 6 over an hour topping out at MEASURED_MAX_STAGE_MS = 13,304,097 ms (3.7 hours,
// a "Build C9 /z-status dashboard" builder). Those are stages that FINISHED, so a
// ceiling under them would park work that was going to land. 2 x 3.7h = 7.4h,
// rounded up to 8 -- which is SUBTREE_STALE_MS exactly, and that agreement is
// worth keeping: 8 hours is already the age at which lib/transcripts.ts stops
// believing a transcript proves anything is running behind it, so it is the same
// answer to the same question asked of the same corpus.
//
// The asymmetry runs the other way from the watchdog's. A watchdog that fires
// early costs a paid re-spawn or a discarded ticket; this one parks BLOCKED, so
// being wrong costs a human one look at a ticket that is sitting there with its
// branch and worktree intact. Being too generous costs a held lane for the rest
// of the run, which is why it is bounded at all.
export const STAGE_CEILING_MINUTES = 480;

// A lane whose CURRENT stage has occupied it past STAGE_CEILING_MINUTES (#256).
// Parks Blocked, naming the stage, the elapsed minutes and the ceiling, so the
// note is self-explaining to the human who has to decide what to do with it.
//
// `salvage: true` unconditionally, unlike the dead-worker paths above which set
// it only on a proven-dirty worktree. There is no probe here and so no worktree
// facts: this fires on a lane the loop has watched for 8 hours and may still be
// writing files it never committed, and parking releases the lane lock, which
// makes that worktree an orphan the next run's reconcile force-removes. An empty
// salvage patch costs one file; a discarded 8-hour worktree costs the ticket.
function stageCeilingAction(lane: LaneState, elapsedMs: number): Action {
  const minutes = Math.floor(elapsedMs / 60_000);
  return {
    kind: "park",
    ticket: lane.ticket,
    status: "Blocked",
    salvage: true,
    note:
      `The ${lane.stage} stage has held this lane for ${minutes} minutes, past the ${STAGE_CEILING_MINUTES}-minute ` +
      `per-stage ceiling, so the loop is parking it rather than probing it alive again. An agent that keeps ` +
      `answering ALIVE refreshes the watchdog forever, so elapsed time is the only thing that can end this. ` +
      `Nothing here is proven broken and nothing was skipped: the branch and worktree are intact, and any ` +
      `uncommitted work was dumped to \`~/.zstack/projects/<slug>/reports/uncommitted-${lane.ticket}.patch\` ` +
      `(re-apply with \`git apply\`) because releasing the lane lock leaves the worktree an orphan the next ` +
      `run's reconcile force-removes.` +
      (lane.stage === "merge"
        ? ` This was a MERGE stage: check \`gh pr view\` before returning the ticket -- the PR may have landed ` +
          `before the agent wedged, in which case the ticket is Done rather than Blocked.`
        : ` Return it to Ready once you have decided what to keep.`),
  };
}

// A lane whose worker is silent past the watchdog AND not alive on probe (#209).
//
// Before this, the machine's only answer was `skip` -- correct when the agent
// could not do the job, wrong when it simply never said it did. Run 11's #170
// builder addressed both reviewer findings, backgrounded its own `bun test`, and
// stopped waiting for it; the finished diff was sitting uncommitted in the
// worktree, and recording that outcome would have skipped the ticket and thrown
// away every dollar already spent on it. So a dead worker whose worktree still
// holds uncommitted work buys one fresh agent at the SAME stage instead.
//
// A fresh SPAWN, never a resume: the no-SendMessage rule (z-loop/SKILL.md) is the
// gate-tested guarantee that nothing latent travels between stages, and it is
// worth more than the tokens a resume would save.
function deadWorkerAction(lane: LaneState, wd: number, parkedByHuman: boolean): Action {
  // A dead MERGE worker is never blind-skipped (issue #14 H9): `gh pr merge` may
  // have landed the PR before the worker died, and skipping would lose it from
  // mergedThisRun (breaking a stacked child's step-18 retarget) and let batch-end
  // branch deletion close the dependent PR. The SKILL must verify PR state via
  // `gh pr view` and record an outcome -- `merged` (-> complete, counted in
  // mergedThisRun) if it landed, else `stage-blocked` (-> park Blocked for a
  // human). So a dead merge lane holds at check-worker until an outcome is
  // recorded, never falling through to the skip or the re-spawn below.
  if (lane.stage === "merge") return { kind: "check-worker", ticket: lane.ticket };
  // A human who moved this ticket to a stop status mid-run took it OUT of the
  // loop, and that move is respected (docs/user-guide/z-loop.md) -- so the lane
  // stops here and spends nothing. Step 1's stop-lane guard cannot catch this
  // lane: it only considers lanes with a recorded outcome, and a worker that died
  // silently has none by definition. Without this check the recovery would spawn
  // a fresh paid agent into a ticket a human just dragged to Blocked/Questions,
  // overriding the one instruction the board is guaranteed to carry. stop-lane
  // rather than skip: the human already set the status, so it is not ours to
  // overwrite with Skipped.
  //
  // The uncommitted work is salvaged here for exactly the reason the skip below
  // salvages it, and the note must not say otherwise: stop-lane removes the lane
  // lock too, so this worktree is an orphan to the next run's reconcile scan
  // (lib/reconcile.ts orphanWorktrees -> pruneWorktreeReal -> `git worktree
  // remove --force`) whatever the board says. An earlier cut of this branch
  // promised the tree was "kept for inspection" 33 lines above the code that
  // proves it is not.
  if (parkedByHuman) {
    const dirty = lane.worktreeDirty === true;
    return {
      kind: "stop-lane",
      ticket: lane.ticket,
      ...(dirty ? { salvage: true as const } : {}),
      note:
        `Worker died mid-${lane.stage} (silent past the ${wd}-minute watchdog, not alive on probe), and a human ` +
        `had already moved #${lane.ticket} to a stop status during the run; stopping its lane cleanly instead of ` +
        `re-spawning or skipping${
          dirty
            ? ` -- its worktree still held uncommitted work, dumped to \`~/.zstack/projects/<slug>/reports/uncommitted-${lane.ticket}.patch\` ` +
              `(re-apply it with \`git apply\`) because releasing the lane lock leaves the worktree an orphan the next run's reconcile ` +
              `force-removes`
            : ""
        } (other lanes continue).`,
    };
  }
  // Per STAGE, not per lane: a builder that died silently is no evidence about the
  // QA agent that runs after it, so spending the builder's budget must not leave a
  // later QA death with nothing but the skip.
  const spent = respawnsAt(lane, lane.stage);
  const dirty = lane.worktreeDirty === true;
  if (dirty && RESPAWN_STAGES.includes(lane.stage) && spent < MAX_DEAD_RESPAWNS) {
    // stageAttempt reads the counters BEFORE applyAction spends this re-spawn, so
    // the fresh spawn's attempt is the next one up. applyAction's increment then
    // makes a later `loop attempt` read agree with this number exactly.
    return {
      kind: "respawn",
      ticket: lane.ticket,
      stage: lane.stage,
      attempt: stageAttempt(lane) + 1,
      note: deadRespawnNote(lane),
    };
  }
  const base = `Worker died mid-${lane.stage}: silent past the ${wd}-minute watchdog and not alive on probe.`;
  // No uncommitted work (or no worktree facts collected at all): byte-identical to
  // the pre-#209 note -- there is nothing to recover, so no re-spawn is spent.
  if (!dirty) {
    return {
      kind: "skip",
      ticket: lane.ticket,
      note: `${base} Skipped per the PROCESS.md no-token-burn rule; worktree left for inspection.`,
    };
  }
  // Work IS sitting there and the lane has no re-spawn left. Skipping removes the
  // lane lock, and a LOCKLESS worktree is an orphan to the next run's reconcile
  // scan whatever the board says -- it is force-removed (uncommitted work
  // discarded) before the loop will start. Same salvage contract as #177's park:
  // the note names the patch the orchestrator dumps first (z-loop/SKILL.md
  // `skip N`, triggered by this action's own `salvage` field), so the note is
  // true.
  return {
    kind: "skip",
    ticket: lane.ticket,
    salvage: true,
    note:
      `${base} ${spent > 0 ? `A re-spawned ${lane.stage} died the same way (${spent + 1} attempt(s)), so this is not a slip. ` : ""}` +
      `Its worktree still holds uncommitted work, which was dumped to ` +
      `\`~/.zstack/projects/<slug>/reports/uncommitted-${lane.ticket}.patch\` ` +
      `(re-apply it in a fresh worktree with \`git apply\`) because the lane worktree does NOT survive: ` +
      `skipping released its lane lock, so the next run's reconcile scan force-removes it ` +
      `(\`git worktree remove --force\` -- uncommitted work discarded) before the loop will start. ` +
      `Salvage it BEFORE the next /z-loop run, then return the ticket to Ready. ` +
      `Skipped per the PROCESS.md no-token-burn rule.`,
  };
}

// Reviewer->builder bounce cap (issue #76): both routes that send a ticket
// back to the builder from Review -- a REVIEW-FINDINGS, and a below-floor
// confidence retry -- draw on the SAME lane.reviewBounces budget, capped by
// reviewerGate.maxReviewBounces. Mirrors the qa-bugs cap below: without it, a
// low-confidence-forever ticket in "retry" mode could loop
// builder->QA->review indefinitely, burning tokens.
function reviewerBounceAction(lane: LaneState, reviewerGate: ReviewerGate, note: string): Action {
  const ticket = lane.ticket;
  const pass = lane.reviewBounces + 1;
  if (pass >= reviewerGate.maxReviewBounces) {
    return {
      kind: "park",
      ticket,
      status: "Blocked",
      note: `review bounce cap reached (${pass}/${reviewerGate.maxReviewBounces})\n\n${note}`,
    };
  }
  return { kind: "advance", ticket, to: "builder", note };
}

// #191's quorum gate, applied only to an approve that already cleared the
// confidence floor. Returns null (merge) when the review carried enough skeptic
// verdicts, a reviewer RE-SPAWN when it did not, and Blocked once this lane has
// spent its one retry.
//
// The re-spawn targets the REVIEWER, not the builder: a short quorum says the
// review was thin, not that the diff is wrong, and rebuilding a diff nobody
// found fault with fixes nothing while paying a builder and a QA pass for it.
// canTransition("Review","Review") is already legal and STATUS_FOR_STAGE matches,
// so the board move is a no-op.
//
// The retry budget is SEPARATE from lane.reviewBounces on purpose. Sharing it
// would let a delivery race consume a rebuild that a genuine finding needs, and
// would park the ticket under "review bounce cap reached" -- telling the human a
// reviewer rejected this diff twice when one of the two was a starved sub-agent.
// Two different failures, two different budgets, two different notes.
function quorumAction(
  lane: LaneState,
  reviewerGate: ReviewerGate,
  skeptics: { received: number; of: number } | null
): Action | null {
  if (reviewerGate.minSkepticQuorum <= 0) return null; // quorum gate disabled
  // `== null` catches undefined as well as null, deliberately: a lane's outcome
  // is PERSISTED in state.json, so a loop upgraded onto #191 mid-drain reads
  // review-approve outcomes recorded by the old code, which carry no `skeptics`
  // key at all. A strict `=== null` would dereference undefined and crash the
  // tick. Either way the reading is the same -- no denominator reported, so this
  // gate has nothing to judge and #62's floor already ruled.
  if (skeptics == null) return null; // single pass, unparseable, or pre-#191 state
  if (skeptics.received >= reviewerGate.minSkepticQuorum) return null; // enough looked -> merge gate
  const spent = lane.quorumRetries ?? 0;
  const detail =
    `skeptic quorum not met (${skeptics.received}/${skeptics.of} verdicts delivered, ` +
    `${reviewerGate.minSkepticQuorum} required). The confidence score aggregated over ` +
    `${skeptics.received === 0 ? "no verdicts at all" : `only ${skeptics.received}`}, so it is not the ` +
    `independent agreement the adversarial pass is supposed to produce.`;
  if (spent >= MAX_QUORUM_RETRIES) {
    return {
      kind: "park",
      ticket: lane.ticket,
      status: "Blocked",
      note:
        `${detail}\n\nA second reviewer could not reach quorum either (${spent + 1} attempt(s)), so this is ` +
        `environmental, not luck. Re-run the review by hand, or lower minSkepticQuorum for this project if a ` +
        `thinner adversarial pass is acceptable. The diff itself was never faulted.`,
    };
  }
  return { kind: "advance", ticket: lane.ticket, to: "reviewer", note: detail };
}

// What one lane's finished stage means for that lane. A PASSING review-approve
// (or a disabled gate) returns null: merging is a cross-lane decision
// (dependency order, one merge at a time) resolved by nextAction's merge gate
// below, not per-lane. A FAILING approve is resolved right here, same as any
// other terminal outcome.
function resolveOutcome(lane: LaneState, qaLimits: QaBounceLimits, reviewerGate: ReviewerGate, skipQa: boolean): Action | null {
  const o = lane.outcome!;
  const ticket = lane.ticket;
  switch (o.kind) {
    case "built":
      // #177: a BUILT whose lane worktree proved to have shipped nothing never
      // advances -- not to QA and not to Review either, since the skip-QA walk
      // would hand the reviewer the same empty diff. Absent (a BUILT recorded
      // with no git facts, e.g. a pre-#177 state file mid-drain) is byte-identical
      // to the old behavior.
      if (o.unverified) return commitRetryAction(lane, o.unverified);
      // #130: a `skip-qa`-labeled ticket walks straight to Review (Building ->
      // Review, made legal above). Every other outcome is unchanged, so the
      // qa-pass/qa-bugs/investigate/reviewer paths are identical for non-skip.
      return { kind: "advance", ticket, to: skipQa ? "reviewer" : "qa" };
    case "needs-input":
    case "human-question":
      return { kind: "park", ticket, status: "Questions", note: o.note };
    case "confused":
      return { kind: "skip", ticket, note: o.note };
    case "stage-blocked":
      return { kind: "park", ticket, status: "Blocked", note: o.note };
    case "qa-bugs": {
      const pass = lane.qaBounces + 1; // the QA pass that just found these bugs
      if (pass >= qaLimits.maxQaPasses) {
        return { kind: "park", ticket, status: "Blocked", note: `Bugs on QA pass ${pass} (limit ${qaLimits.maxQaPasses}); stopping per PROCESS.md step 16.\n\n${o.note}` };
      }
      // A bounce at/past qaInvestigateAfter starts the rebuild with /investigate
      // (PROCESS.md step 15) -- generalizes the old `pass === 2` so raising the
      // cap still investigates every bounce past the configured threshold.
      return { kind: "advance", ticket, to: "builder", note: o.note, investigateFirst: pass >= qaLimits.qaInvestigateAfter };
    }
    case "qa-pass":
      return { kind: "advance", ticket, to: "reviewer" };
    case "review-findings":
      return reviewerBounceAction(lane, reviewerGate, o.note);
    case "review-approve": {
      if (reviewerGate.belowAction === "off") return null; // gate disabled -> merge gate lands it
      const conf = o.confidence; // number | null
      if (conf === null || conf < reviewerGate.minConfidence) {
        const note = conf === null
          ? `truth-check failed (reviewer approved with no parseable confidence score)`
          : `truth-check failed (confidence ${conf}/100)`;
        if (reviewerGate.belowAction === "retry") return reviewerBounceAction(lane, reviewerGate, note);
        return { kind: "park", ticket, status: "Blocked", note };
      }
      // #191: the confidence cleared the floor -- but WHAT cleared it? An
      // aggregate over ONE skeptic that could not refute is confidence=100, and
      // before this gate that merged as though three independent reviews agreed.
      // Only an adversarial review reports the denominator, so an absent token is
      // a single pass and never blocks here (that case is #62's floor's job).
      return quorumAction(lane, reviewerGate, o.skeptics);
    }
    case "merged":
      return { kind: "complete", ticket, note: o.note };
  }
}

// Attaches a resync-on-lag correction (#116) to an advance action, when
// nextAction's desync guard below judged this ticket's board read to be one
// hop behind its own lane's already-advanced stage. Only "advance" carries a
// setStatus that can throw from a stale status (park/skip/complete/stop-lane
// never do), so every other kind passes through untouched.
function withResync(action: Action, resyncStatus: Map<number, BoardStatus>): Action {
  if (action.kind !== "advance") return action;
  const status = resyncStatus.get(action.ticket);
  return status === undefined ? action : { ...action, resyncStatus: status };
}

// The scheduler. Deterministic priority order:
//   1. wave reconciliation + finished stages: a human move that parked a lane's
//      ticket out from under it stops that lane cleanly at its boundary;
//      otherwise resolve a finished stage (any lane with a non-merge-gated
//      outcome);
//   2. merge gate: of the lanes approved for merge, advance exactly one, in
//      topological merge order, only when no other lane is mid-merge;
//   3. watchdog: a silent lane is probed (check-worker) or, once known dead,
//      skipped with a note;
//   4. park any unclaimed ticket whose dependency can no longer complete;
//   5. claim the next claimable ticket if a lane is free -- SUPPRESSED while the
//      context ceiling is reached (#131): no new ticket enters Building, but
//      steps 1-3 keep draining in-flight lanes; once every lane is idle with
//      batch work remaining, return context-clear so the operator clears
//      context and resumes the same batch;
//   6. with all lanes idle and nothing claimable, break a dependency deadlock
//      by parking the lowest stuck ticket to Blocked (no-token-burn rule);
//   7. drain-complete when nothing workable remains; else wait.
// "Workable" here is batch-scoped (#131): when state.batchTickets is set, a
// Ready ticket outside the flagged allow-list is neither claimed nor counted
// against the drain, so it waits for a future run instead of keeping this one
// alive.
// The knobs come straight off the state the caller already holds -- there is no
// second options shape to keep in sync with LoopState (every caller used to
// re-spread the same nine fields into one).
//
// `laneHeads` (#248) is the one FACT the merge decision cannot derive from
// state: the sha a lane's branch actually sits at right now. It is passed in as
// data, the same way BuilderCommitFacts is, so this stays pure and gate-testable
// with no real repository -- but unlike those, no agent supplies it: the `next`
// CLI reads it itself out of `.worktrees/ticket-<N>`, derived from the ticket
// number. Absent (a reducer-only caller: unit tests, the e2e sim) means no
// observation was made this tick and the commit binding is not checked; a lane
// MISSING from a supplied map means the loop looked and could not read a head,
// which is checked and refused.
export function nextAction(state: LoopState, nowMs: number, laneHeads?: LaneHeadFacts): Action {
  const { tickets, lanes } = state;
  const maxLanes = state.maxLanes ?? DEFAULT_MAX_LANES;
  // #256: resolved PER LANE at the watchdog step below, not once here -- the
  // budget is a property of the stage, and a lane's stage is not known until the
  // loop reaches that lane.
  const budgetFor = (stage: Stage): number => resolveWatchdogMinutes(state.watchdogMinutes, stage);
  const qaLimits: QaBounceLimits = {
    maxQaPasses: state.maxQaPasses ?? DEFAULT_MAX_QA_PASSES,
    qaInvestigateAfter: state.qaInvestigateAfter ?? DEFAULT_QA_INVESTIGATE_AFTER,
  };
  const reviewerGate: ReviewerGate = {
    minConfidence: state.minReviewerConfidence ?? DEFAULT_MIN_REVIEWER_CONFIDENCE,
    belowAction: state.reviewerBelowThresholdAction ?? DEFAULT_REVIEWER_BELOW_THRESHOLD_ACTION,
    maxReviewBounces: state.maxReviewBounces ?? DEFAULT_MAX_REVIEW_BOUNCES,
    minSkepticQuorum: state.minSkepticQuorum ?? DEFAULT_MIN_SKEPTIC_QUORUM,
  };
  const byNumber = new Map(tickets.map((t) => [t.number, t]));
  // Tickets this tick's desync guard judged as a lagged (not genuine) board
  // write -- see the guard below. Populated during step 1's lane loop, read by
  // both that loop's own return and the merge gate (step 2), which reaches a
  // lane only after this loop already let it fall through (a passing
  // review-approve resolves to null here, same lane check either way).
  const resyncStatus = new Map<number, BoardStatus>();

  // 1. Wave reconciliation + finished stages, in lane order. A human who moved a
  //    lane's ticket to a stop status mid-run (the board is re-read before each
  //    transition) stops that lane cleanly at its next boundary: only a lane that
  //    has reached a boundary (an outcome recorded, including a gated merge
  //    approval) is stopped, so a mid-stage worker is never killed -- it finishes,
  //    records its outcome, and is caught here on the following tick. Merge
  //    approvals still wait for the gate below.
  const parkedByHuman = reconcileBoardMoves(tickets, lanes);

  // 1a. #273: lanes whose TICKET left the loop's reach -- a human dragged it into
  //     a column the loop does not drive, or a confirm-pass lookup proved it off
  //     the board. Its OWN PASS, ahead of every other per-lane transition below,
  //     and deliberately not gated on `lane.outcome` the way every other stop
  //     here is. Two reasons, and they are not the same reason:
  //
  //     - There is no boundary coming. The human-move stop below waits for one
  //       because its ticket is still on the board and still observable next
  //       tick; a gone ticket is not observable at all, so waiting for a report
  //       that may never arrive IS the unsupervised-worker window this stop
  //       exists to close.
  //     - Inside the shared loop it lost to any LOWER-INDEXED lane with a
  //       finished stage (measured: lanes [#4 built, #5 gone] returned
  //       `advance #4`), so a gone lane's live agent kept running for as many
  //       ticks as its neighbours had work. The drain could not complete
  //       meanwhile -- the retained lane keeps `lanes.length` non-zero -- so
  //       nothing was ever unsafe, but the window it exists to close stayed open.
  //
  //     Lowest ticket number first so the choice is deterministic when two lanes
  //     go at once. This cannot starve the rest of the loop: each pass removes
  //     one gone lane for good, and there are finitely many.
  const goneLane = lanes
    .filter((l) => l.goneReason !== undefined)
    .sort((a, b) => a.ticket - b.ticket)[0];
  if (goneLane) {
    const reason = goneLane.goneReason!;
    const why =
      reason.kind === "unsupported-status"
        ? `now sits in board status ${reason.status ? JSON.stringify(reason.status) : "(none)"}, which the loop does not drive`
        : reason.kind === "confirmed-gone"
          ? `is no longer on the project board (proved by a single-ticket lookup)`
          : // An unrecognized kind still stops the lane, but must NOT borrow either
            // proof: a hand-edited or forward-version state.json is not evidence
            // that a lookup ran. Naming what we do not know beats fabricating it.
            `left the loop's reach for a reason this version does not recognize`;
    return {
      kind: "stop-lane",
      ticket: goneLane.ticket,
      // #273: unlike every other stop-lane, this one fires MID-STAGE -- the
      // worker may be halfway through writing files it has not committed. The
      // teardown removes the lane lock, which makes the worktree an orphan the
      // next run's reconcile force-removes, so the dump is the only thing
      // standing between a human's column drag and a builder's lost work.
      // Unconditional rather than gated on `worktreeDirty`: that flag is only
      // ever set by a dead-worker probe, and this stop does not wait for one. A
      // dump of a clean tree is an empty patch and costs nothing.
      salvage: true,
      dropTicket: true,
      note:
        `#${goneLane.ticket} ${why}; stopping its ${goneLane.stage} lane so its agent is torn down and its lane lock ` +
        `released. Its worktree may hold uncommitted work, dumped to ` +
        `\`~/.zstack/projects/<slug>/reports/uncommitted-${goneLane.ticket}.patch\` (re-apply with \`git apply\`) because ` +
        `releasing the lane lock leaves the worktree an orphan the next run's reconcile force-removes (other lanes continue).`,
    };
  }

  for (const lane of lanes) {
    if (!lane.outcome) continue;
    if (parkedByHuman.has(lane.ticket)) {
      return {
        kind: "stop-lane",
        ticket: lane.ticket,
        note: `A human moved #${lane.ticket} to ${byNumber.get(lane.ticket)!.status} during the run; stopping its lane cleanly at the ${lane.stage} boundary (other lanes continue).`,
      };
    }
    // Stage/status desync guard (#110, resync-on-lag #116, origin marker #125).
    // t.status is re-read from the live board each tick (ingestBoardItems),
    // while the advance resolveOutcome/merge-gate derives comes from lane.stage.
    // When the two disagree at a boundary, a single snapshot cannot prove WHY: a
    // human could have dragged the card back, or the loop's own prior advance
    // simply has not landed on the board yet (GitHub eventual consistency).
    // Distance alone cannot tell these apart at ONE hop (#116's blind spot,
    // #125): a reviewer lane reading QA is IDENTICAL whether the loop's own
    // Review write is still in flight or a human genuinely dragged Review->QA.
    // ORIGIN settles it: the loop records the status it wrote (lane.lastWroteStatus,
    // cleared by ingest the moment the board shows it land), so a one-hop-behind
    // read (isOneHopLag, incl. #124's advance->builder bounce lag) resyncs ONLY
    // when that marker still points at this lane's own stage status -- proof the
    // gap is the loop's own still-propagating write, not a human move the loop
    // never made. Resync corrects the ticket to the lane's
    // expected status and proceeds with the normal advance (no rebuild, no
    // re-run of QA that already passed). Everything else -- a further-back gap,
    // OR a one-hop gap with no in-flight write of ours (lastWroteStatus cleared/
    // absent = a genuine human move-back) -- keeps #110's safe stop-lane, honoring
    // the human's move instead of silently overriding it. #130 made Building ->
    // Review a legal, label-gated skip-QA walk, so the transition's own
    // illegality no longer backstops a lagged write (the qa-pass lane still
    // showing Building no longer throws on the Building->Review advance) -- so
    // THIS origin-marker guard, not LEGAL_TRANSITIONS, is now what protects the
    // lagged-write case, and every other lane's progress survives.
    const t = byNumber.get(lane.ticket);
    if (t && t.status !== STATUS_FOR_STAGE[lane.stage]) {
      if (
        isOneHopLag(lane, t.status) &&
        lane.lastWroteStatus === STATUS_FOR_STAGE[lane.stage]
      ) {
        resyncStatus.set(lane.ticket, STATUS_FOR_STAGE[lane.stage]);
      } else {
        return {
          kind: "stop-lane",
          ticket: lane.ticket,
          note: `#${lane.ticket}'s board status (${t.status}) disagrees with its ${lane.stage} stage (expected ${STATUS_FOR_STAGE[lane.stage]}); stopping its lane cleanly at the ${lane.stage} boundary so one desynced lane cannot abort the tick (other lanes continue).`,
        };
      }
    }
    // A PASSING review-approve (or a disabled gate) resolves to null here and
    // falls through to the merge gate below, exactly as before #62; a FAILING
    // approve is resolved right here, same as any other terminal outcome.
    const action = resolveOutcome(lane, qaLimits, reviewerGate, byNumber.get(lane.ticket)?.skipQa ?? false);
    if (action) return withResync(action, resyncStatus);
  }

  // 2. Merge gate: one merge at a time, dependency order across ready lanes.
  const midMerge = lanes.some((l) => l.stage === "merge" && l.outcome?.kind !== "merged");
  const mergeReady = lanes.filter((l) => l.outcome?.kind === "review-approve");
  if (mergeReady.length > 0 && !midMerge) {
    // #146: a mergeReady lane whose dependency already died on a PRIOR tick
    // (e.g. parked Blocked by the cycle park below) can never merge -- its dep
    // will never reach Done -- so it is caught here the SAME way step 4 below
    // catches a dead-dependency unclaimed ticket, same wording, BEFORE asking
    // for a merge order at all. This is what turns a two-lane cycle's park
    // (which only ever removes one lane per tick) into the whole cycle
    // eventually parking: the survivor's dependency-turned-Blocked shows up
    // here on its next tick instead of being read as "already merged" (the
    // out-of-set assumption mergeOrderProbe below makes for every OTHER dep).
    const deadMergeReady = mergeReady
      .map((l) => ({ ticket: l.ticket, dead: deadDeps(byNumber.get(l.ticket)!, byNumber) }))
      .filter((x) => x.dead.length > 0)
      .sort((a, b) => a.ticket - b.ticket);
    if (deadMergeReady.length > 0) {
      const { ticket, dead } = deadMergeReady[0];
      const states = dead.map((d) => `#${d} (${byNumber.get(d)!.status})`).join(", ");
      return { kind: "park", ticket, status: "Blocked", note: `Blocked by dependencies that cannot complete in this batch: ${states}.` };
    }
    const { order, stuck } = mergeOrderProbe(
      mergeReady.map((l) => ({ ticket: l.ticket, dependsOn: byNumber.get(l.ticket)?.dependsOn ?? [] }))
    );
    if (order.length === 0) {
      // A genuine dependency cycle among review-approved lanes (a planning
      // bug -- z-plan links deps both ways, but a bug can still produce one;
      // see PROCESS.md's park-with-a-comment-never-a-stall rule). Nothing in
      // the mergeReady set can resolve at all: park the lowest-numbered
      // member (same "break with the lowest" convention as step 6's deadlock
      // park below) naming every stuck ticket, not just its own dep, so the
      // note reads as the cause. Any lane the cycle doesn't reach resolved
      // into `order` above instead and merges normally this same tick.
      return { kind: "park", ticket: stuck[0], status: "Blocked", note: `Dependency cycle among review-approved lanes: #${stuck.join(", #")}. Parking to keep the rest of the drain moving.` };
    }
    // #178: the green gate, enforced HERE rather than in orchestrator prose.
    // Run 9's merge worker read a suite reporting 9 failures, called it green,
    // merged, and broke main (reverted in PR #158) -- so "is the suite green?"
    // is not the agent's call, and neither is "did anyone check?". A lane at
    // the front of the merge order with no verdict on it gets a merge-gate
    // action (repeated until a verdict lands, the same way check-worker repeats
    // until a probe lands); a red verdict parks it Blocked with the gate's own
    // note; only a green one reaches the advance below. There is no other edge
    // into the merge stage.
    const first = order[0];
    const firstLane = mergeReady.find((l) => l.ticket === first.ticket)!;
    const gate = firstLane.mergeGate;
    if (!gate) {
      // A gate that keeps starting and never finishing (its process killed
      // mid-gauntlet) must not spin the drain: refuse after MERGE_GATE_MAX_RUNS
      // silent attempts, fail-closed, with the cause named.
      if ((firstLane.mergeGateRuns ?? 0) >= MERGE_GATE_MAX_RUNS) {
        return {
          kind: "park",
          ticket: first.ticket,
          status: "Blocked",
          note: `merge gate started ${firstLane.mergeGateRuns} times and never returned a verdict (the gauntlet process was killed each time -- most often a command timeout shorter than the suite). Refusing the merge.`,
        };
      }
      return { kind: "merge-gate", ticket: first.ticket };
    }
    if (!gate.green) return { kind: "park", ticket: first.ticket, status: "Blocked", note: gate.note };
    // A green verdict vouches for one branch on ONE base. Every merge in this
    // run moves that base under every lane still waiting, so a stamp older than
    // the last merge is not permission any more -- it is a pre-parent gauntlet.
    // Re-gate instead of advancing; the fresh run drops the stale verdict
    // (recordMergeGate's null branch) and stamps the new base with its answer.
    // Terminates: the key only changes when a merge completes, and each merge
    // costs one re-gate per waiting lane.
    if ((firstLane.mergeGateBase ?? "") !== mergeGateBaseKey(state)) {
      return { kind: "merge-gate", ticket: first.ticket };
    }
    // #248: and a green verdict vouches for one BRANCH HEAD. The base check
    // above catches the base moving under a stamp; this catches the stamp's own
    // commit not being the code about to be merged -- a verdict measured on a
    // different worktree, or on a branch that has since taken a commit. Until
    // this read existed, `commit` was written by the gate and read by nobody,
    // so a green stamp for commit A authorized a merge of commit B and the only
    // thing standing in between was the merge prompt's prose telling the agent
    // to re-run the gate after resolving a conflict.
    //
    // A mismatch RE-GATES, the same shape the base check above uses, and for
    // the same reason: a branch that moved is a recoverable condition, and the
    // fresh gauntlet resolves it. Parking here instead would take out the whole
    // dependency CHAIN, not just this lane -- `deadMergeReady` above parks
    // every dependent of a Blocked ticket, so one recoverable mismatch at the
    // head of a stack ends the drain for everything behind it.
    //
    // It terminates because the CLI refuses to stamp a verdict measured on a
    // tree that is not this lane's own worktree (`isLaneBranch`). That was the
    // one producer that could hand back the same mismatching verdict forever;
    // with it gone, every re-gate measures the head the loop just observed, so
    // the sequence ends as soon as nothing is committing to the branch.
    //
    // The two UNPROVABLE arms below still park, because a re-gate cannot fix
    // either: a gate that could not read a head stamps `commit: undefined`
    // again, and a lane whose worktree cannot be read will not become readable
    // by running the gauntlet in it. Those are broken-checkout facts, not
    // moved-branch facts (PROCESS.md: park, never stall).
    if (laneHeads !== undefined) {
      const observed = laneHeads[first.ticket];
      const park = (why: string): Action => ({ kind: "park", ticket: first.ticket, status: "Blocked", note: `${why} Refusing the merge: a gate verdict that cannot be tied to the commit being merged is not a gate (#248).` });
      if (gate.commit === undefined) {
        return park(`The merge gate's green verdict for #${first.ticket} names no commit, so nothing proves it was measured on the code about to merge.`);
      }
      if (observed === undefined || observed === null) {
        return park(`The merge gate's green verdict for #${first.ticket} names commit ${gate.commit}, but the loop could not read a HEAD from that lane's worktree to compare it against.`);
      }
      if (observed !== gate.commit) {
        return { kind: "merge-gate", ticket: first.ticket };
      }
    }
    // A stacked parent is one merging concurrently OR already merged this run
    // (its branch survives until batch-end cleanup, so the child's PR still
    // needs the step-18 retarget).
    const mergedThisRun = new Set(state.mergedThisRun ?? []);
    const runParents = (byNumber.get(first.ticket)?.dependsOn ?? []).filter((d) => mergedThisRun.has(d));
    const stackedOn = [...new Set([...first.stackedOn, ...runParents])].sort((a, b) => a - b);
    return withResync({ kind: "advance", ticket: first.ticket, to: "merge", stackedOn }, resyncStatus);
  }

  // 3. Watchdog on silent lanes (an unresolved merge approval is not silent).
  for (const lane of lanes) {
    if (lane.outcome) continue;
    // 3a. The per-stage CEILING comes first, and it is checked for every lane
    //     whether or not that lane is currently silent (#256). A wedged worker
    //     that answers ALIVE is never silent by construction -- each probe resets
    //     the baseline -- so a ceiling evaluated only inside the expiry branch
    //     below would be unreachable on precisely the lanes it exists to end.
    //     Absent stageStartedMs (a pre-#256 state file) means no ceiling.
    const startedMs = lane.stageStartedMs;
    if (startedMs !== undefined && nowMs - startedMs > STAGE_CEILING_MINUTES * 60_000) {
      return stageCeilingAction(lane, nowMs - startedMs);
    }
    const wd = budgetFor(lane.stage);
    if (!watchdogExpired(lane, nowMs, wd)) continue;
    // A dead worker resolves to a merge-stage hold (H9), a clean stop when a
    // human already took the ticket off the board mid-run, a same-stage re-spawn
    // when its worktree still holds uncommitted work (#209), or the skip.
    if (lane.workerDead) return deadWorkerAction(lane, wd, parkedByHuman.has(lane.ticket));
    return { kind: "check-worker", ticket: lane.ticket };
  }

  // 4. A dependent whose dependency parked can never proceed in this batch.
  //    Batch-scoped (#131): a workable ticket outside the flagged allow-list is
  //    not this run's to work, so it is excluded here (never park-checked) and
  //    from the drain count below -- it waits for a future run.
  const inLane = new Set(lanes.map((l) => l.ticket));
  const inBatch = state.batchTickets ? new Set(state.batchTickets) : undefined;
  const unclaimed = tickets
    .filter((t) => isWorkableStatus(t.status) && !inLane.has(t.number) && !t.claimedByOther)
    .filter((t) => inBatch === undefined || inBatch.has(t.number))
    .sort((a, b) => a.number - b.number);
  for (const t of unclaimed) {
    const dead = deadDeps(t, byNumber);
    if (dead.length > 0) {
      const states = dead.map((d) => `#${d} (${byNumber.get(d)!.status})`).join(", ");
      return { kind: "park", ticket: t.number, status: "Blocked", note: `Blocked by dependencies that cannot complete in this batch: ${states}.` };
    }
  }

  // Context ceiling gate (#131): when the orchestrator's own live context
  // occupancy has reached the limit, stop CLAIMING new tickets. The claim step
  // is skipped (no new ticket enters Building) while steps 1-3 above keep
  // draining in-flight lanes to a terminal state. Off entirely at limit 0.
  const contextTokenLimit = state.contextTokenLimit ?? 0;
  const contextGated = contextTokenLimit > 0 && (state.contextTokens ?? 0) >= contextTokenLimit;

  // 5. Claim the next ticket into a free lane -- unless context-gated.
  const claimable = claimableTickets(tickets, lanes, state.batchTickets);
  if (!contextGated && claimable.length > 0 && lanes.length < maxLanes) {
    const t = claimable[0];
    return { kind: "claim", ticket: t.number, stage: claimStage(t.status) };
  }

  // 5b. Context ceiling reached, every lane idle, batch work still remaining:
  //     pause to clear-and-resume instead of falling through to a forever-wait
  //     (#131). A fresh orchestrator reads a small context on its first tick,
  //     so contextGated is false and claiming resumes on the SAME batch (the
  //     built tickets have left Ready; batchTickets persisted in state.json).
  //     If the batch happens to be fully drained here (unclaimed empty), the
  //     normal drain-complete below wins -- context-clear fires only when work
  //     genuinely remains. Only fires with lanes idle, so an in-flight lane is
  //     never cut short (AC6).
  if (contextGated && lanes.length === 0 && unclaimed.length > 0) {
    return { kind: "context-clear" };
  }

  // 6. Lanes idle, nothing claimable, work remains. Two very different cases hide
  //    here (issue #14 C7): a genuine in-batch deadlock (a dependency cycle, or a
  //    dep that can never complete in this batch) that MUST be broken by parking to
  //    avoid a token-burning spin; versus a dependent merely waiting on a dep that
  //    ANOTHER live session is still building (claimedByOther). The second will
  //    complete and re-ingest will unblock it, so it must WAIT, never park.
  //    Discriminator: at this point nothing in THIS batch can advance (no lanes, no
  //    claimable), so the only external progress possible is a claimedByOther dep.
  //    If any stuck ticket depends on one, wait; otherwise the stuck set is a real
  //    deadlock -- park the lowest to break it.
  if (lanes.length === 0 && claimable.length === 0 && unclaimed.length > 0) {
    const waitsOnOtherSession = unclaimed.some((t) =>
      t.dependsOn.some((d) => {
        const dep = byNumber.get(d);
        return dep !== undefined && dep.claimedByOther === true && dep.status !== "Done";
      })
    );
    if (waitsOnOtherSession) return { kind: "wait" };
    const t = unclaimed[0];
    return { kind: "park", ticket: t.number, status: "Blocked", note: `Dependency deadlock: depends on #${t.dependsOn.join(", #")} and no lane can make progress. Likely a dependency cycle in the batch.` };
  }

  // 7. Drained, or waiting on running lanes / other sessions' claims.
  if (lanes.length === 0 && unclaimed.length === 0) return { kind: "drain-complete" };
  return { kind: "wait" };
}

// Batch drained = every ticket terminal for this batch (Done / Questions /
// Blocked / Skipped) -- claimedByOther tickets belong to another session's
// batch -- and no lane still running. Batch-scoped (#131): when batchTickets
// is set, a workable ticket OUTSIDE the flagged allow-list is not this run's
// work and never keeps the run alive (AC4).
//
// #273: a lane whose ticket left the board (goneReason) still counts as running,
// and it does so through `lanes.length === 0` alone -- no separate clause, no
// way for the two to disagree. That is only true because ingestBoardItems KEEPS
// such a lane; the bug this replaced deleted it, and Step 7 could then fire and
// `git branch -D` the branch a still-live worker was committing to. The gate
// test in tests/loop.test.ts pins it so the retention cannot be undone silently.
export function drainComplete(tickets: TicketSnapshot[], lanes: LaneState[], batchTickets?: number[]): boolean {
  const inBatch = batchTickets ? new Set(batchTickets) : undefined;
  return (
    lanes.length === 0 &&
    tickets.every(
      (t) =>
        !isWorkableStatus(t.status) ||
        t.claimedByOther === true ||
        (inBatch !== undefined && !inBatch.has(t.number))
    )
  );
}

// -- human-needed safety control (issue #63) ----------------------------------

// Pure predicate: has the batch crossed the config threshold of tickets parked
// for human attention? percent <= 0 is the explicit "disable" knob
// (BoardConfig.humanNeededPercent, default 30). initialReady <= 0 can never
// trip: there is no meaningful percentage of a batch that committed nothing
// (also guards the division for a stale/pre-feature state file where
// initialReadyCount was never captured).
export function humanNeededTripped(
  blocked: number,
  skipped: number,
  questions: number,
  initialReady: number,
  percent: number
): boolean {
  if (percent <= 0 || initialReady <= 0) return false;
  return ((blocked + skipped + questions) / initialReady) * 100 > percent;
}

export interface HumanNeededStatus {
  tripped: boolean;
  alreadyNotified: boolean;
  blocked: number;
  skipped: number;
  questions: number;
  initialReadyCount: number;
  percent: number;
  tickets: { blocked: number[]; skipped: number[]; questions: number[] };
}

// The one place that turns a LoopState into the human-needed breakdown: counts
// + which tickets (the notify() payload), plus tripped/alreadyNotified so the
// orchestrator's fire-once check is a single field read, never prose
// bookkeeping. Read-only -- the CLI wraps this with no writes, same contract
// as `next`.
export function humanNeededStatus(state: LoopState): HumanNeededStatus {
  // #150: scope the numerator to this batch's own tickets (state.initialBatchTickets)
  // and never count a foreign claimedByOther park -- a pre-existing park from
  // before this batch started, or another session's parked ticket, was never
  // this batch's to begin with and must not inflate the trip against
  // initialReadyCount's denominator. undefined (a state file predating this
  // field) falls back to every ticket, the same graceful pre-feature decay
  // initialReadyCount's own <=0 guard already uses in humanNeededTripped.
  const batch = state.initialBatchTickets;
  const inBatch = (t: TicketSnapshot) => !t.claimedByOther && (batch === undefined || batch.includes(t.number));
  const byStatus = (s: BoardStatus) => state.tickets.filter((t) => t.status === s && inBatch(t));
  const blocked = byStatus("Blocked");
  const skipped = byStatus("Skipped");
  const questions = byStatus("Questions");
  const initialReadyCount = state.initialReadyCount ?? 0;
  const percent = state.humanNeededPercent ?? DEFAULT_HUMAN_NEEDED_PERCENT;
  return {
    tripped: humanNeededTripped(blocked.length, skipped.length, questions.length, initialReadyCount, percent),
    alreadyNotified: state.humanNeededNotified === true,
    blocked: blocked.length,
    skipped: skipped.length,
    questions: questions.length,
    initialReadyCount,
    percent,
    tickets: {
      blocked: blocked.map((t) => t.number),
      skipped: skipped.map((t) => t.number),
      questions: questions.map((t) => t.number),
    },
  };
}

// -- state reducers -----------------------------------------------------------

function findTicket(state: LoopState, n: number): TicketSnapshot {
  const t = state.tickets.find((x) => x.number === n);
  if (!t) throw new ZError(`Ticket #${n} is not in the loop state.`);
  return t;
}

function setStatus(t: TicketSnapshot, to: BoardStatus): void {
  if (!canTransition(t.status, to)) {
    throw new ZError(`Illegal status transition for #${t.number}: ${t.status} -> ${to}.`);
  }
  t.status = to;
}

function dropLane(state: LoopState, n: number): void {
  state.lanes = state.lanes.filter((l) => l.ticket !== n);
}

// Applies an Action to the loop state, returning the new state (pure -- input
// untouched). This mirrors on the state file exactly what the orchestrator
// does on the board/worktrees, so the two never drift by prose bookkeeping.
export function applyAction(state: LoopState, action: Action, nowMs: number): LoopState {
  const next = structuredClone(state);
  switch (action.kind) {
    case "claim": {
      const t = findTicket(next, action.ticket);
      setStatus(t, STATUS_FOR_STAGE[action.stage]);
      // #125: record the status we just wrote as the lane's origin marker (see
      // LaneState.lastWroteStatus); ingest clears it once the board shows it land.
      // #256: stageStartedMs is stamped alongside lastActivityMs at every stage
      // ENTRY (here, advance, respawn) and never again -- the heartbeat moves the
      // activity baseline, the ceiling needs one that does not move.
      next.lanes.push({ ticket: action.ticket, stage: action.stage, lastActivityMs: nowMs, stageStartedMs: nowMs, qaBounces: 0, reviewBounces: 0, lastWroteStatus: STATUS_FOR_STAGE[action.stage] });
      return next;
    }
    case "advance": {
      const lane = next.lanes.find((l) => l.ticket === action.ticket);
      if (!lane) throw new ZError(`No lane holds #${action.ticket} to advance.`);
      if (action.to === "builder" && lane.stage === "qa") lane.qaBounces += 1;
      if (action.to === "builder" && lane.stage === "reviewer") lane.reviewBounces += 1;
      // The two self-advances in the machine (#191's reviewer -> reviewer, #177's
      // builder -> builder) MUST each consume their counter here. Without these
      // lines quorumAction/commitRetryAction's `spent` never grows, so a project
      // whose sub-agent delivery is broken -- or a builder that keeps reporting
      // BUILT with nothing committed -- re-spawns the same stage forever: a paid
      // infinite loop, the exact thing the no-token-burn rule forbids.
      if (action.to === "reviewer" && lane.stage === "reviewer") lane.quorumRetries = (lane.quorumRetries ?? 0) + 1;
      if (action.to === "builder" && lane.stage === "builder") lane.commitRetries = (lane.commitRetries ?? 0) + 1;
      lane.stage = action.to;
      lane.lastActivityMs = nowMs;
      lane.stageStartedMs = nowMs; // #256: a new stage is a new ceiling
      delete lane.outcome;
      delete lane.workerDead;
      // #209: worktreeDirty describes ONE probe of ONE stage's leftovers, so it
      // dies with the stage it was read for -- same rule the respawn case and
      // recordProbe follow. Leaving it behind would let a builder-stage reading
      // vouch for a later QA-stage death the orchestrator never collected facts
      // for, buying a re-spawn the evidence does not support.
      delete lane.worktreeDirty;
      // #178: a green gate vouches for ONE commit. Advancing anywhere but into
      // the merge stage (a QA/review bounce back to the builder) means the code
      // is about to change, so the verdict and its attempt count are dropped and
      // the lane must be gated again before it can merge. The advance INTO merge
      // keeps its verdict as the audit trail of why the merge was allowed.
      if (action.to !== "merge") {
        delete lane.mergeGate;
        delete lane.mergeGateRuns;
        delete lane.mergeGateBase;
      }
      // #125: this advance writes STATUS_FOR_STAGE[to] below; record it as the
      // lane's origin marker so a lagged board write can be told from a human
      // move-back on the next tick (ingest clears it once the board shows it land).
      lane.lastWroteStatus = STATUS_FOR_STAGE[action.to];
      const t = findTicket(next, action.ticket);
      if (action.resyncStatus !== undefined) {
        // #116: nextAction's desync guard already established this ticket's
        // board read is one hop behind where the lane's own prior advance put
        // it (a lagged write, not a genuine move) -- write the correction
        // directly, bypassing canTransition (this is fixing a stale read, not
        // making a semantic move), so the real transition right below
        // validates from the corrected status instead of the stale one.
        t.status = action.resyncStatus;
      }
      setStatus(t, STATUS_FOR_STAGE[action.to]);
      return next;
    }
    // #209: same lane, same stage, fresh agent. The counter MUST be spent here or
    // deadWorkerAction's `spent` never grows and a lane whose environment keeps
    // killing workers re-spawns forever -- a paid infinite loop, the exact thing
    // the no-token-burn rule forbids. No board write and no lastWroteStatus touch:
    // the ticket already shows STATUS_FOR_STAGE[stage] (the lane never left it),
    // so inventing an in-flight write marker here would tell the next tick's
    // desync guard to resync a lag that does not exist.
    case "respawn": {
      const lane = next.lanes.find((l) => l.ticket === action.ticket);
      if (!lane) throw new ZError(`No lane holds #${action.ticket} to re-spawn.`);
      // The action names the stage it was computed for, and the budget spent is
      // the LANE's current one -- so a stale action (one built before some other
      // tick moved this lane) would spend the wrong stage's re-spawn and shift
      // the wrong stage's stageAttempt. That is the duplicate-spawn-tag class the
      // derivation header exists to prevent, so it throws rather than guessing.
      if (action.stage !== lane.stage) {
        throw new ZError(
          `Stale respawn for #${action.ticket}: the action was built for stage "${action.stage}" but the lane is now at "${lane.stage}". ` +
            `Re-run \`loop next\` and apply what it returns.`
        );
      }
      lane.respawns = { ...lane.respawns, [lane.stage]: respawnsAt(lane, lane.stage) + 1 };
      lane.lastActivityMs = nowMs;
      // #256: a re-spawn is a FRESH agent at the same stage, so it gets a fresh
      // ceiling. Bounded by MAX_DEAD_RESPAWNS (one per stage per lane), so this
      // cannot be used to extend a lane indefinitely -- and the predecessor it
      // replaces was dead on probe, not running long.
      lane.stageStartedMs = nowMs;
      delete lane.outcome;
      delete lane.workerDead;
      delete lane.worktreeDirty;
      return next;
    }
    case "park": {
      dropLane(next, action.ticket);
      setStatus(findTicket(next, action.ticket), action.status);
      return next;
    }
    case "skip": {
      dropLane(next, action.ticket);
      setStatus(findTicket(next, action.ticket), "Skipped");
      return next;
    }
    case "stop-lane": {
      // A human already set the board status; honor it, just drop our lane. No
      // setStatus (the ticket is not ours to move anymore).
      //
      // #273: when the action carries `dropTicket`, its TICKET has left the
      // loop's reach and the ticket in state is only the tombstone ingest kept so
      // the action could name the lane. It goes in the SAME write as the lane,
      // and only here -- that ordering is the whole fix. The reducer used to
      // delete the ticket at ingest and strand the lane; now the ticket leaves
      // state exactly when its worker and lock are torn down.
      //
      // Keyed off the ACTION, never off `lane.goneReason`: the SKILL hand-builds
      // a stop-lane of this kind itself (the `--if-present` moved:false row) for
      // a lane that never went through a marking ingest, and reading hidden lane
      // state left that path's ticket behind at a workable status -- so the next
      // `next` returned a `claim` for it and spawned a paid agent into a ticket
      // proved off the board.
      //
      // Leaving the tombstone is not survivable in the confirmed-gone case: the
      // board cannot re-observe that ticket, and once its lane is gone nothing
      // watches it, so it would carry forward through every later ingest forever.
      // (The unsupported-status case would in fact be swept by the next ingest's
      // `gone` filter, since the item is still in the read -- but the ticket must
      // still go HERE, in one write with the lane, or the state briefly says the
      // loop owns work it has already torn the worker down for.)
      //
      // #178: a lane dropped at the MERGE stage whose ticket the board already
      // shows Done landed its PR -- a human dragging the merging card to Done
      // mid-run is the reachable case (nextAction:1329's parkedByHuman
      // stop-lane). `complete` is the only other resolution that records into
      // `mergedThisRun`, so without this the base every OTHER lane's green
      // verdict is bound to never moves, and each of them keeps a pre-parent
      // gauntlet as live merge permission. Derived from state rather than
      // carried on the action on purpose: the SKILL hand-builds stop-lane rows,
      // and a fact a hand-builder can omit is a fact that will be omitted.
      const stopping = next.lanes.find((l) => l.ticket === action.ticket);
      const landed =
        stopping?.stage === "merge" && next.tickets.find((t) => t.number === action.ticket)?.status === "Done";
      dropLane(next, action.ticket);
      if (landed && !(next.mergedThisRun ?? []).includes(action.ticket)) {
        (next.mergedThisRun ??= []).push(action.ticket);
      }
      if (action.dropTicket) next.tickets = next.tickets.filter((t) => t.number !== action.ticket);
      return next;
    }
    case "complete": {
      dropLane(next, action.ticket);
      setStatus(findTicket(next, action.ticket), "Done");
      (next.mergedThisRun ??= []).push(action.ticket);
      return next;
    }
    case "check-worker":
    // #178: like check-worker, the state change is the side effect the
    // orchestrator's command performs (recordMergeGate via `loop merge-gate
    // --state`), not something the reducer can synthesize -- running a test
    // suite is not pure. Applying it is a no-op; the next `next` reads the
    // stamped verdict.
    case "merge-gate":
    case "wait":
    // #131: context-clear is a mid-batch PAUSE, not a state transition -- the
    // orchestrator releases the loop lock, keeps worktrees/branches and the
    // un-drained state.json, and exits WITHOUT the end-of-loop stage. A pure
    // no-op on state (like wait): batchTickets/lanes/tickets are untouched so
    // the re-invoked, context-cleared orchestrator resumes the same batch.
    case "context-clear":
    case "drain-complete":
      return next;
  }
}

// Records a finished stage agent's final message on its lane (pure).
//
// #177: `git` is the lane worktree's own git facts, and a BUILT is checked against
// them right here -- where the marker becomes state -- so every builder is held to
// the same clean-tree + moved-HEAD contract instead of relying on the
// orchestrator to notice. Optional because only the builder stage has facts to
// check (the other three markers ignore it) and because a state file recorded
// before #177 must keep loading; the CLI below is what makes it non-optional for
// a real builder lane. resolveOutcome turns a failure into the retry/park.
export function recordOutcome(
  state: LoopState,
  ticket: number,
  finalMessage: string,
  nowMs: number,
  git?: BuilderCommitFacts
): LoopState {
  const next = structuredClone(state);
  const lane = next.lanes.find((l) => l.ticket === ticket);
  if (!lane) throw new ZError(`No lane holds #${ticket} to record an outcome on.`);
  const outcome = parseStageResult(lane.stage, finalMessage);
  if (outcome.kind === "built" && git) {
    const unverified = builtGuardFailure(git);
    if (unverified) outcome.unverified = unverified;
  }
  lane.outcome = outcome;
  lane.lastActivityMs = nowMs;
  return next;
}

// Records an aliveness probe: alive refreshes the watchdog baseline, dead marks
// the lane so the next nextAction() resolves it (pure).
//
// #209: `porcelain` is the lane worktree's own `git status --porcelain --branch`
// payload, collected by the orchestrator at probe time and judged here rather
// than in prose. It is what tells a worker that died holding finished work from
// one that died holding nothing -- the first buys a re-spawn, the second is the
// skip that has always happened. Optional, and its absence records no facts at
// all (byte-identical to pre-#209 behavior): unlike #177's BUILT verification,
// omitting it can only cost recovery, never let unverified work advance, and a
// lane whose worktree is already gone has no status to collect.
export function recordProbe(
  state: LoopState,
  ticket: number,
  alive: boolean,
  nowMs: number,
  porcelain?: string
): LoopState {
  const next = structuredClone(state);
  const lane = next.lanes.find((l) => l.ticket === ticket);
  if (!lane) throw new ZError(`No lane holds #${ticket} to probe.`);
  if (alive) {
    lane.lastActivityMs = nowMs;
    delete lane.workerDead;
    // The worktree reading only ever describes a DEAD worker's leftovers; a live
    // one is still writing, so a stale flag must not survive to its next probe.
    delete lane.worktreeDirty;
  } else {
    lane.workerDead = true;
    // Set it or clear it -- never leave the previous probe's reading standing.
    // The flag's contract is "the facts THIS probe collected", so a dead probe
    // that collected none must read as none: absent (-> skip), not whatever the
    // last probe happened to see. Otherwise one dirty reading vouches for every
    // later death on the lane, and `loop probe`'s own stdout line would report a
    // worktree it never opened.
    if (porcelain === undefined) delete lane.worktreeDirty;
    else lane.worktreeDirty = worktreeHoldsWork(porcelain);
  }
  return next;
}

// Records observed worker activity on a lane: the newest transcript append in its
// stage-spawn subtree, read at the tick boundary and handed in as a number (pure).
//
// MONOTONIC, and that is the safety property. `activityMs` only ever moves the
// baseline FORWARD, so:
//
//   * an observation older than the baseline (a stage that has written nothing
//     since it was claimed, a subtree whose newest record predates a re-spawn)
//     changes nothing, and the lane keeps its stage-start floor -- the pre-#256
//     stage-age behavior, which is the conservative direction;
//   * `undefined` -- every fail-open answer subtreeActivityMs can give -- is a
//     no-op for the same reason, so a missing session transcript or an unresolved
//     spawn tag can never park a healthy lane NOR silence the watchdog on a dead
//     one.
//
// The observation itself is a filesystem read, so it happens at the CLI edge (the
// `heartbeat` verb below) and the reducer only ever sees the number -- the same
// split as `nowMs`, and the reason the state machine stays free of `node:fs`.
export function recordActivity(state: LoopState, ticket: number, activityMs: number | undefined): LoopState {
  const next = structuredClone(state);
  const lane = next.lanes.find((l) => l.ticket === ticket);
  if (!lane) throw new ZError(`No lane holds #${ticket} to record activity on.`);
  if (activityMs !== undefined && Number.isFinite(activityMs) && activityMs > lane.lastActivityMs) {
    lane.lastActivityMs = activityMs;
  }
  return next;
}

// Records the loop-owned merge gate on a lane (#178, pure). `verdict === null`
// means an attempt is STARTING: bump the attempt count and drop any earlier
// verdict, so a gauntlet killed mid-run still leaves the evidence nextAction
// needs to stop retrying. A verdict object is the finished attempt's answer,
// green or red, and it is what unlocks (or refuses) the advance to merge.
export function recordMergeGate(state: LoopState, ticket: number, verdict: MergeGateVerdict | null, nowMs: number): LoopState {
  const next = structuredClone(state);
  const lane = next.lanes.find((l) => l.ticket === ticket);
  if (!lane) throw new ZError(`No lane holds #${ticket} to record a merge gate on.`);
  lane.lastActivityMs = nowMs;
  if (verdict === null) {
    lane.mergeGateRuns = (lane.mergeGateRuns ?? 0) + 1;
    // Load-bearing: the attempt now running may answer differently, so the
    // PREVIOUS verdict stops speaking the moment a new gauntlet starts. Without
    // it a lane re-gated after its base moved would keep the stale green while
    // the fresh run is in flight, and a tick landing in that window would read
    // the old permission -- exactly the hole the base check below closes.
    delete lane.mergeGate;
    delete lane.mergeGateBase;
  } else {
    lane.mergeGate = verdict;
    lane.mergeGateBase = mergeGateBaseKey(next);
    // An attempt that ANSWERED is not a silent one. MERGE_GATE_MAX_RUNS bounds
    // consecutive killed gauntlets only, so a lane legitimately re-gated once
    // per base move (see mergeGateBase) never trips the "started N times and
    // never returned a verdict" park on the strength of runs that did return.
    delete lane.mergeGateRuns;
  }
  return next;
}

// The merge base a gate verdict is about, as a comparable key. `mergedThisRun`
// is the whole of it: the loop merges onto one base branch, so the base moves
// exactly when some lane merges. Deliberately NOT "re-gate whenever the advance
// carries a non-empty `stackedOn`" -- a lane gated AFTER its parent merged
// keeps `stackedOn:[parent]` until it merges itself, so that rule never
// terminates. "The base moved since the stamp" both covers the reported case
// (stamped at t0, parent merges, stale green) and always makes progress.
export function mergeGateBaseKey(state: LoopState): string {
  return [...(state.mergedThisRun ?? [])].sort((a, b) => a - b).join(",");
}

// A lost z-board claim: another session owns the ticket; it leaves our batch.
export function markClaimLost(state: LoopState, ticket: number): LoopState {
  const next = structuredClone(state);
  findTicket(next, ticket).claimedByOther = true;
  return next;
}

// A safety-control acknowledgement (issue #63): the orchestrator calls this
// ONLY after notify() has actually delivered the mid-run breakdown, so the
// next tick's humanNeededStatus() reports alreadyNotified and the SKILL never
// re-fires for the same crossing.
export function markHumanNeededNotified(state: LoopState): LoopState {
  const next = structuredClone(state);
  next.humanNeededNotified = true;
  return next;
}

// -- board-snapshot ingest ----------------------------------------------------

// The shape z-board list --json emits (lib/board.ts BoardItem).
export interface BoardItemLike {
  number: number;
  title: string;
  fields: Record<string, string | number>;
  labels?: string[]; // #130: issue labels riding the snapshot (lib/board.ts BoardItem.labels)
}

// Splits a read into the items the loop's state machine can drive and the ones
// it cannot. A human may add columns to the board -- a staging queue, a triage
// lane -- and a status outside BOARD_STATUSES must never crash the loop; before
// this, one such ticket threw out of ingest and killed every tick (#226).
//
// An unknown status is a POSITIVE observation, not an absence, so it is
// evidence under #138's rule rather than an exception to it: the read proves
// the ticket sits somewhere the loop does not drive. That is why an ignored
// ticket is REMOVED from state rather than merely skipped -- skipping alone
// would leave #138's carry-forward holding the ticket's last known status
// forever, so a human moving a ticket out of Ready into their own column would
// leave the loop still seeing it as Ready and free to claim it.
//
// A missing Status field lands here too (rendered "(none)"): an item with no
// status is likewise not work the loop was handed.
export function partitionKnownStatus(items: BoardItemLike[]): {
  known: BoardItemLike[];
  ignored: { number: number; status: string }[];
  notes: string[];
} {
  const known: BoardItemLike[] = [];
  const ignored: { number: number; status: string }[] = [];
  for (const it of items) {
    const status = String(it.fields?.["Status"] ?? "");
    if (BOARD_STATUSES.includes(status as BoardStatus)) known.push(it);
    else ignored.push({ number: it.number, status });
  }
  const notes = ignored.map(
    (i) =>
      `#${i.number} sits in board status ${i.status ? JSON.stringify(i.status) : "(none)"}, which the loop does not drive ` +
      `(known: ${BOARD_STATUSES.join(", ")}); ignoring it for this run.`
  );
  return { known, ignored, notes };
}

// Builds/refreshes the ticket snapshot from z-board list output plus fetched
// issue bodies ({"<number>": "<body>"}), preserving lanes and claim-lost flags
// from the previous state. Pure: assembling a snapshot is a JSON transform,
// never prose work.
export function ingestBoardItems(
  prev: LoopState | null,
  items: BoardItemLike[],
  bodies: Record<string, string>,
  cfg?: {
    maxLanes?: number;
    watchdogMinutes?: number | StageWatchdogMinutes; // #256: scalar or per-stage
    maxQaPasses?: number;
    qaInvestigateAfter?: number;
    minReviewerConfidence?: number;
    reviewerBelowThresholdAction?: "block" | "retry" | "off";
    maxReviewBounces?: number;
    minSkepticQuorum?: number;
    humanNeededPercent?: number;
    ticketLimit?: number; // #131: cap used to compute batchTickets on a fresh batch
    contextTokens?: number; // #131: live orchestrator context reading, stored fresh
    contextTokenLimit?: number; // #131: context ceiling, captured once like the other knobs
  },
  // #138: one of the two inputs that remove a ticket (and its lane) from loop
  // state -- the other being an unknown board status (partitionKnownStatus
  // above). Each number here must have been PROVED absent by a single-ticket
  // lookup (lib/board.ts `item`); absence from `items` proves nothing and never
  // lands here. Default [] = no confirm pass ran, which degrades to pure
  // carry-forward.
  confirmedGone: number[] = []
): LoopState {
  const prevByNumber = new Map((prev?.tickets ?? []).map((t) => [t.number, t]));
  // Every caller is protected here, not just the CLI: a status the loop does
  // not drive can reach ingest from any read path.
  const { known, ignored } = partitionKnownStatus(items);
  const observed = known.map((it) => {
    const status = it.fields["Status"] as BoardStatus;
    const t: TicketSnapshot = {
      number: it.number,
      title: it.title,
      status,
      dependsOn: parseDependsOn(bodies[String(it.number)] ?? ""),
    };
    const model = it.fields["Model"];
    if (typeof model === "string" && model) t.model = model;
    const effort = it.fields["Model Effort"];
    if (typeof effort === "string" && effort) t.modelEffort = effort;
    if ((it.labels ?? []).includes(SKIP_QA_LABEL)) t.skipQa = true;
    if (prevByNumber.get(it.number)?.claimedByOther) t.claimedByOther = true;
    return t;
  });
  // #138 positive-evidence merge. A board read is a set of POSITIVE observations,
  // never a census: every read path here pages the GitHub API (`z-board snapshot`,
  // Step 3's per-status `list` loop, any future caller), and at THIS boundary a
  // page that came back short is indistinguishable from a ticket that was really
  // removed -- no shrink predicate, hold counter, or "believe the board or hold"
  // rule can recover ground truth from a non-observation. So a prev ticket absent
  // from `items` carries forward UNCHANGED and a present one updates, which makes
  // correctness independent of which read path fed this call. #127's
  // `items.length === 0` special case is gone with the same reasoning: an empty
  // read is simply the case where nothing was observed, and it now carries
  // everything forward through this one merge path (and returns a fresh clone,
  // never `prev` by reference). The old H14 lane drop -- a lane whose ticket
  // vanished from the read -- is likewise gone; the ONLY removal is
  // `confirmedGone`, a caller's positive proof from a single-ticket lookup --
  // joined by the tickets positively observed in a status the loop does not
  // drive, which is the same kind of evidence (see partitionKnownStatus).
  //
  // #273: the REASON each number is gone, not just the fact, because a gone
  // number that still holds a LANE cannot simply be deleted -- see lanedGone
  // below. The two sources are disjoint in practice (applyConfirmations only
  // looks up numbers ABSENT from `items`, and an ignored one is present by
  // definition), but an observed status is the newer evidence, so it wins.
  const goneReasons = new Map<number, NonNullable<LaneState["goneReason"]>>();
  for (const n of confirmedGone) goneReasons.set(n, { kind: "confirmed-gone" });
  for (const i of ignored) goneReasons.set(i.number, { kind: "unsupported-status", status: i.status });
  const gone = new Set(goneReasons.keys());
  // #273: a gone ticket that a lane is still working is NOT deleted here. Its
  // lane owns a live background agent, a lane lock and a worktree, and only the
  // stop-lane ACTION tears those down; deleting the ticket (and filtering the
  // lane, below) took the state machine's only handle on that lane away and left
  // every one of those resources behind. So the ticket stays as a minimal
  // TOMBSTONE -- the prev snapshot carried forward unchanged, deliberately not
  // refreshed even in the unsupported-status case where the item IS still in the
  // read (it is in `ignored`, not `observed`, and a status the loop does not
  // drive is not a status worth recording) -- purely so nextAction can name the
  // lane it is about to stop. applyAction's stop-lane drops the pair.
  const lanedGone = new Set((prev?.lanes ?? []).map((l) => l.ticket).filter((n) => gone.has(n)));
  const merged = new Map<number, TicketSnapshot>();
  for (const t of prev?.tickets ?? []) merged.set(t.number, structuredClone(t));
  for (const t of observed) merged.set(t.number, t);
  for (const n of gone) if (!lanedGone.has(n)) merged.delete(n);
  // A retained lane must always have a ticket: findTicket and every
  // `byNumber.get(lane.ticket)!` in this file assume it, and a lane whose ticket
  // was already missing from prev is exactly the orphan-lane crash (#138's H14)
  // that this retention would otherwise re-introduce. Synthesize the tombstone
  // from the lane itself, at the status the lane's own stage implies.
  for (const l of prev?.lanes ?? []) {
    if (!lanedGone.has(l.ticket) || merged.has(l.ticket)) continue;
    merged.set(l.ticket, {
      number: l.ticket,
      title: `#${l.ticket}`,
      status: STATUS_FOR_STAGE[l.stage],
      dependsOn: [],
    });
  }
  const tickets = [...merged.values()].sort((a, b) => a.number - b.number);
  // Deliberately built from the OBSERVED items only, not the merged set: this map
  // is what clears #125's origin marker, and applyAction sets a lane's ticket
  // status and its lastWroteStatus in the SAME write -- so a carried-forward
  // (unobserved) ticket always "matches" its own marker and would clear it with
  // no board evidence at all, silently disarming the desync guard.
  const statusByNumber = new Map(observed.map((t) => [t.number, t.status]));
  // #125: the moment the freshly-read board shows the status the loop last
  // wrote for a lane, that write has LANDED -- drop the origin marker. From
  // then on a one-hop-behind read for that lane is a genuine human move-back
  // (the desync guard's safe stop-lane), not a still-propagating write of ours
  // (resync). While the write lags (board != lastWroteStatus) the marker
  // survives so the guard still resyncs.
  //
  // #273: no lane is filtered out here any more. A lane whose ticket is `gone`
  // is MARKED instead (goneReason), which turns the removal into the stop-lane
  // action that actually performs the teardown, and keeps the lane visible to
  // drainComplete (lanes.length) until that action is applied -- so Step 7
  // cannot delete the branch a still-running worker is committing to.
  //
  // ONE mutable copy, then each marker cleared on its own evidence and returned
  // once. An earlier cut returned early from the revival branch, which silently
  // skipped the lastWroteStatus clear below that every other lane on the same
  // read gets -- leaving a revived lane carrying a stale "our write is still in
  // flight" marker, which is exactly what tells the next tick's desync guard to
  // resync a lag that does not exist instead of honoring a human's move-back.
  const lanes = (prev?.lanes ?? []).map((l) => {
    const next = { ...l };
    const reason = goneReasons.get(l.ticket);
    if (reason) {
      next.goneReason = reason;
      return next;
    }
    // A mark normally lives one tick -- ingest sets it, the next `next` returns
    // its stop, the apply drops it. It outlives that only when a run dies in
    // between and leaves it on disk. If the human then moves the ticket back
    // into a status the loop drives, THAT read is positive proof the lane is
    // workable again, so the stale mark is cleared. `statusByNumber` is the
    // OBSERVED set, deliberately, not the merged one: an absence still proves
    // nothing (#138), so a short page or a failed confirm lookup leaves a mark
    // that was once positively earned exactly where it is, and the stop stands.
    if (next.goneReason !== undefined && statusByNumber.has(l.ticket)) delete next.goneReason;
    if (next.lastWroteStatus !== undefined && statusByNumber.get(l.ticket) === next.lastWroteStatus) {
      delete next.lastWroteStatus;
    }
    return next;
  });

  // Safety control (issue #63): initialReadyCount/humanNeededNotified are
  // per-BATCH state, not a per-project setting, so they need a different
  // fallback chain than the knobs above -- a naive "preserve whenever prev is
  // non-null" would carry a FIRST run's drained, terminal-status prev (and its
  // stale counters) into a second /z-loop invocation, since state.json is
  // never deleted between runs. drainComplete alone is NOT a sufficient reset
  // boundary, though: applyAction updates a terminal ticket's status and drops
  // its lane in the SAME state write, so the tick that resolves a batch's
  // LAST ticket already leaves `prev` drainComplete -- and the very next
  // ingest (the confirmation tick that just re-observes that same finished
  // batch, nothing new committed) would wrongly read as "fresh", wiping
  // initialReadyCount/humanNeededNotified for a crossing that just happened on
  // that final ticket. mergedThisRun (issue #119) is per-batch state for the
  // same reason -- it feeds the merge gate's stacked-parent check (line ~444),
  // and a stale entry from a batch that finished loops ago points a new
  // ticket's PR at a parent branch that no longer exists -- so it resets on
  // the same startingFreshBatch boundary as the other two. #133 defers the
  // board move to claim time: the committed queue now sits in READY until each
  // ticket is claimed (the old batch-commit step that moved the whole batch to
  // Building up front is gone), so ingest-time-zero -- Step 3's ingest, before
  // Step 4 claims anything -- sees every committed ticket still Ready. A drained
  // prev has, by definition, zero unclaimed Ready tickets belonging to THIS
  // batch (drainComplete treats Ready as workable, so an own unclaimed Ready
  // ticket means the batch is NOT drained; a Ready ticket may only linger past
  // drain when claimedByOther -- it belongs to another session's batch, not
  // this one); so a fresh batch is when there is no prior state at all, OR the
  // prior state was fully drained AND the incoming snapshot actually shows new,
  // UNCLAIMED Ready tickets (the committed queue lands in Ready before its first
  // ingest, so "any unclaimed Ready ticket in a post-drain snapshot" IS "a new
  // batch was just committed"). readyCount must exclude claimedByOther for the
  // same reason every other workable-for-this-batch check in this file does
  // (nextAction's unclaimed filter, the deadlock discriminator, drainComplete
  // itself) -- otherwise a lingering foreign Ready ticket in the snapshot
  // masquerades as a new batch on the very re-ingest that should be preserving
  // this batch's counters. A drained prev whose incoming snapshot has no new
  // unclaimed Ready tickets is the SAME batch's final state, not a new one
  // -- preserve its counters.
  const readyCount = tickets.filter((t) => t.status === "Ready" && !t.claimedByOther).length;
  // #150: a ticket belongs to a freshly-captured batch when it is absent from
  // the PRIOR state entirely (brand new -- covers a Step-1 pre-commit park
  // straight to Questions/Blocked/Skipped, #133 AC4) or currently Ready-and-
  // unclaimed (the committed queue, same filter as readyCount above). This is
  // the predicate, not yet gated on startingFreshBatch -- applied below only
  // when a fresh batch is actually starting.
  //
  // #203: "absent from the prior state" only means something when a prior state
  // EXISTS. With prev === null there is nothing to be absent from, so that
  // clause matched every ticket on the board -- every pre-existing Blocked/
  // Skipped/Questions park included -- and humanNeededStatus's numerator became
  // board-wide, tripping the gate at tick zero on a project's first run or any
  // run after a state archive/reset (measured: 174 numbers captured against a
  // real batch of 1). At ingest-time-zero with no prior state the batch IS the
  // committed queue by definition, so only the Ready-and-unclaimed clause can
  // apply. The cost is deliberate and one-sided: on a first run a Step-1 park is
  // not counted, because it is indistinguishable from a park that predates the
  // run; every later run has a prev and keeps #133 AC4 exactly as it was.
  const isNewBatchTicket = (t: TicketSnapshot) =>
    (prev != null && !prevByNumber.has(t.number)) || (t.status === "Ready" && !t.claimedByOther);
  // Whether the PRIOR batch drained is judged against ITS OWN allow-list (#131):
  // a leftover non-batch Ready ticket must not make prev look un-drained and so
  // block the next batch's capture (AC4/AC11 use the same batch scoping).
  //
  // #131 review-bounce (finding 1/2): under a ticket cap the batch-scoped
  // drainComplete becomes true the instant the FLAGGED tickets finish, while the
  // deliberately-excluded leftover Ready tickets keep readyCount > 0. Left alone
  // that combination re-fires startingFreshBatch on the very next per-tick
  // ingest, which (a) recomputes batchTickets -- and z-loop-tick passes no
  // --ticket-limit, so selectBatch(.., 0) returns undefined, DROPPING the
  // allow-list and draining the whole queue in one invocation -- and (b) wipes
  // mergedThisRun/initialReadyCount/humanNeededNotified mid-run (finding 2). The
  // capped run must instead drain EXACTLY its batch, then return drain-complete
  // so the operator re-invokes /z-loop for the next batch. The distinguishing
  // signal: a NEW capped batch is captured only when --ticket-limit is explicitly
  // on the ingest (Step 3, the start of an invocation, ALWAYS passes it), never
  // on a bare per-tick z-loop-tick ingest (which never does). So once a batch is
  // active (prev.batchTickets defined), a fresh batch starts only on a
  // --ticket-limit-bearing ingest; without the cap (prev.batchTickets undefined)
  // this is byte-identical to pre-#131. (A context-clear resume's Step 3 ingest
  // DOES carry --ticket-limit, but its prev batch is un-drained, so
  // drainComplete is false and batchTickets is preserved anyway -- AC11.)
  const priorBatchActive = prev?.batchTickets !== undefined;
  const ticketLimitProvided = cfg?.ticketLimit !== undefined;
  const startingFreshBatch =
    !prev ||
    (drainComplete(prev.tickets, prev.lanes, prev.batchTickets) &&
      readyCount > 0 &&
      (!priorBatchActive || ticketLimitProvided));

  return {
    tickets,
    lanes: structuredClone(lanes),
    maxLanes: cfg?.maxLanes ?? prev?.maxLanes ?? DEFAULT_MAX_LANES,
    // #256: the per-stage TABLE is the last-resort default, not the scalar, so a
    // state built with no config flag at all still gets the four derived budgets.
    // Same cfg -> preserved-from-prev -> default chain as every knob beside it.
    watchdogMinutes: cfg?.watchdogMinutes ?? prev?.watchdogMinutes ?? { ...DEFAULT_STAGE_WATCHDOG_MINUTES },
    maxQaPasses: cfg?.maxQaPasses ?? prev?.maxQaPasses ?? DEFAULT_MAX_QA_PASSES,
    qaInvestigateAfter: cfg?.qaInvestigateAfter ?? prev?.qaInvestigateAfter ?? DEFAULT_QA_INVESTIGATE_AFTER,
    minReviewerConfidence: cfg?.minReviewerConfidence ?? prev?.minReviewerConfidence ?? DEFAULT_MIN_REVIEWER_CONFIDENCE,
    reviewerBelowThresholdAction:
      cfg?.reviewerBelowThresholdAction ?? prev?.reviewerBelowThresholdAction ?? DEFAULT_REVIEWER_BELOW_THRESHOLD_ACTION,
    maxReviewBounces: cfg?.maxReviewBounces ?? prev?.maxReviewBounces ?? DEFAULT_MAX_REVIEW_BOUNCES,
    minSkepticQuorum: cfg?.minSkepticQuorum ?? prev?.minSkepticQuorum ?? DEFAULT_MIN_SKEPTIC_QUORUM,
    humanNeededPercent: cfg?.humanNeededPercent ?? prev?.humanNeededPercent ?? DEFAULT_HUMAN_NEEDED_PERCENT,
    mergedThisRun: startingFreshBatch ? [] : [...(prev?.mergedThisRun ?? [])],
    initialReadyCount: startingFreshBatch ? readyCount : (prev!.initialReadyCount ?? 0),
    // #150: captured ONCE at the same fresh-batch boundary as initialReadyCount
    // and preserved verbatim across every re-ingest -- humanNeededStatus's
    // numerator scope for the life of this batch.
    // structuredClone on the preserved arms (here and batchTickets below): the
    // returned state must never alias `prev`'s arrays, or a caller mutating the
    // ingest result silently rewrites the state it was merged from (#138 AC1).
    initialBatchTickets: startingFreshBatch
      ? tickets.filter(isNewBatchTicket).map((t) => t.number)
      : structuredClone(prev!.initialBatchTickets),
    humanNeededNotified: startingFreshBatch ? false : (prev!.humanNeededNotified ?? false),
    // #131: the flagged allow-list is captured ONCE at the fresh-batch boundary
    // (same as initialReadyCount) and preserved verbatim across every re-ingest
    // and context clear -- so a resume continues the same batch. #138 adds the
    // one subtraction: a ticket PROVED gone is not a member of any batch, and
    // leaving it here would put it back on the confirm pass's target list every
    // tick for the rest of the drain -- one lookup and one log line each, forever.
    // (initialBatchTickets stays verbatim: it scopes humanNeededStatus's
    // numerator over tickets that still exist, so a removed number cannot
    // contribute to it and shrinking it would only muddy that capture-once
    // contract.) The list still never GROWS or re-selects, which is what #131 and
    // #157 protect.
    batchTickets: startingFreshBatch
      ? selectBatch(tickets, cfg?.ticketLimit ?? DEFAULT_TICKET_LIMIT)
      : prev!.batchTickets?.filter((n) => !gone.has(n)),
    // contextTokens is a LIVE per-tick reading -- always taken fresh from cfg,
    // never preserved from prev (an unresolvable/absent reading degrades to 0,
    // which never gates). contextTokenLimit is captured once like the knobs.
    contextTokens: cfg?.contextTokens ?? 0,
    contextTokenLimit: cfg?.contextTokenLimit ?? prev?.contextTokenLimit ?? DEFAULT_CONTEXT_TOKEN_LIMIT,
  };
}

// -- merge gate (#178) --------------------------------------------------------

// Why this exists: run 9's merge worker for #132 read a suite that reported
// 9 failing tests, decided in prose that it was green, and merged -- main went
// red and had to be reverted (PR #158). "Is the suite green?" is deterministic
// space, so the loop owns it: the gate runs the gauntlet itself and judges by
// the summary fail-count + the process exit code. The merge agent never gets a
// vote; it runs `gh pr merge` only after this returns green.
//
// The verdict is STAMPED on the lane (LaneState.mergeGate) and nextAction's
// merge step reads it, so "did anyone actually run the gate?" is not a prose
// question either: with no green stamp there is no advance to the merge stage,
// hence no merge agent, hence no `gh pr merge`.

// One gauntlet attempt in a merge worktree: `bun run test` then
// `bun run typecheck`.
export interface SuiteRun {
  exitCode: number; // the first nonzero of the two commands (0 = both clean)
  output: string; // their combined stdout+stderr
}

// Which of the gauntlet's two commands the merge worktree actually defines.
// Pinning both by name made every lane on a repo without a `typecheck` script
// park Blocked forever: `bun run typecheck` on a missing script exits 1 with
// `Script not found`, and red is unbypassable by design. Detection here is the
// same `HAS()` rule the end-of-loop regression pass already uses (SKILL.md Step
// 7a, "never assumed") -- a provably-absent script is skipped, never run and
// never counted red. What it is NOT is a bypass: skipping needs proof of
// absence from `package.json`, and with neither script defined there is no gate
// left to run, so the gate refuses.
export interface GateScripts {
  test: boolean;
  typecheck: boolean;
  // Whether that `test` script actually drives BUN'S OWN test runner. The gate
  // spawns `bun run test` (the script the repo defines), not the `bun test`
  // builtin, so on a jest/vitest/go-through-npm repo the output carries no bun
  // banner and no ` N fail` summary at all. Demanding them there is not
  // fail-closed, it is a permanent false red -- exit 0 with no banner would
  // park every lane on such a repo Blocked forever, the same shape as the
  // `typecheck`-not-defined bug this detection already fixed once. So the
  // bun-summary reads below are conditioned on positive evidence from the
  // manifest that bun's runner is what runs; anywhere else the script's exit
  // code is the repo's own verdict and the gate takes it at that.
  bunTest: boolean;
}

// All true is the fail-closed default: a caller that cannot say what exists
// gets the full gauntlet AND the full bun-summary reading, not a skip.
export const ALL_GATE_SCRIPTS: GateScripts = { test: true, typecheck: true, bunTest: true };

// `bun test` as the command a `test` script runs -- at the start of the script
// or after a shell separator, so `bunx jest` and `echo "bun test"` do not match
// while `cross-env CI=1 bun test` and `bun test && tsc` do.
const BUN_TEST_SCRIPT = /(?:^|[\s;&|(])bun\s+(?:-\S+\s+|--\S+\s+)*test(?:\s|$)/;

// `bun run <name>` as a HOP to another entry in the same `scripts` block. The
// literal match above sees only the first command; a skeptic drove three
// byte-identical fixtures through the shipped CLI and got the whole point of
// this gate reversed by the script string alone:
//
//   {"test":"bun test"}                                 -> exit 1, red
//   {"test":"bun run inner","inner":"bun test"}         -> exit 0, GREEN
//   {"test":"bun run test:unit","test:unit":"bun test"} -> exit 0, GREEN
//
// The two indirect fixtures print `bun test v1.3.14` and `(fail) really
// broken` and still read green, because `bunTest:false` switched off all three
// anti-#132 guards at once (the banner count, the fail count, and the
// started-vs-finished check). That is #132's exact shape with merge permission
// attached. Every `bun run <name>` in the script is followed, not just a lone
// one, because `"bun run test:unit && bun run test:e2e"` is the shape that
// measured `bunTest:false` while running bun's runner in both limbs.
const BUN_RUN_REF = /(?:^|[\s;&|(])bun\s+run\s+(?:-\S+\s+|--\S+\s+)*([^\s;&|()]+)/g;

// Does this script reach bun's own test runner, directly or through `bun run`
// hops within the same `scripts` block? `seen` is the cycle guard: a manifest
// may name itself (`{"test":"bun run test"}`) or ring, and a gate that hangs
// on a hand-edited package.json is a stalled drain.
function reachesBunTest(script: string, scripts: Record<string, string>, seen: Set<string>): boolean {
  if (BUN_TEST_SCRIPT.test(script)) return true;
  for (const m of script.matchAll(BUN_RUN_REF)) {
    const name = m[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    const next = scripts[name];
    if (typeof next === "string" && reachesBunTest(next, scripts, seen)) return true;
  }
  return false;
}

// `package.json`'s `scripts` as the gate reads it. Unreadable, unparseable, or
// absent all mean "no scripts proven present", which the gate turns into a
// refusal rather than a skip -- exactly the reading a Go checkout gets.
export function detectGateScripts(packageJsonText: string | null): GateScripts {
  let scripts: unknown;
  try {
    scripts = packageJsonText === null ? undefined : (JSON.parse(packageJsonText) as { scripts?: unknown }).scripts;
  } catch {
    scripts = undefined;
  }
  const read = (name: string): string | null =>
    typeof scripts === "object" && scripts !== null && typeof (scripts as Record<string, unknown>)[name] === "string"
      ? ((scripts as Record<string, string>)[name] as string)
      : null;
  const test = read("test");
  const table: Record<string, string> =
    typeof scripts === "object" && scripts !== null
      ? Object.fromEntries(Object.entries(scripts as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"))
      : {};
  return {
    test: test !== null,
    typecheck: read("typecheck") !== null,
    bunTest: test !== null && reachesBunTest(test, table, new Set(["test"])),
  };
}

export function readGateScripts(worktree: string): GateScripts {
  try {
    return detectGateScripts(readFileSync(join(worktree, "package.json"), "utf8"));
  } catch {
    return detectGateScripts(null);
  }
}

export interface MergeGateVerdict {
  green: boolean;
  attempts: number; // 1 or 2 -- exactly one retry is allowed, for contention
  failCount: number | null; // summary fail-count of the deciding run (null = no summary line)
  note: string; // one line; goes verbatim into the lane's BLOCKED note
  // The worktree HEAD this verdict vouches for, and the whole of what it
  // vouches for. A gate result is only ever about ONE commit, so nextAction's
  // merge step compares this against the sha it OBSERVES on the lane's own
  // worktree and refuses when they differ (#248) -- without that read this
  // field was written and never read, and a green stamp taken on commit A
  // authorized a merge of commit B.
  //
  // Optional on the type because the pure `mergeGate()` never shells git; the
  // `merge-gate` CLI is what fills it. A verdict that reaches the merge
  // decision WITHOUT one is refused there rather than waved through: an
  // unbindable verdict is exactly the thing #248 says is not a gate.
  commit?: string;
}

// The one contention retry's wait. Long enough for another lane's suite/tsc to
// release a file lock (the only nonzero-with-no-failures case seen on Windows),
// short enough that a genuinely broken branch is refused within ~30s.
export const MERGE_GATE_RETRY_WAIT_MS = 15_000;

// How many times the loop starts the gate for one lane before refusing the
// merge outright. Only a run that dies WITHOUT stamping a verdict (its process
// killed mid-gauntlet) consumes an attempt -- a run that answers, green or red,
// ends the sequence -- so two covers "the first call was killed, the second had
// a long enough timeout" and nothing more.
export const MERGE_GATE_MAX_RUNS = 2;

// The whole gate's wall-clock budget, enforced HERE rather than left to the
// SKILL's prose "give this Bash call a 600000 timeout". Measured on this repo:
// `bun test` 233.6s + `tsc --noEmit` ~1s, so a contention retry is
// 2 x ~235s + 15s ~= 8.1 min against the tool's 10-minute maximum -- too thin
// to leave to a number written in a table. It is a BUDGET, not a per-attempt
// cap: attempt 1 gets the whole of it (2.4x the measured suite) rather than
// half, because a per-attempt half-cap (262s at the old 540s budget) would KILL
// a merely slow-but-green suite, which is the far commoner event than a suite
// that runs past the budget entirely.
//
// 570s, not 540s: the retry's allowance is whatever attempt 1 leaves, so every
// second the budget does not have is a second taken off the retry. At 540s a
// 265s attempt 1 -- routine under load -- left the retry 260s, which is under
// the 238.9s a loaded run of this suite was measured at, with no margin.
// 570s leaves the 600000 ms Bash cap 30s of headroom (the gate's own work
// outside the two spawns is a package.json read, a `git rev-parse` and one
// atomic write, well under a second) and hands that whole 30s to the retry.
export const MERGE_GATE_BUDGET_MS = 570_000;

// bun wraps its summary lines in SGR escapes whenever the ambient environment
// asks for color (a parent tool exporting FORCE_COLOR is enough), and
// `\x1b[0m\x1b[2m 0 fail\x1b[0m` matches none of the line anchors below -- a
// GREEN suite would read red, burn both retries, and park the lane. runGauntlet
// pins the color env off at the source; every parse here strips escapes anyway,
// so the gate's reading is a property of the parse rather than an accident of
// whoever launched the orchestrator.
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE, "");
}

// A `bun test` run brackets itself in its own output: one `bun test v<version>`
// banner when it starts, one `Ran N tests across M files.` when it finishes.
// Counting both is how the gate knows WHOSE summary it is reading. A test that
// shells a nested `bun test` with inherited stdio writes that run's banner AND
// summary into this same stream, so "there is a ` 0 fail` line here" proves
// nothing on its own -- and when the outer run then dies without printing its
// own (a `process.exit(0)` inside a test), the only summary left is the nested
// run's: exit 0, ` 0 fail`, and a real failing test on disk. That is exactly
// #132's "the suite did not run" wearing somebody else's verdict. Equal counts
// mean every run in the stream reported, and parseSuiteFailCount's MAX then
// speaks for all of them.
export function countSuiteRuns(output: string): { started: number; finished: number } {
  const clean = stripAnsi(output);
  return {
    started: (clean.match(/^bun test v/gm) ?? []).length,
    finished: (clean.match(/^Ran \d+ tests? across \d+ files?\./gm) ?? []).length,
  };
}

// The banner count alone cannot answer "is this even a bun project?": `bun test`
// prints the banner BEFORE it goes looking for test files, so a checkout on some
// other runner still counts as one started run. Measured on a directory holding
// only `main.go`: `bun test v1.3.14 (0d9b296a)`, then this line, then exit 1.
// This is the line that actually says "nothing ran here". Anchored to the line
// start like every other parse, so a test that merely mentions the text in its
// own source or assertions can never be mistaken for bun saying it.
export function foundNoTestFiles(output: string): boolean {
  return /^error: 0 test files matching/m.test(stripAnsi(output));
}

// The fail-count off a `bun test` run, read ONLY from its summary line
// (`^ N fail`), never from per-test `(fail) name` lines or a literal like
// tests/e2e-check.test.ts's intentional `FAIL merge-order` self-test output
// (#128) -- those are prose about a nested run, not this run's verdict.
// MAX across summary lines, not last: a test that spawns a nested `bun test`
// can print a second (green) summary into the same stream, and the fail-closed
// reading is "any summary reporting failures is a failure".
//
// Anchored at BOTH ends. bun's summary line is the whole line and nothing else
// (measured: exactly ` 1 fail`, no trailing text, no count column). The tail
// anchor used to be `\b`, which matches any non-word character -- so a line
// like `  3 fail-safe checks skipped` or `12 fail: legacy counter` read as a
// summary, the MAX took it, and a suite whose real summary is ` 0 fail` at exit
// 0 went RED. The retry reproduces the same output, so that lane parks Blocked
// with no way past it: the same "every lane Blocked forever" failure the
// absent-script rule exists to kill, relocated into the parse. MAX is
// fail-closed against a MISSED summary, not against a phantom one, so this
// parse has to be exact in both directions.
export function parseSuiteFailCount(output: string): number | null {
  const counts = [...stripAnsi(output).matchAll(/^[ \t]*(\d+)[ \t]+fail[ \t]*$/gm)].map((m) => Number(m[1]));
  return counts.length ? Math.max(...counts) : null;
}

// One attempt's verdict. Green demands, in order: no summary reporting
// failures, test files that bun actually found, exit 0, a `bun test` run that
// actually started, a summary line to read a count off, and as many runs
// finished as started (so that count is THIS run's verdict and not a nested
// run's). Anything else refuses the merge.
function judgeSuiteRun(run: SuiteRun, attempt: number, scripts: GateScripts = ALL_GATE_SCRIPTS): MergeGateVerdict {
  const failCount = parseSuiteFailCount(run.output);
  // No `test` script: `bun test` was never spawned, so there is no summary line,
  // no banner and no fail count to demand -- every check below would read the
  // absent suite as the "did not run" shape and refuse a repo the amended plan
  // says to gate on `bun run typecheck` alone. The exit code is the whole
  // verdict here, and `failCount: null` keeps the JSON honest about it.
  if (!scripts.test) {
    return run.exitCode === 0
      ? { green: true, attempts: attempt, failCount: null, note: `merge gate GREEN on attempt ${attempt}: exit 0 (typecheck only -- no \`test\` script in package.json)` }
      : {
          green: false,
          attempts: attempt,
          failCount: null,
          note: `merge gate RED on attempt ${attempt}: \`bun run typecheck\` exited ${run.exitCode} (no \`test\` script in package.json, so typecheck is the whole gate) -- refusing the merge`,
        };
  }
  const red = (why: string): MergeGateVerdict => ({ green: false, attempts: attempt, failCount, note: `${why} -- refusing the merge` });
  // A limb the manifest proves absent is SKIPPED, and every green verdict says
  // so. The amended Plan allows the skip; what makes it readable afterwards is
  // that the absence is documented rather than folded into a bare "green" --
  // an operator (or the next reviewer of a merge that went wrong) can tell a
  // gate that ran both commands from one that ran one. The `test`-absent case
  // carries its own wording above; only `typecheck` can be missing here.
  const skipped = scripts.typecheck ? "" : " (no `typecheck` script in package.json -- that limb was not run)";
  // Names which of the two it is instead of the blanket "the suite did not run"
  // or "gauntlet exited N": this gate shells `bun test` then `bun run
  // typecheck`, so a project on another runner runs no tests at all and every
  // one of its lanes would otherwise park Blocked on a note that reads like a
  // broken suite and never names the real cause.
  const notBun = (why: string): MergeGateVerdict =>
    red(
      `merge gate RED on attempt ${attempt}: exit ${run.exitCode} with no \`bun test\` run at all (${why}) -- the worktree's \`test\` script runs bun's own test runner, so either the suite never started or it died before reporting`
    );
  if (failCount !== null && failCount > 0) {
    return red(`merge gate RED on attempt ${attempt}: suite summary reports ${failCount} fail (exit ${run.exitCode})`);
  }
  // Ahead of the exit-code branch on purpose. `bun test` exits 1 when it finds
  // no test files, so judging by exit code first buried this case -- and the
  // message written for it -- under the generic "gauntlet exited 1 with no
  // test-summary line", leaving an operator on a non-bun checkout reading a
  // broken-suite note (QA finding 2). Only this signal jumps the queue, not a
  // missing banner: a run killed by contention BEFORE it printed anything is
  // also bannerless, and "gauntlet exited N" is the honest note for that one.
  // Guarded on failCount === null so the reordering can only ever change the
  // WORDING of an already-red verdict -- green demands a summary line, and this
  // branch requires there be none.
  if (failCount === null && foundNoTestFiles(run.output)) {
    return notBun("bun found 0 test files");
  }
  if (run.exitCode !== 0) {
    return red(`merge gate RED on attempt ${attempt}: gauntlet exited ${run.exitCode}${failCount === null ? " with no test-summary line" : " with 0 fail (typecheck or a crashed run)"}`);
  }
  // Everything below reads bun's own test-run bookkeeping, so it only applies
  // where bun's runner is what the `test` script runs. A jest/vitest/
  // pytest-through-npm suite prints none of it; its exit 0 IS the verdict, and
  // demanding a banner it never emits would refuse every green merge on that
  // repo forever. The two reads ABOVE stay unconditional because they are
  // fail-closed anywhere: `^N fail` and bun's `0 test files` line are bun-shaped
  // text that a foreign runner does not print, so on such a repo they never fire.
  const runs = countSuiteRuns(run.output);
  // "Is bun's runner what ran?" is answered by the OUTPUT first and the manifest
  // only second. detectGateScripts now follows `bun run <name>` hops, but static
  // resolution cannot see through every indirection a script can express (`npm
  // test`, a shell wrapper, a script that execs a generated command), and the
  // cost of guessing wrong is asymmetric: guessing "foreign" on a real bun run
  // hands exit 0 a free pass with all three anti-#132 guards off, which is the
  // refuted-AC1 hole. A banner in the stream is bun's own statement that its
  // runner started here, so it OVERRIDES the manifest reading. The reverse
  // mistake is harmless: a foreign runner that prints no banner still takes the
  // shortcut below and merges on its own exit code.
  if (!scripts.bunTest && runs.started === 0) {
    return {
      green: true,
      attempts: attempt,
      failCount,
      note: `merge gate GREEN on attempt ${attempt}: exit 0 (the worktree's \`test\` script is not \`bun test\`, so the scripts' own exit codes are the verdict)${skipped}`,
    };
  }
  if (runs.started === 0) {
    // Exit 0 with no banner: nothing bun ran produced this output. Fail-closed
    // in both directions -- a foreign runner that printed nothing parseable,
    // and one whose output happens to parse as `N fail`, are equally not a
    // verdict this gate may merge on.
    return notBun("no `bun test` banner in the output");
  }
  if (failCount === null) {
    return red(`merge gate RED on attempt ${attempt}: exit 0 but no "N fail" summary line -- the suite did not run`);
  }
  if (runs.started !== runs.finished) {
    return red(
      `merge gate RED on attempt ${attempt}: ${runs.started} \`bun test\` run(s) started in this output but only ${runs.finished} finished -- a run died without reporting (a \`process.exit\` inside a test), so the ${failCount} fail on the summary line is a different run's verdict, not this one's`
    );
  }
  return { green: true, attempts: attempt, failCount: 0, note: `merge gate GREEN on attempt ${attempt}: 0 fail, exit 0${skipped}` };
}

// The gate. `runAttempt` runs the gauntlet once in the merge worktree, within
// the wall-clock it is handed; `sleep` blocks between the two attempts; `now`
// is the clock the budget is measured on (all injected so the unit test feeds
// synthetic outputs, never waits, and can drive the budget deterministically).
//
// Retry policy: EXACTLY one, for ANY first attempt that is not green. It used
// to fire only for the "nonzero exit with no reported failures" shape, on the
// theory that contention is bannerless -- but measured on this repo contention
// does not present that way at all. It presents as TEST TIMEOUTS, which bun
// counts on the summary line (the full suite under load reports 2 fail, both
// `this test timed out after 5000ms`, where the same file alone reports 1), so
// every real contention case took the "summary reports failures" branch, got no
// retry, no 15s wait, and an immediate Blocked -- satisfying AC2 only for the
// synthetic bannerless fixture. Retrying everything does not weaken AC1: a
// genuine failure reproduces on the second run, and it is the SECOND run's
// count that decides.
export function mergeGate(
  runAttempt: (attempt: number, timeoutMs: number) => SuiteRun,
  sleep: (ms: number) => void,
  retryWaitMs: number = MERGE_GATE_RETRY_WAIT_MS,
  scripts: GateScripts = ALL_GATE_SCRIPTS,
  budgetMs: number = MERGE_GATE_BUDGET_MS,
  now: () => number = Date.now
): MergeGateVerdict {
  // Neither command defined: nothing to run, so nothing to vouch for. Refused
  // before the first attempt and never retried -- a missing script is a fact
  // about the checkout, not contention, and 15s does not make one appear.
  if (!scripts.test && !scripts.typecheck) {
    return {
      green: false,
      attempts: 0,
      failCount: null,
      note: "merge gate RED: the worktree's package.json defines neither a `test` nor a `typecheck` script (or has no readable package.json), so the gate has nothing to run -- refusing the merge",
    };
  }
  const startedAt = now();
  const left = (): number => Math.max(0, budgetMs - (now() - startedAt));
  const first = judgeSuiteRun(runAttempt(1, left()), 1, scripts);
  if (first.green) return first;
  // The retry is UNCONDITIONAL on a red attempt 1. It used to be skipped
  // whenever what was left could not fit a run as long as the first one took --
  // which, with the budget on one side and the retry wait on the other, made
  // "attempt 1 ran longer than (budget - 15s) / 2" cancel the one retry AC2
  // mandates. At the old 540s budget that cliff sat at 262.5s, under the 233.6s
  // this repo's own suite takes, and it fired on PR #178 itself: attempt 1
  // reported 3 timeout-shaped failures, got no retry, and the lane would have
  // parked Blocked on a branch that ran 0 fail in three separate runs. The
  // budget must never be able to cancel the retry, so the only thing that can
  // now stop it is the budget being physically GONE -- attempt 1 having eaten
  // all of it, which means attempt 1 was itself killed at the cap and there is
  // no wall clock left to run anything in. Reaching that on this repo takes an
  // attempt 1 of 555s, 2.4x the measured suite; anything short of it retries,
  // and a retry squeezed into the last seconds is still strictly better than
  // none -- it can only be killed, which is red, and attempt 1 was red already.
  if (left() <= retryWaitMs) {
    return { ...first, note: `${first.note} (no retry: attempt 1 consumed the gate's entire ${Math.round(budgetMs / 1000)}s budget, leaving no wall clock to run a second in)` };
  }
  sleep(retryWaitMs);
  return judgeSuiteRun(runAttempt(2, left()), 2, scripts);
}

// The real attempt: `bun run test` then, only if that is clean,
// `bun run typecheck` -- both in the merge worktree. process.execPath is this
// bun binary (no PATH lookup, which is what breaks the spawn on Windows).
//
// `bun run test`, NOT the `bun test` builtin. Pinning the builtin gated a
// command the repo never asked for: a worktree whose `test` script is
// `jest --ci`, or a chained `bun test && bun run lint`, had its real suite
// skipped, and bun's runner then found no files matching ITS patterns
// (`{"scripts":{"test":"jest"}} + __tests__/a.js` returned
// `{"green":false,"...bun found 0 test files"}`, exit 1, unbypassable) --
// parking every lane on that repo Blocked forever. Running the defined script
// is also what makes `bun test` mandatory-where-defined mean anything: on this
// repo the script IS `bun test`, so the summary reading is byte-identical.
//
// The environment is the caller's with color pinned OFF. Everything the gate
// decides is read off these bytes, and bun emits SGR-wrapped summary lines
// under FORCE_COLOR: without this the verdict would depend on whichever tool
// happened to launch the orchestrator (measured: a passing project reads
// `{"green":false,...,"failCount":null}` under FORCE_COLOR=1).
// Only the limbs `scripts` proves exist are spawned; mergeGate has already
// refused the both-absent case, so at least one always runs.
function runGauntlet(cwd: string, scripts: GateScripts = ALL_GATE_SCRIPTS, timeoutMs: number = MERGE_GATE_BUDGET_MS): SuiteRun {
  const dec = (b: unknown): string => (b instanceof Uint8Array ? new TextDecoder().decode(b) : "");
  const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
  const startedAt = Date.now();
  // A spawn killed by the timeout reports exitCode null + a signalCode; the
  // gate's whole contract is a NUMBER it can call nonzero, and it must never
  // read a kill as clean, so the kill normalises to 124 (timeout(1)'s code) and
  // says so in the output the verdict quotes.
  const run = (script: string, budget: number): { code: number; out: string } => {
    const p = Bun.spawnSync([process.execPath, "run", script], { cwd, stdout: "pipe", stderr: "pipe", env, timeout: Math.max(1, budget) });
    const out = dec(p.stdout) + dec(p.stderr);
    if (p.exitCode === 0) return { code: 0, out };
    if (p.exitCode === null || p.signalCode) {
      return { code: 124, out: `${out}\nmerge gate: \`bun run ${script}\` was killed after ${Math.round(budget / 1000)}s (the gate's wall-clock budget)\n` };
    }
    return { code: p.exitCode, out };
  };
  let testOut = "";
  if (scripts.test) {
    const t = run("test", timeoutMs);
    testOut = t.out;
    if (t.code !== 0) return { exitCode: t.code, output: testOut };
  }
  if (!scripts.typecheck) return { exitCode: 0, output: testOut };
  const tc = run("typecheck", timeoutMs - (Date.now() - startedAt));
  return { exitCode: tc.code, output: testOut + tc.out };
}

// The worktree's HEAD sha -- the verdict's `commit` when the gate stamps one,
// and the fact nextAction compares it against when the merge decision is made.
// `undefined` means git could not answer (no worktree, no git); both readers
// treat that as unprovable rather than fine, so it never silently passes.
function gitHead(cwd: string): string | undefined {
  const p = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) return undefined;
  return new TextDecoder().decode(p.stdout).trim() || undefined;
}

// #248: what `next` observed about each lane's branch this tick. `null` is a
// LOOKED-AND-COULD-NOT-READ, which the merge step refuses; a lane absent from
// the map was never looked at (it carries no verdict to bind).
export interface LaneHeadFacts {
  [ticket: number]: string | null | undefined;
}

// A lane's worktree, DERIVED from the ticket number rather than taken from
// anyone. z-loop/SKILL.md's claim row creates exactly this path
// (`git worktree add ".worktrees/ticket-<N>"`), so the loop can find a lane's
// code without an agent naming it -- which is the point: the last latent step
// between changed code and `gh pr merge` used to be "did the agent type the
// right path" into `merge-gate <worktreePath>`. It cannot be any more, because
// a verdict stamped from some other checkout carries that checkout's sha and
// fails the comparison above.
export function laneWorktreePath(ticket: number, root: string = process.cwd()): string {
  return join(root, ".worktrees", `ticket-${ticket}`);
}

// The worktree's checked-out branch, for the lane bind below. Same best-effort
// shape as gitHead: `undefined` when git cannot answer, which the caller treats
// as unprovable rather than fine.
function gitBranch(cwd: string): string | undefined {
  const p = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) return undefined;
  const b = new TextDecoder().decode(p.stdout).trim();
  return b && b !== "HEAD" ? b : undefined; // a detached checkout names no branch
}

// Is this the branch lane N's worktree is supposed to be on? z-loop/SKILL.md's
// claim row creates `z/ticket-<N>-<slug>`, and the slug is not knowable here,
// so the bind is on the ticket-numbered prefix -- which is the part that names
// the lane. `z/ticket-1-` never matches `z/ticket-12-x`, because the character
// after the number has to be the separator.
//
// Bound by BRANCH rather than by path on purpose. The obvious check is
// "`<worktreePath>` resolves to `.worktrees/ticket-<N>`", but that is relative
// to the process's cwd, and the merge prompt runs the gate's stamping form from
// INSIDE the worktree after resolving a conflict -- so a cwd-relative
// comparison would refuse the one re-gate that matters most. A branch name is
// the same fact read from somewhere that does not move.
export function isLaneBranch(branch: string, ticket: number): boolean {
  return branch === `z/ticket-${ticket}` || branch.startsWith(`z/ticket-${ticket}-`);
}

// Reads the branch head of every lane carrying a gate verdict. Only those: a
// lane with no stamp is re-gated by nextAction regardless, so spending a `git`
// spawn on it would buy nothing, and `next` runs on every tick of the drain.
// git, never gh -- lib/board.ts is the pack's sole gh caller (tests/board.test.ts
// pins it), and a branch head is a local fact that needs no API call.
export function observeLaneHeads(state: LoopState, root: string = process.cwd()): LaneHeadFacts {
  const facts: LaneHeadFacts = {};
  for (const lane of state.lanes ?? []) {
    if (!lane.mergeGate) continue;
    facts[lane.ticket] = gitHead(laneWorktreePath(lane.ticket, root)) ?? null;
  }
  return facts;
}

// -- #138 targeted confirm pass ----------------------------------------------
// Carry-forward alone is always SAFE (a ticket the loop no longer needs simply
// lingers), but on its own it is not complete: a ticket genuinely removed from
// the board mid-run would keep its lane forever. These two pure functions are
// the other half -- they turn "absent from a bulk read" into an actual
// observation by naming exactly which tickets are worth ONE single-ticket
// lookup each, and folding those lookups' answers back in. The IO between them
// (the lookups themselves) belongs to the caller; ingestBoardItems stays pure.

// The tickets whose absence from a read is worth confirming: the in-flight lanes
// (a stuck lane is the failure carry-forward alone would leave behind) and this
// batch's allow-list. Everything else on the board costs nothing to carry.
export function confirmTargets(prev: LoopState | null, items: BoardItemLike[]): number[] {
  if (!prev) return [];
  const present = new Set(items.map((it) => it.number));
  // #273: a lane already carrying a goneReason is awaiting its stop-lane, and a
  // lookup can prove nothing new about it -- it was marked BY a positive
  // observation. Spending one on it re-buys evidence already in hand, which is
  // the same "one lookup and one log line each" waste the batchTickets
  // subtraction below exists to prevent.
  const marked = new Set((prev.lanes ?? []).filter((l) => l.goneReason !== undefined).map((l) => l.ticket));
  const watched = new Set<number>([...(prev.lanes ?? []).map((l) => l.ticket), ...(prev.batchTickets ?? [])]);
  return [...watched].filter((n) => !present.has(n) && !marked.has(n)).sort((a, b) => a - b);
}

// One single-ticket lookup's answer (lib/board.ts `item` prints exactly this).
export interface ItemLookupResult {
  number: number;
  present: boolean;
  item?: BoardItemLike;
  body?: string;
  reason?: string;
}

// Folds confirm-pass lookups into a read: a ticket the lookup found is SPLICED
// into `items` (a positive observation beats carry-forward), a ticket the lookup
// positively could not find becomes `confirmedGone`. Anything else -- a lookup
// for a ticket the read already had, or a malformed present-but-itemless answer
// -- proves nothing, so it is dropped and that ticket just carries forward.
// `notes` are the log lines the caller prints; each states only what was proven.
export function applyConfirmations(
  items: BoardItemLike[],
  bodies: Record<string, string>,
  lookups: ItemLookupResult[]
): { items: BoardItemLike[]; bodies: Record<string, string>; confirmedGone: number[]; notes: string[] } {
  const present = new Set(items.map((it) => it.number));
  const out = { items: [...items], bodies: { ...bodies }, confirmedGone: [] as number[], notes: [] as string[] };
  for (const l of lookups ?? []) {
    if (typeof l?.number !== "number" || present.has(l.number)) continue;
    if (l.present && l.item) {
      out.items.push(l.item);
      out.bodies[String(l.number)] = l.body ?? "";
      present.add(l.number);
      out.notes.push(
        `read missed #${l.number}; single-ticket lookup confirms it is still on the board (Status: ${l.item.fields?.["Status"] ?? "?"}).`
      );
    } else if (!l.present) {
      out.confirmedGone.push(l.number);
      out.notes.push(
        // #273: this note used to end "releasing its lane", which was the prose
        // half of the defect -- ingest never released anything an orchestrator
        // could act on. A lane is only ever released by an applied stop-lane.
        `read missed #${l.number}; single-ticket lookup confirms it is gone from the board (${l.reason ?? "not-on-project"}); dropping it from state, and any lane still holding it is stopped by the next action.`
      );
    } else {
      out.notes.push(`read missed #${l.number}; its lookup answered nothing usable -- carrying it forward unchanged.`);
    }
  }
  return out;
}

// -- CLI ---------------------------------------------------------------------

const USAGE = `loop <command> [args]

  stage-model <builder|qa|reviewer|merge> <ticketModel> --slug <s>
                                                     print the resolved model name for that stage
                                                     (config stageModels override, else ticketModel)
  merge-gate <worktreePath> [--state <state.json> --ticket <N>] [--retry-wait-ms N] [--budget-ms N]
                                                     run the pre-merge gauntlet (bun test + typecheck, whichever
                                                     of the two that worktree's package.json defines; neither
                                                     defined is a refusal) and print the verdict JSON; exit 0 ONLY
                                                     when green (#178) -- nothing merges on a nonzero exit.
                                                     With --state/--ticket, stamps the verdict on that lane:
                                                     "next" will not advance a lane to merge without a green one
  next <state.json> [--now <ms>]                     print the next Action as JSON (no writes)
  apply <state.json> <action.json> [--now <ms>]      apply an Action, rewrite the state file
  outcome <state.json> <ticket> <msg.txt> [--now <ms>]  parse a stage's final message onto its lane
          a BUILDER lane also REQUIRES its worktree's git facts (#177), which a
          BUILT is verified against: --porcelain <file> (git status --porcelain
          --branch) --head-sha <sha> (git rev-parse HEAD) --base-sha <sha>
          (git merge-base <baseBranch> HEAD)
  probe <state.json> <ticket> <alive|dead> [--now <ms>] record an aliveness probe
          a DEAD probe should also carry the lane worktree's dirtiness (#209),
          which is what lets a stage that died holding finished work be re-spawned
          instead of skipped: --porcelain <file> (git status --porcelain --branch)
  attempt <state.json> <ticket>                      print the lane's 1-based spawn count for its CURRENT
                                                     stage -- the <attempt> for "transcripts tag" and the
                                                     <stage>-<attempt> transcript name. Read it AFTER apply.
  heartbeat <state.json> [--slug <s>] [--project-dir <d>] [--subagents-dir <d>] [--activity-ms <n> --ticket <N>]
                                                     observe every live lane's stage-spawn subtree and move its
                                                     watchdog baseline forward to the newest transcript append
                                                     (#256). Silence, not stage age. Fail-open: a lane whose
                                                     subtree cannot be resolved is left exactly as it was.
                                                     --activity-ms with --ticket skips the read and hands the
                                                     number straight to the reducer (tests, and a caller that
                                                     already has it).
  claim-lost <state.json> <ticket>                   mark a ticket claimed by another session
  human-needed <state.json>                          print the breakdown + tripped/alreadyNotified (no writes)
  human-needed-ack <state.json>                       mark the mid-run notification as sent (fire-once flag)
  confirm-targets <state.json> <items.json>          print the lane/batch tickets the read did NOT
                                                     show, one per line -- each worth one
                                                     \`z-board item <N>\` before the ingest (#138)
  ingest <state.json> <items.json> <bodies.json> [--lookups <F>] [--max-lanes N] [--watchdog-minutes M]
                      [--max-qa-passes N] [--qa-investigate-after N] [--human-needed-percent N]
                      [--min-reviewer-confidence N] [--reviewer-below-threshold-action block|retry|off]
                      [--max-review-bounces N] [--min-skeptic-quorum N] [--ticket-limit N]
                      [--context-token-limit N] [--context-tokens N]
                                                     build/refresh the snapshot (creates state.json)

  --now defaults to the wall clock; tests pass it explicitly.`;

// readJson / atomicWrite come from lib/cli.ts: atomicWrite's tmp+rename keeps a
// crash mid-write from leaving a truncated state.json for the next ingest to
// misread as corrupt.

// Reads the previous loop state for an ingest. ONLY a missing file (ENOENT) is a
// first ingest; a present-but-corrupt/truncated or wrong-shaped state.json is a
// loud error, never a silent null -- treating corruption as a first ingest would
// wipe live lanes and mergedThisRun (same discipline as lib/endloop.ts's
// readLoopCounter).
function readPrevState(path: string): LoopState | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new ZError(`Cannot read state at ${path}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ZError(
      `State file ${path} is present but not valid JSON (${(e as Error).message}). ` +
        `Refusing to treat a corrupt state as a first ingest -- that would silently reset lanes and mergedThisRun. Fix or delete it.`
    );
  }
  const s = parsed as any;
  if (typeof s !== "object" || s === null || !Array.isArray(s.tickets) || !Array.isArray(s.lanes)) {
    throw new ZError(
      `State file ${path} is present but is not a LoopState {tickets[], lanes[], ...}. ` +
        `Refusing to silently reset lanes and mergedThisRun.`
    );
  }
  return s as LoopState;
}

// The numeric ingest knobs, in one table: each is optional, and each reaches
// ingestBoardItems as a number or undefined. Adding a knob is one row here,
// not a read + a ternary + a call-site line.
const INGEST_NUMBERS = [
  "max-lanes",
  // watchdog-minutes is NOT here: since #256 it carries either a number or a
  // per-stage JSON object, and Number("{\"qa\":15}") is NaN. Parsed by
  // watchdogFromFlag below, which is the one place that tells the shapes apart.
  "max-qa-passes",
  "qa-investigate-after",
  "human-needed-percent",
  "min-reviewer-confidence",
  "max-review-bounces",
  "min-skeptic-quorum", // #191: skeptic-delivery floor for an adversarial approve (0 disables)
  "ticket-limit", // #131: per-loop ticket cap (0 = no cap); selects batchTickets on a fresh batch
  "context-token-limit", // #131: context ceiling (0 = disabled), captured once
  "context-tokens", // #131: live orchestrator context reading, threaded per tick by z-loop-tick
] as const;

// kebab-case CLI flag -> the camelCase key ingestBoardItems takes.
const camel = (flag: string): string => flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

// `--watchdog-minutes` in either accepted shape (#256): `25`, or the per-stage
// object `{"builder":25,"qa":15,"reviewer":40,"merge":15}` as one JSON argument.
// z-loop/SKILL.md Step 3 passes whatever `loadConfig` resolved, JSON-stringified,
// and compact JSON has no spaces -- so it survives the SKILL's `read -r` word
// splitting as a single token.
//
// The object is validated by the SAME function that validates it in config.json
// (validateWatchdogMinutes), so a typo'd stage rejects identically whether it
// arrived through a config file or a flag -- there is no second, looser path into
// the state file.
function watchdogFromFlag(raw: string | undefined): number | StageWatchdogMinutes | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    const n = Number(trimmed);
    validateWatchdogMinutes(n);
    return n;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    throw new ZError(
      `--watchdog-minutes looks like JSON but does not parse (${(e as Error).message}): ${JSON.stringify(raw)}. ` +
        `Pass a number for every stage, or {"builder":25,"qa":15,"reviewer":40,"merge":15}.`
    );
  }
  validateWatchdogMinutes(parsed);
  return parsed as StageWatchdogMinutes;
}

// An observed append can never have happened in the future, so a transcript
// timestamp ahead of the clock is clipped to it (#256).
//
// Not paranoia about a hostile file -- these stamps are written by the same
// machine's Claude Code, and the machine's clock moves: an NTP correction or a
// suspend/resume can leave a record dated ahead of `now`. Unclipped, that lands
// in lastActivityMs, `nowMs - lastActivityMs` goes NEGATIVE, and
// `watchdogExpired` is false until the wall clock catches up -- the watchdog
// silently OFF for that lane for the length of the skew, which is exactly the
// failure #256 exists to remove, reintroduced through its own fix.
//
// Clipped at the CLI edge rather than inside recordActivity for the same reason
// the read itself lives here: the reducer takes no clock, and giving it one to
// support this would put `nowMs` into a function whose whole contract is that it
// only ever sees numbers the caller already resolved.
function clampToNow(activityMs: number | undefined, nowMs: number): number | undefined {
  if (activityMs === undefined || !Number.isFinite(activityMs)) return undefined;
  return Math.min(activityMs, nowMs);
}

// readJson's contract for plain text: a missing/unreadable file at the CLI edge is
// an actionable usage failure (exit 1 with the path), not a rethrown stack.
function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new ZError(`Cannot read ${path}: ${(e as Error).message}`);
  }
}

// #177's fail-closed edge. A BUILDER lane may not record an outcome without its
// worktree's git facts: an optional check the orchestrator can simply omit is a
// check that silently is not there, which is the failure mode #177 filed (a BUILT
// with nothing committed walked to QA, and QA passed the base tree). Same
// reasoning as z-loop-tick's required --session (#198) -- it can only ever break
// loudly, on the first builder outcome of the run, with the commands to run.
// Every other stage has nothing to verify, so the flags are ignored there;
// `undefined` keeps recordOutcome's guard off for them.
function builderFactsFromFlags(
  state: LoopState,
  ticket: number,
  flags: ReturnType<typeof parseFlags>["flags"]
): BuilderCommitFacts | undefined {
  const lane = state.lanes?.find((l) => l.ticket === ticket);
  if (lane?.stage !== "builder") return undefined;
  const porcelain = str(flags, "porcelain");
  const headSha = str(flags, "head-sha");
  const baseSha = str(flags, "base-sha");
  if (porcelain === undefined || headSha === undefined || baseSha === undefined) {
    throw new ZError(
      `Recording a BUILDER outcome for #${ticket} requires the lane worktree's git facts (#177):\n` +
        `  git -C <worktree> status --porcelain --branch > "$TMP/porcelain-${ticket}.txt"\n` +
        `  loop outcome <state.json> ${ticket} <msg.txt> --porcelain "$TMP/porcelain-${ticket}.txt" \\\n` +
        `    --head-sha "$(git -C <worktree> rev-parse HEAD)" --base-sha "$(git -C <worktree> merge-base <baseBranch> HEAD)"\n` +
        `A BUILT is verified against them (clean tree + a commit of its own) before the lane may advance to QA.\n` +
        `--branch and merge-base are both required: without --branch a git status that FAILED reads as a clean tree, ` +
        `and against the base TIP a lane that committed nothing under an advanced base reads as moved.`
    );
  }
  return { porcelain: readText(porcelain), headSha, baseSha };
}

export function main(argv: string[]): number {
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  try {
    // Shared CLI plumbing (lib/cli.ts): one pass over argv splits positionals
    // from --flag value pairs, so this file no longer hand-rolls an indexOf
    // scan per flag.
    const { positionals, flags } = parseFlags(argv.slice(1));

    // stage-model takes no state.json (it reads config, not loop state), so it
    // is handled before the generic statePath guard below applies to every
    // other command.
    if (cmd === "stage-model") {
      const stages: Stage[] = ["builder", "qa", "reviewer", "merge"];
      const stage = positionals[0] as Stage;
      const ticketModel = positionals[1];
      if (!stages.includes(stage) || !ticketModel) {
        throw new ZError(`Usage: loop stage-model <${stages.join("|")}> <ticketModel> --slug <s>`);
      }
      // --slug is optional here the same way it is everywhere else (H13):
      // loadConfig's resolveSlug falls back to ZSTACK_SLUG or the sole
      // configured project, and throws its own ZError when neither resolves.
      console.log(resolveStageModel(stage, ticketModel, loadConfig(str(flags, "slug")).stageModels));
      return 0;
    }

    // merge-gate takes a worktree path, not a state.json, so it is handled
    // before the statePath guard too. Its EXIT CODE is the contract: 0 green,
    // 1 red (and 1 on a usage/IO error via handleCliError) -- every nonzero
    // means "do not merge", so the fail-closed reading needs no parsing.
    //
    // With --state/--ticket it also STAMPS the verdict onto that lane, which is
    // what makes the gate enforceable rather than advisory: nextAction refuses
    // to advance a lane to the merge stage until a green stamp is there. The
    // stamping form writes twice -- an attempt marker before the gauntlet, the
    // verdict after -- so a run killed mid-gauntlet is still visible.
    if (cmd === "merge-gate") {
      const worktree = positionals[0];
      const gateState = str(flags, "state");
      const gateTicketRaw = str(flags, "ticket");
      if (!worktree || (gateState === undefined) !== (gateTicketRaw === undefined)) {
        throw new ZError("Usage: loop merge-gate <worktreePath> [--state <state.json> --ticket <N>] [--retry-wait-ms N] [--budget-ms N]");
      }
      const gateTicket = gateTicketRaw === undefined ? undefined : Number(gateTicketRaw);
      if (gateTicket !== undefined && !Number.isInteger(gateTicket)) {
        throw new ZError(`--ticket must be an issue number, got ${JSON.stringify(gateTicketRaw)}.`);
      }
      const rawWait = str(flags, "retry-wait-ms");
      const retryWaitMs = rawWait === undefined ? MERGE_GATE_RETRY_WAIT_MS : Number(rawWait);
      if (!Number.isFinite(retryWaitMs) || retryWaitMs < 0) {
        throw new ZError(`--retry-wait-ms must be a non-negative number, got ${JSON.stringify(rawWait)}.`);
      }
      // The wall-clock budget, overridable for the same reason --retry-wait-ms
      // is: the kill path (a gauntlet limb that outruns the budget) is only
      // reachable in a test by shrinking the budget to seconds, and that path
      // decides the whole verdict on the typecheck-only and foreign-runner
      // branches where the exit code IS the verdict.
      const rawBudget = str(flags, "budget-ms");
      const budgetMs = rawBudget === undefined ? MERGE_GATE_BUDGET_MS : Number(rawBudget);
      if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
        throw new ZError(`--budget-ms must be a positive number, got ${JSON.stringify(rawBudget)}.`);
      }
      const now = Number(str(flags, "now") ?? Date.now());
      // Read-modify-write, re-read immediately before each write so the window
      // in which another writer's change could be lost is microseconds, not the
      // minutes the gauntlet itself takes. That matters because the merge AGENT
      // runs this same stamping form (its Step 0, and again after resolving a
      // conflict) while the orchestrator keeps ticking other lanes.
      const stamp = (v: MergeGateVerdict | null): void => {
        if (gateState === undefined) return;
        atomicWrite(gateState, JSON.stringify(recordMergeGate(readJson(gateState) as LoopState, gateTicket!, v, now), null, 2));
      };
      stamp(null); // an attempt is starting -- survives a killed gauntlet
      let verdict: MergeGateVerdict;
      try {
        if (!existsSync(worktree)) throw new ZError(`Merge gate: worktree ${worktree} does not exist.`);
        // #248: the STAMPING form writes a verdict onto lane N, so the tree it
        // measured has to BE lane N's. Without this the argument was free --
        // `merge-gate <anyDirectory> --state st.json --ticket 8` stamped a
        // green onto #8, reproduced end to end -- and the last latent step
        // before `gh pr merge` was "did the agent type the right path".
        //
        // It also buys the termination that lets a commit mismatch RE-GATE
        // instead of parking: with a foreign tree refused here, the only thing
        // left that can move a verdict off its branch head is the branch
        // itself moving, and each re-gate then measures the new head. Refusing
        // here rather than in the reducer is what keeps a stacked chain
        // draining in dependency order instead of parking on a recoverable
        // condition.
        if (gateTicket !== undefined) {
          const branch = gitBranch(worktree);
          if (branch === undefined || !isLaneBranch(branch, gateTicket)) {
            throw new ZError(
              `Merge gate: ${worktree} is on ${branch === undefined ? "no branch (detached, or not a git worktree)" : `branch ${branch}`}, not #${gateTicket}'s lane branch \`z/ticket-${gateTicket}-<slug>\`. A verdict stamped on lane #${gateTicket} has to be measured on lane #${gateTicket}'s own worktree.`
            );
          }
        }
        // Which limbs to run is read off the worktree's own package.json, once,
        // before any spawn -- the same detection the end-of-loop regression pass
        // does, so an absent script is skipped instead of exiting 1 and parking
        // every lane on that repo forever.
        const gateScripts = readGateScripts(worktree);
        // The sha is captured AFTER the gauntlet, from the tree the gauntlet
        // actually ran on, so a verdict never names a commit it did not test.
        verdict = {
          ...mergeGate((_attempt, timeoutMs) => runGauntlet(worktree, gateScripts, timeoutMs), (ms) => Bun.sleepSync(ms), retryWaitMs, gateScripts, budgetMs),
          commit: gitHead(worktree),
        };
      } catch (e) {
        // Standalone (a merge agent's own run): keep the loud CLI error. Stamping
        // (the loop's own run): a gate that cannot RUN is a red gate, not a
        // crashed tick -- the lane parks Blocked with the reason instead of
        // re-running a command that will fail the same way.
        if (gateState === undefined) throw e;
        verdict = { green: false, attempts: 0, failCount: null, note: `merge gate could not run: ${(e as Error).message} -- refusing the merge` };
      }
      stamp(verdict);
      console.log(JSON.stringify(verdict));
      if (!verdict.green) console.error(verdict.note);
      return verdict.green ? 0 : 1;
    }

    // The only Date.now() in this file: the CLI boundary. Pure functions above
    // always take nowMs.
    const nowMs = Number(str(flags, "now") ?? Date.now());
    const statePath = positionals[0];
    if (!statePath) throw new ZError(`Usage:\n${USAGE}`);

    if (cmd === "next") {
      const state = readJson(statePath) as LoopState;
      // #248: the heads are read HERE, by the loop, not passed in by whoever
      // called it. That is what makes the commit binding an enforcement rather
      // than another thing the orchestrator could forget to do.
      console.log(JSON.stringify(nextAction(state, nowMs, observeLaneHeads(state))));
      return 0;
    }
    if (cmd === "apply") {
      if (!positionals[1]) throw new ZError("Usage: loop apply <state.json> <action.json> [--now <ms>]");
      const state = readJson(statePath) as LoopState;
      const action = readJson(positionals[1]) as Action;
      atomicWrite(statePath, JSON.stringify(applyAction(state, action, nowMs), null, 2));
      console.log(`applied ${action.kind}${"ticket" in action ? ` #${action.ticket}` : ""}`);
      return 0;
    }
    if (cmd === "outcome") {
      const ticket = Number(positionals[1]);
      if (!Number.isInteger(ticket) || !positionals[2]) throw new ZError("Usage: loop outcome <state.json> <ticket> <msg.txt> [--now <ms>]");
      const state = readJson(statePath) as LoopState;
      const message = readText(positionals[2]);
      const next = recordOutcome(state, ticket, message, nowMs, builderFactsFromFlags(state, ticket, flags));
      atomicWrite(statePath, JSON.stringify(next, null, 2));
      console.log(JSON.stringify(next.lanes.find((l) => l.ticket === ticket)!.outcome));
      return 0;
    }
    if (cmd === "probe") {
      const ticket = Number(positionals[1]);
      const verdict = positionals[2];
      if (!Number.isInteger(ticket) || (verdict !== "alive" && verdict !== "dead")) {
        throw new ZError("Usage: loop probe <state.json> <ticket> <alive|dead> [--now <ms>]");
      }
      const state = readJson(statePath) as LoopState;
      // #209: only a DEAD probe has leftovers to judge, so the flag is read only
      // there -- passing it with `alive` would be recording a fact about a
      // worktree the live worker is still writing.
      const porcelainFlag = str(flags, "porcelain");
      const porcelain = verdict === "dead" && porcelainFlag !== undefined ? readText(porcelainFlag) : undefined;
      const nextState = recordProbe(state, ticket, verdict === "alive", nowMs, porcelain);
      atomicWrite(statePath, JSON.stringify(nextState, null, 2));
      const dirty = nextState.lanes.find((l) => l.ticket === ticket)?.worktreeDirty;
      console.log(`#${ticket} ${verdict}${dirty === undefined ? "" : dirty ? " (worktree holds uncommitted work)" : " (worktree clean)"}`);
      return 0;
    }
    if (cmd === "attempt") {
      const ticket = Number(positionals[1]);
      if (!Number.isInteger(ticket)) throw new ZError("Usage: loop attempt <state.json> <ticket>");
      const state = readJson(statePath) as LoopState;
      const lane = state.lanes?.find((l) => l.ticket === ticket);
      if (!lane) throw new ZError(`No lane holds #${ticket}, so it has no stage to count spawns for.`);
      console.log(stageAttempt(lane));
      return 0;
    }
    if (cmd === "heartbeat") {
      const state = readJson(statePath) as LoopState;
      // The explicit form: the caller already has the number, so nothing is read
      // off disk. Used by the gate tests and available to any caller that
      // observed the subtree itself.
      const explicit = str(flags, "activity-ms");
      if (explicit !== undefined) {
        const ticket = Number(str(flags, "ticket"));
        if (!Number.isInteger(ticket)) throw new ZError("Usage: loop heartbeat <state.json> --activity-ms <n> --ticket <N>");
        atomicWrite(statePath, JSON.stringify(recordActivity(state, ticket, clampToNow(Number(explicit), nowMs)), null, 2));
        console.log(`#${ticket} activity ${explicit}`);
        return 0;
      }
      // The read is bounded by what the lane already knows: a stage spawn's tag
      // is a digest of slug/ticket/stage/attempt (transcripts.spawnTag) and
      // stageAttempt() returns the attempt of the spawn RUNNING RIGHT NOW, so the
      // tag never has to be stored on the lane and can never name a spawn that
      // already ended. Same three facts the orchestrator stamped into the prompt.
      const slug = str(flags, "slug") ?? loadConfig(undefined).slug;
      const subagentsDir = str(flags, "subagents-dir") ?? subagentsDirFor(str(flags, "project-dir") ?? process.cwd());
      if (subagentsDir === undefined) {
        // No session transcript resolved: nothing to observe, nothing to change.
        // Loud on stderr (an operator debugging a skipped-but-healthy stage needs
        // to know the observation is not happening) and exit 0 -- the drain must
        // never stop because a sidecar directory is missing.
        console.error("loop heartbeat: no session transcript directory resolved; every lane keeps its current watchdog baseline.");
        return 0;
      }
      // One directory scan for every lane instead of one per lane: the metas are
      // the same list whichever tag is being resolved.
      let metas: AgentMeta[] | undefined;
      try {
        metas = readAgentMetas(subagentsDir).metas;
      } catch (e) {
        console.error(`loop heartbeat: ${(e as Error).message}; every lane keeps its current watchdog baseline.`);
        return 0;
      }
      let next = state;
      for (const lane of state.lanes ?? []) {
        const observed = subtreeActivityMs(subagentsDir, spawnTag(slug, lane.ticket, lane.stage, stageAttempt(lane)), metas);
        const activity = clampToNow(observed, nowMs);
        next = recordActivity(next, lane.ticket, activity);
        const after = next.lanes.find((l) => l.ticket === lane.ticket)!;
        console.log(
          activity === undefined
            ? `#${lane.ticket} ${lane.stage} no subtree observed; baseline unchanged`
            : `#${lane.ticket} ${lane.stage} last append ${activity}${after.lastActivityMs === activity ? "" : " (older than the baseline; unchanged)"}`
        );
      }
      atomicWrite(statePath, JSON.stringify(next, null, 2));
      return 0;
    }
    if (cmd === "claim-lost") {
      const ticket = Number(positionals[1]);
      if (!Number.isInteger(ticket)) throw new ZError("Usage: loop claim-lost <state.json> <ticket>");
      const state = readJson(statePath) as LoopState;
      atomicWrite(statePath, JSON.stringify(markClaimLost(state, ticket), null, 2));
      console.log(`#${ticket} claimed by another session; out of this batch`);
      return 0;
    }
    if (cmd === "human-needed") {
      const state = readJson(statePath) as LoopState;
      console.log(JSON.stringify(humanNeededStatus(state)));
      return 0;
    }
    if (cmd === "human-needed-ack") {
      const state = readJson(statePath) as LoopState;
      atomicWrite(statePath, JSON.stringify(markHumanNeededNotified(state), null, 2));
      console.log("human-needed notification acknowledged");
      return 0;
    }
    if (cmd === "confirm-targets") {
      // Read-only, and fail-open by construction: no state file yet (tick 1)
      // means no lanes and no batch, so nothing is worth confirming.
      if (!positionals[1]) throw new ZError("Usage: loop confirm-targets <state.json> <items.json>");
      const targets = confirmTargets(readPrevState(statePath), readJson(positionals[1]) as BoardItemLike[]);
      if (targets.length > 0) console.log(targets.join("\n"));
      return 0;
    }
    if (cmd === "ingest") {
      if (!positionals[1] || !positionals[2]) throw new ZError("Usage: loop ingest <state.json> <items.json> <bodies.json> [--lookups <F>] [--max-lanes N] [--watchdog-minutes M] [--max-qa-passes N] [--qa-investigate-after N] [--human-needed-percent N] [--min-reviewer-confidence N] [--reviewer-below-threshold-action block|retry|off] [--max-review-bounces N] [--min-skeptic-quorum N] [--ticket-limit N] [--context-token-limit N] [--context-tokens N]");
      const prev = readPrevState(statePath);
      let items = readJson(positionals[1]) as BoardItemLike[];
      let bodies = readJson(positionals[2]) as Record<string, string>;
      // #138: the confirm pass's answers, if the caller ran one. Splicing a
      // confirmed-present ticket back into the read and collecting the confirmed-
      // gone numbers is a JSON transform, so it happens HERE (applyConfirmations),
      // not in the wrapper's prose. Each note names only what was proven; they go
      // to stderr because stdout of the tick is reserved for the Action line.
      const lookupsFile = str(flags, "lookups");
      let confirmedGone: number[] = [];
      if (lookupsFile !== undefined) {
        const confirmed = applyConfirmations(items, bodies, readJson(lookupsFile) as ItemLookupResult[]);
        items = confirmed.items;
        bodies = confirmed.bodies;
        confirmedGone = confirmed.confirmedGone;
        for (const note of confirmed.notes) console.error(note);
      }
      // Same stderr channel, same reason: a human-added board column is not an
      // error, but it must be visible that the loop is skipping those tickets.
      for (const note of partitionKnownStatus(items).notes) console.error(note);
      const reviewerBelowThresholdAction = str(flags, "reviewer-below-threshold-action");
      if (
        reviewerBelowThresholdAction !== undefined &&
        !["block", "retry", "off"].includes(reviewerBelowThresholdAction)
      ) {
        throw new ZError(`--reviewer-below-threshold-action must be "block", "retry", or "off", got ${JSON.stringify(reviewerBelowThresholdAction)}.`);
      }
      const cfg: Record<string, number | string | StageWatchdogMinutes | undefined> = {
        reviewerBelowThresholdAction,
        // #256: parsed on its own, since it is the one knob that is not a number.
        // `undefined` (flag absent) leaves ingestBoardItems' preserve-then-default
        // chain untouched, exactly like every numeric flag below.
        watchdogMinutes: watchdogFromFlag(str(flags, "watchdog-minutes")),
      };
      for (const flag of INGEST_NUMBERS) {
        const raw = str(flags, flag);
        if (raw !== undefined) cfg[camel(flag)] = Number(raw);
      }
      const state = ingestBoardItems(prev, items, bodies, cfg as Parameters<typeof ingestBoardItems>[3], confirmedGone);
      atomicWrite(statePath, JSON.stringify(state, null, 2));
      console.log(`${state.tickets.length} ticket(s), ${state.lanes.length} lane(s)`);
      return 0;
    }
    console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
    return 1;
  } catch (e) {
    return handleCliError(e);
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
