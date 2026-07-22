// Gate tests for C9 (issue #10): the /z-status read-only dashboard. Pure
// function tests against fixtures with an injected nowMs, zero network.
//
//   AC2 mutation-free: grep contract enforcement (zero z-board mutating commands)
//   AC3 empty board / no locks / no reports: clean states, no errors
//
// AC1 (full fixture render: counts, Questions/Blocked listings, lane age, the
// verdict line, Estimate/Actual totals) lived here as a second, looser copy of
// what tests/status-report.test.ts already pins exactly -- same renderer, same
// assertions, tighter fixtures there. It was deleted rather than kept in sync;
// status-report.test.ts is the single home for the renderer's own contract.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatusReport, type StatusReportInput } from "../lib/status-report.ts";
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
// AC3 -- empty board / no locks / no reports: clean states, no errors
// ============================================================================
describe("AC3: empty board, no locks, no reports render cleanly", () => {
  test("empty board: all status counts are zero", () => {
    const report = buildStatusReport({
      boardItems: [],
      laneLocks: [],
      lastReport: null,
      nowMs: 0,
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
      nowMs: 0,
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
      nowMs: 0,
    });

    expect(report).toContain("None (board is idle)");
  });

  test("no prior reports: last loop section shows (no prior loops)", () => {
    const report = buildStatusReport({
      boardItems: [],
      laneLocks: [],
      lastReport: null,
      nowMs: 0,
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
      nowMs: 0,
    });

    expect(report).toContain("Estimate: $0.00");
    expect(report).toContain("Actual: $0.00");
  });

  test("missing or unreadable report file is handled gracefully", () => {
    const report = buildStatusReport({
      boardItems: [],
      laneLocks: [],
      lastReport: "/nonexistent/path/to/report.md",
      nowMs: 0,
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
    // Issue #14 item 2: the old filter excluded *.md, so z-status/SKILL.md --
    // the file this gate exists to guard -- was never scanned. Scan it.
    const files = trackedFiles()
      .filter((f) => (f.startsWith("z-status/") || f.includes("status-report")) && !f.startsWith("tests/"))
      .filter((f) => !f.endsWith(".png"));
    // Canary: fail loudly if the skill file ever drops out of the scanned set,
    // instead of passing vacuously again.
    expect(files).toContain("z-status/SKILL.md");

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
