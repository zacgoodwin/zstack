// Gate tests for C2: the z-board GitHub Projects contract. Every subcommand is
// exercised against recorded GraphQL fixtures with an injected executor, so the
// suite is deterministic, free, and hits zero network (the gh token has no
// project scope and no live board exists). Covers the four acceptance criteria:
// per-subcommand fixtures, the quota guard, the grep contract-enforcement gate,
// and claim atomicity.
import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Board,
  ZError,
  ghExecutor,
  type GraphQLExecutor,
  type GraphQLData,
  type GhSpawn,
  type GhProc,
} from "../lib/board.ts";
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
    const data = loadFixture(fixture);
    // The recorded project-items fixture predates the F3 malformed-response
    // guard and omits pageInfo; a REAL ProjectItems response always carries it
    // (it is selected in the query), so complete the recording here rather
    // than weaken the guard.
    if (op === "ProjectItems" && data.node?.items && !data.node.items.pageInfo) {
      data.node.items.pageInfo = { hasNextPage: false, endCursor: null };
    }
    return data;
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
  // Shapes one ProjectItems page; status parameterized so multi-status boards
  // can be modeled (F0 all-statuses list).
  const page = (
    numbers: number[],
    pageInfo: { hasNextPage: boolean; endCursor: string | null },
    status = "Todo"
  ) => ({
    node: {
      items: {
        pageInfo,
        nodes: numbers.map((n) => ({
          content: { number: n, title: `T${n}`, url: `http://x/${n}` },
          fieldValues: {
            nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: status, field: { name: "Status" } }],
          },
        })),
      },
    },
  });

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

  // F0: --status is optional; the no-status list is the one-call atomic
  // snapshot contract z-status consumes (`z-board list --json`).
  test("list() with no status returns every item across statuses", async () => {
    const board = new Board(CFG, makeExecutor());
    const items = await board.list();
    expect(items.map((i) => i.number)).toEqual([4, 5, 6]);
    expect(new Set(items.map((i) => i.fields.Status))).toEqual(new Set(["Done", "In progress"]));
  });

  test("no-status list still paginates past 100 items and spans statuses (F0)", async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => i + 1);
    const calls: Call[] = [];
    const board = new Board(
      CFG,
      makeExecutor({
        calls,
        overrides: {
          ProjectItems: (vars) =>
            vars.cursor === "CUR_100"
              ? page([101], { hasNextPage: false, endCursor: null }, "Done")
              : page(firstPage, { hasNextPage: true, endCursor: "CUR_100" }, "Todo"),
        },
      })
    );
    const items = await board.list();
    expect(items.length).toBe(101);
    expect(new Set(items.map((i) => i.fields.Status))).toEqual(new Set(["Todo", "Done"]));
    expect(calls.filter((c) => c.op === "ProjectItems").length).toBe(2); // followed the cursor
  });

  // Issue #14 item 1: >100-item boards silently dropped tickets before cursor
  // pagination. Two fake pages (100 + 1) must all come back.
  test("paginates past 100 items: a 101-item board lists fully", async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => i + 1);
    const calls: Call[] = [];
    const board = new Board(
      CFG,
      makeExecutor({
        calls,
        overrides: {
          ProjectItems: (vars) =>
            vars.cursor === "CUR_100"
              ? page([101], { hasNextPage: false, endCursor: null })
              : page(firstPage, { hasNextPage: true, endCursor: "CUR_100" }),
        },
      })
    );
    const items = await board.list("Todo");
    expect(items.map((i) => i.number)).toEqual([...firstPage, 101]);
    const reqs = calls.filter((c) => c.op === "ProjectItems");
    expect(reqs.length).toBe(2);
    expect(reqs[0].vars.cursor).toBeUndefined();
    expect(reqs[1].vars.cursor).toBe("CUR_100"); // the loop actually followed the cursor
  });

  test("hasNextPage without an endCursor throws instead of silently truncating", async () => {
    const board = new Board(
      CFG,
      makeExecutor({
        overrides: {
          ProjectItems: { node: { items: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] } } },
        },
      })
    );
    await expect(board.list("Todo")).rejects.toThrow(/no endCursor/);
  });

  test("hasNextPage with an empty-string endCursor throws instead of looping (F3a)", async () => {
    let fetches = 0;
    const board = new Board(
      CFG,
      makeExecutor({
        overrides: {
          ProjectItems: () => {
            // Bounded fake: with the guard gone this test must FAIL fast, not
            // hang the suite looping on the "" cursor.
            if (++fetches > 4) throw new Error("cursor loop did not terminate");
            return { node: { items: { pageInfo: { hasNextPage: true, endCursor: "" }, nodes: [] } } };
          },
        },
      })
    );
    await expect(board.list("Todo")).rejects.toThrow(/no endCursor/);
    expect(fetches).toBe(1); // refused on the first malformed page
  });

  test("an endCursor that does not advance throws instead of refetching forever (F3b)", async () => {
    let fetches = 0;
    const board = new Board(
      CFG,
      makeExecutor({
        overrides: {
          ProjectItems: () => {
            // Bounded fake: with the guard gone this test must FAIL fast on the
            // wrong error, never hang the suite in the real infinite loop.
            if (++fetches > 4) throw new Error("cursor loop did not terminate");
            return page([1], { hasNextPage: true, endCursor: "CUR_STUCK" });
          },
        },
      })
    );
    await expect(board.list("Todo")).rejects.toThrow(/same endCursor/);
    expect(fetches).toBe(2); // page 1 issued CUR_STUCK, page 2 repeated it
  });

  test("a page with items but no pageInfo throws instead of reporting the board drained (F3c)", async () => {
    const board = new Board(
      CFG,
      makeExecutor({
        overrides: {
          ProjectItems: {
            node: {
              items: {
                nodes: [{ content: { number: 1, title: "T1", url: "http://x/1" }, fieldValues: { nodes: [] } }],
              },
            },
          },
        },
      })
    );
    await expect(board.list("Todo")).rejects.toThrow(/no pageInfo/);
  });
});

// Ceilings assessed per issue #14 item 1: nested/bounded lists are not
// paginated; instead overflow must throw loudly, never truncate.
describe("single-page ceiling guards", () => {
  test("fieldValues overflow (>20 values on an item) throws", async () => {
    const board = new Board(
      CFG,
      makeExecutor({
        overrides: {
          ProjectItems: {
            node: {
              items: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    content: { number: 5, title: "T5", url: "http://x/5" },
                    fieldValues: { pageInfo: { hasNextPage: true }, nodes: [] },
                  },
                ],
              },
            },
          },
        },
      })
    );
    await expect(board.list("Todo")).rejects.toThrow(/fieldValues for issue #5.*truncated/);
  });

  test("an issue on more than 20 projects throws instead of 'not on project'", async () => {
    const board = new Board(
      CFG,
      makeExecutor({
        overrides: {
          IssueLookup: {
            repository: {
              issue: {
                id: "I_5",
                number: 5,
                title: "T5",
                body: "",
                assignees: { nodes: [] },
                projectItems: { pageInfo: { hasNextPage: true }, nodes: [] },
              },
            },
          },
        },
      })
    );
    await expect(board.move(5, "Done")).rejects.toThrow(/projectItems for issue #5.*truncated/);
  });

  test("milestones overflow throws instead of a bogus 'not found'", async () => {
    const board = new Board(
      CFG,
      makeExecutor({
        overrides: {
          RepoMeta: {
            repository: {
              id: "R_1",
              milestones: { pageInfo: { hasNextPage: true }, nodes: [] },
              labels: { pageInfo: { hasNextPage: false }, nodes: [] },
            },
          },
        },
      })
    );
    const file = tmpBodyFile("Body.");
    await expect(board.create("T", file, "zstack-v1")).rejects.toThrow(/milestones for .*truncated/);
  });
});

// -- ticket #57: one-call drain snapshot (items + bodies) --------------------
describe("snapshot", () => {
  const nodeWithBody = (n: number, status: string, body: string | null, labels: string[] = []) => ({
    content: {
      number: n,
      title: `T${n}`,
      url: `http://x/${n}`,
      body,
      labels: { pageInfo: { hasNextPage: false }, nodes: labels.map((name) => ({ name })) },
    },
    fieldValues: {
      pageInfo: { hasNextPage: false },
      nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: status, field: { name: "Status" } }],
    },
  });
  const boardPage = (nodes: any[]) => ({
    node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } },
  });

  test("emits all-status items PLUS each ticket's body in one ProjectItems pass (no N+1 lookups)", async () => {
    const calls: Call[] = [];
    const nodes = [nodeWithBody(4, "Done", "body four"), nodeWithBody(5, "In progress", "body five")];
    const board = new Board(CFG, makeExecutor({ calls, overrides: { ProjectItems: boardPage(nodes) } }));
    const snap = await board.snapshot();

    expect(snap.items.map((i) => i.number)).toEqual([4, 5]);
    expect(snap.items[0].fields.Status).toBe("Done");
    // Bodies keyed by issue number as a string -- exactly what loop.ts ingest consumes.
    expect(snap.bodies).toEqual({ "4": "body four", "5": "body five" });
    // Items are byte-identical to a plain all-status list() over the same board:
    // snapshot replaces the SKILL's hand-assembled 9-list + per-body fetch.
    const listBoard = new Board(CFG, makeExecutor({ overrides: { ProjectItems: boardPage(nodes) } }));
    expect(snap.items).toEqual(await listBoard.list());
    // One query pass, no per-issue IssueLookup fan-out (bodies ride content.body).
    expect(calls.filter((c) => c.op === "ProjectItems").length).toBe(1);
    expect(calls.some((c) => c.op === "IssueLookup")).toBe(false);
  });

  test("carries issue labels from content.labels onto BoardItem.labels (#130)", async () => {
    const board = new Board(
      CFG,
      makeExecutor({ overrides: { ProjectItems: boardPage([nodeWithBody(9, "Building", "b", ["skip-qa", "bug"])]) } })
    );
    const snap = await board.snapshot();
    expect(snap.items[0].labels).toEqual(["skip-qa", "bug"]);
    // An issue with no labels yields an empty array, never undefined.
    const bare = new Board(
      CFG,
      makeExecutor({ overrides: { ProjectItems: boardPage([nodeWithBody(10, "Building", "b")]) } })
    );
    expect((await bare.snapshot()).items[0].labels).toEqual([]);
  });

  test("a labels connection past its single page throws instead of dropping skip-qa (#130)", async () => {
    const overflowNode = {
      content: {
        number: 5,
        title: "T5",
        url: "http://x/5",
        body: "b",
        labels: { pageInfo: { hasNextPage: true }, nodes: [] },
      },
      fieldValues: { pageInfo: { hasNextPage: false }, nodes: [] },
    };
    const board = new Board(CFG, makeExecutor({ overrides: { ProjectItems: boardPage([overflowNode]) } }));
    await expect(board.snapshot()).rejects.toThrow(/labels for issue #5.*truncated/);
  });

  test("a ticket with a null/absent body serializes as an empty string, never undefined", async () => {
    const board = new Board(
      CFG,
      makeExecutor({ overrides: { ProjectItems: boardPage([nodeWithBody(7, "Ready", null)]) } })
    );
    const snap = await board.snapshot();
    expect(snap.bodies).toEqual({ "7": "" });
  });

  test("paginates past 100 items exactly like list() (bodies for every page)", async () => {
    const first = Array.from({ length: 100 }, (_, i) => nodeWithBody(i + 1, "Building", `b${i + 1}`));
    const board = new Board(
      CFG,
      makeExecutor({
        overrides: {
          ProjectItems: (vars) =>
            vars.cursor === "CUR_100"
              ? boardPage([nodeWithBody(101, "Done", "b101")])
              : { node: { items: { pageInfo: { hasNextPage: true, endCursor: "CUR_100" }, nodes: first } } },
        },
      })
    );
    const snap = await board.snapshot();
    expect(snap.items.length).toBe(101);
    expect(Object.keys(snap.bodies).length).toBe(101);
    expect(snap.bodies["101"]).toBe("b101");
  });

  // #127: a transient GitHub read can return 0 items for a board that really has
  // many (observed live: one snapshot returned 0, the next returned all 68).
  test("retries an empty read and returns the real items when a retry succeeds", async () => {
    let reads = 0;
    // First underlying ProjectItems read is a well-formed but EMPTY page (the
    // hiccup); the retry returns the real board. sleep injected as a no-op so the
    // gate test never touches the wall clock.
    const board = new Board(
      CFG,
      makeExecutor({
        overrides: {
          ProjectItems: () => (++reads === 1 ? boardPage([]) : boardPage([nodeWithBody(4, "Done", "b4")])),
        },
      }),
      () => Promise.resolve()
    );
    const snap = await board.snapshot();
    expect(snap.items.map((i) => i.number)).toEqual([4]); // the retry's items, not the empty first read
    expect(snap.bodies).toEqual({ "4": "b4" });
    expect(reads).toBe(2); // retried exactly once past the empty read
  });

  test("a genuinely empty board still returns [] once the bounded retries exhaust", async () => {
    let reads = 0;
    const board = new Board(
      CFG,
      makeExecutor({ overrides: { ProjectItems: () => (reads++, boardPage([])) } }),
      () => Promise.resolve()
    );
    const snap = await board.snapshot();
    expect(snap.items).toEqual([]);
    expect(reads).toBe(4); // initial read + 3 bounded retries, then trusts the empty
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

  // F4: Number("") and Number("  ") are 0 -- a blank from a failed upstream
  // pipeline (e.g. the cost pipeline writing Actual) must never silently zero
  // a board field, and non-finite values are equally corrupt.
  test("field-set NUMBER refuses blank and non-finite values with no mutation (F4)", async () => {
    for (const bad of ["", "  ", "abc", "Infinity", "NaN"]) {
      const calls: Call[] = [];
      const board = new Board(CFG, makeExecutor({ calls }));
      await expect(board.fieldSet(5, "Actual", bad)).rejects.toThrow(
        new RegExp(`Actual expects a number, got "${bad}"`)
      );
      expect(calls.some((c) => c.op === "SetNumber")).toBe(false); // refused before any mutation
    }
  });

  test("field-set NUMBER still accepts '3.5' and '0' (F4)", async () => {
    for (const [raw, num] of [["3.5", 3.5], ["0", 0]] as const) {
      const calls: Call[] = [];
      const board = new Board(CFG, makeExecutor({ calls }));
      await board.fieldSet(5, "Actual", raw);
      const set = calls.find((c) => c.op === "SetNumber")!;
      expect(set.vars.number).toBe(num);
    }
  });
});

// -- issue #14 item 18: TEXT field path + not-found branches ------------------
describe("fieldSet TEXT + not-found branches (item 18)", () => {
  // CFG has no TEXT field, so the M_SET_TEXT branch was never exercised.
  const TEXT_CFG: BoardConfig = {
    ...CFG,
    fields: { ...CFG.fields, Notes: { id: "F_notes", dataType: "TEXT" } },
  };

  test("field-set on a TEXT field routes through SetText with the raw string", async () => {
    const calls: Call[] = [];
    const board = new Board(TEXT_CFG, makeExecutor({ calls }));
    await board.fieldSet(5, "Notes", "hello world");
    const set = calls.find((c) => c.op === "SetText");
    expect(set).toBeDefined();
    expect(set!.vars).toMatchObject({ project: "PVT_1", item: "PVTI_5", field: "F_notes", text: "hello world" });
    // The TEXT path must not leak into the number/select mutations.
    expect(calls.some((c) => c.op === "SetNumber" || c.op === "SetSingleSelect")).toBe(false);
  });

  test("field-set on an unknown field lists the valid set and issues no mutation", async () => {
    const calls: Call[] = [];
    const board = new Board(CFG, makeExecutor({ calls }));
    await expect(board.fieldSet(5, "Priority", "high")).rejects.toThrow(/Unknown field "Priority".*Model.*Estimate.*Actual/);
    expect(calls.some((c) => c.op.startsWith("Set"))).toBe(false);
  });

  test("operations on a nonexistent issue raise a clear not-found ZError", async () => {
    const gone = { repository: { issue: null } };
    const board = new Board(CFG, makeExecutor({ overrides: { IssueLookup: gone } }));
    await expect(board.move(404, "Done")).rejects.toThrow(ZError);
    await expect(board.move(404, "Done")).rejects.toThrow(/Issue #404 not found in zacgoodwin\/zstack/);
    await expect(board.fieldSet(404, "Estimate", "3")).rejects.toThrow(/Issue #404 not found/);
    await expect(board.claim(404, "alice")).rejects.toThrow(/Issue #404 not found/);
  });

  test("field-get on a nonexistent issue raises the same not-found ZError, not a silent null", async () => {
    const gone = { repository: { issue: null } };
    const board = new Board(CFG, makeExecutor({ overrides: { FieldValue: gone } }));
    await expect(board.fieldGet(404, "Model")).rejects.toThrow(ZError);
    await expect(board.fieldGet(404, "Model")).rejects.toThrow(/Issue #404 not found in zacgoodwin\/zstack/);
  });

  test("field-get never falls back to another project's same-named field", async () => {
    const otherBoardOnly = {
      repository: {
        issue: {
          projectItems: {
            nodes: [
              { project: { number: 99 }, fieldValueByName: { __typename: "ProjectV2ItemFieldSingleSelectValue", name: "haiku" } },
            ],
          },
        },
      },
    };
    const board = new Board(CFG, makeExecutor({ overrides: { FieldValue: otherBoardOnly } }));
    await expect(board.fieldGet(5, "Model")).rejects.toThrow(/Issue #5 is not on project zstack \(#1\)/);
  });

  test("an issue that exists but is not on this project names project + slug", async () => {
    const offBoard = {
      repository: {
        issue: {
          id: "I_5",
          number: 5,
          title: "T5",
          body: "",
          assignees: { nodes: [] },
          projectItems: { nodes: [{ id: "PVTI_other", project: { number: 99 } }] },
        },
      },
    };
    const calls: Call[] = [];
    const board = new Board(CFG, makeExecutor({ calls, overrides: { IssueLookup: offBoard } }));
    await expect(board.fieldSet(5, "Estimate", "3")).rejects.toThrow(/Issue #5 is not on project zstack \(#1\)/);
    expect(calls.some((c) => c.op.startsWith("Set"))).toBe(false); // no mutation on the miss
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

// Stateful body backend for link (issue #14 item 10): bodies are real state and
// UpdateIssueBody is a last-write-wins snapshot, exactly like GitHub's
// updateIssue, so lost-update interleavings are reproducible. loseWrites
// simulates a concurrent writer clobbering our write (the re-read then misses
// our line, as it would live).
function linkBackend(
  initialBodies: Record<number, string>,
  opts: {
    loseWrites?: (id: string) => boolean;
    // F1 verify-path fixture: what the store actually keeps for a write --
    // lets a test model a concurrent clobber that REPLACES our body with
    // different content (loseWrites can only drop the write wholesale).
    transformWrite?: (id: string, body: string) => string;
    // F2: yield a macrotask per op so unserialized concurrent flows interleave
    // deterministically instead of depending on microtask scheduling order.
    delay?: boolean;
  } = {}
) {
  const bodies: Record<string, string> = {};
  for (const [n, b] of Object.entries(initialBodies)) bodies[`I_${n}`] = b;
  const calls: Call[] = [];
  const exec: GraphQLExecutor = async (query, vars: any) => {
    if (opts.delay) await new Promise<void>((r) => setTimeout(r, 0));
    const op = opName(query);
    calls.push({ op, vars });
    switch (op) {
      case "RateLimit":
        return { rateLimit: { remaining: 5000, resetAt: "2026-07-19T00:00:00Z" } };
      case "IssueLookup":
        return {
          repository: {
            issue: {
              id: `I_${vars.number}`,
              number: vars.number,
              title: `#${vars.number}`,
              body: bodies[`I_${vars.number}`] ?? "",
              assignees: { nodes: [] },
              projectItems: { nodes: [{ id: `PVTI_${vars.number}`, project: { number: 1 } }] },
            },
          },
        };
      case "UpdateIssueBody": {
        if (!opts.loseWrites?.(vars.id)) {
          bodies[vars.id] = opts.transformWrite ? opts.transformWrite(vars.id, vars.body) : vars.body;
        }
        return { updateIssue: { issue: { number: 0 } } };
      }
      case "AddComment":
        return { addComment: { clientMutationId: null } };
      default:
        throw new Error(`linkBackend: unexpected op ${op}`);
    }
  };
  return { exec, bodies, calls };
}

describe("link", () => {
  test("records the dependency both directions with body line + comment", async () => {
    const b = linkBackend({ 5: "Body.", 6: "Body." });
    const board = new Board(CFG, b.exec);
    await board.link(5, 6);

    expect(b.bodies["I_5"]).toContain("Depends on #6");
    expect(b.bodies["I_6"]).toContain("Blocks #5");
    const comments = b.calls.filter((c) => c.op === "AddComment");
    expect(comments.map((c) => c.vars.body).sort()).toEqual(["Blocks #5", "Depends on #6"]);
  });

  test("is idempotent: an already-present line is skipped", async () => {
    const b = linkBackend({ 5: "Body.\n\nDepends on #6", 6: "Body.\n\nBlocks #5" });
    const board = new Board(CFG, b.exec);
    await board.link(5, 6);
    expect(b.calls.some((c) => c.op === "AddComment")).toBe(false);
    expect(b.calls.some((c) => c.op === "UpdateIssueBody")).toBe(false);
  });

  // -- issue #14 item 10: read-check-write clobber protection ----------------
  test("a lost update is retried until the relation line survives", async () => {
    let lose = 1; // swallow exactly the first write to #5, as a concurrent clobber would
    const b = linkBackend({ 5: "Body.", 6: "" }, { loseWrites: (id) => id === "I_5" && lose-- > 0 });
    const board = new Board(CFG, b.exec);
    await board.link(5, 6);
    expect(b.bodies["I_5"]).toContain("Depends on #6");
    expect(b.calls.filter((c) => c.op === "UpdateIssueBody" && c.vars.id === "I_5").length).toBe(2);
    // comment posted once, only after the write verifiably stuck
    expect(b.calls.filter((c) => c.op === "AddComment" && c.vars.body === "Depends on #6").length).toBe(1);
  });

  test("throws loudly after bounded retries when writes keep getting clobbered", async () => {
    const b = linkBackend({ 5: "Body.", 6: "" }, { loseWrites: (id) => id === "I_5" });
    const board = new Board(CFG, b.exec);
    await expect(board.link(5, 6)).rejects.toThrow(/did not survive 3 body writes/);
    expect(b.calls.filter((c) => c.op === "UpdateIssueBody" && c.vars.id === "I_5").length).toBe(3);
    expect(b.calls.some((c) => c.op === "AddComment")).toBe(false); // no success signal on failure
  });

  test("concurrent link() calls on the same issue drop no lines", async () => {
    const b = linkBackend({ 5: "Body.", 6: "", 7: "" });
    const boardA = new Board(CFG, b.exec);
    const boardB = new Board(CFG, b.exec);
    await Promise.all([boardA.link(5, 6), boardB.link(5, 7)]);
    expect(b.bodies["I_5"]).toContain("Depends on #6");
    expect(b.bodies["I_5"]).toContain("Depends on #7");
    expect(b.bodies["I_6"]).toContain("Blocks #5");
    expect(b.bodies["I_7"]).toContain("Blocks #5");
  });

  // line-exact presence helper mirroring lib/board.ts hasLine (F1 assertions)
  const bodyHasLine = (body: string, line: string) => body.split("\n").some((l) => l.trimEnd() === line);

  // F1 verify path: substring includes() let "Depends on #12" false-verify a
  // check for "Depends on #1" -- a clobbered write reported success and the
  // lost line was never re-appended.
  test("verify is line-exact: a clobber leaving 'Depends on #12' cannot false-verify 'Depends on #1'", async () => {
    let clobbers = 1; // the first write to #5 is replaced by a concurrent writer's own snapshot
    const b = linkBackend(
      { 5: "Body.", 1: "" },
      { transformWrite: (id, body) => (id === "I_5" && clobbers-- > 0 ? "Body.\n\nDepends on #12" : body) }
    );
    const board = new Board(CFG, b.exec);
    await board.link(5, 1);
    expect(bodyHasLine(b.bodies["I_5"], "Depends on #1")).toBe(true); // loss detected, re-appended
    expect(bodyHasLine(b.bodies["I_5"], "Depends on #12")).toBe(true); // the other writer's line kept
    expect(b.calls.filter((c) => c.op === "UpdateIssueBody" && c.vars.id === "I_5").length).toBe(2);
  });

  // F1 pre-check path: with only "Depends on #12" present, link(5,1) must
  // WRITE "Depends on #1", not no-op on the substring hit.
  test("pre-check is line-exact: link(5,1) with only 'Depends on #12' present still writes", async () => {
    const b = linkBackend({ 5: "Body.\n\nDepends on #12", 1: "" });
    const board = new Board(CFG, b.exec);
    await board.link(5, 1);
    expect(bodyHasLine(b.bodies["I_5"], "Depends on #1")).toBe(true);
    expect(b.calls.some((c) => c.op === "UpdateIssueBody" && c.vars.id === "I_5")).toBe(true);
    // and the relation comment was posted -- this was NOT treated as pre-existing
    expect(b.calls.filter((c) => c.op === "AddComment" && c.vars.body === "Depends on #1").length).toBe(1);
  });

  // F2: without per-issue serialization, writer B's stale-snapshot write can
  // land AFTER writer A's verification passed -- a lost line no retry catches.
  // With the lock, read/write phases run strictly sequentially: exactly one
  // write per link, and the second write's read already saw the first line.
  test("concurrent link() on one issue serializes: second write builds on the first, no clobber", async () => {
    const b = linkBackend({ 5: "Body.", 6: "", 7: "" }, { delay: true });
    const boardA = new Board(CFG, b.exec);
    const boardB = new Board(CFG, b.exec);
    await Promise.all([boardA.link(5, 6), boardB.link(5, 7)]);
    const updates = b.calls.filter((c) => c.op === "UpdateIssueBody" && c.vars.id === "I_5");
    expect(updates.length).toBe(2); // no interleave means no clobber means no retry writes
    const [first, second] = updates.map((u) => u.vars.body as string);
    const firstLine = bodyHasLine(first, "Depends on #6") ? "Depends on #6" : "Depends on #7";
    const otherLine = firstLine === "Depends on #6" ? "Depends on #7" : "Depends on #6";
    expect(bodyHasLine(first, firstLine)).toBe(true);
    expect(bodyHasLine(second, firstLine)).toBe(true); // second writer read AFTER first write
    expect(bodyHasLine(second, otherLine)).toBe(true);
    expect(bodyHasLine(b.bodies["I_5"], "Depends on #6")).toBe(true); // both survive
    expect(bodyHasLine(b.bodies["I_5"], "Depends on #7")).toBe(true);
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
  const calls: Call[] = [];
  const login = (userId: string) => userId.replace(/^U_/, "");
  const exec: GraphQLExecutor = async (query, vars: any) => {
    calls.push({ op: opName(query), vars });
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
  return { exec, assignees, calls };
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

  // -- issue #14 item 18: re-claiming your own ticket is idempotent ------------
  test("re-claim by the sole existing claimer is a no-op success, not a second mutation", async () => {
    const backend = claimBackend(["alice"]);
    const board = new Board(CFG, backend.exec);
    await board.claim(9, "alice"); // resolves -- crash-recovery re-entry must not error
    expect(backend.assignees).toEqual(["alice"]); // unchanged
    // No assignee mutation was issued: the early return fired before UserId/Add.
    expect(backend.calls.filter((c) => c.op === "AddAssignees" || c.op === "RemoveAssignees" || c.op === "UserId")).toEqual([]);
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

  // Issue #23: ghExecutor shells to the RAW endpoint (`gh api /graphql`,
  // issue #17), not the bare `graphql` subcommand. A regex that only matched
  // the bare form would let a future .ts file that shells to the raw endpoint
  // directly (a string like "gh api /graphql ...") evade this gate.
  //
  // Post-#17 QA bounce: the shell-string regex above only matches
  // `gh api /graphql` written as one joined string. lib/board.ts's actual
  // invocation is an ARRAY literal -- spawn(["gh", "api", "/graphql", ...]) --
  // where "gh", "api", and "/graphql" are separate tokens with no `\bgh\s+api\b`
  // substring anywhere in the source. A second pattern catches that array-of-
  // string-literals shape directly (either quote style, whitespace-tolerant).
  function callsGhDirectly(content: string): boolean {
    return (
      /\bgh\s+api\s+\/?graphql\b/.test(content) ||
      /\bgh\s+issue\b/.test(content) ||
      /["']gh["']\s*,\s*["']api["']\s*,\s*["']\/?graphql["']/.test(content)
    );
  }

  // Files this gate scans for direct gh invocations. `evals/` sits alongside
  // `tests/` as a doubles-and-harnesses lane: the paid planner eval harness
  // (evals/planner/board-double.ts, run.sh) quotes gh invocation strings in
  // comments and prompts to describe what the double parses -- it never
  // shells the real gh. #23 widened callsGhDirectly's regexes to catch the
  // raw-endpoint and array-literal forms; #25 (based pre-#23) added that
  // harness. Each passed its own gate in isolation; merged, the harness's
  // documentation tripped the widened detector. The fix narrows the scanned
  // set, not the detector -- see the canary below.
  function gateScans(f: string): boolean {
    return (
      f !== "lib/board.ts" &&
      !f.startsWith("tests/") &&
      !f.startsWith("evals/") &&
      !f.startsWith("references/") &&
      !f.endsWith(".md") &&
      !f.endsWith(".png")
    );
  }

  test("only lib/board.ts calls gh api graphql or gh issue directly", () => {
    const files = trackedFiles().filter(gateScans);
    const offenders: string[] = [];
    for (const f of files) {
      const content = readFileSync(join(REPO_ROOT, f), "utf8");
      if (callsGhDirectly(content)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  // Canary: proves the evals/ exclusion is scoped narrowly and stays wired.
  // If a future change drops the evals/ exclusion while a doubles harness
  // that quotes gh strings still exists, this fails pre-merge instead of the
  // gate above silently flagging documentation as an offense.
  test("gateScans excludes tests/ and evals/ doubles-and-harnesses, keeps lib/ and bin/ scanned", () => {
    expect(gateScans("evals/planner/board-double.ts")).toBe(false);
    expect(gateScans("tests/x.test.ts")).toBe(false);
    expect(gateScans("lib/foo.ts")).toBe(true);
    expect(gateScans("bin/z-board")).toBe(true);
  });

  // Ticket #57: bin/z-loop-tick shells only z-board + bun. Its whole reason to
  // exist (a gh-free per-iteration tick) depends on bodies coming from
  // `z-board snapshot` (routed through lib/board.ts), so a direct gh call here
  // would both break the caller gate and defeat the design. The generic gate
  // above already scans bin/ files; this asserts it EXPLICITLY for z-loop-tick.
  test("bin/z-loop-tick makes no direct gh call (snapshot fetches bodies through lib/board.ts)", () => {
    const content = readFileSync(join(REPO_ROOT, "bin", "z-loop-tick"), "utf8");
    expect(callsGhDirectly(content)).toBe(false);
    // Stronger than callsGhDirectly: no bare `gh` command token anywhere (any
    // subcommand, comments included) -- word-boundary so "GitHub"/"through" don't trip it.
    const ghCommand = /(^|[\s;|&$("'`])gh[\s'"]/m;
    expect(ghCommand.test(content)).toBe(false);
    // And it does call the two allowed tools.
    expect(content).toContain("z-board");
    expect(content).toContain("lib/loop.ts");
  });

  test("lib/board.ts is in fact the caller (guards against the gate passing vacuously)", () => {
    const content = readFileSync(join(REPO_ROOT, "lib", "board.ts"), "utf8");
    // Must assert the actual detector predicate, not a weaker proxy (`/\bgh\b/`
    // + `includes("api")`): that proxy stayed green even while callsGhDirectly
    // failed to recognize lib/board.ts's own array-literal invocation, so the
    // gate and the sanctioned file could drift apart without this test noticing.
    expect(callsGhDirectly(content)).toBe(true);
  });

  // Canary: proves the detector itself catches all known forms without needing
  // a scratch file planted in the repo. A future narrowing of any of these
  // regexes (e.g. dropping the `\/?`, or dropping the array-literal branch)
  // turns this red.
  test("the offender detector catches the bare, raw-endpoint, and array-literal gh api graphql forms", () => {
    expect(callsGhDirectly("exec(\"gh api graphql -f query='mutation { m }'\")")).toBe(true);
    expect(callsGhDirectly('exec("gh api /graphql --input -")')).toBe(true);
    expect(callsGhDirectly("gh issue edit 1 --body x")).toBe(true);
    // Array-literal form (lib/board.ts's real shape), both quote styles and
    // both the bare and raw-endpoint subcommand spellings.
    expect(callsGhDirectly('spawn(["gh", "api", "/graphql", "--input", "-"], body)')).toBe(true);
    expect(callsGhDirectly('spawn(["gh", "api", "graphql"], body)')).toBe(true);
    expect(callsGhDirectly("spawn(['gh', 'api', '/graphql'], body)")).toBe(true);
    expect(callsGhDirectly("this file has nothing to do with any CLI")).toBe(false);
  });

  // Issue #14 item 2: the code gate above excludes *.md, so the skill files --
  // the pack's actual executed surface -- were never scanned and the gate
  // passed vacuously. Skill files DO shell out to gh. Every `gh <anything>`
  // invocation in a SKILL.md code context (F5: ANY subcommand, not just
  // api graphql / issue) must match this explicit allowlist exactly
  // (whitespace-normalized, so incidental reflow within a line doesn't break
  // it); a NEW direct call fails until it is consciously sanctioned here.
  const SKILL_GH_ALLOWLIST: Record<string, string[]> = {
    "z-setup/SKILL.md": [
      // Step 0 repo-identity lookups: read-only
      `gh repo view --json owner -q .owner.login)`,
      `gh repo view --json name -q .name)`,
      // Step 1 auth probes: read-only scope check ("; then" is the enclosing
      // shell conditional the scanner keeps on the line)
      `gh auth status 2>&1 | grep -q "'project'"; then`,
      `gh auth status`, // read-only auth probe (prereq checklist)
      `gh auth login`, // printed instruction for the user; interactive auth, no repo/board mutation
      // token-scope repair: mutates only the LOCAL gh token's scopes, never repo/board state
      `gh auth refresh -s project`,
      // Step 1 scoped probe: read-only viewer query; the shell glue after
      // >/dev/null is error reporting, not a second command (the source line
      // uses backslash continuations, joined by the scanner)
      `gh api graphql -f query='query { viewer { login } }' >/dev/null && echo "gh scopes OK" || { echo "Still cannot query GraphQL; resolve gh auth before continuing." >&2; exit 1; }`,
      // Step 5 verification checklist: read-only project views for the human
      `gh project view <NUMBER> --owner <OWNER> --web`,
      `gh project list --owner "$OWNER"`,
    ],
    "z-plan/SKILL.md": [
      // slug lookup: read-only (trailing shell comment is part of the line)
      `gh repo view --json name -q .name) # one board per repo; matches /z-setup`,
      `gh auth status`, // read-only auth probe (prereq checklist)
      // Step 10 Backlog scan (issue #13): same read the loop's planning pass
      // uses (z-loop/SKILL.md); z-board has no body-read subcommand
      `gh issue view <N> --json body -q .body > "$TMP/body-<N>.md"`,
      // Step 10 Backlog scan (issue #13): same write the loop's planning pass
      // uses; z-board has no issue-body-edit subcommand (the one mutation
      // outside z-board, already sanctioned for z-loop above)
      `gh issue edit <N> --body-file ...`,
      // ticket #77 Step 8 fold-in gate (PROCESS.md step 6): read-only session
      // login lookup, the board's known bot/session identity used to spot a
      // human comment newer than the plan
      `gh api user -q .login`,
      // ticket #77 Step 8 fold-in gate: read-only comments fetch; z-board has
      // no comment-read subcommand
      `gh issue view <N> --json comments -q '.comments'`,
    ],
    "z-status/SKILL.md": [
      `gh repo view --json name -q .name)`, // slug lookup: read-only
    ],
    "z-loop/SKILL.md": [
      // preamble identity lookups: all read-only
      `gh repo view --json name -q .name)`,
      `gh repo view --json defaultBranchRef -q .defaultBranchRef.name)`,
      `gh api user -q .login)`,
      `gh auth status`, // read-only auth probe (prereq checklist)
      // read-only body fetches (planning pass + board snapshot); z-board has no
      // body-read subcommand
      `gh issue view <N> --json body -q .body > "$TMP/body-<N>.md"`,
      `gh issue view "$N" --json body -q .body > "$TMP/body-$N.md"`,
      `gh issue view`, // prose reference in the builder-input table
      // issue #59 reviewer-spawn label fetch: read-only. Labels live on the
      // GitHub issue, not the board item (board.list never fetches them), so the
      // adversarial-mode predicate reads them here. Trailing ) is from the $(...).
      `gh issue view <N> --json labels -q '[.labels[].name]')`,
      // planning-pass body write; z-board has no issue-body-edit subcommand
      // (flagged in issue #14 item 2 findings as the one mutation outside z-board)
      `gh issue edit <N> --body-file ...`,
      // H9 dead-merge-lane resolution: read-only PR state check
      `gh pr view <branch> --json state,url -q '.state'`,
      `gh pr view`, // prose reference in the H9 dead-merge paragraph: read-only check
      `gh pr merge`, // prose reference naming what a dead worker MAY have run; not an instruction
      `gh issue close`, // prose PROHIBITION: "never gh issue close"
      // ticket #77 Step 1 fold-in gate (PROCESS.md step 6): read-only comments
      // fetch; z-board has no comment-read subcommand. Author comparison uses
      // $ME, already looked up in the preamble -- no new gh call for that part.
      `gh issue view <N> --json comments -q '.comments' > "$TMP/comments-<N>.json"`,
    ],
  };

  // F5 scanner. Order matters: backslash-continued lines are logically joined
  // FIRST (a continuation could otherwise split `gh \` from its verb so the
  // invocation was never scanned, or truncate `gh issue close \` + `123` to a
  // prose-allowlisted prefix), THEN every `gh <args>` invocation -- any
  // subcommand -- is extracted from code contexts (fenced blocks and inline
  // backtick spans; bare prose is not scanned) and whitespace-normalized for
  // exact-matching against the allowlist. `gh *` matches are permission
  // PATTERN syntax (`Bash(gh *)`), not runnable invocations, and are skipped.
  function ghInvocations(content: string): string[] {
    const joined = content.replace(/\\\r?\n/g, " ");
    const contexts: string[] = [];
    const fenced = /```[^\n]*\n([\s\S]*?)```/g;
    let rest = "";
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = fenced.exec(joined))) {
      rest += joined.slice(last, m.index) + "\n";
      contexts.push(m[1]);
      last = m.index + m[0].length;
    }
    rest += joined.slice(last);
    for (const im of rest.matchAll(/`([^`\n]+)`/g)) contexts.push(im[1]);
    const out: string[] = [];
    for (const ctx of contexts) {
      for (const line of ctx.split(/\r?\n/)) {
        // the leading " " makes start-of-line uniform with the boundary chars
        for (const g of (" " + line).matchAll(/[\s;|&$(]gh\s+\S[^`]*/g)) {
          const inv = g[0].slice(1).replace(/\s+/g, " ").trim();
          if (!inv.startsWith("gh *")) out.push(inv);
        }
      }
    }
    return out;
  }

  test("skill .md files: every gh invocation in code contexts is allowlisted", () => {
    const skillFiles = trackedFiles().filter((f) => f.endsWith("/SKILL.md"));
    // Canary: the scan must actually contain the real skill files, or this gate
    // has gone vacuous again (the exact bug it replaces).
    expect(skillFiles).toContain("z-loop/SKILL.md");
    expect(skillFiles).toContain("z-plan/SKILL.md");
    expect(skillFiles).toContain("z-setup/SKILL.md");
    expect(skillFiles).toContain("z-status/SKILL.md");

    const offenders: string[] = [];
    for (const f of skillFiles) {
      const allowed = new Set(SKILL_GH_ALLOWLIST[f] ?? []);
      for (const inv of ghInvocations(readFileSync(join(REPO_ROOT, f), "utf8"))) {
        if (!allowed.has(inv)) offenders.push(`${f}: ${inv}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // F5 scanner self-tests: both confirmed evasion vectors plus a plain planted
  // mutation, against crafted markdown -- the gate is only as strong as its
  // extractor.
  describe("gh invocation scanner (F5)", () => {
    test("backslash continuation cannot hide the verb from the scan", () => {
      const md = "```bash\ngh \\\n  api graphql -f query='mutation { m }'\n```\n";
      expect(ghInvocations(md)).toEqual(["gh api graphql -f query='mutation { m }'"]);
    });

    test("continuation cannot truncate an invocation to an allowlisted prefix", () => {
      const md = "```bash\ngh issue close \\\n  123\n```\n";
      expect(ghInvocations(md)).toEqual(["gh issue close 123"]);
    });

    test("non-graphql gh forms are visible, not just api graphql / issue", () => {
      const md = [
        "```bash",
        "gh api -X POST /repos/o/r/issues",
        "gh pr merge 7 --squash",
        "gh project item-add 1 --owner o",
        "gh auth refresh -s project",
        "```",
      ].join("\n");
      expect(ghInvocations(md)).toEqual([
        "gh api -X POST /repos/o/r/issues",
        "gh pr merge 7 --squash",
        "gh project item-add 1 --owner o",
        "gh auth refresh -s project",
      ]);
    });

    test("a planted gh api graphql mutation in a fenced block is extracted", () => {
      const md = "Prose.\n\n```sh\ngh api graphql -f query='mutation { updateIssue }'\n```\n";
      expect(ghInvocations(md)).toContain("gh api graphql -f query='mutation { updateIssue }'");
    });

    test("inline backtick invocations are scanned; bare prose and permission patterns are not", () => {
      const md = "Never `gh issue close` a ticket. The gh CLI must be installed. Allow `Bash(gh *)` in settings.";
      expect(ghInvocations(md)).toEqual(["gh issue close"]);
    });
  });
});

// -- Issue #17: the REAL ghExecutor encoding + error contracts ----------------
// The rest of the suite mocks the executor, so gh's actual arg encoding was
// never exercised and the `Float!` rejection slipped through: `-F number=1.64`
// let gh's magic typing hand the API the string "1.64". These drive the REAL
// ghExecutor through an injected spawn seam, so the JSON body asserted here is
// the exact bytes production POSTs -- a string-typed float in this test is a
// string-typed float in prod.
describe("ghExecutor JSON encoding + error contracts (issue #17)", () => {
  // Records the command + stdin body, returns a canned process result.
  function fakeSpawn(result: GhProc, sink?: { cmd?: string[]; body?: string }): GhSpawn {
    return (cmd, stdin) => {
      if (sink) {
        sink.cmd = cmd;
        sink.body = stdin;
      }
      return result;
    };
  }
  const ok = (data: unknown): GhProc => ({ exitCode: 0, stdout: JSON.stringify({ data }), stderr: "" });

  // AC3: variables {a:1.64, b:2, c:"x", d:true} -> a JSON body whose `a` is the
  // NUMBER 1.64, b the number 2, c a string, d a boolean. No string-typed float.
  test("floats stay JSON numbers, not strings (the Float! bug)", async () => {
    const sink: { cmd?: string[]; body?: string } = {};
    const exec = ghExecutor(fakeSpawn(ok({ ok: true }), sink));
    await exec("mutation SetNumber($number: Float!) { x }", { a: 1.64, b: 2, c: "x", d: true });

    // POSTed to the raw /graphql endpoint on stdin, not passed as `-F` args.
    expect(sink.cmd).toEqual(["gh", "api", "/graphql", "--input", "-"]);
    const req = JSON.parse(sink.body!);
    expect(req.query).toContain("SetNumber");
    expect(req.variables.a).toBe(1.64);
    expect(typeof req.variables.a).toBe("number");
    expect(req.variables.b).toBe(2);
    expect(typeof req.variables.b).toBe("number");
    expect(req.variables.c).toBe("x");
    expect(req.variables.d).toBe(true);
    // The old `-F number=1.64` path shipped the value as the string "1.64";
    // guard the exact regression.
    expect(sink.body).not.toContain('"1.64"');
  });

  test("returns the data payload on success", async () => {
    const exec = ghExecutor(fakeSpawn(ok({ updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_1" } } })));
    expect(await exec("mutation SetNumber { x }", {})).toEqual({
      updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_1" } },
    });
  });

  // AC4: raw /graphql returns HTTP 200 (exit 0) with an `errors` array in the
  // body; the executor must NOT return silent success.
  test("a GraphQL errors array in an HTTP-200 body raises ZError naming the error", async () => {
    const proc: GhProc = {
      exitCode: 0,
      stdout: JSON.stringify({
        data: null,
        errors: [
          {
            message: "Variable $number of type Float! was provided invalid value",
            path: ["updateProjectV2ItemFieldValue"],
          },
        ],
      }),
      stderr: "",
    };
    const exec = ghExecutor(fakeSpawn(proc));
    await expect(exec("mutation SetNumber { x }", { number: 1.64 })).rejects.toThrow(ZError);
    await expect(exec("mutation SetNumber { x }", { number: 1.64 })).rejects.toThrow(/Variable \$number of type Float!/);
    await expect(exec("mutation SetNumber { x }", { number: 1.64 })).rejects.toThrow(/path: updateProjectV2ItemFieldValue/);
  });

  // Transport failure (non-zero exit) still raises, carrying stderr.
  test("a non-zero exit (transport failure) raises ZError with stderr", async () => {
    const proc: GhProc = { exitCode: 1, stdout: "", stderr: "error connecting to api.github.com" };
    const exec = ghExecutor(fakeSpawn(proc));
    await expect(exec("mutation SetNumber { x }", {})).rejects.toThrow(/gh api \/graphql failed: error connecting to api\.github\.com/);
  });

  // Issue #23: exit 0 does not guarantee a JSON body. Every other failure path
  // in this executor is a named ZError; a raw SyntaxError from JSON.parse was
  // the one gap.
  test("exit 0 with non-JSON stdout raises ZError naming the parse failure and a stdout snippet, not a raw SyntaxError", async () => {
    const proc: GhProc = { exitCode: 0, stdout: "not-json", stderr: "" };
    const exec = ghExecutor(fakeSpawn(proc));
    await expect(exec("mutation SetNumber { x }", {})).rejects.toThrow(ZError);
    await expect(exec("mutation SetNumber { x }", {})).rejects.toThrow(/non-JSON stdout/);
    await expect(exec("mutation SetNumber { x }", {})).rejects.toThrow(/not-json/);
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
    expect(loaded.quota).toEqual({ threshold: 100, mode: "sleep" });
    expect(loaded.lockStalenessMinutes).toBe(60); // C7 default applied (issue #2)
  });

  // AC11 (issue #63): a config.json with no humanNeededPercent key loads the
  // default (30), same fallback-application style as every other knob above.
  test("applies the humanNeededPercent default when absent", () => {
    const home = makeHome();
    const written = { ...CFG, humanNeededPercent: undefined };
    writeConfig(home, "zstack", written);
    const loaded = loadConfig("zstack", home);
    expect(loaded.humanNeededPercent).toBe(30);
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

// -- issue #14 item 18: resolveSlug + loadConfig error paths ------------------
describe("resolveSlug + loadConfig error paths (item 18)", () => {
  const homes: string[] = [];
  let savedSlug: string | undefined;

  beforeEach(() => {
    savedSlug = process.env.ZSTACK_SLUG;
    delete process.env.ZSTACK_SLUG;
  });
  afterEach(() => {
    if (savedSlug !== undefined) process.env.ZSTACK_SLUG = savedSlug;
    else delete process.env.ZSTACK_SLUG;
    while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
  });

  function makeHome(): string {
    const dir = mkdtempSync(join(tmpdir(), "zstack-slug-"));
    homes.push(dir);
    return dir;
  }
  function writeProject(home: string, slug: string): void {
    const dir = join(home, ".zstack", "projects", slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ ...CFG, slug }));
  }

  test("ambiguity: multiple projects and no disambiguator names every candidate", () => {
    const home = makeHome();
    writeProject(home, "alpha");
    writeProject(home, "beta");
    let caught: unknown;
    try {
      resolveSlug(undefined, home);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ZError); // actionable, not a bug-stack
    const msg = (caught as ZError).message;
    expect(msg).toMatch(/Multiple zstack projects configured/);
    expect(msg).toContain("alpha"); // every candidate is named
    expect(msg).toContain("beta");
    expect(msg).toMatch(/--slug/); // and both escape hatches are offered
    expect(msg).toMatch(/ZSTACK_SLUG/);
  });

  test("no projects at all points at /z-setup", () => {
    expect(() => resolveSlug(undefined, makeHome())).toThrow(/No zstack project configured.*\/z-setup/);
  });

  test("ZSTACK_SLUG disambiguates between multiple configured projects", () => {
    const home = makeHome();
    writeProject(home, "alpha");
    writeProject(home, "beta");
    process.env.ZSTACK_SLUG = "beta";
    expect(resolveSlug(undefined, home)).toBe("beta");
    expect(loadConfig(undefined, home).slug).toBe("beta"); // loads the env-chosen config
  });

  test("an explicit slug wins over ZSTACK_SLUG", () => {
    const home = makeHome();
    writeProject(home, "alpha");
    writeProject(home, "beta");
    process.env.ZSTACK_SLUG = "beta";
    expect(resolveSlug("alpha", home)).toBe("alpha");
  });

  test("ZSTACK_SLUG naming a project that does not exist fails with a clear ZError", () => {
    const home = makeHome();
    writeProject(home, "alpha");
    process.env.ZSTACK_SLUG = "ghost";
    let caught: unknown;
    try {
      loadConfig(undefined, home);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ZError);
    expect((caught as ZError).message).toMatch(/No zstack config for "ghost"/);
    expect((caught as ZError).message).toMatch(/z-setup/); // the fix is named
  });

  test("corrupt config JSON raises a ZError naming the file, never a raw SyntaxError", () => {
    const home = makeHome();
    const dir = join(home, ".zstack", "projects", "zstack");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{ this is not json");
    let caught: unknown;
    try {
      loadConfig("zstack", home);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ZError); // handleCliError prints it; a SyntaxError would rethrow as a bug
    expect(caught).not.toBeInstanceOf(SyntaxError);
    const msg = (caught as ZError).message;
    expect(msg).toMatch(/is not valid JSON/);
    expect(msg).toContain(join(".zstack", "projects", "zstack", "config.json")); // the offending file is named
  });
});
