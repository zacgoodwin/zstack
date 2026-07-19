// Gate tests for C9 (issue #10): the /z-status read-only dashboard. Pure
// function tests against fixtures with injected clock, zero network.
//
//   AC1 full fixture render: all 9 statuses populated, lanes with age,
//        report summary with verdict, totals computed
//   AC2 mutation-free: grep contract enforcement (zero z-board mutating commands)
//   AC3 empty board / no locks / no reports: clean states, no errors
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatusReport, ZError, type StatusReportInput } from "../lib/status-report.ts";
import type { BoardItem } from "../lib/board.ts";
import type { LaneLock } from "../lib/locks.ts";

const REPO_ROOT = join(import.meta.dir, "..");

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "zstatus-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

// ============================================================================
// AC1 -- full fixture render: all 9 statuses, lanes, report, totals
// ============================================================================
describe("AC1: full fixture render with all statuses, lanes, report, totals", () => {
  test("renders all nine statuses with correct counts", () => {
    const items: BoardItem[] = [
      { number: 1, title: "Backlog ticket", url: "http://test", fields: { Status: "Backlog", Estimate: 5, Actual: 0 } },
      { number: 2, title: "Ready 1", url: "http://test", fields: { Status: "Ready", Estimate: 3, Actual: 0 } },
      { number: 3, title: "Ready 2", url: "http://test", fields: { Status: "Ready", Estimate: 2, Actual: 0 } },
      { number: 4, title: "Questions ticket", url: "http://test", fields: { Status: "Questions", Estimate: 1, Actual: 0.5 } },
      { number: 5, title: "Building ticket", url: "http://test", fields: { Status: "Building", Estimate: 4, Actual: 0 } },
      { number: 6, title: "QA ticket", url: "http://test", fields: { Status: "QA", Estimate: 3, Actual: 2 } },
      { number: 7, title: "Review ticket", url: "http://test", fields: { Status: "Review", Estimate: 2, Actual: 1.5 } },
      { number: 8, title: "Blocked ticket", url: "http://test", fields: { Status: "Blocked", Estimate: 6, Actual: 1 } },
      { number: 9, title: "Skipped ticket", url: "http://test", fields: { Status: "Skipped", Estimate: 1, Actual: 0 } },
      { number: 10, title: "Done ticket", url: "http://test", fields: { Status: "Done", Estimate: 2, Actual: 5 } },
    ];

    const report = buildStatusReport({
      boardItems: items,
      laneLocks: [],
      lastReport: null,
      clock: () => 0,
    });

    expect(report).toContain("Backlog: 1");
    expect(report).toContain("Ready: 2");
    expect(report).toContain("Questions: 1");
    expect(report).toContain("Building: 1");
    expect(report).toContain("QA: 1");
    expect(report).toContain("Review: 1");
    expect(report).toContain("Blocked: 1");
    expect(report).toContain("Skipped: 1");
    expect(report).toContain("Done: 1");
  });

  test("lists Questions and Blocked tickets by number and title", () => {
    const items: BoardItem[] = [
      { number: 4, title: "Fix typecheck failure", url: "http://test", fields: { Status: "Questions" } },
      { number: 8, title: "Waiting on review feedback", url: "http://test", fields: { Status: "Blocked" } },
      { number: 5, title: "Some other ticket", url: "http://test", fields: { Status: "Building" } },
    ];

    const report = buildStatusReport({
      boardItems: items,
      laneLocks: [],
      lastReport: null,
      clock: () => 0,
    });

    expect(report).toContain("#4 Fix typecheck failure");
    expect(report).toContain("#8 Waiting on review feedback");
    expect(report).not.toContain("#5 Some other ticket");
  });

  test("displays in-flight lanes with ticket, stage, and age", () => {
    const now = 1000 * 60 * 30; // 30 minutes
    const claimedAt = now - 1000 * 60 * 5; // 5 minutes ago

    const lanes: { path: string; lock: LaneLock }[] = [
      {
        path: "/locks/ticket-7.json",
        lock: { ticket: 7, stage: "builder", session: "sess-1", claimedAt },
      },
      {
        path: "/locks/ticket-9.json",
        lock: { ticket: 9, stage: "reviewer", session: "sess-2", claimedAt: now - 1000 * 60 * 45 },
      },
    ];

    const report = buildStatusReport({
      boardItems: [],
      laneLocks: lanes,
      lastReport: null,
      clock: () => now,
    });

    expect(report).toContain("Ticket #7 (builder): 5m");
    expect(report).toContain("Ticket #9 (reviewer): 45m");
  });

  test("extracts verdict line from last report file", () => {
    const dir = tmp();
    const reportPath = join(dir, "reports", "loop-1000.md");
    mkdirSync(join(dir, "reports"), { recursive: true });
    const content = `# End-of-loop report -- loop 1

**Verdict:** GREEN -- typecheck: 0 errors; suite: 243/243; build: pass

**Deploy:** land-and-deploy -> canary -> document-release completed, in that order.`;
    writeFileSync(reportPath, content);

    const report = buildStatusReport({
      boardItems: [],
      laneLocks: [],
      lastReport: reportPath,
      clock: () => 0,
    });

    expect(report).toContain("loop-1000.md: GREEN -- typecheck: 0 errors; suite: 243/243; build: pass");
  });

  test("computes Estimate and Actual totals across all tickets", () => {
    const items: BoardItem[] = [
      { number: 1, title: "T1", url: "http://test", fields: { Status: "Done", Estimate: 5.5, Actual: 4.25 } },
      { number: 2, title: "T2", url: "http://test", fields: { Status: "Done", Estimate: 3.0, Actual: 3.75 } },
      { number: 3, title: "T3", url: "http://test", fields: { Status: "Building", Estimate: 2.25, Actual: 0 } },
      // Missing Estimate or Actual in some tickets should be handled gracefully
      { number: 4, title: "T4", url: "http://test", fields: { Status: "Ready" } },
    ];

    const report = buildStatusReport({
      boardItems: items,
      laneLocks: [],
      lastReport: null,
      clock: () => 0,
    });

    expect(report).toContain("Estimate: $10.75");
    expect(report).toContain("Actual: $8.00");
  });

  test("render includes all major sections: counts, questions, blocked, lanes, last-loop, totals", () => {
    const report = buildStatusReport({
      boardItems: [{ number: 1, title: "A", url: "http://test", fields: { Status: "Done" } }],
      laneLocks: [],
      lastReport: null,
      clock: () => 0,
    });

    expect(report).toContain("# z-status — Board Dashboard");
    expect(report).toContain("## Ticket Counts");
    expect(report).toContain("## Waiting on Human");
    expect(report).toContain("### Questions");
    expect(report).toContain("### Blocked");
    expect(report).toContain("## In-Flight Lanes");
    expect(report).toContain("## Last Loop");
    expect(report).toContain("## Milestone Totals");
  });
});

// ============================================================================
// AC3 -- empty board / no locks / no reports: clean states, no errors
// ============================================================================
describe("AC3: empty board, no locks, no reports render cleanly", () => {
  test("empty board: all status counts are zero", () => {
    const report = buildStatusReport({
      boardItems: [],
      laneLocks: [],
      lastReport: null,
      clock: () => 0,
    });

    expect(report).toContain("Backlog: 0");
    expect(report).toContain("Ready: 0");
    expect(report).toContain("Questions: 0");
    expect(report).toContain("Building: 0");
    expect(report).toContain("QA: 0");
    expect(report).toContain("Review: 0");
    expect(report).toContain("Blocked: 0");
    expect(report).toContain("Skipped: 0");
    expect(report).toContain("Done: 0");
  });

  test("no questions or blocked tickets: sections show 'None'", () => {
    const items: BoardItem[] = [
      { number: 1, title: "Done", url: "http://test", fields: { Status: "Done" } },
      { number: 2, title: "Ready", url: "http://test", fields: { Status: "Ready" } },
    ];

    const report = buildStatusReport({
      boardItems: items,
      laneLocks: [],
      lastReport: null,
      clock: () => 0,
    });

    // Check for the None markers in questions and blocked sections
    const lines = report.split("\n");
    const questionIdx = lines.findIndex((l) => l.includes("### Questions"));
    const blockedIdx = lines.findIndex((l) => l.includes("### Blocked"));

    expect(questionIdx).toBeGreaterThanOrEqual(0);
    expect(blockedIdx).toBeGreaterThanOrEqual(0);

    // Find first non-empty line after each section header
    const questionLine = lines.slice(questionIdx + 1).find((l) => l.trim());
    const blockedLine = lines.slice(blockedIdx + 1).find((l) => l.trim());

    expect(questionLine).toContain("None");
    expect(blockedLine).toContain("None");
  });

  test("no in-flight lanes: section shows 'board is idle'", () => {
    const report = buildStatusReport({
      boardItems: [],
      laneLocks: [],
      lastReport: null,
      clock: () => 0,
    });

    expect(report).toContain("None (board is idle)");
  });

  test("no prior reports: last loop section shows (no prior loops)", () => {
    const report = buildStatusReport({
      boardItems: [],
      laneLocks: [],
      lastReport: null,
      clock: () => 0,
    });

    expect(report).toContain("(no prior loops)");
  });

  test("zero totals when no items have Estimate or Actual", () => {
    const items: BoardItem[] = [
      { number: 1, title: "T1", url: "http://test", fields: { Status: "Done" } },
      { number: 2, title: "T2", url: "http://test", fields: { Status: "Ready" } },
    ];

    const report = buildStatusReport({
      boardItems: items,
      laneLocks: [],
      lastReport: null,
      clock: () => 0,
    });

    expect(report).toContain("Estimate: $0.00");
    expect(report).toContain("Actual: $0.00");
  });

  test("missing or unreadable report file is handled gracefully", () => {
    const report = buildStatusReport({
      boardItems: [],
      laneLocks: [],
      lastReport: "/nonexistent/path/to/report.md",
      clock: () => 0,
    });

    expect(report).toContain("(no prior loops)");
    // Should not throw
  });
});

// ============================================================================
// AC2 -- grep contract enforcement: zero mutating z-board subcommands
// ============================================================================
describe("AC2: contract enforcement — no z-board mutating commands", () => {
  function trackedFiles(): string[] {
    const proc = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
    });
    return proc.stdout.toString().split(/\r?\n/).filter(Boolean);
  }

  test("z-status skill and status-report code contain zero z-board mutating subcommands", () => {
    const files = trackedFiles()
      .filter((f) => (f.startsWith("z-status/") || f.includes("status-report")) && !f.startsWith("tests/"))
      .filter((f) => !f.endsWith(".md") && !f.endsWith(".png"));

    const mutatingCommands = ["move", "field-set", "create", "comment", "claim", "release"];
    const offenders: string[] = [];

    for (const f of files) {
      const content = readFileSync(join(REPO_ROOT, f), "utf8");
      for (const cmd of mutatingCommands) {
        if (new RegExp(`\\bz-board\\s+${cmd}\\b`).test(content)) {
          offenders.push(f);
          break;
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("status-report.ts makes no board mutations (defensive check)", () => {
    const content = readFileSync(join(REPO_ROOT, "lib", "status-report.ts"), "utf8");
    // Ensure we're only calling readFileSync, not writeFileSync on the board
    expect(content).not.toContain("board.move");
    expect(content).not.toContain("board.fieldSet");
    expect(content).not.toContain("board.create");
    expect(content).not.toContain("board.comment");
    expect(content).not.toContain("board.claim");
    expect(content).not.toContain("board.release");
  });
});
