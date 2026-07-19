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
import { join } from "node:path";
import { costOfFiles, expandGlob, parseLine, ZError } from "../lib/cost.ts";
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
