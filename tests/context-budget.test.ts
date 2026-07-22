// Gate tests for lib/context-budget.ts (issue #131, AC9): the deterministic
// live-context measurement the loop's context ceiling gates on. Covers
// currentContextTokens over a committed transcript fixture (input + cache-read
// + cache-creation of the LAST assistant usage line, output excluded), the
// empty/missing-file 0 fallback (fail-open), newest-mtime session resolution,
// and the CLI's 0-on-unresolvable behavior. No LLM calls -- pure transcript
// arithmetic + filesystem resolution.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  contextBudget,
  currentContextTokens,
  main,
  resolveSessionTranscript,
} from "../lib/context-budget.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "context-transcript.jsonl");

const tmpPaths: string[] = [];
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ctx-budget-"));
  tmpPaths.push(d);
  return d;
}
afterEach(() => {
  while (tmpPaths.length) rmSync(tmpPaths.pop()!, { recursive: true, force: true });
});

// The exact cwd->transcript-dir mangling Claude Code uses (verified against
// real ~/.claude/projects dirs): every non-alphanumeric char -> "-".
function mangle(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

describe("currentContextTokens (AC9)", () => {
  test("sums input + cache_read + cache_creation of the LAST assistant usage line, excluding output", () => {
    // Fixture's last assistant usage is
    // {input:400000, cache_read:120000, cache_creation:30000, output:900};
    // an EARLIER assistant line (100/200/0/50) proves "last" wins, not first/sum.
    expect(currentContextTokens(FIXTURE)).toBe(550000); // 400000 + 120000 + 30000, output 900 excluded
  });

  test("a transcript with no assistant/usage line returns 0", () => {
    const dir = mkTmp();
    const p = join(dir, "user-only.jsonl");
    writeFileSync(
      p,
      JSON.stringify({ type: "user", message: { role: "user", content: [] }, uuid: "x" }) + "\n"
    );
    expect(currentContextTokens(p)).toBe(0);
  });

  test("an empty transcript returns 0", () => {
    const dir = mkTmp();
    const p = join(dir, "empty.jsonl");
    writeFileSync(p, "");
    expect(currentContextTokens(p)).toBe(0);
  });

  test("a missing file returns 0 (fail-open, never throws)", () => {
    expect(currentContextTokens(join(mkTmp(), "does-not-exist.jsonl"))).toBe(0);
  });

  // -- #157: partial-line tolerance (fail-open in the FUNCTION, not just the
  // wrapper). The transcript read here is the orchestrator's own live session
  // file, so a tick can catch it mid-write.
  const assistantLine = (input: number) =>
    JSON.stringify({
      type: "assistant",
      requestId: `req_${input}`,
      message: { model: "claude-opus-4", id: `msg_${input}`, usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    });

  function captureStderr(fn: () => void): string {
    const orig = console.error;
    let out = "";
    console.error = (...args: unknown[]) => {
      out += args.join(" ") + "\n";
    };
    try {
      fn();
    } finally {
      console.error = orig;
    }
    return out;
  }

  test("#157 AC3: a truncated FINAL line does not throw -- the last well-formed usage line is returned", () => {
    const p = join(mkTmp(), "mid-write.jsonl");
    writeFileSync(p, `${assistantLine(1000)}\n${assistantLine(7000)}\n{"type":"assistant","message":{"usa`);
    let got = -1;
    // A real reading survived, so nothing is reported: the value is a complete
    // measurement of an earlier turn, the same one-flush lag the module already
    // documents -- not an unknown.
    const err = captureStderr(() => {
      got = currentContextTokens(p);
    });
    expect(got).toBe(7000);
    expect(err).toBe("");
  });

  test("#157 AC3: a transcript with ONLY a truncated line returns 0 AND reports that the size is unknown", () => {
    const p = join(mkTmp(), "all-partial.jsonl");
    writeFileSync(p, `{"type":"assistant","message":{"usage":{"input_tok`);
    let got = -1;
    const err = captureStderr(() => {
      got = currentContextTokens(p);
    });
    expect(got).toBe(0); // fail-open: never throws, never wedges the drain
    // ...but that 0 is NOT silently indistinguishable from a healthy small
    // window: the operator is told the reading is unknown and cannot gate.
    expect(err).toContain("not valid JSON");
    expect(err).toContain("UNKNOWN");
    expect(err).toContain(p);
  });

  test("#157: the skip is scoped to unparseable text -- a renamed usage key (valid JSON) still fails LOUD", () => {
    const p = join(mkTmp(), "drift.jsonl");
    writeFileSync(
      p,
      JSON.stringify({
        type: "assistant",
        requestId: "req_1",
        message: { model: "claude-opus-4", id: "msg_1", usage: { input_TOKENS: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      }) + "\n"
    );
    expect(() => currentContextTokens(p)).toThrow(/input_tokens/);
  });
});

describe("resolveSessionTranscript", () => {
  // Lay out ~/.claude/projects/<mangled-cwd>/ under a fake home with two
  // transcripts, then pin their mtimes so "newest" is deterministic (no sleep).
  function layout(home: string, cwd: string, files: { name: string; mtimeSec: number }[]): string {
    const dir = join(home, ".claude", "projects", mangle(cwd));
    mkdirSync(dir, { recursive: true });
    for (const f of files) {
      const p = join(dir, f.name);
      writeFileSync(p, "");
      utimesSync(p, f.mtimeSec, f.mtimeSec);
    }
    return dir;
  }

  test("returns the newest-mtime *.jsonl under the mangled-cwd project dir", () => {
    const home = mkTmp();
    const cwd = "D:\\Users\\zacgo\\Documents\\GitHub\\zstack-1";
    const dir = layout(home, cwd, [
      { name: "older.jsonl", mtimeSec: 1_000_000 },
      { name: "newest.jsonl", mtimeSec: 2_000_000 },
      { name: "notes.txt", mtimeSec: 3_000_000 }, // not .jsonl -> ignored even though newest
    ]);
    expect(resolveSessionTranscript(cwd, home)).toBe(join(dir, "newest.jsonl"));
  });

  test("a missing project dir resolves to undefined (fail-open)", () => {
    const home = mkTmp(); // no .claude/projects at all
    expect(resolveSessionTranscript("D:\\some\\where", home)).toBeUndefined();
  });
});

describe("contextBudget (resolve + read end to end)", () => {
  test("reads the resolved transcript's occupancy", () => {
    const home = mkTmp();
    const cwd = "D:\\proj\\repo";
    const dir = join(home, ".claude", "projects", mangle(cwd));
    mkdirSync(dir, { recursive: true });
    // Copy the fixture content in as the sole transcript.
    writeFileSync(join(dir, "session.jsonl"), readFileSync(FIXTURE, "utf8"));
    expect(contextBudget(cwd, home)).toBe(550000);
  });

  test("an unresolvable session degrades to 0 (fail-open)", () => {
    expect(contextBudget("D:\\no\\such\\repo", mkTmp())).toBe(0);
  });
});

describe("CLI main", () => {
  function captureStdout(fn: () => void): string {
    const orig = console.log;
    let out = "";
    console.log = (...args: unknown[]) => {
      out += args.join(" ") + "\n";
    };
    try {
      fn();
    } finally {
      console.log = orig;
    }
    return out.trim();
  }

  test("`current --project-dir <unresolvable>` prints 0 and exits 0 (fail-open)", () => {
    let code = -1;
    const out = captureStdout(() => {
      code = main(["current", "--project-dir", join(mkTmp(), "nope")]);
    });
    expect(code).toBe(0);
    expect(out).toBe("0");
  });

  test("`current` defaults --project-dir to cwd; never throws for the real home", () => {
    // Whatever this machine's real ~/.claude/projects holds, the CLI must
    // return a non-negative integer, never crash the caller (fail-open).
    let code = -1;
    const out = captureStdout(() => {
      code = main(["current"]);
    });
    expect(code).toBe(0);
    expect(Number.isInteger(Number(out))).toBe(true);
    expect(Number(out)).toBeGreaterThanOrEqual(0);
    // touch homedir() so the import is exercised on all platforms
    expect(typeof homedir()).toBe("string");
  });
});
