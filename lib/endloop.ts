// The End-of-Loop stage (C8, issue #9): PROCESS.md steps 22-23 as deterministic
// space. After the batch drains, the SKILL runs a regression on merged main and
// hands the verdict here; endLoopPlan decides what happens next -- never in
// prose. Red never deploys; green walks the deploy chain in a fixed order;
// every 5th loop appends the security + quality audits. The report builder
// turns the whole run into the markdown the SKILL writes to disk.
//
// Deliberately free of every gh/skill side effect: no z-board create, no Skill
// tool call, no network. This file only plans (endLoopPlan), persists one
// integer (the loop counter), drafts bug-ticket content as data, and renders
// markdown. The SKILL performs every actual side effect and feeds this file's
// pure outputs into them (bin/z-board create, the Skill tool, lib/skill-invoker
// for the audit log).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite, handleCliError, readJson } from "./cli.ts";
import { TERMINAL_STATUSES, ZError, projectsDir } from "./config.ts";
import type { CompletionEdge } from "./stage-prompts.ts";

export { ZError } from "./config.ts";
export type { CompletionEdge } from "./stage-prompts.ts";

// -- regression result ---------------------------------------------------------

export type RegressionVerdict = "red" | "green";

// One thing the regression found broken. repro + firstSuspectFile are exactly
// the two things the Red path deliverable requires in a filed bug's body.
export interface Finding {
  title: string; // one-line finding, e.g. "typecheck: 3 errors in lib/foo.ts"
  repro: string; // concrete repro steps: do X, expect Y, got Z
  firstSuspectFile: string; // best-guess file to start investigating
}

export interface RegressionResult {
  verdict: RegressionVerdict;
  // What ran and what it found: typecheck/full suite/build/e2e (where web
  // changed) + gstack /qa-only, always present regardless of verdict.
  evidence: string;
  findings: Finding[]; // non-empty iff verdict === "red"
}

// -- the plan -------------------------------------------------------------------

export type EndLoopActionKind =
  | "file-bugs" // red only: every finding -> a Backlog bug (repro + first-suspect file)
  | "land-and-deploy" // green only, in this fixed order
  | "canary"
  | "document-release"
  | "cso" // green + 5th loop only
  | "health" // green + 5th loop only
  | "report"; // always last

// PROCESS.md steps 22-23 as one pure decision. Red regression: file every
// finding, write the report, NO deploy action appears anywhere in the plan.
// Green: the deploy chain in exactly this order, with the 5th-loop security +
// quality audits appended before the report when loopCount % 5 === 0. loopCount
// is the value AFTER this loop's increment (bumpLoopCounter's return), so
// "loop 5" means loopCount === 5, not the pre-increment read.
export function endLoopPlan(regression: RegressionResult, loopCount: number): EndLoopActionKind[] {
  if (!Number.isInteger(loopCount) || loopCount < 1) {
    throw new ZError(`loopCount must be a positive integer (the post-increment loop counter), got ${loopCount}.`);
  }
  if (regression.verdict === "red") {
    if (regression.findings.length === 0) {
      throw new ZError("Red regression verdict carries zero findings -- nothing to file. Check the regression gate wiring before trusting this result.");
    }
    return ["file-bugs", "report"];
  }
  const plan: EndLoopActionKind[] = ["land-and-deploy", "canary", "document-release"];
  if (loopCount % 5 === 0) plan.push("cso", "health");
  plan.push("report");
  return plan;
}

// -- loop counter: read/increment/persist, atomic write, missing file = 0 -------

export function defaultLoopCounterPath(slug: string, home = homedir()): string {
  return join(projectsDir(home), slug, "loop-counter");
}

// Counter writes go through lib/cli.ts atomicWrite (tmp + rename) so a
// concurrent reader never observes a half-written counter.

// Missing file reads as 0 (no loops completed yet). A present-but-unparseable
// file is a loud error, never a silent reset -- a corrupt counter is exactly
// the kind of bug that should stop the loop, not quietly re-run the 5th-loop
// audits on the wrong cadence.
export function readLoopCounter(path: string): number {
  if (!existsSync(path)) return 0;
  const raw = readFileSync(path, "utf8").trim();
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new ZError(`Loop counter at ${path} is corrupt: expected a non-negative integer, got ${JSON.stringify(raw)}.`);
  }
  return n;
}

export function writeLoopCounter(path: string, value: number): void {
  atomicWrite(path, `${value}\n`);
}

// The single read-increment-persist cycle the SKILL calls ONCE per loop, at the
// very end (after the report). Kept crash-safe by pairing with peekLoopCounter:
// the loop computes its plan from the peek (no write) and only persists here, so
// a crash before this point re-runs the same loop id rather than drifting the
// 5th-loop cadence forward by one (issue #14 H17).
export function bumpLoopCounter(path: string): number {
  const next = readLoopCounter(path) + 1;
  writeLoopCounter(path, next);
  return next;
}

// The prospective post-increment count WITHOUT persisting it (issue #14 H17). The
// SKILL peeks this at the START of the end-of-loop stage to size the plan (the
// 5th-loop cadence), does all its work, then calls bumpLoopCounter AFTER the
// report -- so peek and the later bump return the same value on a clean run, and a
// crash in between leaves the counter untouched for a clean re-run (no drift).
export function peekLoopCounter(path: string): number {
  return readLoopCounter(path) + 1;
}

// -- bug-ticket drafting (pure data; the SKILL calls z-board create with it) ----

export interface BugTicketDraft {
  title: string;
  body: string;
}

// Formats a finding into Backlog-bug content: repro + first-suspect file, as
// the Red path deliverable requires. `source` names where the finding came
// from (regression / cso / health) so the filed ticket is traceable to the
// end-of-loop stage that found it (PROCESS.md step 23: "file bugs for
// everything found").
export function buildBugTicket(finding: Finding, source: "regression" | "cso" | "health", loopCount: number): BugTicketDraft {
  return {
    title: `[${source}] ${finding.title}`,
    body: `## Repro\n\n${finding.repro}\n\n## First suspect\n\n${finding.firstSuspectFile}\n\n_Filed by /z-loop end-of-loop (${source}), loop ${loopCount}._\n`,
  };
}

// -- report builder ---------------------------------------------------------

export interface TicketOutcome {
  number: number;
  title: string;
  status: string; // final board status: Done | Questions | Blocked | Skipped
  actualDollars: number;
}

// One ticket's completion-note edges (lib/stage-prompts.ts CompletionEdge),
// tagged with the ticket they surfaced from so the rollup can attribute each.
export interface TicketEdges {
  ticket: number;
  edges: CompletionEdge[];
}

export interface BugFiled {
  number: number;
  title: string;
}

export interface EndLoopReportInput {
  regression: RegressionResult;
  loopCount: number;
  auditsRan: boolean; // true when cso + health ran this loop (the plan included them)
  tickets: TicketOutcome[];
  edges: TicketEdges[];
  bugsFiled: BugFiled[];
}

// Report row order = the canonical terminal set's order (lib/config.ts).

// Pure markdown render of the whole loop's outcome (issue #9 AC4): verdict with
// evidence, dollars (summed here from the Actuals passed in -- never re-priced
// or eyeballed), tickets by final status, the edges-to-validate rollup
// aggregated across every ticket's completion note, and every bug filed this
// stage. The SKILL writes the return value to reports/loop-<ts>.md verbatim.
export function buildEndLoopReport(input: EndLoopReportInput): string {
  const { regression, loopCount, auditsRan, tickets, edges, bugsFiled } = input;

  const totalDollars = tickets.reduce((sum, t) => sum + t.actualDollars, 0);

  const deployLine =
    regression.verdict === "red"
      ? "NO deploy -- regression is red. Every finding below is filed to Backlog with repro + first-suspect file; fix and re-run before shipping."
      : `land-and-deploy -> canary -> document-release completed, in that order.${auditsRan ? " 5th-loop audits (cso + health) also ran; findings below." : ""}`;

  const statusCounts = TERMINAL_STATUSES.map((s) => `- ${s}: ${tickets.filter((t) => t.status === s).length}`).join("\n");

  const ticketRows = tickets.length
    ? tickets.map((t) => `| #${t.number} | ${t.title} | ${t.status} | $${t.actualDollars.toFixed(2)} |`).join("\n")
    : "| -- | (no tickets in this batch) | -- | -- |";

  const edgeLines = edges.flatMap((te) =>
    te.edges.map((e) => `- #${te.ticket}: to check ${e.check}, do ${e.doStep}, expect ${e.expect}.`)
  );
  const edgesSection = edgeLines.length ? edgeLines.join("\n") : "- None surfaced.";

  const bugLines = bugsFiled.length ? bugsFiled.map((b) => `- #${b.number} ${b.title}`).join("\n") : "- None filed.";

  return `# End-of-loop report -- loop ${loopCount}

**Verdict:** ${regression.verdict.toUpperCase()} -- ${regression.evidence}

**Deploy:** ${deployLine}

**Total spend:** $${totalDollars.toFixed(2)} (sum of ticket Actuals)

## Tickets by final status

${statusCounts}

| # | Title | Status | Actual |
|---|---|---|---|
${ticketRows}

## Edges a human must validate

${edgesSection}

## Bugs filed to Backlog

${bugLines}
`;
}

// -- CLI ----------------------------------------------------------------------

const USAGE = `endloop <command> [args]

  plan <regression.json> <loopCount>              print the ordered EndLoopActionKind[] as JSON
  counter read <path>                             print the current loop counter (0 if missing)
  counter peek <path>                             print the prospective next count (read+1), NO write
  counter bump <path>                             increment + persist atomically, print the new value
  bug <finding.json> <regression|cso|health> <loopCount>   print a BugTicketDraft {title, body} as JSON
  report <input.json>                             print the markdown end-of-loop report (EndLoopReportInput)`;

export function main(argv: string[]): number {
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  try {
    if (cmd === "plan") {
      const path = argv[1];
      const loopCount = Number(argv[2]);
      if (!path || !Number.isInteger(loopCount)) throw new ZError(`Usage: endloop plan <regression.json> <loopCount>`);
      const regression = readJson(path) as RegressionResult;
      console.log(JSON.stringify(endLoopPlan(regression, loopCount)));
      return 0;
    }
    if (cmd === "counter") {
      const sub = argv[1];
      const path = argv[2];
      if (!path || (sub !== "read" && sub !== "peek" && sub !== "bump")) throw new ZError(`Usage: endloop counter <read|peek|bump> <path>`);
      const value = sub === "read" ? readLoopCounter(path) : sub === "peek" ? peekLoopCounter(path) : bumpLoopCounter(path);
      console.log(String(value));
      return 0;
    }
    if (cmd === "bug") {
      const path = argv[1];
      const source = argv[2];
      const loopCount = Number(argv[3]);
      if (!path || (source !== "regression" && source !== "cso" && source !== "health") || !Number.isInteger(loopCount)) {
        throw new ZError(`Usage: endloop bug <finding.json> <regression|cso|health> <loopCount>`);
      }
      const finding = readJson(path) as Finding;
      console.log(JSON.stringify(buildBugTicket(finding, source, loopCount)));
      return 0;
    }
    if (cmd === "report") {
      const path = argv[1];
      if (!path) throw new ZError(`Usage: endloop report <input.json>`);
      const input = readJson(path) as EndLoopReportInput;
      console.log(buildEndLoopReport(input));
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
