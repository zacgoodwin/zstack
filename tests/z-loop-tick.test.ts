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
import { test, expect, describe, afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    const tickTmp = join(dir, "tick-tmp");
    const tickState = join(dir, "tick-state.json");

    const proc = Bun.spawnSync(
      ["bash", Z_LOOP_TICK, "--slug", "demo", "--state", tickState, "--tmp", tickTmp],
      { env: { ...process.env, Z_BOARD: stub }, stdout: "pipe", stderr: "pipe" }
    );
    expect(proc.exitCode).toBe(0);

    // stdout is EXACTLY one non-empty line: the Action JSON (snapshot + ingest
    // are silenced inside the wrapper).
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
  test("human-needed: writes tripped:true when parked tickets cross the threshold, and a failed/unconfigured notify send never aborts the tick or sets the fire-once flag", () => {
    const dir = mkTmp();
    const stub = writeStubZBoard(dir, TRIPPED_ITEMS, TRIPPED_BODIES);
    const tickTmp = join(dir, "tick-tmp");
    const tickState = join(dir, "tick-state.json");

    const proc = Bun.spawnSync(
      ["bash", Z_LOOP_TICK, "--slug", "demo", "--state", tickState, "--tmp", tickTmp],
      { env: { ...process.env, Z_BOARD: stub }, stdout: "pipe", stderr: "pipe" }
    );
    // The tick must exit 0 and still print exactly one Action line even though
    // slug "demo" has no ~/.zstack config on the test machine -- notify.ts
    // send fails loudly (ZError), and that failure must never propagate.
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
});
