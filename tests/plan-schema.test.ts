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
  slugifyTitle,
  validateTicketBody,
  SPLIT_MAX_FILES,
  SPLIT_MAX_STEPS,
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

  test("Step 10 stays in Backlog: no move to Ready, exception named as Step 7.4's pull only", () => {
    const step10 = section(zPlan(), "## Step 10 — Backlog scan");
    expect(step10).toContain("Step 10 never calls");
    expect(step10).toContain('"$Z_BOARD" move <N> Ready');
    expect(step10).toMatch(/Step 7\.4's\s+dependency pull/); // tolerant of source line-wrap
    // The only ticket-movement call anywhere in Step 10 is to Questions (the
    // ambiguity path) -- Ready never appears as a `z-board move` target.
    expect(step10).not.toMatch(/"\$Z_BOARD" move <N> Ready --slug/);
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

  test("Done criteria names the Step 10 gate", () => {
    const done = section(zPlan(), "## Done criteria");
    expect(done).toMatch(/Backlog at scan time passes `z-ticket-lint`/);
  });
});
