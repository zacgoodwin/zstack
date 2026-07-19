// Gate tests for the e2e checker itself (C10). The checker in evals/e2e/ is only
// trustworthy if it (a) passes on a known-good run and (b) actually catches a
// broken one -- a checker that never fails proves nothing. So this drives
// runAllAssertions against the hand-authored sample-run (all green), then against
// temp copies with one artifact each mutated, asserting the RIGHT named assertion
// flips to fail. Deterministic, no network, well under the 2s gate budget.
import { test, expect, describe, afterEach } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAllAssertions, type AssertionResult } from "../evals/e2e/assertions.ts";
import { main, SAMPLE_RUN } from "../evals/e2e/check.ts";

const REPO_ROOT = join(import.meta.dir, "..");

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

// A fresh temp copy of the sample-run with `mutate` applied, then checked.
function checkMutated(mutate: (dir: string) => void): AssertionResult[] {
  const dir = mkdtempSync(join(tmpdir(), "zstack-e2e-check-"));
  tmps.push(dir);
  cpSync(SAMPLE_RUN, dir, { recursive: true });
  mutate(dir);
  return runAllAssertions(dir);
}

function byName(results: AssertionResult[], name: string): AssertionResult {
  const r = results.find((x) => x.name === name);
  if (!r) throw new Error(`no assertion named "${name}" in results`);
  return r;
}

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2));

// ============================================================================
// The known-good sample-run: every assertion passes
// ============================================================================
describe("sample-run (known good): every assertion passes", () => {
  const results = runAllAssertions(SAMPLE_RUN);

  test("ten assertions all pass", () => {
    const failed = results.filter((r) => !r.pass);
    expect(failed.map((r) => `${r.name}: ${r.detail}`)).toEqual([]);
    expect(results).toHaveLength(10);
  });

  test("the exact assertion set is present (the DoD coverage the README maps)", () => {
    expect(results.map((r) => r.name).sort()).toEqual(
      [
        "actuals",
        "completion-notes",
        "deploy-chain",
        "fresh-context",
        "lane-cap",
        "loop-counter",
        "merge-order",
        "report",
        "reviewer-blindness",
        "walk",
      ].sort()
    );
  });

  test("check.ts main() exits 0 on the sample-run", () => {
    expect(main([SAMPLE_RUN])).toBe(0);
  });
});

// ============================================================================
// Mutated runs: the right assertion flips to fail
// ============================================================================
describe("mutated runs: the checker catches the specific break", () => {
  test("out-of-order merge (mergedThisRun [2,1,3]) fails merge-order", () => {
    const results = checkMutated((dir) => {
      const p = join(dir, "state-final.json");
      const s = readJson(p);
      s.mergedThisRun = [2, 1, 3]; // #2 lands before its dependency #1
      writeJson(p, s);
    });
    const r = byName(results, "merge-order");
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("#2 merged before its dependency #1");
  });

  test("a missing Actual field fails actuals", () => {
    const results = checkMutated((dir) => {
      const p = join(dir, "board-final.json");
      const board = readJson(p);
      delete board[1].fields.Actual; // ticket #2 loses its Actual
      writeJson(p, board);
    });
    const r = byName(results, "actuals");
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("#2 has no positive numeric Actual");
  });

  test("an Actual that disagrees with z-cost fails actuals (drift gate)", () => {
    const results = checkMutated((dir) => {
      const p = join(dir, "board-final.json");
      const board = readJson(p);
      board[0].fields.Actual = 99.99; // #1 no longer matches its transcripts
      writeJson(p, board);
    });
    const r = byName(results, "actuals");
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("!= z-cost");
  });

  test("a completion note with no edges fails completion-notes", () => {
    const results = checkMutated((dir) => {
      const p = join(dir, "notes", "note-3.json");
      const note = readJson(p);
      note.edges = [];
      writeJson(p, note);
    });
    const r = byName(results, "completion-notes");
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("no edges");
  });

  test("a leaked key in a reviewer input fails reviewer-blindness", () => {
    const results = checkMutated((dir) => {
      const p = join(dir, "stage-inputs", "ticket-1-reviewer.json");
      const input = readJson(p);
      input.prDescription = "the builder's own summary -- must never reach the reviewer";
      writeJson(p, input);
    });
    const r = byName(results, "reviewer-blindness");
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("not blinded");
  });

  test("loop-counter respects a non-default auditEveryNLoops from fixture state (issue #18)", () => {
    // sample-run is loop 3 under the default (every-5th-loop) cadence, so its
    // invocation log correctly carries no cso/health. Configure a cadence of 3
    // via state-initial.json and add the audit invocations a loop-3 run WOULD
    // produce under that cadence -- this only passes if the assertion reads
    // the fixture's cadence instead of a hardcoded `% 5`.
    const results = checkMutated((dir) => {
      const sp = join(dir, "state-initial.json");
      const s = readJson(sp);
      s.auditEveryNLoops = 3;
      writeJson(sp, s);

      const invPath = join(dir, "reports", "invocations-20260719-101500.jsonl");
      const lines = readFileSync(invPath, "utf8").trim().split("\n");
      lines.push(JSON.stringify({ skill: "cso", atMs: 4000 }), JSON.stringify({ skill: "health", atMs: 5000 }));
      writeFileSync(invPath, lines.join("\n") + "\n");
    });
    const r = byName(results, "loop-counter");
    expect(r.pass).toBe(true);
    expect(r.detail).toContain("present");
  });

  test("loop-counter still fails when audits are missing under a non-default cadence that expects them", () => {
    // Same cadence=3 config, but WITHOUT adding the cso/health invocations --
    // proves the assertion's expectation actually flipped with the cadence
    // (not just always-pass), since under the default cadence (5) loop 3
    // correctly expects no audits, but under cadence 3 it does.
    const results = checkMutated((dir) => {
      const sp = join(dir, "state-initial.json");
      const s = readJson(sp);
      s.auditEveryNLoops = 3;
      writeJson(sp, s);
    });
    const r = byName(results, "loop-counter");
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("expected=true");
  });

  test("a report total that disagrees with the board Actuals fails report", () => {
    const results = checkMutated((dir) => {
      const p = join(dir, "board-final.json");
      const board = readJson(p);
      board[0].fields.Actual = 1.36; // total now 4.06, report still says 4.05
      writeJson(p, board);
    });
    const r = byName(results, "report");
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("!= sum of board Actuals");
  });

  test("check.ts main() exits 1 on a broken run", () => {
    const dir = mkdtempSync(join(tmpdir(), "zstack-e2e-check-"));
    tmps.push(dir);
    cpSync(SAMPLE_RUN, dir, { recursive: true });
    const p = join(dir, "state-final.json");
    const s = readJson(p);
    s.mergedThisRun = [3, 2, 1];
    writeJson(p, s);
    expect(main([dir])).toBe(1);
  });
});

// ============================================================================
// Structural: the C10 deliverables exist where the docs say they do
// ============================================================================
describe("C10 deliverables are on disk", () => {
  const files = [
    "evals/fixture-app/package.json",
    "evals/fixture-app/src/routes.ts",
    "evals/fixture-app/src/server.ts",
    "evals/fixture-app/test/routes.test.ts",
    "evals/fixture-app/scripts/deploy",
    "evals/fixture-app/docs/user-guide/index.md",
    "evals/e2e/run.md",
    "evals/e2e/fixture-spec.md",
    "evals/e2e/README.md",
    "evals/e2e/assertions.ts",
    "evals/e2e/check.ts",
    "docs/user-guide/z-setup.md",
    "docs/user-guide/z-plan.md",
    "docs/user-guide/z-loop.md",
    "docs/user-guide/z-status.md",
    "docs/user-guide/troubleshooting.md",
  ];
  for (const f of files) {
    test(`${f} exists`, () => {
      expect(existsSync(join(REPO_ROOT, f))).toBe(true);
    });
  }

  test("the fixture-app package.json wires typecheck/test/build/deploy", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "evals/fixture-app/package.json"), "utf8"));
    for (const s of ["typecheck", "test", "build", "deploy"]) expect(pkg.scripts[s]).toBeString();
  });
});
