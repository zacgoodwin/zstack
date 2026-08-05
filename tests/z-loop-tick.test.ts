// Gate test for bin/z-loop-tick (ticket #57, Leak 2, AC4): the per-iteration
// drain wrapper must print EXACTLY one valid Action JSON line and leave the same
// state file the old three-step snapshot -> ingest -> next sequence produced.
// Also covers the human-needed safety control (issue #63) the wrapper now runs
// each tick: it writes $TMP/human-needed.json, and a notify.ts send failure
// (an unconfigured slug on the test machine) never aborts the tick or sets the
// fire-once flag.
//
// z-board is stubbed via the $Z_BOARD seam (the loop preamble exports it; here it
// points at a fake that emits a fixed board). That is the portable stand-in for
// dropping a stub z-board on PATH -- git-bash on Windows cannot reliably resolve
// a colon-joined PATH from a bun-spawned process, and $Z_BOARD is the same seam
// the real loop already uses. The wrapper runs the REAL lib/loop.ts (its
// $PACK resolves to this repo), so ingest + next are the production code paths.
//
// Issue #58 adds a throttle step at the top of the wrapper's flow (before the
// snapshot call) that shells to `bun lib/throttle.ts wait --slug <slug>`, which
// calls the REAL loadConfig. So every spawn below now also points USERPROFILE
// (the env var Bun's os.homedir() reads on Windows; HOME is set alongside for
// POSIX runners) at a temp home carrying a minimal, valid `demo` project config
// -- never the real ~/.zstack.
import { test, expect, describe, afterAll } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { throttleDelayMs, throttleTick, defaultLoopDir, readLastTick } from "../lib/throttle.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const Z_LOOP_TICK = join(REPO_ROOT, "bin", "z-loop-tick");

// Every test below that spawns bin/z-loop-tick gets this budget instead of bun's
// 5000ms default. MEASURED on this Windows machine, idle, with --timeout 120000
// so nothing was cut short: the nine tick-driving tests run 1.98s-4.86s, and the
// slowest (#150, which drives TWO ticks) lands within 3% of the default. One
// tick costs ~2s because bin/z-loop-tick runs seven sequential `bun` subprocess
// spawns on every iteration -- throttle wait, locks beat, context-budget
// current, loop confirm-targets, loop ingest, loop human-needed, loop next --
// plus the stubbed z-board and two jq calls, and process spawn on Windows is far
// more expensive than on POSIX.
//
// So the default was never a real budget here -- it was a coin flip that came up
// heads on an idle machine. Under load it failed nondeterministically: three
// consecutive runs of this file produced 9, then 5, then 2 failures, every one a
// timeout and never an assertion (issue #252).
//
// 30s is ~6x the measured idle worst case. It is deliberately NOT unbounded: a
// tick that genuinely hangs (a lock never released, a subprocess awaiting stdin)
// still fails this suite rather than stalling CI forever. Raise it only with a
// fresh measurement pasted here -- if the honest number ever approaches 30s, the
// fix is to cut the spawn count, not to grow this constant again.
const TICK_TIMEOUT_MS = 30_000;

// The board the stubbed `z-board snapshot` emits: one Ready ticket, no deps.
const ITEMS = JSON.stringify([
  { number: 1, title: "T1", url: "http://x/1", fields: { Status: "Ready" } },
]);
const BODIES = JSON.stringify({ "1": "no deps" });

// A board that trips the human-needed control on the very first tick: 1
// Ready ticket (the committed batch size, #133 -- the committed queue sits in
// Ready until claimed) plus 2 Blocked + 1 Skipped already parked --
// (2+1)/1*100 = 300% > the default 30% threshold.
const TRIPPED_ITEMS = JSON.stringify([
  { number: 1, title: "T1", url: "http://x/1", fields: { Status: "Ready" } },
  { number: 2, title: "T2", url: "http://x/2", fields: { Status: "Blocked" } },
  { number: 3, title: "T3", url: "http://x/3", fields: { Status: "Blocked" } },
  { number: 4, title: "T4", url: "http://x/4", fields: { Status: "Skipped" } },
]);
const TRIPPED_BODIES = JSON.stringify({ "1": "no deps", "2": "no deps", "3": "no deps", "4": "no deps" });

// #203: those 3 parks only belong to THIS batch's numerator if the batch filed
// them -- which requires a prior state to be new against. Written to --state
// before the tick, this is a drained prior batch (one Done ticket, no lanes, no
// batchTickets, so the tick's own ingest starts a fresh batch): every ticket on
// TRIPPED_ITEMS is then new to prev, exactly the #133 AC4 shape the parks are
// standing in for. Without it the tick ingests a fresh state and the 3 parks are
// indistinguishable from work parked before the run, which is the false trip
// #203 removed.
function seedDrainedPrevState(statePath: string): void {
  writeFileSync(
    statePath,
    JSON.stringify({
      tickets: [{ number: 9, title: "prior", status: "Done", dependsOn: [] }],
      lanes: [],
      maxLanes: 3,
      watchdogMinutes: 10,
      initialReadyCount: 1,
      initialBatchTickets: [9],
    })
  );
}

const dirs: string[] = [];
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "z-loop-tick-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// A fake $HOME/$USERPROFILE carrying a minimal, valid config.json for slug
// "demo" (issue #58: bin/z-loop-tick's throttle step now calls the real
// loadConfig("demo"), which must resolve to something valid, never the
// operator's real ~/.zstack).
function makeConfigHome(tickThrottleSeconds?: number): string {
  const home = mkTmp();
  const dir = join(home, ".zstack", "projects", "demo");
  mkdirSync(dir, { recursive: true });
  const cfg: any = {
    slug: "demo",
    owner: "acme",
    repo: "demo",
    projectNumber: 1,
    projectId: "PVT_1",
    repositoryId: "R_1",
    statusField: { id: "F_status", dataType: "SINGLE_SELECT", options: { Backlog: "o1", Ready: "o2", Done: "o3" } },
    fields: {},
  };
  if (tickThrottleSeconds !== undefined) cfg.tickThrottleSeconds = tickThrottleSeconds;
  writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));
  return home;
}

// A fake z-board implementing the two subcommands the tick calls: `snapshot`
// (writing the given board to --out-items / --out-bodies, exactly what the real
// one does) and, for #138, `item <N>` (the single-ticket confirm lookup, answered
// from `lookups`, keyed by issue number). Defaults to the module-level
// ITEMS/BODIES fixture; a test that needs a different board (e.g. to trip the
// human-needed control) passes its own. An `item` call with no stubbed answer
// exits non-zero -- the real transport-failure shape, which the tick must
// survive by carrying that ticket forward.
function writeStubZBoard(dir: string, items = ITEMS, bodies = BODIES, lookups: Record<string, unknown> = {}): string {
  const stub = join(dir, "z-board");
  const itemCases = Object.entries(lookups)
    .map(([n, answer]) => `    ${n}) printf '%s\\n' ${JSON.stringify(JSON.stringify(answer))} ;;`)
    .join("\n");
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
set -e
cmd="$1"; shift || true
OUT_ITEMS=""; OUT_BODIES=""; N=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out-items) OUT_ITEMS="$2"; shift 2 ;;
    --out-bodies) OUT_BODIES="$2"; shift 2 ;;
    --slug) shift 2 ;;
    *) [ -z "$N" ] && N="$1"; shift ;;
  esac
done
if [ "$cmd" = "snapshot" ]; then
  printf '%s' ${JSON.stringify(items)} > "$OUT_ITEMS"
  printf '%s' ${JSON.stringify(bodies)} > "$OUT_BODIES"
  echo "stub snapshot ok"   # discarded by z-loop-tick's >/dev/null
fi
if [ "$cmd" = "item" ]; then
  case "$N" in
${itemCases}
    *) echo "stub z-board: no item fixture for #$N" >&2; exit 1 ;;
  esac
fi
`
  );
  chmodSync(stub, 0o755);
  return stub;
}

// A prior state file with two in-flight builder lanes -- what the confirm pass
// exists for. Written straight to disk (not built by an ingest) so the tick's
// own read of state.json is what is under test.
function writeLaneState(path: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      tickets: [
        { number: 1, title: "T1", status: "Building", dependsOn: [] },
        { number: 2, title: "T2", status: "Building", dependsOn: [] },
      ],
      lanes: [
        { ticket: 1, stage: "builder", lastActivityMs: 0, qaBounces: 0, reviewBounces: 0 },
        { ticket: 2, stage: "builder", lastActivityMs: 0, qaBounces: 0, reviewBounces: 0 },
      ],
      maxLanes: 3,
      watchdogMinutes: 10,
      mergedThisRun: [],
      initialReadyCount: 2,
      initialBatchTickets: [1, 2],
      batchTickets: [1, 2],
      humanNeededNotified: false,
    })
  );
}

describe("z-loop-tick", () => {
  test("prints exactly one Action JSON line and writes the same state the 3-step sequence produces", () => {
    const dir = mkTmp();
    const stub = writeStubZBoard(dir);
    const home = makeConfigHome(); // tickThrottleSeconds omitted -> defaults to 0 (off)
    const tickTmp = join(dir, "tick-tmp");
    const tickState = join(dir, "tick-state.json");

    const proc = Bun.spawnSync(
      ["bash", Z_LOOP_TICK, "--slug", "demo", "--state", tickState, "--tmp", tickTmp, "--session", "test-session"],
      { env: { ...process.env, Z_BOARD: stub, HOME: home, USERPROFILE: home }, stdout: "pipe", stderr: "pipe" }
    );
    expect(proc.exitCode).toBe(0);

    // stdout is EXACTLY one non-empty line: the Action JSON (throttle,
    // snapshot, and ingest are all silenced inside the wrapper).
    const lines = proc.stdout.toString().split(/\r?\n/).filter((l) => l.trim() !== "");
    expect(lines.length).toBe(1);
    const action = JSON.parse(lines[0]);
    expect(action).toEqual({ kind: "claim", ticket: 1, stage: "builder" });

    // The state file z-loop-tick wrote equals what the manual sequence produces:
    // the only step that writes state is `ingest`, so run it directly on the same
    // fixture and compare byte-for-byte. #131: the wrapper now threads a live
    // context reading as `--context-tokens N`; under the temp $HOME there is no
    // ~/.claude/projects, so context-budget resolves nothing and reads 0
    // (fail-open) -- the manual ingest passes the same `--context-tokens 0` so
    // both states carry contextTokens:0 and the default contextTokenLimit.
    const items = join(dir, "items.json");
    const bodies = join(dir, "bodies.json");
    const expectedState = join(dir, "expected-state.json");
    writeFileSync(items, ITEMS);
    writeFileSync(bodies, BODIES);
    const ing = Bun.spawnSync(
      ["bun", join(REPO_ROOT, "lib", "loop.ts"), "ingest", expectedState, items, bodies, "--context-tokens", "0"],
      { stdout: "pipe", stderr: "pipe" }
    );
    expect(ing.exitCode).toBe(0);
    expect(readFileSync(tickState, "utf8")).toBe(readFileSync(expectedState, "utf8"));

    // #131: this is the FAIL-OPEN branch -- under the temp $HOME there is no
    // ~/.claude/projects transcript, so context-budget resolves nothing and reads
    // 0. (The NONZERO, load-bearing reading -- proof the wrapper actually threads
    // the value -- is the sibling test below, which plants a real transcript.)
    const tickWritten = JSON.parse(readFileSync(tickState, "utf8"));
    expect(tickWritten.contextTokens).toBe(0);
    expect(tickWritten.contextTokenLimit).toBe(550000);

    // Human-needed safety control (issue #63): the first tick's ITEMS is one
    // Ready ticket, so #133's Ready-count capture makes initialReadyCount = 1
    // (was 0 under the old Building-count capture). With 0 parked it still never
    // trips (0/1 = 0% < 30%).
    const hn = JSON.parse(readFileSync(join(tickTmp, "human-needed.json"), "utf8"));
    expect(hn).toMatchObject({ tripped: false, alreadyNotified: false, blocked: 0, skipped: 0, questions: 0, initialReadyCount: 1 });

    // The throttle step actually ran end to end (not just skipped): it stamped
    // a real last-tick file under the project's loop dir.
    const loopDir = defaultLoopDir("demo", home);
    expect(existsSync(join(loopDir, "last-tick"))).toBe(true);
    expect(readLastTick(loopDir)).not.toBeNull();
  }, TICK_TIMEOUT_MS);

  // #131 review-bounce finding 3(b): the assertion above (contextTokens === 0)
  // is NOT load-bearing on its own -- a reverted wrapper that never threads
  // --context-tokens also yields 0. This drives the wrapper -> ingest -> state
  // path with a NONZERO live reading: a real session transcript planted under a
  // known cwd's ~/.claude/projects/<mangled-cwd>/ dir, so context-budget resolves
  // a concrete number the wrapper MUST thread into ingest. If the wrapper stopped
  // threading it (the reverted case), contextTokens would be 0, not this value.
  test("the wrapper threads a NONZERO live context reading into the per-tick ingest (load-bearing #131)", () => {
    const dir = mkTmp();
    const stub = writeStubZBoard(dir);
    const home = makeConfigHome();
    // The wrapper reads context-budget for --project-dir "$PWD"; pin $PWD to a
    // known cwd and plant that session's transcript under the fake home so the
    // reading is deterministic (input 300000 + cache_read 100000 + cache_creation
    // 50000 = 450000; output excluded).
    const cwd = join(dir, "orch-cwd");
    mkdirSync(cwd, { recursive: true });
    const mangled = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const projDir = join(home, ".claude", "projects", mangled);
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, "session.jsonl"),
      JSON.stringify({
        type: "assistant",
        requestId: "req_1",
        message: {
          model: "claude-opus-4",
          id: "msg_1",
          usage: { input_tokens: 300000, output_tokens: 900, cache_read_input_tokens: 100000, cache_creation_input_tokens: 50000 },
        },
      }) + "\n"
    );

    const tickTmp = join(dir, "tick-tmp");
    const tickState = join(dir, "tick-state.json");
    const proc = Bun.spawnSync(
      ["bash", Z_LOOP_TICK, "--slug", "demo", "--state", tickState, "--tmp", tickTmp, "--session", "test-session"],
      { cwd, env: { ...process.env, Z_BOARD: stub, HOME: home, USERPROFILE: home }, stdout: "pipe", stderr: "pipe" }
    );
    expect(proc.exitCode).toBe(0);

    // The live reading landed on the state file -- proof the wrapper computed it
    // AND threaded it through --context-tokens into the ingest.
    const written = JSON.parse(readFileSync(tickState, "utf8"));
    expect(written.contextTokens).toBe(450000);
    expect(written.contextTokenLimit).toBe(550000); // default ceiling captured on first ingest

    // Cross-check: the identical ingest run manually with --context-tokens 450000
    // produces the same state, so the wrapper's only context-side effect is
    // threading exactly this reading (nothing else moved).
    const items = join(dir, "items.json");
    const bodies = join(dir, "bodies.json");
    const expectedState = join(dir, "expected-state.json");
    writeFileSync(items, ITEMS);
    writeFileSync(bodies, BODIES);
    const ing = Bun.spawnSync(
      ["bun", join(REPO_ROOT, "lib", "loop.ts"), "ingest", expectedState, items, bodies, "--context-tokens", "450000"],
      { stdout: "pipe", stderr: "pipe" }
    );
    expect(ing.exitCode).toBe(0);
    expect(readFileSync(tickState, "utf8")).toBe(readFileSync(expectedState, "utf8"));
  }, TICK_TIMEOUT_MS);

  test("missing a required flag fails loudly, prints no Action", () => {
    const dir = mkTmp();
    const stub = writeStubZBoard(dir);
    const proc = Bun.spawnSync(
      ["bash", Z_LOOP_TICK, "--slug", "demo", "--tmp", join(dir, "t")], // no --state
      { env: { ...process.env, Z_BOARD: stub }, stdout: "pipe", stderr: "pipe" }
    );
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stdout.toString().trim()).toBe("");
    expect(proc.stderr.toString()).toContain("usage: z-loop-tick");
  }, TICK_TIMEOUT_MS);

  // #198: --session is required, not optional. An absent session would silently
  // disable the liveness heartbeat and reintroduce "a live loop reads stale"
  // with no symptom until a second invocation reconciled over a running drain.
  test("#198: a missing --session fails loudly and prints no Action", () => {
    const dir = mkTmp();
    const stub = writeStubZBoard(dir);
    const proc = Bun.spawnSync(
      ["bash", Z_LOOP_TICK, "--slug", "demo", "--state", join(dir, "s.json"), "--tmp", join(dir, "t")],
      { env: { ...process.env, Z_BOARD: stub }, stdout: "pipe", stderr: "pipe" }
    );
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stdout.toString().trim()).toBe("");
    expect(proc.stderr.toString()).toContain("--session");
  }, TICK_TIMEOUT_MS);

  // -- issue #63: the human-needed safety control -----------------------------
  test("human-needed: writes tripped:true when parked tickets cross the threshold, and an unconfigured notify send never aborts the tick or sets the fire-once flag", () => {
    const dir = mkTmp();
    const stub = writeStubZBoard(dir, TRIPPED_ITEMS, TRIPPED_BODIES);
    // issue #58: the throttle step now runs before snapshot/ingest and calls
    // the real loadConfig("demo"), so this test needs the same config home as
    // the first test even though it's exercising notify.ts, not throttle.ts.
    const home = makeConfigHome();
    const tickTmp = join(dir, "tick-tmp");
    const tickState = join(dir, "tick-state.json");
    seedDrainedPrevState(tickState); // #203: makes the 3 parks this batch's own

    const proc = Bun.spawnSync(
      ["bash", Z_LOOP_TICK, "--slug", "demo", "--state", tickState, "--tmp", tickTmp, "--session", "test-session"],
      { env: { ...process.env, Z_BOARD: stub, HOME: home, USERPROFILE: home }, stdout: "pipe", stderr: "pipe" }
    );
    // The tick must exit 0 and still print exactly one Action line even though
    // slug "demo"'s config has no `notifications` block -- notify.ts's send
    // degrades to a no-op ("skipped"), never throws, and that must never
    // propagate.
    expect(proc.exitCode).toBe(0);
    const lines = proc.stdout.toString().split(/\r?\n/).filter((l) => l.trim() !== "");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0])).toEqual({ kind: "claim", ticket: 1, stage: "builder" });

    const hn = JSON.parse(readFileSync(join(tickTmp, "human-needed.json"), "utf8"));
    expect(hn.tripped).toBe(true); // (2 blocked + 1 skipped) / 1 initialReadyCount = 300% > 30%
    expect(hn.blocked).toBe(2);
    expect(hn.skipped).toBe(1);
    expect(hn.initialReadyCount).toBe(1);

    // The fire-once flag must stay unset: notify.ts never reported "sent", so
    // the real notification still fires once the project IS configured.
    const written = JSON.parse(readFileSync(tickState, "utf8"));
    expect(written.humanNeededNotified).not.toBe(true);
  }, TICK_TIMEOUT_MS);

  // #203, the live repro through the real wrapper: the SAME board as the test
  // above, but with no --state file at all (a project's first run, or any run
  // after a state archive/reset). The 3 parks predate the run, so the batch is
  // the 1 Ready ticket and the control must read 0% -- on main this wrote
  // tripped:true at 300% before a single lane had run, and would have fired a
  // false human-needed page on a configured project.
  test("#203: a tick from a FRESH state file scopes the batch to the Ready queue and does not trip on pre-existing parks", () => {
    const dir = mkTmp();
    const stub = writeStubZBoard(dir, TRIPPED_ITEMS, TRIPPED_BODIES);
    const home = makeConfigHome();
    const tickTmp = join(dir, "tick-tmp");
    const tickState = join(dir, "tick-state.json"); // deliberately NOT seeded

    const proc = Bun.spawnSync(
      ["bash", Z_LOOP_TICK, "--slug", "demo", "--state", tickState, "--tmp", tickTmp, "--session", "test-session"],
      { env: { ...process.env, Z_BOARD: stub, HOME: home, USERPROFILE: home }, stdout: "pipe", stderr: "pipe" }
    );
    expect(proc.exitCode).toBe(0);

    const written = JSON.parse(readFileSync(tickState, "utf8"));
    expect(written.initialBatchTickets).toEqual([1]); // the Ready queue, not all 4 board items
    expect(written.initialReadyCount).toBe(1);

    const hn = JSON.parse(readFileSync(join(tickTmp, "human-needed.json"), "utf8"));
    expect(hn.blocked).toBe(0);
    expect(hn.skipped).toBe(0);
    expect(hn.tripped).toBe(false);
  }, TICK_TIMEOUT_MS);

  // #150: driven through two REAL wrapper ticks against the same --state file
  // (not a hand-built prev), so state.json's persistence across invocations is
  // what's under test, not just ingestBoardItems in isolation. Tick 1 leaves 3
  // Blocked tickets fully drained with nothing else on the board -- a stand-in
  // for "already parked from before this batch started". Tick 2 introduces a
  // fresh batch of 10 Ready tickets while those 3 stay Blocked, untouched --
  // the control must read 0%, not the false 3/10 = 30% a board-wide count
  // would produce before a single lane of the new batch has run.
  test("#150: a fresh batch's human-needed.json ignores 3 pre-existing Blocked tickets from a prior drained batch", () => {
    const dir = mkTmp();
    const home = makeConfigHome();
    const tickTmp = join(dir, "tick-tmp");
    const tickState = join(dir, "tick-state.json");

    const priorItems = JSON.stringify([
      { number: 1, title: "old1", url: "http://x/1", fields: { Status: "Blocked" } },
      { number: 2, title: "old2", url: "http://x/2", fields: { Status: "Blocked" } },
      { number: 3, title: "old3", url: "http://x/3", fields: { Status: "Blocked" } },
    ]);
    const priorBodies = JSON.stringify({ "1": "no deps", "2": "no deps", "3": "no deps" });
    const stub = writeStubZBoard(dir, priorItems, priorBodies);
    const tick1 = Bun.spawnSync(
      ["bash", Z_LOOP_TICK, "--slug", "demo", "--state", tickState, "--tmp", tickTmp, "--session", "test-session"],
      { env: { ...process.env, Z_BOARD: stub, HOME: home, USERPROFILE: home }, stdout: "pipe", stderr: "pipe" }
    );
    expect(tick1.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(tickState, "utf8")).initialReadyCount).toBe(0); // nothing Ready yet, sanity

    const freshNums = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
    const freshItems = JSON.stringify([
      { number: 1, title: "old1", url: "http://x/1", fields: { Status: "Blocked" } },
      { number: 2, title: "old2", url: "http://x/2", fields: { Status: "Blocked" } },
      { number: 3, title: "old3", url: "http://x/3", fields: { Status: "Blocked" } },
      ...freshNums.map((n) => ({ number: n, title: `r${n}`, url: `http://x/${n}`, fields: { Status: "Ready" } })),
    ]);
    const freshBodies = JSON.stringify(Object.fromEntries([1, 2, 3, ...freshNums].map((n) => [String(n), "no deps"])));
    writeStubZBoard(dir, freshItems, freshBodies); // same stub path -- overwrites with the new board

    const tick2 = Bun.spawnSync(
      ["bash", Z_LOOP_TICK, "--slug", "demo", "--state", tickState, "--tmp", tickTmp, "--session", "test-session"],
      { env: { ...process.env, Z_BOARD: stub, HOME: home, USERPROFILE: home }, stdout: "pipe", stderr: "pipe" }
    );
    expect(tick2.exitCode).toBe(0);
    const lines = tick2.stdout.toString().split(/\r?\n/).filter((l) => l.trim() !== "");
    expect(JSON.parse(lines[0])).toEqual({ kind: "claim", ticket: 4, stage: "builder" });

    const state = JSON.parse(readFileSync(tickState, "utf8"));
    expect(state.initialReadyCount).toBe(10); // only the 10 new Ready, not the 3 old Blocked
    expect(state.initialBatchTickets).toEqual(freshNums);

    const hn = JSON.parse(readFileSync(join(tickTmp, "human-needed.json"), "utf8"));
    expect(hn.blocked).toBe(0); // the 3 pre-existing Blocked tickets are excluded
    expect(hn.tripped).toBe(false); // 0/10 = 0%, no false trip before a single lane of this batch ran
    // Two full synchronous wrapper ticks, each shelling several `bun` processes:
    // the only test in this file that pays that cost twice (observed 5.2-5.5s on
    // Windows against bun's 5s default). TICK_TIMEOUT_MS covers it and its
    // siblings, which flake the same way under load.
  }, TICK_TIMEOUT_MS);

  // The test above only exercises the failure/unconfigured branch (`SENT` !=
  // "sent") of z-loop-tick's `[ "$SENT" = "sent" ] && human-needed-ack` line;
  // nothing previously drove the success branch end-to-end through the real
  // wrapper script. This pins it with a real `~/.zstack/projects/<slug>/
  // config.json` (Bun resolves os.homedir() from HOME on POSIX and USERPROFILE
  // on Windows -- both overridden below) and a local mock Discord webhook that actually
  // answers 200, so notify.ts's `send` completes a real round trip and prints
  // "sent". Uses Bun.spawn (async), not spawnSync: a synchronous spawn blocks
  // this process's event loop, which would starve Bun.serve() of the chance to
  // answer the child's request.
  test("human-needed: a successful notify send (real config.json + local webhook) actually POSTs and sets the fire-once flag", async () => {
    const dir = mkTmp();
    const stub = writeStubZBoard(dir, TRIPPED_ITEMS, TRIPPED_BODIES);
    const tickTmp = join(dir, "tick-tmp");
    const tickState = join(dir, "tick-state.json");
    seedDrainedPrevState(tickState); // #203: makes the 3 parks this batch's own

    let hits = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        hits++;
        return new Response("ok", { status: 200 });
      },
    });

    // ZSTACK_DISCORD_WEBHOOK wins over config.json's discordWebhookUrl (and,
    // being env-sourced, skips the config schema's https:// requirement), so
    // the config below only needs notifications.enabled -- no secret on disk.
    const fakeHome = join(dir, "fake-home");
    const slug = "e2e-notify";
    const configDir = join(fakeHome, ".zstack", "projects", slug);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        slug,
        owner: "acme",
        repo: "widgets",
        projectNumber: 1,
        projectId: "PVT_x",
        repositoryId: "R_x",
        statusField: { id: "F_status", dataType: "SINGLE_SELECT", options: { Building: "opt1" } },
        fields: {},
        notifications: { enabled: true },
      })
    );

    try {
      const proc = Bun.spawn(
        ["bash", Z_LOOP_TICK, "--slug", slug, "--state", tickState, "--tmp", tickTmp, "--session", "test-session"],
        {
          env: {
            ...process.env,
            Z_BOARD: stub,
            // Bun's os.homedir() resolves from HOME on POSIX and USERPROFILE on
            // Windows -- set both so the child finds config.json under fakeHome
            // regardless of platform. (USERPROFILE alone leaves POSIX homedir()
            // pointing at the real home, so the config would not be found.)
            HOME: fakeHome,
            USERPROFILE: fakeHome,
            ZSTACK_DISCORD_WEBHOOK: `http://127.0.0.1:${server.port}/hook`,
          },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      const [stdout, , exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(exitCode).toBe(0);
      const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
      expect(lines.length).toBe(1);
      expect(JSON.parse(lines[0])).toEqual({ kind: "claim", ticket: 1, stage: "builder" });

      expect(hits).toBe(1); // the webhook actually received one real POST

      const hn = JSON.parse(readFileSync(join(tickTmp, "human-needed.json"), "utf8"));
      expect(hn.tripped).toBe(true);

      // The fire-once flag IS set this time: notify.ts reported "sent".
      const written = JSON.parse(readFileSync(tickState, "utf8"));
      expect(written.humanNeededNotified).toBe(true);
    } finally {
      server.stop(true);
    }
  }, TICK_TIMEOUT_MS);

  // -- #138: the targeted confirm pass ---------------------------------------
  // Both cases run the REAL wrapper against a REAL prior state file with two
  // in-flight lanes, and a snapshot double whose read is missing #1 -- the
  // truncated-page shape. What separates them is only what the single-ticket
  // lookup answers.
  const MISSING_ONE_ITEMS = JSON.stringify([{ number: 2, title: "T2", url: "http://x/2", fields: { Status: "Building" } }]);
  const MISSING_ONE_BODIES = JSON.stringify({ "2": "no deps" });

  test("#138 AC4: a read that missed #1 + a lookup that finds it -> #1 ingests at its LOOKED-UP status, no lane dropped", () => {
    const dir = mkTmp();
    const stub = writeStubZBoard(dir, MISSING_ONE_ITEMS, MISSING_ONE_BODIES, {
      1: { number: 1, present: true, item: { number: 1, title: "T1", url: "http://x/1", fields: { Status: "QA" } }, body: "no deps" },
    });
    const home = makeConfigHome();
    const tickTmp = join(dir, "tick-tmp");
    const tickState = join(dir, "tick-state.json");
    writeLaneState(tickState);

    const proc = Bun.spawnSync(
      ["bash", Z_LOOP_TICK, "--slug", "demo", "--state", tickState, "--tmp", tickTmp, "--session", "test-session"],
      { env: { ...process.env, Z_BOARD: stub, HOME: home, USERPROFILE: home }, stdout: "pipe", stderr: "pipe" }
    );
    expect(proc.exitCode).toBe(0);

    const state = JSON.parse(readFileSync(tickState, "utf8"));
    // The positive observation beat carry-forward: #1 is at QA, not the Building
    // the prior state held.
    expect(state.tickets.find((t: any) => t.number === 1).status).toBe("QA");
    expect(state.tickets.map((t: any) => t.number)).toEqual([1, 2]);
    expect(state.lanes.map((l: any) => l.ticket)).toEqual([1, 2]); // nothing released

    const log = proc.stderr.toString();
    expect(log).toContain("read missed #1");
    expect(log).toContain("still on the board");
    expect(log).not.toContain("releasing its lane");
  }, TICK_TIMEOUT_MS);

  test("#138 AC5: the same read + a lookup that positively reports not-on-project -> #1 stopped, #2 untouched", () => {
    const dir = mkTmp();
    const stub = writeStubZBoard(dir, MISSING_ONE_ITEMS, MISSING_ONE_BODIES, {
      1: { number: 1, present: false, reason: "not-on-project" },
    });
    const home = makeConfigHome();
    const tickTmp = join(dir, "tick-tmp");
    const tickState = join(dir, "tick-state.json");
    writeLaneState(tickState);

    const proc = Bun.spawnSync(
      ["bash", Z_LOOP_TICK, "--slug", "demo", "--state", tickState, "--tmp", tickTmp, "--session", "test-session"],
      { env: { ...process.env, Z_BOARD: stub, HOME: home, USERPROFILE: home }, stdout: "pipe", stderr: "pipe" }
    );
    expect(proc.exitCode).toBe(0);

    const state = JSON.parse(readFileSync(tickState, "utf8"));
    // #273: the tick MARKS the confirmed-gone lane, it no longer deletes it. The
    // ticket survives as a tombstone and the lane as a stop-lane target -- both
    // leave state together when the orchestrator applies that action, after it
    // has torn the worker down and removed the lane lock.
    expect(state.tickets.map((t: any) => t.number)).toEqual([1, 2]);
    expect(state.lanes.map((l: any) => l.ticket)).toEqual([1, 2]);
    expect(state.lanes.find((l: any) => l.ticket === 1).goneReason).toEqual({ kind: "confirmed-gone" });
    expect(state.lanes.find((l: any) => l.ticket === 2).goneReason).toBeUndefined();
    expect(state.tickets.find((t: any) => t.number === 2).status).toBe("Building"); // #2 untouched

    // And the one Action line the tick prints IS that stop.
    const lines = proc.stdout.toString().split(/\r?\n/).filter((l) => l.trim() !== "");
    expect(lines.length).toBe(1);
    const action = JSON.parse(lines[0]);
    expect(action.kind).toBe("stop-lane");
    expect(action.ticket).toBe(1);
    expect(action.note).toMatch(/no longer on the project board/i);
    expect(action.dropTicket).toBe(true);
    expect(action.salvage).toBe(true);

    const log = proc.stderr.toString();
    expect(log).toContain("read missed #1");
    expect(log).toContain("gone from the board (not-on-project)");
    // The note must NOT claim the tick released the lane -- it did not (#273).
    expect(log).not.toContain("releasing its lane");
    expect(log).toContain("stopped by the next action");
  }, TICK_TIMEOUT_MS);

  // #273: the unknown-status arm, end to end through the real wrapper. A human
  // drags laned #1 into a column the loop does not drive; the tick must still
  // print EXACTLY one Action line -- the stop-lane that tears the lane down --
  // with partitionKnownStatus's note on stderr and nothing extra on stdout.
  test("#273: a laned ticket in an unknown status -> exactly one stop-lane Action line, note on stderr", () => {
    const dir = mkTmp();
    const stub = writeStubZBoard(
      dir,
      JSON.stringify([
        { number: 1, title: "T1", url: "http://x/1", fields: { Status: "Cancelled" } },
        { number: 2, title: "T2", url: "http://x/2", fields: { Status: "Building" } },
      ]),
      JSON.stringify({ "1": "no deps", "2": "no deps" })
    );
    const home = makeConfigHome();
    const tickTmp = join(dir, "tick-tmp");
    const tickState = join(dir, "tick-state.json");
    writeLaneState(tickState);

    const proc = Bun.spawnSync(
      ["bash", Z_LOOP_TICK, "--slug", "demo", "--state", tickState, "--tmp", tickTmp, "--session", "test-session"],
      { env: { ...process.env, Z_BOARD: stub, HOME: home, USERPROFILE: home }, stdout: "pipe", stderr: "pipe" }
    );
    expect(proc.exitCode).toBe(0);

    const lines = proc.stdout.toString().split(/\r?\n/).filter((l) => l.trim() !== "");
    expect(lines.length).toBe(1); // stdout stays reserved for the one Action line
    const action = JSON.parse(lines[0]);
    expect(action.kind).toBe("stop-lane");
    expect(action.ticket).toBe(1);
    expect(action.note).toContain('"Cancelled"');
    expect(action.dropTicket).toBe(true);
    expect(action.salvage).toBe(true);

    const state = JSON.parse(readFileSync(tickState, "utf8"));
    expect(state.lanes.find((l: any) => l.ticket === 1).goneReason).toEqual({
      kind: "unsupported-status",
      status: "Cancelled",
    });
    expect(state.lanes.map((l: any) => l.ticket)).toEqual([1, 2]); // #2 keeps running

    // partitionKnownStatus's note rides stderr, as it always has.
    const log = proc.stderr.toString();
    expect(log).toContain("does not drive");
    expect(log).toContain('"Cancelled"');
  }, TICK_TIMEOUT_MS);

  test("#138: an unparseable lookup answer degrades to no confirmations, never a dead tick", () => {
    const dir = mkTmp();
    const stub = writeStubZBoard(dir, MISSING_ONE_ITEMS, MISSING_ONE_BODIES, {});
    // Overwrite the `item` branch with one that exits 0 printing garbage -- the
    // mid-write shape, which `jq -s` cannot slurp.
    writeFileSync(
      stub,
      readFileSync(stub, "utf8").replace('*) echo "stub z-board: no item fixture for #$N" >&2; exit 1 ;;', `*) printf '{"number": ' ;;`)
    );
    const home = makeConfigHome();
    const tickTmp = join(dir, "tick-tmp");
    const tickState = join(dir, "tick-state.json");
    writeLaneState(tickState);

    const proc = Bun.spawnSync(
      ["bash", Z_LOOP_TICK, "--slug", "demo", "--state", tickState, "--tmp", tickTmp, "--session", "test-session"],
      { env: { ...process.env, Z_BOARD: stub, HOME: home, USERPROFILE: home }, stdout: "pipe", stderr: "pipe" }
    );
    expect(proc.exitCode).toBe(0);
    expect(proc.stderr.toString()).toContain("unreadable");
    const state = JSON.parse(readFileSync(tickState, "utf8"));
    expect(state.tickets.map((t: any) => t.number)).toEqual([1, 2]); // both carried
    expect(state.lanes.map((l: any) => l.ticket)).toEqual([1, 2]);
  }, TICK_TIMEOUT_MS);

  test("#138: a FAILING single-ticket lookup carries the ticket forward and never releases a lane", () => {
    const dir = mkTmp();
    // No `item` fixture for #1 at all -> the stub exits non-zero, the real
    // transport-failure shape. Fail-open: same outcome as no confirm pass.
    const stub = writeStubZBoard(dir, MISSING_ONE_ITEMS, MISSING_ONE_BODIES, {});
    const home = makeConfigHome();
    const tickTmp = join(dir, "tick-tmp");
    const tickState = join(dir, "tick-state.json");
    writeLaneState(tickState);

    const proc = Bun.spawnSync(
      ["bash", Z_LOOP_TICK, "--slug", "demo", "--state", tickState, "--tmp", tickTmp, "--session", "test-session"],
      { env: { ...process.env, Z_BOARD: stub, HOME: home, USERPROFILE: home }, stdout: "pipe", stderr: "pipe" }
    );
    expect(proc.exitCode).toBe(0); // the drain is never wedged by a failed lookup
    const state = JSON.parse(readFileSync(tickState, "utf8"));
    expect(state.tickets.find((t: any) => t.number === 1).status).toBe("Building"); // carried forward
    expect(state.lanes.map((l: any) => l.ticket)).toEqual([1, 2]);
    expect(proc.stderr.toString()).toContain("single-ticket lookup for #1 failed");
  }, TICK_TIMEOUT_MS);

  // Ordering canary (issue #58): the throttle step must run BEFORE the
  // snapshot call, matching Plan step 4 ("before it issues the first
  // board.ts call of the cycle") -- mirrors the snapshot-before-ingest-before-
  // next ordering check in tests/loop-skill-fixes.test.ts.
  test("the throttle step is wired in, strictly before the snapshot call", () => {
    const tick = readFileSync(Z_LOOP_TICK, "utf8");
    expect(tick).toContain('lib/throttle.ts" wait --slug "$SLUG"');
    expect(tick.indexOf('lib/throttle.ts" wait')).toBeLessThan(tick.indexOf("snapshot --slug"));
  });

  // #131: the wrapper computes the live context reading and threads it into the
  // per-tick ingest as --context-tokens. Wiring canary: the context-budget call
  // is best-effort (`|| echo 0`, fail-open) and precedes the ingest that
  // consumes $CTX.
  test("the context reading is computed fail-open and threaded into the per-tick ingest", () => {
    const tick = readFileSync(Z_LOOP_TICK, "utf8");
    expect(tick).toContain('lib/context-budget.ts" current');
    expect(tick).toContain("|| echo 0"); // hard-error backstop -> never wedges the drain
    expect(tick).toContain('--context-tokens "$CTX"');
    expect(tick.indexOf("context-budget.ts")).toBeLessThan(tick.indexOf("loop.ts\" ingest"));
  });

  // #157 (#131 review finding 1): #131's cap-evaporation fix rests on THIS
  // wrapper's per-tick ingest carrying --context-tokens and never
  // --ticket-limit. A --ticket-limit here sets ticketLimitProvided, which makes
  // ingestBoardItems start a FRESH batch at the drain boundary and re-selects
  // (i.e. evaporates) the allow-list mid-run -- the exact bug #131's review
  // bounce caught. tests/loop.test.ts pins the reducer's behavior GIVEN a
  // flagless ingest; nothing pinned the wrapper that produces it, so re-adding
  // the flag used to leave every test green. This reads the command itself.
  test("#157: the per-tick ingest passes --context-tokens and NEVER --ticket-limit", () => {
    const tick = readFileSync(Z_LOOP_TICK, "utf8");
    const ingestCommands = tick
      .replace(/\\\r?\n\s*/g, " ") // fold backslash continuations, so a multi-line ingest can't slip past
      .split(/\r?\n/)
      .filter((l) => !l.trimStart().startsWith("#"))
      .filter((l) => /loop\.ts"?\s+ingest\b/.test(l));
    // Exactly one ingest invocation: a second one (or a rename that hides it
    // from this filter) fails here rather than silently escaping the assertion.
    expect(ingestCommands.length).toBe(1);
    expect(ingestCommands[0]).toContain('--context-tokens "$CTX"');
    expect(ingestCommands[0]).not.toContain("--ticket-limit");
  });

  // #138: the confirm pass is between the snapshot and the ingest, and the
  // ingest consumes its lookups file. A confirm pass computed AFTER the ingest
  // (or an ingest that stopped reading it) would leave absence unconfirmed
  // forever -- lanes on removed tickets would never be released.
  test("#138: the confirm pass runs after the snapshot and its lookups reach the ingest", () => {
    const tick = readFileSync(Z_LOOP_TICK, "utf8");
    expect(tick).toContain('loop.ts" confirm-targets "$STATE" "$TMP/items.json"');
    expect(tick).toContain('"$Z_BOARD" item "$MISSED"');
    expect(tick.indexOf("snapshot --slug")).toBeLessThan(tick.indexOf("confirm-targets"));
    expect(tick.indexOf("confirm-targets")).toBeLessThan(tick.indexOf('loop.ts" ingest'));
    const ingest = tick.split(/\r?\n/).find((l) => /loop\.ts"?\s+ingest\b/.test(l))!;
    expect(ingest).toContain('--lookups "$TMP/lookups.json"');
  });
});

// ============================================================================
// issue #58 AC12: the wrapper's throttle step, with an injected fake clock and
// a spy Sleep -- not real timers. This is the deterministic core bin/z-loop-tick
// shells into via `bun lib/throttle.ts wait`; exercising it directly here (per
// Plan step 4: "add the throttle-wiring case" to #57's test file) is both the
// fast path and the one place a real clock/timer never touches the test.
// ============================================================================
describe("throttle wiring: throttleTick (issue #58 AC12)", () => {
  const dirs2: string[] = [];
  afterAll(() => {
    while (dirs2.length) rmSync(dirs2.pop()!, { recursive: true, force: true });
  });
  function makeLoopDir(): string {
    const d = mkdtempSync(join(tmpdir(), "z-throttle-wiring-"));
    dirs2.push(d);
    return join(d, "loop");
  }

  test("first run: spy Sleep is called with 0 (or not called); second run 10s later: called with 110_000", async () => {
    const loopDir = makeLoopDir();
    let fakeNow = 1_000_000;
    const now = () => fakeNow;
    const sleepCalls: number[] = [];
    const spySleep = async (ms: number) => {
      sleepCalls.push(ms);
    };

    // First tick: no prior last-tick file -> throttleDelayMs is 0 -> sleep is
    // either not called, or called with 0 (AC5's "no prior tick" case, applied
    // through the wiring instead of the pure function directly).
    await throttleTick(loopDir, 120, now, spySleep);
    expect(sleepCalls.length === 0 || sleepCalls[0] === 0).toBe(true);

    // Second tick, fake clock advanced by only 10s: 120 - 10 = 110s remaining.
    fakeNow += 10_000;
    sleepCalls.length = 0;
    await throttleTick(loopDir, 120, now, spySleep);
    expect(sleepCalls).toEqual([110_000]);
  });

  test("throttleTick always stamps last-tick after the (possibly zero) delay", async () => {
    const loopDir = makeLoopDir();
    const now = () => 42_000;
    await throttleTick(loopDir, 0, now, async () => {
      throw new Error("sleep must not be called when throttling is off");
    });
    expect(readLastTick(loopDir)).toBe(42_000);
  });

  // Sanity cross-check: throttleTick's delay math is exactly throttleDelayMs
  // applied to readLastTick's return value -- no drift between the pure
  // function and the wiring that calls it.
  test("delay computed by the wiring matches throttleDelayMs directly", () => {
    expect(throttleDelayMs(1_000_000, 1_050_000, 120)).toBe(70_000);
  });
});
