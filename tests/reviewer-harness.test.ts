// Gate tests for the reviewer eval harnesses' grade reader (issue #108).
//
// The bug these pin: evals/reviewer/run.sh and evals/reviewer-severity/run.sh
// parsed the grader's reply inline with `JSON.parse(readFileSync(...))`. The
// grader is a live `claude -p`, and it wraps its JSON in a ```json fence more
// often than not. JSON.parse threw, bun wrote nothing, and the shell compare
// scored the trial FAIL no matter what the grader decided. On the paid 5-trial
// run recorded on #108, 4 of 5 grade files were fenced -- the run could not
// have scored above 1/5 even with a perfect fixture, and it reported "0/5" as
// though that were a measurement of the reviewer.
//
// The free structural smoke test never caught it because mock-claude.sh only
// ever emitted bare JSON. Both halves are fixed here: evals/lib/grade.ts owns
// the extraction, and MOCK_CLAUDE_GRADE_WRAP lets the mock reproduce the real
// grader's reply shapes. Deterministic and free -- no claude -p, no network.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractJsonObject, readGradeVerdict, verdictToken } from "../evals/lib/grade.ts";
import { parseReviewerConfidence, parseSkepticQuorum } from "../lib/loop.ts";
import { adversarialActive, reviewerPrompt, type AdversarialMode } from "../lib/stage-prompts.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const REVIEWER_DIR = join(REPO_ROOT, "evals", "reviewer");
const SEVERITY_DIR = join(REPO_ROOT, "evals", "reviewer-severity");

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

const GRADE = `{"adversarialMarker":"REVIEW-FINDINGS","singlePassMarker":"REVIEW-APPROVE","namesDefect":true,"adversarialConfidence":0,"pass":true}`;

// ============================================================================
// 1. extractJsonObject -- the shapes a live grader actually emits
// ============================================================================
describe("extractJsonObject", () => {
  test("bare JSON round-trips", () => {
    expect(extractJsonObject(GRADE)).toBe(GRADE);
  });

  test("```json fenced -- the exact shape that broke #108's paid run", () => {
    expect(extractJsonObject("```json\n" + GRADE + "\n```\n")).toBe(GRADE);
  });

  test("bare ``` fence (no language tag)", () => {
    expect(extractJsonObject("```\n" + GRADE + "\n```")).toBe(GRADE);
  });

  test("prose around the object", () => {
    expect(extractJsonObject(`Here is the grade:\n\n${GRADE}\n\nHappy to explain.`)).toBe(GRADE);
  });

  test("prose AND a fence together", () => {
    expect(extractJsonObject(`Sure. Grade:\n\`\`\`json\n${GRADE}\n\`\`\`\nDone.`)).toBe(GRADE);
  });

  test("CRLF line endings (this box is Windows; every tool here emits CRLF)", () => {
    expect(extractJsonObject("```json\r\n" + GRADE + "\r\n```\r\n")).toBe(GRADE);
  });

  test("a UTF-8 BOM prefix does not defeat the parse", () => {
    expect(extractJsonObject("﻿" + GRADE)).toBe(GRADE);
  });

  test("pretty-printed multi-line JSON inside a fence", () => {
    const pretty = JSON.stringify(JSON.parse(GRADE), null, 2);
    expect(extractJsonObject("```json\n" + pretty + "\n```")).toBe(pretty);
  });

  test("no object at all returns null rather than guessing", () => {
    expect(extractJsonObject("I was unable to grade this trial.")).toBeNull();
    expect(extractJsonObject("")).toBeNull();
    expect(extractJsonObject("{ unterminated")).toBeNull();
  });
});

// ============================================================================
// 2. readGradeVerdict -- pass / fail / unreadable are three distinct outcomes
// ============================================================================
describe("readGradeVerdict", () => {
  test("pass:true and pass:false are graded verdicts, fenced or not", () => {
    expect(readGradeVerdict(GRADE).status).toBe("pass");
    expect(readGradeVerdict("```json\n" + GRADE + "\n```").status).toBe("pass");
    expect(readGradeVerdict(GRADE.replace('"pass":true', '"pass":false')).status).toBe("fail");
    expect(readGradeVerdict("```json\n" + GRADE.replace('"pass":true', '"pass":false') + "\n```").status).toBe("fail");
  });

  // The distinction that matters: an unreadable grade must NOT masquerade as a
  // graded failure, or a broken harness reads as a bad reviewer (#108).
  test("unreadable output is not a graded FAIL", () => {
    const v = readGradeVerdict("I was unable to grade this trial.");
    expect(v.status).toBe("unreadable");
    expect(verdictToken(v)).toBe("UNREADABLE");
  });

  test("malformed JSON inside a well-formed fence is unreadable, and says why", () => {
    const v = readGradeVerdict("```json\n{\"pass\": tru}\n```");
    expect(v.status).toBe("unreadable");
    if (v.status === "unreadable") expect(v.reason).toMatch(/not valid JSON/);
  });

  test("a missing `pass` field is unreadable, not a silent FAIL", () => {
    const v = readGradeVerdict(`{"marker":"REVIEW-FINDINGS","namesDefect":true}`);
    expect(v.status).toBe("unreadable");
    if (v.status === "unreadable") expect(v.reason).toMatch(/no boolean "pass"/);
  });

  test("a non-boolean `pass` (string \"true\") is unreadable, not a pass", () => {
    const v = readGradeVerdict(`{"pass":"true"}`);
    expect(v.status).toBe("unreadable");
  });

  test("a JSON array or scalar is unreadable", () => {
    expect(readGradeVerdict("[1,2,3]").status).toBe("unreadable");
    expect(readGradeVerdict("```json\n42\n```").status).toBe("unreadable");
  });

  // Verbatim bytes from the #108 paid run's artifacts (grade-1 and grade-4 of
  // /tmp/tmp.GQUPZrsvHu). grade-1 is a genuine fenced verdict the old compare
  // discarded; grade-4 is the grader drifting the schema -- booleans where the
  // marker strings belong. Both must be handled, and differently.
  test("regression pin: the real grade-1.json from #108's paid run parses", () => {
    const real = '```json\n{"adversarialMarker": "REVIEW-FINDINGS:", "singlePassMarker": "REVIEW-FINDINGS:", "namesDefect": true, "adversarialConfidence": 0, "pass": false}\n```\n';
    expect(readGradeVerdict(real).status).toBe("fail"); // a real graded FAIL, now legible
  });

  test("regression pin: the real grade-4.json from #108 keeps a readable boolean pass", () => {
    const real = '```json\n{"adversarialMarker": true, "singlePassMarker": false, "namesDefect": true, "adversarialConfidence": 0, "pass": false}\n```\n';
    expect(readGradeVerdict(real).status).toBe("fail");
  });
});

// ============================================================================
// 3. The exact expression the harnesses used to run, proving it was broken.
//    This is the assertion that would have caught #108 before the paid run.
// ============================================================================
describe("the old inline compare (regression evidence)", () => {
  function oldInlineCompare(fileContents: string): string {
    // Verbatim semantics of the removed line: JSON.parse the whole file, write
    // PASS/FAIL. On a fence it throws, the process writes nothing, and the
    // shell's `= "PASS"` test sees an empty string -- i.e. FAIL.
    try {
      return JSON.parse(fileContents).pass === true ? "PASS" : "FAIL";
    } catch {
      return "";
    }
  }

  test("old compare: a fenced pass:true yielded an empty token (counted FAIL)", () => {
    expect(oldInlineCompare("```json\n" + GRADE + "\n```")).toBe("");
  });

  test("new reader: the same fenced pass:true is a PASS", () => {
    expect(verdictToken(readGradeVerdict("```json\n" + GRADE + "\n```"))).toBe("PASS");
  });

  test("old and new agree on bare JSON -- the fix changed nothing that worked", () => {
    expect(oldInlineCompare(GRADE)).toBe("PASS");
    expect(verdictToken(readGradeVerdict(GRADE))).toBe("PASS");
  });
});

// ============================================================================
// 4. The grade.ts CLI -- the contract run.sh actually consumes
// ============================================================================
describe("grade.ts CLI", () => {
  function runCli(contents: string): { token: string; stderr: string; exitCode: number } {
    const dir = mkdtempSync(join(tmpdir(), "zreviewer-grade-"));
    tmps.push(dir);
    const file = join(dir, "grade.json");
    writeFileSync(file, contents, "utf8");
    const proc = Bun.spawnSync(["bun", join(REPO_ROOT, "evals", "lib", "grade.ts"), file], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      token: proc.stdout.toString().trim(),
      stderr: proc.stderr.toString(),
      exitCode: proc.exitCode ?? 1,
    };
  }

  test("fenced pass:true -> PASS on stdout, exit 0", () => {
    const r = runCli("```json\n" + GRADE + "\n```\n");
    expect(r.token).toBe("PASS");
    expect(r.exitCode).toBe(0);
  });

  test("bare pass:false -> FAIL, exit 0", () => {
    expect(runCli(GRADE.replace('"pass":true', '"pass":false')).token).toBe("FAIL");
  });

  test("ungradeable text -> UNREADABLE with the reason on stderr, still exit 0", () => {
    const r = runCli("I was unable to grade this trial.");
    expect(r.token).toBe("UNREADABLE");
    expect(r.stderr).toMatch(/no JSON object found/);
    // Exit 0 is deliberate: a nonzero exit would trip run.sh's `set -e` before
    // it could count the trial. The token carries the outcome.
    expect(r.exitCode).toBe(0);
  });

  test("a missing file -> UNREADABLE, never a crash", () => {
    const proc = Bun.spawnSync(["bun", join(REPO_ROOT, "evals", "lib", "grade.ts"), "/definitely/not/here.json"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.stdout.toString().trim()).toBe("UNREADABLE");
    expect(proc.exitCode).toBe(0);
  });
});

// ============================================================================
// 5. Mocked end-to-end: both harnesses' REAL orchestration, through
//    mock-claude.sh. The `fence` case is the one that fails against the old
//    inline parse -- the test that would have saved #108's paid run.
// ============================================================================
function runEval(
  dir: string,
  args: string[],
  envOverrides: Record<string, string> = {}
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bash", join(dir, "run.sh"), ...args], {
    env: { ...process.env, CLAUDE_CMD: `bash ${join(dir, "mock-claude.sh")}`, ...envOverrides },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode ?? 1,
    stdout: proc.stdout?.toString() ?? "",
    stderr: proc.stderr?.toString() ?? "",
  };
}

// Each of these spawns bash + several bun processes, so they run in seconds,
// not milliseconds. RUNS is kept at the minimum each assertion needs: the
// exit-0 cases require 5 trials (run.sh's threshold is a literal `-ge 4`, which
// #108's AC3 forbids touching), while the failure cases prove out at RUNS=1.
const E2E_TIMEOUT_MS = 30_000;

describe("mocked end-to-end: evals/reviewer/run.sh", () => {
  test("bare grade JSON: 5/5, PASS, exit 0 (the pre-existing smoke, still green)", () => {
    const r = runEval(REVIEWER_DIR, ["5"]);
    expect(r.stdout).toContain("in 5/5 trials");
    expect(r.exitCode).toBe(0);
  }, E2E_TIMEOUT_MS);

  // THE regression test. Against the old inline parse this scores 0/5 and exits
  // 1; the reviewer outputs are identical in both cases, so the only variable is
  // how the grade file was formatted.
  test("FENCED grade JSON still scores 5/5 -- the #108 regression", () => {
    const r = runEval(REVIEWER_DIR, ["5"], { MOCK_CLAUDE_GRADE_WRAP: "fence" });
    expect(r.stdout).toContain("in 5/5 trials");
    expect(r.exitCode).toBe(0);
  }, E2E_TIMEOUT_MS);

  test("a genuine graded failure still fails the threshold, exit 1 -- not masked as a harness error", () => {
    const r = runEval(REVIEWER_DIR, ["1"], { MOCK_CLAUDE_PASS: "false" });
    expect(r.stdout).toContain("in 0/1 trials");
    // #318 added a second gate, so the verdict line names both possible causes.
    expect(r.stdout).toContain("FAIL: recall below threshold, or a reviewer stage reported no exit marker");
    expect(r.exitCode).toBe(1);
    // ...and this failure is the RECALL one: the mock still emits markers, so the
    // marker gate passed and did not contribute to the exit code.
    expect(r.stdout).toContain("exit marker reported: 2/2 reviewer stages");
    expect(r.stdout).not.toContain("MISSING MARKER");
  }, E2E_TIMEOUT_MS);

  test("ungradeable output reports HARNESS ERROR and exit 2, never a score", () => {
    const r = runEval(REVIEWER_DIR, ["1"], { MOCK_CLAUDE_GRADE_WRAP: "garbage" });
    expect(r.stdout).toContain("HARNESS ERROR");
    expect(r.stdout).toContain("1 of 1 grader outputs were unreadable");
    expect(r.stdout).not.toContain("trials (pass threshold"); // the point: no fake measurement
    expect(r.exitCode).toBe(2);
  }, E2E_TIMEOUT_MS);
});

describe("mocked end-to-end: evals/reviewer-severity/run.sh", () => {
  test("bare grade JSON: every fixture passes, exit 0", () => {
    const r = runEval(SEVERITY_DIR, ["1"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[prose-nit] correct classification in 1/1");
    expect(r.stdout).toContain("[weakened-ac] correct classification in 1/1");
    expect(r.stdout).toContain("[wrong-runbook] correct classification in 1/1");
  }, E2E_TIMEOUT_MS);

  test("FENCED grade JSON still passes every fixture -- same #108 regression", () => {
    const r = runEval(SEVERITY_DIR, ["1"], { MOCK_CLAUDE_GRADE_WRAP: "fence" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[prose-nit] correct classification in 1/1");
  }, E2E_TIMEOUT_MS);

  test("ungradeable output reports HARNESS ERROR and exit 2", () => {
    const r = runEval(SEVERITY_DIR, ["1"], { MOCK_CLAUDE_GRADE_WRAP: "garbage" });
    expect(r.stdout).toContain("HARNESS ERROR");
    expect(r.exitCode).toBe(2);
  }, E2E_TIMEOUT_MS);

  // -- #191's skeptic-starved fixture -----------------------------------------
  //
  // It is the only fixture built ADVERSARIAL, because starvation is the thing it
  // measures. If the per-fixture `adversarial-mode` hook silently stopped being
  // read, the fixture would quietly build the single-pass prompt -- which carries
  // no skeptics= token at all, so the reviewer could not report a denominator and
  // the paid run would measure nothing while still printing a score.
  test("#191: run.sh honors each fixture's adversarial-mode, and only skeptic-starved is adversarial", () => {
    const r = runEval(SEVERITY_DIR, ["1"]);
    expect(r.exitCode).toBe(0);
    // run.sh prints the mode it actually resolved per fixture, so the hook's
    // effect is observable without reparsing an msys temp path (#175).
    expect(r.stdout).toMatch(/\[skeptic-starved\] correct classification in 1\/1.*mode=always/);
    // The three classification fixtures stay on the single pass -- #191 must not
    // have quietly turned the whole eval adversarial (and 4x more expensive).
    for (const fix of ["prose-nit", "weakened-ac", "wrong-runbook"]) {
      expect(r.stdout).toMatch(new RegExp(`\\[${fix}\\].*mode=off`));
    }
    // And the resolved mode is what actually reaches the constructor.
    expect(readFileSync(join(SEVERITY_DIR, "run.sh"), "utf8")).toContain('--adversarial-mode "$MODE"');
  }, E2E_TIMEOUT_MS);

  // The other half of the chain: that mode, applied to that fixture, really does
  // produce a prompt that can carry a denominator. Pure -- no subprocess.
  test("#191: the skeptic-starved fixture's mode yields a prompt that demands the denominator", () => {
    const mode = readFileSync(join(SEVERITY_DIR, "fixtures", "skeptic-starved", "adversarial-mode"), "utf8").trim();
    expect(mode).toBe("always");
    const prompt = reviewerPrompt(
      { ticketBody: "b", acceptanceCriteria: "a", diff: "d", worktreePath: "/w" },
      "/tmp/input.json",
      adversarialActive(mode as AdversarialMode, 0, [])
    );
    expect(prompt).toContain("Super-truth pass");
    expect(prompt).toContain("skeptics=<k>/3");
    // #318 replaced #191's "Delivery is BEST-EFFORT / check at most once" wording
    // with a named degraded exit, which is what this fixture actually exercises:
    // a reviewer holding fewer than three verdicts must still report one.
    expect(prompt).toContain("DEGRADED COLLECTION");
  });

  // The mock stands in for a real reviewer, so its canned starved output must
  // itself satisfy the rubric's pass rule -- otherwise the mock would "pass" the
  // harness while modelling behavior the paid run would fail.
  test("#191: the mock's starved output satisfies the rubric's pass rule", () => {
    const proc = Bun.spawnSync(["bash", join(SEVERITY_DIR, "mock-claude.sh"), "the reviewer prompt"], {
      env: { ...process.env, MOCK_FIXTURE: "skeptic-starved" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString();
    expect(out.trimStart().startsWith("REVIEW-APPROVE:")).toBe(true); // a marker, never a silent turn
    expect(parseSkepticQuorum(out)).toEqual({ received: 0, of: 3 }); // an honest denominator
    // NOT inflated: 0 verdicts must not carry confidence=100.
    expect(parseReviewerConfidence(out)).not.toBe(100);
    expect(parseReviewerConfidence(out)).toBeGreaterThan(0);
  });
});
