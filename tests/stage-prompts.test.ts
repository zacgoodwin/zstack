// Gate tests for C6's pure prompt constructors: reviewer blindness (issue #8
// AC3 -- the input type has exactly four keys, enforced at compile time and at
// runtime), the fresh-context purity guarantee (AC4 -- constructors are pure
// functions of their typed input, so every spawn's context is rebuilt from
// data), and the completion-note builder (AC7 -- edges + Actual present).
import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  builderPrompt,
  completionNote,
  mergePrompt,
  qaPrompt,
  reviewerPrompt,
  shSingleQuote,
  REVIEWER_INPUT_KEYS,
  ZError,
  type BuilderPromptInput,
  type CompletionNoteInput,
  type MergePromptInput,
  type QaPromptInput,
  type ReviewerPromptInput,
} from "../lib/stage-prompts.ts";

const REPO_ROOT = join(import.meta.dir, "..");

const BUILDER_INPUT: BuilderPromptInput = {
  ticketNumber: 42,
  ticketTitle: "Add CSV export",
  ticketBody: "## Context\n\nUsers need CSV.\n\n### Acceptance Criteria\n\n- exporting an empty list yields a header-only file",
  worktreePath: ".worktrees/ticket-42",
  branch: "z/ticket-42-add-csv-export",
  baseBranch: "main",
};

const QA_INPUT: QaPromptInput = {
  ticketNumber: 42,
  ticketBody: BUILDER_INPUT.ticketBody,
  worktreePath: ".worktrees/ticket-42",
  branch: "z/ticket-42-add-csv-export",
  qaPass: 1,
  webTarget: false,
};

const REVIEWER_INPUT: ReviewerPromptInput = {
  ticketBody: BUILDER_INPUT.ticketBody,
  acceptanceCriteria: "- exporting an empty list yields a header-only file",
  diff: "diff --git a/export.ts b/export.ts\n+export function toCsv() {}",
  worktreePath: "/tmp/review-throwaway-42",
};

const MERGE_INPUT: MergePromptInput = {
  ticketNumber: 42,
  prTitle: "Add CSV export",
  branch: "z/ticket-42-add-csv-export",
  baseBranch: "main",
  worktreePath: ".worktrees/ticket-42",
  stackedOn: [],
};

// Pointer prompts (ticket #57) reference the stage's input-<N>.json by ABSOLUTE
// path; the worker reads ticketBody/diff/acceptanceCriteria from there instead
// of the orchestrator inlining them. Tests pass a representative absolute path.
const INPUT_PATH = join(REPO_ROOT, "loop", "tmp", "input-42.json");

// -- reviewer blindness (AC3) -------------------------------------------------

describe("reviewer blindness", () => {
  test("the input type has exactly {ticketBody, acceptanceCriteria, diff, worktreePath}", () => {
    // Compile-time half: Exact<> collapses to never if ReviewerPromptInput ever
    // gains or loses a key, so this assignment stops typechecking.
    type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
    const _exact: Exact<keyof ReviewerPromptInput, (typeof REVIEWER_INPUT_KEYS)[number]> = true;
    void _exact;
    // Runtime half: a constructed input exposes exactly the four keys.
    expect(Object.keys(REVIEWER_INPUT).sort()).toEqual(["acceptanceCriteria", "diff", "ticketBody", "worktreePath"]);
    expect([...REVIEWER_INPUT_KEYS].sort()).toEqual(["acceptanceCriteria", "diff", "ticketBody", "worktreePath"]);
  });

  test("a smuggled extra field is rejected at runtime", () => {
    const leaky = { ...REVIEWER_INPUT, prDescription: "trust me, it works" };
    expect(() => reviewerPrompt(leaky as ReviewerPromptInput, INPUT_PATH)).toThrow(ZError);
    const rationale = { ...REVIEWER_INPUT, planRationale: "we chose X because..." };
    expect(() => reviewerPrompt(rationale as ReviewerPromptInput, INPUT_PATH)).toThrow(ZError);
  });

  test("a missing or empty input is rejected -- a blinded reviewer with no diff is no reviewer", () => {
    const { diff: _dropped, ...missing } = REVIEWER_INPUT;
    expect(() => reviewerPrompt(missing as ReviewerPromptInput, INPUT_PATH)).toThrow(ZError);
    expect(() => reviewerPrompt({ ...REVIEWER_INPUT, diff: "" }, INPUT_PATH)).toThrow(ZError);
  });

  // AC2: the new `inputPath` param is a plain second argument, NOT a key of the
  // input object, so the exact-four-key gate is untouched -- the input still
  // carries exactly {ticketBody, acceptanceCriteria, diff, worktreePath} and
  // reviewerPrompt still rejects a fifth key even with inputPath supplied.
  test("adding inputPath does not add a fifth key: the input stays exactly the four blinded keys", () => {
    expect(Object.keys(REVIEWER_INPUT).sort()).toEqual(["acceptanceCriteria", "diff", "ticketBody", "worktreePath"]);
    // A valid input + inputPath builds fine...
    expect(() => reviewerPrompt(REVIEWER_INPUT, INPUT_PATH)).not.toThrow();
    // ...but a fifth key is still rejected regardless of inputPath.
    const leaky = { ...REVIEWER_INPUT, builderTranscript: "..." };
    expect(() => reviewerPrompt(leaky as ReviewerPromptInput, INPUT_PATH)).toThrow(/blinded by design/);
  });

  test("the prompt is a POINTER: it references the input file, omits body/AC/diff, keeps the blindness contract", () => {
    const p = reviewerPrompt(REVIEWER_INPUT, INPUT_PATH);
    // The large payload is read from the file, NOT inlined into the prompt.
    expect(p).toContain(INPUT_PATH);
    expect(p).not.toContain(REVIEWER_INPUT.ticketBody);
    expect(p).not.toContain(REVIEWER_INPUT.acceptanceCriteria);
    expect(p).not.toContain(REVIEWER_INPUT.diff);
    // The throwaway worktree path is small/fixed and stays inline.
    expect(p).toContain(REVIEWER_INPUT.worktreePath);
    expect(p).toContain("no PR description, no plan rationale, no builder or QA transcript");
    expect(p).toContain("REVIEW-APPROVE:");
    expect(p).toContain("REVIEW-FINDINGS:");
    // Fix 8a: the reviewer must be able to park Blocked (loop.ts MARKERS.reviewer
    // parses BLOCKED:), so an unusable worktree parks instead of being Skipped.
    expect(p).toContain("BLOCKED:");
  });
});

// -- fresh-context purity (AC4) -----------------------------------------------

describe("prompt constructor purity", () => {
  test("every constructor is a pure function of its input: identical input, identical prompt, no carried state", () => {
    // Interleave calls with different inputs; the repeats must be byte-identical,
    // proving no hidden state leaks between spawns.
    const b1 = builderPrompt(BUILDER_INPUT, INPUT_PATH);
    const q1 = qaPrompt(QA_INPUT, INPUT_PATH);
    const r1 = reviewerPrompt(REVIEWER_INPUT, INPUT_PATH);
    const m1 = mergePrompt(MERGE_INPUT, INPUT_PATH);
    builderPrompt({ ...BUILDER_INPUT, ticketNumber: 99, qaNotes: "1) broken" }, INPUT_PATH);
    reviewerPrompt({ ...REVIEWER_INPUT, diff: "other diff" }, INPUT_PATH);
    expect(builderPrompt(BUILDER_INPUT, INPUT_PATH)).toBe(b1);
    expect(qaPrompt(QA_INPUT, INPUT_PATH)).toBe(q1);
    expect(reviewerPrompt(REVIEWER_INPUT, INPUT_PATH)).toBe(r1);
    expect(mergePrompt(MERGE_INPUT, INPUT_PATH)).toBe(m1);
  });
});

// -- pointer-prompt size-invariance (AC1) -------------------------------------

describe("pointer prompts are size-invariant to the payload (AC1)", () => {
  const HUGE = "X".repeat(100_000); // 100 KB ticketBody / diff
  const AC = "Y".repeat(100_000);

  // The builder/qa injection carries the huge body; the reviewer additionally
  // carries a huge diff + acceptance criteria. Every stage's input-<N>.json is
  // referenced by absolute path; the built prompt must not embed the payload.
  const CASES: { stage: string; build: () => string; payloads: string[] }[] = [
    { stage: "builder", build: () => builderPrompt({ ...BUILDER_INPUT, ticketBody: HUGE }, INPUT_PATH), payloads: [HUGE] },
    { stage: "qa", build: () => qaPrompt({ ...QA_INPUT, ticketBody: HUGE }, INPUT_PATH), payloads: [HUGE] },
    { stage: "reviewer", build: () => reviewerPrompt({ ...REVIEWER_INPUT, ticketBody: HUGE, diff: HUGE, acceptanceCriteria: AC }, INPUT_PATH), payloads: [HUGE, AC] },
    { stage: "merge", build: () => mergePrompt(MERGE_INPUT, INPUT_PATH), payloads: [] },
  ];

  for (const c of CASES) {
    test(`${c.stage}: 100 KB payload -> < 4 KB prompt, omits the payload, contains the absolute input path`, () => {
      const p = c.build();
      expect(p.length).toBeLessThan(4096);
      for (const payload of c.payloads) expect(p).not.toContain(payload);
      expect(isAbsolute(INPUT_PATH)).toBe(true);
      expect(p).toContain(INPUT_PATH);
    });
  }
});

// -- builder prompt -----------------------------------------------------------

describe("builder prompt", () => {
  test("points at the ticket file, carries worktree discipline, ponytail, and the exit contract", () => {
    const p = builderPrompt(BUILDER_INPUT, INPUT_PATH);
    expect(p).toContain('#42: "Add CSV export"');
    // Pointer prompt: the body is read from the input file, not inlined.
    expect(p).not.toContain(BUILDER_INPUT.ticketBody);
    expect(p).toContain(INPUT_PATH);
    expect(p).toContain("field `ticketBody`");
    expect(p).toContain(".worktrees/ticket-42");
    expect(p).toContain("z/ticket-42-add-csv-export");
    expect(p).toContain("Ponytail ladder");
    expect(p).toContain("implementation + gate tests + evals");
    expect(p).toContain("BUILT:");
    expect(p).toContain("NEEDS-INPUT:");
    expect(p).toContain("never ask a question");
  });

  test("QA bounce points at qaNotes and (from the 2nd bounce) demands /investigate; review bounce points at reviewNotes", () => {
    const p1 = builderPrompt({ ...BUILDER_INPUT, qaNotes: "1) header row missing" }, INPUT_PATH);
    // The findings themselves live in the input file (payload-independent), so
    // the section names the field + path rather than inlining the note text.
    expect(p1).toContain("QA findings from the previous pass");
    expect(p1).toContain("`qaNotes`");
    expect(p1).toContain(INPUT_PATH);
    expect(p1).not.toContain("1) header row missing");
    expect(p1).not.toContain("/investigate");
    const p2 = builderPrompt({ ...BUILDER_INPUT, qaNotes: "1) header row missing", investigateFirst: true }, INPUT_PATH);
    expect(p2).toContain("/investigate");
    const pr = builderPrompt({ ...BUILDER_INPUT, reviewNotes: "1) AC weakened" }, INPUT_PATH);
    expect(pr).toContain("Reviewer findings");
    expect(pr).toContain("`reviewNotes`");
    expect(pr).not.toContain("1) AC weakened");
  });
});

// -- QA prompt ----------------------------------------------------------------

describe("qa prompt", () => {
  test("functional + technical checks, pass number, ticket-file pointer, exit contract", () => {
    const p = qaPrompt(QA_INPUT, INPUT_PATH);
    expect(p).toContain("QA pass 1");
    expect(p).toContain("Functional");
    expect(p).toContain("Technical");
    expect(p).toContain("QA-PASS:");
    expect(p).toContain("QA-BUGS:");
    // Pointer prompt: the body is read from the input file, not inlined.
    expect(p).not.toContain(QA_INPUT.ticketBody);
    expect(p).toContain(INPUT_PATH);
    expect(p).toContain("field `ticketBody`");
    expect(p).not.toContain("/qa");
  });

  test("web targets are told to drive gstack /qa", () => {
    expect(qaPrompt({ ...QA_INPUT, webTarget: true }, INPUT_PATH)).toContain("gstack /qa");
  });
});

// -- merge prompt -------------------------------------------------------------

describe("merge prompt", () => {
  test("plain merge: PR steps, conflict gauntlet, no branch deletion mid-batch, input pointer", () => {
    const p = mergePrompt(MERGE_INPUT, INPUT_PATH);
    expect(p).toContain("gh pr create --base main");
    expect(p).toContain("full gauntlet");
    expect(p).toContain("Never pass --delete-branch");
    expect(p).toContain("MERGED:");
    expect(p).toContain(INPUT_PATH); // AC1: every stage references its input file
    expect(p).not.toContain("Stacked chain");
  });

  test("stacked chain: parent first, no deletion, retarget, delete last", () => {
    const p = mergePrompt({ ...MERGE_INPUT, stackedOn: [40, 41] }, INPUT_PATH);
    expect(p).toContain("Stacked chain");
    expect(p).toContain("#40, #41");
    expect(p).toContain("WITHOUT deleting its branch");
    expect(p).toContain("retarget this PR");
    expect(p).toContain("gh pr edit --base main");
    expect(p).toContain("Delete branches only after the whole batch");
  });

  // -- fix 1: PR-title shell injection ---------------------------------------
  test("shSingleQuote renders shell metacharacters inert (POSIX single-quote escaping)", () => {
    // $() and backticks stay literal; each embedded single quote becomes '\''.
    expect(shSingleQuote("a'b$(c)")).toBe("'a'\\''b$(c)'");
    expect(shSingleQuote("Fix $(cmd) `bt` and O'Brien")).toBe("'Fix $(cmd) `bt` and O'\\''Brien'");
    // Round-trips through bash to the exact original (no expansion, no splitting).
    const evil = "Fix $(rm -rf ~) and `whoami` in O'Brien's parser";
    const echoed = Bun.spawnSync(["bash", "-c", `printf %s ${shSingleQuote(evil)}`], { stdout: "pipe" });
    expect(echoed.stdout.toString()).toBe(evil);
  });

  test("a shell-metachar PR title is quoted inertly, never as an injectable double-quoted string", () => {
    const evil = "Fix $(rm -rf ~) and `whoami` in O'Brien's parser";
    const p = mergePrompt({ ...MERGE_INPUT, prTitle: evil }, INPUT_PATH);
    // The title appears only inside the single-quoted literal shSingleQuote built.
    expect(p).toContain(`--title ${shSingleQuote(evil)}`);
    // ...and NOT via JSON.stringify, whose double quotes let bash expand $()/backticks.
    expect(p).not.toContain(`--title ${JSON.stringify(evil)}`);
  });
});

// -- completion note (AC7) ----------------------------------------------------

describe("completion note", () => {
  const NOTE_INPUT: CompletionNoteInput = {
    shipped: "CSV export behind the reports menu (lib/export.ts, tests/export.test.ts)",
    prUrl: "https://github.com/x/y/pull/12",
    acceptancePassed: ["exporting an empty list yields a header-only file"],
    edges: [{ check: "the empty-list default", doStep: "export with zero rows", expect: "a file with only the header row" }],
    filedTickets: [{ number: 77, title: "Excel export variant surfaced during QA" }],
    actualDollars: 6.5,
  };

  test("includes shipped, criteria, to-check-do-expect edges, filed tickets, and Actual", () => {
    const n = completionNote(NOTE_INPUT);
    expect(n).toContain("CSV export behind the reports menu");
    expect(n).toContain("https://github.com/x/y/pull/12");
    expect(n).toContain("- exporting an empty list yields a header-only file");
    expect(n).toContain("To check the empty-list default, do export with zero rows, expect a file with only the header row.");
    expect(n).toContain("#77 Excel export variant surfaced during QA");
    expect(n).toContain("**Actual:** $6.50");
    expect(n).toContain("stays OPEN");
  });

  test("empty edges and filings say so explicitly instead of vanishing", () => {
    const n = completionNote({ ...NOTE_INPUT, edges: [], filedTickets: [] });
    expect(n).toContain("**Edges a human must validate:**\n- None surfaced.");
    expect(n).toContain("**Use cases filed to Backlog:**\n- None surfaced.");
  });
});

// -- CLI smoke ----------------------------------------------------------------

describe("stage-prompts CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "zstack-prompts-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("prompt reviewer builds from an input file; a leaky input file fails loudly", () => {
    const ok = join(dir, "reviewer.json");
    writeFileSync(ok, JSON.stringify(REVIEWER_INPUT));
    const proc = Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "stage-prompts.ts"), "prompt", "reviewer", ok], { stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("ADVERSARIAL REVIEWER");

    const leaky = join(dir, "leaky.json");
    writeFileSync(leaky, JSON.stringify({ ...REVIEWER_INPUT, builderTranscript: "..." }));
    const bad = Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "stage-prompts.ts"), "prompt", "reviewer", leaky], { stdout: "pipe", stderr: "pipe" });
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr.toString()).toContain("blinded by design");
  });
});
