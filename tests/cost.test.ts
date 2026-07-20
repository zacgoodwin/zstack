// Gate tests for C4's spend accounting (lib/cost.ts). Covers AC3 (z-cost on
// the pinned fixture equals a hand-computed dollar value), AC4 (a renamed
// usage key fails loudly instead of silently mispricing), and AC5 (rounding).
// Also pins the dedup behavior found by inspecting a real transcript: a
// single API response is split across multiple jsonl lines sharing one
// requestId, each repeating the same usage -- naive summation would
// overcount by however many content-block lines the response had.
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { costOfFiles, expandGlob, main, parseLine, sumByStage, ZError } from "../lib/cost.ts";
import type { FileSpend } from "../lib/cost.ts";
import type { RatesFile } from "../lib/estimate.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "transcript.jsonl");

const RATES: RatesFile = {
  checked_at: "2026-07-01",
  rates: {
    fable: { input: 10.0, output: 50.0, cached_input: 1.0 },
    opus: { input: 5.0, output: 25.0, cached_input: 0.5 },
    sonnet: { input: 3.0, output: 15.0, cached_input: 0.3 },
    haiku: { input: 1.0, output: 5.0, cached_input: 0.1 },
  },
};

const tmpPaths: string[] = [];
function tmpFile(content: string, name = "transcript.jsonl"): string {
  const dir = mkdtempSync(join(tmpdir(), "zcost-"));
  tmpPaths.push(dir);
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}
afterEach(() => {
  while (tmpPaths.length) rmSync(tmpPaths.pop()!, { recursive: true, force: true });
});

// -- AC3: fixture parses to the hand-computed dollar value -------------------
//
// The fixture has 6 lines: 1 user turn (ignored), 2 assistant lines sharing
// requestId "req_AAA111" (a duplicated content-block pair -- must count once),
// 1 tool_result user turn (ignored), and 2 more distinct assistant requests.
//
// sonnet (req_AAA111 deduped once + req_CCC333):
//   fresh  = (1000 + 2000) + (0 + 0)       = 3000
//   cached = 50000 + 100000                = 150000
//   output = 500 + 50                      = 550
//   $ = 3000/1e6*3 + 150000/1e6*0.30 + 550/1e6*15 = 0.009 + 0.045 + 0.00825
//     = 0.06225 -> rounds to $0.06
//
// fable (req_BBB222):
//   fresh = 200 + 0 = 200, cached = 10000, output = 300
//   $ = 200/1e6*10 + 10000/1e6*1.00 + 300/1e6*50 = 0.002 + 0.01 + 0.015
//     = 0.027 -> rounds to $0.03
//
// total = 0.06 + 0.03 = $0.09
describe("costOfFiles: fixture (AC3)", () => {
  test("matches the hand-computed dollar value", () => {
    const result = costOfFiles([FIXTURE], RATES);
    expect(result.total).toBe(0.09);
    expect(result.requests).toBe(3); // req_AAA111 (deduped), req_BBB222, req_CCC333
    expect(result.lines_parsed).toBe(4); // 2 (req_AAA111 dup) + 1 + 1

    const sonnet = result.by_model.find((m) => m.model === "sonnet")!;
    expect(sonnet.tokens).toEqual({ fresh_input_tokens: 3000, cached_input_tokens: 150000, output_tokens: 550 });
    expect(sonnet.dollars).toBe(0.06);

    const fable = result.by_model.find((m) => m.model === "fable")!;
    expect(fable.tokens).toEqual({ fresh_input_tokens: 200, cached_input_tokens: 10000, output_tokens: 300 });
    expect(fable.dollars).toBe(0.03);
  });

  test("determinism: same files in -> same dollars out, twice", () => {
    const a = costOfFiles([FIXTURE], RATES);
    const b = costOfFiles([FIXTURE], RATES);
    expect(a).toEqual(b);
  });

  test("dedup: without it the total would be wrong (documents the real-transcript bug this guards against)", () => {
    // Same fixture data but WITHOUT the duplicated content-block line for
    // req_AAA111 removed -- i.e. this is what a naive (non-deduping) sum
    // over the fixture-as-written would look like if line 3 were counted
    // again. We assert the actual code returns the deduped total, not the
    // inflated one, by checking requests < lines that mention req_AAA111.
    const raw = readFileSync(FIXTURE, "utf8");
    const aaaLines = raw.split("\n").filter((l) => l.includes("req_AAA111")).length;
    expect(aaaLines).toBe(2); // the fixture really does duplicate this request
    const result = costOfFiles([FIXTURE], RATES);
    expect(result.requests).toBeLessThan(result.lines_parsed); // dedup actually collapsed something
  });
});

// -- AC4: format-drift canary -------------------------------------------------
describe("format-drift canary (AC4)", () => {
  test("a renamed usage key fails loudly instead of silently mispricing", () => {
    const raw = readFileSync(FIXTURE, "utf8");
    // Rename but keep it valid JSON -- a real drift would ship a JSON-valid
    // transcript with a differently-spelled key, not broken syntax.
    const mutated = raw.replace(/"cache_read_input_tokens"/g, `"cache_read_tokens"`);
    const file = tmpFile(mutated);
    expect(() => costOfFiles([file], RATES)).toThrow(ZError);
    expect(() => costOfFiles([file], RATES)).toThrow(/cache_read_input_tokens/);
  });

  test("parseLine asserts all four required usage keys on a priceable line", () => {
    const line = JSON.stringify({
      type: "assistant",
      requestId: "req_X",
      message: { model: "claude-sonnet-4-5", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1 } },
    });
    expect(() => parseLine(line, "test:1")).toThrow(/cache_creation_input_tokens/);
  });

  test("non-assistant / usage-less lines are skipped, not errors", () => {
    expect(parseLine('{"type":"user","message":{"role":"user"}}', "test:1")).toBeNull();
    expect(parseLine("", "test:1")).toBeNull();
    expect(parseLine("   ", "test:1")).toBeNull();
  });

  test("malformed JSON names the offending file:line", () => {
    expect(() => parseLine("{not json", "transcript.jsonl:7")).toThrow(/transcript\.jsonl:7/);
  });
});

// -- synthetic transcript entries (ticket #30) --------------------------------
//
// Hit live during a /z-loop drain: Claude Code itself writes an inline
// synthetic assistant entry with `"model": "<synthetic>"` whenever an API
// call fails transiently mid-session (isApiErrorMessage:true, apiErrorStatus
// 429/500/529 -- rate limit or server error). Confirmed against 11/11 real
// "<synthetic>" occurrences in ~/.claude/projects/ transcripts. It has a
// full, validly-shaped usage object (that's why it reached resolveRate at
// all instead of being filtered out by parseLine's assistant+usage check)
// but carries nothing billable -- z-cost must skip it before the rate lookup
// and count the skip, rather than raising the fail-loud unknown-model ZError
// every OTHER unrecognized model string still must raise.
describe("synthetic transcript entries are skipped, not priced (ticket #30)", () => {
  const ZERO_USAGE = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  const syntheticLine = (requestId: string) =>
    JSON.stringify({
      type: "assistant",
      requestId,
      message: { model: "<synthetic>", role: "assistant", usage: ZERO_USAGE },
    });
  const realLine = (requestId: string, model: string) =>
    JSON.stringify({
      type: "assistant",
      requestId,
      message: {
        model,
        usage: { input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });

  test("AC1: mixed transcript prices the real entries and reports skippedSynthetic", () => {
    // Real fixture (hand-computed total $0.09, 3 requests -- see AC3 above)
    // plus one synthetic line appended: the total and request count must be
    // unaffected, with exactly one skip counted.
    const content = readFileSync(FIXTURE, "utf8").replace(/\n$/, "") + "\n" + syntheticLine("req_SYN") + "\n";
    const file = tmpFile(content);
    const result = costOfFiles([file], RATES);
    expect(result.total).toBe(0.09); // unchanged from the real-only fixture
    expect(result.requests).toBe(3); // synthetic entry does not count as a request
    expect(result.skippedSynthetic).toBe(1);
  });

  test("AC2: an all-synthetic transcript yields total 0 with skippedSynthetic set, no unknown-model error", () => {
    const content = [syntheticLine("req_SYN1"), syntheticLine("req_SYN2"), syntheticLine("req_SYN3")].join("\n") + "\n";
    const file = tmpFile(content);
    const result = costOfFiles([file], RATES);
    expect(result.total).toBe(0);
    expect(result.requests).toBe(0);
    expect(result.by_model).toEqual([]);
    expect(result.skippedSynthetic).toBe(3); // one per line, not deduped
  });

  test("AC3: a genuinely unknown model string still raises the fail-loud ZError", () => {
    const file = tmpFile(realLine("req_UNKNOWN", "gpt-oss") + "\n");
    expect(() => costOfFiles([file], RATES)).toThrow(ZError);
    expect(() => costOfFiles([file], RATES)).toThrow(/No rate for model "gpt-oss"/);
  });

  test("--json surfaces skippedSynthetic for consumers (z-loop's Actual field-set)", async () => {
    const content = readFileSync(FIXTURE, "utf8").replace(/\n$/, "") + "\n" + syntheticLine("req_SYN") + "\n";
    const file = tmpFile(content);
    const pattern = join(file, "..", "*.jsonl").replaceAll("\\", "/");
    const ratesFile = tmpFile(JSON.stringify(RATES), "rates.json");

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    let code: number;
    try {
      code = await main(["--json", pattern, "--rates", ratesFile]);
    } finally {
      console.log = orig;
    }
    expect(code).toBe(0);
    const obj = JSON.parse(logs.join("\n"));
    expect(obj.total).toBe(0.09);
    expect(obj.skippedSynthetic).toBe(1);
  });

  test("human summary line surfaces the skip count when nonzero", async () => {
    const file = tmpFile(syntheticLine("req_SYN") + "\n");
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    let code: number;
    try {
      code = await main([file]);
    } finally {
      console.log = orig;
    }
    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/1 synthetic skipped/);
  });
});

// -- glob expansion (native Bun.Glob, no new dependency) ---------------------
describe("expandGlob", () => {
  test("matches jsonl files under a directory and returns readable paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcost-glob-"));
    tmpPaths.push(dir);
    writeFileSync(join(dir, "a.jsonl"), "");
    writeFileSync(join(dir, "b.jsonl"), "");
    writeFileSync(join(dir, "c.txt"), "");
    const files = expandGlob("*.jsonl", dir);
    expect(files.length).toBe(2);
    for (const f of files) expect(() => readFileSync(f, "utf8")).not.toThrow();
  });

  test("no matches returns an empty array", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcost-glob-empty-"));
    tmpPaths.push(dir);
    expect(expandGlob("*.jsonl", dir)).toEqual([]);
  });
});

// -- absolute patterns (ticket #22: Bun.Glob drive-letter fix) ---------------
//
// Confirmed empirically (Windows, Bun 1.3.14): Bun.Glob.scanSync never
// matches a pattern that is ITSELF a fully literal absolute path (no glob
// metacharacter anywhere) regardless of `cwd` -- e.g. the exact live repro
// `z-cost --json "C:/.../transcripts/ticket-17/builder.jsonl"` returned "No
// files matched" even though the file existed, while the identical filename
// used as a relative pattern from its own directory matched fine. The fix
// splits an absolute pattern into its deepest glob-metacharacter-free
// directory prefix and scans from there with only the (now relative) tail.
describe("expandGlob: absolute patterns (ticket #22)", () => {
  test("AC1: absolute Windows drive-letter pattern (forward slashes) matches", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcost-abs-win-fwd-"));
    tmpPaths.push(dir);
    writeFileSync(join(dir, "transcript.jsonl"), readFileSync(FIXTURE, "utf8"));
    const pattern = join(dir, "*.jsonl").replaceAll("\\", "/"); // "C:/.../*.jsonl"
    const files = expandGlob(pattern);
    expect(files.length).toBe(1);
    expect(costOfFiles(files, RATES).total).toBe(0.09);
  });

  test("AC1: absolute Windows drive-letter pattern (native backslashes) matches", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcost-abs-win-back-"));
    tmpPaths.push(dir);
    writeFileSync(join(dir, "transcript.jsonl"), readFileSync(FIXTURE, "utf8"));
    const pattern = join(dir, "*.jsonl"); // native Windows join uses "\"
    const files = expandGlob(pattern);
    expect(files.length).toBe(1);
    expect(costOfFiles(files, RATES).total).toBe(0.09);
  });

  test("absolute POSIX-style pattern (leading single slash, no drive letter) matches", () => {
    // A driveless leading-slash path is drive-RELATIVE on Windows (it
    // resolves onto whatever the current process's drive is), so the fixture
    // has to live on that same drive -- os.tmpdir() is a different drive on
    // this machine, so build under process.cwd() (the worktree) instead.
    const dir = mkdtempSync(join(process.cwd(), ".zcost-abs-posix-"));
    tmpPaths.push(dir);
    writeFileSync(join(dir, "transcript.jsonl"), readFileSync(FIXTURE, "utf8"));
    // Strip the drive letter to simulate a POSIX-style absolute pattern
    // ("/Users/.../*.jsonl") -- the leading-slash branch of ABSOLUTE_PATTERN.
    const posixDir = "/" + dir.replace(/^[a-zA-Z]:[\\/]/, "").replaceAll("\\", "/");
    const pattern = `${posixDir}/*.jsonl`;
    const files = expandGlob(pattern);
    expect(files.length).toBe(1);
    expect(costOfFiles(files, RATES).total).toBe(0.09);
  });

  test("literal absolute path with NO glob metacharacter still matches (the exact live repro)", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcost-abs-literal-"));
    tmpPaths.push(dir);
    writeFileSync(join(dir, "builder.jsonl"), readFileSync(FIXTURE, "utf8"));
    const pattern = join(dir, "builder.jsonl").replaceAll("\\", "/"); // no "*" anywhere
    const files = expandGlob(pattern);
    expect(files.length).toBe(1);
    expect(costOfFiles(files, RATES).total).toBe(0.09);
  });

  test("AC2: relative pattern (cd T && z-cost \"*.jsonl\") gives the same total as AC1", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcost-rel-"));
    tmpPaths.push(dir);
    writeFileSync(join(dir, "transcript.jsonl"), readFileSync(FIXTURE, "utf8"));
    const files = expandGlob("*.jsonl", dir); // cwd = T, pattern relative -- unchanged behavior
    expect(files.length).toBe(1);
    expect(costOfFiles(files, RATES).total).toBe(0.09);
  });

  test("AC3: absolute pattern over an empty directory still yields no matches", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcost-abs-empty-"));
    tmpPaths.push(dir);
    const pattern = join(dir, "*.jsonl").replaceAll("\\", "/");
    expect(expandGlob(pattern)).toEqual([]);
  });

  test("AC3: main() raises the existing ZError naming the pattern for an absolute no-match glob", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zcost-abs-empty-cli-"));
    tmpPaths.push(dir);
    const pattern = join(dir, "*.jsonl").replaceAll("\\", "/");
    const logs: string[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => void logs.push(a.join(" "));
    let code: number;
    try {
      code = await main(["--json", pattern]);
    } finally {
      console.error = origError;
    }
    expect(code).not.toBe(0);
    expect(logs.join("\n")).toContain(pattern);
    expect(logs.join("\n")).toMatch(/No files matched/);
  });
});

// -- UNC patterns are refused, not silently mismatched (ticket #22 rework) --
//
// Adversarial review found that the fix above has a regression: a UNC path
// (\\server\share\... or //server/share/...) matches ABSOLUTE_PATTERN's
// driveless-leading-slash branch, but splitAbsoluteGlob's
// `pattern.split(/[\\/]+/)` collapses the leading double separator into one
// segment, so resolve() roots the (now single-slash) prefix onto the
// CURRENT drive instead of the network host -- silently redirecting to a
// same-named local directory if one happens to exist, instead of the loud
// ENOENT a missing UNC share should give. That's a silent wrong answer
// (priced!) where the pre-fix code merely failed loud on the literal UNC
// path. Since z-cost's transcripts always live under the user's home
// directory (no real UNC demand), UNC patterns are refused outright with a
// ZError naming the limitation, preserving the fail-loud contract with the
// smallest possible surface.
describe("expandGlob: UNC patterns are refused (ticket #22 rework)", () => {
  test("a //server/share/*.jsonl-style pattern throws naming UNC", () => {
    expect(() => expandGlob("//myserver/share/*.jsonl")).toThrow(ZError);
    expect(() => expandGlob("//myserver/share/*.jsonl")).toThrow(/UNC/);
  });

  test("a \\\\server\\share\\...-style pattern (native Windows UNC backslashes) throws naming UNC", () => {
    expect(() => expandGlob("\\\\myserver\\share\\*.jsonl")).toThrow(ZError);
    expect(() => expandGlob("\\\\myserver\\share\\*.jsonl")).toThrow(/UNC/);
  });

  test("main() exits 1 and prints the UNC error for a UNC pattern", async () => {
    const logs: string[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => void logs.push(a.join(" "));
    let code: number;
    try {
      code = await main(["--json", "//myserver/share/*.jsonl"]);
    } finally {
      console.error = origError;
    }
    expect(code).toBe(1);
    expect(logs.join("\n")).toMatch(/UNC/);
  });

  test("shadow-dir: a UNC pattern still throws even when a local dir mirrors its segments", () => {
    // Reproduces the reviewer's exact regression scenario: build a REAL local
    // directory at the drive root that splitAbsoluteGlob+resolve() would
    // silently redirect the UNC pattern onto if the guard did not exist
    // (confirmed empirically: path.resolve("/host/share") on this machine
    // returns "<cwd's drive>:\host\share", i.e. the drive root -- not the
    // network host), containing a real transcript file. Without the guard
    // this local file would be the silent wrong match the reviewer found;
    // with the guard, expandGlob must throw before ever reaching that path,
    // never returning the local file.
    const rand = Math.random().toString(36).slice(2);
    const host = `zcost-shadow-host-${rand}`;
    const share = `zcost-shadow-share-${rand}`;
    const root = parse(process.cwd()).root; // e.g. "D:\\"
    const shadowDir = join(root, host, share);
    mkdirSync(shadowDir, { recursive: true });
    tmpPaths.push(join(root, host));
    writeFileSync(join(shadowDir, "local.jsonl"), readFileSync(FIXTURE, "utf8"));

    const pattern = `//${host}/${share}/*.jsonl`;
    expect(() => expandGlob(pattern)).toThrow(ZError);
    expect(() => expandGlob(pattern)).toThrow(/UNC/);
  });
});

// -- requestId-absent dedup fallback (issue #14 item 16a) ---------------------
//
// Real transcripts split one API response across multiple jsonl lines (one per
// content block), each repeating the identical `message` object -- including
// its API message id (`message.id`). requestId and message.id are 1:1 per
// response (verified: 0 mismatches across 8 requestIds / 27 lines in a real
// session). So when requestId is absent, message.id is the stable per-response
// key; without it, the old file:line fallback priced an N-block response N
// times -- the exact overcount the dedup exists to prevent.
describe("dedup fallback when requestId is absent (item 16a)", () => {
  const HAIKU_USAGE = {
    input_tokens: 100,
    output_tokens: 100,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  // One content-block line of a response identified only by message.id.
  const blockLine = (msgId: string | undefined, text: string) =>
    JSON.stringify({
      type: "assistant",
      message: {
        ...(msgId !== undefined ? { id: msgId } : {}),
        model: "claude-haiku-4-5",
        role: "assistant",
        content: [{ type: "text", text }],
        usage: HAIKU_USAGE,
      },
    });

  test("multi-block response without requestId is priced exactly once", () => {
    const file = tmpFile(blockLine("msg_ONE", "block a") + "\n" + blockLine("msg_ONE", "block b") + "\n");
    const result = costOfFiles([file], RATES);
    expect(result.lines_parsed).toBe(2);
    expect(result.requests).toBe(1); // NOT 2: both lines are one API response
    const haiku = result.by_model.find((m) => m.model === "haiku")!;
    expect(haiku.tokens).toEqual({ fresh_input_tokens: 100, cached_input_tokens: 0, output_tokens: 100 });
  });

  test("distinct responses without requestId stay distinct (different message.id)", () => {
    const file = tmpFile(blockLine("msg_ONE", "a") + "\n" + blockLine("msg_TWO", "b") + "\n");
    const result = costOfFiles([file], RATES);
    expect(result.requests).toBe(2);
    const haiku = result.by_model.find((m) => m.model === "haiku")!;
    expect(haiku.tokens.output_tokens).toBe(200);
  });

  test("neither requestId nor message.id: last-resort file:line, never dropped", () => {
    const file = tmpFile(blockLine(undefined, "a") + "\n" + blockLine(undefined, "b") + "\n");
    const result = costOfFiles([file], RATES);
    expect(result.requests).toBe(2); // priced once per line, uniquely -- worst case, not silently dropped
  });

  test("requestId still wins when present (fixture behavior unchanged)", () => {
    expect(costOfFiles([FIXTURE], RATES).requests).toBe(3);
  });
});

// -- mixed-id dedup (F14) -----------------------------------------------------
//
// One response's content-block lines don't all carry the same id fields: a line
// can have requestId+message.id while a sibling has only message.id (or only
// requestId). Keying each line by a SINGLE id gives the two halves different
// dedup keys ("req_R" vs "msgid:msg_M") and prices the one response twice. The
// fix registers BOTH ids as seen and treats a line as duplicate if EITHER key
// was seen -- including registering the keys of already-duplicate lines, so a
// later line carrying only the "other" id of a linked pair still dedups.
describe("mixed-id responses dedup by BOTH keys (F14)", () => {
  const USAGE = {
    input_tokens: 100,
    output_tokens: 100,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  const line = (ids: { requestId?: string; msgId?: string }) =>
    JSON.stringify({
      type: "assistant",
      ...(ids.requestId !== undefined ? { requestId: ids.requestId } : {}),
      message: {
        ...(ids.msgId !== undefined ? { id: ids.msgId } : {}),
        model: "claude-haiku-4-5",
        usage: USAGE,
      },
    });

  test("line with both ids + line with only message.id: priced once", () => {
    const file = tmpFile(line({ requestId: "req_R", msgId: "msg_M" }) + "\n" + line({ msgId: "msg_M" }) + "\n");
    const result = costOfFiles([file], RATES);
    expect(result.lines_parsed).toBe(2);
    expect(result.requests).toBe(1); // NOT 2: both lines are one API response
    const haiku = result.by_model.find((m) => m.model === "haiku")!;
    expect(haiku.tokens.output_tokens).toBe(100); // priced once, not twice
  });

  test("line with only requestId + line with both ids: priced once", () => {
    const file = tmpFile(line({ requestId: "req_R" }) + "\n" + line({ requestId: "req_R", msgId: "msg_M" }) + "\n");
    const result = costOfFiles([file], RATES);
    expect(result.requests).toBe(1);
    expect(result.by_model.find((m) => m.model === "haiku")!.tokens.output_tokens).toBe(100);
  });

  test("chain: requestId-only, both, message.id-only -- one response, priced once", () => {
    // The middle line links req_R to msg_M; the third carries only msg_M. This
    // only dedups if duplicate lines still register their unseen keys.
    const file = tmpFile(
      line({ requestId: "req_R" }) + "\n" + line({ requestId: "req_R", msgId: "msg_M" }) + "\n" + line({ msgId: "msg_M" }) + "\n"
    );
    const result = costOfFiles([file], RATES);
    expect(result.lines_parsed).toBe(3);
    expect(result.requests).toBe(1);
    expect(result.by_model.find((m) => m.model === "haiku")!.tokens.output_tokens).toBe(100);
  });

  test("distinct responses with distinct id pairs stay distinct", () => {
    const file = tmpFile(
      line({ requestId: "req_A", msgId: "msg_A" }) + "\n" + line({ requestId: "req_B", msgId: "msg_B" }) + "\n"
    );
    const result = costOfFiles([file], RATES);
    expect(result.requests).toBe(2);
    expect(result.by_model.find((m) => m.model === "haiku")!.tokens.output_tokens).toBe(200);
  });
});

// -- z-cost --json (issue #14 item 16b) ---------------------------------------
//
// z-loop's Actual field-set consumes `z-cost --json | jq -r .total`; this pins
// the machine-readable shape so that pipeline can't silently rot.
describe("z-cost --json output (item 16b)", () => {
  test("emits one parseable object: total, per-model breakdown with tokens, requests", async () => {
    // Same data as the AC3 fixture, via a glob pattern like z-loop passes.
    const file = tmpFile(readFileSync(FIXTURE, "utf8"));
    const pattern = join(file, "..", "*.jsonl").replaceAll("\\", "/");
    const ratesFile = tmpFile(JSON.stringify(RATES), "rates.json");

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    let code: number;
    try {
      code = await main(["--json", pattern, "--rates", ratesFile]);
    } finally {
      console.log = orig;
    }
    expect(code).toBe(0);

    const obj = JSON.parse(logs.join("\n"));
    expect(obj.total).toBe(0.09); // jq -r .total -> what z-loop field-sets as Actual
    expect(obj.requests).toBe(3);
    const sonnet = obj.by_model.find((m: any) => m.model === "sonnet");
    expect(sonnet.dollars).toBe(0.06);
    expect(sonnet.tokens).toEqual({ fresh_input_tokens: 3000, cached_input_tokens: 150000, output_tokens: 550 });
  });
});

// -- multi-file sum -----------------------------------------------------------
describe("costOfFiles across multiple files", () => {
  test("sums a ticket's several agent transcripts together", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcost-multi-"));
    tmpPaths.push(dir);
    const line = (requestId: string, model: string) =>
      JSON.stringify({
        type: "assistant",
        requestId,
        message: {
          model,
          usage: { input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      });
    const fileA = join(dir, "a.jsonl");
    const fileB = join(dir, "b.jsonl");
    writeFileSync(fileA, line("req_1", "claude-haiku-4-5") + "\n");
    writeFileSync(fileB, line("req_2", "claude-haiku-4-5") + "\n");

    const result = costOfFiles([fileA, fileB], RATES);
    expect(result.requests).toBe(2);
    const haiku = result.by_model.find((m) => m.model === "haiku")!;
    expect(haiku.tokens).toEqual({ fresh_input_tokens: 200, cached_input_tokens: 0, output_tokens: 200 });
  });
});

// -- --by-file attribution (ticket #83) ---------------------------------------
//
// Per-file spend attribution feeds z-loop's end-of-loop spend-by-stage table:
// the loop copies one transcript per stage spawn (<stage>-<attempt>.jsonl),
// and z-cost --by-file prices each one so lib/endloop.ts's sumByStage can
// bucket them. Dedup stays GLOBAL (unchanged total) -- only attribution is
// per-file.
describe("--by-file attribution (ticket #83)", () => {
  const usage = (input: number, output: number) => ({
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
  const line = (requestId: string, model: string, input: number, output: number) =>
    JSON.stringify({ type: "assistant", requestId, message: { model, usage: usage(input, output) } });

  // AC1: a directory of two fixture transcripts -- by_file's dollars sum to
  // the cent-equal total.
  test("AC1: by_file dollars sum equals total to the cent, over two fixture files", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcost-byfile-"));
    tmpPaths.push(dir);
    // Sonnet rate: input $3/1M, output $15/1M. Round token counts so the
    // file-level rounding and the model-level rounding this fixture happens
    // to land on the same cent (a pin, not a general rounding proof -- see
    // costOfFiles' by_file comment).
    writeFileSync(join(dir, "builder-1.jsonl"), line("req_A", "claude-sonnet-4-5", 100000, 10000) + "\n"); // $0.30 + $0.15 = $0.45
    writeFileSync(join(dir, "qa-1.jsonl"), line("req_B", "claude-sonnet-4-5", 100000, 0) + "\n"); // $0.30

    const files = expandGlob("*.jsonl", dir);
    const result = costOfFiles(files, RATES, { byFile: true });
    expect(result.total).toBe(0.75);
    expect(result.by_file).toBeDefined();
    const sum = result.by_file!.reduce((s, f) => s + f.dollars, 0);
    expect(Math.round(sum * 100) / 100).toBe(result.total);
    expect(result.by_file!.find((f) => f.file.endsWith("builder-1.jsonl"))!.dollars).toBe(0.45);
    expect(result.by_file!.find((f) => f.file.endsWith("qa-1.jsonl"))!.dollars).toBe(0.3);
  });

  // AC2: without --by-file, output is byte-identical to today -- no by_file
  // key anywhere, not even as `undefined` leaking into JSON.
  test("AC2: without --by-file, CostResult has no by_file key at all", () => {
    const result = costOfFiles([FIXTURE], RATES);
    expect("by_file" in result).toBe(false);
  });

  test("AC2: --json output without --by-file has no by_file key (byte-identical to today)", async () => {
    const file = tmpFile(readFileSync(FIXTURE, "utf8"));
    const pattern = join(file, "..", "*.jsonl").replaceAll("\\", "/");
    const ratesFile = tmpFile(JSON.stringify(RATES), "rates.json");
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    let code: number;
    try {
      code = await main(["--json", pattern, "--rates", ratesFile]);
    } finally {
      console.log = orig;
    }
    expect(code).toBe(0);
    expect(logs.join("\n")).not.toContain("by_file");
    expect(JSON.parse(logs.join("\n")).by_file).toBeUndefined();
  });

  // AC3: a requestId duplicated across two files is priced once in total,
  // attributed to exactly one by_file entry (the first-seen file).
  test("AC3: a requestId duplicated across two files is priced once, attributed to exactly one file", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcost-byfile-dup-"));
    tmpPaths.push(dir);
    writeFileSync(join(dir, "builder-1.jsonl"), line("req_DUP", "claude-sonnet-4-5", 100000, 0) + "\n");
    // Same requestId again -- pure duplicate, no other content in this file.
    writeFileSync(join(dir, "builder-2.jsonl"), line("req_DUP", "claude-sonnet-4-5", 100000, 0) + "\n");

    const files = expandGlob("*.jsonl", dir); // sorted: builder-1.jsonl, builder-2.jsonl
    const result = costOfFiles(files, RATES, { byFile: true });
    expect(result.requests).toBe(1); // priced once in total, not twice
    expect(result.total).toBe(0.3);

    expect(result.by_file).toHaveLength(1); // the duplicate-only file contributed nothing
    expect(result.by_file![0].file.endsWith("builder-1.jsonl")).toBe(true); // attributed to first-seen, in sorted order
    expect(result.by_file![0].dollars).toBe(0.3);
    expect(result.by_file![0].requests).toBe(1);

    const totalFromFiles = result.by_file!.reduce((s, f) => s + f.dollars, 0);
    expect(Math.round(totalFromFiles * 100) / 100).toBe(result.total);
  });

  test("by_file entries appear in lexicographically sorted path order, not insertion order", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcost-byfile-order-"));
    tmpPaths.push(dir);
    writeFileSync(join(dir, "reviewer-1.jsonl"), line("req_R", "claude-haiku-4-5", 100, 0) + "\n");
    writeFileSync(join(dir, "builder-1.jsonl"), line("req_B", "claude-haiku-4-5", 100, 0) + "\n");
    writeFileSync(join(dir, "qa-1.jsonl"), line("req_Q", "claude-haiku-4-5", 100, 0) + "\n");

    const files = expandGlob("*.jsonl", dir); // expandGlob already sorts
    const result = costOfFiles(files, RATES, { byFile: true });
    const names = result.by_file!.map((f) => f.file.replace(/\\/g, "/").split("/").pop());
    expect(names).toEqual(["builder-1.jsonl", "qa-1.jsonl", "reviewer-1.jsonl"]);
  });

  test("--by-file text mode prints one line per file above the total line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zcost-byfile-text-"));
    tmpPaths.push(dir);
    writeFileSync(join(dir, "builder-1.jsonl"), line("req_A", "claude-sonnet-4-5", 100000, 0) + "\n");
    const ratesFile = tmpFile(JSON.stringify(RATES), "rates.json");
    const pattern = join(dir, "*.jsonl").replaceAll("\\", "/");

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    let code: number;
    try {
      code = await main(["--by-file", pattern, "--rates", ratesFile]);
    } finally {
      console.log = orig;
    }
    expect(code).toBe(0);
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs[0]).toContain("builder-1.jsonl");
    expect(logs[0]).toContain("$0.30");
    expect(logs[0]).toContain("(1 requests)");
    // total line comes AFTER the per-file line(s), i.e. "above the total" (plan item 1)
    const totalLineIndex = logs.findIndex((l) => l.startsWith("$0.30 total across"));
    expect(totalLineIndex).toBeGreaterThan(0);
  });
});

// -- sumByStage (ticket #83, AC6) ----------------------------------------------
describe("sumByStage", () => {
  const fileSpend = (file: string, dollars: number): FileSpend => ({
    file,
    dollars,
    requests: 1,
    tokens: { fresh_input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
  });

  test("AC6: buckets qa-1.jsonl and qa-2.jsonl into one qa row; notes.jsonl goes to other", () => {
    const byFile = [
      fileSpend("/state/transcripts/ticket-12/qa-1.jsonl", 0.1),
      fileSpend("/state/transcripts/ticket-12/qa-2.jsonl", 0.05),
      fileSpend("/state/transcripts/ticket-12/notes.jsonl", 0.02),
    ];
    const stages = sumByStage(byFile);
    expect(stages).toHaveLength(2); // only stages actually present
    expect(stages.find((s) => s.stage === "qa")!.dollars).toBe(0.15);
    expect(stages.find((s) => s.stage === "other")!.dollars).toBe(0.02);
  });

  test("recognizes builder/reviewer/merge stage prefixes too", () => {
    const byFile = [fileSpend("builder-1.jsonl", 1), fileSpend("reviewer-1.jsonl", 2), fileSpend("merge-1.jsonl", 3)];
    const stages = sumByStage(byFile);
    expect(stages.map((s) => s.stage).sort()).toEqual(["builder", "merge", "reviewer"]);
  });

  test("a Windows-style path (backslashes) still resolves to the basename's stage", () => {
    const byFile = [fileSpend("C:\\state\\transcripts\\ticket-9\\qa-1.jsonl", 0.5)];
    expect(sumByStage(byFile)).toEqual([{ stage: "qa", dollars: 0.5 }]);
  });
});
