// Lane scheduling for /z-loop (C6): which ticket is claimable next (dependency
// order), lane-cap enforcement, watchdog expiry, and merge ordering for a set of
// finished lanes. Every function here is pure and clock-injected (no Date.now()),
// so the loop's scheduling decisions are deterministic space (PRINCIPLES.md) --
// the skill shells in via the CLI below and never re-derives any of this in
// prose. Types live in lib/loop.ts (the state machine); importing them as
// type-only keeps the loop<->lanes import cycle erased at runtime.
import { readFileSync } from "node:fs";
import { handleCliError } from "./cli.ts";
import { TERMINAL_STATUSES, ZError } from "./config.ts";
import type { BoardStatus, LaneState, Stage, TicketSnapshot } from "./loop.ts";

export { ZError } from "./config.ts";

// -- dependency parsing -------------------------------------------------------

// Extracts the issue numbers a ticket waits on from its body's "Depends on"
// lines. Two wire formats exist and both must parse: z-plan writes
// "Depends on: C2 (#5), C4 (#6)" (colon, prose) and z-board link appends
// "Depends on #5" (no colon). Only "Depends on" lines are scanned -- a body's
// other #N references ("Part of: EPIC #3") are not dependencies.
export function parseDependsOn(body: string): number[] {
  const deps = new Set<number>();
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^\s*depends on:?\s*(.*)$/i);
    if (!m) continue;
    for (const ref of m[1].matchAll(/#(\d+)/g)) deps.add(Number(ref[1]));
  }
  return [...deps].sort((a, b) => a - b);
}

// -- claimable-ticket selection ----------------------------------------------

// Statuses a lane can pick up, and the stage the lane starts at. Ready is
// claimable as a fallback (a straggler filed mid-loop); QA/Review cover
// re-entry after a crashed run so a half-done ticket resumes at its stage
// instead of being rebuilt. Questions/Blocked/Skipped/Done/Backlog are never
// here, which is exactly why a Questions ticket can never be claimed.
const CLAIMABLE_STAGE: Partial<Record<BoardStatus, Stage>> = {
  Ready: "builder",
  Building: "builder",
  QA: "qa",
  Review: "reviewer",
};

export function claimStage(status: BoardStatus): Stage {
  const stage = CLAIMABLE_STAGE[status];
  if (!stage) throw new ZError(`Status "${status}" is not claimable.`);
  return stage;
}

export function isWorkableStatus(status: BoardStatus): boolean {
  return CLAIMABLE_STAGE[status] !== undefined;
}

// A dependency is satisfied when it is Done on this board, or absent from the
// snapshot entirely (already merged/closed in an earlier batch).
function depsSatisfied(t: TicketSnapshot, byNumber: Map<number, TicketSnapshot>): boolean {
  return t.dependsOn.every((d) => {
    const dep = byNumber.get(d);
    return dep === undefined || dep.status === "Done";
  });
}

// Dependencies that can never complete in this batch: the loop must not let the
// dependent sit and burn tokens waiting on them (PROCESS.md global rule). Dead =
// terminal (lib/config.ts TERMINAL_STATUSES) minus Done -- a Done dep is
// satisfied, not dead.
export function deadDeps(t: TicketSnapshot, byNumber: Map<number, TicketSnapshot>): number[] {
  return t.dependsOn.filter((d) => {
    const dep = byNumber.get(d);
    return dep !== undefined && dep.status !== "Done" && TERMINAL_STATUSES.includes(dep.status);
  });
}

// Tickets a free lane may claim right now, in claim order: workable status, not
// already in a lane, not claimed by another session, every dependency
// Done/merged. Deterministic order = ascending issue number; dependency order
// falls out because a dependent is simply not claimable until its deps are Done.
export function claimableTickets(tickets: TicketSnapshot[], lanes: LaneState[]): TicketSnapshot[] {
  const inLane = new Set(lanes.map((l) => l.ticket));
  const byNumber = new Map(tickets.map((t) => [t.number, t]));
  return tickets
    .filter((t) => isWorkableStatus(t.status) && !inLane.has(t.number) && !t.claimedByOther)
    .filter((t) => depsSatisfied(t, byNumber))
    .sort((a, b) => a.number - b.number);
}

export function laneCapReached(lanes: LaneState[], maxLanes: number): boolean {
  return lanes.length >= maxLanes;
}

// -- watchdog -----------------------------------------------------------------

// A stage is expired when it has been silent for LONGER than the budget --
// exactly watchdogMinutes of silence is still in budget. Clock injected: the
// caller passes nowMs, so tests pin expiry to the millisecond.
export function watchdogExpired(lane: LaneState, nowMs: number, watchdogMinutes: number): boolean {
  return nowMs - lane.lastActivityMs > watchdogMinutes * 60_000;
}

// -- merge ordering -----------------------------------------------------------

export interface MergeInput {
  ticket: number;
  dependsOn: number[];
}

// One PR merge, in order. stackedOn = the deps that are IN this finished set:
// non-empty means a stacked chain (PROCESS.md step 18) -- the parent merges
// first WITHOUT deleting its branch, this PR is retargeted to the base branch
// after each parent lands, and branches are deleted only after the whole batch
// (deleting a base branch closes dependent PRs).
export interface MergeStep {
  ticket: number;
  stackedOn: number[];
}

// Topological merge order over a set of finished lanes. Deps outside the set
// are ignored (already merged). Kahn's algorithm picking the lowest ready
// ticket each round, so the order is total and deterministic. A cycle inside
// the set is a planning bug and throws rather than merging anything.
export function mergeOrder(finished: MergeInput[]): MergeStep[] {
  const inSet = new Set(finished.map((f) => f.ticket));
  const deps = new Map(finished.map((f) => [f.ticket, f.dependsOn.filter((d) => inSet.has(d))]));
  const merged = new Set<number>();
  const steps: MergeStep[] = [];
  while (steps.length < finished.length) {
    const ready = [...deps]
      .filter(([t, d]) => !merged.has(t) && d.every((x) => merged.has(x)))
      .map(([t]) => t)
      .sort((a, b) => a - b);
    if (ready.length === 0) {
      const stuck = [...deps.keys()].filter((t) => !merged.has(t));
      throw new ZError(`Dependency cycle among finished lanes: #${stuck.join(", #")}.`);
    }
    merged.add(ready[0]);
    steps.push({ ticket: ready[0], stackedOn: deps.get(ready[0])! });
  }
  return steps;
}

// -- CLI ---------------------------------------------------------------------
const USAGE = `lanes <command> [args]

  depends-on <body.md>          print the issue numbers a ticket body depends on, as JSON
  merge-order <finished.json>   print MergeStep[] for [{ticket, dependsOn}] lanes, as JSON`;

export function main(argv: string[]): number {
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  try {
    if (cmd === "depends-on") {
      if (!argv[1]) throw new ZError("Usage: lanes depends-on <body.md>");
      console.log(JSON.stringify(parseDependsOn(readFileSync(argv[1], "utf8"))));
      return 0;
    }
    if (cmd === "merge-order") {
      if (!argv[1]) throw new ZError("Usage: lanes merge-order <finished.json>");
      const finished = JSON.parse(readFileSync(argv[1], "utf8")) as MergeInput[];
      console.log(JSON.stringify(mergeOrder(finished)));
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
