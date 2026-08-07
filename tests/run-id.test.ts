// Gate tests for the run-identity contract (#322, epic #321 contract C1):
// runId format + lifecycle, the run-scoped artifact layout, run-disjoint spawn
// tags, run-scoped pricing, and the CLI-boundary state refusals.
//
// The regressions being pinned are all real, filed drains: attempt collisions
// overwrote transcripts (#210), a resumed ticket's Actual absorbed a previous
// run's spend (#212), the endloop report globbed every historical run and
// priced a $2.33 batch at $365.07 (#309), and a shell-expanded glob made
// z-cost silently price only its first positional (#319). No LLM calls.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZError } from "../lib/config.ts";
import { isRunId, mintRunId, stageDest } from "../lib/run-id.ts";
import { spawnTag } from "../lib/transcripts.ts";
import { costOfFiles, transcriptsUnder, main as costMain } from "../lib/cost.ts";
import type { RatesFile } from "../lib/estimate.ts";

const RATES: RatesFile = {
  checked_at: "2026-07-01",
  rates: {
    sonnet: { input: 3.0, output: 15.0, cached_input: 0.3 },
  },
};

// 2026-01-01T00:00:00.000Z -- the fixed clock every minted id below derives from.
const T0 = 1767225600000;
const RUN_A = "run-20260101-000000-aaaa";
const RUN_B = "run-20260101-000000-bbbb";

const tmpPaths: string[] = [];
function mkTmp(prefix = "zrunid-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpPaths.push(d);
  return d;
}
afterEach(() => {
  while (tmpPaths.length) rmSync(tmpPaths.pop()!, { recursive: true, force: true });
});

function captureStdout(fn: () => void | Promise<unknown>): Promise<string> {
  const orig = console.log;
  let out = "";
  console.log = (...a: unknown[]) => {
    out += a.join(" ") + "\n";
  };
  return Promise.resolve(fn()).then(
    () => ((console.log = orig), out),
    (e) => {
      console.log = orig;
      throw e;
    }
  );
}

// One priceable transcript line: real wire shape (model resolves to the sonnet
// rate key), unique requestId so nothing dedups across files unless a test
// wants it to.
function usageLine(requestId: string, outputTokens = 1000): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-5-20250929",
      role: "assistant",
      content: [{ type: "text", text: "…" }],
      usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: outputTokens },
    },
    requestId,
    timestamp: "2026-01-01T00:00:05.000Z",
  });
}

// A two-run state dir: the same ticket, the same stage, the same attempt number
// in both runs -- exactly the shape that used to collide (#210) and bleed (#212).
function twoRunStateDir(): { stateDir: string; runADir: string; runBDir: string } {
  const stateDir = mkTmp();
  const runADir = stageDest(stateDir, RUN_A, 151, "builder", 1);
  const runBDir = stageDest(stateDir, RUN_B, 151, "builder", 1);
  mkdirSync(runADir, { recursive: true });
  mkdirSync(runBDir, { recursive: true });
  writeFileSync(join(runADir, "builder-1.jsonl"), usageLine("req_runA_1") + "\n");
  writeFileSync(join(runBDir, "builder-1.jsonl"), usageLine("req_runB_1") + "\n");
  return { stateDir, runADir, runBDir };
}

// -- format + mint -------------------------------------------------------------

describe("isRunId / mintRunId", () => {
  test("accepts the canonical shape, rejects everything near it", () => {
    expect(isRunId(RUN_A)).toBe(true);
    expect(isRunId("run-20260101-000000-AAAA")).toBe(false); // uppercase hex
    expect(isRunId("run-20260101-000000-aaa")).toBe(false); // short suffix
    expect(isRunId("run-2026011-000000-aaaa")).toBe(false); // short date
    expect(isRunId("rux-20260101-000000-aaaa")).toBe(false);
    expect(isRunId("")).toBe(false);
  });

  test("mint is deterministic given the clock and the injected suffix", () => {
    expect(mintRunId(T0, "aaaa")).toBe(RUN_A);
    expect(mintRunId(T0, "aaaa")).toBe(mintRunId(T0, "aaaa"));
  });

  test("every crypto-suffixed mint satisfies its own validator", () => {
    expect(isRunId(mintRunId(T0))).toBe(true);
  });

  test("a malformed injected suffix and a garbage clock both throw", () => {
    expect(() => mintRunId(T0, "zzzz")).toThrow(ZError); // z is not hex
    expect(() => mintRunId(Number.NaN)).toThrow(ZError);
  });
});

// -- layout (AC2) --------------------------------------------------------------

describe("stageDest: the layout is code, not prose", () => {
  test("distinct attempts and distinct runs get distinct directories by construction", () => {
    const base = stageDest("/s", RUN_A, 151, "builder", 1);
    expect(stageDest("/s", RUN_A, 151, "builder", 2)).not.toBe(base); // #210
    expect(stageDest("/s", RUN_B, 151, "builder", 1)).not.toBe(base); // #212
    expect(stageDest("/s", RUN_A, 152, "builder", 1)).not.toBe(base);
    expect(stageDest("/s", RUN_A, 151, "qa", 1)).not.toBe(base);
  });

  test("the path is <stateDir>/runs/<runId>/t<ticket>/<stage>-<attempt>", () => {
    expect(stageDest("/s", RUN_A, 151, "qa", 2).replace(/\\/g, "/")).toBe(`/s/runs/${RUN_A}/t151/qa-2`);
  });

  test("a non-runId is refused rather than minting a stray directory name", () => {
    expect(() => stageDest("/s", "latest", 151, "qa", 1)).toThrow(ZError);
  });
});

// -- spawn tags (#210) ---------------------------------------------------------

describe("spawnTag: run-disjoint", () => {
  test("the same slug/ticket/stage/attempt in two runs mints two different tags", () => {
    expect(spawnTag("zstack", RUN_A, 151, "builder", 1)).not.toBe(spawnTag("zstack", RUN_B, 151, "builder", 1));
  });

  test("still deterministic within a run, and still refuses a non-runId", () => {
    expect(spawnTag("zstack", RUN_A, 151, "builder", 1)).toBe(spawnTag("zstack", RUN_A, 151, "builder", 1));
    expect(() => spawnTag("zstack", "not-a-run", 151, "builder", 1)).toThrow(ZError);
  });
});

// -- run-scoped pricing (AC1, AC3) ---------------------------------------------

describe("run-scoped pricing", () => {
  test("AC1: pricing run B attributes $0.00 from run A", () => {
    const { stateDir, runBDir } = twoRunStateDir();
    const b = costOfFiles(transcriptsUnder(join(stateDir, "runs", RUN_B)), RATES);
    expect(b.requests).toBe(1); // run A's request is invisible, not deduped away
    const bOnly = costOfFiles([join(runBDir, "builder-1.jsonl")], RATES);
    expect(b.total).toBe(bOnly.total);
  });

  test("AC3: per-ticket subtree totals sum to the whole-run total", () => {
    const stateDir = mkTmp();
    for (const [ticket, req] of [
      [151, "req_t151"],
      [152, "req_t152"],
    ] as const) {
      const d = stageDest(stateDir, RUN_A, ticket, "builder", 1);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "builder-1.jsonl"), usageLine(req) + "\n");
    }
    const root = join(stateDir, "runs", RUN_A);
    const whole = costOfFiles(transcriptsUnder(root), RATES);
    const t151 = costOfFiles(transcriptsUnder(join(root, "t151")), RATES);
    const t152 = costOfFiles(transcriptsUnder(join(root, "t152")), RATES);
    expect(t151.total + t152.total).toBe(whole.total);
  });

  test("a missing run directory is loud, never an empty $0.00", () => {
    expect(() => transcriptsUnder(join(mkTmp(), "runs", RUN_A))).toThrow(/does not exist/);
  });
});

// -- z-cost CLI contract (#319, AC4) -------------------------------------------

describe("z-cost CLI: run-dir / state-dir", () => {
  test("#319's exact shape -- positionals -- is refused loudly", async () => {
    let code: number | undefined;
    await captureStdout(async () => {
      code = await costMain(["a.jsonl", "b.jsonl", "c.jsonl"]);
    });
    expect(code).toBe(1);
  });

  test("exactly one input mode is required", async () => {
    const { stateDir } = twoRunStateDir();
    let code: number | undefined;
    await captureStdout(async () => {
      code = await costMain(["--run-dir", join(stateDir, "runs", RUN_A), "--state-dir", stateDir]);
    });
    expect(code).toBe(1);
  });

  test("--state-dir resolves the CURRENT run from state.json; --run overrides it", async () => {
    const { stateDir } = twoRunStateDir();
    writeFileSync(join(stateDir, "state.json"), JSON.stringify({ schemaVersion: 2, runId: RUN_B, tickets: [], lanes: [] }));
    const ratesFile = join(mkTmp(), "rates.json");
    writeFileSync(ratesFile, JSON.stringify(RATES));
    const current = JSON.parse(await captureStdout(() => costMain(["--json", "--state-dir", stateDir, "--rates", ratesFile])));
    expect(current.requests).toBe(1); // run B only
    const overridden = JSON.parse(
      await captureStdout(() => costMain(["--json", "--state-dir", stateDir, "--run", RUN_A, "--rates", ratesFile]))
    );
    expect(overridden.requests).toBe(1); // run A only
    expect(current.total + overridden.total).toBeGreaterThan(current.total); // both runs really priced separately
  });

  // Pre-1.3.0.0 this remedy read "price that drain with --legacy"; --legacy
  // is gone, so the message no longer dangles a pointer at a removed flag
  // (the source-grep in tests/cost.test.ts's "--legacy removal" describe pins
  // this file-wide; this asserts it at the one call site that used to name it).
  test("a state.json without a runId is refused rather than guessing, with no dangling --legacy pointer", async () => {
    const stateDir = mkTmp();
    writeFileSync(join(stateDir, "state.json"), JSON.stringify({ tickets: [], lanes: [] }));
    let code: number | undefined;
    const logs: string[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      await captureStdout(async () => {
        code = await costMain(["--json", "--state-dir", stateDir]);
      });
    } finally {
      console.error = origError;
    }
    expect(code).toBe(1);
    expect(logs.join("\n")).toMatch(/predates #322/);
    expect(logs.join("\n")).not.toContain("--legacy");
  });
});

// -- layout ownership: no write path emits the old layout (AC4 source pin) -----

describe("old-layout write paths are gone", () => {
  const skill = readFileSync(join(import.meta.dir, "..", "z-loop", "SKILL.md"), "utf8");

  test("SKILL.md composes artifact paths through the dest verb and prices through --run-dir", () => {
    // The three executable shapes the old layout lived in, each now unreachable:
    expect(skill).not.toInclude(`mkdir -p "$TMP" "$STATE_DIR/transcripts"`); // Step -1 pre-created it
    expect(skill).not.toInclude(`--dest "$STATE_DIR/transcripts`); // collect wrote into it
    expect(skill).not.toInclude(`"$STATE_DIR/transcripts/*/*.jsonl"`); // #309's history glob
    expect(skill).not.toInclude(`transcripts/ticket-<N>/*.jsonl`); // #319's per-ticket glob
    // ...and the replacements are present, not merely the old forms absent:
    expect(skill).toInclude(`dest --state-dir "$STATE_DIR" --run "$RUN_ID"`);
    expect(skill).toInclude(`--run-dir "$RUN_ROOT/t<N>"`);
    expect(skill).toInclude(`--by-file --run-dir "$RUN_ROOT"`);
    expect(skill).toInclude(`mv "$STATE" "$RUN_ROOT/state.json"`);
    expect(skill).toInclude(`RUN_ID=$(jq -r .runId "$STATE")`);
  });

  test("tag calls always carry the run", () => {
    // Every `transcripts.ts" tag` invocation in the SKILL names --run; one
    // without it would mint a runless tag the collect side can't match.
    const tagCalls = skill.split("\n").filter((l) => l.includes(`transcripts.ts" tag `));
    expect(tagCalls.length).toBeGreaterThan(0);
    for (const call of tagCalls) expect(call).toInclude(`--run "$RUN_ID"`);
  });
});

// -- loop state contract (mint lifecycle + AC5 refusals) -----------------------

const REPO_ROOT = join(import.meta.dir, "..");

function runLoop(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["bun", join(REPO_ROOT, "lib", "loop.ts"), ...args], { stdout: "pipe", stderr: "pipe" });
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

describe("loop state: runId lifecycle and version refusals", () => {
  // Subprocess-heavy: measured budget per #252's rule, not bun's 5s default.
  test(
    "a first ingest mints the runId off the CLI clock; a resume keeps it verbatim",
    () => {
      const dir = mkTmp();
      const statePath = join(dir, "state.json");
      writeFileSync(join(dir, "items.json"), "[]");
      writeFileSync(join(dir, "bodies.json"), "{}");
      const first = runLoop(["ingest", statePath, join(dir, "items.json"), join(dir, "bodies.json"), "--now", String(T0)]);
      expect(first.exitCode).toBe(0);
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      expect(state.schemaVersion).toBe(2);
      expect(state.runId).toStartWith("run-20260101-000000-"); // minted from --now, suffix random
      expect(isRunId(state.runId)).toBe(true);
      expect(first.stdout).toInclude(state.runId);
      // Resume: a second ingest a day later keeps the SAME run identity.
      const second = runLoop(["ingest", statePath, join(dir, "items.json"), join(dir, "bodies.json"), "--now", String(T0 + 86_400_000)]);
      expect(second.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(statePath, "utf8")).runId).toBe(state.runId);
    },
    30_000
  );

  test(
    "a v1 state (no schemaVersion) is refused with the remedy, by reader and ingest alike (AC5)",
    () => {
      const dir = mkTmp();
      const statePath = join(dir, "state.json");
      writeFileSync(statePath, JSON.stringify({ tickets: [], lanes: [], maxLanes: 3, watchdogMinutes: 10 }));
      const next = runLoop(["next", statePath, "--now", String(T0)]);
      expect(next.exitCode).toBe(1);
      expect(next.stderr).toInclude("predates the run-id contract");
      expect(next.stderr).toInclude("delete the state file");
      writeFileSync(join(dir, "items.json"), "[]");
      writeFileSync(join(dir, "bodies.json"), "{}");
      const ingest = runLoop(["ingest", statePath, join(dir, "items.json"), join(dir, "bodies.json"), "--now", String(T0)]);
      expect(ingest.exitCode).toBe(1); // never silently re-headers a v1 drain
      expect(existsSync(statePath)).toBe(true); // and never deleted it either
    },
    30_000
  );

  test(
    "a NEWER schemaVersion refuses with the update remedy; a v2 file with a garbage runId is corrupt (AC5)",
    () => {
      const dir = mkTmp();
      const statePath = join(dir, "state.json");
      writeFileSync(statePath, JSON.stringify({ schemaVersion: 3, runId: RUN_A, tickets: [], lanes: [], maxLanes: 3, watchdogMinutes: 10 }));
      const newer = runLoop(["next", statePath, "--now", String(T0)]);
      expect(newer.exitCode).toBe(1);
      expect(newer.stderr).toInclude("binary is older than the state");
      writeFileSync(statePath, JSON.stringify({ schemaVersion: 2, runId: "latest", tickets: [], lanes: [], maxLanes: 3, watchdogMinutes: 10 }));
      const corrupt = runLoop(["next", statePath, "--now", String(T0)]);
      expect(corrupt.exitCode).toBe(1);
      expect(corrupt.stderr).toInclude("corrupt");
    },
    30_000
  );
});
