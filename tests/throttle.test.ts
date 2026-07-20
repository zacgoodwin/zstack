// Gate tests for lib/throttle.ts (issue #58): the pure throttleDelayMs pacing
// decision (AC5-AC8) and the on-disk last-tick state it paces against
// (AC9-AC11). All deterministic, no network, well under the 2s gate budget.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultLoopDir, readLastTick, throttleDelayMs, writeLastTick } from "../lib/throttle.ts";

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
