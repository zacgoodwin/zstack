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
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const TESTS_DIR = join(import.meta.dir);

// Recursive walk, not Bun.Glob: lib/spec-sources.ts already hit the reason
// (Windows quirk, issue #22) -- Bun.Glob does not match absolute
// drive-letter patterns like TESTS_DIR on Windows, so a "**/*.test.ts"
// pattern against this absolute dir would silently match nothing there.
// readdirSync + withFileTypes recursion sidesteps that platform gap and is
// the same idiom lib/reconcile.ts already uses for directory walks.
function testFiles(dir: string = TESTS_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...testFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
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

// Shared by the real gate check below AND the issue #122 regression test, so
// the regression test exercises the exact same scan the gate runs -- not a
// parallel reimplementation that could drift and pass while the real gate
// stays broken.
function scanViolations(): string[] {
  const violations: string[] = [];
  for (const file of testFiles()) {
    const source = readFileSync(file, "utf8");
    for (const line of unsafeHomedirZstackLines(source)) {
      violations.push(`${relative(TESTS_DIR, file)}: ${line.trim()}`);
    }
  }
  return violations;
}

describe("Issue #118 AC2: no test resolves the real ~/.zstack for a write/delete", () => {
  test("grep -rn \"homedir()\" tests/: every hit that also names .zstack is a read-only existsSync check", () => {
    expect(scanViolations()).toEqual([]);
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

describe("Issue #122: the scan is recursive, not just top-level tests/", () => {
  // Plants a real offender nested under tests/helpers/ (issue #122's named
  // example), created and removed within this test, and asserts the
  // production scan (testFiles + unsafeHomedirZstackLines, via
  // scanViolations) finds it. Before this fix, testFiles() called flat
  // readdirSync(TESTS_DIR), which never descends into helpers/ -- this
  // offender would silently pass.
  test("a .test.ts under tests/helpers/ that writes to the real home's .zstack dir is caught, named with its nested path", () => {
    const relPath = join("helpers", "__nested-offender-fixture.test.ts");
    const offenderPath = join(TESTS_DIR, relPath);
    // Assembled by concatenation, not written verbatim: the gate is a naive
    // text scan, so if THIS file's own source literally had "homedir()" and
    // ".zstack" on one line, the gate would flag itself the moment it scans
    // tests/zstack-home-safety.test.ts.
    const dangerousLine =
      "mkdirSync(join(homedir" + '(), ".zstack", "projects", "evil"), { recursive: true });';
    const offenderSource = [
      'import { homedir } from "node:os";',
      'import { mkdirSync } from "node:fs";',
      'import { join } from "node:path";',
      dangerousLine,
      "",
    ].join("\n");
    writeFileSync(offenderPath, offenderSource);
    try {
      // The recursive walk must reach the nested file at all.
      expect(testFiles()).toContain(offenderPath);
      // And the scan must flag it, named with its path relative to tests/.
      const violations = scanViolations();
      expect(violations.some((v) => v.startsWith(`${relPath}:`))).toBe(true);
    } finally {
      rmSync(offenderPath, { force: true }); // never leave the offender behind
    }
  });
});
