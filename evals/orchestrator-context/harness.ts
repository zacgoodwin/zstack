// evals/orchestrator-context — the /z-loop orchestrator-context drain eval
// (ticket #57, AC5). It measures the metric the ticket names: peak orchestrator
// resident-context bytes PER DRAINED TICKET, before (pre-#57) vs after
// (pointer-prompts + one-line tick), on a synthetic 6-ticket happy-path drain.
//
// Why this is a DETERMINISTIC eval, not a paid one (PRINCIPLES.md, latent vs
// deterministic): the measured quantity is context BYTES, and those are a pure
// function of two things #57 changes -- (1) the stage prompt the orchestrator
// reads back to spawn each Agent (Leak 1), and (2) the per-iteration bash text
// it re-reads every tick (Leak 2). Both are computed here from the REAL stage
// constructors and the REAL scheduler (lib/loop.ts drives the drain), so the
// number is reproducible and free. There is no LLM judgment to make, so making
// an LLM call would be theater. tests/orchestrator-context.test.ts gates the
// >=60% threshold; this file is the runnable harness + report.
import {
  applyAction,
  nextAction,
  recordOutcome,
  type LoopState,
  type Stage,
  type TicketSnapshot,
} from "../../lib/loop.ts";
import { builderPrompt, mergePrompt, qaPrompt, reviewerPrompt } from "../../lib/stage-prompts.ts";

// A representative ABSOLUTE input path, the shape z-loop writes per ticket.
const INPUT_PATH = "/home/dev/.zstack/projects/demo/loop/tmp/input-1.json";

export interface Payloads {
  ticketBody: string;
  diff: string;
  acceptanceCriteria: string;
}

// Realistic mid-size drain payloads: a ~6 KB ticket body, an ~18 KB diff, ~1.2 KB
// of acceptance criteria. (The cut only GROWS with payload size -- see the eval
// test's 100 KB case -- so a modest, realistic payload is the honest baseline.)
export function defaultPayloads(): Payloads {
  return { ticketBody: "B".repeat(6000), diff: "D".repeat(18000), acceptanceCriteria: "A".repeat(1200) };
}

// The bytes each stage INLINED into its prompt pre-#57 -- the payload that
// transited the orchestrator's own context on every spawn (Leak 1).
function payloadBytes(stage: Stage, p: Payloads): number {
  switch (stage) {
    case "builder":
    case "qa":
      return p.ticketBody.length;
    case "reviewer":
      return p.ticketBody.length + p.acceptanceCriteria.length + p.diff.length;
    case "merge":
      return 0;
  }
}

// The REAL pointer prompt the orchestrator reads TODAY, built WITH the payloads
// present -- its length is independent of them (that is AC1), which is exactly
// what makes the after-number small.
function afterPromptBytes(stage: Stage, p: Payloads): number {
  switch (stage) {
    case "builder":
      return builderPrompt(
        { ticketNumber: 1, ticketTitle: "Ticket 1", ticketBody: p.ticketBody, worktreePath: ".worktrees/ticket-1", branch: "z/ticket-1-demo", baseBranch: "main" },
        INPUT_PATH
      ).length;
    case "qa":
      return qaPrompt(
        { ticketNumber: 1, ticketBody: p.ticketBody, worktreePath: ".worktrees/ticket-1", branch: "z/ticket-1-demo", qaPass: 1, webTarget: false },
        INPUT_PATH
      ).length;
    case "reviewer":
      return reviewerPrompt(
        { ticketBody: p.ticketBody, acceptanceCriteria: p.acceptanceCriteria, diff: p.diff, worktreePath: "/tmp/review-1" },
        INPUT_PATH
      ).length;
    case "merge":
      return mergePrompt(
        { ticketNumber: 1, prTitle: "Ticket 1", branch: "z/ticket-1-demo", baseBranch: "main", worktreePath: ".worktrees/ticket-1", stackedOn: [] },
        INPUT_PATH
      ).length;
  }
}

// Baseline prompt bytes = the SAME boilerplate the pointer prompt carries (that
// is essentially all the after-prompt is) PLUS the inlined payload. So
// baseline - after == payloadBytes(stage): the exact bytes #57 stops routing
// through the orchestrator's context per spawn. Folding the ~150-byte pointer
// reference line into "boilerplate" overstates baseline by <1% of the payload --
// immaterial to a >=60% ratio, and conservative if anything.
function baselinePromptBytes(stage: Stage, p: Payloads): number {
  return afterPromptBytes(stage, p) + payloadBytes(stage, p);
}

// Leak 2: the per-iteration bash the orchestrator re-reads every tick. Baseline
// is the pre-#57 ~15-line snapshot+ingest+next block (faithfully modeled on
// z-loop/SKILL.md Step 4, same structure and line count); after is the exact
// single z-loop-tick line #57 replaces it with.
export const BASELINE_TICK = `for S in Backlog Ready Questions Building QA Review Blocked Skipped Done; do
  "$Z_BOARD" list --status "$S" --json --slug "$SLUG" > "$TMP/items-$S.json"
done
jq -s 'add' "$TMP"/items-*.json > "$TMP/items.json"
jq -r '.[].number' "$TMP/items.json" | while read -r N; do
  gh issue view "$N" --json body -q .body > "$TMP/body-$N.md"
done
bun -e "import {readFileSync, readdirSync, writeFileSync} from 'node:fs';
  const b = {}; for (const f of readdirSync('$TMP')) {
    const m = f.match(/body-(number).md/); if (m) b[m[1]] = readFileSync('$TMP/' + f, 'utf8'); }
  writeFileSync('$TMP/bodies.json', JSON.stringify(b));"
bun "$PACK/lib/loop.ts" ingest "$STATE" "$TMP/items.json" "$TMP/bodies.json"
bun "$PACK/lib/loop.ts" next "$STATE"`;

export const AFTER_TICK = `ACTION=$("$PACK/bin/z-loop-tick" --slug "$SLUG" --state "$STATE" --tmp "$TMP")`;

const HAPPY: Record<Stage, string> = {
  builder: "BUILT: ok",
  qa: "QA-PASS: ok",
  reviewer: "REVIEW-APPROVE: ok",
  merge: "MERGED: https://pr/1",
};

export interface DrainStats {
  spawns: { ticket: number; stage: Stage }[];
  iterations: number; // number of `next` calls == number of drain ticks
  ticketsDrained: number;
}

// Drive the REAL scheduler to drain N independent tickets on the happy path,
// recording every stage spawn (a claim spawns builder; an advance spawns its
// target stage) and every `next` call (one per tick the orchestrator runs).
export function simulateDrain(nTickets: number): DrainStats {
  let s: LoopState = {
    tickets: Array.from({ length: nTickets }, (_, i) => ({ number: i + 1, title: `Ticket ${i + 1}`, status: "Building", dependsOn: [], model: "sonnet" }) as TicketSnapshot),
    lanes: [],
    maxLanes: 3,
    watchdogMinutes: 10,
    mergedThisRun: [],
  };
  const spawns: { ticket: number; stage: Stage }[] = [];
  let iterations = 0;
  for (let i = 0; i < 5000; i++) {
    const a = nextAction(s.tickets, s.lanes, { nowMs: 0, maxLanes: s.maxLanes, watchdogMinutes: s.watchdogMinutes, mergedThisRun: s.mergedThisRun });
    iterations++;
    if (a.kind === "drain-complete") return { spawns, iterations, ticketsDrained: nTickets };
    if (a.kind === "wait") {
      const idle = s.lanes.find((l) => !l.outcome);
      if (!idle) throw new Error("simulateDrain: wait with no lane to progress -- scheduler stuck");
      s = recordOutcome(s, idle.ticket, HAPPY[idle.stage], 0);
      continue;
    }
    if (a.kind === "check-worker") throw new Error("simulateDrain: unexpected watchdog on the happy path");
    // A claim spawns builder; an advance spawns its target stage. complete (after
    // a merge) and any park/skip just mutate state -- no spawn, but still applied.
    if (a.kind === "claim") spawns.push({ ticket: a.ticket, stage: a.stage });
    else if (a.kind === "advance") spawns.push({ ticket: a.ticket, stage: a.to });
    s = applyAction(s, a, 0);
  }
  throw new Error("simulateDrain: no drain-complete within 5000 steps");
}

export interface Measurement {
  ticketsDrained: number;
  spawns: number;
  iterations: number;
  baselineTotal: number;
  afterTotal: number;
  baselinePerTicket: number;
  afterPerTicket: number;
  reductionPct: number;
}

export const THRESHOLD_PCT = 60;

export function measure(nTickets: number, p: Payloads = defaultPayloads()): Measurement {
  const { spawns, iterations, ticketsDrained } = simulateDrain(nTickets);
  let baselineTotal = 0;
  let afterTotal = 0;
  for (const sp of spawns) {
    baselineTotal += baselinePromptBytes(sp.stage, p);
    afterTotal += afterPromptBytes(sp.stage, p);
  }
  baselineTotal += iterations * BASELINE_TICK.length;
  afterTotal += iterations * AFTER_TICK.length;
  return {
    ticketsDrained,
    spawns: spawns.length,
    iterations,
    baselineTotal,
    afterTotal,
    baselinePerTicket: baselineTotal / ticketsDrained,
    afterPerTicket: afterTotal / ticketsDrained,
    reductionPct: (1 - afterTotal / baselineTotal) * 100,
  };
}

export function report(m: Measurement): string {
  const tok = (n: number) => Math.round(n / 4); // ~4 chars/token; the ratio is tokenizer-invariant
  return [
    `orchestrator-context drain eval (synthetic ${m.ticketsDrained}-ticket happy-path drain)`,
    `  stage spawns: ${m.spawns}   drain ticks (next calls): ${m.iterations}`,
    `  baseline per-ticket: ${m.baselinePerTicket.toFixed(0)} chars (~${tok(m.baselinePerTicket)} tok)  <- recorded ceiling`,
    `  after    per-ticket: ${m.afterPerTicket.toFixed(0)} chars (~${tok(m.afterPerTicket)} tok)`,
    `  reduction: ${m.reductionPct.toFixed(1)}%   (threshold >= ${THRESHOLD_PCT}%)`,
    `  VERDICT: ${m.reductionPct >= THRESHOLD_PCT ? "PASS" : "FAIL"}`,
  ].join("\n");
}

export function main(argv: string[]): number {
  const n = Number(argv[0] ?? "6");
  const m = measure(Number.isFinite(n) && n > 0 ? Math.floor(n) : 6);
  console.log(report(m));
  return m.reductionPct >= THRESHOLD_PCT ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
