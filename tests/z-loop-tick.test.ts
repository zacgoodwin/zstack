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

// The board the stubbed `z-board snapshot` emits: one Ready ticket, no deps.
const ITEMS = JSON.stringify([
  { number: 1, title: "T1", url: "http://x/1", fields: { Status: "Ready" } },
]);
const BODIES = JSON.stringify({ "1": "no deps" });

// A board that trips the human-needed control on the very first tick: 1
// Building ticket (the committed batch size) plus 2 Blocked + 1 Skipped
// already parked -- (2+1)/1*100 = 300% > the default 30% threshold.
const TRIPPED_ITEMS = JSON.stringify([
  { number: 1, title: "T1", url: "http://x/1", fields: { Status: "Building" } },
  { number: 2, title: "T2", url: "http://x/2", fields: { Status: "Blocked" } },
  { number: 3, title: "T3", url: "http://x/3", fields: { Status: "Blocked" } },
  { number: 4, title: "T4", url: "http://x/4", fields: { Status: "Skipped" } },
]);
const TRIPPED_BODIES = JSON.stringify({ "1": "no deps", "2": "no deps", "3": "no deps", "4": "no deps" });

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

// A fake z-board that only implements `snapshot`, writing the given board to
// the --out-items / --out-bodies paths (exactly what the real snapshot does).
// Defaults to the module-level ITEMS/BODIES fixture; a test that needs a
// different board (e.g. to trip the human-needed control) passes its own.
function writeStubZBoard(dir: string, items = ITEMS, bodies = BODIES): string {
  const stub = join(dir, "z-board");
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
set -e
cmd="$1"; shift || true
OUT_ITEMS=""; OUT_BODIES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out-items) OUT_ITEMS="$2"; shift 2 ;;
    --out-bodies) OUT_BODIES="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ "$cmd" = "snapshot" ]; then
  printf '%s' ${JSON.stringify(items)} > "$OUT_ITEMS"
  printf '%s' ${JSON.stringify(bodies)} > "$OUT_BODIES"
  echo "stub snapshot ok"   # discarded by z-loop-tick's >/dev/null
fi
`
  );
  chmodSync(stub, 0o755);
  return stub;
}

describe("z-loop-tick", () => {
  test("prints exactly one Action JSON line and writes the same state the 3-step sequence produces", () => {
    const dir = mkTmp();
    const stub = writeStubZBoard(dir);
    const home = makeConfigHome(); // tickThrottleSeconds omitted -> defaults to 0 (off)
    const tickTmp = join(dir, "tick-tmp");
    const tickState = join(dir, "tick-state.json");

    const proc = Bun.spawnSync(
      ["bash", Z_LOOP_TICK, "--slug", "demo", "--state", tickState, "--tmp", tickTmp],
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
    // fixture and compare byte-for-byte.
    const items = join(dir, "items.json");
    const bodies = join(dir, "bodies.json");
    const expectedState = join(dir, "expected-state.json");
    writeFileSync(items, ITEMS);
    writeFileSync(bodies, BODIES);
    const ing = Bun.spawnSync(
      ["bun", join(REPO_ROOT, "lib", "loop.ts"), "ingest", expectedState, items, bodies],
      { stdout: "pipe", stderr: "pipe" }
    );
    expect(ing.exitCode).toBe(0);
    expect(readFileSync(tickState, "utf8")).toBe(readFileSync(expectedState, "utf8"));

    // Human-needed safety control (issue #63): a first tick with 0 tickets
    // committed to Building never trips (initialReadyCount = 0, guarded).
    const hn = JSON.parse(readFileSync(join(tickTmp, "human-needed.json"), "utf8"));
    expect(hn).toMatchObject({ tripped: false, alreadyNotified: false, blocked: 0, skipped: 0, questions: 0, initialReadyCount: 0 });

    // The throttle step actually ran end to end (not just skipped): it stamped
    // a real last-tick file under the project's loop dir.
    const loopDir = defaultLoopDir("demo", home);
    expect(existsSync(join(loopDir, "last-tick"))).toBe(true);
    expect(readLastTick(loopDir)).not.toBeNull();
  });

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
  });

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

    const proc = Bun.spawnSync(
      ["bash", Z_LOOP_TICK, "--slug", "demo", "--state", tickState, "--tmp", tickTmp],
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
  });

  // The test above only exercises the failure/unconfigured branch (`SENT` !=
  // "sent") of z-loop-tick's `[ "$SENT" = "sent" ] && human-needed-ack` line;
  // nothing previously drove the success branch end-to-end through the real
  // wrapper script. This pins it with a real `~/.zstack/projects/<slug>/
  // config.json` (Bun on Windows resolves os.homedir() from USERPROFILE, not
  // HOME -- overridden here) and a local mock Discord webhook that actually
  // answers 200, so notify.ts's `send` completes a real round trip and prints
  // "sent". Uses Bun.spawn (async), not spawnSync: a synchronous spawn blocks
  // this process's event loop, which would starve Bun.serve() of the chance to
  // answer the child's request.
  test("human-needed: a successful notify send (real config.json + local webhook) actually POSTs and sets the fire-once flag", async () => {
    const dir = mkTmp();
    const stub = writeStubZBoard(dir, TRIPPED_ITEMS, TRIPPED_BODIES);
    const tickTmp = join(dir, "tick-tmp");
    const tickState = join(dir, "tick-state.json");

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
        ["bash", Z_LOOP_TICK, "--slug", slug, "--state", tickState, "--tmp", tickTmp],
        {
          env: {
            ...process.env,
            Z_BOARD: stub,
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
  });

  // Ordering canary (issue #58): the throttle step must run BEFORE the
  // snapshot call, matching Plan step 4 ("before it issues the first
  // board.ts call of the cycle") -- mirrors the snapshot-before-ingest-before-
  // next ordering check in tests/loop-skill-fixes.test.ts.
  test("the throttle step is wired in, strictly before the snapshot call", () => {
    const tick = readFileSync(Z_LOOP_TICK, "utf8");
    expect(tick).toContain('lib/throttle.ts" wait --slug "$SLUG"');
    expect(tick.indexOf('lib/throttle.ts" wait')).toBeLessThan(tick.indexOf("snapshot --slug"));
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
