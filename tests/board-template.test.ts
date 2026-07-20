// Gate tests for issue #20: the board shape as a shipped, validated template
// (lib/board-template.ts + z-setup/board-template.json). Pure, local, zero
// network. Covers:
//   - the regression pin: the packaged default equals the shape /z-setup used to
//     hardcode (same 9 statuses in order, same 4 fields + options, same colors),
//     so a drift from lib/config.ts canon turns this suite red (AC4)
//   - the loader's refusals: a missing/renamed required field, a status-set
//     mismatch, a duplicate, a bad color/layout, an unreadable/invalid file
//     (AC3, AC4 -- gutting the validator turns these red)
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadBoardTemplate,
  validateBoardTemplate,
  deriveShape,
  DEFAULT_TEMPLATE,
  DEFAULT_SHAPE,
  DEFAULT_TEMPLATE_PATH,
  type BoardTemplate,
} from "../lib/board-template.ts";
import { BOARD_STATUSES, ZError } from "../lib/config.ts";

// A deep clone of the validated default, for mutate-then-revalidate cases.
function cloneDefault(): BoardTemplate {
  return structuredClone(DEFAULT_TEMPLATE);
}

// The GitHub palette the OLD hardcoded path cycled through by option index. The
// default template MUST reproduce it exactly, or the emitted GraphQL is no
// longer byte-identical to what /z-setup created before the shape was
// externalized (the 1:1 mandate).
const COLORS = ["GRAY", "BLUE", "GREEN", "YELLOW", "ORANGE", "RED", "PURPLE", "PINK"];

const tmpFiles: string[] = [];
function writeTemplateFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ztpl-"));
  tmpFiles.push(dir);
  const p = join(dir, "template.json");
  writeFileSync(p, content);
  return p;
}

// -- regression pin: default == the previously hardcoded shape ----------------
describe("regression pin: the packaged default matches the old hardcoded shape", () => {
  test("the shipped file loads and validates", () => {
    // If BOARD_STATUSES (lib/config.ts) ever changes without the template, the
    // status-set-equal guard makes this throw -- the exact "drift from canon"
    // this pin guards (AC4).
    expect(() => loadBoardTemplate()).not.toThrow();
    expect(DEFAULT_TEMPLATE_PATH).toContain(join("z-setup", "board-template.json"));
  });

  test("statuses are the canonical nine, in order", () => {
    expect(DEFAULT_SHAPE.statusOptions).toEqual([...BOARD_STATUSES]);
    expect(DEFAULT_TEMPLATE.statuses.map((s) => s.name)).toEqual([...BOARD_STATUSES]);
  });

  test("the four custom fields match the old shape, in order, with the old options", () => {
    expect(DEFAULT_SHAPE.customFields).toEqual([
      { name: "Model", dataType: "SINGLE_SELECT", options: ["haiku", "sonnet", "opus", "fable"] },
      { name: "Model Effort", dataType: "SINGLE_SELECT", options: ["low", "medium", "high", "xhigh"] },
      { name: "Estimate", dataType: "NUMBER", options: undefined },
      { name: "Actual", dataType: "NUMBER", options: undefined },
    ]);
  });

  test("every status + option color equals the old position-cycled palette (byte-identical emit)", () => {
    DEFAULT_TEMPLATE.statuses.forEach((s, i) => {
      expect(s.color).toBe(COLORS[i % COLORS.length]);
      expect(s.description).toBe(""); // the old path always emitted description: ""
    });
    for (const f of DEFAULT_TEMPLATE.fields) {
      (f.options ?? []).forEach((o, i) => {
        expect(o.color).toBe(COLORS[i % COLORS.length]);
        expect(o.description).toBe("");
      });
    }
  });

  test("deriveShape exposes per-field option meta for the single-select fields", () => {
    expect(DEFAULT_SHAPE.fieldMeta.Model.map((o) => o.name)).toEqual(["haiku", "sonnet", "opus", "fable"]);
    expect(DEFAULT_SHAPE.fieldMeta["Model Effort"].map((o) => o.name)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(DEFAULT_SHAPE.fieldMeta.Estimate).toBeUndefined(); // NUMBER fields carry no options
    expect(DEFAULT_SHAPE.statusMeta.map((o) => o.name)).toEqual([...BOARD_STATUSES]);
  });

  test("the default carries the described views (present, shape-only)", () => {
    expect(DEFAULT_TEMPLATE.views.length).toBeGreaterThan(0);
    expect(DEFAULT_SHAPE.views).toEqual(DEFAULT_TEMPLATE.views);
    for (const v of DEFAULT_TEMPLATE.views) {
      expect(typeof v.name).toBe("string");
      expect(["board", "table", "roadmap"]).toContain(v.layout);
    }
  });
});

// -- required-field refusals (AC3; gutting the validator turns these red) ------
describe("required-field enforcement (loop/z-board hard dependency)", () => {
  test("a template missing Estimate is refused, naming the field AND the loop contract", () => {
    const t = cloneDefault() as any;
    t.fields = t.fields.filter((f: any) => f.name !== "Estimate");
    let caught: unknown;
    try {
      validateBoardTemplate(t);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ZError);
    const msg = (caught as ZError).message;
    expect(msg).toContain("Estimate"); // the field is named
    expect(msg).toMatch(/z-estimate/); // and the dependency that breaks
    expect(msg).toMatch(/drops or renames/);
  });

  test("renaming Model is refused as a missing required field (rename == drop)", () => {
    const t = cloneDefault() as any;
    t.fields.find((f: any) => f.name === "Model").name = "Brain";
    expect(() => validateBoardTemplate(t)).toThrow(/required field "Model"/);
  });

  test("each of the four required fields, dropped, is refused by name", () => {
    for (const name of ["Model", "Model Effort", "Estimate", "Actual"]) {
      const t = cloneDefault() as any;
      t.fields = t.fields.filter((f: any) => f.name !== name);
      expect(() => validateBoardTemplate(t)).toThrow(new RegExp(`required field "${name}"`));
    }
  });

  test("a required field with the wrong dataType is refused, naming the expected type", () => {
    const t = cloneDefault() as any;
    const est = t.fields.find((f: any) => f.name === "Estimate");
    est.dataType = "SINGLE_SELECT";
    est.options = [{ name: "x", color: "GRAY", description: "" }];
    expect(() => validateBoardTemplate(t)).toThrow(/"Estimate" must be dataType NUMBER/);
  });
});

// -- status-set enforcement ---------------------------------------------------
describe("status set must equal lib/config.ts BOARD_STATUSES", () => {
  test("an extra status is refused, naming the unsupported extra", () => {
    const t = cloneDefault() as any;
    t.statuses.push({ name: "Icebox", color: "GRAY", description: "" });
    expect(() => validateBoardTemplate(t)).toThrow(/unsupported extras: Icebox/);
  });

  test("a missing status is refused, naming what is missing", () => {
    const t = cloneDefault() as any;
    t.statuses = t.statuses.filter((s: any) => s.name !== "Review");
    expect(() => validateBoardTemplate(t)).toThrow(/missing: Review/);
  });

  test("a renamed status is refused (missing the canonical + extra the new name)", () => {
    const t = cloneDefault() as any;
    t.statuses.find((s: any) => s.name === "Blocked").name = "Stuck";
    expect(() => validateBoardTemplate(t)).toThrow(/missing: Blocked[\s\S]*unsupported extras: Stuck/);
  });

  test("a duplicate status name is refused", () => {
    const t = cloneDefault() as any;
    t.statuses[1].name = t.statuses[0].name;
    expect(() => validateBoardTemplate(t)).toThrow(/duplicate status/);
  });
});

// -- option / view shape validation -------------------------------------------
describe("option and view shape validation", () => {
  test("a color outside the ProjectV2 enum is refused, naming the path", () => {
    const t = cloneDefault() as any;
    t.statuses[0].color = "TURQUOISE";
    expect(() => validateBoardTemplate(t)).toThrow(/statuses\[0\]\.color.*GRAY, BLUE/);
  });

  test("a same-name-but-recolored status still validates (a legit customization)", () => {
    const t = cloneDefault() as any;
    t.statuses[0].color = "PURPLE";
    t.statuses[0].description = "not yet planned";
    const out = validateBoardTemplate(t);
    expect(out.statuses[0].color).toBe("PURPLE");
    expect(out.statuses[0].description).toBe("not yet planned");
  });

  test("an option description defaults to empty string when omitted", () => {
    const t = cloneDefault() as any;
    delete t.statuses[0].description;
    expect(validateBoardTemplate(t).statuses[0].description).toBe("");
  });

  test("a view without a name is refused", () => {
    const t = cloneDefault() as any;
    t.views.push({ layout: "board" });
    expect(() => validateBoardTemplate(t)).toThrow(/views\[\d+\]\.name/);
  });

  test("a view with an unknown layout is refused, listing the valid layouts", () => {
    const t = cloneDefault() as any;
    t.views[0].layout = "gantt";
    expect(() => validateBoardTemplate(t)).toThrow(/layout.*board, table, roadmap/);
  });

  test("a duplicate view name is refused", () => {
    const t = cloneDefault() as any;
    t.views.push(structuredClone(t.views[0]));
    expect(() => validateBoardTemplate(t)).toThrow(/duplicate view/);
  });

  test("an empty views list is allowed (views are optional descriptive data)", () => {
    const t = cloneDefault() as any;
    t.views = [];
    expect(() => validateBoardTemplate(t)).not.toThrow();
    expect(deriveShape(validateBoardTemplate(t)).views).toEqual([]);
  });

  test("a NUMBER field carrying options is refused (options are single-select only)", () => {
    const t = cloneDefault() as any;
    t.fields.find((f: any) => f.name === "Actual").options = [{ name: "x", color: "GRAY", description: "" }];
    expect(() => validateBoardTemplate(t)).toThrow(/only valid for a SINGLE_SELECT/);
  });
});

// -- file-level failures (ZError, never a raw throw) --------------------------
describe("loadBoardTemplate file errors", () => {
  test("a missing file is a ZError naming the path", () => {
    const bad = join(tmpdir(), "does-not-exist-zstack-template.json");
    let caught: unknown;
    try {
      loadBoardTemplate(bad);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ZError);
    expect((caught as ZError).message).toContain(bad);
    expect((caught as ZError).message).toMatch(/Cannot read board template/);
  });

  test("invalid JSON is a ZError, not a raw SyntaxError", () => {
    const p = writeTemplateFile("{ not valid json");
    let caught: unknown;
    try {
      loadBoardTemplate(p);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ZError);
    expect(caught).not.toBeInstanceOf(SyntaxError);
    expect((caught as ZError).message).toMatch(/not valid JSON/);
  });

  test("a structurally invalid file names the path and the bad field", () => {
    const p = writeTemplateFile(JSON.stringify({ statuses: [], fields: [], views: [] }));
    expect(() => loadBoardTemplate(p)).toThrow(/is invalid:.*"statuses" must be a non-empty array/);
  });

  test("a hand-written valid override loads from disk", () => {
    const p = writeTemplateFile(JSON.stringify(cloneDefault()));
    const t = loadBoardTemplate(p);
    expect(t.statuses.map((s) => s.name)).toEqual([...BOARD_STATUSES]);
  });
});

afterEach(() => {
  while (tmpFiles.length) rmSync(tmpFiles.pop()!, { recursive: true, force: true });
});
