// Gate tests for issue #64's cost-saving helper (lib/cost-suggest.ts):
// costSuggestions/loadPlannedTickets/main (cases 1-10) plus SKILL.md doc
// canaries (cases 11-12) pinning z-plan/SKILL.md's new Step 11 -- the SKILL
// is run by an agent, not this suite, so these pin the exact contract text
// the way tests/plan-schema.test.ts already does for Step 10.
import { test, expect, describe, spyOn, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costSuggestions, loadPlannedTickets, main, type PlannedTicket } from "../lib/cost-suggest.ts";
import { ZError } from "../lib/config.ts";

const FIXTURE_PATH = join(import.meta.dir, "..", "evals", "cost-suggest", "fixture-batch.json");
const FIXTURE: PlannedTicket[] = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

// -- cases 1-4: the 5-ticket fixture (#101/#102 haiku-low $1.86 each, #103
// sonnet-medium $10.27 on lib/config.ts, #104 opus-xhigh $15.77 on
// lib/config.ts+lib/loop.ts, #105 fable-xhigh $45.22 on lib/config.ts) -----
describe("costSuggestions: the 5-ticket fixture", () => {
  test("case 1: totalEstimate sums every estimate, rounded once", () => {
    // 1.86 + 1.86 + 10.27 + 15.77 + 45.22 = 74.98
    expect(costSuggestions(FIXTURE).totalEstimate).toBe(74.98);
  });

  test("case 2: byTier groups by model-modelEffort, sorted subtotal desc", () => {
    const byTier = costSuggestions(FIXTURE).byTier;
    expect(byTier).toEqual([
      { tier: "fable-xhigh", model: "fable", modelEffort: "xhigh", tickets: [105], subtotal: 45.22 },
      { tier: "opus-xhigh", model: "opus", modelEffort: "xhigh", tickets: [104], subtotal: 15.77 },
      { tier: "sonnet-medium", model: "sonnet", modelEffort: "medium", tickets: [103], subtotal: 10.27 },
      { tier: "haiku-low", model: "haiku", modelEffort: "low", tickets: [101, 102], subtotal: 3.72 },
    ]);
  });

  test("case 3: sharedFileClusters has exactly one cluster, lib/loop.ts absent", () => {
    const clusters = costSuggestions(FIXTURE).sharedFileClusters;
    expect(clusters).toEqual([{ file: "lib/config.ts", tickets: [103, 104, 105] }]);
    expect(clusters.find((c) => c.file === "lib/loop.ts")).toBeUndefined();
  });

  test("case 4: topCostTicket is the highest estimate", () => {
    expect(costSuggestions(FIXTURE).topCostTicket).toEqual({
      number: 105,
      title: "Redesign the config subsystem end to end",
      estimate: 45.22,
    });
  });
});

describe("costSuggestions: topCostTicket tie-break", () => {
  test("case 5: a tie at the top estimate is broken by the lower ticket number", () => {
    const tied: PlannedTicket[] = [
      { number: 201, title: "A", model: "sonnet", modelEffort: "medium", estimate: 1.64, files: [] },
      { number: 202, title: "B", model: "sonnet", modelEffort: "medium", estimate: 1.64, files: [] },
    ];
    expect(costSuggestions(tied).topCostTicket?.number).toBe(201);
  });
});

describe("costSuggestions: suggestions (case 6)", () => {
  test("fixed order -- high-cost-ticket, shared-file-cluster, low-tier-batch", () => {
    const suggestions = costSuggestions(FIXTURE).suggestions;
    expect(suggestions).toEqual([
      {
        kind: "high-cost-ticket",
        tickets: [105],
        fact: '#105 ("Redesign the config subsystem end to end") is fable-xhigh ($45.22).',
      },
      {
        kind: "shared-file-cluster",
        tickets: [103, 104, 105],
        fact: "lib/config.ts is touched by 3 tickets: #103, #104, #105.",
      },
      {
        kind: "low-tier-batch",
        tickets: [101, 102],
        fact: "2 tickets are haiku-low mechanical work: #101, #102.",
      },
    ]);
  });
});

describe("costSuggestions: edges (cases 7-8)", () => {
  test("case 7: empty input returns the documented zero-value shape", () => {
    expect(costSuggestions([])).toEqual({
      totalEstimate: 0,
      byTier: [],
      sharedFileClusters: [],
      topCostTicket: null,
      suggestions: [],
    });
  });

  test("case 8: a single ticket with no shared files yields no suggestions", () => {
    const solo: PlannedTicket[] = [
      { number: 301, title: "Solo ticket", model: "sonnet", modelEffort: "medium", estimate: 1.0, files: ["lib/solo.ts"] },
    ];
    expect(costSuggestions(solo).suggestions).toEqual([]);
  });
});

// -- CLI round trip + trust-boundary validation (cases 9-10) -----------------
describe("main(): CLI round trip and error handling", () => {
  const dirs: string[] = [];
  let logs: ReturnType<typeof spyOn>;
  let errs: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logs = spyOn(console, "log").mockImplementation(() => {});
    errs = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logs.mockRestore();
    errs.mockRestore();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function batchFile(contents: unknown): string {
    const d = mkdtempSync(join(tmpdir(), "zstack-cost-suggest-"));
    dirs.push(d);
    const p = join(d, "planned-batch.json");
    writeFileSync(p, JSON.stringify(contents));
    return p;
  }

  test("case 9: stdout round-trips the identical CostBreakdown costSuggestions() returns", () => {
    const path = batchFile(FIXTURE);
    expect(main([path])).toBe(0);
    expect(logs).toHaveBeenCalledWith(JSON.stringify(costSuggestions(FIXTURE)));
  });

  test("case 10: a ticket entry missing estimate exits 1 naming the number and field", () => {
    const broken = FIXTURE.map((t) => (t.number === 103 ? { ...t, estimate: undefined } : t));
    // JSON.stringify drops an `undefined` value entirely, exactly like a
    // hand-written batch file that never had the field -- exercising the
    // real missing-key path, not a JS-only undefined.
    const path = batchFile(JSON.parse(JSON.stringify(broken)));
    expect(main([path])).toBe(1);
    expect(errs).toHaveBeenCalled();
    const message = (errs.mock.calls[0] ?? [])[0] as string;
    expect(message).toMatch(/#103/);
    expect(message).toMatch(/"estimate"/);
  });

  test("no argument exits 1 (usage)", () => {
    expect(main([])).toBe(1);
  });

  test("--help exits 0", () => {
    expect(main(["--help"])).toBe(0);
  });

  test("an unreadable path exits 1", () => {
    expect(main([join(tmpdir(), "zstack-cost-suggest-does-not-exist.json")])).toBe(1);
    expect(errs).toHaveBeenCalled();
  });
});

describe("loadPlannedTickets: trust-boundary type validation", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  function batchFile(contents: unknown): string {
    const d = mkdtempSync(join(tmpdir(), "zstack-cost-suggest-load-"));
    dirs.push(d);
    const p = join(d, "planned-batch.json");
    writeFileSync(p, JSON.stringify(contents));
    return p;
  }

  test("well-typed batch loads and matches the raw fixture", () => {
    expect(loadPlannedTickets(batchFile(FIXTURE))).toEqual(FIXTURE);
  });

  test("a non-array top level is rejected", () => {
    expect(() => loadPlannedTickets(batchFile({ not: "an array" }))).toThrow(ZError);
  });

  test("a non-numeric number is a ZError naming the index (no ticket number to name yet)", () => {
    const bad = [{ ...FIXTURE[0], number: "101" }];
    expect(() => loadPlannedTickets(batchFile(bad))).toThrow(/index 0.*"number"/s);
  });

  test.each(["title", "model", "modelEffort"])("an empty %s string is rejected", (key) => {
    const bad = [{ ...FIXTURE[0], [key]: "" }];
    expect(() => loadPlannedTickets(batchFile(bad))).toThrow(
      new RegExp(`#${FIXTURE[0].number}.*"${key}" must be a non-empty string`, "s")
    );
  });

  test("a negative estimate is rejected before any arithmetic runs", () => {
    const bad = [{ ...FIXTURE[0], estimate: -1 }];
    expect(() => loadPlannedTickets(batchFile(bad))).toThrow(/"estimate" must be a non-negative finite number/);
  });

  test("a non-array files field is rejected", () => {
    const bad = [{ ...FIXTURE[0], files: "lib/config.ts" }];
    expect(() => loadPlannedTickets(batchFile(bad))).toThrow(/"files" must be an array of strings/);
  });

  test("a files array with a non-string element is rejected", () => {
    const bad = [{ ...FIXTURE[0], files: [1] }];
    expect(() => loadPlannedTickets(batchFile(bad))).toThrow(/"files" must be an array of strings/);
  });
});

// -- z-plan/SKILL.md Step 11 doc canaries (cases 11-12) ----------------------
describe("z-plan/SKILL.md: Step 11 Cost-saving suggestions contract (issue #64)", () => {
  const zPlan = () => readFileSync(join(import.meta.dir, "..", "z-plan", "SKILL.md"), "utf8");

  // Returns the body of a "## <heading>" section up to the next "## " heading
  // (mirrors tests/plan-schema.test.ts's section() helper).
  function section(md: string, heading: string): string {
    const start = md.indexOf(heading);
    if (start < 0) return "";
    const rest = md.slice(start + heading.length);
    const next = rest.indexOf("\n## ");
    return next < 0 ? rest : rest.slice(0, next);
  }

  test("case 11: Step 11 exists, after Step 10, before Dry-run/eval mode", () => {
    const md = zPlan();
    const step10 = md.indexOf("## Step 10 — Backlog scan");
    const step11 = md.indexOf("## Step 11 — Cost-saving suggestions");
    const dryRun = md.indexOf("## Dry-run / eval mode");
    expect(step10).toBeGreaterThan(-1);
    expect(step11).toBeGreaterThan(step10);
    expect(dryRun).toBeGreaterThan(step11);
  });

  test("case 12: Step 11 names $Z_COST_SUGGEST, the batch definition, and the empty-batch rule", () => {
    const step11 = section(zPlan(), "## Step 11 — Cost-saving suggestions");
    expect(step11).not.toBe("");

    // Names the CLI it shells to.
    expect(step11).toContain('"$Z_COST_SUGGEST"');

    // States the batch definition: Steps 4-9 tickets plus Step 10's drafted
    // subset, excluding untouched/Questions tickets.
    expect(step11).toMatch(/Steps 4-9 filed or updated/);
    expect(step11).toMatch(/Step 10 drafted a body for/);
    expect(step11).toMatch(/EXCLUDING Step 10's untouched already-fielded tickets/);
    expect(step11).toMatch(/parked to\s+Questions/);

    // States an empty batch prints nothing.
    expect(step11).toMatch(/batch is empty/);
    expect(step11).toMatch(/skips this step and prints nothing/);

    // Advisory-only: never a board write, comment, or notification transport.
    expect(step11).toMatch(/never a board write/);
    expect(step11).toMatch(/never a comment/);
    expect(step11).toMatch(/never routed through any notification transport/);
  });

  test("the preamble resolves Z_COST_SUGGEST beside the existing Z_LINT line", () => {
    const md = zPlan();
    expect(md).toContain('Z_LINT="$PACK/bin/z-ticket-lint"');
    expect(md).toContain('Z_COST_SUGGEST="$PACK/bin/z-cost-suggest"');
  });
});
