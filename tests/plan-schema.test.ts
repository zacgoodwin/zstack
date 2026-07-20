// Gate tests for C5's ticket-body schema (lib/ticket-schema.ts) and the
// determinism chain behind /z-plan's Estimate field. Covers: the schema gate
// (issue #7 AC1 -- every mandatory section present, malformed/empty caught,
// optional Depends-on), slugify stability (idempotent re-plan matching, AC in
// SKILL.md Step 9), the z-ticket-lint CLI exit codes, and the tier->z-estimate
// chain that makes estimates reproducible (AC2). Deterministic, fixtures only,
// no network.
import { test, expect, describe, spyOn, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  main,
  needsSplit,
  shouldSplitForCost,
  slugifyTitle,
  validateTicketBody,
  SPLIT_MAX_FILES,
  SPLIT_MAX_STEPS,
  TIER_ESTIMATES,
  type TicketError,
} from "../lib/ticket-schema.ts";
import { estimate, loadRates, type Buckets } from "../lib/estimate.ts";

const TICKETS = join(import.meta.dir, "fixtures", "tickets");
const read = (name: string) => readFileSync(join(TICKETS, name), "utf8");
const sections = (errs: TicketError[]) => errs.map((e) => e.section).sort();

// -- schema validation (AC1) -------------------------------------------------
describe("validateTicketBody: mandatory sections present", () => {
  test("a complete body with a Depends-on line passes", () => {
    const r = validateTicketBody(read("good.md"));
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("a complete body with NO Depends-on line still passes", () => {
    const r = validateTicketBody(read("good-no-depends.md"));
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

describe("validateTicketBody: catches each failure and names the section", () => {
  test("missing Acceptance Criteria -> one 'missing' error naming it", () => {
    const r = validateTicketBody(read("missing-ac.md"));
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ section: "Acceptance Criteria", code: "missing" });
  });

  test("Plan heading with no body before its subsection -> 'empty' Plan", () => {
    const r = validateTicketBody(read("empty-plan.md"));
    expect(r.ok).toBe(false);
    const plan = r.errors.find((e) => e.section === "Plan");
    expect(plan?.code).toBe("empty");
  });

  test("Context at the wrong heading level -> 'malformed' Context", () => {
    const r = validateTicketBody(read("wrong-level-context.md"));
    expect(r.ok).toBe(false);
    const ctx = r.errors.find((e) => e.section === "Context");
    expect(ctx).toMatchObject({ code: "malformed" });
    expect(ctx?.message).toMatch(/level 2/);
  });

  test("a Depends-on line naming no issue -> 'malformed' Depends on", () => {
    const r = validateTicketBody(read("bad-depends.md"));
    expect(r.ok).toBe(false);
    const dep = r.errors.find((e) => e.section === "Depends on");
    expect(dep).toMatchObject({ code: "malformed" });
  });

  test("reports every gap in one pass, not just the first", () => {
    const r = validateTicketBody("## Context\n\nonly this section exists.\n");
    // Missing: Plan, Acceptance Criteria, Tests + evals, Docs pages touched, Out of scope
    expect(sections(r.errors)).toEqual([
      "Acceptance Criteria",
      "Docs pages touched",
      "Out of scope",
      "Plan",
      "Tests + evals",
    ]);
    expect(r.errors.every((e) => e.code === "missing")).toBe(true);
  });

  test("an empty document fails every mandatory section", () => {
    const r = validateTicketBody("");
    expect(r.errors).toHaveLength(6);
    expect(r.errors.every((e) => e.code === "missing")).toBe(true);
  });
});

describe("validateTicketBody: fence-awareness (a '#' inside a code fence is not a heading)", () => {
  const withFence = [
    "## Context",
    "grounded.",
    "## Plan",
    "```bash",
    "# this shell comment is the ONLY content of Plan",
    "z-board list --status Ready",
    "```",
    "### Acceptance Criteria",
    "- Setup: x -> Action: y -> Expected: z.",
    "## Tests + evals",
    "a gate test.",
    "## Docs pages touched",
    "none.",
    "## Out of scope",
    "everything else.",
    "",
  ].join("\n");

  test("Plan whose only content is a fenced block (with a #-line) is NOT empty", () => {
    expect(validateTicketBody(withFence).ok).toBe(true);
  });

  test("the SAME #-line unfenced IS read as a heading, emptying Plan (proves it matters)", () => {
    const unfenced = withFence.replace(/```bash\n/, "").replace(/```\n/, "");
    const r = validateTicketBody(unfenced);
    const plan = r.errors.find((e) => e.section === "Plan");
    expect(plan?.code).toBe("empty");
  });
});

// -- slugify (SKILL.md Step 9 idempotent re-plan matching) --------------------
describe("slugifyTitle", () => {
  test.each([
    ["C5: /z-plan, spec to milestones + tickets", "c5-z-plan-spec-to-milestones-tickets"],
    ["  Leading and trailing  ", "leading-and-trailing"],
    ["Weird---multiple___separators!!!", "weird-multiple-separators"],
    ["Café Ünïcode Tëst", "cafe-unicode-test"],
    ["ALLCAPS", "allcaps"],
  ])("%s -> %s", (title, slug) => {
    expect(slugifyTitle(title)).toBe(slug);
  });

  test("is idempotent: slug(slug(x)) === slug(x)", () => {
    for (const t of ["C5: /z-plan!", "a - b - c", "Ünïcode", "###", "  ", "one"]) {
      const once = slugifyTitle(t);
      expect(slugifyTitle(once)).toBe(once);
    }
  });

  test("punctuation-only or empty input slugs to the empty string", () => {
    expect(slugifyTitle("!!!")).toBe("");
    expect(slugifyTitle("")).toBe("");
  });
});

// -- 400K chunking gate (issue #7 AC4) ---------------------------------------
describe("needsSplit: the oversize-ticket gate is a deterministic comparison", () => {
  test("a small ticket fits in one window", () => {
    expect(needsSplit(3, 6).split).toBe(false);
    // Each cap in isolation is a boundary: at the cap, not over.
    expect(needsSplit(SPLIT_MAX_FILES, 2).split).toBe(false);
    expect(needsSplit(2, SPLIT_MAX_STEPS).split).toBe(false);
  });

  test("too many files alone forces a split", () => {
    const d = needsSplit(SPLIT_MAX_FILES + 1, 2);
    expect(d.split).toBe(true);
    expect(d.reason).toMatch(/files/);
  });

  test("too many steps alone forces a split", () => {
    const d = needsSplit(2, SPLIT_MAX_STEPS + 1);
    expect(d.split).toBe(true);
    expect(d.reason).toMatch(/steps/);
  });

  test("broad-and-deep (under each cap but both high) forces a split", () => {
    expect(needsSplit(9, 21).split).toBe(true);
    expect(needsSplit(8, 21).split).toBe(false); // 8 files is not > 8
  });

  test("same inputs -> same decision (deterministic)", () => {
    expect(needsSplit(20, 40)).toEqual(needsSplit(20, 40));
  });
});

// -- shouldSplitForCost: the cost-based split gate (issue #78) --------------
describe("shouldSplitForCost: splits only when children total strictly less than parent", () => {
  test("split-true: two cheaper children beat one opus-high ticket (AC2)", () => {
    // 0.23 + 1.64 = 1.87 < 4.36
    const d = shouldSplitForCost("opus-high", ["haiku-low", "sonnet-medium"]);
    expect(d.split).toBe(true);
    expect(d.reason).toContain("1.87");
    expect(d.reason).toContain("4.36");
  });

  test("split-false: two same-tier children cost more than one, no split (AC2)", () => {
    // 1.64 + 1.64 = 3.28 >= 1.64
    const d = shouldSplitForCost("sonnet-medium", ["sonnet-medium", "sonnet-medium"]);
    expect(d.split).toBe(false);
    expect(d.reason).toContain("3.28");
    expect(d.reason).toContain("1.64");
  });

  test("a tie (children total == parent) does not split -- strictly below only", () => {
    const d = shouldSplitForCost("opus-high", ["opus-high"]);
    expect(d.split).toBe(false);
  });

  test("unknown-tier error: an unrecognized parent tier throws, naming it", () => {
    expect(() => shouldSplitForCost("bogus-tier", ["haiku-low"])).toThrow(/bogus-tier/);
  });

  test("unknown-tier error: an unrecognized child tier throws, naming it", () => {
    expect(() => shouldSplitForCost("opus-high", ["haiku-low", "bogus-tier"])).toThrow(/bogus-tier/);
  });

  test("an empty child list is rejected -- a split needs at least one child", () => {
    expect(() => shouldSplitForCost("opus-high", [])).toThrow(/non-empty/);
  });

  test("same inputs -> same decision (deterministic)", () => {
    expect(shouldSplitForCost("opus-xhigh", ["opus-high", "sonnet-medium"])).toEqual(
      shouldSplitForCost("opus-xhigh", ["opus-high", "sonnet-medium"])
    );
  });

  test("TIER_ESTIMATES matches the tier -> z-estimate reproducibility chain (no silent drift)", () => {
    const tiers = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "z-plan", "tiers.json"), "utf8")
    ).tiers as Record<string, Buckets>;
    const rates = loadRates();
    const NOW = new Date("2026-07-19T00:00:00Z");
    for (const [name, dollars] of Object.entries(TIER_ESTIMATES)) {
      expect(estimate(tiers[name], rates, NOW).total).toBe(dollars);
    }
  });
});

// -- z-ticket-lint CLI exit codes --------------------------------------------
describe("z-ticket-lint CLI (main)", () => {
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

  test("a valid body exits 0", () => {
    expect(main([join(TICKETS, "good.md")])).toBe(0);
  });

  test("an invalid body exits 1 and prints errors to stderr", () => {
    expect(main([join(TICKETS, "missing-ac.md")])).toBe(1);
    expect(errs).toHaveBeenCalled();
  });

  test("no argument exits 1 (usage)", () => {
    expect(main([])).toBe(1);
  });

  test("--help exits 0", () => {
    expect(main(["--help"])).toBe(0);
  });

  test("an unreadable path exits 1", () => {
    expect(main([join(TICKETS, "does-not-exist.md")])).toBe(1);
    expect(errs).toHaveBeenCalled();
  });
});

// -- Estimate determinism chain (AC2): tier -> z-estimate --------------------
describe("tier -> z-estimate is reproducible (issue #7 AC2)", () => {
  const tiers = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "z-plan", "tiers.json"), "utf8")
  ).tiers as Record<string, Buckets>;
  const rates = loadRates();
  const NOW = new Date("2026-07-19T00:00:00Z");

  // These totals are the ones documented in z-plan/SKILL.md Step 6. If a rate in
  // references/rates.json or a bucket in z-plan/tiers.json changes, this pins the
  // drift here instead of letting the skill's table quietly go stale.
  const EXPECTED: Record<string, number> = {
    "haiku-low": 0.23,
    "sonnet-medium": 1.64,
    "opus-high": 4.36,
    "opus-xhigh": 7.15,
    "fable-xhigh": 19.5,
  };

  test("every documented tier exists in tiers.json", () => {
    expect(Object.keys(tiers).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [name, total] of Object.entries(EXPECTED)) {
    test(`${name} totals $${total} and is identical across two runs`, () => {
      const first = estimate(tiers[name], rates, NOW);
      const second = estimate(tiers[name], rates, NOW);
      expect(first).toEqual(second);
      expect(first.total).toBe(total);
    });
  }
});

// -- Step 10 Backlog scan contract (issue #13) -------------------------------
// The SKILL is executed by an agent, not this test suite, so these are doc
// canaries: they pin the exact contract strings in z-plan/SKILL.md that make
// AC1-AC4 true, and fail loudly if a future edit silently drops Step 10, the
// `--backlog` flag, or the "stays in Backlog" rule instead of raising it as a
// spec question (CLAUDE.md: weakening a planned AC is never a silent edit).
describe("z-plan/SKILL.md: Step 10 Backlog scan contract (issue #13)", () => {
  const zPlan = () => readFileSync(join(import.meta.dir, "..", "z-plan", "SKILL.md"), "utf8");

  // Returns the body of a "## <heading>" section up to the next "## " heading
  // (mirrors tests/loop-skill-fixes.test.ts's section() helper).
  function section(md: string, heading: string): string {
    const start = md.indexOf(heading);
    if (start < 0) return "";
    const rest = md.slice(start + heading.length);
    const next = rest.indexOf("\n## ");
    return next < 0 ? rest : rest.slice(0, next);
  }

  test("Step 10 exists, after Step 9, before Dry-run/eval mode", () => {
    const md = zPlan();
    const step9 = md.indexOf("## Step 9");
    const step10 = md.indexOf("## Step 10 — Backlog scan");
    const dryRun = md.indexOf("## Dry-run / eval mode");
    expect(step9).toBeGreaterThan(-1);
    expect(step10).toBeGreaterThan(step9);
    expect(dryRun).toBeGreaterThan(step10);
  });

  test("--backlog is parsed as its own flag and bypasses spec resolution (AC4)", () => {
    const step1 = section(zPlan(), "## Step 1 —");
    expect(step1).toContain("--backlog");
    expect(step1).toContain("BACKLOG_ONLY=1");
    expect(step1).toContain("skip straight to Step 10");
    expect(step1).toContain('no "No spec file found" failure');
  });

  test("a normal spec run runs the scan too, as its final step", () => {
    expect(zPlan()).toContain("Backlog scan runs as the final step of every normal spec run");
  });

  test("Step 10 lists Backlog, gates every ticket through z-ticket-lint, and fields it", () => {
    const step10 = section(zPlan(), "## Step 10 — Backlog scan");
    expect(step10).not.toBe("");
    expect(step10).toContain('"$Z_BOARD" list --status Backlog --json');
    expect(step10).toContain('"$Z_LINT" "$TMP/body-<N>.md"');
    expect(step10).toContain("lib/ticket-schema.ts:97-144");
    expect(step10).toContain('"$Z_BOARD" field-get <N> <Field>');
  });

  test("Step 10 never promotes to Ready; Step 7.4's pull remains the only path to Ready", () => {
    const step10 = section(zPlan(), "## Step 10 — Backlog scan");
    expect(step10).toContain("Step 10 never calls");
    expect(step10).toContain('"$Z_BOARD" move <N> Ready');
    expect(step10).toMatch(/Step 7\.4's\s+dependency pull/); // tolerant of source line-wrap
    // Ready never appears as a `z-board move` target anywhere in Step 10.
    expect(step10).not.toMatch(/"\$Z_BOARD" move <N> Ready --slug/);
    // The claim is scoped to Ready specifically -- Step 10 also moves tickets
    // to Questions (item 3's ambiguity path) and must say so is a *different*,
    // allowed movement, not a second Ready exception (this is the reworded
    // contract; a version that still claims Step 7.4 is the only ticket
    // movement anywhere in the skill is the bug this test guards against).
    expect(step10).toMatch(/different, allowed movement/);
    expect(step10).not.toMatch(/only ticket-movement exception anywhere in this skill/);
  });

  test("Step 10 idempotent re-run: a passing, fully-fielded ticket gets zero writes", () => {
    const step10 = section(zPlan(), "## Step 10 — Backlog scan");
    expect(step10).toMatch(/zero body edits, zero\s*\n?\s*field writes, and zero comments/);
  });

  test("--dry-run --backlog mirrors the existing dry-run contract with no board writes", () => {
    const dryRun = section(zPlan(), "## Dry-run / eval mode");
    expect(dryRun).toContain("--dry-run --backlog");
    expect(dryRun).toMatch(/No board writes,\s+no GitHub writes/); // tolerant of source line-wrap
  });

  test("Done criteria names the Step 10 gate, scoped to tickets still in Backlog", () => {
    const done = section(zPlan(), "## Done criteria");
    // The lint-pass claim must carve out item 3's ambiguity path (a ticket
    // moved to Questions never gets a drafted body, so it can't be linted) --
    // a version that claims literally "every ticket in Backlog at scan time"
    // passes lint is the bug this test guards against.
    expect(done).toMatch(/still in Backlog after the scan/);
    expect(done).toMatch(/not moved to Questions/);
    expect(done).toMatch(/passes `z-ticket-lint`/);
    expect(done).not.toMatch(/Every ticket in Backlog at scan time passes `z-ticket-lint`/);
    // The Ready-promotion claim must be scoped to Ready, not asserted as the
    // only ticket movement anywhere in the skill (Questions is another).
    expect(done).toMatch(/never promotes a ticket to Ready/);
    expect(done).toMatch(/Step 7\.4's\s+dependency pull/);
    expect(done).not.toMatch(/only ticket-movement exception anywhere in this skill/);
  });
});

// -- Step 1 multi-document input contract (issue #16) ------------------------
// /z-plan used to resolve exactly one spec file (the newest ceo-plans/ entry),
// missing scope recorded in gstack's other planning artifacts -- and failing
// outright ("No spec file found") on a project with a specs/ archive but no
// ceo-plans/ dir at all. These are doc canaries on z-plan/SKILL.md's Step 1
// (the skill is executed by an agent, not this suite) pinning the contract
// strings that make AC1-AC3 true: an explicit path still wins unchanged
// (AC2), the no-arg case discovers and reads EVERY document via
// lib/spec-sources.ts rather than defaulting to one file, and an empty result
// fails loud naming every searched directory instead of the old dead end
// (AC3) -- never a silent regression to single-file behavior.
describe("z-plan/SKILL.md: Step 1 multi-document input contract (issue #16)", () => {
  const zPlan = () => readFileSync(join(import.meta.dir, "..", "z-plan", "SKILL.md"), "utf8");

  function section(md: string, heading: string): string {
    const start = md.indexOf(heading);
    if (start < 0) return "";
    const rest = md.slice(start + heading.length);
    const next = rest.indexOf("\n## ");
    return next < 0 ? rest : rest.slice(0, next);
  }

  test("an explicit path argument still wins unchanged, with no discovery run (AC2)", () => {
    const step1 = section(zPlan(), "## Step 1 —");
    expect(step1).toContain("An explicit path argument wins unchanged");
    expect(step1).toContain("no discovery run");
  });

  test("no argument runs lib/spec-sources.ts over every gstack planning-document kind", () => {
    const step1 = section(zPlan(), "## Step 1 —");
    expect(step1).toContain('bun "$PACK/lib/spec-sources.ts"');
    expect(step1).toContain("$HOME/.gstack/projects/$SLUG");
    // All four discovered kinds named explicitly -- a version that silently
    // drops one back to single-file behavior is the regression this guards.
    expect(step1).toContain("specs/*.md");
    expect(step1).toContain("ceo-plans/*.md");
    expect(step1).toContain("*-test-plan-*.md");
    expect(step1).toContain("checkpoints/*.md");
  });

  test("every returned document must be read; the primary spec is the newest specs/ceo-plans entry, not just list[0] (AC1)", () => {
    const step1 = section(zPlan(), "## Step 1 —");
    expect(step1).toMatch(/read every file it names/i);
    expect(step1).toMatch(/newest entry whose\s+`kind` is `specs` or `ceo-plans`/);
    // Guards the exact bug a naive port would reintroduce: `specs` entries
    // sort before `ceo-plans` entries in the array regardless of mtime, so
    // "primary = the first element" is wrong when ceo-plans is newer.
    expect(step1).toMatch(/do not simply take the array's first element/);
    expect(step1).toContain("mandatory grounding context");
    expect(step1).toMatch(/scope named ONLY in one of these other documents/);
    expect(step1).toMatch(/\(AC1\)/);
  });

  test("an empty discovery result fails loud naming every searched directory, no board writes (AC3)", () => {
    const step1 = section(zPlan(), "## Step 1 —");
    expect(step1).toMatch(/no "No spec file found" dead end/);
    expect(step1).toMatch(/already naming every directory it\s*\n?\s*searched/);
    expect(step1).toMatch(/No board writes happen on\s*\n?\s*this path/);
  });

  // Reviewer finding 2 (issue #16 rework): a non-empty discovery result with
  // zero specs/ceo-plans entries (only test-plan/checkpoints found) left
  // "primary spec" undefined -- discoverSpecSources only threw on a TOTAL
  // empty result, but the primary-spec rule above draws from specs/ceo-plans
  // only. Decided contract (conservative-deterministic, do not re-litigate):
  // this doc canary pins the never-auto-plan-from-non-spec-kinds sentence so
  // a future edit that quietly falls back to a test-plan/checkpoint as the
  // primary spec fails loudly here instead of shipping silently.
  test("a second, distinct failure covers zero specs/ceo-plans found (only test-plan/checkpoints): never auto-plan from those kinds (finding 2)", () => {
    const step1 = section(zPlan(), "## Step 1 —");
    expect(step1).toMatch(/second, distinct failure/i);
    // (a) names what was found.
    expect(step1).toMatch(/names every kind and\s*\n?\s*path it did find/);
    // (b) states no specs/ceo-plans primary candidate exists.
    expect(step1).toMatch(/no specs\/ceo-plans primary-spec\s*\n?\s*candidate exists/);
    // (c) echoes the CLI error and stops -- no board writes, ever.
    expect(step1).toMatch(/Echo that message and `exit 1`/);
    expect(step1).toMatch(/do NOT auto-plan from\s*\n?\s*checkpoints or test plans alone/);
    expect(step1).toMatch(/Stop with no board writes on\s*\n?\s*this path either/);
  });
});

// -- Step 1 multiple explicit path arguments (issue #19) ---------------------
// #16 covers the no-argument case only; `/z-plan a.md b.md c.md` was
// previously undefined -- Step 1's flag-parsing loop assigned every non-flag
// argument to a single SPEC variable, so only the LAST path survived and the
// rest were silently dropped. These are doc canaries on z-plan/SKILL.md's
// Step 1 (the skill is executed by an agent, not this suite) pinning the
// contract strings that make AC1-AC3 true: one explicit path is unchanged
// (AC2), the first of several is the primary spec and every other is
// mandatory grounding context, nothing named is silently dropped (AC1), and a
// missing named file fails loud naming it with no partial planning (AC3).
describe("z-plan/SKILL.md: Step 1 multiple explicit path arguments (issue #19)", () => {
  const zPlan = () => readFileSync(join(import.meta.dir, "..", "z-plan", "SKILL.md"), "utf8");

  function section(md: string, heading: string): string {
    const start = md.indexOf(heading);
    if (start < 0) return "";
    const rest = md.slice(start + heading.length);
    const next = rest.indexOf("\n## ");
    return next < 0 ? rest : rest.slice(0, next);
  }

  test("a single explicit path argument is unchanged from before this ticket (AC2)", () => {
    const step1 = section(zPlan(), "## Step 1 —");
    // Same literal contract sentence #16 already pinned -- this ticket must
    // not weaken it while adding multi-path support.
    expect(step1).toContain("An explicit path argument wins unchanged");
    expect(step1).toContain("no discovery run");
    expect(step1).toContain("Identical to the behavior before this ticket (issue #19)");
  });

  test("more than one explicit path: the FIRST is primary, every other is mandatory grounding (AC1)", () => {
    const step1 = section(zPlan(), "## Step 1 —");
    expect(step1).toContain("More than one explicit path argument is also supported");
    expect(step1).toMatch(/`\$\{SPECS\[0\]\}`\s*—\s*the FIRST path\s*—\s*is the\s*\n?\s*\*\*primary spec\*\*/);
    expect(step1).toMatch(/Every subsequent path is \*\*mandatory grounding\s*\n?\s*context\*\*/);
    expect(step1).toMatch(/scope named ONLY in one of\s*\n?\s*these other files still belongs in the plan/);
    expect(step1).toMatch(/nothing (named on the command\s*\n?\s*line is optional background reading, and )?nothing is silently dropped/);
    // Guards the exact regression this ticket fixes: a naive port that still
    // overwrites a single SPEC variable per argument.
    expect(step1).toMatch(/only the LAST path survived and the rest were\s*\n?\s*silently dropped/);
    // Explicit paths (one or many) never fall through to spec-sources discovery.
    expect(step1).toMatch(/still bypass `lib\/spec-sources\.ts` discovery entirely/);
  });

  test("every named path must exist before any is read; a missing one fails loud, naming it, with no partial plan (AC3)", () => {
    const step1 = section(zPlan(), "## Step 1 —");
    expect(step1).toContain('Every named path must exist before any of them is read');
    expect(step1).toContain('[ -f "$p" ]');
    expect(step1).toMatch(/A missing file fails loud, naming exactly which path does not\s*\n?\s*exist/);
    expect(step1).toMatch(/exits 1 with no board writes/);
    expect(step1).toMatch(/does NOT fall back to planning from the\s*\n?\s*paths that do exist/);
    // The concrete AC3 example: a.md + missing.md never plans from a.md alone.
    expect(step1).toContain("/z-plan a.md missing.md` never plans from `a.md` alone");
  });

  test("Step 1 collects arguments into an ordered SPECS list, not a single overwritten SPEC variable", () => {
    const step1 = section(zPlan(), "## Step 1 —");
    expect(step1).toContain("SPECS=()");
    expect(step1).toContain('SPECS+=("$arg")');
    expect(step1).not.toContain('SPEC="$arg"');
  });
});

// -- --ticket flag + Step 10 cost-split gate (issue #78) ---------------------
// The SKILL is executed by an agent, not this test suite (same rationale as
// the Step 10/Step 1 doc canaries above): these pin the exact contract
// strings in z-plan/SKILL.md that make AC1/AC3/AC4 true, so a future edit
// that silently drops --ticket's scoping or the split-gate evaluation fails
// loudly here instead of shipping.
describe("z-plan/SKILL.md: --ticket flag scopes Step 10 to one issue (issue #78)", () => {
  const zPlan = () => readFileSync(join(import.meta.dir, "..", "z-plan", "SKILL.md"), "utf8");

  function section(md: string, heading: string): string {
    const start = md.indexOf(heading);
    if (start < 0) return "";
    const rest = md.slice(start + heading.length);
    const next = rest.indexOf("\n## ");
    return next < 0 ? rest : rest.slice(0, next);
  }

  test("Step 1 parses --ticket as a value-taking flag alongside --backlog", () => {
    const step1 = section(zPlan(), "## Step 1 —");
    expect(step1).toContain("TICKET_ONLY");
    expect(step1).toContain("--ticket) WANT_TICKET=1");
    expect(step1).toContain("--ticket requires a value");
    // The existing --backlog/SPECS contract (prior doc canaries) must survive
    // unweakened alongside the new flag.
    expect(step1).toContain("BACKLOG_ONLY=1");
    expect(step1).toContain("SPECS=()");
  });

  test("--ticket <N> implies --backlog's spec-resolution bypass, scoped to N (AC1)", () => {
    const step1 = section(zPlan(), "## Step 1 —");
    expect(step1).toContain("single-ticket form of `--backlog`'s");
    expect(step1).toContain("skip straight to Step 10");
    expect(step1).toMatch(/scopes Step 10's loop to\s*\n?\s*exactly ticket `N`/);
    expect(step1).toContain("`--backlog` with no `--ticket` still scans the whole Backlog list");
  });

  test("--ticket <N> errors loud on an unknown number or a Done ticket, no board writes (AC1)", () => {
    const step1 = section(zPlan(), "## Step 1 —");
    expect(step1).toMatch(/no ticket #N found on the board/);
    expect(step1).toMatch(/ticket #N is\s*\nDone; nothing to plan/);
    expect(step1).toContain("Step 10 never re-plans a Done ticket");
  });

  test("Step 10's list step branches on TICKET_ONLY without dropping the --backlog list call", () => {
    const step10 = section(zPlan(), "## Step 10 — Backlog scan");
    expect(step10).toContain('if [ -n "$TICKET_ONLY" ]');
    // Prior doc canary's pinned string must still be reachable in the else branch.
    expect(step10).toContain('"$Z_BOARD" list --status Backlog --json');
  });
});

describe("z-plan/SKILL.md: Step 10 evaluates BOTH split gates before filing a drafted body (issue #78)", () => {
  const zPlan = () => readFileSync(join(import.meta.dir, "..", "z-plan", "SKILL.md"), "utf8");

  function section(md: string, heading: string): string {
    const start = md.indexOf(heading);
    if (start < 0) return "";
    const rest = md.slice(start + heading.length);
    const next = rest.indexOf("\n## ");
    return next < 0 ? rest : rest.slice(0, next);
  }

  test("item 3's otherwise-branch calls needsSplit AND shouldSplitForCost before filing (AC3)", () => {
    const step10 = section(zPlan(), "## Step 10 — Backlog scan");
    expect(step10).toContain("needsSplit(F, S)");
    expect(step10).toContain("shouldSplitForCost(parentTier, childTiers)");
    expect(step10).toContain("lib/ticket-schema.ts");
  });

  test("a tripped gate files children to schema+fields, links both ways, and marks the parent (AC3)", () => {
    const step10 = section(zPlan(), "## Step 10 — Backlog scan");
    expect(step10).toMatch(/File each child to the Step 4\s*\n?\s*schema/);
    expect(step10).toContain("Link parent<->child both directions (Step 7)");
    expect(step10).toContain("## Subtasks (in order)");
    expect(step10).toMatch(/comment on the parent that\s*\n?\s*it should be closed by a human once every child lands/);
  });

  test("a split never closes, moves, or promotes the parent or any child (Out of scope: no auto-close)", () => {
    const step10 = section(zPlan(), "## Step 10 — Backlog scan");
    expect(step10).toMatch(/Never call a\s*\n?\s*close on the parent, never move it/);
    expect(step10).toMatch(/never promote the parent or\s*\n?\s*any child to Ready/);
  });

  test("a split parent carries no Estimate of its own -- item 4 fields only the children", () => {
    const step10 = section(zPlan(), "## Step 10 — Backlog scan");
    expect(step10).toMatch(/carries no Estimate of its\s*\n?\s*own beyond the sum its children report/);
  });

  test("--dry-run --ticket composes identically to --dry-run --backlog, scoped to N", () => {
    const dryRun = section(zPlan(), "## Dry-run / eval mode");
    expect(dryRun).toContain("--dry-run --ticket <N>");
    expect(dryRun).toMatch(/composes the same way/);
  });

  test("Done criteria names the split-parent contract (Subtasks list, links, stays open, un-promoted)", () => {
    const done = section(zPlan(), "## Done criteria");
    expect(done).toMatch(/split on either gate/);
    expect(done).toContain("## Subtasks (in order)");
    expect(done).toMatch(/never\s*\n?\s*auto-closed, never moved to Ready/);
  });
});
