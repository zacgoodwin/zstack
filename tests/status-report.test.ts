// Gate tests for lib/status-report.ts (issue #14 item 15). Three concerns:
// (1) the renderer's counts/sums/ages are correct against a hand-built board
// fixture, (2) the CLI path exits 0 and prints the report (pins the old
// synchronous-main-with-.then footer crash), and (3) z-status/SKILL.md
// actually references the z-board -> jq -> status-report pipeline, so the
// skill wiring can't silently rot back into prose math.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatusReport } from "../lib/status-report.ts";
import type { BoardItem } from "../lib/board.ts";

const LIB = join(import.meta.dir, "..", "lib", "status-report.ts");
const SKILL = join(import.meta.dir, "..", "z-status", "SKILL.md");

const tmpPaths: string[] = [];
function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpPaths.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpPaths.length) rmSync(tmpPaths.pop()!, { recursive: true, force: true });
});

// Hand-built board: 1 Done, 1 Questions, 1 Blocked, 2 Building, rest empty.
// Estimate sum = 1.50 + 3.00 + 2.00 = 6.50; Actual sum = 2.25 + 0.75 = 3.00.
const ITEMS: BoardItem[] = [
  { number: 1, title: "Ship the estimator", url: "u1", fields: { Status: "Done", Estimate: 1.5, Actual: 2.25 } },
  { number: 2, title: "Ambiguous schema question", url: "u2", fields: { Status: "Questions", Estimate: 3 } },
  { number: 3, title: "Stuck on CI runner", url: "u3", fields: { Status: "Blocked", Actual: 0.75 } },
  { number: 4, title: "Building now", url: "u4", fields: { Status: "Building", Estimate: 2 } },
  { number: 5, title: "Also building", url: "u5", fields: { Status: "Building" } },
];

describe("buildStatusReport (item 15): renderer is the single source of numbers", () => {
  test("counts, listings, lane age, and Estimate/Actual sums are exact", () => {
    const claimedAt = 1_000_000;
    const report = buildStatusReport({
      boardItems: ITEMS,
      laneLocks: [
        { path: "lock4", lock: { ticket: 4, stage: "builder", session: "s", claimedAt } },
        { path: "lock5", lock: { ticket: 5, stage: "qa", session: "s", claimedAt } },
      ],
      lastReport: null,
      clock: () => claimedAt + 5 * 60_000, // 5 minutes after claim
    });

    expect(report).toContain("- Done: 1");
    expect(report).toContain("- Questions: 1");
    expect(report).toContain("- Blocked: 1");
    expect(report).toContain("- Building: 2");
    expect(report).toContain("- Backlog: 0");
    expect(report).toContain("- Ready: 0");
    expect(report).toContain("- #2 Ambiguous schema question");
    expect(report).toContain("- #3 Stuck on CI runner");
    expect(report).toContain("- Ticket #4 (builder): 5m");
    expect(report).toContain("- Ticket #5 (qa): 5m");
    expect(report).toContain("- Estimate: $6.50");
    expect(report).toContain("- Actual: $3.00");
    expect(report).toContain("(no prior loops)");
  });

  test("last-report verdict line is surfaced by filename", () => {
    const dir = tmpDir("zstatus-report-");
    const reportFile = join(dir, "loop-20260719-120000.md");
    writeFileSync(reportFile, "# Loop\n\n**Verdict:** GREEN — deployed.\n");
    const report = buildStatusReport({
      boardItems: [],
      laneLocks: [],
      lastReport: reportFile,
      clock: () => 0,
    });
    expect(report).toContain("loop-20260719-120000.md: GREEN — deployed.");
  });
});

describe("status-report CLI (the pipeline's exec contract)", () => {
  test("report command exits 0 and prints the rendered report", () => {
    // Pins the footer bug: main() is synchronous, so `.then()` on its result
    // crashed every successful render into exit 1.
    const dir = tmpDir("zstatus-cli-");
    const itemsFile = join(dir, "items.json");
    writeFileSync(itemsFile, JSON.stringify(ITEMS));
    const locksDir = join(dir, "locks");
    mkdirSync(locksDir);

    const proc = Bun.spawnSync(["bun", LIB, "report", "--board-items", itemsFile, "--locks-dir", locksDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const out = proc.stdout.toString();
    expect(out).toContain("- Done: 1");
    expect(out).toContain("- Estimate: $6.50");
    expect(out).toContain("- Actual: $3.00");
  });
});

describe("z-status/SKILL.md wiring (grep gate, item 15)", () => {
  test("the skill invokes the deterministic pipeline, not prose math", () => {
    const skill = readFileSync(SKILL, "utf8");
    // Snapshot: nine per-status z-board list --json calls merged by jq
    expect(skill).toMatch(/list --status "\$S" --json/);
    expect(skill).toMatch(/jq -s 'add'/);
    // Render: the lib CLI with its exact flags
    expect(skill).toMatch(/lib\/status-report\.ts" report/);
    expect(skill).toMatch(/--board-items/);
    expect(skill).toMatch(/--locks-dir/);
    expect(skill).toMatch(/--last-report/);
  });
});
