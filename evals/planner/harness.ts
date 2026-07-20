// The planner eval harness (issue #25). Owns the deterministic dimension of
// both the spec-to-tickets pass and the backlog-scan pass: splitting a dry-run
// plan document into per-ticket bodies, gating each through bin/z-ticket-lint,
// aggregating the graded score JSON against the >= 8/10 pass threshold
// (rubric.md), and asserting Estimate reproducibility run-to-run (issue #7
// AC2). Every exported function below is pure (fixture in, value out) except
// lintTicketBody/checkRun, which shell to the real bin/z-ticket-lint via an
// injectable spawn (mirrors lib/board.ts's GhSpawn injection) -- the paid
// `claude -p` calls that PRODUCE plan-*.md/score-*.json live in run.sh, never
// here and never in `bun test` (PRINCIPLES.md "LLM access": local claude -p
// only, and never in the free gate lane).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../../lib/ticket-schema.ts";

// -- 0. gh.cmd Windows PATH-shim content --------------------------------------
// Pure: the exact gh.cmd file content run.sh's backlog case writes onto PATH
// (see that file's comment for the full two-shim rationale). Historically
// this was built with a bash `printf FORMAT ARGS` call that inlined the repo
// root into the FORMAT string itself; printf's FORMAT argument interprets its
// OWN escape sequences wherever they appear in FORMAT -- including inside the
// substituted path's backslashes -- so "\e" and "\b" silently became ESC
// (0x1B) and backspace (0x08) bytes, corrupting
// "...ticket-25\evals\planner\board-double.ts" into
// "...ticket-25<ESC>vals\planner<BS>oard-double.ts" and breaking the shim
// (confirmed: `printf 'X\evals\board.ts\n'` -> "Xvalsoard.ts"). This function
// builds the string in JS -- no shell FORMAT string involved, so no such
// reinterpretation is possible -- and normalizes every backslash to a forward
// slash first: cmd.exe and bun both accept forward slashes in a quoted script
// path, so the emitted file is backslash-free end to end and the hazard class
// cannot recur even if repoRoot itself contains backslashes (e.g. from
// `cygpath -w`).
export function ghCmdShimContent(repoRoot: string): string {
  const forwardSlashRoot = repoRoot.replace(/\\/g, "/");
  return `@echo off\r\nbun "${forwardSlashRoot}/evals/planner/board-double.ts" %*\r\n`;
}

// -- 1. Dry-run output splitter -----------------------------------------------
// Splits one dry-run markdown document into per-ticket body chunks. The
// boundary is each ticket's own mandatory "## Context" heading (lib/
// ticket-schema.ts's REQUIRED_SECTIONS) -- every ticket z-plan drafts has
// exactly one, so this needs no wrapper syntax the skill would have to add
// (the skill text is out of scope for this ticket) and works for both the
// single-ticket backlog-scan pass and the multi-ticket spec pass. Fence-aware
// (reuses lib/ticket-schema.ts's parse()): a "## Context" example inside a
// fenced code block in one ticket's Plan is not mistaken for a second
// boundary.
export function splitDryRunOutput(markdown: string): string[] {
  const { headings, lines } = parse(markdown);
  const starts = headings
    .filter((h) => h.level === 2 && h.title.trim().toLowerCase() === "context")
    .map((h) => h.line);
  if (starts.length === 0) return [];
  return starts.map((from, i) => {
    const to = i + 1 < starts.length ? starts[i + 1] : lines.length;
    return lines.slice(from, to).join("\n").trim() + "\n";
  });
}

// -- 2. z-ticket-lint wiring ---------------------------------------------------
export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type Spawn = (cmd: string[]) => SpawnResult;

// Real default: `bash <lintBin> <file>`, not a direct exec of the shebang --
// Bun.spawnSync uses the OS process API directly, which cannot follow a
// shebang on Windows (ENOENT), so bash is named explicitly for portability.
export const defaultSpawn: Spawn = (cmd) => {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: proc.exitCode ?? 1,
    stdout: proc.stdout?.toString() ?? "",
    stderr: proc.stderr?.toString() ?? "",
  };
};

export interface LintResult {
  ok: boolean;
  output: string;
}

// Writes `body` to a throwaway file under `tmpDir` and pipes it through the
// real bin/z-ticket-lint (or an injected fake spawn for pure unit tests).
// `checkPathsRoot`, when given, adds `--check-paths <checkPathsRoot>` --
// issue #84's grounding gate: if the ticket carries a `## Files` section,
// every path must exist under that root. No second lint implementation here;
// this just threads the flag bin/z-ticket-lint already understands.
export function lintTicketBody(
  body: string,
  tmpDir: string,
  lintBin: string,
  spawn: Spawn = defaultSpawn,
  checkPathsRoot?: string
): LintResult {
  const file = join(tmpDir, `lint-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(file, body, "utf8");
  const cmd = checkPathsRoot ? ["bash", lintBin, file, "--check-paths", checkPathsRoot] : ["bash", lintBin, file];
  const result = spawn(cmd);
  return { ok: result.exitCode === 0, output: (result.stdout + result.stderr).trim() };
}

// -- 3. Score aggregation ------------------------------------------------------
export interface RubricScore {
  schema: number;
  grounding: number;
  acceptance: number;
  tiers: number;
  dependencies: number;
  total: number;
  notes?: string;
}

// rubric.md: "Pass threshold: average >= 8/10". Out of scope to change
// (ticket's Out of scope: "Changing the rubric dimensions or the 8/10
// threshold").
export const PASS_THRESHOLD = 8;

const SCORE_FIELDS = ["schema", "grounding", "acceptance", "tiers", "dependencies", "total"] as const;

// Parses one grader's raw stdout into a RubricScore, failing loudly (naming
// the exact field) on malformed JSON or a missing/non-numeric dimension --
// silently defaulting a missing dimension to 0 would corrupt the aggregate
// mean without any visible signal.
export function parseScore(raw: string): RubricScore {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`score JSON is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof obj !== "object" || obj === null) {
    throw new Error(`score JSON is not an object (got ${JSON.stringify(obj)}).`);
  }
  const rec = obj as Record<string, unknown>;
  for (const f of SCORE_FIELDS) {
    if (typeof rec[f] !== "number" || !Number.isFinite(rec[f])) {
      throw new Error(`score JSON missing numeric "${f}" field (got ${JSON.stringify(rec[f])}).`);
    }
  }
  return rec as unknown as RubricScore;
}

export interface AggregateResult {
  mean: number;
  pass: boolean;
}

// Averages `.total` over every run's score; pass at mean >= PASS_THRESHOLD
// (rubric.md). This is the "pass gate is an exit code, not prose" contract
// (ticket AC4).
export function aggregateScores(scores: RubricScore[]): AggregateResult {
  if (scores.length === 0) throw new Error("aggregateScores: no scores to aggregate.");
  const mean = scores.reduce((s, x) => s + x.total, 0) / scores.length;
  return { mean, pass: mean >= PASS_THRESHOLD };
}

// -- 4. Estimate reproducibility (issue #7 AC2) -------------------------------
// One Estimate value per ticket, in document order. Line-anchored (not a
// substring match) so prose mentioning "the Estimate field" elsewhere in a
// ticket body is never mistaken for a value.
export function extractEstimates(markdown: string): number[] {
  const out: number[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = line.match(/^\s*estimate:\s*([0-9]+(?:\.[0-9]+)?)\s*$/i);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

export interface ReproducibilityResult {
  reproducible: boolean;
  detail: string;
}

// The tier -> z-estimate chain is deterministic by design (z-plan/SKILL.md
// Step 6), so the SAME fixture must yield IDENTICAL Estimate values every run
// -- exact equality, not a tolerance band (a tolerance would mask the exact
// bug issue #7 AC2 exists to catch: a nondeterministic chain drifting by a
// cent). Fewer than two runs has nothing to compare and is vacuously
// reproducible.
export function checkReproducibility(estimatesPerRun: number[][]): ReproducibilityResult {
  if (estimatesPerRun.length < 2) {
    return { reproducible: true, detail: "fewer than 2 runs; nothing to compare." };
  }
  const [first, ...rest] = estimatesPerRun;
  for (let r = 0; r < rest.length; r++) {
    const run = rest[r];
    if (run.length !== first.length) {
      return {
        reproducible: false,
        detail: `run ${r + 2} emitted ${run.length} Estimate value(s), run 1 emitted ${first.length}.`,
      };
    }
    for (let i = 0; i < first.length; i++) {
      if (run[i] !== first[i]) {
        return {
          reproducible: false,
          detail: `ticket ${i + 1}: run 1 Estimate=${first[i]}, run ${r + 2} Estimate=${run[i]}.`,
        };
      }
    }
  }
  return {
    reproducible: true,
    detail: `${first.length} Estimate value(s) identical across ${estimatesPerRun.length} runs.`,
  };
}

// -- exit code -----------------------------------------------------------------
export interface GateResult {
  scorePass: boolean;
  lintPass: boolean;
  reproducible: boolean;
}

// The pass gate is an exit code, not prose (ticket AC4): 0 only when the
// graded score clears the threshold AND every emitted ticket body lints
// clean AND Estimates reproduced run-to-run. lintPass is a deterministic
// ground truth the harness holds independently of what the LLM grader
// self-reports for the rubric's own "schema gate" dimension.
export function computeExitCode(gate: GateResult): number {
  return gate.scorePass && gate.lintPass && gate.reproducible ? 0 : 1;
}

// -- orchestration: ties the above together over a run directory -------------
// Directory contract (written by run.sh): plan-<i>.md, score-<i>.json for
// i in 1..runs.
export interface CheckReport {
  runs: number;
  lintFailures: string[];
  scores: RubricScore[];
  aggregate: AggregateResult;
  reproducibility: ReproducibilityResult;
  exitCode: number;
}

// The fixture app every planner-eval ticket is grounded against (evals/planner/
// fixture-app) -- the repo root a ticket's `## Files` paths (if any) must
// resolve under. Overridable so tests can point it at a throwaway fixture.
export const DEFAULT_FILES_ROOT = join(import.meta.dir, "fixture-app");

export function checkRun(
  outDir: string,
  runs: number,
  lintBin: string,
  spawn: Spawn = defaultSpawn,
  filesRoot: string = DEFAULT_FILES_ROOT
): CheckReport {
  const lintFailures: string[] = [];
  const scores: RubricScore[] = [];
  const estimatesPerRun: number[][] = [];

  for (let i = 1; i <= runs; i++) {
    const planPath = join(outDir, `plan-${i}.md`);
    const scorePath = join(outDir, `score-${i}.json`);
    const plan = readFileSync(planPath, "utf8");
    const chunks = splitDryRunOutput(plan);
    if (chunks.length === 0) {
      lintFailures.push(`run ${i}: no ticket found (no "## Context" heading in ${planPath}).`);
    }
    chunks.forEach((body, idx) => {
      // --check-paths against filesRoot: this is the "did the planner ground
      // correctly" half (issue #84) -- a ticket whose `## Files` section
      // names a plausible-but-wrong path fails here, same as a missing
      // mandatory section would.
      const { ok, output } = lintTicketBody(body, outDir, lintBin, spawn, filesRoot);
      if (!ok) lintFailures.push(`run ${i} ticket ${idx + 1}: z-ticket-lint failed:\n${output}`);
    });
    scores.push(parseScore(readFileSync(scorePath, "utf8")));
    estimatesPerRun.push(extractEstimates(plan));
  }

  const aggregate = aggregateScores(scores);
  const reproducibility = checkReproducibility(estimatesPerRun);
  const exitCode = computeExitCode({
    scorePass: aggregate.pass,
    lintPass: lintFailures.length === 0,
    reproducible: reproducibility.reproducible,
  });
  return { runs, lintFailures, scores, aggregate, reproducibility, exitCode };
}

export function formatReport(report: CheckReport): string {
  const lines: string[] = [];
  lines.push(`runs: ${report.runs}`);
  report.scores.forEach((s, i) => lines.push(`  run ${i + 1}: total=${s.total}`));
  lines.push(`mean total: ${report.aggregate.mean.toFixed(2)} (threshold ${PASS_THRESHOLD}) -- ${report.aggregate.pass ? "PASS" : "FAIL"}`);
  lines.push(`schema gate (z-ticket-lint): ${report.lintFailures.length === 0 ? "PASS" : "FAIL"}`);
  for (const f of report.lintFailures) lines.push(`  ${f}`);
  lines.push(`reproducible: ${report.reproducibility.reproducible ? "yes" : "no"} -- ${report.reproducibility.detail}`);
  lines.push(`exit code: ${report.exitCode}`);
  return lines.join("\n");
}

// -- CLI -----------------------------------------------------------------------
const USAGE = `harness.ts check <outDir> <runs>
harness.ts gh-cmd-shim <repoRoot> <outFile>

  check: Checks a planner eval run directory (plan-<i>.md / score-<i>.json for
  i in 1..<runs>, written by run.sh): splits each plan into per-ticket bodies,
  lints each through bin/z-ticket-lint, aggregates the score JSON against the
  >= ${PASS_THRESHOLD}/10 pass threshold, and asserts Estimate reproducibility
  across runs. Exit 0 = pass, 1 = fail (report on stdout either way).

  gh-cmd-shim: writes the gh.cmd Windows PATH-shim (run.sh's backlog case) to
  <outFile> -- see ghCmdShimContent's doc comment for the historical bash
  \`printf FORMAT\` bug this CLI wrapper exists to keep out of run.sh for good.

  Env: Z_LINT overrides the bin/z-ticket-lint path (default: ../../bin/z-ticket-lint).`;

export function main(argv: string[]): number {
  const [cmd, arg1, arg2] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  if (cmd === "gh-cmd-shim") {
    if (!arg1 || !arg2) {
      console.error(`Usage: ${USAGE}`);
      return 1;
    }
    writeFileSync(arg2, ghCmdShimContent(arg1), "utf8");
    return 0;
  }
  if (cmd !== "check" || !arg1 || !arg2) {
    console.error(`Usage: ${USAGE}`);
    return 1;
  }
  const outDir = arg1;
  const runsArg = arg2;
  const runs = Number(runsArg);
  if (!Number.isInteger(runs) || runs < 1) {
    console.error(`<runs> must be a positive integer, got "${runsArg}".`);
    return 1;
  }
  const lintBin = process.env.Z_LINT ?? join(import.meta.dir, "..", "..", "bin", "z-ticket-lint");
  let report: CheckReport;
  try {
    report = checkRun(outDir, runs, lintBin);
  } catch (e) {
    console.error(`harness check failed: ${(e as Error).message}`);
    return 1;
  }
  console.log(formatReport(report));
  return report.exitCode;
}

// Test-only convenience: a fresh temp dir under the OS tmp root, mirroring the
// mkdtempSync pattern tests/board.test.ts uses for its own throwaway dirs.
export function freshTmpDir(prefix = "zplanner-harness-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
