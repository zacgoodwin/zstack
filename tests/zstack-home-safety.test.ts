// Gate test for issue #118 (AC2): no test in tests/ may resolve the REAL OS
// home (node:os homedir()) into a `.zstack` path and then write to or delete
// it. That exact pattern -- `join(homedir(), ".zstack", "projects", slug)` fed
// into mkdirSync/writeFileSync/rmSync -- is what tests/notify.test.ts:413 did
// before this fix: it created (and, on a happy path, deleted) a real
// ~/.zstack/projects/<slug> directory. Combined with the reviewer's full `bun
// test` run inside a throwaway worktree (issue #118 AC1, fixed in
// z-loop/SKILL.md), a test like that could resolve onto the loop's own live
// state.json/locks/transcripts and destroy them mid-review.
//
// Every OTHER test file already routes `.zstack` paths through a sandboxed
// `home` (testHome()/mkdtempSync + an explicit `home` param, or a subprocess
// with HOME/USERPROFILE overridden) -- see tests/setup.test.ts's testHome(),
// tests/z-loop-tick.test.ts's makeConfigHome(). The one legitimate reason a
// test may still call the real homedir() at all is to assert a `.zstack` path
// under it was NEVER created (a read-only existsSync check, exactly what the
// fixed notify.test.ts now does) -- so the gate below allows that shape and
// fails on every other one.
import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const TESTS_DIR = join(import.meta.dir);

function testFiles(): string[] {
  return readdirSync(TESTS_DIR).filter((f) => f.endsWith(".test.ts"));
}

// A line of CODE (comments are prose, not risk) that calls the real
// (unmocked) homedir() and also names ".zstack" is the dangerous shape --
// UNLESS a read-only existsSync check sits on that line or shortly after it
// (the realistic "build the real path, then assert it was never created"
// shape the fixed notify.test.ts now uses). This is the literal
// `grep -rn "homedir()" tests/` the ticket names, narrowed to the one
// combination that can touch real state.
const EXISTS_CHECK_WINDOW = 6;
function unsafeHomedirZstackLines(source: string): string[] {
  const lines = source.split(/\r?\n/);
  const violations: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\/\//.test(line)) continue; // comment-only line: prose, not executable
    if (!/homedir\(\)/.test(line) || !/\.zstack/.test(line)) continue;
    const window = lines.slice(i, i + EXISTS_CHECK_WINDOW).join("\n");
    if (/existsSync/.test(window)) continue; // read-only "prove it's untouched" shape
    violations.push(line);
  }
  return violations;
}

describe("Issue #118 AC2: no test resolves the real ~/.zstack for a write/delete", () => {
  test("grep -rn \"homedir()\" tests/: every hit that also names .zstack is a read-only existsSync check", () => {
    const violations: string[] = [];
    for (const file of testFiles()) {
      const source = readFileSync(join(TESTS_DIR, file), "utf8");
      for (const line of unsafeHomedirZstackLines(source)) {
        violations.push(`${file}: ${line.trim()}`);
      }
    }
    expect(violations).toEqual([]);
  });

  // Pins the one file this fix actually touched: notify.test.ts's CLI "send"
  // test now sandboxes HOME/USERPROFILE and only reads the real home to prove
  // it was untouched (AC2/AC3), never mkdirSync/writeFileSync/rmSync's it.
  test("notify.test.ts's CLI send test sandboxes HOME/USERPROFILE instead of writing to the real home", () => {
    const source = readFileSync(join(TESTS_DIR, "notify.test.ts"), "utf8");
    expect(source).toContain("env.HOME = fakeHome");
    expect(source).toContain("env.USERPROFILE = fakeHome");
    expect(source).not.toContain('mkdirSync(join(homedir()');
    expect(source).not.toContain('rmSync(join(homedir()');
  });
});
