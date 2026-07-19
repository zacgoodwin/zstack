// Gate tests for C2: the z-board GitHub Projects contract. Every subcommand is
// exercised against recorded GraphQL fixtures with an injected executor, so the
// suite is deterministic, free, and hits zero network (the gh token has no
// project scope and no live board exists). Covers the four acceptance criteria:
// per-subcommand fixtures, the quota guard, the grep contract-enforcement gate,
// and claim atomicity.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, ZError, type GraphQLExecutor, type GraphQLData } from "../lib/board.ts";
import { loadConfig, resolveSlug, type BoardConfig } from "../lib/config.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const FIXTURES = join(import.meta.dir, "fixtures", "graphql");

const CFG: BoardConfig = {
  slug: "zstack",
  owner: "zacgoodwin",
  repo: "zstack",
  projectNumber: 1,
  projectId: "PVT_1",
  repositoryId: "R_1",
  statusField: {
    id: "F_status",
    dataType: "SINGLE_SELECT",
    options: { Todo: "opt_todo", "In progress": "opt_ip", Done: "opt_done" },
  },
  fields: {
    Model: { id: "F_model", dataType: "SINGLE_SELECT", options: { opus: "opt_opus", sonnet: "opt_sonnet" } },
    "Model Effort": { id: "F_effort", dataType: "SINGLE_SELECT", options: { high: "opt_high", low: "opt_low" } },
    Estimate: { id: "F_est", dataType: "NUMBER" },
    Actual: { id: "F_act", dataType: "NUMBER" },
  },
  quota: { threshold: 200, mode: "sleep" },
};

const FIXTURE_BY_OP: Record<string, string> = {
  ProjectItems: "project-items",
  IssueLookup: "issue-lookup",
  FieldValue: "field-value-model",
  RepoMeta: "repo-meta",
  CreateIssue: "create-issue",
  CreateIssueLabeled: "create-issue",
  AddProjectItem: "add-project-item",
  SetSingleSelect: "set-field",
  SetNumber: "set-field",
  SetText: "set-field",
  AddComment: "add-comment",
  UpdateIssueBody: "update-body",
};

function opName(query: string): string {
  const m = query.match(/(?:query|mutation)\s+(\w+)/);
  if (!m) throw new Error(`cannot name operation: ${query.slice(0, 40)}`);
  return m[1];
}

function loadFixture(name: string): GraphQLData {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
}

interface Call {
  op: string;
  vars: Record<string, any>;
}

// Fixture-routing executor. Overrides win; otherwise RateLimit uses the named
// rate-limit fixture (healthy by default) and every other op maps to its
// recorded response. `calls` records the exact operations a subcommand issues.
function makeExecutor(
  opts: {
    rateLimit?: string;
    overrides?: Record<string, GraphQLData | ((vars: any) => GraphQLData)>;
    calls?: Call[];
  } = {}
): GraphQLExecutor {
  return async (query, variables) => {
    const op = opName(query);
    opts.calls?.push({ op, vars: variables });
    const override = opts.overrides?.[op];
    if (override !== undefined) {
      return typeof override === "function" ? override(variables) : override;
    }
    if (op === "RateLimit") return loadFixture(opts.rateLimit ?? "rate-limit-healthy");
    const fixture = FIXTURE_BY_OP[op];
    if (!fixture) throw new Error(`no fixture registered for op ${op}`);
    return loadFixture(fixture);
  };
}

const tmpPaths: string[] = [];
function tmpBodyFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "zboard-"));
  tmpPaths.push(dir);
  const file = join(dir, "body.md");
  writeFileSync(file, content);
  return file;
}

afterEach(() => {
  while (tmpPaths.length) rmSync(tmpPaths.pop()!, { recursive: true, force: true });
});

// -- AC1: every subcommand against fixtures, zero network --------------------
describe("list", () => {
  test("returns items in a status with their fields", async () => {
    const board = new Board(CFG, makeExecutor());
    const items = await board.list("In progress");
    expect(items.map((i) => i.number)).toEqual([5, 6]);
    expect(items[0].fields.Model).toBe("opus");
    expect(items[0].fields.Estimate).toBe(6);
  });

  test("filters out other statuses", async () => {
    const board = new Board(CFG, makeExecutor());
    const done = await board.list("Done");
    expect(done.map((i) => i.number)).toEqual([4]);
  });

  test("unknown status lists the valid set", async () => {
    const board = new Board(CFG, makeExecutor());
    await expect(board.list("Backlog")).rejects.toThrow(/Unknown status "Backlog".*Todo.*In progress.*Done/);
  });
});

describe("move", () => {
  test("sets the Status single-select option", async () => {
    const calls: Call[] = [];
    const board = new Board(CFG, makeExecutor({ calls }));
    await board.move(5, "Done");
    const set = calls.find((c) => c.op === "SetSingleSelect")!;
    expect(set.vars).toMatchObject({ item: "PVTI_5", field: "F_status", option: "opt_done" });
  });

  test("unknown status rejects before any mutation", async () => {
    const calls: Call[] = [];
    const board = new Board(CFG, makeExecutor({ calls }));
    await expect(board.move(5, "Shipped")).rejects.toThrow(/Unknown status/);
    expect(calls.some((c) => c.op === "SetSingleSelect")).toBe(false);
  });
});

describe("comment", () => {
  test("adds a comment with the body-file contents", async () => {
    const calls: Call[] = [];
    const board = new Board(CFG, makeExecutor({ calls }));
    const file = tmpBodyFile("Hello from a body file.\n");
    await board.comment(5, file);
    const add = calls.find((c) => c.op === "AddComment")!;
    expect(add.vars).toMatchObject({ subject: "I_5", body: "Hello from a body file.\n" });
  });
});

describe("field-get / field-set", () => {
  test("field-get reads a custom field by name", async () => {
    const board = new Board(CFG, makeExecutor());
    expect(await board.fieldGet(5, "Model")).toBe("opus");
  });

  test("field-get unknown field lists the valid set", async () => {
    const board = new Board(CFG, makeExecutor());
    await expect(board.fieldGet(5, "Priority")).rejects.toThrow(/Unknown field.*Model.*Estimate.*Actual/);
  });

  test("field-set on a NUMBER field sends a numeric value", async () => {
    const calls: Call[] = [];
    const board = new Board(CFG, makeExecutor({ calls }));
    await board.fieldSet(5, "Estimate", "6.0");
    const set = calls.find((c) => c.op === "SetNumber")!;
    expect(set.vars).toMatchObject({ field: "F_est", number: 6 });
  });

  test("field-set on a SINGLE_SELECT field resolves the option id", async () => {
    const calls: Call[] = [];
    const board = new Board(CFG, makeExecutor({ calls }));
    await board.fieldSet(5, "Model", "opus");
    const set = calls.find((c) => c.op === "SetSingleSelect")!;
    expect(set.vars).toMatchObject({ field: "F_model", option: "opt_opus" });
  });

  test("field-set rejects an unknown single-select value", async () => {
    const board = new Board(CFG, makeExecutor());
    await expect(board.fieldSet(5, "Model", "gpt5")).rejects.toThrow(/Unknown value "gpt5".*opus.*sonnet/);
  });

  test("field-set rejects a non-numeric value for a NUMBER field", async () => {
    const board = new Board(CFG, makeExecutor());
    await expect(board.fieldSet(5, "Estimate", "soon")).rejects.toThrow(/expects a number/);
  });
});

describe("create", () => {
  test("creates an issue against a resolved milestone", async () => {
    const calls: Call[] = [];
    const board = new Board(CFG, makeExecutor({ calls }));
    const file = tmpBodyFile("Body.");
    const issue = await board.create("New ticket", file, "zstack-v1");
    expect(issue.number).toBe(42);
    const create = calls.find((c) => c.op === "CreateIssue")!;
    expect(create.vars).toMatchObject({ milestone: "MS_v1", title: "New ticket" });
  });

  test("attaches a resolved label when --label is given", async () => {
    const calls: Call[] = [];
    const board = new Board(CFG, makeExecutor({ calls }));
    const file = tmpBodyFile("Body.");
    await board.create("New ticket", file, "zstack-v1", "bug");
    const create = calls.find((c) => c.op === "CreateIssueLabeled")!;
    expect(create.vars).toMatchObject({ milestone: "MS_v1", label: "LBL_bug" });
  });

  // Fold-in gap from C2 (issue #5): create must also add the issue to the board.
  test("adds the created issue to the project board", async () => {
    const calls: Call[] = [];
    const board = new Board(CFG, makeExecutor({ calls }));
    const file = tmpBodyFile("Body.");
    await board.create("New ticket", file, "zstack-v1");
    const add = calls.find((c) => c.op === "AddProjectItem")!;
    expect(add).toBeDefined();
    expect(add.vars).toMatchObject({ project: "PVT_1", content: "I_42" });
  });

  test("unknown milestone lists the valid set", async () => {
    const board = new Board(CFG, makeExecutor());
    const file = tmpBodyFile("Body.");
    await expect(board.create("T", file, "zstack-v9")).rejects.toThrow(/Milestone "zstack-v9" not found.*zstack-v1/);
  });

  test("unknown label lists the valid set", async () => {
    const board = new Board(CFG, makeExecutor());
    const file = tmpBodyFile("Body.");
    await expect(board.create("T", file, "zstack-v1", "urgent")).rejects.toThrow(/Label "urgent" not found.*bug/);
  });
});

describe("link", () => {
  test("records the dependency both directions with body line + comment", async () => {
    const calls: Call[] = [];
    const perIssue = (vars: any): GraphQLData => ({
      repository: {
        issue: {
          id: `I_${vars.number}`,
          number: vars.number,
          title: `#${vars.number}`,
          body: "Body.",
          assignees: { nodes: [] },
          projectItems: { nodes: [{ id: `PVTI_${vars.number}`, project: { number: 1 } }] },
        },
      },
    });
    const board = new Board(CFG, makeExecutor({ calls, overrides: { IssueLookup: perIssue } }));
    await board.link(5, 6);

    const comments = calls.filter((c) => c.op === "AddComment");
    expect(comments.map((c) => c.vars.body).sort()).toEqual(["Blocks #5", "Depends on #6"]);
    const bodies = calls.filter((c) => c.op === "UpdateIssueBody");
    expect(bodies.find((c) => c.vars.id === "I_5")!.vars.body).toContain("Depends on #6");
    expect(bodies.find((c) => c.vars.id === "I_6")!.vars.body).toContain("Blocks #5");
  });

  test("is idempotent: an already-present line is skipped", async () => {
    const calls: Call[] = [];
    const linked = (vars: any): GraphQLData => ({
      repository: {
        issue: {
          id: `I_${vars.number}`,
          number: vars.number,
          title: `#${vars.number}`,
          body: vars.number === 5 ? "Body.\n\nDepends on #6" : "Body.\n\nBlocks #5",
          assignees: { nodes: [] },
          projectItems: { nodes: [{ id: `PVTI_${vars.number}`, project: { number: 1 } }] },
        },
      },
    });
    const board = new Board(CFG, makeExecutor({ calls, overrides: { IssueLookup: linked } }));
    await board.link(5, 6);
    expect(calls.some((c) => c.op === "AddComment")).toBe(false);
    expect(calls.some((c) => c.op === "UpdateIssueBody")).toBe(false);
  });
});

describe("quota subcommand", () => {
  test("reports remaining points without gating", async () => {
    const board = new Board(CFG, makeExecutor({ rateLimit: "rate-limit-low" }));
    const q = await board.quota();
    expect(q.remaining).toBe(150);
  });
});

// -- AC2: quota guard inside the GraphQL wrapper -----------------------------
describe("quota guard", () => {
  const at = (iso: string) => Date.parse(iso);

  test("remaining below threshold: sleeps until reset, then proceeds", async () => {
    const slept: number[] = [];
    const board = new Board(
      CFG,
      makeExecutor({ rateLimit: "rate-limit-low" }),
      async (ms) => void slept.push(ms),
      () => at("2026-07-18T23:00:00Z")
    );
    const items = await board.list("In progress");
    expect(slept).toEqual([at("2026-07-18T23:30:00Z") - at("2026-07-18T23:00:00Z")]);
    expect(items.length).toBeGreaterThan(0); // call still went through after the wait
  });

  test("remaining above threshold: proceeds without sleeping", async () => {
    const slept: number[] = [];
    const board = new Board(CFG, makeExecutor({ rateLimit: "rate-limit-ok" }), async (ms) => void slept.push(ms));
    await board.list("In progress");
    expect(slept).toEqual([]);
  });

  test("abort mode: rejects instead of sleeping", async () => {
    const slept: number[] = [];
    const abortCfg: BoardConfig = { ...CFG, quota: { threshold: 200, mode: "abort" } };
    const board = new Board(abortCfg, makeExecutor({ rateLimit: "rate-limit-low" }), async (ms) => void slept.push(ms));
    await expect(board.list("In progress")).rejects.toThrow(/quota exhausted/);
    expect(slept).toEqual([]);
  });

  test("missing rateLimit fails loudly instead of running unguarded (fix 2)", async () => {
    const slept: number[] = [];
    const board = new Board(CFG, makeExecutor({ overrides: { RateLimit: {} } }), async (ms) => void slept.push(ms));
    await expect(board.list("In progress")).rejects.toThrow(/rateLimit probe returned no usable/);
    expect(slept).toEqual([]); // guard threw; no call slipped through
  });

  test("a malformed rateLimit (non-numeric remaining) fails loudly (fix 2)", async () => {
    const board = new Board(
      CFG,
      makeExecutor({ overrides: { RateLimit: { rateLimit: { remaining: "lots", resetAt: "2026-07-18T23:30:00Z" } } } })
    );
    await expect(board.list("In progress")).rejects.toThrow(/rateLimit probe returned no usable/);
  });

  test("an unparseable resetAt throws instead of sleep(NaN) hammering the API (fix 3)", async () => {
    const slept: number[] = [];
    const board = new Board(
      CFG,
      makeExecutor({ overrides: { RateLimit: { rateLimit: { remaining: 150, resetAt: "not-a-date" } } } }),
      async (ms) => void slept.push(ms),
      () => at("2026-07-18T23:00:00Z")
    );
    await expect(board.list("In progress")).rejects.toThrow(/resetAt is not a parseable timestamp/);
    expect(slept).toEqual([]); // never slept, let alone slept(NaN)
  });
});

// -- AC4: claim atomicity ----------------------------------------------------
// A stateful in-memory backend shared by "concurrent" Board instances. Assignee
// mutations are additive and returned in assignment order, exactly as GitHub
// behaves, so the contract's first-assignee-wins tiebreaker is what gets tested.
function claimBackend(initial: string[] = []) {
  const assignees = [...initial];
  const login = (userId: string) => userId.replace(/^U_/, "");
  const exec: GraphQLExecutor = async (query, vars: any) => {
    switch (opName(query)) {
      case "RateLimit":
        return { rateLimit: { remaining: 5000, resetAt: "2026-07-19T00:00:00Z" } };
      case "IssueLookup":
        return {
          repository: {
            issue: {
              id: "I_9",
              number: 9,
              title: "ticket",
              body: "",
              assignees: { nodes: assignees.map((l) => ({ login: l })) },
              projectItems: { nodes: [{ id: "PVTI_9", project: { number: 1 } }] },
            },
          },
        };
      case "UserId":
        return { user: { id: `U_${vars.login}` } };
      case "AddAssignees": {
        const l = login(vars.user);
        if (!assignees.includes(l)) assignees.push(l);
        return { addAssigneesToAssignable: { clientMutationId: null } };
      }
      case "RemoveAssignees": {
        const i = assignees.indexOf(login(vars.user));
        if (i >= 0) assignees.splice(i, 1);
        return { removeAssigneesFromAssignable: { clientMutationId: null } };
      }
      case "IssueAssignees":
        return { repository: { issue: { assignees: { nodes: assignees.map((l) => ({ login: l })) } } } };
      default:
        throw new Error(`claimBackend: unexpected op ${opName(query)}`);
    }
  };
  return { exec, assignees };
}

describe("claim", () => {
  test("claims an unassigned issue", async () => {
    const backend = claimBackend();
    const board = new Board(CFG, backend.exec);
    await board.claim(9, "alice");
    expect(backend.assignees).toEqual(["alice"]);
  });

  test("rejects an already-claimed issue", async () => {
    const backend = claimBackend(["bob"]);
    const board = new Board(CFG, backend.exec);
    await expect(board.claim(9, "alice")).rejects.toThrow(/already claimed by bob/);
    expect(backend.assignees).toEqual(["bob"]);
  });

  test("two concurrent claims: exactly one succeeds", async () => {
    const backend = claimBackend();
    const boardA = new Board(CFG, backend.exec);
    const boardB = new Board(CFG, backend.exec);
    const results = await Promise.allSettled([boardA.claim(9, "alice"), boardB.claim(9, "bob")]);
    const won = results.filter((r) => r.status === "fulfilled");
    expect(won.length).toBe(1);
    expect(backend.assignees.length).toBe(1); // loser backed its assignment out
  });
});

// -- release (C7, issue #2): reconcile a stale claim -------------------------
describe("release", () => {
  test("removes every assignee so a future loop can re-claim", async () => {
    const backend = claimBackend(["alice"]);
    const board = new Board(CFG, backend.exec);
    const removed = await board.release(9);
    expect(removed).toEqual(["alice"]);
    expect(backend.assignees).toEqual([]);
  });

  test("is a no-op on an unassigned issue", async () => {
    const backend = claimBackend();
    const board = new Board(CFG, backend.exec);
    expect(await board.release(9)).toEqual([]);
    expect(backend.assignees).toEqual([]);
  });
});

// -- AC3: grep contract-enforcement gate for the whole pack ------------------
describe("contract enforcement", () => {
  function trackedFiles(): string[] {
    const proc = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
    });
    return proc.stdout.toString().split(/\r?\n/).filter(Boolean);
  }

  test("only lib/board.ts calls gh api graphql or gh issue directly", () => {
    const files = trackedFiles().filter(
      (f) =>
        f !== "lib/board.ts" &&
        !f.startsWith("tests/") &&
        !f.startsWith("references/") &&
        !f.endsWith(".md") &&
        !f.endsWith(".png")
    );
    const offenders: string[] = [];
    for (const f of files) {
      const content = readFileSync(join(REPO_ROOT, f), "utf8");
      if (/\bgh\s+api\s+graphql\b/.test(content) || /\bgh\s+issue\b/.test(content)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  test("lib/board.ts is in fact the caller (guards against the gate passing vacuously)", () => {
    const content = readFileSync(join(REPO_ROOT, "lib", "board.ts"), "utf8");
    expect(/\bgh\b/.test(content) && content.includes("api")).toBe(true);
  });
});

// -- config contract C3 will write against -----------------------------------
describe("config loader", () => {
  const homes: string[] = [];
  function makeHome(): string {
    const dir = mkdtempSync(join(tmpdir(), "zstack-home-"));
    homes.push(dir);
    return dir;
  }
  function writeConfig(home: string, slug: string, cfg: object) {
    const dir = join(home, ".zstack", "projects", slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));
  }
  afterEach(() => {
    while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
  });

  test("missing config points the user at /z-setup", () => {
    const home = makeHome();
    expect(() => loadConfig("ghost", home)).toThrow(/\/z-setup/);
  });

  test("reads a written config and applies quota defaults", () => {
    const home = makeHome();
    const written = { ...CFG, quota: undefined };
    writeConfig(home, "zstack", written);
    const loaded = loadConfig("zstack", home);
    expect(loaded.projectId).toBe("PVT_1");
    expect(loaded.quota).toEqual({ threshold: 200, mode: "sleep" });
    expect(loaded.lockStalenessMinutes).toBe(60); // C7 default applied (issue #2)
  });

  test("malformed config (missing keys) names what is missing", () => {
    const home = makeHome();
    writeConfig(home, "zstack", { slug: "zstack" });
    expect(() => loadConfig("zstack", home)).toThrow(/missing:.*owner/);
  });

  test("resolveSlug auto-detects the sole configured project", () => {
    const saved = process.env.ZSTACK_SLUG;
    delete process.env.ZSTACK_SLUG;
    try {
      const home = makeHome();
      writeConfig(home, "only-one", CFG);
      expect(resolveSlug(undefined, home)).toBe("only-one");
    } finally {
      if (saved !== undefined) process.env.ZSTACK_SLUG = saved;
    }
  });
});
