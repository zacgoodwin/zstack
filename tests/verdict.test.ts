// Gate tests for the stage verdict contract (#323, epic #321 contract C2): a
// stage reports by writing verdict.json in its run-scoped directory; the
// orchestrator reads the file and NEVER parses prose. The forgery this kills is
// #312 -- a QA agent echoing `QA-PASS:` out of a ticket's own Acceptance
// Criteria was read as a pass by the deleted marker scanner. No LLM calls.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZError } from "../lib/config.ts";
import { stageDest } from "../lib/run-id.ts";
import {
  STAGE_RESULTS,
  VERDICT_SCHEMA_VERSION,
  quorumFromDisk,
  pathInsideTicketTree,
  readVerdict,
  verdictPath,
  main as verdictMain,
  type ExpectedSpawn,
} from "../lib/verdict.ts";
import { outcomeFromVerdict } from "../lib/loop.ts";

const RUN_A = "run-20260101-000000-aaaa";
const RUN_B = "run-20260101-000000-bbbb";

const tmps: string[] = [];
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "zverdict-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

const QA_SPAWN: ExpectedSpawn = { runId: RUN_A, ticket: 151, stage: "qa", attempt: 1 };

function writeVerdict(path: string, v: Record<string, unknown>): string {
  writeFileSync(path, JSON.stringify(v));
  return path;
}

function validQa(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: VERDICT_SCHEMA_VERSION,
    runId: RUN_A,
    ticket: 151,
    stage: "qa",
    attempt: 1,
    result: "QA-PASS",
    evidence: { gauntletExit: 0, pass: 210, fail: 0 },
    notes: "suite green, criteria exercised",
    ...over,
  };
}

// -- readVerdict: the validity rules, exact ------------------------------------

describe("readVerdict", () => {
  test("a well-formed verdict for the expected spawn is accepted", () => {
    const p = writeVerdict(join(mkTmp(), "verdict.json"), validQa());
    const r = readVerdict(p, QA_SPAWN);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict.result).toBe("QA-PASS");
  });

  test("#312's exact forgery: a QA-PASS living only in prose is NOTHING -- no file, no pass", () => {
    // The ticket's own Acceptance Criteria contain a literal marker line; the
    // old scanner read an echo of it as the stage's verdict. Under #323 there
    // is nothing to scan: the stage's final message is never an input, and a
    // missing verdict file is the dead-stage path, not a pass.
    const dir = mkTmp();
    const r = readVerdict(join(dir, "verdict.json"), QA_SPAWN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("no verdict file");
  });

  test("malformed JSON, non-object, and wrong schema version are each INVALID with the reason named", () => {
    const dir = mkTmp();
    const bad = join(dir, "verdict.json");
    writeFileSync(bad, "{ not json");
    expect(readVerdict(bad, QA_SPAWN)).toMatchObject({ ok: false, reason: expect.stringContaining("not valid JSON") });
    writeFileSync(bad, JSON.stringify([1, 2]));
    expect(readVerdict(bad, QA_SPAWN).ok).toBe(false);
    writeFileSync(bad, JSON.stringify(validQa({ schema: 99 })));
    expect(readVerdict(bad, QA_SPAWN)).toMatchObject({ ok: false, reason: expect.stringContaining("schema") });
  });

  test("a mis-addressed verdict never speaks for this spawn: wrong run, ticket, stage, or attempt", () => {
    const dir = mkTmp();
    const p = join(dir, "verdict.json");
    for (const over of [{ runId: RUN_B }, { ticket: 152 }, { stage: "builder" }, { attempt: 2 }]) {
      writeVerdict(p, validQa(over));
      const r = readVerdict(p, QA_SPAWN);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("does not match this spawn");
    }
  });

  test("a result outside the stage's union is INVALID -- including another stage's own values", () => {
    const p = join(mkTmp(), "verdict.json");
    writeVerdict(p, validQa({ result: "BUILT" })); // builder's word in QA's mouth
    expect(readVerdict(p, QA_SPAWN).ok).toBe(false);
    writeVerdict(p, validQa({ result: "qa-pass" })); // case is part of the value
    expect(readVerdict(p, QA_SPAWN).ok).toBe(false);
  });

  test("a pasted template (placeholder notes) is quoting the contract, not filling it", () => {
    const p = join(mkTmp(), "verdict.json");
    writeVerdict(p, validQa({ notes: "<one-line evidence summary>" }));
    const r = readVerdict(p, QA_SPAWN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("placeholder");
  });

  test("a caller bug (bad expect) throws instead of reporting INVALID", () => {
    const p = writeVerdict(join(mkTmp(), "verdict.json"), validQa());
    expect(() => readVerdict(p, { ...QA_SPAWN, runId: "latest" })).toThrow(ZError);
    expect(() => readVerdict(p, { ...QA_SPAWN, stage: "banana" as never })).toThrow(ZError);
  });
});

// -- outcomeFromVerdict: the 1:1 mapping onto the reducer's own union ----------

describe("outcomeFromVerdict", () => {
  const mk = (stage: keyof typeof STAGE_RESULTS, result: string, over: Record<string, unknown> = {}) =>
    ({ schema: 1, runId: RUN_A, ticket: 151, stage, attempt: 1, result, ...over }) as never;

  test("every stage's happy result maps to the outcome kind the reducers already speak", () => {
    expect(outcomeFromVerdict(mk("builder", "BUILT"), null)).toEqual({ kind: "built" });
    expect(outcomeFromVerdict(mk("qa", "QA-PASS"), null)).toEqual({ kind: "qa-pass" });
    expect(outcomeFromVerdict(mk("merge", "MERGED", { evidence: { prUrl: "https://x/pull/9" } }), null)).toEqual({
      kind: "merged",
      note: "https://x/pull/9",
    });
  });

  test("reviewer confidence rides the typed evidence field; junk scores null (the gate then refuses)", () => {
    const q = { received: 2, of: 3, unrefuted: 2, invalid: [] };
    expect(outcomeFromVerdict(mk("reviewer", "REVIEW-APPROVE", { evidence: { confidence: 92 } }), q)).toEqual({
      kind: "review-approve",
      confidence: 92,
      skeptics: { received: 2, of: 3 },
    });
    for (const junk of [undefined, "92", 101, -1, Number.NaN]) {
      const o = outcomeFromVerdict(mk("reviewer", "REVIEW-APPROVE", { evidence: { confidence: junk } }), null);
      expect(o).toEqual({ kind: "review-approve", confidence: null, skeptics: null });
    }
  });

  test("notes carry the human-facing line for the parking kinds", () => {
    expect(outcomeFromVerdict(mk("qa", "QA-BUGS", { notes: "1) save 500s" }), null)).toEqual({ kind: "qa-bugs", note: "1) save 500s" });
    expect(outcomeFromVerdict(mk("builder", "NEEDS-INPUT", { notes: "which currency?" }), null)).toEqual({ kind: "needs-input", note: "which currency?" });
    expect(outcomeFromVerdict(mk("merge", "BLOCKED", { notes: "gate red" }), null)).toEqual({ kind: "stage-blocked", note: "gate red" });
    expect(outcomeFromVerdict(mk("qa", "CONFUSED", { notes: "no worktree" }), null)).toEqual({ kind: "confused", note: "no worktree" });
  });

  test("a skeptic result has no lane mapping -- reaching here is a caller bug", () => {
    expect(() => outcomeFromVerdict(mk("skeptic", "UPHELD"), null)).toThrow(ZError);
  });
});

// -- quorum counted off disk (#266, #231) --------------------------------------

describe("quorumFromDisk", () => {
  const REVIEWER: ExpectedSpawn = { runId: RUN_A, ticket: 151, stage: "reviewer", attempt: 1 };

  function skepticDirs(stateDir: string): { runRoot: string; dirs: string[] } {
    const base = stageDest(stateDir, RUN_A, 151, "reviewer", 1);
    const dirs = [1, 2, 3].map((k) => join(base, `skeptic-${k}`));
    for (const d of dirs) mkdirSync(d, { recursive: true });
    return { runRoot: join(stateDir, "runs", RUN_A), dirs };
  }

  function skepticVerdict(result: string): Record<string, unknown> {
    return { schema: 1, runId: RUN_A, ticket: 151, stage: "skeptic", attempt: 1, result, evidence: { lens: "refutation", claimChecked: "AC1" }, notes: "checked" };
  }

  test("#266's scenario: a reviewer claiming 3 with one file on disk counts as 1", () => {
    const { runRoot, dirs } = skepticDirs(mkTmp());
    writeVerdict(verdictPath(dirs[0]), skepticVerdict("UPHELD"));
    // dirs[1] and dirs[2] hold nothing -- the reviewer's tally is not evidence.
    const q = quorumFromDisk(dirs.map(verdictPath), runRoot, REVIEWER);
    expect(q.received).toBe(1);
    expect(q.of).toBe(3);
    expect(q.unrefuted).toBe(1);
    expect(q.invalid.length).toBe(2);
  });

  test("#231's scenario: a verdict on disk counts even though the reviewer never saw it -- the directory is read, not its memory", () => {
    const { runRoot, dirs } = skepticDirs(mkTmp());
    for (const d of dirs) writeVerdict(verdictPath(d), skepticVerdict("UPHELD"));
    const q = quorumFromDisk(dirs.map(verdictPath), runRoot, REVIEWER);
    expect(q).toMatchObject({ received: 3, of: 3, unrefuted: 3 });
  });

  test("REFUTED counts as received but not unrefuted", () => {
    const { runRoot, dirs } = skepticDirs(mkTmp());
    writeVerdict(verdictPath(dirs[0]), skepticVerdict("UPHELD"));
    writeVerdict(verdictPath(dirs[1]), skepticVerdict("REFUTED"));
    const q = quorumFromDisk(dirs.slice(0, 2).map(verdictPath), runRoot, REVIEWER);
    expect(q).toMatchObject({ received: 2, unrefuted: 1 });
  });

  test("path trust: a listed path outside this ticket's run subtree is rejected, and a duplicate cannot double-count", () => {
    const stateDir = mkTmp();
    const { runRoot, dirs } = skepticDirs(stateDir);
    writeVerdict(verdictPath(dirs[0]), skepticVerdict("UPHELD"));
    // Another TICKET's tree in the same run -- forging quorum off a neighbor.
    const foreign = stageDest(stateDir, RUN_A, 152, "reviewer", 1);
    mkdirSync(foreign, { recursive: true });
    writeVerdict(verdictPath(foreign), { ...skepticVerdict("UPHELD"), ticket: 152 });
    const q = quorumFromDisk([verdictPath(dirs[0]), verdictPath(dirs[0]), verdictPath(foreign), "/tmp/elsewhere/verdict.json"], runRoot, REVIEWER);
    expect(q.received).toBe(1); // the duplicate, the foreign tree, and the stray all rejected
    expect(q.invalid.length).toBe(3);
    expect(pathInsideTicketTree(verdictPath(foreign), runRoot, 151)).toBe(false);
  });

  test("a skeptic verdict wearing the wrong stage or run is invalid, not counted", () => {
    const { runRoot, dirs } = skepticDirs(mkTmp());
    writeVerdict(verdictPath(dirs[0]), { ...skepticVerdict("UPHELD"), stage: "qa" });
    writeVerdict(verdictPath(dirs[1]), { ...skepticVerdict("UPHELD"), runId: RUN_B });
    const q = quorumFromDisk(dirs.slice(0, 2).map(verdictPath), runRoot, REVIEWER);
    expect(q.received).toBe(0);
    expect(q.invalid.length).toBe(2);
  });
});

// -- CLI ----------------------------------------------------------------------

describe("verdict CLI", () => {
  function captureStdout(fn: () => void): string {
    const orig = console.log;
    let out = "";
    console.log = (...a: unknown[]) => {
      out += a.join(" ") + "\n";
    };
    try {
      fn();
    } finally {
      console.log = orig;
    }
    return out;
  }

  test("check prints ok/invalid as JSON with exit 0 either way", () => {
    const p = writeVerdict(join(mkTmp(), "verdict.json"), validQa());
    let code: number | undefined;
    const out = captureStdout(() => {
      code = verdictMain(["check", p, "--run", RUN_A, "--ticket", "151", "--stage", "qa", "--attempt", "1"]);
    });
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ ok: true });
    const missing = captureStdout(() => {
      code = verdictMain(["check", join(mkTmp(), "verdict.json"), "--run", RUN_A, "--ticket", "151", "--stage", "qa", "--attempt", "1"]);
    });
    expect(code).toBe(0);
    expect(JSON.parse(missing)).toMatchObject({ ok: false });
  });

  test("path composes stageDest + verdict.json, with skeptics one level under their reviewer", () => {
    const stateDir = mkTmp();
    const out = captureStdout(() => {
      expect(verdictMain(["path", "--state-dir", stateDir, "--run", RUN_A, "--ticket", "151", "--stage", "qa", "--attempt", "2"])).toBe(0);
      expect(verdictMain(["path", "--state-dir", stateDir, "--run", RUN_A, "--ticket", "151", "--stage", "skeptic", "--attempt", "1", "--skeptic", "2"])).toBe(0);
    });
    const [qa, sk] = out.trim().split("\n");
    expect(qa.replace(/\\/g, "/")).toEndWith(`runs/${RUN_A}/t151/qa-2/verdict.json`);
    expect(sk.replace(/\\/g, "/")).toEndWith(`runs/${RUN_A}/t151/reviewer-1/skeptic-2/verdict.json`);
  });
});

// -- AC4: the marker parser is GONE from lib/, by grep -------------------------

// Same style as the sole-gh-caller pin: a source-string gate so the deleted
// scanner can never quietly reappear. The identifiers may appear in tests and
// docs (history), never in lib/.
describe("the marker scanner stays deleted (#323 AC4)", () => {
  test("no marker-parsing identifiers in lib/", () => {
    const libDir = join(import.meta.dir, "..", "lib");
    const banned = /parseStageResult|parseReviewerConfidence|parseSkepticQuorum|MARKER_LINE|PLACEHOLDER_PAYLOAD/;
    const offenders: string[] = [];
    for (const f of new Bun.Glob("*.ts").scanSync({ cwd: libDir })) {
      if (banned.test(readFileSync(join(libDir, f), "utf8"))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  test("the fence tracker has ONE owner: ticket-schema.ts (#314)", () => {
    const libDir = join(import.meta.dir, "..", "lib");
    const owners: string[] = [];
    for (const f of new Bun.Glob("*.ts").scanSync({ cwd: libDir })) {
      if (/FENCE_LINE/.test(readFileSync(join(libDir, f), "utf8"))) owners.push(f);
    }
    expect(owners).toEqual(["ticket-schema.ts"]);
  });
});
