// Gate tests for lib/status-report.ts (issue #14 item 15). Three concerns:
// (1) the renderer's counts/sums/ages are correct against a hand-built board
// fixture, (2) the CLI path exits 0 and prints the report (pins the old
// synchronous-main-with-.then footer crash), and (3) z-status/SKILL.md's
// fenced pipeline runs one atomic z-board snapshot into status-report, in
// order, so the skill wiring can't silently rot back into per-status
// snapshots or prose math.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatusReport, ZError } from "../lib/status-report.ts";
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

  // -- F11 defense: dedupe by issue number, first wins, warn loudly -----------
  test("duplicate issue numbers are deduped (first wins) and a warning line appears", () => {
    // The same issue seen twice under different statuses -- the exact artifact
    // a per-status snapshot race produces. The second sighting must not count.
    const dupItems: BoardItem[] = [
      ...ITEMS,
      { number: 4, title: "Building now", url: "u4", fields: { Status: "QA", Estimate: 2, Actual: 9 } },
    ];
    const report = buildStatusReport({ boardItems: dupItems, laneLocks: [], lastReport: null, clock: () => 0 });
    expect(report).toContain("- Building: 2"); // first occurrence kept
    expect(report).toContain("- QA: 0"); // duplicate sighting NOT counted
    expect(report).toContain("- Estimate: $6.50"); // sums unchanged by the dupe
    expect(report).toContain("- Actual: $3.00");
    expect(report).toContain("Warning: dropped 1 duplicate board item(s)");
  });

  test("no duplicates: no warning line", () => {
    const report = buildStatusReport({ boardItems: ITEMS, laneLocks: [], lastReport: null, clock: () => 0 });
    expect(report).not.toMatch(/duplicate/i);
  });

  // -- F13: only a MISSING last-report reads as "no prior loops" --------------
  test("a missing last-report path renders '(no prior loops)' (fresh board)", () => {
    const report = buildStatusReport({
      boardItems: [],
      laneLocks: [],
      lastReport: join(tmpDir("zstatus-f13-"), "never-written.md"),
      clock: () => 0,
    });
    expect(report).toContain("(no prior loops)");
  });

  test("an unreadable last-report (a directory) raises ZError naming the path, not fake idle", () => {
    const dir = tmpDir("zstatus-f13-dir-"); // a DIRECTORY where a file is expected -> EISDIR, not ENOENT
    let caught: unknown;
    try {
      buildStatusReport({ boardItems: [], laneLocks: [], lastReport: dir, clock: () => 0 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ZError);
    expect((caught as ZError).message).toContain(dir);
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

  // -- F15: a corrupt snapshot file must exit via the ZError contract ---------
  test("a corrupt --board-items file exits 1 with an actionable message, not a stack trace", () => {
    const dir = tmpDir("zstatus-corrupt-");
    const itemsFile = join(dir, "items.json");
    writeFileSync(itemsFile, "{ definitely not json");
    const locksDir = join(dir, "locks");
    mkdirSync(locksDir);

    const proc = Bun.spawnSync(["bun", LIB, "report", "--board-items", itemsFile, "--locks-dir", locksDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(1);
    const err = proc.stderr.toString();
    expect(err).toContain("Cannot read JSON at"); // lib/cli.ts readJson's ZError shape
    expect(err).toContain(itemsFile); // names the offending path
    expect(err).not.toContain("SyntaxError"); // no raw JSON.parse stack trace
  });

  // -- F13: a broken locks dir must not exit as a fake-idle dashboard ---------
  test("a --locks-dir that is a FILE exits 1 naming the path, not a lane-less report", () => {
    const dir = tmpDir("zstatus-locksfile-");
    const itemsFile = join(dir, "items.json");
    writeFileSync(itemsFile, "[]");
    const notADir = join(dir, "locks");
    writeFileSync(notADir, "i am a file, not a directory");

    const proc = Bun.spawnSync(["bun", LIB, "report", "--board-items", itemsFile, "--locks-dir", notADir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain(notADir);
    expect(proc.stdout.toString()).not.toContain("board is idle"); // never a plausible-but-false idle
  });
});

describe("z-status/SKILL.md wiring (grep gate, item 15 + F11/F12)", () => {
  // The fenced ```bash block(s) of the skill -- the commands an operator (or
  // the skill runner) actually executes. Asserting inside a block, in order,
  // keeps this gate from passing on stray prose mentions elsewhere in the file.
  function fencedBashBlocks(md: string): string[] {
    return [...md.matchAll(/```bash\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
  }

  test("one fenced bash block runs the atomic-snapshot pipeline, in order", () => {
    const skill = readFileSync(SKILL, "utf8");
    const blocks = fencedBashBlocks(skill);
    expect(blocks.length).toBeGreaterThan(0);

    // The pipeline steps, in execution order: temp dir, cleanup trap (F12),
    // ONE atomic all-statuses snapshot (F11), then the render CLI with its
    // exact flags. All must appear in a SINGLE block, in this order.
    const steps = [
      "TMP=$(mktemp -d)",
      `trap 'rm -rf "$TMP"' EXIT`,
      `"$Z_BOARD" list --json`,
      `lib/status-report.ts" report`,
      "--board-items",
      "--locks-dir",
      "--last-report",
    ];
    const pipeline = blocks.find((b) => steps.every((s) => b.includes(s)));
    expect(pipeline).toBeDefined();
    let at = -1;
    for (const s of steps) {
      const i = pipeline!.indexOf(s, at + 1);
      expect(i).toBeGreaterThan(at); // present AND after the previous step
      at = i;
    }

    // Atomicity guard (F11): the snapshot is never assembled per-status or
    // merged -- that pipeline double-counts/loses tickets moving mid-scan.
    expect(pipeline!).not.toContain("--status");
    expect(pipeline!).not.toContain("jq -s");
  });
});
