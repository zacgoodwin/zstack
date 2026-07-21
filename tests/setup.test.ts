// Gate tests for C3: the /z-setup deterministic half (lib/setup-board.ts) and
// config schema (lib/config-schema.ts). Everything runs against an in-memory
// stateful backend or synthetic ProjectState objects -- zero network, well under
// the 2s gate budget. Covers issue #1's acceptance criteria: scripted verify,
// creation vs adoption, idempotence (a re-run plans zero mutations), and schema
// validation that fails loudly with the field named.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SetupBoard,
  diffState,
  toEpicStyle,
  verifyReport,
  writeConfig,
  renderViewsBlock,
  STATUS_OPTIONS,
  CUSTOM_FIELDS,
  type FieldState,
  type ProjectState,
} from "../lib/setup-board.ts";
import { loadConfig, type BoardConfig } from "../lib/config.ts";
import { validateConfig } from "../lib/config-schema.ts";
import { loadBoardTemplate, deriveShape, DEFAULT_TEMPLATE } from "../lib/board-template.ts";
import type { GraphQLData, GraphQLExecutor } from "../lib/board.ts";

// -- filesystem isolation for SetupBoard.apply() -----------------------------
// buildConfig now reads ~/.zstack/projects/<slug>/config.json to preserve
// hand-added optional fields across a re-apply (issue #97), so every
// SetupBoard.apply() call that reaches buildConfig touches the filesystem at
// whatever `home` resolves to. Without an explicit override, a test would
// silently read (and become coupled to) whatever real
// ~/.zstack/projects/<slug>/config.json happens to sit on the machine running
// the suite -- exactly the non-determinism the gate-test discipline
// (deterministic, local, never flaky) forbids. testHome() hands each such call
// an isolated, empty-by-default temp dir; the module-level afterEach sweeps
// every one this file creates.
const testHomes: string[] = [];
afterEach(() => {
  while (testHomes.length) rmSync(testHomes.pop()!, { recursive: true, force: true });
});
function testHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "zstack-setup-test-home-"));
  testHomes.push(dir);
  return dir;
}

// -- helpers -----------------------------------------------------------------
function opName(query: string): string {
  const m = query.match(/(?:query|mutation)\s+(\w+)/);
  if (!m) throw new Error(`cannot name operation: ${query.slice(0, 40)}`);
  return m[1];
}

// Options are inlined into create/update queries as GraphQL literals; pull the
// names back out so tests can assert the create path carried the right set.
function parseInlineOptions(query: string): string[] {
  const opts: string[] = [];
  const re = /name: "([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query))) opts.push(m[1]);
  return opts;
}

interface BackendField {
  id: string;
  name: string;
  dataType: "SINGLE_SELECT" | "NUMBER" | "TEXT";
  options?: string[];
}
// An item is either a Status option name (shorthand, null = no Status) or a
// {fieldName: optionName} record for multi-field usage tests (F7).
type BackendItem = string | null | Record<string, string | null>;
interface BackendProject {
  id: string;
  number: number;
  title: string;
  fields: BackendField[];
  items?: BackendItem[];
}

function fullProjectSpec(title = "zstack"): BackendProject {
  return {
    id: "PVT_full",
    number: 3,
    title,
    fields: [
      { id: "F_title", name: "Title", dataType: "TEXT" },
      { id: "F_status", name: "Status", dataType: "SINGLE_SELECT", options: [...STATUS_OPTIONS] },
      { id: "F_model", name: "Model", dataType: "SINGLE_SELECT", options: ["haiku", "sonnet", "opus", "fable"] },
      { id: "F_effort", name: "Model Effort", dataType: "SINGLE_SELECT", options: ["low", "medium", "high", "xhigh"] },
      { id: "F_est", name: "Estimate", dataType: "NUMBER" },
      { id: "F_act", name: "Actual", dataType: "NUMBER" },
    ],
  };
}

function nodeFrom(p: BackendProject): GraphQLData {
  return {
    node: {
      id: p.id,
      number: p.number,
      title: p.title,
      fields: {
        nodes: p.fields.map((f) => ({
          __typename: f.dataType === "SINGLE_SELECT" ? "ProjectV2SingleSelectField" : "ProjectV2Field",
          id: f.id,
          name: f.name,
          dataType: f.dataType,
          ...(f.options ? { options: f.options.map((n, i) => ({ id: `${f.id}_${i}`, name: n })) } : {}),
        })),
      },
    },
  };
}

// Stateful in-memory ProjectV2 backend: CreateProject seeds a fresh board with
// GitHub's default Status, and every field mutation updates the store, so a read
// after a write reflects it -- which is what makes the end-to-end idempotence
// assertion (second apply plans zero mutations) meaningful.
function setupBackend(existing?: BackendProject, opts?: { usagePageSize?: number }) {
  let project: BackendProject | null = existing ? structuredClone(existing) : null;
  let seq = 0;
  const calls: { op: string; query: string; vars: any }[] = [];

  const exec: GraphQLExecutor = async (query, vars: any) => {
    const op = opName(query);
    calls.push({ op, query, vars });
    switch (op) {
      case "RepoId":
        return { repository: { id: "R_1" } };
      case "OwnerId":
        return { repositoryOwner: { id: "U_owner" } };
      case "Projects":
        return {
          repository: {
            projectsV2: {
              nodes: project ? [{ id: project.id, number: project.number, title: project.title }] : [],
            },
          },
        };
      case "ProjectByNumber":
        return {
          repository: {
            projectV2:
              project && project.number === vars.number
                ? { id: project.id, number: project.number, title: project.title }
                : null,
          },
        };
      case "ProjectFields":
        if (!project) throw new Error("ProjectFields called with no project");
        return nodeFrom(project);
      case "FieldUsage": {
        if (!project) throw new Error("FieldUsage called with no project");
        // Real cursor pagination (offset cursors) so tests can pin that the
        // production loop actually follows pages (F6).
        const all = (project.items ?? []).map((it) => {
          const v = it === null || typeof it === "string" ? (vars.field === "Status" ? it : null) : (it[vars.field] ?? null);
          return { fieldValueByName: v ? { name: v } : null };
        });
        const size = opts?.usagePageSize ?? Math.max(all.length, 1);
        const start = vars.after ? Number(vars.after) : 0;
        const end = start + size;
        return {
          node: {
            items: {
              pageInfo: { hasNextPage: end < all.length, endCursor: end < all.length ? String(end) : null },
              nodes: all.slice(start, end),
            },
          },
        };
      }
      case "CreateProject":
        project = {
          id: "PVT_new",
          number: 7,
          title: vars.title,
          fields: [
            { id: "F_title", name: "Title", dataType: "TEXT" },
            { id: "F_status", name: "Status", dataType: "SINGLE_SELECT", options: ["Todo", "In Progress", "Done"] },
          ],
        };
        return { createProjectV2: { projectV2: { id: project.id, number: project.number, title: project.title } } };
      case "CreateSingleSelectField": {
        const id = `F_new${++seq}`;
        project!.fields.push({ id, name: vars.name, dataType: "SINGLE_SELECT", options: parseInlineOptions(query) });
        return { createProjectV2Field: { projectV2Field: { id, name: vars.name } } };
      }
      case "CreateNumberField": {
        const id = `F_new${++seq}`;
        project!.fields.push({ id, name: vars.name, dataType: "NUMBER" });
        return { createProjectV2Field: { projectV2Field: { id, name: vars.name } } };
      }
      case "UpdateFieldOptions": {
        const options = parseInlineOptions(query);
        const f = project!.fields.find((x) => x.id === vars.field);
        if (!f) throw new Error(`UpdateFieldOptions: no field ${vars.field}`);
        f.options = options;
        return { updateProjectV2Field: { projectV2Field: { id: vars.field } } };
      }
      default:
        throw new Error(`setupBackend: unexpected op ${op}`);
    }
  };

  return {
    exec,
    calls,
    get project() {
      return project;
    },
  };
}

function fieldState(name: string, dataType: FieldState["dataType"], options?: string[]): FieldState {
  return {
    id: `F_${name}`,
    name,
    dataType,
    options: options ? options.map((n, i) => ({ id: `F_${name}_${i}`, name: n })) : undefined,
  };
}

function stateFrom(fields: FieldState[], number = 3, title = "zstack"): ProjectState {
  return { id: "PVT_full", number, title, fields };
}

function fullState(): ProjectState {
  return stateFrom([
    fieldState("Title", "TEXT"),
    fieldState("Status", "SINGLE_SELECT", [...STATUS_OPTIONS]),
    fieldState("Model", "SINGLE_SELECT", ["haiku", "sonnet", "opus", "fable"]),
    fieldState("Model Effort", "SINGLE_SELECT", ["low", "medium", "high", "xhigh"]),
    fieldState("Estimate", "NUMBER"),
    fieldState("Actual", "NUMBER"),
  ]);
}

// -- diffState (the idempotence engine, pure) --------------------------------
describe("diffState", () => {
  test("null project plans create + status + all four fields", () => {
    const actions = diffState(null, "zstack");
    expect(actions[0]).toEqual({ kind: "create-project", title: "zstack" });
    expect(actions.some((a) => a.kind === "set-status-options")).toBe(true);
    const created = actions.filter((a) => a.kind === "create-field").map((a: any) => a.name);
    expect(created).toEqual(["Model", "Model Effort", "Estimate", "Actual"]);
  });

  test("a fully-set-up board plans zero mutations (idempotence)", () => {
    expect(diffState(fullState(), "zstack")).toEqual([]);
  });

  test("a missing custom field plans exactly one create-field", () => {
    const state = fullState();
    state.fields = state.fields.filter((f) => f.name !== "Actual");
    const actions = diffState(state, "zstack");
    expect(actions).toEqual([{ kind: "create-field", name: "Actual", dataType: "NUMBER", options: undefined }]);
  });

  test("wrong Status options plan a set-status-options", () => {
    const state = fullState();
    const status = state.fields.find((f) => f.name === "Status")!;
    status.options = [{ id: "x", name: "Todo" }, { id: "y", name: "Done" }];
    const actions = diffState(state, "zstack");
    expect(actions).toEqual([{ kind: "set-status-options", options: [...STATUS_OPTIONS] }]);
  });

  test("wrong single-select options plan a set-field-options", () => {
    const state = fullState();
    const model = state.fields.find((f) => f.name === "Model")!;
    model.options = [{ id: "x", name: "opus" }]; // missing haiku/sonnet/fable
    const actions = diffState(state, "zstack");
    expect(actions).toEqual([
      { kind: "set-field-options", name: "Model", options: ["haiku", "sonnet", "opus", "fable"] },
    ]);
  });

  test("a project with no Status field is rejected", () => {
    const state = stateFrom([fieldState("Title", "TEXT")]);
    expect(() => diffState(state, "zstack")).toThrow(/no Status field/);
  });
});

// -- verifyReport (acceptance criterion 1: scripted, not eyeballs) -----------
describe("verifyReport", () => {
  test("a fully-set-up board verifies OK with all lines OK", () => {
    const report = verifyReport(fullState());
    expect(report.ok).toBe(true);
    expect(report.lines.every((l) => l.includes("OK"))).toBe(true);
    expect(report.lines).toHaveLength(5); // Status + 4 fields
  });

  test("a missing field verifies as not-ok and names the field MISSING", () => {
    const state = fullState();
    state.fields = state.fields.filter((f) => f.name !== "Estimate");
    const report = verifyReport(state);
    expect(report.ok).toBe(false);
    expect(report.lines.some((l) => l.startsWith("Estimate: MISSING"))).toBe(true);
  });

  test("a null project verifies as not-ok pointing at /z-setup", () => {
    const report = verifyReport(null);
    expect(report.ok).toBe(false);
    expect(report.lines[0]).toMatch(/z-setup/);
  });
});

// -- SetupBoard.plan / apply against the stateful backend --------------------
describe("SetupBoard.plan", () => {
  test("a fresh repo plans create + status + four fields (six actions)", async () => {
    const backend = setupBackend();
    const setup = new SetupBoard(backend.exec);
    const actions = await setup.plan("zacgoodwin", "zstack", { title: "zstack" });
    expect(actions).toHaveLength(6);
    expect(actions[0].kind).toBe("create-project");
    // plan issues zero mutations
    expect(backend.calls.some((c) => c.op.startsWith("Create") || c.op.startsWith("Update"))).toBe(false);
  });

  test("an already-set-up repo plans zero mutations (idempotence)", async () => {
    const backend = setupBackend(fullProjectSpec());
    const setup = new SetupBoard(backend.exec);
    const actions = await setup.plan("zacgoodwin", "zstack", { title: "zstack" });
    expect(actions).toEqual([]);
  });
});

describe("SetupBoard.apply — creation path", () => {
  test("creates the project, runs every mutation, and builds a valid config", async () => {
    const backend = setupBackend();
    const setup = new SetupBoard(backend.exec);
    const result = await setup.apply("zacgoodwin", "zstack", {
      slug: "zstack",
      title: "zstack",
      epicStyle: "milestones",
      home: testHome(),
    });

    expect(result.created).toBe(true);
    // create + status options + 2 single-selects + 2 numbers = 5 executed actions
    expect(result.actions).toHaveLength(5);
    expect(backend.calls.filter((c) => c.op === "CreateProject")).toHaveLength(1);
    expect(backend.calls.filter((c) => c.op === "CreateSingleSelectField")).toHaveLength(2);
    expect(backend.calls.filter((c) => c.op === "CreateNumberField")).toHaveLength(2);
    expect(backend.calls.filter((c) => c.op === "UpdateFieldOptions")).toHaveLength(1); // Status

    // The Status update carried the canonical nine, inlined into the query.
    const statusUpdate = backend.calls.find((c) => c.op === "UpdateFieldOptions")!;
    expect(parseInlineOptions(statusUpdate.query)).toEqual([...STATUS_OPTIONS]);
    // The Model field creation carried its four options, inlined.
    const modelCreate = backend.calls.find(
      (c) => c.op === "CreateSingleSelectField" && c.vars.name === "Model"
    )!;
    expect(parseInlineOptions(modelCreate.query)).toEqual(["haiku", "sonnet", "opus", "fable"]);

    // Config reflects the real created ids and shape.
    const cfg = result.config;
    expect(cfg.slug).toBe("zstack");
    expect(cfg.projectNumber).toBe(7);
    expect(cfg.projectId).toBe("PVT_new");
    expect(cfg.repositoryId).toBe("R_1");
    expect(cfg.epicStyle).toBe("milestones");
    expect(cfg.maxLanes).toBe(3);
    expect(cfg.watchdogMinutes).toBe(10);
    expect(Object.keys(cfg.statusField.options!)).toEqual([...STATUS_OPTIONS]);
    expect(Object.keys(cfg.fields)).toEqual(["Model", "Model Effort", "Estimate", "Actual"]);
    expect(typeof cfg.fields.Model.options!.opus).toBe("string");
    expect(cfg.fields.Model.options!.opus.length).toBeGreaterThan(0);
    expect(cfg.fields.Estimate.dataType).toBe("NUMBER");
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  test("a second apply against the now-set-up board plans zero mutations (end-to-end idempotence)", async () => {
    const backend = setupBackend();
    const setup = new SetupBoard(backend.exec);
    const home = testHome();
    await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", home });

    const before = backend.calls.length;
    const second = await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", home });
    expect(second.created).toBe(false);
    expect(second.actions).toEqual([]);
    const mutationsAfter = backend.calls
      .slice(before)
      .filter((c) => c.op.startsWith("Create") || c.op.startsWith("Update"));
    expect(mutationsAfter).toEqual([]);
  });
});

describe("SetupBoard.apply — adoption path", () => {
  test("adopts an existing correct board with zero mutations", async () => {
    const backend = setupBackend(fullProjectSpec());
    const setup = new SetupBoard(backend.exec);
    const result = await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", home: testHome() });
    expect(result.created).toBe(false);
    expect(result.actions).toEqual([]);
    expect(backend.calls.some((c) => c.op.startsWith("Create") || c.op.startsWith("Update"))).toBe(false);
    expect(result.config.projectNumber).toBe(3);
    expect(result.config.projectId).toBe("PVT_full");
  });

  test("adopts by explicit --project-number", async () => {
    const backend = setupBackend(fullProjectSpec());
    const setup = new SetupBoard(backend.exec);
    const result = await setup.apply("zacgoodwin", "zstack", {
      slug: "zstack",
      title: "ignored-when-number-given",
      projectNumber: 3,
      home: testHome(),
    });
    expect(result.created).toBe(false);
    expect(backend.calls.some((c) => c.op === "ProjectByNumber")).toBe(true);
    expect(backend.calls.some((c) => c.op === "Projects")).toBe(false);
  });
});

// GitHub's default board: Todo / In Progress are non-canonical and would be
// deleted by set-status-options; Done is canonical and survives. Shared by the
// adopt-guard, pagination (F6), and TOCTOU-recheck (F10) suites.
function legacyProject(items: BackendItem[]): BackendProject {
  return {
    id: "PVT_legacy",
    number: 4,
    title: "zstack",
    fields: [
      { id: "F_title", name: "Title", dataType: "TEXT" },
      { id: "F_status", name: "Status", dataType: "SINGLE_SELECT", options: ["Todo", "In Progress", "Done"] },
    ],
    items,
  };
}

// -- destructive adopt guard (issue #14 item 5) -------------------------------
describe("SetupBoard.apply — destructive adopt guard", () => {

  test("adopt with live items in non-canonical options refuses without --force, naming options + counts, issuing no mutation", async () => {
    const backend = setupBackend(legacyProject(["Todo", "Todo", "In Progress", "Done", null]));
    const setup = new SetupBoard(backend.exec);
    await expect(
      setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack" })
    ).rejects.toThrow(/"Todo": 2 item\(s\)[\s\S]*"In Progress": 1 item\(s\)[\s\S]*--force/);
    // No destructive (or any) mutation was issued, and the backend still holds
    // the original options. The item in canonical "Done" did not trigger it.
    expect(backend.calls.some((c) => c.op.startsWith("Create") || c.op.startsWith("Update"))).toBe(false);
    expect(backend.project!.fields.find((f) => f.name === "Status")!.options).toEqual([
      "Todo",
      "In Progress",
      "Done",
    ]);
  });

  test("adopt with --force proceeds, reports what was dropped, and replaces Status", async () => {
    const backend = setupBackend(legacyProject(["Todo", "In Progress", "Done"]));
    const setup = new SetupBoard(backend.exec);
    const result = await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", force: true, home: testHome() });
    expect(result.created).toBe(false);
    expect(result.dropped).toEqual([
      { field: "Status", name: "Todo", count: 1 },
      { field: "Status", name: "In Progress", count: 1 },
    ]);
    expect(backend.calls.some((c) => c.op === "UpdateFieldOptions")).toBe(true);
    expect(backend.project!.fields.find((f) => f.name === "Status")!.options).toEqual([...STATUS_OPTIONS]);
    expect(() => validateConfig(result.config)).not.toThrow();
  });

  test("adopt with no items in non-canonical options proceeds without --force", async () => {
    const backend = setupBackend(legacyProject(["Done", null]));
    const setup = new SetupBoard(backend.exec);
    const result = await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", home: testHome() });
    expect(result.created).toBe(false);
    expect(result.dropped).toEqual([]);
    expect(backend.calls.some((c) => c.op === "UpdateFieldOptions")).toBe(true);
  });
});

// -- F6: usage scan pagination is real and loud ------------------------------
describe("SetupBoard.apply — usage scan pagination (F6)", () => {
  test("counts populated options across BOTH pages (refusal names the full count)", async () => {
    // 3 "Todo" items with a page size of 2: page one alone sees only 2. An
    // implementation with the cursor loop deleted undercounts and this regex
    // (pinned to the total) fails.
    const backend = setupBackend(legacyProject(["Todo", "Todo", "Todo"]), { usagePageSize: 2 });
    const setup = new SetupBoard(backend.exec);
    await expect(
      setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack" })
    ).rejects.toThrow(/"Todo": 3 item\(s\)/);
    expect(backend.calls.some((c) => c.op.startsWith("Create") || c.op.startsWith("Update"))).toBe(false);
  });

  test("hasNextPage with a null or empty endCursor throws loudly instead of undercounting", async () => {
    for (const badCursor of [null, ""]) {
      const backend = setupBackend(legacyProject(["Todo"]));
      const exec: GraphQLExecutor = async (q, v) => {
        const data = await backend.exec(q, v);
        if (opName(q) === "FieldUsage") {
          (data as any).node.items.pageInfo = { hasNextPage: true, endCursor: badCursor };
        }
        return data;
      };
      await expect(
        new SetupBoard(exec).apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack" })
      ).rejects.toThrow(/endCursor/);
    }
  });

  test("a repeated endCursor throws instead of looping forever", async () => {
    const backend = setupBackend(legacyProject(["Todo"]));
    const exec: GraphQLExecutor = async (q, v) => {
      const data = await backend.exec(q, v);
      if (opName(q) === "FieldUsage") {
        (data as any).node.items.pageInfo = { hasNextPage: true, endCursor: "STUCK" };
      }
      return data;
    };
    await expect(
      new SetupBoard(exec).apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack" })
    ).rejects.toThrow(/twice in a row/);
  });
});

// -- F7: the guard covers every single-select replace, not just Status --------
describe("SetupBoard.apply — guard covers Model / Model Effort (F7)", () => {
  // A board whose Model field carries an extra non-canonical option; Status is
  // already canonical so ONLY the Model replace is destructive.
  function modelDriftProject(items: BackendItem[]): BackendProject {
    const p = fullProjectSpec();
    p.fields.find((f) => f.name === "Model")!.options = ["haiku", "sonnet", "opus", "fable", "gpt4"];
    p.items = items;
    return p;
  }

  test("a populated non-canonical Model option refuses without --force, naming Model and the option", async () => {
    const backend = setupBackend(modelDriftProject([{ Model: "gpt4" }, { Model: "opus" }, {}]));
    const setup = new SetupBoard(backend.exec);
    await expect(
      setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack" })
    ).rejects.toThrow(/Model "gpt4": 1 item\(s\)[\s\S]*--force/);
    expect(backend.calls.some((c) => c.op.startsWith("Create") || c.op.startsWith("Update"))).toBe(false);
  });

  test("--force proceeds, reports the dropped Model option per field, and replaces the options", async () => {
    const backend = setupBackend(modelDriftProject([{ Model: "gpt4" }]));
    const setup = new SetupBoard(backend.exec);
    const result = await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", force: true, home: testHome() });
    expect(result.dropped).toEqual([{ field: "Model", name: "gpt4", count: 1 }]);
    expect(backend.project!.fields.find((f) => f.name === "Model")!.options).toEqual([
      "haiku",
      "sonnet",
      "opus",
      "fable",
    ]);
  });

  test("an unpopulated non-canonical Model option proceeds without --force", async () => {
    const backend = setupBackend(modelDriftProject([{ Model: "opus" }]));
    const setup = new SetupBoard(backend.exec);
    const result = await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", home: testHome() });
    expect(result.dropped).toEqual([]);
    expect(backend.calls.some((c) => c.op === "UpdateFieldOptions")).toBe(true);
  });
});

// -- F8: lookup pagination (a page-2 project/field must be FOUND) -------------
describe("SetupBoard pagination of lookups (F8)", () => {
  test("a title match on page 2 of projectsV2 is adopted, not duplicated", async () => {
    const backend = setupBackend(fullProjectSpec());
    const exec: GraphQLExecutor = async (q, v: any) => {
      if (opName(q) === "Projects") {
        // Page one: only a decoy, more pages advertised. Page two: the match.
        if (!v.after) {
          return {
            repository: {
              projectsV2: {
                pageInfo: { hasNextPage: true, endCursor: "P1" },
                nodes: [{ id: "PVT_other", number: 1, title: "decoy" }],
              },
            },
          };
        }
        return {
          repository: {
            projectsV2: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: "PVT_full", number: 3, title: "zstack" }],
            },
          },
        };
      }
      return backend.exec(q, v);
    };
    const setup = new SetupBoard(exec);
    const result = await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", home: testHome() });
    expect(result.created).toBe(false); // found on page 2 -> adopted
    expect(result.config.projectId).toBe("PVT_full");
    expect(backend.calls.some((c) => c.op === "CreateProject")).toBe(false);
  });

  test("field discovery sees fields split across two pages (no duplicate create planned)", async () => {
    const backend = setupBackend(fullProjectSpec());
    const exec: GraphQLExecutor = async (q, v: any) => {
      if (opName(q) === "ProjectFields") {
        const node = (nodeFrom(backend.project!) as any).node;
        const nodes = node.fields.nodes;
        const page = v.after
          ? { pageInfo: { hasNextPage: false, endCursor: null }, nodes: nodes.slice(3) }
          : { pageInfo: { hasNextPage: true, endCursor: "F1" }, nodes: nodes.slice(0, 3) };
        return { node: { ...node, fields: page } };
      }
      return backend.exec(q, v);
    };
    const setup = new SetupBoard(exec);
    // Every field lives on one of the two pages; if page 2 were dropped, the
    // plan would contain create-field actions for the "missing" fields.
    const actions = await setup.plan("zacgoodwin", "zstack", { title: "zstack" });
    expect(actions).toEqual([]);
  });
});

// -- F9: inputs are validated BEFORE the first GraphQL op ---------------------
describe("SetupBoard.apply — pre-flight input validation (F9)", () => {
  test("an invalid maxLanes / watchdogMinutes refuses with ZERO GraphQL ops issued", async () => {
    const backend = setupBackend(fullProjectSpec());
    const setup = new SetupBoard(backend.exec);
    for (const bad of [NaN, 0, -1]) {
      await expect(
        setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", maxLanes: bad })
      ).rejects.toThrow(/"maxLanes" must be a positive number/);
    }
    await expect(
      setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", watchdogMinutes: -5 })
    ).rejects.toThrow(/"watchdogMinutes" must be a positive number/);
    expect(backend.calls).toEqual([]); // nothing reached the backend, mutation or read
  });

  test('apply({epicStyle: "issue-type"} as any) throws before any op (JS-caller defense)', async () => {
    const backend = setupBackend(fullProjectSpec());
    const setup = new SetupBoard(backend.exec);
    await expect(
      setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", epicStyle: "issue-type" } as any)
    ).rejects.toThrow(/not yet supported[\s\S]*milestones/);
    expect(backend.calls).toEqual([]);
  });
});

// -- F10: TOCTOU recheck right before the destructive mutation ----------------
describe("SetupBoard.apply — usage recheck before replace (F10)", () => {
  test("an option populated between the scan and the mutation refuses even with --force", async () => {
    // First scan: nothing populated (guard would proceed). Second scan: an item
    // landed in "Todo" during the window -> refuse, naming it, despite --force.
    const backend = setupBackend(legacyProject(["Done", null]));
    let usageReads = 0;
    const exec: GraphQLExecutor = async (q, v) => {
      if (opName(q) === "FieldUsage" && ++usageReads === 2) {
        return {
          node: {
            items: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ fieldValueByName: { name: "Todo" } }],
            },
          },
        };
      }
      return backend.exec(q, v);
    };
    const setup = new SetupBoard(exec);
    await expect(
      setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", force: true })
    ).rejects.toThrow(/"Todo": 1 item\(s\)[\s\S]*not quiescent/);
    expect(usageReads).toBe(2); // the recheck actually ran
    expect(backend.calls.some((c) => c.op === "UpdateFieldOptions")).toBe(false);
  });
});

// -- writeConfig round-trip --------------------------------------------------
describe("writeConfig", () => {
  test("writes a config that loadConfig reads back cleanly", async () => {
    const backend = setupBackend();
    const setup = new SetupBoard(backend.exec);
    const home = testHome();
    const result = await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", home });

    const path = writeConfig(result.config, home);
    expect(path).toContain(join(".zstack", "projects", "zstack", "config.json"));

    const loaded = loadConfig("zstack", home);
    expect(loaded.projectId).toBe("PVT_new");
    expect(loaded.statusField.options!.Done).toBeDefined();
    expect(loaded.maxLanes).toBe(3);
    // issue #18: SetupBoard never writes this knob, so a config from /z-setup
    // omits it entirely -- loadConfig must still default it to 5 (AC2:
    // existing "every 5th loop" behavior unchanged for every already-set-up project).
    expect(loaded.auditEveryNLoops).toBe(5);
    // issue #59 AC8: same for adversarialMode -- SetupBoard never writes it, so
    // loadConfig must default an omitting config to "non-trivial".
    expect(loaded.adversarialMode).toBe("non-trivial");
    // issue #62 AC10: same pattern for the reviewer-confidence gate -- SetupBoard
    // never writes either knob, so loadConfig must default them to 70 / "block".
    expect(loaded.minReviewerConfidence).toBe(70);
    expect(loaded.reviewerBelowThresholdAction).toBe("block");
  });

  // -- issue #82 (AC6): stageModels default only for a brand-new project ------
  test("a brand-new project's config includes the stageModels default and passes validateConfig", async () => {
    const backend = setupBackend();
    const setup = new SetupBoard(backend.exec);
    const result = await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", home: testHome() });
    expect(result.created).toBe(true);
    expect(result.config.stageModels).toEqual({ merge: "haiku" });
    expect(() => validateConfig(result.config)).not.toThrow();
  });

  // Re-running setup against an existing config (adoption) never touches
  // stageModels -- neither injecting the default nor stripping a key the
  // config didn't have. Simulates a config written BEFORE this ticket (no
  // stageModels key at all): a second apply/write against the now-existing
  // project must leave the file byte-identical. Also issue #97 AC2 (no-drift
  // re-run over a prior config carrying none of the four preserved optional
  // fields stays byte-identical): the second apply() now reads this SAME
  // `home`'s config.json (via buildConfig's priorOptionalFields), so this test
  // doubles as proof that reading it back injects nothing new.
  test("re-running setup against an existing config without stageModels leaves it byte-identical", async () => {
    const backend = setupBackend();
    const setup = new SetupBoard(backend.exec);
    const home = testHome();

    // First run creates the project; strip stageModels to simulate a config
    // that predates this ticket, then write it -- the "existing config
    // without the key" AC6 names.
    const first = await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", home });
    delete (first.config as any).stageModels;
    const path = writeConfig(first.config, home);
    const before = readFileSync(path, "utf8");

    // Second run adopts the now-existing project (created === false) and reads
    // the file just written above from the same `home`.
    const second = await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", home });
    expect(second.created).toBe(false);
    expect(second.config.stageModels).toBeUndefined(); // adoption never injects the default
    writeConfig(second.config, home);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  // -- issue #97 AC1: a re-apply that genuinely rewrites the config (the board
  // shape drifted) preserves every hand-added optional field, not just
  // stageModels -----------------------------------------------------------
  test("a re-apply over a drifted board preserves hand-added stageModels/quota/notifications/adversarialMode", async () => {
    const backend = setupBackend();
    const setup = new SetupBoard(backend.exec);
    const home = testHome();

    // First run creates the project and its config.
    const first = await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", home });
    const handEdited: BoardConfig = {
      ...first.config,
      stageModels: { merge: "haiku", qa: "haiku" },
      quota: { threshold: 250, mode: "abort" },
      notifications: { enabled: true },
      adversarialMode: "always",
    };
    writeConfig(handEdited, home);

    // Simulate board-shape drift: the live board's Model field lost the
    // "fable" option (e.g. someone edited it directly on github.com), so the
    // next apply's diffState plans a real set-field-options mutation and
    // buildConfig runs on a freshly re-read state -- the "writeConfig branch"
    // the ticket names, not the no-op re-run.
    backend.project!.fields.find((f) => f.name === "Model")!.options = ["haiku", "sonnet", "opus"];

    const second = await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", home });
    expect(second.actions.some((a) => a.kind === "set-field-options" && a.name === "Model")).toBe(true);
    expect(second.config.stageModels).toEqual({ merge: "haiku", qa: "haiku" });
    expect(second.config.quota).toEqual({ threshold: 250, mode: "abort" });
    expect(second.config.notifications).toEqual({ enabled: true });
    expect(second.config.adversarialMode).toBe("always");

    const path = writeConfig(second.config, home);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.stageModels).toEqual({ merge: "haiku", qa: "haiku" });
    expect(written.quota).toEqual({ threshold: 250, mode: "abort" });
    expect(written.notifications).toEqual({ enabled: true });
    expect(written.adversarialMode).toBe("always");
  });

  // -- issue #97 AC3: first-time setup, no prior config.json on disk at all --
  test("first-time setup with no prior config.json tolerates the absent file (no crash, unchanged default)", async () => {
    const backend = setupBackend();
    const setup = new SetupBoard(backend.exec);
    const home = testHome(); // guaranteed empty: no ~/.zstack/projects/<slug>/config.json at all
    const result = await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", home });
    expect(result.created).toBe(true);
    expect(result.config.quota).toEqual({ threshold: 100, mode: "sleep" });
    expect(result.config.stageModels).toEqual({ merge: "haiku" });
    expect(result.config.notifications).toBeUndefined();
    expect(result.config.adversarialMode).toBeUndefined();
    expect(() => writeConfig(result.config, home)).not.toThrow();
  });

  // A hand-edited config.json that is not valid JSON must not crash setup --
  // tolerated the same as an absent file, falling back to fresh defaults.
  test("a corrupt prior config.json is tolerated (fresh defaults, no crash)", async () => {
    const backend = setupBackend();
    const setup = new SetupBoard(backend.exec);
    const home = testHome();
    const first = await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", home });
    const path = writeConfig(first.config, home);
    writeFileSync(path, "{ not valid json"); // corrupt it directly, bypassing writeConfig's validation

    const second = await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", home });
    expect(second.config.quota).toEqual({ threshold: 100, mode: "sleep" }); // fresh default, nothing preserved
    expect(second.config.stageModels).toBeUndefined(); // adoption path -- no default injected either
  });

  // Reviewer finding 1 (blocker): a validly-parsed JSON value whose SHAPE is
  // wrong for one of the four preserved fields (a string where an object is
  // required, or an explicit null) used to reach validateConfig unfiltered --
  // and apply() runs the board's GraphQL mutations BEFORE buildConfig/
  // validateConfig, so that crash landed AFTER the live board already changed,
  // with config.json never written. A wrong-shape field must instead fall
  // back to "nothing to preserve for that field" -- the same tolerant
  // treatment priorOptionalFields already gives a missing/unparsable file --
  // while a correctly-shaped sibling field is unaffected.
  test("a validly-parsed but wrong-shape preserved field does not crash apply() after board mutations run; falls back per-field, siblings still preserved", async () => {
    const backend = setupBackend();
    const setup = new SetupBoard(backend.exec);
    const home = testHome();

    const first = await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", home });
    const path = writeConfig(first.config, home);
    // Hand-edit the file directly (bypassing writeConfig's own validateConfig
    // call) to a validly-parsed JSON document carrying two bad-shape fields
    // (a string "quota", an explicit-null "adversarialMode") alongside a
    // correctly-shaped "stageModels" -- a realistic typo that leaves the rest
    // of the file intact.
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    onDisk.quota = "banana"; // wrong shape: a string, not {threshold, mode}
    onDisk.adversarialMode = null; // valid JSON, explicit null -- also wrong shape
    onDisk.stageModels = { merge: "haiku", qa: "haiku" }; // correctly-shaped sibling
    writeFileSync(path, JSON.stringify(onDisk, null, 2) + "\n");

    // Force board-shape drift so apply()'s mutation loop (lines 580-594)
    // actually executes GraphQL calls before buildConfig/validateConfig run --
    // reproducing the exact hazard finding 1 reported (mutate the board, then
    // throw before config.json is written).
    backend.project!.fields.find((f) => f.name === "Model")!.options = ["haiku", "sonnet", "opus"];

    // The bug: this used to throw (validateConfig rejecting the unfiltered
    // "banana" quota) AFTER the set-field-options mutation above already ran.
    // Awaiting it directly here means any regression fails this test the same
    // way it fails production -- an uncaught throw, not a silent pass.
    const second = await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", home });

    expect(second.actions.some((a) => a.kind === "set-field-options" && a.name === "Model")).toBe(true);
    expect(second.config.quota).toEqual({ threshold: 100, mode: "sleep" }); // default wins, not "banana"
    expect(second.config.adversarialMode).toBeUndefined(); // null wasn't preserved, no default either
    expect(second.config.stageModels).toEqual({ merge: "haiku", qa: "haiku" }); // sibling untouched
    expect(() => validateConfig(second.config)).not.toThrow();
  });

  // Issue #106 AC3: `typeof [] === "object"` and `[] !== null`, so a bare
  // array used to pass validateQuota as a "valid" quota object -- it never
  // threw, so priorOptionalFields' per-field try/catch (above) never caught
  // it and preserved the array verbatim across a re-apply instead of falling
  // back to DEFAULT_QUOTA. Same reproduction shape as the wrong-shape test
  // above (drift the board so apply()'s mutation loop runs before
  // buildConfig/validateConfig), but specifically for the array hole.
  test("a prior config carrying quota: [] falls back to DEFAULT_QUOTA on re-apply, not preserved as an array (AC3)", async () => {
    const backend = setupBackend();
    const setup = new SetupBoard(backend.exec);
    const home = testHome();

    const first = await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", home });
    const path = writeConfig(first.config, home);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    onDisk.quota = []; // the bare-array hole
    writeFileSync(path, JSON.stringify(onDisk, null, 2) + "\n");

    // Drift the board so apply()'s mutation loop runs before buildConfig --
    // the mutate-then-fail hazard finding 1 (#97) reported.
    backend.project!.fields.find((f) => f.name === "Model")!.options = ["haiku", "sonnet", "opus"];

    const second = await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", home });

    expect(second.actions.some((a) => a.kind === "set-field-options" && a.name === "Model")).toBe(true);
    expect(second.config.quota).toEqual({ threshold: 100, mode: "sleep" }); // DEFAULT_QUOTA, array not preserved
    expect(Array.isArray(second.config.quota)).toBe(false);
    expect(() => validateConfig(second.config)).not.toThrow(); // no post-mutation crash
  });
});

// -- board template override (issue #20 AC2 + AC5) ---------------------------
describe("board template override", () => {
  test("a custom template's status color + description is honored in the emitted mutation; names intact -> verify green (AC2)", async () => {
    const t = structuredClone(loadBoardTemplate());
    const backlog = t.statuses.find((s) => s.name === "Backlog")!;
    backlog.color = "PURPLE";
    backlog.description = "not yet planned";
    const shape = deriveShape(t);

    const backend = setupBackend();
    const setup = new SetupBoard(backend.exec, shape);
    const result = await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", home: testHome() });
    expect(result.created).toBe(true);

    // The Status field is set via UpdateFieldOptions on the create path; its
    // inlined literal must carry the CUSTOM color + description.
    const statusUpdate = backend.calls.find((c) => c.op === "UpdateFieldOptions")!;
    expect(statusUpdate.query).toContain('{name: "Backlog", color: PURPLE, description: "not yet planned"}');
    // A field left at the default still emits the default color -- no bleed.
    const modelCreate = backend.calls.find((c) => c.op === "CreateSingleSelectField" && c.vars.name === "Model")!;
    expect(modelCreate.query).toContain('{name: "haiku", color: GRAY, description: ""}');

    // Names are unchanged, so the live board still verifies against this shape.
    const report = await setup.verify("zacgoodwin", "zstack", { title: "zstack" });
    expect(report.ok).toBe(true);
  });

  test("the default emitted status literal is byte-identical to the old position-cycled shape (1:1)", async () => {
    const backend = setupBackend();
    const setup = new SetupBoard(backend.exec); // default shape
    await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack", home: testHome() });
    const statusUpdate = backend.calls.find((c) => c.op === "UpdateFieldOptions")!;
    // Backlog=GRAY, Ready=BLUE, ... Done wraps back to GRAY; all descriptions "".
    expect(statusUpdate.query).toContain('{name: "Backlog", color: GRAY, description: ""}');
    expect(statusUpdate.query).toContain('{name: "Ready", color: BLUE, description: ""}');
    expect(statusUpdate.query).toContain('{name: "Done", color: GRAY, description: ""}');
  });

  test("renderViewsBlock names every template view as a manual step, never dropping one (AC5)", () => {
    const block = renderViewsBlock(DEFAULT_TEMPLATE.views);
    expect(block).toMatch(/manual/i);
    for (const v of DEFAULT_TEMPLATE.views) {
      expect(block).toContain(`"${v.name}"`);
      expect(block).toContain(v.layout);
    }
  });

  test("renderViewsBlock is empty for a template with no views", () => {
    expect(renderViewsBlock([])).toBe("");
  });

  // AC3: a template dropping a required field is refused at load, BEFORE the
  // executor is touched -- the CLI loads + validates the template up front, so no
  // board mutation is ever attempted on a bad template.
  test("a template missing a required field refuses before any GraphQL op (AC3)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ztpl-ac3-"));
    try {
      const bad: any = structuredClone(loadBoardTemplate());
      bad.fields = bad.fields.filter((f: any) => f.name !== "Estimate");
      const badPath = join(dir, "bad.json");
      require("node:fs").writeFileSync(badPath, JSON.stringify(bad));

      const calls: string[] = [];
      const exec: GraphQLExecutor = async (q) => {
        calls.push(q);
        return {} as GraphQLData;
      };
      // Mirrors main()'s order: load+validate, derive, only then construct.
      expect(() => {
        const shape = deriveShape(loadBoardTemplate(badPath));
        new SetupBoard(exec, shape);
      }).toThrow(/required field "Estimate"/);
      expect(calls).toEqual([]); // executor never touched
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// -- config schema validation (acceptance criterion 4) -----------------------
describe("validateConfig", () => {
  function goodConfig(): BoardConfig {
    return {
      slug: "zstack",
      owner: "zacgoodwin",
      repo: "zstack",
      projectNumber: 1,
      projectId: "PVT_1",
      repositoryId: "R_1",
      statusField: { id: "F_status", dataType: "SINGLE_SELECT", options: { Backlog: "o1", Done: "o2" } },
      fields: {
        Model: { id: "F_model", dataType: "SINGLE_SELECT", options: { opus: "o3" } },
        Estimate: { id: "F_est", dataType: "NUMBER" },
      },
      epicStyle: "milestones",
      maxLanes: 3,
      watchdogMinutes: 10,
      quota: { threshold: 200, mode: "sleep" },
    };
  }

  test("a well-formed config passes", () => {
    expect(() => validateConfig(goodConfig())).not.toThrow();
  });

  test("a single-select field with no options fails, naming the path", () => {
    const cfg = goodConfig();
    delete (cfg.fields.Model as any).options;
    expect(() => validateConfig(cfg)).toThrow(/fields\.Model\.options/);
  });

  // Issue #106: the array-as-object hole applies to every
  // `typeof x === "object"` guard in the file, not just quota/notifications --
  // a bare config, a bare `fields` map, a bare field, and a bare options map
  // all pass `typeof [] === "object" && [] !== null` the same way.
  test("a bare array is rejected at every object-shaped site: the whole config, fields, a field, and an options map", () => {
    expect(() => validateConfig([])).toThrow(/Config must be a JSON object/);

    const badFields = goodConfig() as any;
    badFields.fields = [];
    expect(() => validateConfig(badFields)).toThrow(/"fields" must be an object/);

    const badField = goodConfig() as any;
    badField.fields.Model = [];
    expect(() => validateConfig(badField)).toThrow(/"fields\.Model" must be an object/);

    const badOptions = goodConfig() as any;
    badOptions.fields.Model.options = ["opt_opus"];
    expect(() => validateConfig(badOptions)).toThrow(/fields\.Model\.options/);
  });

  test("a non-integer projectNumber fails, naming the field", () => {
    const cfg = goodConfig() as any;
    cfg.projectNumber = "1";
    expect(() => validateConfig(cfg)).toThrow(/projectNumber/);
  });

  test("a bad epicStyle fails, naming the field", () => {
    const cfg = goodConfig() as any;
    cfg.epicStyle = "labels";
    expect(() => validateConfig(cfg)).toThrow(/epicStyle/);
  });

  // issue #14 item 6: "issue-type" has no create path yet, so the schema is the
  // single enforcement point that keeps it out of every config.
  test('epicStyle "issue-type" is rejected as not yet supported, pointing at milestones', () => {
    const cfg = goodConfig() as any;
    cfg.epicStyle = "issue-type";
    expect(() => validateConfig(cfg)).toThrow(/"issue-type" is not yet supported[\s\S]*"milestones"/);
    cfg.epicStyle = "milestones";
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  test('--epic-style "issue-type" is rejected at the CLI parse layer, before any GraphQL call', () => {
    expect(() => toEpicStyle("issue-type")).toThrow(/not yet supported[\s\S]*milestones/);
    expect(toEpicStyle("milestones")).toBe("milestones");
    expect(toEpicStyle(undefined)).toBeUndefined();
  });

  test("a statusField with the wrong dataType fails", () => {
    const cfg = goodConfig() as any;
    cfg.statusField.dataType = "NUMBER";
    expect(() => validateConfig(cfg)).toThrow(/statusField\.dataType.*SINGLE_SELECT/);
  });

  test("an option id that is not a string fails, naming the option", () => {
    const cfg = goodConfig() as any;
    cfg.statusField.options.Done = 42;
    expect(() => validateConfig(cfg)).toThrow(/statusField\.options\.Done/);
  });

  // -- issue #14 item 18: every numeric + quota guard branch ------------------
  describe("numeric + quota guards (item 18)", () => {
    const NUMERIC_KEYS = ["maxLanes", "watchdogMinutes", "lockStalenessMinutes", "maxQaPasses", "qaInvestigateAfter"] as const;

    test.each(NUMERIC_KEYS.map((k) => [k] as [string]))(
      "%s rejects a string, NaN, zero, and a negative",
      (key) => {
        for (const bad of ["3", NaN, 0, -1]) {
          const cfg = goodConfig() as any;
          cfg[key] = bad;
          expect(() => validateConfig(cfg)).toThrow(new RegExp(`"${key}" must be a positive number`));
        }
      }
    );

    test.each(NUMERIC_KEYS.map((k) => [k] as [string]))("%s accepts a positive number and is optional", (key) => {
      const cfg = goodConfig() as any;
      cfg[key] = 5;
      expect(() => validateConfig(cfg)).not.toThrow();
      delete cfg[key];
      expect(() => validateConfig(cfg)).not.toThrow();
    });

    test("projectNumber rejects NaN and a float, not just a string", () => {
      for (const bad of [NaN, 1.5]) {
        const cfg = goodConfig() as any;
        cfg.projectNumber = bad;
        expect(() => validateConfig(cfg)).toThrow(/"projectNumber" must be an integer/);
      }
    });

    test("quota must be an object when present", () => {
      for (const bad of ["high", null, 200]) {
        const cfg = goodConfig() as any;
        cfg.quota = bad;
        expect(() => validateConfig(cfg)).toThrow(/"quota" must be an object/);
      }
    });

    // Issue #106: `typeof [] === "object"` and `[] !== null`, so a bare array
    // used to pass the old `typeof quota !== "object" || quota === null`
    // guard as a valid quota object -- `quota.threshold`/`quota.mode` then
    // read as undefined off the array instead of the config failing loudly.
    // Must throw naming "quota", the same as any other wrong-shape value (AC1).
    test("a bare array is rejected, not silently accepted as a valid object (AC1)", () => {
      const cfg = goodConfig() as any;
      cfg.quota = [];
      expect(() => validateConfig(cfg)).toThrow(/"quota" must be an object/);
    });

    // NaN matters here: `remaining >= NaN` is always false, so a NaN threshold
    // would trip the board's quota guard on every single call, forever.
    test("quota.threshold rejects a string, a negative, NaN, and Infinity", () => {
      for (const bad of ["200", -1, NaN, Infinity]) {
        const cfg = goodConfig() as any;
        cfg.quota = { threshold: bad, mode: "sleep" };
        expect(() => validateConfig(cfg)).toThrow(/"quota\.threshold" must be a non-negative number/);
      }
    });

    test("quota.threshold accepts 0, and partial quota objects pass", () => {
      const cfg = goodConfig() as any;
      cfg.quota = { threshold: 0 }; // guard on every call: valid
      expect(() => validateConfig(cfg)).not.toThrow();
      cfg.quota = { mode: "abort" }; // loadConfig fills the default threshold
      expect(() => validateConfig(cfg)).not.toThrow();
    });

    test('quota.mode rejects anything but "sleep" or "abort"', () => {
      for (const bad of ["retry", 1, null]) {
        const cfg = goodConfig() as any;
        cfg.quota = { threshold: 200, mode: bad };
        expect(() => validateConfig(cfg)).toThrow(/"quota\.mode" must be "sleep" or "abort"/);
      }
    });
  });

  // -- issue #18: the /cso + /health audit cadence knob -----------------------
  describe("auditEveryNLoops (issue #18)", () => {
    test("accepts a positive integer and is optional", () => {
      const cfg = goodConfig() as any;
      cfg.auditEveryNLoops = 3;
      expect(() => validateConfig(cfg)).not.toThrow();
      delete cfg.auditEveryNLoops;
      expect(() => validateConfig(cfg)).not.toThrow();
    });

    // AC3: 0, -1, and 2.5 must all fail, naming the field and the integer >= 1
    // requirement -- unlike maxLanes/watchdogMinutes/lockStalenessMinutes
    // (requirePositiveNumber alone), a fraction is rejected too.
    test.each([0, -1, 2.5, NaN, "3"])("rejects %p, naming the field and the integer >= 1 rule", (bad) => {
      const cfg = goodConfig() as any;
      cfg.auditEveryNLoops = bad;
      expect(() => validateConfig(cfg)).toThrow(/"auditEveryNLoops" must be a positive integer \(>= 1\)/);
    });
  });

  // -- issue #59: the adversarial-reviewer mode knob --------------------------
  describe("adversarialMode (issue #59)", () => {
    // AC9: a value outside the three-enum is rejected, naming the field and the
    // valid set; a valid value (and omission -- loadConfig defaults it) passes.
    test("rejects a bad adversarialMode", () => {
      const cfg = goodConfig() as any;
      cfg.adversarialMode = "sometimes";
      expect(() => validateConfig(cfg)).toThrow(/adversarialMode.*"off", "non-trivial", "always"/);
    });

    test("accepts a valid adversarialMode and is optional", () => {
      const cfg = goodConfig() as any;
      for (const mode of ["off", "non-trivial", "always"]) {
        cfg.adversarialMode = mode;
        expect(() => validateConfig(cfg)).not.toThrow();
      }
      delete cfg.adversarialMode;
      expect(() => validateConfig(cfg)).not.toThrow();
    });
  });

  // -- issue #58: the tick-throttle pacing knob --------------------------------
  describe("tickThrottleSeconds (issue #58)", () => {
    // AC3: 0 -- the required "off" value -- must NOT be rejected the way
    // requirePositiveNumber would reject it (that guard rejects v <= 0).
    test("accepts 0 (off), the value requirePositiveNumber would wrongly reject", () => {
      const cfg = goodConfig() as any;
      cfg.tickThrottleSeconds = 0;
      expect(() => validateConfig(cfg)).not.toThrow();
    });

    test("accepts a positive integer and is optional", () => {
      const cfg = goodConfig() as any;
      cfg.tickThrottleSeconds = 120;
      expect(() => validateConfig(cfg)).not.toThrow();
      delete cfg.tickThrottleSeconds;
      expect(() => validateConfig(cfg)).not.toThrow();
    });

    // AC4: -1, 2.5, NaN, and "120" all fail, naming the field + the
    // non-negative-integer rule.
    test.each([-1, 2.5, NaN, "120"])("rejects %p, naming the field and the non-negative integer rule", (bad) => {
      const cfg = goodConfig() as any;
      cfg.tickThrottleSeconds = bad;
      expect(() => validateConfig(cfg)).toThrow(/"tickThrottleSeconds" must be a non-negative integer/);
    });
  });

  // -- issue #62: the reviewer-confidence safety gate knobs --------------------
  describe("reviewer confidence gate (issue #62)", () => {
    // AC10: minReviewerConfidence is an integer 0-100 -- unlike
    // requirePositiveNumber's knobs, 0 is valid and anything > 100 is not.
    test("minReviewerConfidence must be an integer 0-100", () => {
      for (const bad of [150, -1, 2.5, "70"]) {
        const cfg = goodConfig() as any;
        cfg.minReviewerConfidence = bad;
        expect(() => validateConfig(cfg)).toThrow(/minReviewerConfidence.*integer 0-100/);
      }
      const cfg = goodConfig() as any;
      cfg.minReviewerConfidence = 0;
      expect(() => validateConfig(cfg)).not.toThrow();
      cfg.minReviewerConfidence = 100;
      expect(() => validateConfig(cfg)).not.toThrow();
      delete cfg.minReviewerConfidence;
      expect(() => validateConfig(cfg)).not.toThrow();
    });

    // AC10: reviewerBelowThresholdAction is one of block|retry|off.
    test("reviewerBelowThresholdAction must be one of block|retry|off", () => {
      const cfg = goodConfig() as any;
      cfg.reviewerBelowThresholdAction = "nope";
      expect(() => validateConfig(cfg)).toThrow(/reviewerBelowThresholdAction.*block.*retry.*off/);
      for (const ok of ["block", "retry", "off"]) {
        cfg.reviewerBelowThresholdAction = ok;
        expect(() => validateConfig(cfg)).not.toThrow();
      }
      delete cfg.reviewerBelowThresholdAction;
      expect(() => validateConfig(cfg)).not.toThrow();
    });
  });

  // -- issue #76: the reviewer->builder bounce cap knob ------------------------
  describe("maxReviewBounces (issue #76)", () => {
    // AC3: 0, a negative, and a fraction are all rejected -- unlike
    // requirePositiveNumber's knobs (maxLanes etc.), which accept a fraction;
    // same integer + floor shape as auditEveryNLoops above.
    test.each([0, -1, 2.5, NaN, "2"])("rejects %p, naming the field and the integer >= 1 rule", (bad) => {
      const cfg = goodConfig() as any;
      cfg.maxReviewBounces = bad;
      expect(() => validateConfig(cfg)).toThrow(/"maxReviewBounces" must be a positive integer \(>= 1\)/);
    });

    test("accepts a positive integer and is optional", () => {
      const cfg = goodConfig() as any;
      cfg.maxReviewBounces = 4;
      expect(() => validateConfig(cfg)).not.toThrow();
      delete cfg.maxReviewBounces;
      expect(() => validateConfig(cfg)).not.toThrow();
    });
  });

  // -- issue #63: the human-needed safety-control threshold knob --------------
  describe("humanNeededPercent (issue #63)", () => {
    // AC12: 0 is the documented "disable" value (unlike maxLanes/watchdogMinutes
    // etc., which reject 0 via requirePositiveNumber) and must pass; a negative
    // must throw naming the field and the non-negative rule.
    test("0 passes (explicit disable value), a negative throws", () => {
      const cfg = goodConfig() as any;
      cfg.humanNeededPercent = 0;
      expect(() => validateConfig(cfg)).not.toThrow();
      cfg.humanNeededPercent = -5;
      expect(() => validateConfig(cfg)).toThrow(/humanNeededPercent.*non-negative/);
    });

    test("rejects a string, NaN, and Infinity", () => {
      for (const bad of ["30", NaN, Infinity]) {
        const cfg = goodConfig() as any;
        cfg.humanNeededPercent = bad;
        expect(() => validateConfig(cfg)).toThrow(/"humanNeededPercent" must be a non-negative number/);
      }
    });

    test("accepts a positive percent and is optional", () => {
      const cfg = goodConfig() as any;
      cfg.humanNeededPercent = 50;
      expect(() => validateConfig(cfg)).not.toThrow();
      delete cfg.humanNeededPercent;
      expect(() => validateConfig(cfg)).not.toThrow();
    });
  });

  // -- issue #82: per-stage model routing knob ---------------------------------
  describe("stageModels (issue #82)", () => {
    // AC4: an unknown stage name fails, naming the exact path.
    test("an unknown stage name fails, naming stageModels.<stage>", () => {
      const cfg = goodConfig() as any;
      cfg.stageModels = { deploy: "haiku" };
      expect(() => validateConfig(cfg)).toThrow(/stageModels\.deploy/);
    });

    // AC4: a non-string value on a KNOWN stage also fails, naming the path
    // (not the "unknown stage" message -- "merge" is a valid stage name).
    test("a non-string value on a known stage fails, naming stageModels.<stage>", () => {
      const cfg = goodConfig() as any;
      cfg.stageModels = { merge: 3 };
      expect(() => validateConfig(cfg)).toThrow(/stageModels\.merge/);
    });

    // AC7: a string that isn't a known rate key fails through the SAME lookup
    // z-cost/z-estimate use (resolveRate in lib/estimate.ts), naming the path.
    test("a model that is not a known rate key fails validation, naming stageModels.<stage>", () => {
      const cfg = goodConfig() as any;
      cfg.stageModels = { merge: "not-a-model" };
      expect(() => validateConfig(cfg)).toThrow(/stageModels\.merge/);
    });

    test('a real rate-key model ({"merge": "haiku"}) is accepted', () => {
      const cfg = goodConfig() as any;
      cfg.stageModels = { merge: "haiku" };
      expect(() => validateConfig(cfg)).not.toThrow();
    });

    // AC3: an explicit {} (the resolver's opt-out signal) is a perfectly valid
    // object as far as the schema is concerned -- the absent-vs-{} distinction
    // is the RESOLVER's job (lib/loop.ts resolveStageModel), not the schema's.
    test("an explicit {} passes", () => {
      const cfg = goodConfig() as any;
      cfg.stageModels = {};
      expect(() => validateConfig(cfg)).not.toThrow();
    });

    test("absent is optional and passes", () => {
      const cfg = goodConfig() as any;
      delete cfg.stageModels;
      expect(() => validateConfig(cfg)).not.toThrow();
    });

    test("a non-object stageModels fails", () => {
      const cfg = goodConfig() as any;
      cfg.stageModels = "haiku";
      expect(() => validateConfig(cfg)).toThrow(/"stageModels" must be an object/);
    });

    // Issue #106: same array-as-object hole as quota/notifications, fixed
    // consistently across every `typeof x === "object"` guard in
    // config-schema.ts -- validateStageModels is the named sibling.
    test("a bare array is rejected, not silently accepted as a valid object", () => {
      const cfg = goodConfig() as any;
      cfg.stageModels = ["haiku"];
      expect(() => validateConfig(cfg)).toThrow(/"stageModels" must be an object/);
    });
  });
});

// -- loadConfig surfaces schema errors (deep validation is wired in) ---------
describe("loadConfig deep validation", () => {
  const homes: string[] = [];
  afterEach(() => {
    while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
  });
  function writeRaw(slug: string, cfg: object): string {
    const home = mkdtempSync(join(tmpdir(), "zstack-badcfg-"));
    homes.push(home);
    const dir = join(home, ".zstack", "projects", slug);
    require("node:fs").mkdirSync(dir, { recursive: true });
    require("node:fs").writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));
    return home;
  }

  test("a key-complete but structurally-invalid config fails loudly at load", () => {
    // All required top-level keys present, but Status has no option map.
    const home = writeRaw("zstack", {
      slug: "zstack",
      owner: "zacgoodwin",
      repo: "zstack",
      projectNumber: 1,
      projectId: "PVT_1",
      repositoryId: "R_1",
      statusField: { id: "F_status", dataType: "SINGLE_SELECT" },
      fields: {},
    });
    expect(() => loadConfig("zstack", home)).toThrow(/is invalid:.*statusField\.options/);
  });

  // -- issue #18 AC2/AC3: auditEveryNLoops end to end through loadConfig -------
  function validRawConfig(extra: object = {}): object {
    return {
      slug: "zstack",
      owner: "zacgoodwin",
      repo: "zstack",
      projectNumber: 1,
      projectId: "PVT_1",
      repositoryId: "R_1",
      statusField: { id: "F_status", dataType: "SINGLE_SELECT", options: { Backlog: "o1", Done: "o2" } },
      fields: {},
      ...extra,
    };
  }

  test("AC3: auditEveryNLoops 0, -1, and 2.5 all fail loadConfig, naming the field + integer >= 1 rule", () => {
    for (const bad of [0, -1, 2.5]) {
      const home = writeRaw("zstack", validRawConfig({ auditEveryNLoops: bad }));
      expect(() => loadConfig("zstack", home)).toThrow(/"auditEveryNLoops" must be a positive integer \(>= 1\)/);
    }
  });

  test("AC2: auditEveryNLoops absent -> loadConfig defaults it to 5 (existing every-5th-loop behavior unchanged)", () => {
    const home = writeRaw("zstack", validRawConfig());
    expect(loadConfig("zstack", home).auditEveryNLoops).toBe(5);
  });

  test("AC1: auditEveryNLoops 3 in config.json is honored through loadConfig, not overridden by the default", () => {
    const home = writeRaw("zstack", validRawConfig({ auditEveryNLoops: 3 }));
    expect(loadConfig("zstack", home).auditEveryNLoops).toBe(3);
  });

  // -- issue #41: maxQaPasses / qaInvestigateAfter end to end through loadConfig,
  // same positive-number contract as maxLanes (AC4).
  test("AC4: maxQaPasses 0, negative, or non-numeric fails loadConfig, naming the key (same as maxLanes)", () => {
    for (const bad of [0, -1, "3"]) {
      const home = writeRaw("zstack", validRawConfig({ maxQaPasses: bad }));
      expect(() => loadConfig("zstack", home)).toThrow(/"maxQaPasses" must be a positive number/);
    }
  });

  test("AC4: qaInvestigateAfter 0, negative, or non-numeric fails loadConfig, naming the key", () => {
    for (const bad of [0, -1, "2"]) {
      const home = writeRaw("zstack", validRawConfig({ qaInvestigateAfter: bad }));
      expect(() => loadConfig("zstack", home)).toThrow(/"qaInvestigateAfter" must be a positive number/);
    }
  });

  test("AC1: maxQaPasses/qaInvestigateAfter absent -> loadConfig defaults them to 3 / 2", () => {
    const home = writeRaw("zstack", validRawConfig());
    const cfg = loadConfig("zstack", home);
    expect(cfg.maxQaPasses).toBe(3);
    expect(cfg.qaInvestigateAfter).toBe(2);
  });

  test("explicit maxQaPasses/qaInvestigateAfter in config.json are honored through loadConfig, not overridden by the default", () => {
    const home = writeRaw("zstack", validRawConfig({ maxQaPasses: 5, qaInvestigateAfter: 1 }));
    const cfg = loadConfig("zstack", home);
    expect(cfg.maxQaPasses).toBe(5);
    expect(cfg.qaInvestigateAfter).toBe(1);
  });

  // -- issue #76: maxReviewBounces end to end through loadConfig, same
  // integer + floor contract as auditEveryNLoops (AC3).
  test("AC3: maxReviewBounces 0, negative, or fractional fails loadConfig, naming the key and the integer >= 1 rule", () => {
    for (const bad of [0, -1, 2.5]) {
      const home = writeRaw("zstack", validRawConfig({ maxReviewBounces: bad }));
      expect(() => loadConfig("zstack", home)).toThrow(/"maxReviewBounces" must be a positive integer \(>= 1\)/);
    }
  });

  test("AC3: maxReviewBounces absent -> loadConfig defaults it to 2", () => {
    const home = writeRaw("zstack", validRawConfig());
    expect(loadConfig("zstack", home).maxReviewBounces).toBe(2);
  });

  test("explicit maxReviewBounces in config.json is honored through loadConfig, not overridden by the default", () => {
    const home = writeRaw("zstack", validRawConfig({ maxReviewBounces: 5 }));
    expect(loadConfig("zstack", home).maxReviewBounces).toBe(5);
  });

  // -- issue #58: tickThrottleSeconds default-and-override through loadConfig --
  test("AC1: tickThrottleSeconds absent -> loadConfig defaults it to 0 (today's behavior unchanged)", () => {
    const home = writeRaw("zstack", validRawConfig());
    expect(loadConfig("zstack", home).tickThrottleSeconds).toBe(0);
  });

  test("AC2: tickThrottleSeconds 120 in config.json is honored through loadConfig, not overridden by the default", () => {
    const home = writeRaw("zstack", validRawConfig({ tickThrottleSeconds: 120 }));
    expect(loadConfig("zstack", home).tickThrottleSeconds).toBe(120);
  });
});
