// Read-only board dashboard (C9): pure function to render the /z-status skill.
// Takes a snapshot of the board + locks + last report + the current ms, returns markdown.
// No mutations, no side effects: the SKILL assembles the snapshot and writes output.
import { readFileSync } from "node:fs";
import { handleCliError, parseFlags, readJson, requireFlag, str } from "./cli.ts";
import { ZError } from "./config.ts";
import { listLaneLocks } from "./locks.ts";
import type { BoardItem } from "./board.ts";
import type { LaneLock } from "./locks.ts";
import { BOARD_STATUSES } from "./loop.ts";

export interface StatusReportInput {
  boardItems: BoardItem[];
  laneLocks: { path: string; lock: LaneLock }[];
  lastReport: string | null; // path to newest reports/loop-*.md, or null if missing
  nowMs: number; // injected for testing; the wall clock only enters at the CLI edge
}

// Pure markdown render of the board status at this moment: ticket counts per
// all nine statuses, Questions and Blocked tickets listed, in-flight lanes with
// their age, last loop report summary (path + verdict line), and Estimate vs
// Actual totals for the milestone. No mutations, deterministic.
export function buildStatusReport(input: StatusReportInput): string {
  const { laneLocks, lastReport, nowMs } = input;

  // Belt-and-braces vs snapshot races (F11): the SKILL pipeline takes ONE
  // atomic z-board snapshot, but if a future caller ever feeds overlapping
  // per-status snapshots again, a ticket moving mid-scan appears twice. Keep
  // the first occurrence per issue number, count the rest, and say so below --
  // silently double-counted totals are worse than a flagged degraded report.
  const seenNumbers = new Set<number>();
  const boardItems: BoardItem[] = [];
  let dupesDropped = 0;
  for (const item of input.boardItems) {
    if (seenNumbers.has(item.number)) {
      dupesDropped++;
      continue;
    }
    seenNumbers.add(item.number);
    boardItems.push(item);
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

  // Last loop report summary: read the file and extract the verdict line.
  // Only a MISSING file means "no prior loops" (fresh board); any other read
  // failure (EISDIR, EACCES, ...) must not render a plausible-but-false
  // history-less dashboard -- fail loud, naming the path (F13).
  let reportLine = "";
  if (lastReport) {
    let content: string | null = null;
    try {
      content = readFileSync(lastReport, "utf8");
    } catch (e: any) {
      if (e?.code !== "ENOENT") {
        throw new ZError(`Cannot read last report ${lastReport}: ${e?.message ?? e}`);
      }
    }
    if (content !== null) {
      const match = content.match(/^\*\*Verdict:\*\*\s+(.+)$/m);
      if (match) {
        const verdictPath = lastReport.split(/[\\/]/).pop() || lastReport;
        reportLine = `${verdictPath}: ${match[1]}`;
      }
    }
  }

  // Build the markdown report: one count line per canonical status, computed
  // inline so no partially-filled Record<BoardStatus, number> ever exists
  // (issue #14 item 20: `= {}` was a strict-mode lie about totality).
  const statusCounts = BOARD_STATUSES.map(
    (s) => `- ${s}: ${boardItems.filter((item) => item.fields["Status"] === s).length}`
  ).join("\n");

  const questionsSection = questionTickets.length ? questionTickets.join("\n") : "- None.";
  const blockedSection = blockedTickets.length ? blockedTickets.join("\n") : "- None.";
  const lanesSection = laneLines.length ? laneLines.join("\n") : "- None (board is idle).";
  const reportSection = reportLine ? reportLine : "(no prior loops)";
  const dupeWarning = dupesDropped
    ? `\n> Warning: dropped ${dupesDropped} duplicate board item(s) (same issue number seen more than once in the snapshot); counts and totals use the first occurrence.\n`
    : "";

  return `# z-status — Board Dashboard
${dupeWarning}
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

      // readJson wraps parse failures in ZError (F15): a corrupt snapshot file
      // exits 1 with an actionable message, never a raw stack trace.
      const boardItemsJson = readJson(boardItemsFile) as BoardItem[];

      // Load lane locks from directory
      const laneLocks = listLaneLocks(locksDir);

      const report = buildStatusReport({
        boardItems: boardItemsJson,
        laneLocks,
        lastReport: lastReportFile || null,
        nowMs: Date.now(),
      });

      console.log(report);
      return 0;
    }

    console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
    return 1;
  } catch (e) {
    return handleCliError(e);
  }
}

if (import.meta.main) {
  // main() is synchronous -- a .then() here TypeErrors after the report prints
  // and turns every successful render into exit 1 (issue #14 item 15).
  process.exit(main(process.argv.slice(2)));
}
