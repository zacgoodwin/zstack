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
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bumpLoopCounter,
  buildBugTicket,
  buildEndLoopReport,
  endLoopPlan,
  peekLoopCounter,
  readLoopCounter,
  writeLoopCounter,
  ZError,
  type EndLoopActionKind,
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
    // 5th-loop audits called out
    expect(report).toContain("5th-loop audits");
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
