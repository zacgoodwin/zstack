// Gate tests for C6's pure prompt constructors: reviewer blindness (issue #8
// AC3 -- the input type has exactly four keys, enforced at compile time and at
// runtime), the fresh-context purity guarantee (AC4 -- constructors are pure
// functions of their typed input, so every spawn's context is rebuilt from
// data), and the completion-note builder (AC7 -- edges + Actual present).
import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  adversarialActive,
  builderPrompt,
  completionNote,
  countDiffLines,
  mergePrompt,
  planEdgesComment,
  qaPrompt,
  reviewerPrompt,
  shSingleQuote,
  ADVERSARIAL_TRIGGER_LABELS,
  REVIEWER_INPUT_KEYS,
  SPAWN_TAG_MARKER,
  STAGES,
  spawnStub,
  type BuilderPromptInput,
  type CompletionEdge,
  type CompletionNoteInput,
  type MergePromptInput,
  type QaPromptInput,
  type ReviewerPromptInput,
} from "../lib/stage-prompts.ts";
import { ZError } from "../lib/config.ts";

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

  // AC11 (issue #62): the REVIEW-APPROVE contract carries the exact
  // confidence=<0-100> token the loop.ts parser reads, UNCONDITIONALLY -- the
  // plain default call (no adversarial flag), not just the super-truth branch.
  // The four-key blindness gate is untouched: confidence lives in the reviewer's
  // OUTPUT contract, never a fifth input key -- not even one literally named
  // "confidence".
  test("the REVIEW-APPROVE contract requires a confidence= token and the four-key blindness is unchanged", () => {
    const p = reviewerPrompt(REVIEWER_INPUT, INPUT_PATH);
    expect(p).toContain("REVIEW-APPROVE: confidence=<0-100>");
    expect([...REVIEWER_INPUT_KEYS].sort()).toEqual(["acceptanceCriteria", "diff", "ticketBody", "worktreePath"]);
    const leaky = { ...REVIEWER_INPUT, confidence: 90 };
    expect(() => reviewerPrompt(leaky as ReviewerPromptInput, INPUT_PATH)).toThrow(ZError);
  });

  // AC6: the four-key gate is unchanged by the new THIRD parameter -- it fires
  // regardless of what `adversarial` is, because it is a scalar arg, never a key.
  test("the four-key gate holds with the adversarial param present", () => {
    // A clean input still builds and its key set is untouched by the true branch.
    expect(typeof reviewerPrompt(REVIEWER_INPUT, INPUT_PATH, true)).toBe("string");
    expect(Object.keys(REVIEWER_INPUT).sort()).toEqual([
      "acceptanceCriteria",
      "diff",
      "ticketBody",
      "worktreePath",
    ]);
    // A smuggled fifth key throws EVEN with the adversarial flag on -- the gate
    // is not bypassed by the branch.
    const leaky = { ...REVIEWER_INPUT, prDescription: "x" };
    expect(() => reviewerPrompt(leaky as ReviewerPromptInput, INPUT_PATH, true)).toThrow(ZError);
    expect(() => reviewerPrompt(leaky as ReviewerPromptInput, INPUT_PATH, false)).toThrow(ZError);
  });
});

// -- adversarial activation (AC1-5) -------------------------------------------

describe("adversarial activation", () => {
  test("off never activates -- even a huge security diff (AC1)", () => {
    expect(adversarialActive("off", 500, ["security", "payments"])).toBe(false);
  });

  test("always always activates -- even an empty diff with no labels (AC2)", () => {
    expect(adversarialActive("always", 0, [])).toBe(true);
  });

  test("non-trivial: diff >= 10 is the inclusive boundary (AC3)", () => {
    expect(adversarialActive("non-trivial", 10, [])).toBe(true);
    expect(adversarialActive("non-trivial", 9, [])).toBe(false);
  });

  test("non-trivial: each trigger label activates, a non-trigger label does not (AC4)", () => {
    // The full trigger set: each one activates a below-threshold diff on its own.
    for (const label of ADVERSARIAL_TRIGGER_LABELS) {
      expect(adversarialActive("non-trivial", 1, [label])).toBe(true);
    }
    expect(adversarialActive("non-trivial", 1, ["docs"])).toBe(false);
    // a trigger label mixed with noise still fires; noise alone does not.
    expect(adversarialActive("non-trivial", 1, ["docs", "auth"])).toBe(true);
    expect(adversarialActive("non-trivial", 1, ["docs", "chore"])).toBe(false);
  });

  test("countDiffLines excludes +++/---/@@/diff headers (AC5)", () => {
    const diff = [
      "diff --git a/x b/x",
      "index 111..222 100644",
      "--- a/x",
      "+++ b/x",
      "@@ -1,2 +1,3 @@",
      " context line",
      "+added one",
      "+added two",
      "-removed one",
    ].join("\n");
    // Three +/- content lines; the +++/---/@@/diff/index/context lines excluded.
    expect(countDiffLines(diff)).toBe(3);
    // CRLF diffs count the same (split tolerates \r\n).
    expect(countDiffLines(diff.replace(/\n/g, "\r\n"))).toBe(3);
    expect(countDiffLines("")).toBe(0);
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
    const ra1 = reviewerPrompt(REVIEWER_INPUT, INPUT_PATH, true); // the adversarial branch is pure too
    const m1 = mergePrompt(MERGE_INPUT, INPUT_PATH);
    builderPrompt({ ...BUILDER_INPUT, ticketNumber: 99, qaNotes: "1) broken" }, INPUT_PATH);
    reviewerPrompt({ ...REVIEWER_INPUT, diff: "other diff" }, INPUT_PATH);
    reviewerPrompt({ ...REVIEWER_INPUT, diff: "other diff" }, INPUT_PATH, true);
    expect(builderPrompt(BUILDER_INPUT, INPUT_PATH)).toBe(b1);
    expect(qaPrompt(QA_INPUT, INPUT_PATH)).toBe(q1);
    expect(reviewerPrompt(REVIEWER_INPUT, INPUT_PATH)).toBe(r1);
    expect(reviewerPrompt(REVIEWER_INPUT, INPUT_PATH, true)).toBe(ra1);
    expect(mergePrompt(MERGE_INPUT, INPUT_PATH)).toBe(m1);
  });
});

// -- pointer-prompt size-invariance (AC1) -------------------------------------

describe("pointer prompts are size-invariant to the payload (AC1)", () => {
  const HUGE = "X".repeat(100_000); // 100 KB ticketBody / diff
  const AC = "Y".repeat(100_000);

  const TINY = "x"; // the same fields at 1 byte, for the invariance comparison

  // The builder/qa injection carries the huge body; the reviewer additionally
  // carries a huge diff + acceptance criteria. Every stage's input-<N>.json is
  // referenced by absolute path; the built prompt must not embed the payload.
  //
  // `cap` is a per-stage absolute ceiling, not the contract itself: the contract
  // is INVARIANCE (`buildTiny().length === buildHuge().length`), asserted below,
  // which is strictly stronger than any single number. The cap stays as a second
  // guard so a future edit that inlines something unrelated still trips. #191
  // raised the adversarial reviewer's alone, deliberately: hardening the
  // super-truth block against starved skeptic delivery added ~1 KB of FIXED
  // instructions. That is not the failure this test guards against -- its
  // invariance assertion is unaffected -- so the number moved and every other
  // stage kept 4 KB. #209 moved it once more for the same reason: the shared
  // foreground rule (~0.7 KB of fixed text) now goes to the reviewer too, which
  // is where the markerless exits were actually observed.
  const CASES: { stage: string; build: (payload: string, ac: string) => string; cap: number; payloads: string[] }[] = [
    { stage: "builder", build: (b) => builderPrompt({ ...BUILDER_INPUT, ticketBody: b }, INPUT_PATH), cap: 4096, payloads: [HUGE] },
    { stage: "qa", build: (b) => qaPrompt({ ...QA_INPUT, ticketBody: b }, INPUT_PATH), cap: 4096, payloads: [HUGE] },
    { stage: "reviewer", build: (b, ac) => reviewerPrompt({ ...REVIEWER_INPUT, ticketBody: b, diff: b, acceptanceCriteria: ac }, INPUT_PATH), cap: 4096, payloads: [HUGE, AC] },
    // The adversarial reviewer branch fans out skeptics but STILL points at the
    // file for its payload -- it must stay size-invariant too.
    { stage: "reviewer (adversarial)", build: (b, ac) => reviewerPrompt({ ...REVIEWER_INPUT, ticketBody: b, diff: b, acceptanceCriteria: ac }, INPUT_PATH, true), cap: 6144, payloads: [HUGE, AC] },
    // Merge carries a second mandatory command block (the Step 0 version claim,
    // with its own absolute CLI path and six flags), so it sits in the same
    // higher band the adversarial reviewer does. Still payload-invariant, which
    // is the property this case exists to pin.
    { stage: "merge", build: () => mergePrompt(MERGE_INPUT, INPUT_PATH), cap: 6144, payloads: [] },
  ];

  for (const c of CASES) {
    test(`${c.stage}: 100 KB payload -> same-length prompt under ${c.cap}B, omits the payload, contains the absolute input path`, () => {
      const p = c.build(HUGE, AC);
      // The contract: a 100,000x bigger payload changes the prompt not at all.
      expect(p.length).toBe(c.build(TINY, TINY).length);
      expect(p.length).toBeLessThan(c.cap);
      for (const payload of c.payloads) expect(p).not.toContain(payload);
      expect(isAbsolute(INPUT_PATH)).toBe(true);
      expect(p).toContain(INPUT_PATH);
    });
  }
});

// -- adversarial reviewer prompt (AC7) ----------------------------------------

// A fixed, checkout-independent input path used ONLY for the byte-pinned golden
// file below. Post-#57 the reviewer prompt is a POINTER, so it embeds
// ${inputPath}; pinning that path to a literal keeps reviewer-single-pass.golden
// byte-stable across machines (INPUT_PATH is absolute and machine-specific). What
// the golden pins is the shared reviewer body; the path value is immaterial.
const GOLDEN_INPUT_PATH = "/loop/tmp/input-42.json";

describe("adversarial reviewer prompt", () => {
  // The reconciled single-pass (pointer) prompt, pinned byte-for-byte. Post-#62,
  // REVIEW-APPROVE always carries a literal confidence=<0-100> token (the safety
  // gate reads it whether or not the super-truth pass ran); only the skeptic
  // fan-out and REVIEW-FINDINGS' confidence stay adversarial-only (#59, out of
  // #62's scope). If either branch drifts, reviewerPrompt(REVIEWER_INPUT,
  // GOLDEN_INPUT_PATH, false) stops matching this and the test fails -- the
  // non-adversarial path is a strict no-op superset by contract: active ==
  // inactive + exactly the super-truth block and REVIEW-FINDINGS' confidence
  // token (REVIEW-APPROVE's confidence, present in both, is part of the shared,
  // unchanged body).
  const SINGLE_PASS_BASELINE = readFileSync(join(import.meta.dir, "reviewer-single-pass.golden.txt"), "utf8");

  test("active prompt fans out skeptics and emits confidence; inactive prompt is still the single pass", () => {
    const active = reviewerPrompt(REVIEWER_INPUT, INPUT_PATH, true);
    expect(active).toContain("skeptic");
    expect(active).toContain("Agent tool");
    expect(active).toContain("Super-truth pass");
    // REVIEW-APPROVE always carries confidence (#62); REVIEW-FINDINGS only
    // when the super-truth pass ran (#59's unchanged behavior).
    expect(active).toContain("REVIEW-APPROVE: confidence=<0-100>");
    expect(active).toContain("REVIEW-FINDINGS: confidence=<0-100>");

    const inactive = reviewerPrompt(REVIEWER_INPUT, INPUT_PATH, false);
    expect(inactive).not.toContain("skeptic");
    expect(inactive).not.toContain("Super-truth");
    // The single pass still carries REVIEW-APPROVE's confidence (#62 is
    // unconditional there) but never REVIEW-FINDINGS'.
    expect(inactive).toContain("REVIEW-APPROVE: confidence=<0-100>");
    expect(inactive).not.toContain("REVIEW-FINDINGS: confidence=");
    // default arg: omitting the flag is the single pass.
    expect(reviewerPrompt(REVIEWER_INPUT, INPUT_PATH)).toBe(inactive);
  });

  test("inactive prompt is byte-identical to the pinned single-pass baseline", () => {
    expect(reviewerPrompt(REVIEWER_INPUT, GOLDEN_INPUT_PATH, false)).toBe(SINGLE_PASS_BASELINE);
    // And the active prompt is the single pass PLUS exactly the super-truth
    // block, REVIEW-FINDINGS' confidence token, and (#191) each marker's
    // skeptics=<k>/3 denominator -- REVIEW-APPROVE's confidence (present in
    // both) is part of the shared, unchanged body.
    //
    // The block is bounded by the section that FOLLOWS it, not by a phrase
    // inside it: an earlier version matched lazily up to the first "below.\n",
    // so lengthening the block (as #191 did) left its tail behind and the
    // difference showed up as an unrelated-looking golden mismatch. #209 put a
    // shared section between this block and the exit contract, so the bound moved
    // to that one -- ending at "## Exit contract" would now strip the foreground
    // rule the single pass also carries.
    const active = reviewerPrompt(REVIEWER_INPUT, GOLDEN_INPUT_PATH, true);
    const stripped = active
      .replace(/\n## Super-truth pass[\s\S]*?(?=\n## Verification runs in the FOREGROUND)/, "")
      .replaceAll("skeptics=<k>/3 ", "")
      .replace("REVIEW-FINDINGS: confidence=<0-100> ", "REVIEW-FINDINGS: ");
    expect(stripped).toBe(SINGLE_PASS_BASELINE);
  });

  // #191: the three run-10 failure modes the block now names explicitly.
  // Reviewers hung on a skeptic that never reported, ended a turn with no marker
  // (CONFUSED -> the ticket is SKIPPED), or reported confidence=100 holding zero
  // verdicts -- which #62's gate read as three independent agreements.
  test("the super-truth block makes delivery best-effort with a mandatory denominator", () => {
    const active = reviewerPrompt(REVIEWER_INPUT, INPUT_PATH, true);
    expect(active).toContain("Delivery is BEST-EFFORT");
    expect(active).toContain("AT MOST ONCE per skeptic");
    expect(active).toContain("Do not spawn replacements");
    expect(active).toContain("Do NOT end your turn without one of the exit markers");
    // Both markers carry the denominator, so a starved review is legible on
    // either path.
    expect(active).toContain("REVIEW-APPROVE: confidence=<0-100> skeptics=<k>/3");
    expect(active).toContain("REVIEW-FINDINGS: confidence=<0-100> skeptics=<k>/3");
  });

  test("the k -> confidence mapping is an enumerated table, not a formula", () => {
    const active = reviewerPrompt(REVIEWER_INPUT, INPUT_PATH, true);
    expect(active).toContain("do no arithmetic");
    // Every reachable (k, unrefuted) pair is spelled out, so the reviewer never
    // computes 100*u/k in prose (PRINCIPLES.md, latent vs deterministic).
    expect(active).toContain("k=3: 3 unrefuted -> 100, 2 -> 67, 1 -> 33, 0 -> 0");
    expect(active).toContain("k=2: 2 unrefuted -> 100, 1 -> 50, 0 -> 0");
    expect(active).toContain("k=1: 1 unrefuted -> 100, 0 -> 0");
    // The k=0 case is the one that used to merge on a fabricated 100.
    expect(active).toContain("skeptics=0/3");
    expect(active).toContain("never 100");
  });

  // #209, the dominant observed case. The Plan asked for the foreground rule on
  // "builder and QA at minimum", but the data says reviewers: 3 of run 11's 4
  // markerless exits, and run 12 reproduced it three more times (#149, #178, #205
  // each ended a turn with no marker while waiting on skeptics, each rescued by
  // hand). The reviewer runs the same typecheck-and-touched-tests gauntlet, so it
  // carries the same rule -- on BOTH branches, since the single pass has no
  // super-truth block to hide the marker reminder in.
  test("the reviewer carries the foreground rule on both branches", () => {
    for (const adversarial of [false, true]) {
      const p = reviewerPrompt(REVIEWER_INPUT, INPUT_PATH, adversarial);
      expect(p).toContain("Verification runs in the FOREGROUND");
      expect(p).toContain("Never background a gate and end your turn waiting on it");
      expect(p).toContain("Ending your turn with a background job still pending is parsed as CONFUSED");
      // The reviewer's wait is usually a sub-agent, not a test run.
      expect(p).toContain("a sub-agent included");
      // It lands before the markers it is talking about.
      expect(p.indexOf("Verification runs in the FOREGROUND")).toBeLessThan(p.indexOf("## Exit contract"));
    }
    // ...and the skeptic wait is named outright where the fan-out is described.
    const active = reviewerPrompt(REVIEWER_INPUT, INPUT_PATH, true);
    expect(active).toContain('"Still waiting on a skeptic" is not an exception');
  });

  // The denominator is adversarial-only: with no fan-out there is no k, and
  // demanding one would invite an invented number.
  test("the single pass demands no denominator", () => {
    const inactive = reviewerPrompt(REVIEWER_INPUT, INPUT_PATH, false);
    expect(inactive).not.toContain("skeptics=");
    expect(inactive).not.toContain("BEST-EFFORT");
  });
});

// -- spawn tag (#190) ---------------------------------------------------------

// The stamp lib/transcripts.ts searches for. Two properties matter and are
// pinned per stage: omitting the tag leaves the prompt BYTE-IDENTICAL to
// pre-#190 (which is what lets reviewer-single-pass.golden.txt stand
// unregenerated), and supplying one adds EXACTLY one leading line and changes
// nothing else.
describe("spawn tag stamp (#190)", () => {
  const TAG = "zs-a1b2c3d4e5f6";
  const STAMP = `<!-- ${SPAWN_TAG_MARKER} ${TAG} (orchestrator bookkeeping; ignore) -->\n`;
  const STAGES: [string, (tag?: string) => string][] = [
    ["builder", (t) => builderPrompt(BUILDER_INPUT, INPUT_PATH, t)],
    ["qa", (t) => qaPrompt(QA_INPUT, INPUT_PATH, t)],
    ["reviewer (single pass)", (t) => reviewerPrompt(REVIEWER_INPUT, INPUT_PATH, false, t)],
    ["reviewer (adversarial)", (t) => reviewerPrompt(REVIEWER_INPUT, INPUT_PATH, true, t)],
    ["merge", (t) => mergePrompt(MERGE_INPUT, INPUT_PATH, t)],
  ];

  for (const [name, build] of STAGES) {
    test(`${name}: omitted tag is byte-identical to no stamp at all`, () => {
      expect(build(undefined)).toBe(build());
      // An empty string is the shell's "unset variable" case: `--spawn-tag ""`
      // must not stamp a tagless marker that then matches nothing.
      expect(build("")).toBe(build());
      expect(build()).not.toContain(SPAWN_TAG_MARKER);
    });

    test(`${name}: a tag adds exactly one leading line and nothing else`, () => {
      const tagged = build(TAG);
      expect(tagged).toBe(STAMP + build());
      // First line, so lib/transcripts.ts finds it inside its bounded prefix
      // read of the transcript's opening line.
      expect(tagged.split("\n")[0]).toContain(`${SPAWN_TAG_MARKER} ${TAG}`);
      expect(tagged.split(SPAWN_TAG_MARKER)).toHaveLength(2);
    });
  }

  // Blindness (issue #8 AC3) is why the tag is an opaque digest rather than
  // `<slug>/t<n>/<stage>/<attempt>`: a readable tag would tell the reviewer this
  // is review ATTEMPT 2, i.e. that an earlier review rejected the diff. The
  // constructor cannot enforce the value's shape, but it must not be the place
  // that composes a readable one -- it stamps exactly what it is handed.
  test("the reviewer's stamp carries only the opaque tag it was handed", () => {
    const tagged = reviewerPrompt(REVIEWER_INPUT, INPUT_PATH, true, TAG);
    const stamp = tagged.split("\n")[0];
    expect(stamp).toBe(STAMP.trimEnd());
    for (const leak of ["attempt", "t42", "/reviewer/"]) expect(stamp).not.toContain(leak);
  });
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
    // Files-section nudge (issue #84): a ticket that carries a `## Files`
    // section is the grounding map the builder should start from instead of
    // re-discovering the same paths with fresh glob/grep.
    expect(p).toContain("If the ticket has a `## Files` section, it is the map");
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

  // #177: the commit re-spawn's whole value is telling the fresh builder that the
  // work may already exist, uncommitted, in the worktree -- a rebuild from scratch
  // is the wrong move -- and that BUILT is verified, so the same slip loops.
  test("the commit re-spawn points at commitNotes and says commit, do not rebuild", () => {
    const p = builderPrompt({ ...BUILDER_INPUT, commitNotes: "uncommitted work: 3 uncommitted path(s)" }, INPUT_PATH);
    expect(p).toContain("`commitNotes`");
    expect(p).toContain(INPUT_PATH);
    expect(p).not.toContain("3 uncommitted path(s)"); // payload lives in the input file
    expect(p).toContain("COMMIT whatever is already there");
    expect(p).toContain("git status");
    // Absent on every other spawn, so a first-pass builder prompt is unchanged.
    expect(builderPrompt(BUILDER_INPUT, INPUT_PATH)).not.toContain("commitNotes");
  });

  // The exit contract itself has to state what BUILT is checked against, or the
  // guard is a surprise the builder learns by being re-spawned.
  test("the BUILT marker states the clean-tree + moved-HEAD requirement", () => {
    const p = builderPrompt(BUILDER_INPUT, INPUT_PATH);
    expect(p).toContain("git status --porcelain` empty");
    expect(p).toContain(`HEAD off ${BUILDER_INPUT.baseBranch}`);
  });

  // #209 AC1. Run 11's #170 builder fixed both reviewer findings, backgrounded
  // `bun test`, and ended its turn waiting on it -- and the loop sends a stage
  // agent exactly one message by design, so nothing could ever wake it. The
  // prompt told it to run the gauntlet and never said the run must FINISH first.
  test("AC1: the builder is told verification runs in the foreground and a pending job is CONFUSED", () => {
    const p = builderPrompt(BUILDER_INPUT, INPUT_PATH);
    expect(p).toContain("FOREGROUND");
    expect(p).toContain("Never background a gate and end your turn waiting on it");
    expect(p).toContain("Ending your turn with a background job still pending is parsed as CONFUSED");
    expect(p).toContain("skips this ticket");
  });

  // #209 AC5. The re-spawned agent must be told the prior attempt's work is
  // UNVERIFIED and that keeping/fixing/dropping it is its own call: carrying it
  // forward as trusted would defeat the fresh-agent guarantee, and dropping it
  // silently is the waste the re-spawn exists to prevent.
  test("AC5: the dead-worker re-spawn hands over unverified work and the keep/fix/drop call", () => {
    const p = builderPrompt({ ...BUILDER_INPUT, respawnNotes: "predecessor died silent" }, INPUT_PATH);
    expect(p).toContain("died without reporting");
    expect(p).toContain("`respawnNotes`");
    expect(p).toContain(INPUT_PATH);
    expect(p).not.toContain("predecessor died silent"); // payload lives in the input file
    expect(p).toContain("UNCOMMITTED and UNVERIFIED");
    expect(p).toContain("whether to keep, fix, or drop them");
    expect(p).toContain("That call is yours");
    // Absent on every other spawn, so a first-pass builder prompt is unchanged.
    expect(builderPrompt(BUILDER_INPUT, INPUT_PATH)).not.toContain("respawnNotes");
    // And it is not the #177 commit re-spawn, which tells the builder to KEEP and
    // commit what is there -- a different predecessor and a different judgment.
    expect(p).not.toContain("COMMIT whatever is already there");
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

  // #209: QA runs the same gauntlet, so it carries the same foreground rule and
  // the same re-spawn briefing (a QA agent that did leave uncommitted changes
  // left exactly the same unverified state a fresh one must judge).
  test("QA carries the foreground rule, and a re-spawn briefing when it is one", () => {
    const p = qaPrompt(QA_INPUT, INPUT_PATH);
    expect(p).toContain("FOREGROUND");
    expect(p).toContain("Ending your turn with a background job still pending is parsed as CONFUSED");
    expect(p).not.toContain("respawnNotes");
    const r = qaPrompt({ ...QA_INPUT, respawnNotes: "predecessor died silent" }, INPUT_PATH);
    expect(r).toContain("`respawnNotes`");
    expect(r).toContain("UNCOMMITTED and UNVERIFIED");
    expect(r).not.toContain("predecessor died silent");
  });
});

// -- merge prompt -------------------------------------------------------------

describe("merge prompt", () => {
  test("plain merge: PR steps, conflict gauntlet, no branch deletion mid-batch, input pointer", () => {
    const p = mergePrompt(MERGE_INPUT, INPUT_PATH);
    expect(p).toContain("gh pr create --base main");
    expect(p).toContain("re-run Step 0's claim command AND Step 1's gate command exactly as written"); // the conflict path re-claims AND re-gates

    expect(p).toContain("Never pass --delete-branch");
    expect(p).toContain("MERGED:");
    expect(p).toContain(INPUT_PATH); // AC1: every stage references its input file
    expect(p).not.toContain("Stacked chain");
  });

  // #178: the merge agent must never judge green vs red -- the loop's own gate
  // does, and its exit code is the merge permission.
  test("the green gate is the loop's: the prompt hands the agent a command and an exit code, not a judgment", () => {
    const p = mergePrompt(MERGE_INPUT, INPUT_PATH);
    expect(p).toMatch(/never decide green vs red/i);
    expect(p).toContain("merge-gate"); // the loop-owned CLI, by absolute pack path
    expect(p).toContain(resolve(MERGE_INPUT.worktreePath)); // ...against an ABSOLUTE worktree (QA finding 5)
    expect(p).toContain("Exit 0 = green");
    expect(p).toMatch(/ANY nonzero exit = stop and exit BLOCKED/);
    expect(p).toContain("only when the gate exited 0"); // step 3 no longer says "when everything is green"
  });

  // QA finding 2 on the first #178 pass: the prompt ASSERTED "the loop already
  // ran the gate and it returned GREEN", and the only instruction to run it was
  // conditional on a conflict resolution -- so on the clean-merge path the agent
  // ran nothing and merged on an unverifiable claim. The gate command is now an
  // unconditional Step 0 and the prompt states no verdict as fact.
  test("the gate is an UNCONDITIONAL step 0, ahead of the numbered steps, with no claim that it already passed", () => {
    const p = mergePrompt(MERGE_INPUT, INPUT_PATH);
    const gateIdx = p.indexOf("merge-gate");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(p.indexOf("## Steps")); // before every numbered step, including the merge
    expect(p).toMatch(/## Step 1 -- run the green gate/);
    expect(p).toMatch(/Run this yourself, in THIS session, before any gh pr merge -- unconditionally/);
    // No unverifiable assurance about a run the agent cannot see.
    expect(p).not.toMatch(/returned GREEN/i);
    expect(p).not.toMatch(/already ran the mechanical pre-merge gate/i);
    // The command inherits the same timeout lesson as the orchestrator's row:
    // a full suite + typecheck plus a 15s contention retry blows a 120s default.
    expect(p).toMatch(/timeout/i);
    expect(p).toContain("600000");
    // ...and a change to the branch invalidates the earlier run.
    expect(p).toMatch(/Run it AGAIN -- the same command, byte for byte -- after any change you make to the branch/);
  });

  // QA finding 5: the rendered command paired an ABSOLUTE cli path with the
  // input's RELATIVE worktree (`merge-gate '.worktrees/ticket-42'`), while the
  // Workspace line and step 2 ("resolve ON the branch") both invite a cd into
  // that worktree. From in there the gate's existsSync fails, it exits nonzero,
  // and Step 0's own "ANY nonzero exit = BLOCKED" rule false-blocks every merge.
  // toContain(worktreePath) could never catch it -- the relative path is a
  // substring of the absolute one.
  test("the gate command's worktree argument is ABSOLUTE, so it runs from any cwd", () => {
    const p = mergePrompt(MERGE_INPUT, INPUT_PATH);
    const arg = p.match(/merge-gate '([^']+)'/)![1];
    expect(isAbsolute(arg)).toBe(true);
    expect(arg).toBe(resolve(MERGE_INPUT.worktreePath));
    // The Workspace line names the same absolute path, so nothing in the prompt
    // hands the agent a cwd-dependent worktree.
    expect(p).toContain(`- Worktree: ${resolve(MERGE_INPUT.worktreePath)},`);
    expect(p).toMatch(/absolute, so it runs correctly from any directory/);
  });

  // QA finding 6: the post-conflict re-gate was back to prose compliance --
  // Step 0's command omitted --state/--ticket, so a re-run after a conflict
  // resolution stamped nothing and the reducer could not see whether it
  // happened, while the lane kept carrying the pre-merge verdict for a commit
  // the agent had since changed.
  test("with a statePath the gate command STAMPS, so a post-conflict re-run is on the record", () => {
    const statePath = join("loop", "state.json");
    const p = mergePrompt({ ...MERGE_INPUT, statePath }, INPUT_PATH);
    expect(p).toContain(`--state '${resolve(statePath)}' --ticket 42`);
    // Step 2 sends the agent back to the very same command, stamp included.
    expect(p).toMatch(/re-run Step 0's claim command AND Step 1's gate command exactly as written/);
    expect(p).toMatch(/the verdict records the commit sha it tested/);
  });

  test("without a statePath the gate is still run, just unstamped -- the exit code still gates", () => {
    const p = mergePrompt(MERGE_INPUT, INPUT_PATH);
    expect(p).toContain("merge-gate");
    expect(p).not.toContain("--state");
    // Scoped to the GATE command line, not the whole prompt: the Step 0 version
    // claim legitimately carries --ticket (it reads that issue's labels), so a
    // whole-prompt assertion would now pass or fail for the wrong reason.
    const gateCmd = p.split(/\r?\n/).find((l) => l.includes("merge-gate"))!;
    expect(gateCmd).not.toContain("--ticket");
    expect(gateCmd).not.toContain("--state");
    expect(p).toMatch(/ANY nonzero exit = stop and exit BLOCKED/);
  });

  // -- per-PR version claiming ------------------------------------------------
  // gstack's /review reads a PR's claimed version off the BRANCH, so the bump
  // has to be a commit on the branch before the PR is opened. These pin the
  // three properties that makes true.
  test("the version claim is Step 0, ahead of the gate and of every numbered step", () => {
    const p = mergePrompt(MERGE_INPUT, INPUT_PATH);
    const claimIdx = p.indexOf("## Step 0 -- claim this PR's version slot");
    expect(claimIdx).toBeGreaterThan(-1);
    // Before the gate: the claim COMMITS to the branch, so a gate run ahead of
    // it would stamp a verdict for a commit that is not the one being merged.
    expect(claimIdx).toBeLessThan(p.indexOf("## Step 1 -- run the green gate"));
    expect(claimIdx).toBeLessThan(p.indexOf("## Steps"));
    expect(p).toMatch(/It runs BEFORE the gate because it commits to the branch/);
  });

  test("the claim command names the version CLI by absolute pack path, with every argument quoted inertly", () => {
    const p = mergePrompt(MERGE_INPUT, INPUT_PATH);
    const cli = p.match(/bun '([^']*version\.ts)' claim/)![1];
    expect(isAbsolute(cli)).toBe(true);
    expect(cli).toBe(join(REPO_ROOT, "lib", "version.ts"));
    expect(p).toContain(`claim --ticket 42 --worktree '${resolve(MERGE_INPUT.worktreePath)}'`);
    expect(p).toContain(`--base 'main'`);
    expect(p).toContain(`--title ${shSingleQuote(MERGE_INPUT.prTitle)}`);
  });

  // The number is deterministic space; the prose is not. The prompt must hand
  // the agent exactly one job (the entry) and forbid the other (the version).
  test("the agent writes the CHANGELOG prose and NOTHING else -- the number is refused to it explicitly", () => {
    const p = mergePrompt(MERGE_INPUT, INPUT_PATH);
    expect(p).toMatch(/The NUMBER is not yours to pick/);
    expect(p).toMatch(/that prose is the ONLY part of this step that is yours/);
    expect(p).toMatch(/Never edit VERSION, package\.json or a CHANGELOG heading yourself, and never type a version number anywhere/);
    expect(p).toMatch(/Nonzero exit = stop and exit BLOCKED with its message; do NOT open the PR/);
  });

  // Both scratch files sit beside the stage input, NOT in the worktree: an
  // untracked file in the tree the gate measures is noise the claim would then
  // have to avoid staging.
  test("the entry and title files live beside the stage input, never inside the worktree", () => {
    const p = mergePrompt(MERGE_INPUT, INPUT_PATH);
    const entry = p.match(/--entry-file '([^']+)'/)![1];
    const title = p.match(/--title-out '([^']+)'/)![1];
    for (const f of [entry, title]) {
      expect(isAbsolute(f)).toBe(true);
      expect(dirname(f)).toBe(dirname(INPUT_PATH));
      expect(f.startsWith(resolve(MERGE_INPUT.worktreePath))).toBe(false);
    }
    expect(entry).toContain("changelog-42");
    expect(title).toContain("pr-title-42");
  });

  // The PR title carries the claimed version, and only the CLI knows it -- so
  // the prompt must read the file rather than interpolate a title the
  // orchestrator computed before any slot existed.
  test("gh pr create reads the title from the file the claim wrote, not from a retyped string", () => {
    const p = mergePrompt(MERGE_INPUT, INPUT_PATH);
    const titlePath = p.match(/--title-out '([^']+)'/)![1];
    expect(p).toContain(`gh pr create --base main --head ${MERGE_INPUT.branch} --title "$(cat '${titlePath}')"`);
    expect(p).toMatch(/do not retype it/);
  });

  test("a conflict resolution re-runs the CLAIM before the gate, and keeps both CHANGELOG sections", () => {
    const p = mergePrompt(MERGE_INPUT, INPUT_PATH);
    expect(p).toMatch(/re-run Step 0's claim command AND Step 1's gate command exactly as written, in that order/);
    expect(p).toMatch(/the base VERSION just moved/);
    expect(p).toMatch(/a CHANGELOG conflict resolves by KEEPING BOTH sections, newest version on top/);
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

  // Review finding. The conflict path re-claims because resolving moves the base
  // VERSION -- but a stacked child's RETARGET moves it for the same reason and
  // needs no conflict to do so. Without this, a child merges carrying a slot it
  // claimed before its parent was on the base: a version going backwards.
  test("a stacked child re-claims after the retarget, not only after a conflict", () => {
    const p = mergePrompt({ ...MERGE_INPUT, stackedOn: [40] }, INPUT_PATH);
    expect(p).toMatch(/A parent landing MOVES main's VERSION/);
    expect(p).toMatch(/after the last retarget re-run Step 0's claim command and then Step 1's gate/);
    // Only on the stacked branch -- an unstacked merge has no parent to wait on.
    expect(mergePrompt(MERGE_INPUT, INPUT_PATH)).not.toMatch(/A parent landing MOVES/);
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

// -- plan-time edges comment (ticket #77 AC1) ---------------------------------

describe("planEdgesComment", () => {
  const EDGES: CompletionEdge[] = [
    { check: "the chosen retry default", doStep: "trigger two consecutive failures", expect: "a third attempt, not a park" },
    { check: "the ambiguous empty-input case", doStep: "submit with no rows selected", expect: "a no-op, not an error" },
  ];

  test("starts with the Needs-input heading and renders one to-check/do/expect bullet per edge", () => {
    const c = planEdgesComment(EDGES);
    expect(c.startsWith("## Needs input —")).toBe(true);
    expect(c).toContain("To check the chosen retry default, do trigger two consecutive failures, expect a third attempt, not a park.");
    expect(c).toContain("To check the ambiguous empty-input case, do submit with no rows selected, expect a no-op, not an error.");
    // Exactly one bullet per edge, nothing extra.
    expect(c.split("\n").filter((l) => l.startsWith("- ")).length).toBe(EDGES.length);
  });

  test("an empty list renders \"\" so the caller posts no comment", () => {
    expect(planEdgesComment([])).toBe("");
  });
});

// -- CLI smoke ----------------------------------------------------------------

describe("stage-prompts CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "zstack-prompts-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const SP = join(REPO_ROOT, "lib", "stage-prompts.ts");
  const run = (...args: string[]) => Bun.spawnSync(["bun", SP, ...args], { stdout: "pipe", stderr: "pipe" });

  test("prompt reviewer builds from an input file; a leaky input file fails loudly", () => {
    const ok = join(dir, "reviewer.json");
    writeFileSync(ok, JSON.stringify(REVIEWER_INPUT));
    const proc = run("prompt", "reviewer", ok);
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("ADVERSARIAL REVIEWER");

    const leaky = join(dir, "leaky.json");
    writeFileSync(leaky, JSON.stringify({ ...REVIEWER_INPUT, builderTranscript: "..." }));
    const bad = run("prompt", "reviewer", leaky);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr.toString()).toContain("blinded by design");
  });

  // AC10: the reviewer's --adversarial-mode / --labels flags select the branch
  // deterministically from mode + the input's own diff size + labels; the leaky
  // file still fails loudly regardless of flags.
  test("--adversarial-mode / --labels select the super-truth branch (AC10)", () => {
    // REVIEWER_INPUT.diff has ONE changed line (< 10), so under the default
    // non-trivial mode with no labels it is the single pass.
    const ok = join(dir, "reviewer-cli.json");
    writeFileSync(ok, JSON.stringify(REVIEWER_INPUT));

    const always = run("prompt", "reviewer", ok, "--adversarial-mode", "always");
    expect(always.exitCode).toBe(0);
    expect(always.stdout.toString()).toContain("skeptic");
    expect(always.stdout.toString()).toContain("confidence=");

    const labelled = run("prompt", "reviewer", ok, "--adversarial-mode", "non-trivial", "--labels", '["security"]');
    expect(labelled.exitCode).toBe(0);
    expect(labelled.stdout.toString()).toContain("skeptic");
    expect(labelled.stdout.toString()).toContain("confidence=");

    // No flags: default non-trivial, 1-line diff, no labels -> single pass.
    const plain = run("prompt", "reviewer", ok);
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout.toString()).not.toContain("skeptic");
    // REVIEW-APPROVE still carries confidence unconditionally (#62); only the
    // super-truth fan-out and REVIEW-FINDINGS' confidence are adversarial-gated.
    expect(plain.stdout.toString()).toContain("REVIEW-APPROVE: confidence=<0-100>");
    expect(plain.stdout.toString()).not.toContain("REVIEW-FINDINGS: confidence=");

    // off never fans out, even with a trigger label present.
    const off = run("prompt", "reviewer", ok, "--adversarial-mode", "off", "--labels", '["security"]');
    expect(off.exitCode).toBe(0);
    expect(off.stdout.toString()).not.toContain("skeptic");

    // A bad mode is rejected loudly, before any prompt is printed.
    const badMode = run("prompt", "reviewer", ok, "--adversarial-mode", "sometimes");
    expect(badMode.exitCode).toBe(1);
    expect(badMode.stderr.toString()).toContain("adversarial-mode");

    // A leaky file still fails with the blindness error even under active flags.
    const leaky = join(dir, "leaky-cli.json");
    writeFileSync(leaky, JSON.stringify({ ...REVIEWER_INPUT, prDescription: "trust me" }));
    const bad = run("prompt", "reviewer", leaky, "--adversarial-mode", "always");
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr.toString()).toContain("blinded by design");
  });

  // #190: the flag every stage accepts. It rides as a FLAG, so the reviewer's
  // blinded four-key input JSON is untouched -- same treatment as
  // --adversarial-mode / --labels above.
  test("--spawn-tag stamps every stage; omitting it changes nothing", () => {
    const TAG = "zs-000102030405";
    const inputs: [string, unknown][] = [
      ["builder", BUILDER_INPUT],
      ["qa", QA_INPUT],
      ["reviewer", REVIEWER_INPUT],
      ["merge", MERGE_INPUT],
    ];
    for (const [stage, input] of inputs) {
      const file = join(dir, `spawn-${stage}.json`);
      writeFileSync(file, JSON.stringify(input));

      const tagged = run("prompt", stage, file, "--spawn-tag", TAG);
      expect(tagged.exitCode).toBe(0);
      expect(tagged.stdout.toString().split("\n")[0]).toContain(`${SPAWN_TAG_MARKER} ${TAG}`);

      const plain = run("prompt", stage, file);
      expect(plain.exitCode).toBe(0);
      expect(plain.stdout.toString()).not.toContain(SPAWN_TAG_MARKER);
      // The stamp is additive: strip the first line and the two agree byte for
      // byte, for every stage.
      expect(tagged.stdout.toString().split("\n").slice(1).join("\n")).toBe(plain.stdout.toString());
    }
  });

  // A leaky input file must still fail loudly WITH the flag present -- the tag
  // must not become a fifth smuggled key by another route.
  test("--spawn-tag does not weaken the reviewer's blindness gate", () => {
    const leaky = join(dir, "leaky-spawn.json");
    writeFileSync(leaky, JSON.stringify({ ...REVIEWER_INPUT, planRationale: "because" }));
    const bad = run("prompt", "reviewer", leaky, "--spawn-tag", "zs-000102030405");
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr.toString()).toContain("blinded by design");
  });
});

// -- spawn stub (Leak 3) ------------------------------------------------------

// The property that makes the stub worth having: the orchestrator's per-spawn
// context cost stops tracking the prompt's size. If these ever start covarying,
// the stub has silently regressed into a second copy of the prompt.
describe("spawnStub", () => {
  const dir = mkdtempSync(join(tmpdir(), "zstack-stub-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const SP = join(REPO_ROOT, "lib", "stage-prompts.ts");
  const run = (...args: string[]) => Bun.spawnSync(["bun", SP, ...args], { stdout: "pipe", stderr: "pipe" });

  test("stub length is invariant to the prompt file's size", () => {
    const p = "/abs/loop/tmp/prompt-1.txt";
    // Same stage, same path, wildly different prompts on disk -> identical stub.
    // spawnStub never reads the file, which is the structural reason this holds.
    for (const stage of STAGES) {
      const a = spawnStub(stage, p);
      const b = spawnStub(stage, p);
      expect(a).toBe(b);
      // and it stays far below a real stage prompt (~2.9 KB measured)
      expect(a.length).toBeLessThan(700);
    }
  });

  test("stub names the ABSOLUTE prompt path, twice: instruction and BLOCKED fallback", () => {
    const p = "/abs/loop/tmp/prompt-42.txt";
    const s = spawnStub("builder", p);
    expect(isAbsolute(p)).toBe(true);
    expect(s).toContain(`\n${p}\n`);
    // The fallback must be a marker lib/loop.ts already parses, carrying the
    // path, so an unreadable prompt parks the lane loudly instead of wedging it.
    expect(s).toContain(`BLOCKED: could not read stage prompt at ${p}`);
  });

  test("stub identifies its stage and carries the spawn tag as its first line", () => {
    const TAG = "zs-0a1b2c3d4e5f";
    for (const stage of STAGES) {
      const tagged = spawnStub(stage, "/abs/p.txt", TAG);
      expect(tagged.split("\n")[0]).toContain(`${SPAWN_TAG_MARKER} ${TAG}`);
      expect(tagged).toContain(`You are the ${stage.toUpperCase()} stage`);
      // Additive, exactly like the prompt stamp: strip line 1 and they agree.
      expect(tagged.split("\n").slice(1).join("\n")).toBe(spawnStub(stage, "/abs/p.txt"));
    }
  });

  test("CLI stub resolves a relative path and refuses an unreadable prompt", () => {
    const file = join(dir, "prompt-7.txt");
    writeFileSync(file, "PROMPT BODY\n".repeat(400));
    const ok = run("stub", "qa", file);
    expect(ok.exitCode).toBe(0);
    const out = ok.stdout.toString();
    expect(out).toContain(file);
    // The 4.8 KB prompt must NOT be echoed into the stub.
    expect(out).not.toContain("PROMPT BODY");
    expect(out.length).toBeLessThan(700);

    const missing = run("stub", "qa", join(dir, "does-not-exist.txt"));
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.toString()).toContain("Cannot read stage prompt at");

    const badStage = run("stub", "nope", file);
    expect(badStage.exitCode).toBe(1);
    expect(badStage.stderr.toString()).toContain('Unknown stage "nope"');
  });
});
