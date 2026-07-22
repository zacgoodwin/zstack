// Gate tests for z-stop (#132): lib/stop.ts + bin/z-stop. z-stop drops a stop
// sentinel that a running /z-loop observes on its next tick; here we pin the
// three loop-lock classifications it branches on (free / live / stale) and the
// sentinel write/no-write, all with injected --locks-dir / --sentinel so no test
// ever touches a real ~/.zstack. Mirrors the path-injection discipline of
// tests/safety.test.ts (lib/locks.ts).
import { test, expect, describe, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { loopLockPath, processStartTime } from "../lib/locks.ts";
import { stopSentinelPath } from "../lib/stop.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const STOP = join(REPO_ROOT, "lib", "stop.ts");
const Z_STOP = join(REPO_ROOT, "bin", "z-stop");

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "z-stop-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// Runs `bun lib/stop.ts request` with injected paths, returning {code, out}.
function runStop(locksDir: string, sentinel: string, extra: string[] = []): { code: number; out: string } {
  const proc = Bun.spawnSync(
    ["bun", STOP, "request", "--locks-dir", locksDir, "--sentinel", sentinel, ...extra],
    { stdout: "pipe", stderr: "pipe" }
  );
  return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
}

describe("stopSentinelPath", () => {
  test("is <home>/.zstack/projects/<slug>/loop/stop-requested", () => {
    const home = join("X:", "fake-home");
    expect(stopSentinelPath("demo", home)).toBe(
      join(home, ".zstack", "projects", "demo", "loop", "stop-requested")
    );
  });
});

describe("z-stop request", () => {
  // AC2: no loop.lock -> clear message, exit 0, NO sentinel written.
  test("no running loop: prints 'No /z-loop is running', writes no sentinel", () => {
    const locksDir = tmp(); // empty: no loop.lock
    const sentinel = join(tmp(), "loop", "stop-requested");
    const { code, out } = runStop(locksDir, sentinel);
    expect(code).toBe(0);
    expect(out).toContain("No /z-loop is running");
    expect(existsSync(sentinel)).toBe(false);
  });

  // AC3: a live loop.lock (pid = an alive process with matching start-time) ->
  // sentinel written, message names the session. We use THIS test process's pid
  // and its real OS start-time, so inspectLoopLock classifies it live via the
  // pid-identity path (same technique as tests/safety.test.ts) -- and this
  // process is definitely alive while the spawned child reads the lock.
  test("live loop: writes the sentinel and names the session", () => {
    const locksDir = tmp();
    const sentinel = join(tmp(), "loop", "stop-requested");
    const startTime = processStartTime(process.pid);
    expect(startTime).not.toBeNull(); // the helper works on this platform
    writeFileSync(
      loopLockPath(locksDir),
      JSON.stringify({ session: "sess-live", startedAt: 1000, pid: process.pid, host: hostname(), startTime }) + "\n"
    );
    const { code, out } = runStop(locksDir, sentinel);
    expect(code).toBe(0);
    expect(out).toContain("sess-live");
    expect(out).toContain("Stop requested");
    expect(existsSync(sentinel)).toBe(true);
  });

  // AC4: a stale loop.lock (dead pid, startedAt far in the past) -> points at
  // --reconcile, writes NO sentinel (a crashed loop cannot observe a signal).
  test("stale loop: points at --reconcile, writes no sentinel", () => {
    const locksDir = tmp();
    const sentinel = join(tmp(), "loop", "stop-requested");
    // A dead pid (nothing observes) with an ancient startedAt: inspectLoopLock
    // reads it stale via the dead-pid branch (and the age heuristic backs it up).
    writeFileSync(
      loopLockPath(locksDir),
      JSON.stringify({ session: "sess-crashed", startedAt: 0, pid: 2147483646, host: hostname() }) + "\n"
    );
    const { code, out } = runStop(locksDir, sentinel, ["--now", String(999 * 60_000)]);
    expect(code).toBe(0);
    expect(out).toContain("stale");
    expect(out).toContain("--reconcile");
    expect(existsSync(sentinel)).toBe(false);
  });

  // Only one of the injected paths given is a usage error (not a silent
  // real-~/.zstack fallback via loadConfig).
  test("--locks-dir without --sentinel is a loud error", () => {
    const proc = Bun.spawnSync(
      ["bun", STOP, "request", "--locks-dir", tmp()],
      { stdout: "pipe", stderr: "pipe" }
    );
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("BOTH --locks-dir and --sentinel");
  });

  // bin/z-stop is a thin wrapper: it execs lib/stop.ts, so the free-loop path
  // works end to end through the bash entrypoint too.
  test("bin/z-stop wrapper runs lib/stop.ts", () => {
    const locksDir = tmp();
    const sentinel = join(tmp(), "loop", "stop-requested");
    const proc = Bun.spawnSync(
      ["bash", Z_STOP, "request", "--locks-dir", locksDir, "--sentinel", sentinel],
      { stdout: "pipe", stderr: "pipe" }
    );
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("No /z-loop is running");
    expect(existsSync(sentinel)).toBe(false);
  });
});
