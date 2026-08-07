// Gate tests for the re-targeted reviewer eval's deterministic scorer
// (evals/lib/recall.ts, issue #108 follow-up).
//
// What these pin: the eval no longer asks whether adversarial mode catches one
// planted needle single-pass approves -- 16 real single-pass reads showed that
// contract is unsatisfiable (evals/reviewer/run.md "## Results"). It now asks
// how much of what is wrong each mode surfaces, over a fixture carrying many
// independent defects. The live grader answers only the latent half ("did this
// output name defect D3?"); every count, mean, delta and threshold is computed
// in recall.ts so the score can never be read out of a model's prose.
//
// The two invariants worth breaking a build over:
//   1. Grader schema drift is UNREADABLE, never a graded miss. Scoring a
//      missing defect id as `false` would understate recall and quietly turn a
//      harness fault into a measurement -- the #108 failure mode, one level up.
//   2. The pass rule is a trial COUNT, not a mean, so one lopsided trial cannot
//      carry a run that lost the other four.
// Deterministic and free -- no claude -p, no network.
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  hasExitMarker,
  readTrialGrade,
  scoreTrial,
  scoreRun,
  formatReport,
  requiredPasses,
  REVIEWER_MARKERS,
  TRIAL_PASS_THRESHOLD,
  TRIALS,
  type DefectKey,
  type TrialGrade,
} from "../evals/lib/recall.ts";
import { reviewerPrompt } from "../lib/stage-prompts.ts";

const REVIEWER_DIR = join(import.meta.dir, "..", "evals", "reviewer");

const DEFECTS: DefectKey[] = [
  { id: "D1", site: "src/limiter.ts:allow", summary: "ceiling charged before the per-key check" },
  { id: "D2", site: "src/limiter.ts:sweep", summary: "reports keys examined, not dropped" },
  { id: "D3", site: "src/middleware.ts:handle", summary: "fails open when the limiter throws" },
];

const grade = (single: boolean[], adversarial: boolean[], extra: Partial<TrialGrade> = {}): TrialGrade => ({
  single: Object.fromEntries(DEFECTS.map((d, i) => [d.id, single[i]!])),
  adversarial: Object.fromEntries(DEFECTS.map((d, i) => [d.id, adversarial[i]!])),
  singleUnmatched: 0,
  adversarialUnmatched: 0,
  singleMarker: "REVIEW-FINDINGS",
  adversarialMarker: "REVIEW-FINDINGS",
  ...extra,
});

const json = (single: Record<string, unknown>, adversarial: Record<string, unknown>, extra = ""): string =>
  `{"single":${JSON.stringify(single)},"adversarial":${JSON.stringify(adversarial)}${extra}}`;

const ALL = { D1: true, D2: true, D3: true };
const NONE = { D1: false, D2: false, D3: false };

// ============================================================================
// 1. readTrialGrade -- the shapes a live grader actually emits
// ============================================================================

describe("readTrialGrade", () => {
  test("reads a bare JSON object", () => {
    const read = readTrialGrade(json(NONE, ALL), DEFECTS);
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    expect(read.grade.single.D1).toBe(false);
    expect(read.grade.adversarial.D3).toBe(true);
  });

  test("reads a ```json fenced object -- the shape the real grader emits most", () => {
    const read = readTrialGrade("```json\n" + json(ALL, ALL) + "\n```\n", DEFECTS);
    expect(read.status).toBe("ok");
  });

  test("reads an object wrapped in explanatory prose", () => {
    const raw = `Here is the mapping for this trial:\n\n${json(NONE, ALL)}\n\nSingle-pass missed all three.`;
    expect(readTrialGrade(raw, DEFECTS).status).toBe("ok");
  });

  test("a missing defect id is unreadable, NOT a graded miss", () => {
    const read = readTrialGrade(json({ D1: true, D2: true }, ALL), DEFECTS);
    expect(read.status).toBe("unreadable");
    if (read.status !== "unreadable") return;
    expect(read.reason).toContain("D3");
  });

  test("a non-boolean verdict is unreadable, NOT coerced", () => {
    const read = readTrialGrade(json({ D1: true, D2: "yes", D3: false }, ALL), DEFECTS);
    expect(read.status).toBe("unreadable");
    if (read.status !== "unreadable") return;
    expect(read.reason).toContain("D2");
  });

  test("a missing mode object is unreadable", () => {
    const read = readTrialGrade(`{"adversarial":${JSON.stringify(ALL)}}`, DEFECTS);
    expect(read.status).toBe("unreadable");
    if (read.status !== "unreadable") return;
    expect(read.reason).toContain("single");
  });

  test("output with no JSON at all is unreadable, with a preview of what arrived", () => {
    const read = readTrialGrade("I could not grade this trial.", DEFECTS);
    expect(read.status).toBe("unreadable");
    if (read.status !== "unreadable") return;
    expect(read.reason).toContain("could not grade");
  });

  test("unmatched counts default to 0 and never make a grade unreadable", () => {
    const read = readTrialGrade(json(NONE, ALL), DEFECTS);
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    expect(read.grade.singleUnmatched).toBe(0);
    expect(read.grade.adversarialUnmatched).toBe(0);
  });

  test("unmatched counts are read when present, and junk values fall back to 0", () => {
    const ok = readTrialGrade(json(NONE, ALL, `,"singleUnmatched":2,"adversarialUnmatched":"three"`), DEFECTS);
    expect(ok.status).toBe("ok");
    if (ok.status !== "ok") return;
    expect(ok.grade.singleUnmatched).toBe(2);
    expect(ok.grade.adversarialUnmatched).toBe(0);
  });
});

// ============================================================================
// 2. scoreTrial -- a trial passes only on a strictly larger defect set
// ============================================================================

describe("scoreTrial", () => {
  test("adversarial finding strictly more passes the trial", () => {
    const s = scoreTrial(grade([true, false, false], [true, true, false]));
    expect(s.singleFound).toBe(1);
    expect(s.adversarialFound).toBe(2);
    expect(s.delta).toBe(1);
    expect(s.pass).toBe(true);
  });

  test("a tie is not a pass -- equal recall is no evidence for a 4x-cost mode", () => {
    expect(scoreTrial(grade([true, true, false], [true, true, false])).pass).toBe(false);
    expect(scoreTrial(grade([false, false, false], [false, false, false])).pass).toBe(false);
    expect(scoreTrial(grade([true, true, true], [true, true, true])).pass).toBe(false);
  });

  test("adversarial finding fewer is a negative delta and a fail", () => {
    const s = scoreTrial(grade([true, true, true], [true, false, false]));
    expect(s.delta).toBe(-2);
    expect(s.pass).toBe(false);
  });

  test("different defects, same count, is still a tie", () => {
    expect(scoreTrial(grade([true, false, false], [false, true, false])).pass).toBe(false);
  });
});

// ============================================================================
// 3. scoreRun -- the threshold is a trial count, not an average
// ============================================================================

describe("scoreRun", () => {
  const win = grade([false, false, false], [true, true, true]);
  const tie = grade([true, true, true], [true, true, true]);

  test("passes at exactly the threshold", () => {
    const run = scoreRun([win, win, win, win, tie], DEFECTS);
    expect(run.passes).toBe(TRIAL_PASS_THRESHOLD);
    expect(run.pass).toBe(true);
  });

  test("fails one trial below the threshold", () => {
    const run = scoreRun([win, win, win, tie, tie], DEFECTS);
    expect(run.passes).toBe(3);
    expect(run.pass).toBe(false);
  });

  test("one lopsided win cannot carry a run that lost the rest", () => {
    const run = scoreRun([win, tie, tie, tie, tie], DEFECTS);
    expect(run.meanAdversarial).toBeGreaterThan(run.meanSingle - 0.001);
    expect(run.pass).toBe(false);
  });

  test("means and per-defect catch rates aggregate across trials", () => {
    const run = scoreRun(
      [grade([true, false, false], [true, true, false]), grade([true, false, false], [true, false, true])],
      DEFECTS
    );
    expect(run.meanSingle).toBeCloseTo(1);
    expect(run.meanAdversarial).toBeCloseTo(2);
    expect(run.perDefect.D1).toEqual({ single: 2, adversarial: 2 });
    expect(run.perDefect.D2).toEqual({ single: 0, adversarial: 1 });
    expect(run.perDefect.D3).toEqual({ single: 0, adversarial: 1 });
  });

  test("unmatched findings are reported but never gate the run", () => {
    const noisy = grade([false, false, false], [true, true, true], { adversarialUnmatched: 9 });
    const run = scoreRun([noisy, noisy, noisy, noisy, noisy], DEFECTS);
    expect(run.meanAdversarialUnmatched).toBe(9);
    expect(run.pass).toBe(true);
  });

  test("an explicit threshold overrides the default", () => {
    expect(scoreRun([win, tie, tie, tie, tie], DEFECTS, 1).pass).toBe(true);
  });

  test("the shipped threshold is 4 of 5, matching rubric.md", () => {
    expect(TRIAL_PASS_THRESHOLD).toBe(4);
    expect(TRIALS).toBe(5);
  });

  // The bar is the RATIO, not the bare count. A hard-coded 4 would make
  // `run.sh 1` -- the free smoke command in run.sh's own header -- structurally
  // unpassable, so it would report FAIL for a reason that has nothing to do
  // with what the reviewers did.
  test("the required win count scales with the trial count and never drops below 80%", () => {
    expect(requiredPasses(5)).toBe(4);
    expect(requiredPasses(1)).toBe(1);
    expect(requiredPasses(2)).toBe(2);
    expect(requiredPasses(3)).toBe(3);
    expect(requiredPasses(10)).toBe(8);
    for (const n of [1, 2, 3, 5, 7, 10, 25]) {
      expect(requiredPasses(n) / n).toBeGreaterThanOrEqual(TRIAL_PASS_THRESHOLD / TRIALS);
    }
  });

  test("a short run can still pass on its own terms", () => {
    expect(scoreRun([win], DEFECTS).pass).toBe(true);
    expect(scoreRun([tie], DEFECTS).pass).toBe(false);
    expect(scoreRun([win, win, win], DEFECTS).pass).toBe(true);
    expect(scoreRun([win, win, tie], DEFECTS).pass).toBe(false);
  });
});

// ============================================================================
// 3b. The #318 marker gate -- did the reviewer stage report at all?
// ============================================================================
//
// The grader has always been asked which exit marker the loop would read from
// each trial's final message, and until #318 nothing scored the answer. That is
// precisely the defect loop 17 hit: an adversarial reviewer ends its turn waiting
// for skeptic verdicts that can never reach it, emits no marker, is parsed as
// CONFUSED, and its ticket is Skipped with green committed work on the branch.
// This harness is the only lane that drives the real prompt through a real
// fan-out, so it is the only lane where that is observable at all.
//
// The threshold is 100%, unlike the recall gate's 4/5, and the asymmetry is the
// point: a missing marker is not a quality reading to average, it is a finished
// ticket thrown away plus a full reviewer stage paid for nothing.

describe("exit-marker gate (#318)", () => {
  const win = grade([false, false, false], [true, true, true]);
  const silent = (mode: "single" | "adversarial", reported = "NONE") =>
    grade([false, false, false], [true, true, true], mode === "single" ? { singleMarker: reported } : { adversarialMarker: reported });

  test("every reviewer marker counts as reported, CONFUSED included", () => {
    // CONFUSED is a verdict a human can act on. The graded property is that the
    // stage REPORTED, not that it approved -- the prompt names CONFUSED as the
    // sanctioned exit when skeptic collection fails, so scoring it as a miss would
    // punish the exact behavior the fix asks for.
    for (const m of REVIEWER_MARKERS) expect(hasExitMarker(m)).toBe(true);
    expect(REVIEWER_MARKERS).toContain("CONFUSED");
  });

  test("the decorations a live grader adds do not change the reading", () => {
    expect(hasExitMarker("REVIEW-APPROVE: confidence=88 skeptics=0/3 all criteria hold")).toBe(true);
    expect(hasExitMarker("  `REVIEW-FINDINGS`  ")).toBe(true);
    expect(hasExitMarker("review-approve")).toBe(true);
  });

  test("absence in every shape a grader reports it is a miss", () => {
    for (const absent of ["NONE", "none", "", "   ", "no marker was emitted", "(the message ends mid-collection)"]) {
      expect(hasExitMarker(absent)).toBe(false);
    }
  });

  test("one silent stage in one trial fails the whole run, on either mode", () => {
    for (const mode of ["single", "adversarial"] as const) {
      const run = scoreRun([win, win, win, win, silent(mode)], DEFECTS);
      // Recall passed outright -- this is not a recall failure riding along.
      expect(run.passes).toBe(5);
      expect(run.markersPass).toBe(false);
      expect(run.pass).toBe(false);
      // Named, so the artifacts do not have to be re-read to find it.
      expect(run.markerMisses).toEqual([{ trial: 5, mode, reported: "NONE" }]);
    }
  });

  test("the two gates are independent and ANDed", () => {
    const tie = grade([true, true, true], [true, true, true]);
    // Markers fine, recall short.
    const recallOnly = scoreRun([win, win, win, tie, tie], DEFECTS);
    expect(recallOnly.markersPass).toBe(true);
    expect(recallOnly.pass).toBe(false);
    // Recall fine, one marker missing.
    const markerOnly = scoreRun([win, win, win, win, silent("adversarial")], DEFECTS);
    expect(markerOnly.passes).toBeGreaterThanOrEqual(requiredPasses(5));
    expect(markerOnly.pass).toBe(false);
    // Both fine.
    const clean = scoreRun([win, win, win, win, win], DEFECTS);
    expect(clean.markersPass).toBe(true);
    expect(clean.pass).toBe(true);
  });

  test("the report names the missing marker's trial and mode", () => {
    const run = scoreRun([win, silent("adversarial", "")], DEFECTS);
    const report = formatReport(run, DEFECTS, 2);
    // 2 trials x 2 modes = 4 reviewer stages, one of them silent.
    expect(report).toContain("exit marker reported: 3/4 reviewer stages");
    expect(report).toContain("pass threshold: 4/4");
    expect(report).toContain('MISSING MARKER: trial 2, adversarial pass reported "(empty)"');
  });

  test("a clean run says so without emitting a MISSING MARKER line", () => {
    const report = formatReport(scoreRun([win, win], DEFECTS), DEFECTS, 2);
    expect(report).toContain("exit marker reported: 4/4 reviewer stages");
    expect(report).not.toContain("MISSING MARKER");
  });

  // The marker names are a contract with lib/stage-prompts.ts, not a local list:
  // a stage whose marker is renamed there and not here would score every trial as
  // silent and fail the eval for a reason that has nothing to do with the review.
  test("every scored marker is one the reviewer prompt actually prints", () => {
    const prompt = reviewerPrompt(
      { ticketBody: "b", acceptanceCriteria: "a", diff: "d", worktreePath: "/tmp/wt" },
      "/loop/tmp/input-42.json",
      true
    );
    for (const m of REVIEWER_MARKERS) expect(prompt).toContain(`${m}:`);
  });
});

// ============================================================================
// 4. Blindness -- the reviewer must never be able to reach the answer key
// ============================================================================
//
// This fixture is the first to ship an answer key (defects.json), which creates
// a hole the old single-needle fixture could not have: the key sits in the repo
// tree, so a reviewer whose working directory is the repo can read the very
// list it is being scored against. The prompt tells it not to look anywhere but
// its input file, but an eval's integrity cannot rest on the subject's
// compliance. run.sh therefore runs both reviewer passes from INSIDE the
// throwaway worktree (which is also what production does) and grants them only
// $OUT, while the grader -- which is not blinded -- keeps repo access.

describe("run.sh keeps the reviewer blinded to the answer key", () => {
  const runSh = readFileSync(join(REVIEWER_DIR, "run.sh"), "utf8");
  const reviewerCalls = runSh
    .split("\n")
    .filter((l) => l.includes("$CLAUDE_CMD") && (l.includes("single.txt") || l.includes("adversarial.txt")));

  test("both reviewer passes are invoked, and from the worktree", () => {
    expect(reviewerCalls).toHaveLength(2);
    for (const call of reviewerCalls) expect(call).toContain('cd "$WORKTREE"');
  });

  test("neither reviewer pass is granted the fixture directory or the repo", () => {
    for (const call of reviewerCalls) {
      expect(call).not.toContain('--add-dir "$FIX"');
      expect(call).not.toContain('--add-dir "$HERE"');
      expect(call).not.toContain('--add-dir "$REPO"');
    }
  });

  test("the grader still reaches the answer key -- it is not blinded", () => {
    expect(runSh).toContain('--add-dir "$HERE"');
    expect(runSh).toContain("defects.json");
  });

  test("the blinded input file carries exactly the four keys, never the answer key", () => {
    const open = runSh.indexOf("JSON.stringify({");
    const inputBuild = runSh.slice(open, runSh.indexOf("}));", open));
    for (const key of ["ticketBody", "acceptanceCriteria", "diff", "worktreePath"]) {
      expect(inputBuild).toContain(key);
    }
    expect(inputBuild).not.toContain("defects");
  });
});

// ============================================================================
// 5. formatReport -- the report run.sh prints is deterministic
// ============================================================================

describe("formatReport", () => {
  test("names every defect, both means, and the trial count against the threshold", () => {
    const run = scoreRun([grade([true, false, false], [true, true, false])], DEFECTS);
    const report = formatReport(run, DEFECTS, 1);
    for (const d of DEFECTS) expect(report).toContain(d.id);
    expect(report).toContain("mean recall");
    expect(report).toContain(`${TRIAL_PASS_THRESHOLD}/${TRIALS}`);
    expect(report).toContain("1/1 -> 1/1");
  });

  test("same input, same bytes", () => {
    const run = scoreRun([grade([true, true, false], [true, true, true])], DEFECTS);
    expect(formatReport(run, DEFECTS, 1)).toBe(formatReport(run, DEFECTS, 1));
  });
});
