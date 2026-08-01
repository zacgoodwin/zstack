// The /z-loop state machine (C6): ticket states, legal transitions, and
// nextAction() -- the ONE pure function that decides what the orchestrating
// session does next (claim / advance a lane / park / skip / drain-complete).
// Everything here is deterministic space (PRINCIPLES.md): the skill shells in
// through the CLI at the bottom, feeds stage results through recordOutcome, and
// applies the returned Action with applyAction -- it never re-derives a
// scheduling or transition decision in prose. No Date.now() outside the CLI
// edge; every pure function takes nowMs.
import { existsSync, readFileSync } from "node:fs";
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
  loadConfig,
  ZError,
  type BoardStatus,
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
  lastActivityMs: number; // last observed worker output (watchdog baseline)
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
  workerDead?: boolean; // set by the orchestrator after an aliveness probe
  outcome?: StageOutcome; // set when the stage agent's final message is parsed
  // #125: the board status the loop itself last wrote for this lane (set by
  // applyAction's claim/advance). It is the ORIGIN marker the one-hop desync
  // guard needs: while set, the loop's own write is still in flight and has NOT
  // been observed to land; ingestBoardItems clears it the moment the board
  // shows that status. A one-hop-behind read only resyncs when this still
  // points at the lane's own stage status (a genuine human move-back, which the
  // loop never wrote, leaves it cleared -> safe stop-lane). See the guard below.
  lastWroteStatus?: BoardStatus;
}

export interface LoopState {
  tickets: TicketSnapshot[];
  lanes: LaneState[];
  maxLanes: number;
  watchdogMinutes: number;
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
  // #133 AC4) or currently Ready-and-unclaimed (the committed queue, same
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
  // #225: branch protection refused the merge. A distinct kind because the two
  // outcomes it used to be squeezed into both say the wrong thing: BLOCKED
  // (`stage-blocked`) reads as a broken environment and pages `ticket-parked`,
  // and CONFUSED skips the ticket -- while the PR is finished, green, and merely
  // waiting on a human's approving review. `prUrl` is carried separately from
  // the note so the park can name the PR without re-parsing prose (#226 owns the
  // wait-for-approval flow that reads it).
  | { kind: "merge-needs-approval"; prUrl: string | null; note: string }
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

// The PR URL off a MERGE-NEEDS-APPROVAL marker note (#225). The marker's note is
// model-authored prose ("<url> -- ruleset 19184288 requires 1 approving review"),
// so the URL is extracted rather than assumed to be the whole note. Same
// no-throw contract as the other two note parsers above: an unparseable note
// yields null and the park falls back to naming the branch instead of the PR --
// a missing URL must never crash the tick or turn a clean park into a failure.
//
// `\S*?` is lazy up to the literal `/pull/<digits>`, so trailing punctuation, a
// `#issuecomment` fragment, or following prose never join the match.
export function parsePrUrl(note: string): string | null {
  const m = note.match(/https?:\/\/\S*?\/pull\/\d+/);
  return m ? m[0] : null;
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
export function builtGuardFailure(facts: BuilderCommitFacts): string | null {
  const lines = facts.porcelain.split(/\r?\n/).filter((l) => l.trim() !== "");
  const statusRan = lines.some((l) => l.startsWith("## ")); // see BuilderCommitFacts.porcelain
  const dirty = lines.filter((l) => !l.startsWith("## "));
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
    "MERGE-NEEDS-APPROVAL": (note) => ({ kind: "merge-needs-approval", prUrl: parsePrUrl(note), note }),
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
  | { kind: "park"; ticket: number; status: "Questions" | "Blocked"; note: string }
  | { kind: "skip"; ticket: number; note: string }
  | { kind: "stop-lane"; ticket: number; note: string }
  | { kind: "check-worker"; ticket: number }
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
// dumps first (z-loop/SKILL.md `park N Blocked`) and says plainly that the
// worktree does not survive the next run.
function commitRetryAction(lane: LaneState, detail: string): Action {
  const spent = lane.commitRetries ?? 0;
  if (spent >= MAX_COMMIT_RETRIES) {
    return {
      kind: "park",
      ticket: lane.ticket,
      status: "Blocked",
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
    // #225: Questions, not Blocked. The distinction is the whole point of the
    // marker -- the work is finished and the only missing thing is a human
    // action, which is exactly what Questions (and its `human-pause` page)
    // means. Parking it Blocked would page `ticket-parked` and read as
    // something broken, which is how a merge stage talks itself into
    // `--admin` next time.
    case "merge-needs-approval":
      return {
        kind: "park",
        ticket,
        status: "Questions",
        note:
          `Waiting on an approving review: ${o.prUrl ?? "the merge stage's PR"} is open and green, and branch protection ` +
          `will not let the loop merge it. Nothing is wrong with the diff and nothing is broken -- approve and merge the PR ` +
          `yourself (or relax the rule; see docs/user-guide/bot-identity.md), then move this ticket back to Ready if it needs ` +
          `anything more. The loop will not override a protection rule.\n\n${o.note}`,
      };
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
export function nextAction(state: LoopState, nowMs: number): Action {
  const { tickets, lanes } = state;
  const maxLanes = state.maxLanes ?? DEFAULT_MAX_LANES;
  const wd = state.watchdogMinutes ?? DEFAULT_WATCHDOG_MINUTES;
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
    // A stacked parent is one merging concurrently OR already merged this run
    // (its branch survives until batch-end cleanup, so the child's PR still
    // needs the step-18 retarget).
    const first = order[0];
    const mergedThisRun = new Set(state.mergedThisRun ?? []);
    const runParents = (byNumber.get(first.ticket)?.dependsOn ?? []).filter((d) => mergedThisRun.has(d));
    const stackedOn = [...new Set([...first.stackedOn, ...runParents])].sort((a, b) => a - b);
    return withResync({ kind: "advance", ticket: first.ticket, to: "merge", stackedOn }, resyncStatus);
  }

  // 3. Watchdog on silent lanes (an unresolved merge approval is not silent).
  for (const lane of lanes) {
    if (lane.outcome) continue;
    if (!watchdogExpired(lane, nowMs, wd)) continue;
    if (lane.workerDead) {
      // A dead MERGE worker is never blind-skipped (issue #14 H9): `gh pr merge`
      // may have landed the PR before the worker died, and skipping would lose it
      // from mergedThisRun (breaking a stacked child's step-18 retarget) and let
      // batch-end branch deletion close the dependent PR. The SKILL must verify PR
      // state via `gh pr view` and record an outcome -- `merged` (-> complete,
      // counted in mergedThisRun) if it landed, else `stage-blocked` (-> park
      // Blocked for a human). So a dead merge lane holds at check-worker until an
      // outcome is recorded, never falling through to skip.
      if (lane.stage === "merge") return { kind: "check-worker", ticket: lane.ticket };
      return { kind: "skip", ticket: lane.ticket, note: `Worker died mid-${lane.stage}: silent past the ${wd}-minute watchdog and not alive on probe. Skipped per the PROCESS.md no-token-burn rule; worktree left for inspection.` };
    }
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
      next.lanes.push({ ticket: action.ticket, stage: action.stage, lastActivityMs: nowMs, qaBounces: 0, reviewBounces: 0, lastWroteStatus: STATUS_FOR_STAGE[action.stage] });
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
      delete lane.outcome;
      delete lane.workerDead;
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
      dropLane(next, action.ticket);
      return next;
    }
    case "complete": {
      dropLane(next, action.ticket);
      setStatus(findTicket(next, action.ticket), "Done");
      (next.mergedThisRun ??= []).push(action.ticket);
      return next;
    }
    case "check-worker":
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
// the lane so the next nextAction() returns the skip (pure).
export function recordProbe(state: LoopState, ticket: number, alive: boolean, nowMs: number): LoopState {
  const next = structuredClone(state);
  const lane = next.lanes.find((l) => l.ticket === ticket);
  if (!lane) throw new ZError(`No lane holds #${ticket} to probe.`);
  if (alive) {
    lane.lastActivityMs = nowMs;
    delete lane.workerDead;
  } else {
    lane.workerDead = true;
  }
  return next;
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
    watchdogMinutes?: number;
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
  const gone = new Set([...confirmedGone, ...ignored.map((i) => i.number)]);
  const merged = new Map<number, TicketSnapshot>();
  for (const t of prev?.tickets ?? []) merged.set(t.number, structuredClone(t));
  for (const t of observed) merged.set(t.number, t);
  for (const n of gone) merged.delete(n);
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
  const lanes = (prev?.lanes ?? [])
    .filter((l) => !gone.has(l.ticket))
    .map((l) => {
      if (l.lastWroteStatus !== undefined && statusByNumber.get(l.ticket) === l.lastWroteStatus) {
        const cleared = { ...l };
        delete cleared.lastWroteStatus;
        return cleared;
      }
      return l;
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
  const isNewBatchTicket = (t: TicketSnapshot) => !prevByNumber.has(t.number) || (t.status === "Ready" && !t.claimedByOther);
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
    watchdogMinutes: cfg?.watchdogMinutes ?? prev?.watchdogMinutes ?? DEFAULT_WATCHDOG_MINUTES,
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
  const watched = new Set<number>([...(prev.lanes ?? []).map((l) => l.ticket), ...(prev.batchTickets ?? [])]);
  return [...watched].filter((n) => !present.has(n)).sort((a, b) => a - b);
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
        `read missed #${l.number}; single-ticket lookup confirms it is gone from the board (${l.reason ?? "not-on-project"}); releasing its lane.`
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
  next <state.json> [--now <ms>]                     print the next Action as JSON (no writes)
  apply <state.json> <action.json> [--now <ms>]      apply an Action, rewrite the state file
  outcome <state.json> <ticket> <msg.txt> [--now <ms>]  parse a stage's final message onto its lane
          a BUILDER lane also REQUIRES its worktree's git facts (#177), which a
          BUILT is verified against: --porcelain <file> (git status --porcelain
          --branch) --head-sha <sha> (git rev-parse HEAD) --base-sha <sha>
          (git merge-base <baseBranch> HEAD)
  probe <state.json> <ticket> <alive|dead> [--now <ms>] record an aliveness probe
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
  "watchdog-minutes",
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

    // The only Date.now() in this file: the CLI boundary. Pure functions above
    // always take nowMs.
    const nowMs = Number(str(flags, "now") ?? Date.now());
    const statePath = positionals[0];
    if (!statePath) throw new ZError(`Usage:\n${USAGE}`);

    if (cmd === "next") {
      const state = readJson(statePath) as LoopState;
      console.log(JSON.stringify(nextAction(state, nowMs)));
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
      atomicWrite(statePath, JSON.stringify(recordProbe(state, ticket, verdict === "alive", nowMs), null, 2));
      console.log(`#${ticket} ${verdict}`);
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
      const cfg: Record<string, number | string | undefined> = {
        reviewerBelowThresholdAction,
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
