// Shared grade-file reader for the reviewer eval harnesses
// (evals/reviewer/run.sh and evals/reviewer-severity/run.sh).
//
// Why this exists (issue #108): both harnesses used to parse the grader's
// output inline with `bun -e "JSON.parse(readFileSync(...)).pass === true"`.
// The grader is a live `claude -p` writing free-form text, and it routinely
// wraps its JSON in a ```json fence. JSON.parse throws on the fence, bun
// writes nothing, and the shell compare against "PASS" fails -- so the trial
// scored FAIL no matter what the grader actually decided. In the 5-trial paid
// run recorded on #108, 4 of 5 grade files were fenced, capping the achievable
// score at 1/5 before a single reviewer output was even considered.
//
// The mock (mock-claude.sh) always emitted bare JSON, so the structural smoke
// test never reproduced it. That gap is closed by MOCK_CLAUDE_GRADE_WRAP.
//
// Two invariants this file exists to hold:
//   1. Fenced, prose-wrapped, BOM-prefixed and CRLF grade output all parse.
//   2. An UNREADABLE grade is never silently counted as a graded FAIL. A paid
//      run that could not be measured must say so instead of reporting a score.

export type GradeVerdict =
  | { status: "pass" }
  | { status: "fail" }
  | { status: "unreadable"; reason: string };

/**
 * Pull the JSON object out of a model's free-form reply.
 *
 * Handles the shapes the graders actually emit: a bare object, a ```json (or
 * bare ```) fenced block, and an object surrounded by explanatory prose. The
 * first fenced block wins when one is present; otherwise the span from the
 * first `{` to the last `}` is taken. Returns null when there is no brace pair
 * at all, which the caller must treat as unreadable rather than as a failure.
 */
export function extractJsonObject(raw: string): string | null {
  const cleaned = raw.replace(/^\uFEFF/, "");
  const fenced = cleaned.match(/```[^\n]*\r?\n([\s\S]*?)```/);
  const body = fenced ? fenced[1] : cleaned;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return body.slice(start, end + 1);
}

/**
 * Read one grade file's contents into a verdict.
 *
 * `pass` must be a real boolean. A missing or non-boolean `pass` is a grader
 * schema drift (observed on #108: one trial returned `"adversarialMarker": true`
 * instead of the marker string), not a graded failure, so it reports unreadable.
 */
export function readGradeVerdict(raw: string): GradeVerdict {
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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "unreadable", reason: `grader output parsed to ${Array.isArray(parsed) ? "an array" : typeof parsed}, expected an object` };
  }
  const pass = (parsed as Record<string, unknown>).pass;
  if (typeof pass !== "boolean") {
    return { status: "unreadable", reason: `grader output has no boolean "pass" field (got ${JSON.stringify(pass)})` };
  }
  return { status: pass ? "pass" : "fail" };
}

/** The single-word token run.sh branches on. */
export function verdictToken(v: GradeVerdict): "PASS" | "FAIL" | "UNREADABLE" {
  return v.status === "pass" ? "PASS" : v.status === "fail" ? "FAIL" : "UNREADABLE";
}

// CLI: `bun evals/lib/grade.ts <grade-file>` writes one token on stdout and,
// when unreadable, the reason on stderr. Always exits 0 -- the token is the
// contract, and a nonzero exit here would trip the harnesses' `set -e` before
// they could count the trial. process.stdout.write, never console.log: bun
// colorizes a bare boolean even into a pipe, which is the sibling bug that
// broke this same compare before (#179).
if (import.meta.main) {
  const file = process.argv[2];
  if (!file) {
    process.stdout.write("UNREADABLE");
    process.stderr.write("usage: bun evals/lib/grade.ts <grade-file>\n");
  } else {
    let raw = "";
    try {
      raw = await Bun.file(file).text();
    } catch (err) {
      process.stdout.write("UNREADABLE");
      process.stderr.write(`cannot read ${file}: ${(err as Error).message}\n`);
      process.exit(0);
    }
    const verdict = readGradeVerdict(raw);
    process.stdout.write(verdictToken(verdict));
    if (verdict.status === "unreadable") process.stderr.write(`${file}: ${verdict.reason}\n`);
  }
}
