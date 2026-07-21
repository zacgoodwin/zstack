// Gate tests for lib/throttle.ts (issue #58): the pure throttleDelayMs pacing
// decision (AC5-AC8) and the on-disk last-tick state it paces against
// (AC9-AC11). All deterministic, no network, well under the 2s gate budget.
import { test, expect, describe, afterEach, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as os from "node:os";
import { join } from "node:path";
import { defaultLoopDir, main, readLastTick, throttleDelayMs, writeLastTick } from "../lib/throttle.ts";

describe("throttleDelayMs", () => {
  // AC5: no prior tick recorded -> never delay the very first tick.
  test("returns 0 when no prior tick is recorded (lastTickMs === null)", () => {
    expect(throttleDelayMs(null, 1_000_000, 120)).toBe(0);
  });

  // AC6: throttle off (0) -> always 0, regardless of elapsed time.
  test("returns 0 when throttleSeconds is 0 (off), regardless of elapsed time", () => {
    expect(throttleDelayMs(0, 1_000_000, 0)).toBe(0);
  });

  // AC7: exact ms remainder of the interval.
  test("returns the exact ms remainder of the interval", () => {
    const lastTickMs = 1_000_000;
    const nowMs = 1_050_000; // 50s elapsed
    expect(throttleDelayMs(lastTickMs, nowMs, 120)).toBe(70_000);
  });

  // AC8: elapsed already exceeds the interval -> 0, never negative.
  test("returns 0 (never negative) once elapsed exceeds the interval", () => {
    const lastTickMs = 1_000_000;
    const nowMs = 1_130_000; // 130s elapsed
    expect(throttleDelayMs(lastTickMs, nowMs, 120)).toBe(0);
  });

  test("negative throttleSeconds is also treated as off", () => {
    expect(throttleDelayMs(1_000_000, 1_050_000, -1)).toBe(0);
  });
});

describe("readLastTick / writeLastTick", () => {
  const homes: string[] = [];
  afterEach(() => {
    while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
  });
  function makeHome(): string {
    const dir = mkdtempSync(join(tmpdir(), "zstack-throttle-home-"));
    homes.push(dir);
    return dir;
  }

  // AC9: round-trip through the real home-relative path.
  test("writeLastTick then readLastTick round-trips the exact ms value", () => {
    const home = makeHome();
    const loopDir = defaultLoopDir("zstack", home);
    writeLastTick(loopDir, 1_700_000_000_000);
    expect(readLastTick(loopDir)).toBe(1_700_000_000_000);
  });

  // AC10: no file yet -> null, not a throw (first-ever tick for the project).
  test("returns null when no last-tick file exists yet", () => {
    const home = makeHome();
    const loopDir = defaultLoopDir("zstack", home);
    expect(readLastTick(loopDir)).toBeNull();
  });

  // AC11: a present-but-corrupt file fails loudly, naming the path.
  test("throws a ZError naming the path when the file is not a parseable timestamp", () => {
    const home = makeHome();
    const loopDir = defaultLoopDir("zstack", home);
    mkdirSync(loopDir, { recursive: true });
    writeFileSync(join(loopDir, "last-tick"), "not-a-number");
    expect(() => readLastTick(loopDir)).toThrow(/not a parseable timestamp/);
    expect(() => readLastTick(loopDir)).toThrow(new RegExp(loopDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

// ============================================================================
// Review-bounce fix (issue #58): main()'s "wait" handler -- the ONLY
// production path that reads a project's real tickThrottleSeconds off
// loadConfig() and threads it into throttleTick -- previously had zero test
// coverage of its own. Every other test either drives throttleDelayMs/
// throttleTick directly (bypassing main() entirely) or spawns the real CLI
// with tickThrottleSeconds omitted (defaulting to 0, so a mutant that
// hardcodes the handler's config read to 0 stayed invisible). These two tests
// close that gap, both fully deterministic: one pins an injected clock + spy
// Sleep to prove the config VALUE flows; the other spies on the global
// Date.now/setTimeout to prove main()'s literal DEFAULT params (used by the
// real `if (import.meta.main)` entrypoint) wire to those real primitives --
// with the spy resolving synchronously, so neither test performs a real wait.
// ============================================================================
describe('main("wait"): config-to-CLI wiring (review fix, issue #58)', () => {
  const homes: string[] = [];
  afterEach(() => {
    while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
  });

  // A fake $HOME/$USERPROFILE carrying a minimal, valid config.json for slug
  // "demo" with an explicit, nonzero tickThrottleSeconds -- same shape as
  // tests/z-loop-tick.test.ts's makeConfigHome, trimmed to this file's needs.
  function makeConfigHome(tickThrottleSeconds: number): string {
    const home = mkdtempSync(join(tmpdir(), "zstack-throttle-main-home-"));
    homes.push(home);
    const dir = join(home, ".zstack", "projects", "demo");
    mkdirSync(dir, { recursive: true });
    const cfg = {
      slug: "demo",
      owner: "acme",
      repo: "demo",
      projectNumber: 1,
      projectId: "PVT_1",
      repositoryId: "R_1",
      statusField: {
        id: "F_status",
        dataType: "SINGLE_SELECT",
        options: { Backlog: "o1", Ready: "o2", Done: "o3" },
      },
      fields: {},
      tickThrottleSeconds,
    };
    writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));
    return home;
  }

  // loadConfig() resolves the OS home via node:os homedir() (used as the
  // default `home` param of configPath/loadConfig/defaultLoopDir). Under Bun,
  // homedir() reads the OS user database, NOT process.env.HOME/USERPROFILE, so
  // setting those env vars does not redirect it. Spying homedir() for the
  // duration of one main() call (then restoring it) is the in-process
  // equivalent, and -- because throttle.ts and config.ts both import the same
  // live `homedir` binding from node:os -- is what lets this test drive the
  // REAL loadConfig() against a temp home without a subprocess.
  async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
    const spy = spyOn(os, "homedir").mockReturnValue(home);
    try {
      return await fn();
    } finally {
      spy.mockRestore();
    }
  }

  test("the project's real tickThrottleSeconds (not a hardcoded value) reaches throttleTick's delay math", async () => {
    const home = makeConfigHome(120);
    let fakeNow = 1_000_000;
    const now = () => fakeNow;
    const sleepCalls: number[] = [];
    const spySleep = async (ms: number) => {
      sleepCalls.push(ms);
    };

    // First "wait": no prior tick recorded -> delay 0 either way (AC5); this
    // call only exists to stamp a last-tick to pace the second call against.
    await withHome(home, () => main(["wait", "--slug", "demo"], now, spySleep));
    expect(sleepCalls.length === 0 || sleepCalls[0] === 0).toBe(true);

    // Second "wait", fake clock advanced by only 10s: with the fixture's real
    // 120s config value flowing through main() -> throttleTick, the remaining
    // delay is exactly 110_000ms. The mutation the review found (main()'s
    // handler hardcoding its throttleSeconds read to 0) would instead sleep 0
    // here -- this assertion is what makes that mutation fail the suite.
    fakeNow += 10_000;
    sleepCalls.length = 0;
    await withHome(home, () => main(["wait", "--slug", "demo"], now, spySleep));
    expect(sleepCalls).toEqual([110_000]);
  });

  test('main("wait") with no now/sleep args wires to the real Date.now()/setTimeout defaults (spied, no real wait)', async () => {
    const home = makeConfigHome(120);
    // Spy the global primitives main()'s own default params resolve to
    // (throttle.ts:111-112: `now = () => Date.now()`, `sleep = defaultSleep`
    // which calls `setTimeout` -- throttle.ts:73). The setTimeout mock invokes
    // its callback synchronously, so the awaited sleep resolves immediately:
    // this proves the wiring without ever actually waiting out a real timer.
    const timeoutCalls: number[] = [];
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      cb: (...args: unknown[]) => void,
      ms?: number
    ) => {
      timeoutCalls.push(ms ?? 0);
      cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    let fakeNow = 1_000_000;
    const dateNowSpy = spyOn(Date, "now").mockImplementation(() => fakeNow);

    try {
      // First "wait": no prior tick recorded -> delay 0 (AC5); this call only
      // stamps a last-tick (via the spied Date.now()) to pace the second call
      // against. No now/sleep args are passed to main() -- this is the exact
      // call shape the real CLI entrypoint (`if (import.meta.main)`) uses.
      await withHome(home, () => main(["wait", "--slug", "demo"]));
      expect(setTimeoutSpy).not.toHaveBeenCalled();

      // Second "wait", clock advanced 10s: with the fixture's real 120s
      // config value flowing through main()'s DEFAULT now/sleep params into
      // throttleTick, the default sleep must invoke the real setTimeout with
      // the exact 110_000ms remainder. The mutation the review found
      // (main()'s handler hardcoding its throttleSeconds read to 0) would
      // instead compute delay 0 and never call setTimeout at all here --
      // this assertion is what makes that mutation fail the suite.
      fakeNow += 10_000;
      await withHome(home, () => main(["wait", "--slug", "demo"]));
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(timeoutCalls).toEqual([110_000]);
    } finally {
      setTimeoutSpy.mockRestore();
      dateNowSpy.mockRestore();
    }
  });
});
