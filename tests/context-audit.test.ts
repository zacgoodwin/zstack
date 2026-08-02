// Gate tests for lib/context-audit.ts -- the orchestrator context-attribution
// tool. The properties that matter here are not "does it produce a number" but
// "can the number be wrong without saying so", because the ad-hoc script this
// module replaced was 89% off (tool results reported at 41% of orchestrator
// spend, actual 22.7%) and its output looked entirely reasonable.
//
// So the tests are built around the reconciliation invariant, the two content
// shapes a transcript can use, and the drain/dev separation -- the three places
// a silent attribution error can hide.
import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditTranscript,
  assertReconciles,
  NoUsageLineError,
  report,
  rollup,
  type ComponentSpend,
} from "../lib/context-audit.ts";
import { SYNTHETIC_MODEL } from "../lib/cost.ts";
import { ZError } from "../lib/config.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "zstack-ctxaudit-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// -- fixture builders ---------------------------------------------------------

let seq = 0;
function assistant(billed: number, content: any[] = [], model = "claude-opus-4-20250101") {
  return JSON.stringify({
    type: "assistant",
    requestId: `req-${seq++}`,
    message: {
      role: "assistant",
      model,
      content,
      // The audit sums input + cache_read + cache_creation. Put the whole
      // window in cache_read, which is what a real long session looks like.
      usage: { input_tokens: 0, output_tokens: 10, cache_read_input_tokens: billed, cache_creation_input_tokens: 0 },
    },
  });
}
function user(content: any) {
  return JSON.stringify({ type: "user", message: { role: "user", content } });
}
function toolUse(id: string, name: string, input: any) {
  return { type: "tool_use", id, name, input };
}
function toolResult(id: string, content: string) {
  return { type: "tool_result", tool_use_id: id, content };
}
function write(name: string, lines: string[]): string {
  const p = join(dir, name);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

const TICK = '"$PACK/bin/z-loop-tick" --slug demo --state s.json --tmp t --session x';

// -- the invariant ------------------------------------------------------------

describe("reconciliation invariant", () => {
  test("staticFloor + components == totalBilled on a realistic transcript", () => {
    const p = write("basic.jsonl", [
      assistant(1000, [toolUse("t1", "Bash", { command: TICK })]),
      user([toolResult("t1", "X".repeat(400))]),
      assistant(1200, [toolUse("t2", "Read", { file_path: "/repo/lib/loop.ts" })]),
      user([toolResult("t2", "Y".repeat(8000))]),
      assistant(1500, [{ type: "text", text: "done" }]),
    ]);
    const a = auditTranscript(p);
    const sum = a.components.reduce((s, c) => s + c.cost, 0) + a.staticFloorCost;
    expect(sum).toBeCloseTo(a.totalBilled, 6);
    expect(a.totalBilled).toBe(1000 + 1200 + 1500);
    expect(a.staticFloor).toBe(1000); // the minimum window
    expect(a.staticFloorCost).toBe(1000 * 3);
    expect(a.accretion).toBe(3700 - 3000);
  });

  // The exact failure that motivated this module: drop a component class from
  // the pool and every other component's share inflates, silently.
  test("assertReconciles throws when a component class is missing", () => {
    const complete: ComponentSpend[] = [
      { component: "toolUseParams", phase: "drain", cost: 400, calls: 1, rawTokens: 1 },
      { component: "toolResult:Read", phase: "dev", cost: 600, calls: 1, rawTokens: 1 },
    ];
    expect(() => assertReconciles(complete, 1000, 2000, "ok")).not.toThrow();
    // Same total billed, one class omitted -> must not pass silently.
    expect(() => assertReconciles(complete.slice(0, 1), 1000, 2000, "broken")).toThrow(ZError);
    try {
      assertReconciles(complete.slice(0, 1), 1000, 2000, "broken");
    } catch (e) {
      expect((e as Error).message).toContain("does not reconcile");
      expect((e as Error).message).toContain("bug in lib/context-audit.ts");
    }
  });
});

// -- transcript shapes --------------------------------------------------------

describe("transcript shapes", () => {
  // Regression pin: `content` is EITHER a block array or a bare string. The
  // string form was iterated character-by-character, producing 360,286 "calls"
  // for one message. The cost was right, so only the call count exposed it.
  test("string-form message content counts as ONE block, not one per character", () => {
    const body = "Z".repeat(5000);
    const p = write("stringform.jsonl", [
      assistant(1000, [{ type: "text", text: "hi" }]),
      user(body), // bare string, not an array
      assistant(2000, [{ type: "text", text: "bye" }]),
    ]);
    const a = auditTranscript(p);
    const ut = a.components.find((c) => c.component === "userText");
    expect(ut).toBeDefined();
    expect(ut!.calls).toBe(1);
    expect(ut!.rawTokens).toBeCloseTo(body.length / 4, 6);
  });

  test("synthetic usage lines are skipped, so they cannot drag the floor to zero", () => {
    const p = write("synthetic.jsonl", [
      assistant(5000, [{ type: "text", text: "a" }]),
      assistant(0, [], SYNTHETIC_MODEL), // rate-limited turn: all-zero usage
      assistant(6000, [{ type: "text", text: "b" }]),
    ]);
    const a = auditTranscript(p);
    expect(a.turns).toBe(2);
    expect(a.staticFloor).toBe(5000); // NOT 0
  });

  test("an unparseable line is skipped, not thrown on, and is reported", () => {
    const p = write("truncated.jsonl", [
      assistant(1000, [{ type: "text", text: "a" }]),
      '{"type":"assistant","message":{"role":"assis', // caught mid-write
      assistant(2000, [{ type: "text", text: "b" }]),
    ]);
    const a = auditTranscript(p);
    expect(a.skippedLines).toBe(1);
    expect(a.turns).toBe(2);
  });

  // parseLine's fail-loud assertion must survive the tolerance above: a line
  // that IS valid JSON but has renamed usage keys is format drift, not a
  // truncated write, and must never be silently under-counted.
  test("renamed usage keys throw rather than under-report", () => {
    const p = write("drift.jsonl", [
      assistant(1000, [{ type: "text", text: "a" }]),
      JSON.stringify({
        type: "assistant",
        requestId: "r9",
        message: { role: "assistant", model: "claude-opus-4", content: [], usage: { in_tokens: 5, output_tokens: 1 } },
      }),
    ]);
    expect(() => auditTranscript(p)).toThrow(ZError);
  });

  test("a transcript with no usage line fails loudly instead of returning zeros", () => {
    const p = write("empty.jsonl", [user("just a message")]);
    expect(() => auditTranscript(p)).toThrow(ZError);
  });
});

// -- drain vs dev -------------------------------------------------------------

describe("drain/dev separation", () => {
  test("loop-issued commands are drain; operator file reads in the same session are dev", () => {
    const p = write("mixed.jsonl", [
      // pre-drain operator work
      assistant(1000, [toolUse("d1", "Read", { file_path: "/repo/lib/loop.ts" })]),
      user([toolResult("d1", "SOURCE".repeat(500))]),
      // drain starts
      assistant(1100, [toolUse("t1", "Bash", { command: TICK })]),
      user([toolResult("t1", '{"kind":"claim","ticket":42,"stage":"builder"}')]),
      // loop lib call -> drain
      assistant(1200, [toolUse("t2", "Bash", { command: 'bun "$PACK/lib/loop.ts" apply s.json a.json' })]),
      user([toolResult("t2", "applied claim #42")]),
      // operator reading pack source mid-drain -> dev
      assistant(1300, [toolUse("d2", "Read", { file_path: "/repo/lib/stage-prompts.ts" })]),
      user([toolResult("d2", "MORESOURCE".repeat(400))]),
      assistant(1400, [{ type: "text", text: "ok" }]),
    ]);
    const a = auditTranscript(p);
    const byKey = (comp: string, phase: string) => a.components.find((c) => c.component === comp && c.phase === phase);
    expect(byKey("toolResult:Bash/tick", "drain")).toBeDefined();
    expect(byKey("toolResult:Bash/libcall", "drain")).toBeDefined();
    // Both Reads are the operator's, including the one during the drain.
    expect(byKey("toolResult:Read", "drain")).toBeUndefined();
    expect(byKey("toolResult:Read", "dev")!.calls).toBe(2);
  });

  test("git counts as drain only inside a lane worktree", () => {
    const p = write("git.jsonl", [
      assistant(1000, [toolUse("t0", "Bash", { command: TICK })]),
      user([toolResult("t0", "{}")]),
      assistant(1100, [toolUse("g1", "Bash", { command: 'git -C ".worktrees/ticket-7" status --porcelain --branch' })]),
      user([toolResult("g1", "## z/ticket-7")]),
      assistant(1200, [toolUse("g2", "Bash", { command: "git log --oneline -20" })]),
      user([toolResult("g2", "abc123 something")]),
      assistant(1300, [{ type: "text", text: "x" }]),
    ]);
    const a = auditTranscript(p);
    expect(a.components.find((c) => c.component === "toolResult:Bash/git" && c.phase === "drain")!.calls).toBe(1);
    expect(a.components.find((c) => c.component === "toolResult:Bash/git" && c.phase === "dev")!.calls).toBe(1);
  });

  // The SKILL.md body always arrives BEFORE the first tick fires, so a
  // position-based rule would file the loop's own instructions under "dev".
  test("the skill body is drain cost even though it precedes the first tick", () => {
    const p = write("skillbody.jsonl", [
      user("Spawn a FRESH harness Agent (Agent tool), run_in_background: true" + "!".repeat(3000)),
      assistant(1000, [toolUse("t1", "Bash", { command: TICK })]),
      user([toolResult("t1", "{}")]),
      assistant(2000, [{ type: "text", text: "x" }]),
    ]);
    const a = auditTranscript(p);
    const sb = a.components.find((c) => c.component === "skillBody");
    expect(sb).toBeDefined();
    expect(sb!.phase).toBe("drain");
  });
});

// -- turn weighting -----------------------------------------------------------

describe("turn weighting", () => {
  // The whole premise: a block entering early is paid for on every later turn,
  // so identical content costs more the earlier it lands. If this ever collapses
  // to "size only", the tool stops measuring the thing that matters.
  test("identical content costs more the earlier it enters the window", () => {
    const blob = "Q".repeat(4000);
    // Windows must GROW: a flat window means accretion == 0, every component
    // costs 0, and the comparison below would be vacuously equal. Same total
    // billed and same growth curve in both files, so the ONLY difference is
    // where the blob lands.
    const windows = [1000, 2000, 3000, 4000, 5000];
    const early = write("early.jsonl", [
      assistant(windows[0], [toolUse("a", "Bash", { command: TICK })]),
      user([toolResult("a", blob)]),
      assistant(windows[1], [{ type: "text", text: "." }]),
      assistant(windows[2], [{ type: "text", text: "." }]),
      assistant(windows[3], [{ type: "text", text: "." }]),
      assistant(windows[4], [{ type: "text", text: "." }]),
    ]);
    const late = write("late.jsonl", [
      assistant(windows[0], [{ type: "text", text: "." }]),
      assistant(windows[1], [{ type: "text", text: "." }]),
      assistant(windows[2], [{ type: "text", text: "." }]),
      assistant(windows[3], [toolUse("a", "Bash", { command: TICK })]),
      user([toolResult("a", blob)]),
      assistant(windows[4], [{ type: "text", text: "." }]),
    ]);
    const e = auditTranscript(early).components.find((c) => c.component === "toolResult:Bash/tick")!;
    const l = auditTranscript(late).components.find((c) => c.component === "toolResult:Bash/tick")!;
    expect(e.rawTokens).toBeCloseTo(l.rawTokens, 6); // same bytes
    expect(e.cost).toBeGreaterThan(l.cost); // different cost
  });
});

// -- split-response dedup ------------------------------------------------------

// Claude Code writes one transcript line per content block, and every line of a
// split response repeats that response's usage snapshot verbatim. Counting the
// window per LINE prices one API call once per block. The reconciliation
// invariant cannot catch it -- floor and components inflate together, so the
// audit still balances at ~2x (measured 1.87x over an 88-session corpus:
// 17,693 usage lines / 8,839 unique responses). Only these tests pin it.
describe("split-response dedup", () => {
  // Same requestId across two lines, DISTINCT content on each -- the real shape
  // (5,076 of 5,083 multi-line responses in the corpus carry distinct blocks).
  function split(reqId: string, billed: number, content: any[], id?: string) {
    return JSON.stringify({
      type: "assistant",
      requestId: reqId,
      message: {
        role: "assistant",
        model: "claude-opus-4-20250101",
        ...(id ? { id } : {}),
        content,
        usage: { input_tokens: 0, output_tokens: 10, cache_read_input_tokens: billed, cache_creation_input_tokens: 0 },
      },
    });
  }

  test("a response split across lines is one turn billed once", () => {
    const p = write("split.jsonl", [
      split("r1", 1000, [toolUse("t1", "Bash", { command: TICK })]),
      split("r1", 1000, [{ type: "text", text: "prose half of the same response" }]),
      user([toolResult("t1", "Z".repeat(400))]),
      split("r2", 1500, [{ type: "text", text: "." }]),
    ]);
    const a = auditTranscript(p);
    expect(a.turns).toBe(2); // not 3
    expect(a.totalBilled).toBe(1000 + 1500); // not 3500
    expect(a.staticFloor).toBe(1000);
    expect(a.staticFloorCost).toBe(2000);
    expect(a.accretion).toBe(500);
    const sum = a.components.reduce((s, c) => s + c.cost, 0) + a.staticFloorCost;
    expect(sum).toBeCloseTo(a.totalBilled, 6);
  });

  // Dedup is on the usage snapshot only. Each line of a split response carries a
  // DIFFERENT content block, so dropping their content would under-report the
  // very components the tool exists to rank.
  test("both halves of a split response still contribute content", () => {
    const p = write("split-content.jsonl", [
      split("r1", 1000, [toolUse("t1", "Bash", { command: TICK })]),
      split("r1", 1000, [{ type: "text", text: "K".repeat(4000) }]),
      split("r2", 4000, [{ type: "text", text: "." }]),
    ]);
    const a = auditTranscript(p);
    const names = a.components.map((c) => c.component);
    expect(names).toContain("toolUseParams");
    expect(names).toContain("assistantText");
    const text = a.components.find((c) => c.component === "assistantText")!;
    expect(text.rawTokens).toBeGreaterThan(900); // the 4000-char half survived
  });

  // lib/cost.ts F14: one response's lines don't all carry the same id fields --
  // a requestId+message.id line can sit next to a message.id-only sibling. Both
  // keys must dedup or the two halves get different keys and bill twice.
  test("a message.id-only sibling dedups against its requestId line", () => {
    const withBoth = split("r1", 1000, [{ type: "text", text: "a" }], "msg_1");
    const idOnly = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-opus-4-20250101",
        id: "msg_1",
        content: [{ type: "text", text: "b" }],
        usage: { input_tokens: 0, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
      },
    });
    const p = write("split-msgid.jsonl", [withBoth, idOnly, split("r2", 1500, [{ type: "text", text: "." }])]);
    const a = auditTranscript(p);
    expect(a.turns).toBe(2);
    expect(a.totalBilled).toBe(2500);
  });

  // The full F14 chain from lib/cost.ts, and the reason keys must be registered
  // BEFORE the duplicate skip rather than after. The middle line is the only
  // thing linking r1 to m1; skip it before it registers and the msgid-only
  // sibling looks new. Caught in ship review: the first cut of the dedup fix
  // skipped first and billed this response twice (turns 3, totalBilled 3500).
  test("a mixed-id chain dedups whichever order the linking line arrives in", () => {
    const reqOnly = split("r1", 1000, [{ type: "text", text: "a" }]);
    const both = split("r1", 1000, [{ type: "text", text: "b" }], "msg_1");
    const idOnly = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-opus-4-20250101",
        id: "msg_1",
        content: [{ type: "text", text: "c" }],
        usage: { input_tokens: 0, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
      },
    });
    const tail = split("r2", 1500, [{ type: "text", text: "." }]);
    const a = auditTranscript(write("f14-chain.jsonl", [reqOnly, both, idOnly, tail]));
    expect(a.turns).toBe(2);
    expect(a.totalBilled).toBe(2500);
  });

  // Neither id present: parseLine falls back to a "file:line" key, unique per
  // line. Every line must still count -- a fallback line is priced once, never
  // dropped as a phantom duplicate.
  test("lines carrying neither id are each counted, never collapsed", () => {
    const bare = (billed: number, text: string) =>
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-opus-4-20250101",
          content: [{ type: "text", text }],
          usage: { input_tokens: 0, output_tokens: 10, cache_read_input_tokens: billed, cache_creation_input_tokens: 0 },
        },
      });
    const a = auditTranscript(write("no-ids.jsonl", [bare(1000, "a"), bare(1000, "b"), bare(1500, "c")]));
    expect(a.turns).toBe(3);
    expect(a.totalBilled).toBe(3500);
  });

  // Keys register regardless of `billed`, so the first line of a response wins
  // even when its snapshot reads 0 and a sibling's does not. costOfFiles
  // resolves a divergent sibling the same way. Both rest on the empirical fact
  // that a response's lines repeat one snapshot verbatim, so this pins the
  // resolution rather than leaving a divergence to shift the totals in silence.
  test("first-seen snapshot wins when siblings disagree", () => {
    const p = write("divergent-siblings.jsonl", [
      split("r1", 0, [{ type: "text", text: "a" }]),
      split("r1", 1000, [{ type: "text", text: "b" }]),
      split("r2", 1500, [{ type: "text", text: "." }]),
    ]);
    const a = auditTranscript(p);
    expect(a.turns).toBe(1); // r1's zero snapshot won and carries no window
    expect(a.totalBilled).toBe(1500);
  });

  // Red team, and the reason the two fixes in this change had to be tested
  // TOGETHER rather than each on its own: first-wins-zero can leave a session
  // with no readable window even though it holds real usage lines, and the
  // sweep's skip would then drop that whole session's spend while reporting the
  // run complete. The two behaviours are individually defensible and jointly a
  // silent subtraction, so this file must never read as an abandoned prompt.
  test("real usage lines that all dedup to zero abort rather than skip", () => {
    const p = write("real-but-zero.jsonl", [
      split("r1", 0, [{ type: "text", text: "a" }]),
      split("r1", 50000, [{ type: "text", text: "b" }]),
      split("r2", 0, [{ type: "text", text: "c" }]),
      split("r2", 60000, [{ type: "text", text: "d" }]),
    ]);
    expect(() => auditTranscript(p)).toThrow(ZError);
    expect(() => auditTranscript(p)).not.toThrow(NoUsageLineError);
    try {
      auditTranscript(p);
    } catch (e) {
      expect((e as Error).message).toContain("4 assistant usage line(s)");
      expect((e as Error).message).not.toContain("carries no assistant usage line");
    }
  });

  test("a session with real-but-zero usage is not silently skipped by a sweep", () => {
    const dead = write("sweep-zero.jsonl", [
      split("z1", 0, [{ type: "text", text: "a" }]),
      split("z1", 50000, [{ type: "text", text: "b" }]),
    ]);
    const alive = write("sweep-alive.jsonl", [
      split("q1", 1000, [{ type: "text", text: "x" }]),
      split("q2", 2600, [{ type: "text", text: "y" }]),
    ]);
    const CA = join(REPO_ROOT, "lib", "context-audit.ts");
    const r = Bun.spawnSync(["bun", CA, "audit", dead, alive, "--json"], { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(1); // NOT a clean report with the session quietly missing
    expect(r.stderr.toString()).toContain("assistant usage line(s), but every one billed 0");
  });

  // Dedup keys are per-transcript. The same response appearing in two session
  // files is two sessions each re-sending that window, which is exactly what a
  // rollup should add up -- deduping across files would erase real spend.
  test("keys do not leak across sessions in a rollup", () => {
    const a1 = write("dup-a.jsonl", [split("shared", 1000, [{ type: "text", text: "a" }]), split("x1", 1200, [{ type: "text", text: "." }])]);
    const a2 = write("dup-b.jsonl", [split("shared", 1000, [{ type: "text", text: "a" }]), split("x2", 1200, [{ type: "text", text: "." }])]);
    const r = rollup([auditTranscript(a1), auditTranscript(a2)]);
    expect(r.turns).toBe(4);
    expect(r.totalBilled).toBe(4400);
  });
});

// -- rollup -------------------------------------------------------------------

describe("rollup", () => {
  test("merges sessions and preserves the invariant across the whole set", () => {
    const p1 = write("r1.jsonl", [
      assistant(1000, [toolUse("t1", "Bash", { command: TICK })]),
      user([toolResult("t1", "A".repeat(200))]),
      assistant(1400, [{ type: "text", text: "x" }]),
    ]);
    const p2 = write("r2.jsonl", [
      assistant(2000, [toolUse("t1", "Bash", { command: TICK })]),
      user([toolResult("t1", "B".repeat(600))]),
      assistant(2600, [{ type: "text", text: "y" }]),
    ]);
    const audits = [auditTranscript(p1), auditTranscript(p2)];
    const r = rollup(audits);
    expect(r.sessions).toBe(2);
    expect(r.totalBilled).toBe(1000 + 1400 + 2000 + 2600);
    const sum = r.components.reduce((s, c) => s + c.cost, 0) + r.staticFloorCost;
    expect(sum).toBeCloseTo(r.totalBilled, 6);
  });
});

// -- CLI ----------------------------------------------------------------------

describe("context-audit CLI", () => {
  const CA = join(REPO_ROOT, "lib", "context-audit.ts");
  const run = (...args: string[]) => Bun.spawnSync(["bun", CA, ...args], { stdout: "pipe", stderr: "pipe" });

  test("audit prints a reconciling report; --json round-trips", () => {
    const p = write("cli.jsonl", [
      assistant(1000, [toolUse("t1", "Bash", { command: TICK })]),
      user([toolResult("t1", "A".repeat(800))]),
      assistant(1600, [{ type: "text", text: "x" }]),
    ]);
    const txt = run("audit", p);
    expect(txt.exitCode).toBe(0);
    expect(txt.stdout.toString()).toContain("static prefix");

    const js = run("audit", p, "--json");
    expect(js.exitCode).toBe(0);
    const parsed = JSON.parse(js.stdout.toString());
    expect(parsed.totalBilled).toBe(2600);
    const sum = parsed.components.reduce((s: number, c: any) => s + c.cost, 0) + parsed.staticFloorCost;
    expect(sum).toBeCloseTo(parsed.totalBilled, 6);
  });

  test("an unknown command and an unreadable transcript both fail loudly", () => {
    expect(run("nope").exitCode).toBe(1);
    const missing = run("audit", join(dir, "no-such-file.jsonl"));
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.toString()).toContain("Cannot read transcript at");
  });

  // A corpus sweep is the CLI's documented multi-path use, and ~3% of a real
  // session corpus is an abandoned session with no assistant usage line. One of
  // those used to abort the entire rollup.
  describe("a dead session does not take the corpus with it", () => {
    const live = () => [
      assistant(1000, [toolUse("t1", "Bash", { command: TICK })]),
      user([toolResult("t1", "A".repeat(800))]),
      assistant(1600, [{ type: "text", text: "x" }]),
    ];

    test("multi-path: the empty session is skipped, named, and excluded", () => {
      const good = write("sweep-good.jsonl", live());
      const dead = write("sweep-dead.jsonl", [user("just a prompt, never answered")]);
      const r = run("audit", good, dead, "--json");
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout.toString());
      expect(parsed.sessions).toBe(1);
      expect(parsed.unauditable).toEqual([dead]);
      expect(parsed.totalBilled).toBe(2600); // the dead file contributes nothing
      const txt = run("audit", good, dead);
      expect(txt.stdout.toString()).toContain("sweep-dead.jsonl");
    });

    // The skip is scoped to "nothing to attribute". A renamed usage key is
    // format drift and must still abort, or the sweep quietly under-reports.
    test("format drift still aborts the whole sweep", () => {
      const good = write("sweep-good2.jsonl", live());
      const drifted = write(
        "sweep-drift.jsonl",
        [JSON.stringify({
          type: "assistant",
          requestId: "d1",
          message: { role: "assistant", model: "claude-opus-4-20250101", content: [], usage: { in_tokens: 5 } },
        })]
      );
      const r = run("audit", good, drifted);
      expect(r.exitCode).toBe(1);
      expect(r.stdout.toString()).not.toContain("static prefix");
    });

    // The skip is scoped to NoUsageLineError alone. An unreadable path is a
    // different ZError and must abort, or a typo'd path silently vanishes from
    // a sweep's totals and the report reads as complete.
    test("an unreadable path still aborts the whole sweep", () => {
      const good = write("sweep-good3.jsonl", live());
      const r = run("audit", good, join(dir, "no-such-file.jsonl"));
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toContain("Cannot read transcript at");
      expect(r.stdout.toString()).not.toContain("static prefix");
    });

    // The skipped list is rendered by basename, not full path -- an absolute
    // path would satisfy a naive "contains the filename" assertion, so pin the
    // directory's absence explicitly.
    test("report names skipped sessions by basename and counts them", () => {
      const r = report(
        rollup([auditTranscript(write("basename-good.jsonl", live()))], ["/abs/some/dir/dead-one.jsonl"])
      );
      expect(r).toContain("1 session(s) skipped");
      expect(r).toContain("dead-one.jsonl");
      expect(r).not.toContain("/abs/some/dir");
    });

    // A glob is a sweep by intent. Deciding on the expanded count alone made
    // the identical documented command hard-fail or succeed depending on how
    // many transcripts happened to be in the directory that day.
    test("a glob is a sweep even when it matches exactly one dead file", () => {
      const g = mkdtempSync(join(tmpdir(), "zstack-ctxglob-"));
      writeFileSync(join(g, "only-dead.jsonl"), user("never answered") + "\n");
      const r = run("audit", join(g, "*.jsonl"), "--json");
      rmSync(g, { recursive: true, force: true });
      expect(r.exitCode).toBe(1); // every path dead is still an error...
      // ...but via the all-dead guard, NOT the single-path strict throw. That
      // distinction is the whole point of treating a glob as a sweep.
      expect(r.stderr.toString()).toContain("None of the 1 transcript(s)");
      expect(r.stderr.toString()).not.toContain("carries no assistant usage line");
    });

    test("a glob matching one live and one dead file skips the dead one", () => {
      const g = mkdtempSync(join(tmpdir(), "zstack-ctxglob2-"));
      writeFileSync(join(g, "a-live.jsonl"), live().join("\n") + "\n");
      writeFileSync(join(g, "b-dead.jsonl"), user("never answered") + "\n");
      const r = run("audit", join(g, "*.jsonl"), "--json");
      rmSync(g, { recursive: true, force: true });
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout.toString());
      expect(parsed.sessions).toBe(1);
      expect(parsed.unauditable.length).toBe(1);
    });

    // Red team: one file reachable through two positionals was audited twice and
    // its tokens counted twice -- a 1.5x inflation of exactly the absolutes the
    // dedup fix exists to correct, invisible because both copies reconcile.
    test("a file reached by two positionals is audited once", () => {
      const g = mkdtempSync(join(tmpdir(), "zstack-ctxdup-"));
      writeFileSync(join(g, "a.jsonl"), live().join("\n") + "\n");
      writeFileSync(join(g, "b.jsonl"), live().join("\n") + "\n");
      const globOnly = JSON.parse(run("audit", join(g, "*.jsonl"), "--json").stdout.toString());
      const overlap = JSON.parse(run("audit", join(g, "*.jsonl"), join(g, "a.jsonl"), "--json").stdout.toString());
      const twice = JSON.parse(run("audit", join(g, "a.jsonl"), join(g, "a.jsonl"), "--json").stdout.toString());
      rmSync(g, { recursive: true, force: true });
      expect(globOnly.sessions).toBe(2);
      expect(overlap.sessions).toBe(2);
      expect(overlap.totalBilled).toBe(globOnly.totalBilled);
      expect(twice.sessions).toBe(1);
    });

    // Red team: Bun.Glob read "session[1].jsonl" as a character class and
    // silently audited a decoy, reporting the wrong file's numbers with exit 0.
    // An existing file is a literal path whatever characters are in its name.
    test("a literal path containing glob metacharacters reads that file", () => {
      const g = mkdtempSync(join(tmpdir(), "zstack-ctxmeta-"));
      writeFileSync(join(g, "session[1].jsonl"), live().join("\n") + "\n");
      writeFileSync(join(g, "session1.jsonl"), [assistant(7, [{ type: "text", text: "decoy" }])].join("\n") + "\n");
      const r = run("audit", join(g, "session[1].jsonl"), "--json");
      rmSync(g, { recursive: true, force: true });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout.toString()).totalBilled).toBe(2600); // not the decoy's 7
    });

    // Red team: a glob matching nothing fell through to the literal, so the
    // pattern itself hit readFileSync and a mistyped extension read as ENOENT.
    test("a glob matching nothing says so instead of ENOENT on the pattern", () => {
      const g = mkdtempSync(join(tmpdir(), "zstack-ctxnomatch-"));
      writeFileSync(join(g, "a.jsonl"), live().join("\n") + "\n");
      const r = run("audit", join(g, "*.nomatch"));
      rmSync(g, { recursive: true, force: true });
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toContain("No files matched");
      expect(r.stderr.toString()).not.toContain("ENOENT");
    });

    // Red team: colliding basenames rendered as identical lines, so the operator
    // could not tell which sessions dropped. The loop's own transcripts are all
    // named "<stage>-<attempt>.jsonl", so a sweep across ticket dirs always collides.
    test("colliding basenames render as full paths", () => {
      const good = auditTranscript(write("collide-good.jsonl", live()));
      const distinct = report(rollup([good], ["/x/alpha/one.jsonl", "/x/beta/two.jsonl"]));
      expect(distinct).toContain("one.jsonl");
      expect(distinct).not.toContain("/x/alpha");
      const colliding = report(rollup([good], ["/x/alpha/chat.jsonl", "/x/beta/chat.jsonl"]));
      expect(colliding).toContain("/x/alpha/chat.jsonl");
      expect(colliding).toContain("/x/beta/chat.jsonl");
    });

    test("a single named empty transcript still errors", () => {
      const dead = write("solo-dead.jsonl", [user("nothing here")]);
      const r = run("audit", dead);
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toContain("no assistant usage line");
    });

    test("every path dead is an error, not an empty report", () => {
      const d1 = write("all-dead-1.jsonl", [user("a")]);
      const d2 = write("all-dead-2.jsonl", [user("b")]);
      const r = run("audit", d1, d2);
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toContain("None of the 2 transcript(s)");
    });
  });
});
