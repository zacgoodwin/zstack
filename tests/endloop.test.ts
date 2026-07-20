// Gate tests for C8 (issue #9): the End-of-Loop stage's four acceptance
// criteria, all against fixtures + a stubbed invoker + temp dirs -- zero
// network, zero real ~/.zstack writes.
//
//   AC1 red-regression fixture -> zero deploy invocations, every finding filed
//        as a Backlog bug with repro (asserted via the recording invoker)
//   AC2 green path -> invoker log is exactly land-and-deploy -> canary ->
//        document-release, in that order
//   AC3 counter at 4 -> no cso/health; at 5 -> both fire; counter persistence
//        (temp dir) drives the cadence end to end, plus edge cases (missing
//        file, corrupt file -> loud error)
//   AC4 the final report contains verdict+evidence, dollars total, tickets by
//        final status, and the edges-to-validate rollup
//   issue #18: the audit cadence (`auditEveryNLoops`) is a parameter of
//        endLoopPlan (and the `plan` CLI's optional 3rd arg), not hardcoded 5
import { test, expect, describe, afterEach, beforeEach, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bumpLoopCounter,
  buildBugTicket,
  buildEndLoopReport,
  endLoopPlan,
  main,
  peekLoopCounter,
  readLoopCounter,
  writeLoopCounter,
  ZError,
  type EndLoopActionKind,
  type EndLoopReportInput,
  type Finding,
  type RegressionResult,
} from "../lib/endloop.ts";
import {
  createFileInvoker,
  createRecordingInvoker,
  SKILL_NAMES,
  type SkillInvoker,
  type SkillName,
} from "../lib/skill-invoker.ts";

// -- temp dirs (no real ~/.zstack ever touched) -------------------------------
const dirs: string[] = [];
function tmp(prefix = "zstack-endloop-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// -- fixtures ------------------------------------------------------------------
const GREEN: RegressionResult = {
  verdict: "green",
  evidence: "typecheck: 0 errors; suite: 243/243; build: pass; e2e: n/a (no web change); qa-only: no findings",
  findings: [],
};

const FINDING_A: Finding = {
  title: "typecheck: Cannot find name 'Foo' in lib/foo.ts",
  repro: "Run `bun run typecheck` on main; expect 0 errors, got 1 in lib/foo.ts:12.",
  firstSuspectFile: "lib/foo.ts",
};
const FINDING_B: Finding = {
  title: "suite: 2 failures in tests/bar.test.ts",
  repro: "Run `bun test`; expect 243/243 green, got 241/243 (bar.test.ts:5, :19 failing).",
  firstSuspectFile: "lib/bar.ts",
};

function redRegression(findings: Finding[] = [FINDING_A, FINDING_B]): RegressionResult {
  return { verdict: "red", evidence: "typecheck: 1 error; suite: 241/243; build: pass", findings };
}

// Mirrors what the SKILL does with a plan: file-bugs -> buildBugTicket per
// finding; each deploy/audit action -> one invoker.invoke() call, in order.
// "report" is a no-op here (the report is built separately from its own input).
function simulateEndOfLoop(
  plan: EndLoopActionKind[],
  regression: RegressionResult,
  loopCount: number,
  invoker: SkillInvoker
): { bugs: ReturnType<typeof buildBugTicket>[] } {
  const bugs: ReturnType<typeof buildBugTicket>[] = [];
  for (const step of plan) {
    switch (step) {
      case "file-bugs":
        for (const f of regression.findings) bugs.push(buildBugTicket(f, "regression", loopCount));
        break;
      case "land-and-deploy":
      case "canary":
      case "document-release":
      case "cso":
      case "health":
        invoker.invoke(step as SkillName);
        break;
      case "report":
        break;
    }
  }
  return { bugs };
}

// ============================================================================
// AC1 -- red regression: zero deploy invocations, bugs filed with repro
// ============================================================================
describe("AC1: red regression -> zero deploy, bugs filed with repro", () => {
  test("plan is exactly [file-bugs, report]; no deploy action anywhere", () => {
    const plan = endLoopPlan(redRegression(), 3);
    expect(plan).toEqual(["file-bugs", "report"]);
    expect(plan).not.toContain("land-and-deploy");
    expect(plan).not.toContain("canary");
    expect(plan).not.toContain("document-release");
  });

  test("driving the plan through the recording invoker logs zero calls", () => {
    const regression = redRegression();
    const plan = endLoopPlan(regression, 3);
    const invoker = createRecordingInvoker();
    simulateEndOfLoop(plan, regression, 3, invoker);
    expect(invoker.log()).toEqual([]); // zero deploy invocations, full stop
  });

  test("every finding becomes a bug draft with repro + first-suspect file", () => {
    const regression = redRegression();
    const plan = endLoopPlan(regression, 3);
    const invoker = createRecordingInvoker();
    const { bugs } = simulateEndOfLoop(plan, regression, 3, invoker);

    expect(bugs).toHaveLength(2);
    for (const b of bugs) {
      expect(b.body).toContain("## Repro");
      expect(b.body).toContain("## First suspect");
    }
    expect(bugs[0].body).toContain(FINDING_A.repro);
    expect(bugs[0].body).toContain("lib/foo.ts");
    expect(bugs[1].body).toContain(FINDING_B.repro);
    expect(bugs[1].body).toContain("lib/bar.ts");
    expect(bugs[0].title).toContain(FINDING_A.title);
  });

  test("a red verdict with zero findings is refused loudly (nothing to file)", () => {
    expect(() => endLoopPlan({ verdict: "red", evidence: "build failed", findings: [] }, 1)).toThrow(ZError);
  });
});

// ============================================================================
// AC2 -- green path: invoker log is exactly the deploy chain, in order
// ============================================================================
describe("AC2: green path -> land-and-deploy -> canary -> document-release, in order", () => {
  test("plan (not a 5th loop) is the deploy chain plus report, no audits", () => {
    const plan = endLoopPlan(GREEN, 3);
    expect(plan).toEqual(["land-and-deploy", "canary", "document-release", "report"]);
  });

  test("invoker log matches the deploy chain exactly, in order", () => {
    const plan = endLoopPlan(GREEN, 3);
    const invoker = createRecordingInvoker();
    simulateEndOfLoop(plan, GREEN, 3, invoker);
    expect(invoker.log().map((c) => c.skill)).toEqual(["land-and-deploy", "canary", "document-release"]);
  });

  test("invocation order is preserved even if the invoker is called out of plan order by a caller bug", () => {
    // Sanity: the invoker itself just records call order -- it does not
    // reorder. This pins that log() reflects call order, not insertion sort.
    const invoker = createRecordingInvoker();
    invoker.invoke("canary");
    invoker.invoke("land-and-deploy");
    expect(invoker.log().map((c) => c.skill)).toEqual(["canary", "land-and-deploy"]);
  });

  test("createFileInvoker rejects an unknown skill name", () => {
    const invoker = createFileInvoker(join(tmp(), "log.jsonl"));
    expect(() => invoker.invoke("not-a-real-skill" as SkillName)).toThrow(ZError);
  });

  test("createFileInvoker persists the invocation log to disk, in order", () => {
    const dir = tmp();
    const logPath = join(dir, "reports", "invocations-1.jsonl");
    let t = 0;
    const invoker = createFileInvoker(logPath, () => t++);
    for (const s of ["land-and-deploy", "canary", "document-release"] as const) invoker.invoke(s);

    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.skill)).toEqual(["land-and-deploy", "canary", "document-release"]);
    expect(lines.map((l) => l.atMs)).toEqual([0, 1, 2]);
  });

  test("SKILL_NAMES names exactly the six gstack skills the invoker knows", () => {
    // Widened to string[] so toEqual compares against the plain-string list
    // below without demanding SkillName literals; the assertion is unchanged.
    expect(([...SKILL_NAMES] as string[]).sort()).toEqual(
      ["canary", "cso", "document-release", "health", "land-and-deploy", "qa-only"].sort()
    );
  });
});

// ============================================================================
// AC3 -- 5th-loop cadence + counter persistence, plus edge cases
// ============================================================================
describe("AC3: counter at 4 -> no audits; at 5 -> both fire; persistence tested", () => {
  test("loopCount 4: no cso/health", () => {
    const plan = endLoopPlan(GREEN, 4);
    expect(plan).toEqual(["land-and-deploy", "canary", "document-release", "report"]);
    expect(plan).not.toContain("cso");
    expect(plan).not.toContain("health");
  });

  test("loopCount 5: both fire, appended before report", () => {
    const plan = endLoopPlan(GREEN, 5);
    expect(plan).toEqual(["land-and-deploy", "canary", "document-release", "cso", "health", "report"]);
  });

  test("loopCount 10 (second 5th-loop): both fire again", () => {
    expect(endLoopPlan(GREEN, 10)).toContain("cso");
  });

  test("missing counter file reads as 0", () => {
    const path = join(tmp(), "loop-counter");
    expect(readLoopCounter(path)).toBe(0);
  });

  test("bump reads, increments, and persists atomically -- counter drives the audit cadence end to end", () => {
    const path = join(tmp(), "loop-counter");
    let plan: EndLoopActionKind[] = [];
    for (let i = 1; i <= 4; i++) {
      const n = bumpLoopCounter(path);
      expect(n).toBe(i);
      plan = endLoopPlan(GREEN, n);
      expect(plan).not.toContain("cso");
    }
    expect(readFileSync(path, "utf8")).toBe("4\n");

    const fifth = bumpLoopCounter(path);
    expect(fifth).toBe(5);
    expect(readLoopCounter(path)).toBe(5); // persisted, readable back
    plan = endLoopPlan(GREEN, fifth);
    expect(plan).toContain("cso");
    expect(plan).toContain("health");
  });

  test("writeLoopCounter + readLoopCounter round-trip through a fresh path", () => {
    const path = join(tmp(), "nested", "dir", "loop-counter"); // parent dirs don't exist yet
    writeLoopCounter(path, 42);
    expect(readLoopCounter(path)).toBe(42);
  });

  test("edge case: corrupt counter file throws a loud ZError, never silently resets to 0", () => {
    const path = join(tmp(), "loop-counter");
    writeFileSync(path, "not-a-number");
    expect(() => readLoopCounter(path)).toThrow(ZError);
    expect(() => readLoopCounter(path)).toThrow(/corrupt/);
    expect(() => bumpLoopCounter(path)).toThrow(ZError);
  });

  test("edge case: negative or fractional counter contents are rejected", () => {
    const path = join(tmp(), "loop-counter");
    writeFileSync(path, "-1");
    expect(() => readLoopCounter(path)).toThrow(ZError);
    writeFileSync(path, "3.5");
    expect(() => readLoopCounter(path)).toThrow(ZError);
  });

  test("endLoopPlan rejects a non-positive loopCount (must be the post-increment value)", () => {
    expect(() => endLoopPlan(GREEN, 0)).toThrow(ZError);
    expect(() => endLoopPlan(GREEN, -1)).toThrow(ZError);
  });

  // -- issue #14 H17: peek (no write) + bump-last is crash-safe cadence --------
  test("peek returns the prospective next count WITHOUT persisting it", () => {
    const path = join(tmp(), "loop-counter");
    writeLoopCounter(path, 4);
    expect(peekLoopCounter(path)).toBe(5);
    expect(readLoopCounter(path)).toBe(4); // NOT advanced -- peek never writes
    expect(peekLoopCounter(path)).toBe(5); // idempotent: repeated peeks are stable
  });

  test("peek then bump return the same value on a clean run", () => {
    const path = join(tmp(), "loop-counter"); // missing -> reads 0
    const planned = peekLoopCounter(path); // 1, used to size the plan mid-loop
    // ... end-of-loop work happens here ...
    const persisted = bumpLoopCounter(path); // persisted AFTER the report
    expect(planned).toBe(1);
    expect(persisted).toBe(planned);
    expect(readLoopCounter(path)).toBe(1);
  });

  test("a crash after peek but before bump does NOT drift the cadence", () => {
    const path = join(tmp(), "loop-counter");
    writeLoopCounter(path, 4); // four loops completed
    // Loop 5 begins: peek says 5, its plan would include the audits...
    expect(peekLoopCounter(path)).toBe(5);
    // ...but the loop crashes before bumping. Counter is untouched.
    expect(readLoopCounter(path)).toBe(4);
    // The re-run peeks 5 again (same loop id, audits still due) -- no forward drift.
    expect(peekLoopCounter(path)).toBe(5);
    expect(endLoopPlan(GREEN, peekLoopCounter(path))).toContain("cso");
    // Only a clean finish advances it.
    expect(bumpLoopCounter(path)).toBe(5);
    expect(peekLoopCounter(path)).toBe(6);
  });
});

// ============================================================================
// issue #18 -- auditEveryNLoops parameterizes the cadence (endLoopPlan)
// ============================================================================
describe("issue #18: endLoopPlan takes the audit cadence as a parameter", () => {
  test("N=1: every loop fires cso + health", () => {
    for (let loopCount = 1; loopCount <= 4; loopCount++) {
      const plan = endLoopPlan(GREEN, loopCount, 1);
      expect(plan).toContain("cso");
      expect(plan).toContain("health");
    }
  });

  test("N=3: loop 3 fires, loop 4 does not", () => {
    expect(endLoopPlan(GREEN, 3, 3)).toEqual(["land-and-deploy", "canary", "document-release", "cso", "health", "report"]);
    const plan4 = endLoopPlan(GREEN, 4, 3);
    expect(plan4).not.toContain("cso");
    expect(plan4).not.toContain("health");
  });

  test("N omitted: default of 5 preserves the old hardcoded behavior (AC2)", () => {
    expect(endLoopPlan(GREEN, 5)).toContain("cso"); // no 3rd arg at all
    expect(endLoopPlan(GREEN, 4)).not.toContain("cso");
  });

  test("rejects a non-positive or non-integer cadence, naming the requirement", () => {
    for (const bad of [0, -1, 2.5, NaN]) {
      expect(() => endLoopPlan(GREEN, 5, bad)).toThrow(ZError);
      expect(() => endLoopPlan(GREEN, 5, bad)).toThrow(/auditEveryNLoops must be a positive integer/);
    }
  });

  test("red-path plans are unaffected by the cadence argument", () => {
    const plan = endLoopPlan(redRegression(), 3, 1); // N=1 would fire cso on green; red never does
    expect(plan).toEqual(["file-bugs", "report"]);
  });
});

// ============================================================================
// issue #18 -- `endloop plan` CLI: optional 3rd arg (auditEveryNLoops)
// ============================================================================
describe("issue #18: endloop CLI `plan <regression.json> <loopCount> [auditEveryNLoops]`", () => {
  let logs: ReturnType<typeof spyOn>;
  let errs: ReturnType<typeof spyOn>;
  beforeEach(() => {
    logs = spyOn(console, "log").mockImplementation(() => {});
    errs = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logs.mockRestore();
    errs.mockRestore();
  });

  function regressionFile(): string {
    const path = join(tmp(), "regression.json");
    writeFileSync(path, JSON.stringify(GREEN));
    return path;
  }
  function lastPlan(): EndLoopActionKind[] {
    return JSON.parse(logs.mock.calls.at(-1)![0] as string);
  }

  test("AC1: cadence 3 passed explicitly -- loop 3 includes cso/health, loop 4 does not", () => {
    const path = regressionFile();
    expect(main(["plan", path, "3", "3"])).toBe(0);
    expect(lastPlan()).toContain("cso");

    expect(main(["plan", path, "4", "3"])).toBe(0);
    expect(lastPlan()).not.toContain("cso");
  });

  test("cadence omitted entirely defaults to 5 (back-compat)", () => {
    const path = regressionFile();
    expect(main(["plan", path, "5"])).toBe(0);
    expect(lastPlan()).toContain("cso");
    expect(main(["plan", path, "4"])).toBe(0);
    expect(lastPlan()).not.toContain("cso");
  });

  test("AC3: a zero, negative, or non-integer cadence arg exits 1 with a named error, no crash", () => {
    const path = regressionFile();
    for (const bad of ["0", "-1", "2.5", "abc"]) {
      expect(main(["plan", path, "5", bad])).toBe(1);
      expect(errs).toHaveBeenCalled();
    }
  });
});

// ============================================================================
// AC4 -- the final report: verdict+evidence, dollars, status table, edges rollup
// ============================================================================
describe("AC4: final report -- verdict, dollars, tickets by status, edges rollup", () => {
  test("green report with a 5th-loop audit: every required element present", () => {
    const report = buildEndLoopReport({
      regression: GREEN,
      loopCount: 5,
      auditsRan: true,
      tickets: [
        { number: 10, title: "Add CSV export", status: "Done", actualDollars: 3.25 },
        { number: 11, title: "Fix flaky test", status: "Questions", actualDollars: 1.1 },
        { number: 12, title: "Refactor Z", status: "Blocked", actualDollars: 0.5 },
        { number: 13, title: "Dead ticket", status: "Skipped", actualDollars: 0.1 },
      ],
      edges: [
        {
          ticket: 10,
          edges: [{ check: "empty-list export", doStep: "export with zero rows", expect: "a header-only CSV, not an error" }],
        },
      ],
      bugsFiled: [{ number: 20, title: "[cso] hardcoded secret in lib/x.ts" }],
    });

    // verdict with evidence
    expect(report).toContain("GREEN");
    expect(report).toContain(GREEN.evidence);
    // dollars: sum of Actuals passed in, never re-derived
    expect(report).toContain("$4.95");
    // tickets by final status
    expect(report).toContain("Done: 1");
    expect(report).toContain("Questions: 1");
    expect(report).toContain("Blocked: 1");
    expect(report).toContain("Skipped: 1");
    expect(report).toContain("#10");
    expect(report).toContain("Add CSV export");
    // edges-to-validate rollup
    expect(report).toContain("to check empty-list export, do export with zero rows, expect a header-only CSV, not an error.");
    // bugs filed
    expect(report).toContain("#20 [cso] hardcoded secret in lib/x.ts");
    // audits called out (cadence-neutral: no hardcoded "5th-loop" wording, since the cadence is configurable)
    expect(report).toContain("audits (cso + health) also ran this loop");
  });

  test("red report states plainly that no deploy happened, and lists the filed bugs", () => {
    const regression = redRegression([FINDING_A]);
    const report = buildEndLoopReport({
      regression,
      loopCount: 2,
      auditsRan: false,
      tickets: [],
      edges: [],
      bugsFiled: [{ number: 30, title: "[regression] " + FINDING_A.title }],
    });
    expect(report).toContain("RED");
    expect(report).toContain("NO deploy");
    expect(report).not.toContain("land-and-deploy ->");
    expect(report).toContain("#30");
  });

  test("no tickets, no edges, no bugs: the report still renders with explicit 'none' markers", () => {
    const report = buildEndLoopReport({
      regression: GREEN,
      loopCount: 1,
      auditsRan: false,
      tickets: [],
      edges: [],
      bugsFiled: [],
    });
    expect(report).toContain("None surfaced.");
    expect(report).toContain("None filed.");
    expect(report).toContain("$0.00");
  });
});

// ============================================================================
// ticket #83, AC5 -- spend-by-stage table in the end-of-loop report
// ============================================================================
describe("AC5 (ticket #83): '## Spend by stage' table", () => {
  const BASE_INPUT: EndLoopReportInput = {
    regression: GREEN,
    loopCount: 1,
    auditsRan: false,
    tickets: [],
    edges: [],
    bugsFiled: [],
  };

  test("without spendByStage, the report is byte-identical to the pre-existing (no-tickets) fixture", () => {
    const report = buildEndLoopReport(BASE_INPUT);
    expect(report).not.toContain("## Spend by stage");
    // Golden string captured from buildEndLoopReport BEFORE the spendByStage
    // field existed -- pins that adding the optional field changes nothing
    // when it's absent (AC5's second clause).
    expect(report).toBe(
      "# End-of-loop report -- loop 1\n\n" +
        `**Verdict:** GREEN -- ${GREEN.evidence}\n\n` +
        "**Deploy:** land-and-deploy -> canary -> document-release completed, in that order.\n\n" +
        "**Total spend:** $0.00 (sum of ticket Actuals)\n\n" +
        "## Tickets by final status\n\n" +
        "- Done: 0\n- Questions: 0\n- Blocked: 0\n- Skipped: 0\n\n" +
        "| # | Title | Status | Actual |\n|---|---|---|---|\n| -- | (no tickets in this batch) | -- | -- |\n\n" +
        "## Edges a human must validate\n\n- None surfaced.\n\n" +
        "## Bugs filed to Backlog\n\n- None filed.\n"
    );
  });

  test("with spendByStage, renders the table in fixed order builder/qa/reviewer/merge/other, $0.00 rows included", () => {
    const report = buildEndLoopReport({
      ...BASE_INPUT,
      spendByStage: [
        { stage: "qa", dollars: 1.5 },
        { stage: "builder", dollars: 3.25 },
      ],
    });
    expect(report).toContain("## Spend by stage");
    const section = report.slice(report.indexOf("## Spend by stage"), report.indexOf("## Tickets by final status"));

    // fixed row order regardless of input order
    const order = ["builder", "qa", "reviewer", "merge", "other"];
    const rowIndexes = order.map((s) => section.indexOf(`| ${s} |`));
    expect(rowIndexes.every((i) => i >= 0)).toBe(true);
    for (let i = 1; i < rowIndexes.length; i++) expect(rowIndexes[i]).toBeGreaterThan(rowIndexes[i - 1]);

    expect(section).toContain("| builder | $3.25 |");
    expect(section).toContain("| qa | $1.50 |");
    expect(section).toContain("| reviewer | $0.00 |"); // no reviewer bounces this loop -- still shown (the shape)
    expect(section).toContain("| merge | $0.00 |");
    expect(section).toContain("| other | $0.00 |");
  });

  test("an unrecognized stage name in spendByStage is ignored by the fixed-row render (never crashes)", () => {
    const report = buildEndLoopReport({ ...BASE_INPUT, spendByStage: [{ stage: "mystery", dollars: 9.99 }] });
    expect(report).toContain("| builder | $0.00 |");
    expect(report).not.toContain("mystery");
  });
});

// ============================================================================
// ticket #83 -- `endloop spend-by-stage <cost-result.json>` CLI: feeds
// "z-cost --json --by-file"'s output through sumByStage for the report.
// ============================================================================
describe("ticket #83: endloop CLI `spend-by-stage <cost-result.json>`", () => {
  let logs: ReturnType<typeof spyOn>;
  let errs: ReturnType<typeof spyOn>;
  beforeEach(() => {
    logs = spyOn(console, "log").mockImplementation(() => {});
    errs = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logs.mockRestore();
    errs.mockRestore();
  });

  test("reads a z-cost --by-file result and prints sumByStage's output as JSON", () => {
    const costResultPath = join(tmp(), "cost-result.json");
    writeFileSync(
      costResultPath,
      JSON.stringify({
        total: 0.45,
        by_model: [],
        by_file: [
          { file: "qa-1.jsonl", dollars: 0.3, requests: 1, tokens: { fresh_input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
          { file: "qa-2.jsonl", dollars: 0.15, requests: 1, tokens: { fresh_input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
        ],
        requests: 2,
        lines_parsed: 2,
        skippedSynthetic: 0,
      })
    );
    expect(main(["spend-by-stage", costResultPath])).toBe(0);
    const printed = JSON.parse(logs.mock.calls.at(-1)![0] as string);
    expect(printed).toEqual([{ stage: "qa", dollars: 0.45 }]);
  });

  test("a cost-result.json with no by_file key exits 1 with a named error, no crash", () => {
    const costResultPath = join(tmp(), "cost-result.json");
    writeFileSync(costResultPath, JSON.stringify({ total: 0, by_model: [], requests: 0, lines_parsed: 0, skippedSynthetic: 0 }));
    expect(main(["spend-by-stage", costResultPath])).toBe(1);
    expect(errs.mock.calls.flat().join(" ")).toMatch(/by_file/);
  });
});
