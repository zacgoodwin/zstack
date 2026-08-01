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
import { auditTranscript, assertReconciles, rollup, type ComponentSpend } from "../lib/context-audit.ts";
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
});
