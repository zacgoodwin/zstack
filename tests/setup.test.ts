// Gate tests for C3: the /z-setup deterministic half (lib/setup-board.ts) and
// config schema (lib/config-schema.ts). Everything runs against an in-memory
// stateful backend or synthetic ProjectState objects -- zero network, well under
// the 2s gate budget. Covers issue #1's acceptance criteria: scripted verify,
// creation vs adoption, idempotence (a re-run plans zero mutations), and schema
// validation that fails loudly with the field named.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SetupBoard,
  diffState,
  verifyReport,
  writeConfig,
  STATUS_OPTIONS,
  CUSTOM_FIELDS,
  type FieldState,
  type ProjectState,
} from "../lib/setup-board.ts";
import { loadConfig, type BoardConfig } from "../lib/config.ts";
import { validateConfig } from "../lib/config-schema.ts";
import type { GraphQLData, GraphQLExecutor } from "../lib/board.ts";

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
interface BackendProject {
  id: string;
  number: number;
  title: string;
  fields: BackendField[];
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
function setupBackend(existing?: BackendProject) {
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
    await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack" });

    const before = backend.calls.length;
    const second = await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack" });
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
    const result = await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack" });
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
    });
    expect(result.created).toBe(false);
    expect(backend.calls.some((c) => c.op === "ProjectByNumber")).toBe(true);
    expect(backend.calls.some((c) => c.op === "Projects")).toBe(false);
  });
});

// -- writeConfig round-trip --------------------------------------------------
describe("writeConfig", () => {
  const homes: string[] = [];
  afterEach(() => {
    while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
  });
  function makeHome(): string {
    const dir = mkdtempSync(join(tmpdir(), "zstack-setup-home-"));
    homes.push(dir);
    return dir;
  }

  test("writes a config that loadConfig reads back cleanly", async () => {
    const backend = setupBackend();
    const setup = new SetupBoard(backend.exec);
    const result = await setup.apply("zacgoodwin", "zstack", { slug: "zstack", title: "zstack" });

    const home = makeHome();
    const path = writeConfig(result.config, home);
    expect(path).toContain(join(".zstack", "projects", "zstack", "config.json"));

    const loaded = loadConfig("zstack", home);
    expect(loaded.projectId).toBe("PVT_new");
    expect(loaded.statusField.options!.Done).toBeDefined();
    expect(loaded.maxLanes).toBe(3);
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
});
