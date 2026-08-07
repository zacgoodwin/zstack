// Deterministic scorer for the re-targeted reviewer eval (evals/reviewer).
//
// Why this exists: the old contract asked whether adversarial mode surfaces ONE
// planted needle that single-pass approves. Four fixture redesigns and 16 real
// single-pass reads (evals/reviewer/run.md "## Results") showed that contract
// cannot be satisfied -- a planted defect must violate a stated criterion or the
// rubric cannot grade it, so the criteria list indexes the defect and a
// code-executing reviewer audits its way to it every time. The eval now measures
// what the fan-out plausibly does buy: RECALL across many independent defects in
// one diff, i.e. how much of what is wrong a single review cycle surfaces.
//
// The split this file enforces (PRINCIPLES.md, latent vs deterministic): the
// live grader only answers the latent question -- "for each planted defect, did
// this reviewer output name it?" -- and every count, mean, delta and threshold
// is computed HERE, in code, under gate tests. No score is ever read out of a
// model's prose.
import { extractJsonObject } from "./grade.ts";

/** Adversarial must name strictly more planted defects than single-pass in this many of N trials. */
export const TRIAL_PASS_THRESHOLD = 4;
/** ...out of this many trials. Both constants are the rubric's contract; rubric.md documents them. */
export const TRIALS = 5;

/**
 * The reviewer stage's exit markers, as lib/stage-prompts.ts prints them.
 *
 * #318's paid lane. run.sh's grader has always reported which marker the loop
 * would read from each trial's final message, and nothing scored it -- so loop
 * 17's actual failure (an adversarial reviewer that ends its turn awaiting
 * skeptic verdicts, emits NO marker, and gets its ticket Skipped with green
 * committed work) was invisible to the one eval that drives the real prompt
 * through a real fan-out. The measurement existed; the gate did not.
 *
 * CONFUSED is on this list deliberately. The graded property is that a verdict
 * was REPORTED, not that it was favorable: a reviewer that cannot judge the diff
 * and says so is behaving correctly, and the prompt now names that exit
 * explicitly for exactly this case. What fails is silence.
 */
export const REVIEWER_MARKERS = [
  "REVIEW-APPROVE",
  "REVIEW-FINDINGS",
  "NEEDS-HUMAN",
  "BLOCKED",
  "CONFUSED",
] as const;

/**
 * Did the grader report a real exit marker for this mode's final message?
 *
 * The grader is asked for the marker the LOOP would read, so its answer is
 * already the thing under test; this only classifies it. Tolerant of the
 * decorations a live grader adds (a trailing `: <summary>`, surrounding
 * backticks, whitespace) because none of those change which marker was reported,
 * and strict about everything else: "NONE", an empty string, and any prose the
 * grader wrote instead of a marker all count as ABSENT. Absent is the defect.
 */
export function hasExitMarker(reported: string): boolean {
  const head = reported.trim().replace(/^[`"']+/, "").split(/[\s:`"']/)[0]?.toUpperCase() ?? "";
  return (REVIEWER_MARKERS as readonly string[]).includes(head);
}

/**
 * The marker threshold is 100%, not a ratio like the recall gate's 4/5.
 *
 * A missing marker is not a quality signal that can be traded off against a good
 * run -- it is the loop losing a finished ticket, and it costs a full reviewer
 * stage (~$0.70 measured in loop 17) to produce nothing. One occurrence in N
 * trials is a reproduction of #318, so one occurrence fails the run.
 */
export function markerMisses(grades: TrialGrade[]): { trial: number; mode: "single" | "adversarial"; reported: string }[] {
  const misses: { trial: number; mode: "single" | "adversarial"; reported: string }[] = [];
  grades.forEach((g, i) => {
    for (const mode of ["single", "adversarial"] as const) {
      const reported = mode === "single" ? g.singleMarker : g.adversarialMarker;
      if (!hasExitMarker(reported)) misses.push({ trial: i + 1, mode, reported: reported.trim() || "(empty)" });
    }
  });
  return misses;
}

/**
 * How many winning trials a run of `total` trials needs.
 *
 * The contract is the RATIO 4/5, not the bare count 4: a hard-coded 4 makes
 * `run.sh 1` (the documented free smoke command) and `run.sh 3` unpassable no
 * matter how the modes perform, which is how a harness quietly reports FAIL for
 * a structural reason rather than a measured one. Rounding up keeps the bar at
 * or above 80% for every trial count.
 */
export function requiredPasses(total: number): number {
  return Math.ceil((TRIAL_PASS_THRESHOLD / TRIALS) * total);
}

export interface DefectKey {
  id: string;
  site: string;
  summary: string;
}

export interface TrialGrade {
  single: Record<string, boolean>;
  adversarial: Record<string, boolean>;
  singleUnmatched: number;
  adversarialUnmatched: number;
  singleMarker: string;
  adversarialMarker: string;
}

export type TrialRead =
  | { status: "ok"; grade: TrialGrade }
  | { status: "unreadable"; reason: string };

export interface TrialScore {
  singleFound: number;
  adversarialFound: number;
  delta: number;
  /** A trial passes when the fan-out names strictly more planted defects than the single pass. */
  pass: boolean;
}

export interface RunScore {
  trials: TrialScore[];
  passes: number;
  meanSingle: number;
  meanAdversarial: number;
  /** Per defect id: how many trials each mode named it in. */
  perDefect: Record<string, { single: number; adversarial: number }>;
  meanSingleUnmatched: number;
  meanAdversarialUnmatched: number;
  /** #318: every trial-mode whose final message carried no exit marker at all. */
  markerMisses: { trial: number; mode: "single" | "adversarial"; reported: string }[];
  /** #318: 100% of trial-modes reported a marker. Independent of the recall gate. */
  markersPass: boolean;
  pass: boolean;
}

function isBoolMap(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Read one grade file against the fixture's answer key.
 *
 * Every planted defect id must appear in BOTH mode maps as a real boolean. A
 * missing id or a non-boolean is grader schema drift, not a graded miss --
 * scoring it as `false` would silently understate recall and turn a harness
 * fault into a measurement. Unmatched-finding counts default to 0 when absent
 * (they are diagnostic, never part of the pass rule).
 */
export function readTrialGrade(raw: string, defects: DefectKey[]): TrialRead {
  const json = extractJsonObject(raw);
  if (json === null) {
    const preview = raw.trim().slice(0, 120) || "(empty file)";
    return { status: "unreadable", reason: `no JSON object found in grader output: ${preview}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return { status: "unreadable", reason: `grader output is not valid JSON: ${(err as Error).message}` };
  }
  if (!isBoolMap(parsed)) {
    return { status: "unreadable", reason: `grader output parsed to ${Array.isArray(parsed) ? "an array" : typeof parsed}, expected an object` };
  }
  const row = parsed as Record<string, unknown>;
  const modes: Record<string, Record<string, boolean>> = {};
  for (const mode of ["single", "adversarial"] as const) {
    const found = row[mode];
    if (!isBoolMap(found)) {
      return { status: "unreadable", reason: `grader output has no "${mode}" object (got ${JSON.stringify(found)})` };
    }
    const clean: Record<string, boolean> = {};
    for (const d of defects) {
      const hit = (found as Record<string, unknown>)[d.id];
      if (typeof hit !== "boolean") {
        return { status: "unreadable", reason: `grader output "${mode}" is missing a boolean for ${d.id} (got ${JSON.stringify(hit)})` };
      }
      clean[d.id] = hit;
    }
    modes[mode] = clean;
  }
  const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    status: "ok",
    grade: {
      single: modes.single!,
      adversarial: modes.adversarial!,
      singleUnmatched: count(row.singleUnmatched),
      adversarialUnmatched: count(row.adversarialUnmatched),
      singleMarker: typeof row.singleMarker === "string" ? row.singleMarker : "",
      adversarialMarker: typeof row.adversarialMarker === "string" ? row.adversarialMarker : "",
    },
  };
}

export function scoreTrial(grade: TrialGrade): TrialScore {
  const singleFound = Object.values(grade.single).filter(Boolean).length;
  const adversarialFound = Object.values(grade.adversarial).filter(Boolean).length;
  return {
    singleFound,
    adversarialFound,
    delta: adversarialFound - singleFound,
    pass: adversarialFound > singleFound,
  };
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * Aggregate every trial into the run's verdict. The threshold is a trial COUNT,
 * not a mean: a mode that wins big once and loses four times has not shown a
 * reliable improvement, and averaging would hide that.
 */
export function scoreRun(grades: TrialGrade[], defects: DefectKey[], threshold = requiredPasses(grades.length)): RunScore {
  const trials = grades.map(scoreTrial);
  const perDefect: Record<string, { single: number; adversarial: number }> = {};
  for (const d of defects) {
    perDefect[d.id] = {
      single: grades.filter((g) => g.single[d.id]).length,
      adversarial: grades.filter((g) => g.adversarial[d.id]).length,
    };
  }
  const passes = trials.filter((t) => t.pass).length;
  // #318: two independent gates, ANDed. Recall asks whether the fan-out is worth
  // its cost; the marker gate asks whether the stage reported at all. A run that
  // wins on recall while losing a ticket to silence has not passed -- the lost
  // ticket is strictly the more expensive failure, since it discards work that is
  // already finished, committed and green.
  const misses = markerMisses(grades);
  return {
    trials,
    passes,
    meanSingle: mean(trials.map((t) => t.singleFound)),
    meanAdversarial: mean(trials.map((t) => t.adversarialFound)),
    perDefect,
    meanSingleUnmatched: mean(grades.map((g) => g.singleUnmatched)),
    meanAdversarialUnmatched: mean(grades.map((g) => g.adversarialUnmatched)),
    markerMisses: misses,
    markersPass: misses.length === 0,
    pass: passes >= threshold && misses.length === 0,
  };
}

/** The human-readable report run.sh prints. Deterministic: same input, same bytes. */
export function formatReport(run: RunScore, defects: DefectKey[], total: number): string {
  const pct = (n: number): string => `${((n / defects.length) * 100).toFixed(0)}%`;
  const lines: string[] = [];
  lines.push(`per-defect catch rate over ${total} trials (single -> adversarial):`);
  for (const d of defects) {
    const p = run.perDefect[d.id]!;
    lines.push(`  ${d.id} ${d.site.padEnd(28)} ${p.single}/${total} -> ${p.adversarial}/${total}  ${d.summary}`);
  }
  lines.push(
    `mean recall: single ${run.meanSingle.toFixed(1)}/${defects.length} (${pct(run.meanSingle)}), ` +
      `adversarial ${run.meanAdversarial.toFixed(1)}/${defects.length} (${pct(run.meanAdversarial)})`
  );
  lines.push(
    `mean findings matching no planted defect: single ${run.meanSingleUnmatched.toFixed(1)}, ` +
      `adversarial ${run.meanAdversarialUnmatched.toFixed(1)} (diagnostic only, not part of the pass rule)`
  );
  lines.push(
    `adversarial named strictly more planted defects in ${run.passes}/${total} trials ` +
      `(pass threshold: ${requiredPasses(total)}/${total}, from the rubric's ${TRIAL_PASS_THRESHOLD}/${TRIALS})`
  );
  // #318. Reported as a fraction of trial-MODES (2 per trial) because both the
  // single pass and the fan-out are live reviewer stages here, and either can lose
  // a ticket to silence. Named individually on failure: which trial and which mode
  // is the whole diagnostic, and a bare count would send someone back to the raw
  // artifacts to find it.
  const modes = total * 2;
  lines.push(
    `exit marker reported: ${modes - run.markerMisses.length}/${modes} reviewer stages ` +
      `(pass threshold: ${modes}/${modes} -- a stage that reports no marker is parsed as CONFUSED and SKIPS its ticket, #318)`
  );
  for (const m of run.markerMisses) {
    lines.push(`  MISSING MARKER: trial ${m.trial}, ${m.mode} pass reported "${m.reported}"`);
  }
  return lines.join("\n");
}

// CLI: `bun evals/lib/recall.ts <defects.json> <grade-1.json> ...`
//
// Prints the report on stdout and exits 0 (PASS), 1 (below threshold) or 2
// (HARNESS ERROR: at least one grade unreadable, so no measurement was taken).
// The exit codes match evals/reviewer/run.sh's existing contract, and an
// unreadable grade is never folded into a score -- same invariant grade.ts holds.
if (import.meta.main) {
  const [keyPath, ...gradeFiles] = process.argv.slice(2);
  if (!keyPath || gradeFiles.length === 0) {
    process.stderr.write("usage: bun evals/lib/recall.ts <defects.json> <grade-file>...\n");
    process.exit(2);
  }
  const key = JSON.parse(await Bun.file(keyPath).text()) as { defects: DefectKey[] };
  const grades: TrialGrade[] = [];
  const problems: string[] = [];
  for (const file of gradeFiles) {
    let raw = "";
    try {
      raw = await Bun.file(file).text();
    } catch (err) {
      problems.push(`${file}: cannot read (${(err as Error).message})`);
      continue;
    }
    const read = readTrialGrade(raw, key.defects);
    if (read.status === "unreadable") problems.push(`${file}: ${read.reason}`);
    else grades.push(read.grade);
  }
  if (problems.length > 0) {
    process.stdout.write(
      `HARNESS ERROR: ${problems.length} of ${gradeFiles.length} grader outputs were unreadable; no score was taken.\n`
    );
    for (const p of problems) process.stdout.write(`  ${p}\n`);
    process.exit(2);
  }
  const run = scoreRun(grades, key.defects);
  process.stdout.write(`${formatReport(run, key.defects, gradeFiles.length)}\n`);
  process.exit(run.pass ? 0 : 1);
}
