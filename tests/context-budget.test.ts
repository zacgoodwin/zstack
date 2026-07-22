// Gate tests for lib/context-budget.ts (issue #131, AC9): the deterministic
// live-context measurement the loop's context ceiling gates on. Covers
// currentContextTokens over a committed transcript fixture (input + cache-read
// + cache-creation of the LAST assistant usage line, output excluded), the
// empty/missing-file 0 fallback (fail-open, each reported UNKNOWN on stderr
// since a 0 here is never a measured-empty window), newest-mtime resolution,
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

// #157: a 0 from this module means "could not measure", so it must say UNKNOWN
// on stderr -- an operator who cannot tell that from "nearly empty" is the whole
// reason the reporting exists. Pinned here for the five unmeasurable paths (no
// transcript resolved, unreadable file, no usage line, only-unparseable lines,
// only-synthetic lines); the review that found the fifth verified against real
// data that no non-synthetic usage line sums to 0, so those five are all of them.
function expectUnknown(err: string, path?: string): void {
  expect(err).toContain("UNKNOWN");
  expect(err).toContain("cannot gate on it");
  if (path) expect(err).toContain(path);
}

describe("currentContextTokens (AC9)", () => {
  test("sums input + cache_read + cache_creation of the LAST assistant usage line, excluding output", () => {
    // Fixture's last assistant usage is
    // {input:400000, cache_read:120000, cache_creation:30000, output:900};
    // an EARLIER assistant line (100/200/0/50) proves "last" wins, not first/sum.
    expect(currentContextTokens(FIXTURE)).toBe(550000); // 400000 + 120000 + 30000, output 900 excluded
  });

  test("a transcript with no assistant/usage line returns 0 AND reports UNKNOWN (#157)", () => {
    const dir = mkTmp();
    const p = join(dir, "user-only.jsonl");
    writeFileSync(
      p,
      JSON.stringify({ type: "user", message: { role: "user", content: [] }, uuid: "x" }) + "\n"
    );
    let got = -1;
    const err = captureStderr(() => {
      got = currentContextTokens(p);
    });
    expect(got).toBe(0);
    expectUnknown(err, p);
  });

  test("an empty transcript returns 0 AND reports UNKNOWN (#157)", () => {
    const dir = mkTmp();
    const p = join(dir, "empty.jsonl");
    writeFileSync(p, "");
    let got = -1;
    const err = captureStderr(() => {
      got = currentContextTokens(p);
    });
    expect(got).toBe(0);
    expectUnknown(err, p);
  });

  test("a missing file returns 0 (fail-open, never throws) AND reports UNKNOWN (#157)", () => {
    const p = join(mkTmp(), "does-not-exist.jsonl");
    let got = -1;
    const err = captureStderr(() => {
      got = currentContextTokens(p);
    });
    expect(got).toBe(0);
    expectUnknown(err, p);
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
    expect(err).toContain("first at line 1");
    expectUnknown(err, p);
  });

  // -- #157 adversarial-review finding 2: Claude Code's SYNTHETIC assistant
  // entries. It writes one inline in the transcript on a rate-limited turn
  // (isApiErrorMessage + apiErrorStatus 429) and on an interrupted one
  // ("No response requested."). Both carry model "<synthetic>" and all four
  // usage keys present and ZERO -- so they parse cleanly, become the last
  // usage line, and used to be read as an empty window with no UNKNOWN report.
  // Shapes copied from real transcripts in ~/.claude/projects.
  const syntheticLine = (kind: "ratelimit" | "interrupt") =>
    JSON.stringify({
      type: "assistant",
      uuid: `u_${kind}`,
      message: {
        id: `syn_${kind}`,
        model: "<synthetic>",
        role: "assistant",
        type: "message",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        content: [{ type: "text", text: kind === "ratelimit" ? "You've hit your weekly limit · resets 3pm" : "No response requested." }],
      },
      ...(kind === "ratelimit" ? { isApiErrorMessage: true, apiErrorStatus: 429 } : { isApiErrorMessage: false }),
    });

  test("#157 finding 2: a synthetic FINAL line does not read as an empty window -- the last real usage line wins", () => {
    for (const kind of ["ratelimit", "interrupt"] as const) {
      const p = join(mkTmp(), `synthetic-${kind}.jsonl`);
      // The real failure mode: the synthetic entry lands exactly when the
      // window is FULLEST (a rate limit fires at the ceiling), so reading 0
      // here turns the gate off at the one moment it must fire.
      writeFileSync(p, `${assistantLine(550000)}\n${syntheticLine(kind)}\n`);
      let got = -1;
      const err = captureStderr(() => {
        got = currentContextTokens(p);
      });
      expect(got).toBe(550000); // NOT 0
      expect(err).toBe(""); // a real reading survived -- nothing to report
    }
    // isApiErrorMessage alone would miss the interrupt shape; the model string
    // is what catches both.
    expect(syntheticLine("interrupt")).toContain('"isApiErrorMessage":false');
  });

  test("#157 finding 2: a transcript whose ONLY usage lines are synthetic returns 0 AND reports UNKNOWN", () => {
    const p = join(mkTmp(), "synthetic-only.jsonl");
    writeFileSync(p, `${syntheticLine("ratelimit")}\n${syntheticLine("interrupt")}\n`);
    let got = -1;
    const err = captureStderr(() => {
      got = currentContextTokens(p);
    });
    expect(got).toBe(0);
    expect(err).toContain("2 assistant usage line(s) are synthetic");
    expectUnknown(err, p);
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

  test("an unresolvable session degrades to 0 (fail-open) AND reports UNKNOWN (#157)", () => {
    let got = -1;
    const err = captureStderr(() => {
      got = contextBudget("D:\\no\\such\\repo", mkTmp());
    });
    expect(got).toBe(0);
    expectUnknown(err); // names the project dir it looked in, not a transcript path
    expect(err).toContain("no session transcript resolved");
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

  test("`current --project-dir <unresolvable>` prints 0 on stdout and exits 0 (fail-open)", () => {
    let code = -1;
    let out = "";
    // The UNKNOWN report goes to stderr, which the wrapper's `CTX=$(...)`
    // command substitution does NOT capture -- so it can never corrupt $CTX.
    const err = captureStderr(() => {
      out = captureStdout(() => {
        code = main(["current", "--project-dir", join(mkTmp(), "nope")]);
      });
    });
    expect(code).toBe(0);
    expect(out).toBe("0");
    expectUnknown(err);
  });

  test("`current` defaults --project-dir to cwd; never throws for the real home", () => {
    // Whatever this machine's real ~/.claude/projects holds, the CLI must
    // return a non-negative integer, never crash the caller (fail-open).
    let code = -1;
    let out = "";
    captureStderr(() => {
      out = captureStdout(() => {
        code = main(["current"]);
      });
    });
    expect(code).toBe(0);
    expect(Number.isInteger(Number(out))).toBe(true);
    expect(Number(out)).toBeGreaterThanOrEqual(0);
    // touch homedir() so the import is exercised on all platforms
    expect(typeof homedir()).toBe("string");
  });
});
