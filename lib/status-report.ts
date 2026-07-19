// Read-only board dashboard (C9): pure function to render the /z-status skill.
// Takes a snapshot of the board + locks + last report + clock, returns markdown.
// No mutations, no side effects: the SKILL assembles the snapshot and writes output.
import { readFileSync } from "node:fs";
import { ZError, listLaneLocks } from "./locks.ts";
import type { BoardItem } from "./board.ts";
import type { LaneLock } from "./locks.ts";
import { BOARD_STATUSES, type BoardStatus } from "./loop.ts";

export { ZError } from "./config.ts";

export interface StatusReportInput {
  boardItems: BoardItem[];
  laneLocks: { path: string; lock: LaneLock }[];
  lastReport: string | null; // path to newest reports/loop-*.md, or null if missing
  clock: () => number; // injected for testing; returns current ms
}

// Pure markdown render of the board status at this moment: ticket counts per
// all nine statuses, Questions and Blocked tickets listed, in-flight lanes with
// their age, last loop report summary (path + verdict line), and Estimate vs
// Actual totals for the milestone. No mutations, deterministic.
export function buildStatusReport(input: StatusReportInput): string {
  const { boardItems, laneLocks, lastReport, clock } = input;
  const nowMs = clock();

  // Count tickets per status
  const counts: Record<BoardStatus, number> = {};
  for (const status of BOARD_STATUSES) {
    counts[status] = boardItems.filter((item) => item.fields["Status"] === status).length;
  }

  // Questions and Blocked tickets with their numbers and titles
  const questionTickets = boardItems
    .filter((item) => item.fields["Status"] === "Questions")
    .map((item) => `- #${item.number} ${item.title}`);
  const blockedTickets = boardItems
    .filter((item) => item.fields["Status"] === "Blocked")
    .map((item) => `- #${item.number} ${item.title}`);

  // In-flight lanes with age
  const laneLines = laneLocks.map((entry) => {
    const { lock } = entry;
    const ageMs = nowMs - lock.claimedAt;
    const ageMins = Math.floor(ageMs / 60_000);
    const ageStr = ageMins < 1 ? "< 1m" : `${ageMins}m`;
    return `- Ticket #${lock.ticket} (${lock.stage}): ${ageStr}`;
  });

  // Estimate vs Actual totals: sum the Estimate and Actual fields across all items
  let totalEstimate = 0;
  let totalActual = 0;
  for (const item of boardItems) {
    const est = item.fields["Estimate"];
    const act = item.fields["Actual"];
    if (typeof est === "number") totalEstimate += est;
    if (typeof act === "number") totalActual += act;
  }

  // Last loop report summary: read the file and extract the verdict line
  let reportLine = "";
  if (lastReport) {
    try {
      const content = readFileSync(lastReport, "utf8");
      const match = content.match(/^\*\*Verdict:\*\*\s+(.+)$/m);
      if (match) {
        const verdictPath = lastReport.split(/[\\/]/).pop() || lastReport;
        reportLine = `${verdictPath}: ${match[1]}`;
      }
    } catch {
      // If the report can't be read, skip the summary line
    }
  }

  // Build the markdown report
  const statusCounts = BOARD_STATUSES.map((s) => `- ${s}: ${counts[s]}`).join("\n");

  const questionsSection = questionTickets.length ? questionTickets.join("\n") : "- None.";
  const blockedSection = blockedTickets.length ? blockedTickets.join("\n") : "- None.";
  const lanesSection = laneLines.length ? laneLines.join("\n") : "- None (board is idle).";
  const reportSection = reportLine ? reportLine : "(no prior loops)";

  return `# z-status — Board Dashboard

## Ticket Counts

${statusCounts}

## Waiting on Human

### Questions

${questionsSection}

### Blocked

${blockedSection}

## In-Flight Lanes

${lanesSection}

## Last Loop

${reportSection}

## Milestone Totals

- Estimate: $${totalEstimate.toFixed(2)}
- Actual: $${totalActual.toFixed(2)}
`;
}

// -- CLI -----------------------------------------------------------------------

const USAGE = `status <command> [args]

  report --board-items FILE --locks-dir DIR [--last-report FILE]
                                               build markdown report from snapshot`;

interface Parsed {
  flags: Record<string, string | boolean>;
}

function parseFlags(args: string[]): Parsed {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      flags[key] = args[++i];
    }
  }
  return { flags };
}

function str(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

function requireFlag(flags: Record<string, string | boolean>, name: string): string {
  const v = str(flags, name);
  if (!v) throw new ZError(`Missing required --${name}.`);
  return v;
}

export function main(argv: string[]): number {
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }

  try {
    if (cmd === "report") {
      const { flags } = parseFlags(argv.slice(1));
      const boardItemsFile = requireFlag(flags, "board-items");
      const locksDir = requireFlag(flags, "locks-dir");
      const lastReportFile = str(flags, "last-report");

      // Load board items from JSON file
      const boardItemsJson = JSON.parse(readFileSync(boardItemsFile, "utf8")) as BoardItem[];

      // Load lane locks from directory
      const laneLocks = listLaneLocks(locksDir);

      const report = buildStatusReport({
        boardItems: boardItemsJson,
        laneLocks,
        lastReport: lastReportFile || null,
        clock: () => Date.now(),
      });

      console.log(report);
      return 0;
    }

    console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
    return 1;
  } catch (e) {
    if (e instanceof ZError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
