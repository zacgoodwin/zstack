// The e2e eval's assertion library. Every assertion is a deterministic check over
// the artifacts one /z-loop run leaves behind (a live run's `~/.zstack/projects/
// <slug>/...`, or the hand-authored `fixtures/sample-run/` when a live board is
// unavailable). It maps the epic's Definition of Done to executable checks --
// see ../README.md for the traceability table.
//
// The load-bearing move: the "walk", "lane-cap", and "fresh-context" checks do
// not trust a recorded trace -- they RE-DERIVE the run by driving the real
// scheduler (lib/loop.ts) from the recorded starting board (state-initial.json)
// with a happy-path outcome oracle, then assert the emergent properties. So the
// checker exercises the actual state machine, not a transcript of it. The other
// checks validate the recorded outputs (board, report, notes, transcripts,
// invocation log) and cross-reference them against that derivation.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyAction,
  nextAction,
  recordOutcome,
  type Action,
  type LaneState,
  type LoopState,
  type Stage,
} from "../../lib/loop.ts";
import { completionNote, reviewerPrompt, type CompletionNoteInput } from "../../lib/stage-prompts.ts";
import { costOfFiles, expandGlob, loadRates, ratesPath } from "../../lib/cost.ts";
import { SKILL_NAMES } from "../../lib/skill-invoker.ts";

export interface AssertionResult {
  name: string;
  pass: boolean;
  detail: string;
}

function ok(name: string, detail: string): AssertionResult {
  return { name, pass: true, detail };
}
function fail(name: string, detail: string): AssertionResult {
  return { name, pass: false, detail };
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function firstGlob(runDir: string, pattern: string): string | null {
  const matches = [...new Bun.Glob(pattern).scanSync({ cwd: runDir })].sort();
  return matches.length ? join(runDir, matches[0]) : null;
}

// -- board item shape (lib/board.ts BoardItem) --------------------------------

interface BoardItem {
  number: number;
  title: string;
  url: string;
  fields: Record<string, string | number>;
}

// -- happy-path oracle + run derivation ---------------------------------------

// The outcome every stage returns on a fully-successful run. Feeding these back
// through recordOutcome is exactly what the orchestrator does when a stage agent
// finishes; here they resolve instantly so the derivation is synchronous.
export function happyOutcome(stage: Stage, ticket: number): string {
  switch (stage) {
    case "builder":
      return "BUILT: acceptance criteria pass, tests green, committed.";
    case "qa":
      return "QA-PASS: functional and technical checks green.";
    case "reviewer":
      return "REVIEW-APPROVE: every criterion verified against the diff.";
    case "merge":
      return `MERGED: https://github.com/acme/fixture-app/pull/${ticket}`;
  }
}

// LaneState's full key set. Anything outside this -- especially a conversation /
// session / context id -- would mean latent state travels between stages, which
// the "one fresh agent per stage" rule forbids (PROCESS.md, issue #3 AC).
const ALLOWED_LANE_KEYS = new Set(["ticket", "stage", "lastActivityMs", "qaBounces", "workerDead", "outcome"]);
const FORBIDDEN_LANE_KEY = /conversation|session|context|thread|agent.?id|history|transcript/i;

export interface SimTrace {
  statusHistory: Map<number, string[]>;
  maxObservedLanes: number;
  completionOrder: number[];
  finalState: LoopState;
  laneKeySets: Set<string>;
}

// Drives the real scheduler to drain, recording every emergent fact the checks
// need. Pure over its inputs (structuredClone of the initial state); the clock
// is a monotonic counter so the watchdog never trips on this instant run.
export function deriveRun(initial: LoopState, oracle = happyOutcome): SimTrace {
  let state: LoopState = structuredClone(initial);
  const statusHistory = new Map<number, string[]>();
  const laneKeySets = new Set<string>();
  const completionOrder: number[] = [];
  let maxObservedLanes = 0;
  let now = 0;

  const recordStatuses = () => {
    for (const t of state.tickets) {
      const h = statusHistory.get(t.number) ?? [];
      if (h[h.length - 1] !== t.status) h.push(t.status);
      statusHistory.set(t.number, h);
    }
  };
  const captureLanes = () => {
    for (const lane of state.lanes) laneKeySets.add(Object.keys(lane).sort().join(","));
    maxObservedLanes = Math.max(maxObservedLanes, state.lanes.length);
  };
  recordStatuses();

  for (let i = 0; i < 1000; i++) {
    now += 1;
    const action: Action = nextAction(state.tickets, state.lanes, {
      nowMs: now,
      maxLanes: state.maxLanes,
      watchdogMinutes: state.watchdogMinutes,
      mergedThisRun: state.mergedThisRun,
    });
    if (action.kind === "drain-complete") return { statusHistory, maxObservedLanes, completionOrder, finalState: state, laneKeySets };
    if (action.kind === "wait" || action.kind === "check-worker") {
      throw new Error(`Happy-path derivation hit an unexpected "${action.kind}" -- the recorded run is not the clean success this checker models.`);
    }
    if (action.kind === "complete") completionOrder.push(action.ticket);
    state = applyAction(state, action, now);
    captureLanes();
    if (action.kind === "claim") state = recordOutcome(state, action.ticket, oracle(action.stage, action.ticket), now);
    if (action.kind === "advance") state = recordOutcome(state, action.ticket, oracle(action.to, action.ticket), now);
    captureLanes();
    recordStatuses();
  }
  throw new Error("Happy-path derivation did not drain within 1000 steps -- likely a scheduling bug or a bad initial state.");
}

// -- individual assertions ----------------------------------------------------

const REQUIRED_WALK = ["Building", "QA", "Review", "Done"];

export function assertWalk(trace: SimTrace): AssertionResult {
  const problems: string[] = [];
  for (const [ticket, history] of trace.statusHistory) {
    for (const stage of REQUIRED_WALK) {
      if (!history.includes(stage)) problems.push(`#${ticket} never entered ${stage} (saw ${history.join(" -> ")})`);
    }
    if (history[history.length - 1] !== "Done") problems.push(`#${ticket} did not end in Done (ended ${history[history.length - 1]})`);
    // order: Building before QA before Review before Done
    const idx = (s: string) => history.indexOf(s);
    if (idx("Building") > idx("QA") || idx("QA") > idx("Review") || idx("Review") > idx("Done")) {
      problems.push(`#${ticket} walked its stages out of order: ${history.join(" -> ")}`);
    }
  }
  return problems.length
    ? fail("walk", problems.join("; "))
    : ok("walk", `every ticket walked Building -> QA -> Review -> Done (${trace.statusHistory.size} tickets)`);
}

export function assertLaneCap(trace: SimTrace, maxLanes: number): AssertionResult {
  return trace.maxObservedLanes <= maxLanes
    ? ok("lane-cap", `peak concurrent lanes ${trace.maxObservedLanes} <= cap ${maxLanes}`)
    : fail("lane-cap", `peak concurrent lanes ${trace.maxObservedLanes} exceeded the cap of ${maxLanes}`);
}

// Merge order is the RECORDED artifact (state-final.mergedThisRun): the order
// tickets completed this run. It must be a topological order of the dependency
// graph (no ticket lands before a dependency) and match the derived order.
export function assertMergeOrder(recordedFinal: LoopState, trace: SimTrace): AssertionResult {
  const order = recordedFinal.mergedThisRun ?? [];
  const deps = new Map(recordedFinal.tickets.map((t) => [t.number, t.dependsOn ?? []]));
  const seen = new Set<number>();
  for (const t of order) {
    for (const d of deps.get(t) ?? []) {
      if (deps.has(d) && !seen.has(d)) {
        return fail("merge-order", `#${t} merged before its dependency #${d} (recorded order [${order.join(", ")}])`);
      }
    }
    seen.add(t);
  }
  const derived = trace.completionOrder;
  if (JSON.stringify(order) !== JSON.stringify(derived)) {
    return fail("merge-order", `recorded merge order [${order.join(", ")}] disagrees with the scheduler's derived order [${derived.join(", ")}]`);
  }
  return ok("merge-order", `merged in dependency order [${order.join(", ")}]`);
}

export function assertFreshContext(trace: SimTrace): AssertionResult {
  for (const keySet of trace.laneKeySets) {
    const keys = keySet.split(",").filter(Boolean);
    for (const k of keys) {
      if (FORBIDDEN_LANE_KEY.test(k)) return fail("fresh-context", `a lane object carried a latent key "${k}" -- state leaked between stages`);
      if (!ALLOWED_LANE_KEYS.has(k)) return fail("fresh-context", `a lane object carried an unexpected key "${k}" (allowed: ${[...ALLOWED_LANE_KEYS].join(", ")})`);
    }
  }
  return ok("fresh-context", `lane state carried only ${[...ALLOWED_LANE_KEYS].join("/")} across every stage -- nothing latent travels`);
}

// The reviewer-blindness gate as an e2e check: every recorded reviewer input is
// fed through the REAL reviewerPrompt, which throws unless the input is exactly
// {ticketBody, acceptanceCriteria, diff, worktreePath}. A leaked PR description
// or transcript would add a key and this fails.
export function assertReviewerBlindness(runDir: string, ticketNumbers: number[]): AssertionResult {
  const checked: number[] = [];
  for (const n of ticketNumbers) {
    const path = join(runDir, "stage-inputs", `ticket-${n}-reviewer.json`);
    let input: unknown;
    try {
      input = loadJson(path);
    } catch (e) {
      return fail("reviewer-blindness", `no reviewer input for #${n} at ${path} (${(e as Error).message})`);
    }
    try {
      // Throws if the key set is not exactly the four blinded keys.
      reviewerPrompt(input as Parameters<typeof reviewerPrompt>[0]);
      checked.push(n);
    } catch (e) {
      return fail("reviewer-blindness", `reviewer input for #${n} is not blinded: ${(e as Error).message}`);
    }
  }
  return ok("reviewer-blindness", `reviewer inputs for #${checked.join(", #")} are exactly the four blinded keys`);
}

// Actual field written AND transcript-accounted: every Done ticket has a numeric
// Actual > 0 on the board, and it equals z-cost over that ticket's transcripts
// (deterministic drift check, epic DoD 9).
export function assertActuals(runDir: string, board: BoardItem[]): AssertionResult {
  const rates = loadRates(ratesPath());
  const done = board.filter((b) => b.fields["Status"] === "Done");
  if (done.length === 0) return fail("actuals", "no Done tickets on the board to check Actuals for");
  const problems: string[] = [];
  for (const b of done) {
    const actual = b.fields["Actual"];
    if (typeof actual !== "number" || !(actual > 0)) {
      problems.push(`#${b.number} has no positive numeric Actual (got ${JSON.stringify(actual)})`);
      continue;
    }
    const files = expandGlob(join(runDir, "transcripts", `ticket-${b.number}`, "*.jsonl"));
    if (files.length === 0) {
      problems.push(`#${b.number} Actual ${actual} has no transcripts to account it against`);
      continue;
    }
    const priced = costOfFiles(files, rates).total;
    if (priced !== actual) problems.push(`#${b.number} Actual ${actual} != z-cost of its transcripts ${priced}`);
  }
  return problems.length
    ? fail("actuals", problems.join("; "))
    : ok("actuals", `every Done ticket's Actual is positive and matches z-cost of its transcripts (${done.length} tickets)`);
}

const RE_VERDICT = /\*\*Verdict:\*\*\s+(GREEN|RED)/;
const RE_TOTAL = /\*\*Total spend:\*\*\s+\$([0-9]+\.[0-9]{2})/;
const RE_LOOP = /# End-of-loop report -- loop (\d+)/;

export interface ReportFacts {
  path: string;
  text: string;
  verdict: "GREEN" | "RED";
  total: number;
  loopCount: number;
}

export function readReport(runDir: string): ReportFacts {
  const path = firstGlob(runDir, "reports/loop-*.md");
  if (!path) throw new Error("no reports/loop-*.md file found");
  const text = readFileSync(path, "utf8");
  const v = text.match(RE_VERDICT);
  const t = text.match(RE_TOTAL);
  const l = text.match(RE_LOOP);
  if (!v || !t || !l) throw new Error(`report at ${path} is missing verdict/total/loop header`);
  return { path, text, verdict: v[1] as "GREEN" | "RED", total: Number(t[1]), loopCount: Number(l[1]) };
}

export function assertReport(report: ReportFacts, board: BoardItem[]): AssertionResult {
  const sum =
    Math.round(
      board.filter((b) => b.fields["Status"] === "Done").reduce((s, b) => s + (Number(b.fields["Actual"]) || 0), 0) * 100
    ) / 100;
  if (report.total !== sum) {
    return fail("report", `report total $${report.total.toFixed(2)} != sum of board Actuals $${sum.toFixed(2)}`);
  }
  return ok("report", `report present with verdict ${report.verdict} and total $${report.total.toFixed(2)} = sum of Actuals`);
}

// The loop counter is honored two ways: the report's loop number equals the
// persisted counter, and the 5th-loop audits (cso + health) appear in the
// invocation log IFF the counter is a multiple of 5 (epic DoD 8).
export function assertLoopCounter(runDir: string, report: ReportFacts): AssertionResult {
  const counterPath = join(runDir, "loop-counter");
  const counter = Number(readFileSync(counterPath, "utf8").trim());
  if (!Number.isInteger(counter) || counter < 1) return fail("loop-counter", `loop-counter is not a positive integer (${counter})`);
  if (counter !== report.loopCount) return fail("loop-counter", `report says loop ${report.loopCount} but loop-counter file is ${counter}`);
  const invPath = firstGlob(runDir, "reports/invocations-*.jsonl");
  const invSkills = invPath
    ? readFileSync(invPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).skill as string)
    : [];
  const auditsPresent = invSkills.includes("cso") || invSkills.includes("health");
  const auditsExpected = counter % 5 === 0;
  if (auditsPresent !== auditsExpected) {
    return fail("loop-counter", `loop ${counter}: audits present=${auditsPresent} but expected=${auditsExpected} (cso+health fire only on every 5th loop)`);
  }
  return ok("loop-counter", `report loop ${counter} matches the counter; 5th-loop audits ${auditsExpected ? "present" : "correctly absent"}`);
}

export function assertCompletionNotes(runDir: string, report: ReportFacts, doneTickets: number[]): AssertionResult {
  const problems: string[] = [];
  for (const n of doneTickets) {
    const path = join(runDir, "notes", `note-${n}.json`);
    let note: CompletionNoteInput;
    try {
      note = loadJson<CompletionNoteInput>(path);
    } catch (e) {
      problems.push(`#${n}: no completion note (${(e as Error).message})`);
      continue;
    }
    if (!Array.isArray(note.edges) || note.edges.length === 0) {
      problems.push(`#${n}: completion note carries no edges for a human to validate`);
      continue;
    }
    const rendered = completionNote(note);
    for (const e of note.edges) {
      if (!e.check || !e.doStep || !e.expect) {
        problems.push(`#${n}: an edge is missing check/doStep/expect`);
        continue;
      }
      if (!rendered.includes(`To check ${e.check}`)) problems.push(`#${n}: rendered note is missing edge "${e.check}"`);
      // The end-of-loop report must roll every edge up (issue #9 AC4).
      if (!report.text.includes(`to check ${e.check}, do ${e.doStep}, expect ${e.expect}`)) {
        problems.push(`#${n}: edge "${e.check}" is not in the end-of-loop report's rollup`);
      }
    }
  }
  return problems.length
    ? fail("completion-notes", problems.join("; "))
    : ok("completion-notes", `every Done ticket carries edges, rendered and rolled into the report (${doneTickets.length} tickets)`);
}

// Green path: the invocation log is exactly the deploy chain in order, every
// name a known gstack skill (issue #9 AC2). Red path: no deploy skill ran.
const DEPLOY_CHAIN = ["land-and-deploy", "canary", "document-release"];

export function assertDeployChain(runDir: string, report: ReportFacts): AssertionResult {
  const invPath = firstGlob(runDir, "reports/invocations-*.jsonl");
  const skills = invPath
    ? readFileSync(invPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).skill as string)
    : [];
  for (const s of skills) {
    if (!(SKILL_NAMES as readonly string[]).includes(s)) return fail("deploy-chain", `invocation log names an unknown skill "${s}"`);
  }
  if (report.verdict === "RED") {
    const deployed = skills.filter((s) => DEPLOY_CHAIN.includes(s));
    return deployed.length === 0
      ? ok("deploy-chain", "red run invoked no deploy skill, as required")
      : fail("deploy-chain", `red run must not deploy, but invoked ${deployed.join(", ")}`);
  }
  const chain = skills.filter((s) => DEPLOY_CHAIN.includes(s));
  if (JSON.stringify(chain) !== JSON.stringify(DEPLOY_CHAIN)) {
    return fail("deploy-chain", `green deploy chain was [${chain.join(", ")}], expected [${DEPLOY_CHAIN.join(", ")}] in order`);
  }
  return ok("deploy-chain", `green run invoked land-and-deploy -> canary -> document-release in order`);
}

// -- the full run -------------------------------------------------------------

export function runAllAssertions(runDir: string): AssertionResult[] {
  const results: AssertionResult[] = [];
  const initial = loadJson<LoopState>(join(runDir, "state-initial.json"));
  const recordedFinal = loadJson<LoopState>(join(runDir, "state-final.json"));
  const board = loadJson<BoardItem[]>(join(runDir, "board-final.json"));
  const trace = deriveRun(initial);
  const doneTickets = board.filter((b) => b.fields["Status"] === "Done").map((b) => b.number);

  results.push(assertWalk(trace));
  results.push(assertLaneCap(trace, initial.maxLanes));
  results.push(assertMergeOrder(recordedFinal, trace));
  results.push(assertFreshContext(trace));
  results.push(assertReviewerBlindness(runDir, doneTickets));
  results.push(assertActuals(runDir, board));

  let report: ReportFacts | null = null;
  try {
    report = readReport(runDir);
  } catch (e) {
    results.push(fail("report", (e as Error).message));
  }
  if (report) {
    results.push(assertReport(report, board));
    results.push(assertLoopCounter(runDir, report));
    results.push(assertCompletionNotes(runDir, report, doneTickets));
    results.push(assertDeployChain(runDir, report));
  }
  return results;
}
