// The /z-loop state machine (C6): ticket states, legal transitions, and
// nextAction() -- the ONE pure function that decides what the orchestrating
// session does next (claim / advance a lane / park / skip / drain-complete).
// Everything here is deterministic space (PRINCIPLES.md): the skill shells in
// through the CLI at the bottom, feeds stage results through recordOutcome, and
// applies the returned Action with applyAction -- it never re-derives a
// scheduling or transition decision in prose. No Date.now() outside the CLI
// edge; every pure function takes nowMs.
import { existsSync, readFileSync } from "node:fs";
import { atomicWrite, handleCliError, readJson } from "./cli.ts";
import {
  BOARD_STATUSES,
  DEFAULT_HUMAN_NEEDED_PERCENT,
  DEFAULT_MAX_LANES,
  DEFAULT_MAX_QA_PASSES,
  DEFAULT_QA_INVESTIGATE_AFTER,
  DEFAULT_WATCHDOG_MINUTES,
  ZError,
  type BoardStatus,
} from "./config.ts";
import {
  claimStage,
  claimableTickets,
  deadDeps,
  isWorkableStatus,
  laneCapReached,
  mergeOrder,
  parseDependsOn,
  watchdogExpired,
} from "./lanes.ts";
import { reconcileBoardMoves } from "./reconcile.ts";

export { ZError } from "./config.ts";

// -- ticket states ------------------------------------------------------------

// The canonical nine statuses and the terminal-for-this-batch subset live in
// lib/config.ts (single source, issue #14 item 21); re-exported here so every
// existing importer of the state machine keeps its import path.
export { BOARD_STATUSES, TERMINAL_STATUSES } from "./config.ts";
export type { BoardStatus } from "./config.ts";

// Legal status transitions (PROCESS.md). Questions/Blocked/Skipped/Done exits
// are the human's moves (bounce back to Ready, or return a parked ticket to its
// stage) -- the loop itself only ever walks the workable path plus the parks.
const LEGAL_TRANSITIONS: Record<BoardStatus, BoardStatus[]> = {
  Backlog: ["Ready"],
  Ready: ["Building", "Questions", "Blocked", "Skipped"],
  Building: ["QA", "Questions", "Blocked", "Skipped"],
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

export interface TicketSnapshot {
  number: number;
  title: string;
  status: BoardStatus;
  dependsOn: number[];
  model?: string; // board Model field; the harness Agent spawn's model param
  modelEffort?: string; // board Model Effort field
  claimedByOther?: boolean; // z-board claim lost to another session
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
  workerDead?: boolean; // set by the orchestrator after an aliveness probe
  outcome?: StageOutcome; // set when the stage agent's final message is parsed
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
  humanNeededPercent?: number;
  humanNeededNotified?: boolean;
}

// -- stage outcomes -----------------------------------------------------------

export type StageOutcome =
  | { kind: "built" }
  | { kind: "needs-input"; note: string }
  | { kind: "qa-pass" }
  | { kind: "qa-bugs"; note: string }
  | { kind: "review-approve" }
  | { kind: "review-findings"; note: string }
  | { kind: "human-question"; note: string }
  | { kind: "stage-blocked"; note: string }
  | { kind: "confused"; note: string }
  | { kind: "merged"; note: string };

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
    "REVIEW-APPROVE": () => ({ kind: "review-approve" }),
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
  | { kind: "advance"; ticket: number; to: Stage; note?: string; investigateFirst?: boolean; stackedOn?: number[] }
  | { kind: "park"; ticket: number; status: "Questions" | "Blocked"; note: string }
  | { kind: "skip"; ticket: number; note: string }
  | { kind: "stop-lane"; ticket: number; note: string }
  | { kind: "check-worker"; ticket: number }
  | { kind: "complete"; ticket: number; note: string }
  | { kind: "wait" }
  | { kind: "drain-complete" };

// Maximum QA passes before the ticket parks in Blocked (PROCESS.md step 16).
// Kept exported as the default's named constant (issue #41): the cap is now a
// per-project config knob (BoardConfig.maxQaPasses / DEFAULT_MAX_QA_PASSES),
// but existing importers of MAX_QA_PASSES keep working, reading the default.
export const MAX_QA_PASSES = DEFAULT_MAX_QA_PASSES;

// The two config-driven QA bounce knobs resolveOutcome needs. Threaded in by
// nextAction (already defaulted there) rather than read off a global, so the
// reducer stays a pure function of its inputs.
interface QaBounceLimits {
  maxQaPasses: number;
  qaInvestigateAfter: number;
}

// What one lane's finished stage means for that lane. review-approve returns
// null: merging is a cross-lane decision (dependency order, one merge at a
// time) resolved by nextAction's merge gate below, not per-lane.
function resolveOutcome(lane: LaneState, qaLimits: QaBounceLimits): Action | null {
  const o = lane.outcome!;
  const ticket = lane.ticket;
  switch (o.kind) {
    case "built":
      return { kind: "advance", ticket, to: "qa" };
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
      return { kind: "advance", ticket, to: "builder", note: o.note };
    case "review-approve":
      return null;
    case "merged":
      return { kind: "complete", ticket, note: o.note };
  }
}

export interface LoopOpts {
  nowMs: number;
  maxLanes?: number;
  watchdogMinutes?: number;
  maxQaPasses?: number;
  qaInvestigateAfter?: number;
  mergedThisRun?: number[];
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
//   5. claim the next claimable ticket if a lane is free;
//   6. with all lanes idle and nothing claimable, break a dependency deadlock
//      by parking the lowest stuck ticket to Blocked (no-token-burn rule);
//   7. drain-complete when nothing workable remains; else wait.
export function nextAction(tickets: TicketSnapshot[], lanes: LaneState[], opts: LoopOpts): Action {
  const maxLanes = opts.maxLanes ?? DEFAULT_MAX_LANES;
  const wd = opts.watchdogMinutes ?? DEFAULT_WATCHDOG_MINUTES;
  const qaLimits: QaBounceLimits = {
    maxQaPasses: opts.maxQaPasses ?? DEFAULT_MAX_QA_PASSES,
    qaInvestigateAfter: opts.qaInvestigateAfter ?? DEFAULT_QA_INVESTIGATE_AFTER,
  };
  const byNumber = new Map(tickets.map((t) => [t.number, t]));

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
    if (lane.outcome.kind === "review-approve") continue;
    const action = resolveOutcome(lane, qaLimits);
    if (action) return action;
  }

  // 2. Merge gate: one merge at a time, dependency order across ready lanes.
  const midMerge = lanes.some((l) => l.stage === "merge" && l.outcome?.kind !== "merged");
  const mergeReady = lanes.filter((l) => l.outcome?.kind === "review-approve");
  if (mergeReady.length > 0 && !midMerge) {
    const order = mergeOrder(
      mergeReady.map((l) => ({ ticket: l.ticket, dependsOn: byNumber.get(l.ticket)?.dependsOn ?? [] }))
    );
    // A stacked parent is one merging concurrently OR already merged this run
    // (its branch survives until batch-end cleanup, so the child's PR still
    // needs the step-18 retarget).
    const first = order[0];
    const mergedThisRun = new Set(opts.mergedThisRun ?? []);
    const runParents = (byNumber.get(first.ticket)?.dependsOn ?? []).filter((d) => mergedThisRun.has(d));
    const stackedOn = [...new Set([...first.stackedOn, ...runParents])].sort((a, b) => a - b);
    return { kind: "advance", ticket: first.ticket, to: "merge", stackedOn };
  }

  // 3. Watchdog on silent lanes (an unresolved merge approval is not silent).
  for (const lane of lanes) {
    if (lane.outcome) continue;
    if (!watchdogExpired(lane, opts.nowMs, wd)) continue;
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
  const inLane = new Set(lanes.map((l) => l.ticket));
  const unclaimed = tickets
    .filter((t) => isWorkableStatus(t.status) && !inLane.has(t.number) && !t.claimedByOther)
    .sort((a, b) => a.number - b.number);
  for (const t of unclaimed) {
    const dead = deadDeps(t, byNumber);
    if (dead.length > 0) {
      const states = dead.map((d) => `#${d} (${byNumber.get(d)!.status})`).join(", ");
      return { kind: "park", ticket: t.number, status: "Blocked", note: `Blocked by dependencies that cannot complete in this batch: ${states}.` };
    }
  }

  // 5. Claim the next ticket into a free lane.
  const claimable = claimableTickets(tickets, lanes);
  if (claimable.length > 0 && !laneCapReached(lanes, maxLanes)) {
    const t = claimable[0];
    return { kind: "claim", ticket: t.number, stage: claimStage(t.status) };
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
// batch -- and no lane still running.
export function drainComplete(tickets: TicketSnapshot[], lanes: LaneState[]): boolean {
  return lanes.length === 0 && tickets.every((t) => !isWorkableStatus(t.status) || t.claimedByOther === true);
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
  const byStatus = (s: BoardStatus) => state.tickets.filter((t) => t.status === s);
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
      next.lanes.push({ ticket: action.ticket, stage: action.stage, lastActivityMs: nowMs, qaBounces: 0 });
      return next;
    }
    case "advance": {
      const lane = next.lanes.find((l) => l.ticket === action.ticket);
      if (!lane) throw new ZError(`No lane holds #${action.ticket} to advance.`);
      if (action.to === "builder" && lane.stage === "qa") lane.qaBounces += 1;
      lane.stage = action.to;
      lane.lastActivityMs = nowMs;
      delete lane.outcome;
      delete lane.workerDead;
      setStatus(findTicket(next, action.ticket), STATUS_FOR_STAGE[action.to]);
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
    case "drain-complete":
      return next;
  }
}

// Records a finished stage agent's final message on its lane (pure).
export function recordOutcome(state: LoopState, ticket: number, finalMessage: string, nowMs: number): LoopState {
  const next = structuredClone(state);
  const lane = next.lanes.find((l) => l.ticket === ticket);
  if (!lane) throw new ZError(`No lane holds #${ticket} to record an outcome on.`);
  lane.outcome = parseStageResult(lane.stage, finalMessage);
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
    humanNeededPercent?: number;
  }
): LoopState {
  const prevByNumber = new Map((prev?.tickets ?? []).map((t) => [t.number, t]));
  const tickets = items.map((it) => {
    const status = String(it.fields["Status"] ?? "") as BoardStatus;
    if (!BOARD_STATUSES.includes(status)) {
      throw new ZError(`Issue #${it.number} has unknown Status ${JSON.stringify(it.fields["Status"])}.`);
    }
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
    if (prevByNumber.get(it.number)?.claimedByOther) t.claimedByOther = true;
    return t;
  });
  // Drop any lane whose ticket vanished from the snapshot (issue #14 H14): if an
  // issue is removed from the project mid-run, keeping its lane would make the
  // next apply throw in findTicket and wedge every subsequent apply. The worker
  // (if any) is left for the SKILL to tear down; the loop simply stops tracking a
  // ticket the board no longer knows about.
  const present = new Set(tickets.map((t) => t.number));
  const lanes = (prev?.lanes ?? []).filter((l) => present.has(l.ticket));

  // Safety control (issue #63): initialReadyCount/humanNeededNotified are
  // per-BATCH state, not a per-project setting, so they need a different
  // fallback chain than the knobs above -- a naive "preserve whenever prev is
  // non-null" would carry a FIRST run's drained, terminal-status prev (and its
  // stale counters) into a second /z-loop invocation, since state.json is
  // never deleted between runs. drainComplete is the reset boundary: a batch
  // is "fresh" when there is no prior state at all, or the prior state was
  // fully drained (no lanes, every ticket terminal) -- exactly the condition
  // under which `lanes` also lands at [] naturally between runs.
  const startingFreshBatch = !prev || drainComplete(prev.tickets, prev.lanes);

  return {
    tickets: tickets.sort((a, b) => a.number - b.number),
    lanes: structuredClone(lanes),
    maxLanes: cfg?.maxLanes ?? prev?.maxLanes ?? DEFAULT_MAX_LANES,
    watchdogMinutes: cfg?.watchdogMinutes ?? prev?.watchdogMinutes ?? DEFAULT_WATCHDOG_MINUTES,
    maxQaPasses: cfg?.maxQaPasses ?? prev?.maxQaPasses ?? DEFAULT_MAX_QA_PASSES,
    qaInvestigateAfter: cfg?.qaInvestigateAfter ?? prev?.qaInvestigateAfter ?? DEFAULT_QA_INVESTIGATE_AFTER,
    humanNeededPercent: cfg?.humanNeededPercent ?? prev?.humanNeededPercent ?? DEFAULT_HUMAN_NEEDED_PERCENT,
    mergedThisRun: [...(prev?.mergedThisRun ?? [])],
    initialReadyCount: startingFreshBatch
      ? tickets.filter((t) => t.status === "Building").length
      : (prev!.initialReadyCount ?? 0),
    humanNeededNotified: startingFreshBatch ? false : (prev!.humanNeededNotified ?? false),
  };
}

// -- CLI ---------------------------------------------------------------------

const USAGE = `loop <command> [args]

  next <state.json> [--now <ms>]                     print the next Action as JSON (no writes)
  apply <state.json> <action.json> [--now <ms>]      apply an Action, rewrite the state file
  outcome <state.json> <ticket> <msg.txt> [--now <ms>]  parse a stage's final message onto its lane
  probe <state.json> <ticket> <alive|dead> [--now <ms>] record an aliveness probe
  claim-lost <state.json> <ticket>                   mark a ticket claimed by another session
  human-needed <state.json>                          print the breakdown + tripped/alreadyNotified (no writes)
  human-needed-ack <state.json>                       mark the mid-run notification as sent (fire-once flag)
  ingest <state.json> <items.json> <bodies.json> [--max-lanes N] [--watchdog-minutes M]
                      [--max-qa-passes N] [--qa-investigate-after N] [--human-needed-percent N]
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

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv: string[]): number {
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  try {
    // The only Date.now() in this file: the CLI boundary. Pure functions above
    // always take nowMs.
    const nowMs = Number(flagValue(argv, "--now") ?? Date.now());
    const statePath = argv[1];
    if (!statePath) throw new ZError(`Usage:\n${USAGE}`);

    if (cmd === "next") {
      const state = readJson(statePath) as LoopState;
      const action = nextAction(state.tickets, state.lanes, {
        nowMs,
        maxLanes: state.maxLanes,
        watchdogMinutes: state.watchdogMinutes,
        maxQaPasses: state.maxQaPasses,
        qaInvestigateAfter: state.qaInvestigateAfter,
        mergedThisRun: state.mergedThisRun,
      });
      console.log(JSON.stringify(action));
      return 0;
    }
    if (cmd === "apply") {
      if (!argv[2]) throw new ZError("Usage: loop apply <state.json> <action.json> [--now <ms>]");
      const state = readJson(statePath) as LoopState;
      const action = readJson(argv[2]) as Action;
      atomicWrite(statePath, JSON.stringify(applyAction(state, action, nowMs), null, 2));
      console.log(`applied ${action.kind}${"ticket" in action ? ` #${action.ticket}` : ""}`);
      return 0;
    }
    if (cmd === "outcome") {
      const ticket = Number(argv[2]);
      if (!Number.isInteger(ticket) || !argv[3]) throw new ZError("Usage: loop outcome <state.json> <ticket> <msg.txt> [--now <ms>]");
      const state = readJson(statePath) as LoopState;
      const message = readFileSync(argv[3], "utf8");
      const next = recordOutcome(state, ticket, message, nowMs);
      atomicWrite(statePath, JSON.stringify(next, null, 2));
      console.log(JSON.stringify(next.lanes.find((l) => l.ticket === ticket)!.outcome));
      return 0;
    }
    if (cmd === "probe") {
      const ticket = Number(argv[2]);
      const verdict = argv[3];
      if (!Number.isInteger(ticket) || (verdict !== "alive" && verdict !== "dead")) {
        throw new ZError("Usage: loop probe <state.json> <ticket> <alive|dead> [--now <ms>]");
      }
      const state = readJson(statePath) as LoopState;
      atomicWrite(statePath, JSON.stringify(recordProbe(state, ticket, verdict === "alive", nowMs), null, 2));
      console.log(`#${ticket} ${verdict}`);
      return 0;
    }
    if (cmd === "claim-lost") {
      const ticket = Number(argv[2]);
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
    if (cmd === "ingest") {
      if (!argv[2] || !argv[3]) throw new ZError("Usage: loop ingest <state.json> <items.json> <bodies.json> [--max-lanes N] [--watchdog-minutes M] [--max-qa-passes N] [--qa-investigate-after N] [--human-needed-percent N]");
      const prev = readPrevState(statePath);
      const items = readJson(argv[2]) as BoardItemLike[];
      const bodies = readJson(argv[3]) as Record<string, string>;
      const maxLanes = flagValue(argv, "--max-lanes");
      const watchdogMinutes = flagValue(argv, "--watchdog-minutes");
      const maxQaPasses = flagValue(argv, "--max-qa-passes");
      const qaInvestigateAfter = flagValue(argv, "--qa-investigate-after");
      const humanNeededPercent = flagValue(argv, "--human-needed-percent");
      const state = ingestBoardItems(prev, items, bodies, {
        maxLanes: maxLanes === undefined ? undefined : Number(maxLanes),
        watchdogMinutes: watchdogMinutes === undefined ? undefined : Number(watchdogMinutes),
        maxQaPasses: maxQaPasses === undefined ? undefined : Number(maxQaPasses),
        qaInvestigateAfter: qaInvestigateAfter === undefined ? undefined : Number(qaInvestigateAfter),
        humanNeededPercent: humanNeededPercent === undefined ? undefined : Number(humanNeededPercent),
      });
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
