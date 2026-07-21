// Gate tests for the planner eval harness (issue #25): the dry-run output
// splitter, the schema-gate (z-ticket-lint) wiring, score aggregation, the
// >= 8/10 pass-gate exit code, Estimate reproducibility (issue #7 AC2), and
// the board double that stands in for a live GitHub project. Deterministic,
// fixtures only -- the paid `claude -p` calls that would PRODUCE a real
// plan/score live in run.sh, never here (PRINCIPLES.md "LLM access": local
// claude -p only, and never in the free gate lane). The mocked end-to-end
// runs below (AC1/AC2/AC3/AC4) exercise run.sh's real orchestration through
// evals/planner/mock-claude.sh -- the canned stand-in for claude -p -- so
// the paid path is proven structurally with zero cost and zero network.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ghCmdShimContent,
  splitDryRunOutput,
  parseScore,
  aggregateScores,
  extractEstimates,
  checkReproducibility,
  computeExitCode,
  lintTicketBody,
  checkRun,
  formatReport,
  defaultSpawn,
  PASS_THRESHOLD,
  DEFAULT_FILES_ROOT,
  type Spawn,
  type RubricScore,
} from "../evals/planner/harness.ts";
import { handleGh, type BoardDoubleFixture } from "../evals/planner/board-double.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const PLANNER_DIR = join(REPO_ROOT, "evals", "planner");
const LINT_BIN = join(REPO_ROOT, "bin", "z-ticket-lint");
const MOCK_CLAUDE = join(PLANNER_DIR, "mock-claude.sh");

const tmps: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zplanner-harness-test-"));
  tmps.push(dir);
  return dir;
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

// A minimal valid ticket body (passes bin/z-ticket-lint), parameterized so
// tests can vary the Estimate and title. `files`, when given, is a single
// backticked path rendered as a `## Files` bullet (issue #84 grounding gate).
function ticketBody(opts: { title?: string; estimate?: number | string; depends?: string; files?: string } = {}): string {
  const { title = "Do the thing", estimate = 1.64, depends, files } = opts;
  return [
    `# Ticket: ${title}`,
    "",
    "## Context",
    "",
    "grounded in src/store.ts.",
    "",
    "## Plan",
    "",
    "- extend the Store class.",
    "",
    "### Acceptance Criteria",
    "",
    "- Setup: x. Action: y. Expected: z.",
    "",
    "## Tests + evals",
    "",
    "a gate test.",
    "",
    "## Docs pages touched",
    "",
    "none.",
    "",
    "## Out of scope",
    "",
    "everything else.",
    "",
    ...(files ? ["## Files", "", `- \`${files}\` -- grounding path.`, ""] : []),
    "Model: sonnet",
    "Model Effort: medium",
    `Estimate: ${estimate}`,
    ...(depends ? [`Depends on: ${depends}`] : []),
    "",
  ].join("\n");
}

function scoreJson(total: number): string {
  const score: RubricScore = { schema: 2, grounding: 2, acceptance: 2, tiers: 1, dependencies: total - 7, total };
  return JSON.stringify(score);
}

function writeRun(dir: string, i: number, plan: string, total: number): void {
  writeFileSync(join(dir, `plan-${i}.md`), plan, "utf8");
  writeFileSync(join(dir, `score-${i}.json`), scoreJson(total), "utf8");
}

// ============================================================================
// 0. ghCmdShimContent -- the gh.cmd Windows PATH-shim (issue #25 QA fix: a
//    bash `printf FORMAT` call used to inline the repo root into the FORMAT
//    string itself, and printf's FORMAT argument interprets its OWN escape
//    sequences wherever they appear in FORMAT -- "\e" and "\b" inside the
//    path's escaped backslashes silently became ESC (0x1B) and backspace
//    (0x08) bytes, corrupting "...ticket-25\evals\planner\board-double.ts"
//    into "...ticket-25<ESC>vals\planner<BS>oard-double.ts" and killing the
//    shim with "Module not found" before board-double.ts ever ran. See
//    harness.ts's doc comment for the confirmed repro
//    (`printf 'X\evals\board.ts\n'` -> "Xvalsoard.ts").
// ============================================================================
describe("ghCmdShimContent", () => {
  // Deliberately backslash-heavy input (the `cygpath -w` shape the old,
  // buggy code used) to prove normalization, not just the happy path.
  const FAKE_ROOT = "D:\\fake\\repo\\root";
  const content = ghCmdShimContent(FAKE_ROOT);

  test("starts with @echo off", () => {
    expect(content.startsWith("@echo off\r\n")).toBe(true);
  });

  test("contains the intended path, forward-slash normalized, verbatim", () => {
    expect(content).toContain('bun "D:/fake/repo/root/evals/planner/board-double.ts" %*');
  });

  test("contains no control characters -- no ESC (0x1B), no backspace (0x08)", () => {
    // The durable regression check: this function builds the string in JS,
    // never through a shell FORMAT string, so the historical corruption
    // cannot recur. (Mutation-checked: temporarily reintroducing the old
    // `printf '...%s\\evals\\planner...'` FORMAT-embedding approach and
    // re-running this assertion against ITS output turns it red -- see the
    // build notes for issue #25's QA bounce.)
    for (let i = 0; i < content.length; i++) {
      const code = content.charCodeAt(i);
      expect(code).not.toBe(0x1b);
      expect(code).not.toBe(0x08);
    }
  });

  test("uses CRLF line endings throughout, no bare LF or CR left over", () => {
    expect(content).toContain("\r\n");
    expect(content.split("\r\n").join("")).not.toMatch(/[\r\n]/);
  });

  test("a root with no backslashes at all (already forward-slash) round-trips unchanged", () => {
    const c = ghCmdShimContent("D:/already/forward/root");
    expect(c).toContain('bun "D:/already/forward/root/evals/planner/board-double.ts" %*');
  });
});

describe("gh-cmd-shim CLI + the real generated file (issue #25 QA fix)", () => {
  test("`harness.ts gh-cmd-shim` writes a file matching ghCmdShimContent exactly", () => {
    const dir = tmpDir();
    const outFile = join(dir, "gh.cmd");
    const proc = Bun.spawnSync(["bun", join(PLANNER_DIR, "harness.ts"), "gh-cmd-shim", REPO_ROOT, outFile], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const written = readFileSync(outFile, "utf8");
    expect(written).toBe(ghCmdShimContent(REPO_ROOT));
  });

  // Optional-but-cheap real invocation (this box is Windows, the exact env
  // issue #25's QA bounce was filed against): the generated gh.cmd, run
  // directly through Bun.spawnSync (the same mechanism lib/board.ts's
  // ghExecutor uses for the real `gh api /graphql` call), resolves and
  // returns board-double.ts's JSON for a RateLimit query -- the literal
  // end-to-end proof the old corrupted path could never pass ("Module not
  // found" before board-double.ts ever ran).
  test("invoking the generated gh.cmd for real returns board-double's RateLimit JSON", () => {
    if (process.platform !== "win32") return; // gh.cmd is a Windows-only artifact
    const dir = tmpDir();
    const outFile = join(dir, "gh.cmd");
    writeFileSync(outFile, ghCmdShimContent(REPO_ROOT), "utf8");
    const stdin = JSON.stringify({
      query: "query RateLimit { rateLimit { remaining resetAt } }",
      variables: {},
    });
    const proc = Bun.spawnSync([outFile, "api", "/graphql", "--input", "-"], {
      stdin: Buffer.from(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const body = JSON.parse(proc.stdout.toString());
    expect(body.data.rateLimit.remaining).toBeGreaterThan(200);
  });
});

// ============================================================================
// 1. splitDryRunOutput
// ============================================================================
describe("splitDryRunOutput", () => {
  test("a single-ticket document yields one chunk", () => {
    const doc = ticketBody({ title: "One" });
    const chunks = splitDryRunOutput(doc);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("## Context");
    expect(chunks[0]).toContain("## Out of scope");
  });

  test("a two-ticket document yields two chunks, in order, each self-contained", () => {
    const doc = ticketBody({ title: "First", estimate: 1.64 }) + "\n" + ticketBody({ title: "Second", estimate: 4.36, depends: "#1" });
    const chunks = splitDryRunOutput(doc);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain("Estimate: 1.64");
    expect(chunks[0]).not.toContain("Estimate: 4.36"); // ticket 2's own Estimate stayed out of chunk 1
    expect((chunks[0].match(/## Context/g) ?? []).length).toBe(1); // exactly its own Context, not ticket 2's too
    expect(chunks[1]).toContain("Estimate: 4.36");
    expect(chunks[1]).toContain("Depends on: #1");
    // Every chunk on its own passes z-ticket-lint's mandatory sections.
    for (const c of chunks) {
      expect(c).toMatch(/## Context/);
      expect(c).toMatch(/### Acceptance Criteria/);
      expect(c).toMatch(/## Out of scope/);
    }
  });

  test("fence-awareness: a '## Context' example inside a fenced block is not a second boundary", () => {
    const doc = [
      "# Ticket: With a fence",
      "",
      "## Context",
      "",
      "grounded.",
      "",
      "## Plan",
      "",
      "example dry-run output another ticket might emit:",
      "```markdown",
      "## Context",
      "not a real boundary -- inside a fence.",
      "```",
      "",
      "### Acceptance Criteria",
      "",
      "- Setup: x. Action: y. Expected: z.",
      "",
      "## Tests + evals",
      "",
      "a test.",
      "",
      "## Docs pages touched",
      "",
      "none.",
      "",
      "## Out of scope",
      "",
      "none.",
      "",
      "Estimate: 1.64",
      "",
    ].join("\n");
    const chunks = splitDryRunOutput(doc);
    expect(chunks).toHaveLength(1); // the fenced "## Context" did not split it into 2
  });

  test("no '## Context' heading at all yields no chunks", () => {
    expect(splitDryRunOutput("just some prose, no headings.")).toEqual([]);
  });
});

// ============================================================================
// 2. parseScore
// ============================================================================
describe("parseScore", () => {
  test("a complete score JSON parses", () => {
    const s = parseScore(scoreJson(9));
    expect(s.total).toBe(9);
    expect(s.schema).toBe(2);
  });

  test("malformed JSON throws naming the problem", () => {
    expect(() => parseScore("{ not json")).toThrow(/not valid JSON/);
  });

  test("a non-object JSON value throws", () => {
    expect(() => parseScore("42")).toThrow(/not an object/);
    expect(() => parseScore("[1,2,3]")).toThrow(/missing numeric/); // an array has no "schema" field
  });

  test("a missing dimension field throws naming it", () => {
    const bad = JSON.stringify({ schema: 2, grounding: 2, acceptance: 2, tiers: 1, total: 9 }); // no "dependencies"
    expect(() => parseScore(bad)).toThrow(/missing numeric "dependencies"/);
  });

  test("a non-numeric total throws naming it", () => {
    const bad = JSON.stringify({ schema: 2, grounding: 2, acceptance: 2, tiers: 1, dependencies: 2, total: "nine" });
    expect(() => parseScore(bad)).toThrow(/missing numeric "total"/);
  });
});

// ============================================================================
// 3. aggregateScores + the >= 8/10 pass threshold
// ============================================================================
describe("aggregateScores", () => {
  const s = (total: number): RubricScore => ({ schema: 2, grounding: 2, acceptance: 2, tiers: 1, dependencies: total - 7, total });

  test("mean of totals, pass at exactly the threshold (boundary)", () => {
    expect(PASS_THRESHOLD).toBe(8);
    const r = aggregateScores([s(10), s(8), s(6)]); // mean 8
    expect(r.mean).toBe(8);
    expect(r.pass).toBe(true);
  });

  test("mean just under the threshold fails", () => {
    const r = aggregateScores([s(10), s(7), s(6)]); // mean 7.666...
    expect(r.pass).toBe(false);
  });

  test("a single passing score", () => {
    expect(aggregateScores([s(9)])).toEqual({ mean: 9, pass: true });
  });

  test("empty input throws rather than reporting a bogus pass", () => {
    expect(() => aggregateScores([])).toThrow(/no scores/);
  });
});

// ============================================================================
// 4. extractEstimates + checkReproducibility (issue #7 AC2)
// ============================================================================
describe("extractEstimates", () => {
  test("collects Estimate values in document order, case-insensitively", () => {
    const doc = "Estimate: 1.64\nsome prose\nESTIMATE: 4.36\n  estimate:   7.15  \n";
    expect(extractEstimates(doc)).toEqual([1.64, 4.36, 7.15]);
  });

  test("prose merely mentioning 'Estimate' is not a value line", () => {
    const doc = "See the Estimate field above for the dollar figure.\nEstimate: 1.64\n";
    expect(extractEstimates(doc)).toEqual([1.64]);
  });

  test("no Estimate lines yields an empty array", () => {
    expect(extractEstimates("nothing here.")).toEqual([]);
  });
});

describe("checkReproducibility (issue #7 AC2)", () => {
  test("identical Estimate values across runs are reproducible", () => {
    const r = checkReproducibility([[1.64, 4.36], [1.64, 4.36], [1.64, 4.36]]);
    expect(r.reproducible).toBe(true);
    expect(r.detail).toMatch(/identical across 3 runs/);
  });

  test("a DIFFERENT Estimate on any run fails, naming which ticket and the two values", () => {
    const r = checkReproducibility([[1.64, 4.36], [1.64, 5.0]]);
    expect(r.reproducible).toBe(false);
    expect(r.detail).toContain("ticket 2");
    expect(r.detail).toContain("4.36");
    expect(r.detail).toContain("5");
  });

  test("a run emitting a different NUMBER of tickets fails, naming the counts", () => {
    const r = checkReproducibility([[1.64, 4.36], [1.64]]);
    expect(r.reproducible).toBe(false);
    expect(r.detail).toMatch(/1 Estimate.*run 1 emitted 2/);
  });

  test("fewer than 2 runs is vacuously reproducible", () => {
    expect(checkReproducibility([[1.64]]).reproducible).toBe(true);
    expect(checkReproducibility([]).reproducible).toBe(true);
  });
});

// ============================================================================
// 5. computeExitCode -- the pass gate is an exit code, not prose (AC4)
// ============================================================================
describe("computeExitCode", () => {
  test.each([
    [{ scorePass: true, lintPass: true, reproducible: true }, 0],
    [{ scorePass: false, lintPass: true, reproducible: true }, 1],
    [{ scorePass: true, lintPass: false, reproducible: true }, 1],
    [{ scorePass: true, lintPass: true, reproducible: false }, 1],
    [{ scorePass: false, lintPass: false, reproducible: false }, 1],
  ])("%j -> %i", (gate, expected) => {
    expect(computeExitCode(gate)).toBe(expected);
  });
});

// ============================================================================
// 6. lintTicketBody -- the schema-gate wiring to bin/z-ticket-lint
// ============================================================================
describe("lintTicketBody", () => {
  test("injected fake spawn: exit 0 -> ok true", () => {
    const dir = tmpDir();
    const fake: Spawn = () => ({ exitCode: 0, stdout: "ok", stderr: "" });
    const r = lintTicketBody(ticketBody(), dir, LINT_BIN, fake);
    expect(r.ok).toBe(true);
  });

  test("injected fake spawn: exit 1 -> ok false, output carries stderr", () => {
    const dir = tmpDir();
    const fake: Spawn = () => ({ exitCode: 1, stdout: "", stderr: "missing section" });
    const r = lintTicketBody(ticketBody(), dir, LINT_BIN, fake);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("missing section");
  });

  // Integration: the REAL bin/z-ticket-lint binary, no fake -- this is the
  // literal "emitted ticket body is linted by bin/z-ticket-lint" AC1 wording.
  test("real bin/z-ticket-lint: a valid body lints clean", () => {
    const dir = tmpDir();
    const r = lintTicketBody(ticketBody(), dir, LINT_BIN, defaultSpawn);
    expect(r.ok).toBe(true);
  });

  test("real bin/z-ticket-lint: a body missing a mandatory section fails, naming it", () => {
    const dir = tmpDir();
    const broken = "## Context\n\nonly this section exists.\n";
    const r = lintTicketBody(broken, dir, LINT_BIN, defaultSpawn);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("Missing mandatory section");
    expect(r.output).toContain("Acceptance Criteria");
  });

  // issue #84: the optional 5th arg threads `--check-paths <root>` through to
  // the real bin/z-ticket-lint -- the planner eval's grounding gate.
  test("injected fake spawn: a checkPathsRoot arg appends --check-paths <root> to the spawned command", () => {
    const dir = tmpDir();
    let seenCmd: string[] = [];
    const fake: Spawn = (cmd) => {
      seenCmd = cmd;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    lintTicketBody(ticketBody(), dir, LINT_BIN, fake, "/fake/repo/root");
    // issue #103: lintTicketBody normalizes lintBin to forward slashes before
    // it reaches spawn (LINT_BIN is backslash-separated on Windows, since
    // it's built via a native path.join), so the seen command carries the
    // normalized form, not the raw LINT_BIN constant.
    expect(seenCmd).toEqual(["bash", LINT_BIN.replace(/\\/g, "/"), seenCmd[2], "--check-paths", "/fake/repo/root"]);
  });

  test("no checkPathsRoot arg (default): no --check-paths on the spawned command", () => {
    const dir = tmpDir();
    let seenCmd: string[] = [];
    const fake: Spawn = (cmd) => {
      seenCmd = cmd;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    lintTicketBody(ticketBody(), dir, LINT_BIN, fake);
    expect(seenCmd).not.toContain("--check-paths");
  });

  // Real bin/z-ticket-lint, real fixture-app: the actual grounding check
  // (issue #84) -- a ticket whose `## Files` names the real `src/store.ts`
  // lints clean; the same ticket naming a path that does not exist under
  // fixture-app fails, naming exactly that path.
  test("real bin/z-ticket-lint --check-paths against fixture-app: a real Files path lints clean", () => {
    const dir = tmpDir();
    const r = lintTicketBody(ticketBody({ files: "src/store.ts" }), dir, LINT_BIN, defaultSpawn, DEFAULT_FILES_ROOT);
    expect(r.ok).toBe(true);
  });

  test("real bin/z-ticket-lint --check-paths against fixture-app: a plausible-but-wrong Files path fails, naming it", () => {
    const dir = tmpDir();
    const r = lintTicketBody(ticketBody({ files: "src/does-not-exist.ts" }), dir, LINT_BIN, defaultSpawn, DEFAULT_FILES_ROOT);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("src/does-not-exist.ts");
  });

  // issue #103 regression: a raw path.join lintBin (native separator -- a
  // backslash on Windows) broke bin/z-ticket-lint's own `dirname "$0"`,
  // silently no-opping the grounding gate (exit 0/PASS) instead of catching
  // the bad `## Files` path (exit 1/FAIL). Force EVERY separator in both
  // lintBin and checkPathsRoot to a backslash -- regardless of this OS's
  // native path.sep -- so the test exercises lintTicketBody's normalize
  // fix directly instead of relying on this machine's path.join already
  // producing backslashes. On POSIX (and on a Windows bash flavor that
  // already tolerates backslashes) this is a no-op-equivalent that still
  // asserts the correct FAIL, so it's green cross-platform; on the Windows
  // bash flavor the loop's regression run hit, removing the normalize call
  // in lintTicketBody makes this fail loudly instead of production silently
  // passing a hallucinated path.
  test("issue #103: a backslash-separated lintBin/checkPathsRoot still fails the grounding gate (regression pin)", () => {
    const dir = tmpDir();
    const toBackslash = (p: string) => p.split(/[\\/]/).join("\\");
    const backslashLintBin = toBackslash(LINT_BIN);
    const backslashFilesRoot = toBackslash(DEFAULT_FILES_ROOT);
    const r = lintTicketBody(
      ticketBody({ files: "src/does-not-exist.ts" }),
      dir,
      backslashLintBin,
      defaultSpawn,
      backslashFilesRoot
    );
    expect(r.ok).toBe(false);
    expect(r.output).toContain("src/does-not-exist.ts");
  });
});

// ============================================================================
// 7. checkRun / formatReport -- the full deterministic pipeline over a
//    run directory (fixture in, expected out -- no claude -p involved)
// ============================================================================
describe("checkRun: the deterministic pipeline over a run directory", () => {
  test("two passing, reproducible runs -> exit 0", () => {
    const dir = tmpDir();
    writeRun(dir, 1, ticketBody({ estimate: 1.64 }), 9);
    writeRun(dir, 2, ticketBody({ estimate: 1.64 }), 9);
    const report = checkRun(dir, 2, LINT_BIN);
    expect(report.lintFailures).toEqual([]);
    expect(report.aggregate).toEqual({ mean: 9, pass: true });
    expect(report.reproducibility.reproducible).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(formatReport(report)).toMatch(/exit code: 0/);
  });

  // AC3, second half: "a mocked run with DIFFERENT Estimates must fail the
  // reproducibility check."
  test("two runs with DIFFERENT Estimates fail reproducibility -> exit 1", () => {
    const dir = tmpDir();
    writeRun(dir, 1, ticketBody({ estimate: 1.64 }), 9);
    writeRun(dir, 2, ticketBody({ estimate: 4.36 }), 9);
    const report = checkRun(dir, 2, LINT_BIN);
    expect(report.reproducibility.reproducible).toBe(false);
    expect(report.reproducibility.detail).toContain("1.64");
    expect(report.reproducibility.detail).toContain("4.36");
    expect(report.exitCode).toBe(1);
  });

  // AC4: "a run whose average total is below 8 ... non-zero [exit code]."
  test("an average total below 8 fails the pass gate -> exit 1", () => {
    const dir = tmpDir();
    writeRun(dir, 1, ticketBody(), 5);
    const report = checkRun(dir, 1, LINT_BIN);
    expect(report.aggregate.pass).toBe(false);
    expect(report.exitCode).toBe(1);
  });

  test("a ticket body that fails z-ticket-lint fails the run even if the score is high", () => {
    const dir = tmpDir();
    const broken = "## Context\n\nonly this section exists.\n";
    writeRun(dir, 1, broken, 10);
    const report = checkRun(dir, 1, LINT_BIN);
    expect(report.lintFailures.length).toBeGreaterThan(0);
    expect(report.exitCode).toBe(1);
  });

  test("main() CLI wires the same contract and returns the same exit code", async () => {
    const dir = tmpDir();
    writeRun(dir, 1, ticketBody(), 9);
    const { main } = await import("../evals/planner/harness.ts");
    expect(main(["check", dir, "1"])).toBe(0);
  });

  // -- issue #84: the `## Files` grounding gate, wired into checkRun's default
  // pipeline against evals/planner/fixture-app. This is "the eval that would
  // have caught a planner that lists plausible-but-wrong paths": a ticket
  // whose Files section names a real fixture path is indistinguishable from
  // one with none, but a fabricated path now fails the run even at a
  // perfect score, exactly like a missing mandatory section already does.
  test("a real `## Files` path (src/store.ts, exists in fixture-app) does not affect a passing run", () => {
    const dir = tmpDir();
    writeRun(dir, 1, ticketBody({ files: "src/store.ts" }), 9);
    const report = checkRun(dir, 1, LINT_BIN);
    expect(report.lintFailures).toEqual([]);
    expect(report.exitCode).toBe(0);
  });

  test("a fabricated `## Files` path (does not exist in fixture-app) fails the run even at a perfect score", () => {
    const dir = tmpDir();
    writeRun(dir, 1, ticketBody({ files: "src/does-not-exist.ts" }), 10);
    const report = checkRun(dir, 1, LINT_BIN);
    expect(report.lintFailures.length).toBeGreaterThan(0);
    expect(report.lintFailures[0]).toContain("src/does-not-exist.ts");
    expect(report.exitCode).toBe(1);
  });

  test("filesRoot is overridable to a different grounding root", () => {
    const groundingRoot = tmpDir();
    writeFileSync(join(groundingRoot, "real.ts"), "// exists here, not in fixture-app", "utf8");
    const dir = tmpDir();
    writeRun(dir, 1, ticketBody({ files: "real.ts" }), 9);
    // Against fixture-app (default) this path does not exist -> fails.
    expect(checkRun(dir, 1, LINT_BIN).lintFailures.length).toBeGreaterThan(0);
    // Against the custom root where it really is -> passes.
    expect(checkRun(dir, 1, LINT_BIN, defaultSpawn, groundingRoot).lintFailures).toEqual([]);
  });
});

// ============================================================================
// 8. board-double: handleGh serves the fixture Backlog ticket
// ============================================================================
describe("board-double: handleGh", () => {
  const fx: BoardDoubleFixture = {
    slug: "zstack-planner-eval",
    issueNumber: 501,
    body: "delete a code from the store.\n",
  };

  test("gh repo view --json name -q .name returns the fixture slug", () => {
    const r = handleGh(["repo", "view", "--json", "name", "-q", ".name"], "", fx);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(fx.slug);
  });

  test("an unsupported 'gh repo view' invocation fails loudly, not silently", () => {
    const r = handleGh(["repo", "view", "--json", "url"], "", fx);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unsupported");
  });

  test("gh auth status reports a healthy, project-scoped login", () => {
    const r = handleGh(["auth", "status"], "", fx);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("project");
  });

  test("gh issue view <fixture number> returns the fixture body", () => {
    const r = handleGh(["issue", "view", "501", "--json", "body", "-q", ".body"], "", fx);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(fx.body);
  });

  test("gh issue view of any other number fails (fixture knows only #501)", () => {
    const r = handleGh(["issue", "view", "999", "--json", "body", "-q", ".body"], "", fx);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("999");
  });

  test("gh api /graphql RateLimit returns a healthy quota (no sleep/abort)", () => {
    const stdin = JSON.stringify({
      query: "query RateLimit { rateLimit { remaining resetAt } }",
      variables: {},
    });
    const r = handleGh(["api", "/graphql", "--input", "-"], stdin, fx);
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.data.rateLimit.remaining).toBeGreaterThan(200); // above z-setup's default threshold
  });

  test("gh api /graphql ProjectItems returns exactly the fixture ticket, Status=Backlog", () => {
    const stdin = JSON.stringify({
      query: "query ProjectItems($project: ID!) { node(id: $project) { ... on ProjectV2 { items { nodes { content { number } } } } } }",
      variables: { project: "PVT_1" },
    });
    const r = handleGh(["api", "/graphql", "--input", "-"], stdin, fx);
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout);
    const nodes = body.data.node.items.nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0].content.number).toBe(501);
    expect(nodes[0].fieldValues.nodes[0]).toMatchObject({ name: "Backlog", field: { name: "Status" } });
  });

  test("an unexpected write mutation fails loudly instead of faking a silent success", () => {
    const stdin = JSON.stringify({ query: "mutation SetSingleSelect { x }", variables: {} });
    const r = handleGh(["api", "/graphql", "--input", "-"], stdin, fx);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("SetSingleSelect");
  });

  test("malformed gh api stdin (not JSON) fails loudly", () => {
    const r = handleGh(["api", "/graphql", "--input", "-"], "not json", fx);
    expect(r.exitCode).toBe(1);
  });

  test("an unhandled gh invocation fails loudly, naming the invocation", () => {
    const r = handleGh(["pr", "merge", "7"], "", fx);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("gh pr merge 7");
  });
});

// ============================================================================
// 9. Deliverables on disk (mirrors evals/e2e's own structural check)
// ============================================================================
describe("issue #25 deliverables are on disk", () => {
  const files = [
    "evals/planner/board-double.ts",
    "evals/planner/harness.ts",
    "evals/planner/run.sh",
    "evals/planner/mock-claude.sh",
    "evals/planner/run.md",
    "evals/planner/README.md",
  ];
  for (const f of files) {
    test(`${f} exists`, () => {
      expect(existsSync(join(REPO_ROOT, f))).toBe(true);
    });
  }
});

// ============================================================================
// 10. Mocked end-to-end runs (AC1, AC2, AC3, AC4): run.sh's REAL
//     orchestration, through mock-claude.sh standing in for claude -p.
//     No network, no live board, no cost -- the real (paid) claude -p run is
//     the nightly eval's job (documented in run.md).
// ============================================================================
function runHarnessE2E(
  pass: "spec" | "backlog",
  runs: number,
  envOverrides: Record<string, string> = {}
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bash", join(PLANNER_DIR, "run.sh"), pass, String(runs)], {
    env: { ...process.env, CLAUDE_CMD: `bash ${MOCK_CLAUDE}`, ...envOverrides },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode ?? 1,
    stdout: proc.stdout?.toString() ?? "",
    stderr: proc.stderr?.toString() ?? "",
  };
}

describe("mocked end-to-end: run.sh + mock-claude.sh (AC1-AC4)", () => {
  // AC1: backlog-scan harness, RUNS=1, mocked claude -p: completes, the
  // emitted ticket body is linted by bin/z-ticket-lint, a numeric total is
  // produced.
  test("AC1: backlog pass, RUNS=1 completes, lints clean, produces a numeric total", () => {
    const r = runHarnessE2E("backlog", 1);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/run 1: total=9/);
    expect(r.stdout).toContain("schema gate (z-ticket-lint): PASS");
  });

  // AC2: same completion contract for the spec pass.
  test("AC2: spec pass, RUNS=1 completes with the same contract (splitter, lint, score)", () => {
    const r = runHarnessE2E("spec", 1);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/run 1: total=9/);
    expect(r.stdout).toContain("schema gate (z-ticket-lint): PASS");
  });

  // AC3, first half: two consecutive runs on the same fixtures (mocked,
  // deterministic outputs) -> identical Estimates flagged reproducible.
  test("AC3: two consecutive runs with the SAME mocked Estimate are flagged reproducible", () => {
    const r = runHarnessE2E("backlog", 2, { MOCK_CLAUDE_ESTIMATE: "1.64" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/reproducible: yes/);
  });

  // AC4: a run whose average total is below 8 -> the exit code is non-zero.
  test("AC4: an average total below 8 makes the exit code non-zero", () => {
    const r = runHarnessE2E("backlog", 1, { MOCK_CLAUDE_TOTAL: "5" });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/mean total: 5\.00 \(threshold 8\) -- FAIL/);
  });

  test("spec pass emits TWO tickets, proving the splitter handles a multi-ticket document for real", () => {
    const r = runHarnessE2E("spec", 1);
    expect(r.exitCode).toBe(0);
    // Both tickets in the chain must have lint-passed independently.
    expect(r.stdout).toContain("schema gate (z-ticket-lint): PASS");
  });

  // issue #84: the `## Files` grounding gate catches a planner that lists a
  // plausible-but-wrong path, end to end -- real bin/z-ticket-lint
  // --check-paths against the real fixture-app, through run.sh's actual
  // orchestration, not just the unit-level checkRun tests above.
  test("issue #84: a mocked plan naming a nonexistent Files path fails the grounding gate, even at a perfect score", () => {
    const r = runHarnessE2E("backlog", 1, { MOCK_CLAUDE_BAD_FILES: "1" });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("schema gate (z-ticket-lint): FAIL");
    expect(r.stdout).toContain("src/does-not-exist.ts");
  });
});
