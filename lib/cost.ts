// Spend accounting (C4, decision D7): sums the real dollar cost of a ticket's
// work from Claude Code transcript jsonl files, so the board's Actual field is
// never eyeballed.
//
// Two correctness facts drove this design, both confirmed against a real
// transcript under ~/.claude/projects/ rather than assumed:
//
// 1. A single API response gets written as MULTIPLE jsonl lines (one per
//    tool-use/text content block), and every one of those lines repeats the
//    IDENTICAL usage object for that response, tagged with the same
//    `requestId`. Summing every line naively overcounts spend by however many
//    content blocks the response had (observed ~3x average, up to 12x, across
//    a real session). So lines are deduped by requestId before summing.
//    ponytail: assumes usage is a stable snapshot repeated per requestId
//    (verified empirically: 0 mismatches across 41 requestIds / 121 lines in
//    a real session), not incremented across lines. If Claude Code ever
//    starts emitting incremental per-line usage instead, this needs to sum
//    deltas per requestId rather than take the first line seen.
// 2. The real usage object carries `cache_creation_input_tokens` in addition
//    to the four keys ESTIMATION.md's buckets model (fresh/cached input,
//    output). rates.json only defines input/output/cached_input rates (no
//    separate cache-write tier), so cache-creation tokens are priced at the
//    fresh `input` rate alongside `input_tokens` -- they are fresh (non-cache-
//    hit) tokens being processed for the first time. This under-prices real
//    cache writes slightly (Anthropic bills a premium for cache creation);
//    upgrade path is a fourth rate tier in rates.json if that gap matters.
//
// Format-drift gate: parseLine() asserts the four usage keys exist on every
// assistant message it prices. If Claude Code ever renames one, this throws
// loudly instead of silently under/over-billing (tests/cost.test.ts pins this
// with a mutated-fixture canary).
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { handleCliError } from "./cli.ts";
import { ZError } from "./config.ts";
import { loadRates, priceTokens, ratesPath, resolveRate, roundCents, type RatesFile } from "./estimate.ts";

export { ZError } from "./config.ts";
export { loadRates, ratesPath } from "./estimate.ts";

// The exact wire keys Claude Code writes on an assistant message's `usage`
// object. Renaming/removing any of these must fail loudly (AC4).
const REQUIRED_USAGE_KEYS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
] as const;

interface RawUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

interface ParsedUsageLine {
  dedupKeys: string[]; // 1-2 keys naming this line's response (requestId and/or msgid:<id>)
  model: string;
  usage: RawUsage;
}

export interface TokenTotals {
  fresh_input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

export interface ModelSpend {
  model: string; // resolved rate_key ("sonnet", "fable", ...)
  tokens: TokenTotals;
  dollars: number;
}

export interface CostResult {
  total: number; // dollars, rounded to the cent
  by_model: ModelSpend[];
  requests: number; // unique API calls counted (post-dedup)
  lines_parsed: number; // assistant+usage lines seen (pre-dedup)
}

function assertUsageShape(usage: any, where: string): RawUsage {
  const missing = REQUIRED_USAGE_KEYS.filter((k) => typeof usage?.[k] !== "number");
  if (missing.length) {
    throw new ZError(
      `${where}: usage object is missing/renamed key(s): ${missing.join(", ")}. ` +
        `Claude Code's transcript format may have changed -- refusing to write a possibly-wrong Actual value.`
    );
  }
  return usage as RawUsage;
}

// Parses one jsonl line. Returns null for lines that carry no priceable
// usage (user turns, summaries, etc.) rather than treating every line as an
// error -- only assistant messages with a usage object are ever priced.
export function parseLine(line: string, where: string): ParsedUsageLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch (e) {
    throw new ZError(`${where}: not valid JSON (${(e as Error).message}).`);
  }

  if (obj.type !== "assistant" || obj.message?.usage === undefined) return null;

  const usage = assertUsageShape(obj.message.usage, where);
  const model = obj.message.model;
  if (typeof model !== "string" || !model) {
    throw new ZError(`${where}: assistant message missing "model".`);
  }
  // Dedup keys for split-content-block lines (fact 1 above): a line carries
  // requestId, the API message id, or BOTH -- and one response's lines don't
  // all carry the same fields (F14: a requestId+message.id line can sit next
  // to a message.id-only sibling). So a line contributes EVERY id it has, and
  // costOfFiles treats it as duplicate if ANY key was already seen; keying by
  // a single id gave the two halves different keys and priced the response
  // twice. message.id is 1:1 with requestId (verified: 0 mismatches across 8
  // requestIds / 27 lines in a real session). A file:line fallback would price
  // an N-block response N times; it remains only as the last resort when BOTH
  // ids are absent, so a line is never silently dropped -- worst case it's
  // priced once, uniquely. The "msgid:" prefix keeps the id namespaces from
  // ever colliding.
  const dedupKeys: string[] = [];
  if (typeof obj.requestId === "string" && obj.requestId) dedupKeys.push(obj.requestId);
  if (typeof obj.message.id === "string" && obj.message.id) dedupKeys.push(`msgid:${obj.message.id}`);
  if (dedupKeys.length === 0) dedupKeys.push(where);
  return { dedupKeys, model, usage };
}

export function costOfFiles(paths: string[], rates: RatesFile): CostResult {
  const seenKeys = new Set<string>();
  const perModel = new Map<string, TokenTotals>();
  let linesParsed = 0;
  let requests = 0;

  for (const path of paths) {
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const parsed = parseLine(lines[i], `${path}:${i + 1}`);
      if (!parsed) continue;
      linesParsed++;

      // Duplicate if ANY of the line's ids was seen; register ALL of them
      // either way, so a line linking requestId<->message.id also claims the
      // id its earlier sibling lacked (F14: mixed-id lines of one response).
      const duplicate = parsed.dedupKeys.some((k) => seenKeys.has(k));
      for (const k of parsed.dedupKeys) seenKeys.add(k);
      if (duplicate) continue; // duplicate content-block line
      requests++;

      const { key } = resolveRate(parsed.model, rates);
      const bucket = perModel.get(key) ?? { fresh_input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
      bucket.fresh_input_tokens += parsed.usage.input_tokens + parsed.usage.cache_creation_input_tokens;
      bucket.cached_input_tokens += parsed.usage.cache_read_input_tokens;
      bucket.output_tokens += parsed.usage.output_tokens;
      perModel.set(key, bucket);
    }
  }

  const by_model: ModelSpend[] = [];
  let total = 0;
  for (const [key, tokens] of perModel) {
    const rate = rates.rates[key];
    const dollars = priceTokens(tokens.fresh_input_tokens, tokens.cached_input_tokens, tokens.output_tokens, rate);
    by_model.push({ model: key, tokens, dollars });
    total += dollars;
  }

  return { total: roundCents(total), by_model, requests, lines_parsed: linesParsed };
}

// Native glob (Bun.Glob is already part of the runtime -- no new dependency).
// Handles both cwd-relative patterns ("transcripts/*.jsonl") and absolute
// ones (a real "~/.claude/projects/.../*.jsonl" expansion) by re-joining any
// relative match against cwd; absolute matches pass through unchanged.
//
// Bun.Glob.scanSync cannot match a pattern that IS itself an absolute path --
// confirmed empirically (ticket #22): an absolute pattern with no glob
// metacharacter anywhere (e.g. a transcript file named directly, the exact
// shape z-cost hit live) returns zero matches no matter what `cwd` is passed,
// even though the identical tail matches fine once it's relative to its own
// directory. So an absolute pattern is split into its deepest directory
// prefix that contains no glob metacharacter, and Bun.Glob scans FROM that
// prefix with only the remaining (now-relative) tail as the pattern; matches
// are re-joined onto the prefix to stay absolute. Relative patterns are
// untouched -- they already scan correctly from the caller's cwd.
const ABSOLUTE_PATTERN = /^(?:[a-zA-Z]:[\\/]|[\\/])/; // POSIX "/..." or Windows "X:/..." / "X:\..."
// A UNC path (\\server\share\... or //server/share/...) matches
// ABSOLUTE_PATTERN's driveless-leading-slash branch, but splitAbsoluteGlob's
// `pattern.split(/[\\/]+/)` collapses the leading double separator into one
// empty segment, so the rejoined prefix becomes a single-slash path ("/host/
// share") indistinguishable from an ordinary driveless-absolute one.
// resolve() then roots that onto the CURRENT drive (confirmed empirically:
// resolve("/host/share") on this machine returns "D:\host\share", the drive
// of process.cwd(), never the network host) -- so a UNC pattern silently
// redirects to a same-named local directory on whatever drive the process
// happens to be running from if one exists, instead of the loud ENOENT a
// missing network share should give. That's a silent wrong answer, which
// breaks this file's fail-loud contract (see AC4's format-drift gate above).
// Teaching splitAbsoluteGlob to preserve/resolve a UNC root is a bigger
// change with its own edge cases (Bun.Glob's `cwd` option was never
// confirmed to accept a UNC root at all) that nothing here needs --
// transcripts always live under the user's home directory -- so UNC patterns
// are refused outright instead.
const UNC_PATTERN = /^[\\/]{2}/;
const GLOB_META = /[*?[\]{}]/;

// Splits an absolute pattern into { prefix, rest } where `prefix` has no glob
// metacharacter in any segment and `rest` is the (relative) remainder handed
// to Bun.Glob. If the whole pattern is literal (no metachar at all -- the
// exact failure this fixes), `rest` falls back to just the final segment so
// Bun.Glob always receives a relative tail.
function splitAbsoluteGlob(pattern: string): { prefix: string; rest: string } {
  const segments = pattern.split(/[\\/]+/); // segments[0] is "" (POSIX root) or "C:" (drive)
  let i = 1;
  for (; i < segments.length; i++) {
    if (GLOB_META.test(segments[i])) break;
  }
  if (i >= segments.length) i = segments.length - 1; // no metachar anywhere: keep the last segment relative
  let prefix = segments.slice(0, i).join("/") || "/";
  if (/^[a-zA-Z]:$/.test(prefix)) prefix += "/"; // bare drive letter ("C:") means drive-relative, not root
  const rest = segments.slice(i).join("/");
  return { prefix, rest };
}

export function expandGlob(pattern: string, cwd: string = process.cwd()): string[] {
  let scanCwd = cwd;
  let scanPattern = pattern;
  if (ABSOLUTE_PATTERN.test(pattern)) {
    if (UNC_PATTERN.test(pattern)) {
      throw new ZError(
        `UNC patterns (\\\\server\\share\\...) are not supported by z-cost; use a mapped drive letter or a local path. Got: "${pattern}"`
      );
    }
    const split = splitAbsoluteGlob(pattern);
    // resolve(): a driveless POSIX-style prefix ("/Users/...") is a real,
    // existing directory to node:fs (Windows maps it onto the current
    // drive) but Bun.Glob's own `cwd` option fails to open it as given
    // (confirmed empirically) -- resolve() fully-qualifies it onto the
    // current drive first, which Bun.Glob always handles correctly.
    scanCwd = resolve(split.prefix);
    scanPattern = split.rest;
  }
  const matches = [...new Bun.Glob(scanPattern).scanSync({ cwd: scanCwd })];
  return matches.map((m) => (isAbsolute(m) ? m : join(scanCwd, m))).sort();
}

// -- CLI ---------------------------------------------------------------------
const USAGE = `z-cost <glob-pattern> [--rates <path>] [--json]

  glob-pattern: Claude Code transcript jsonl files for a ticket's agents,
                e.g. "$HOME/.claude/projects/*/*.jsonl"
  --json:       emit the CostResult object (total, by_model with tokens and
                dollars, requests, lines_parsed) so consumers like z-loop's
                Actual field-set parse JSON, never prose`;

export async function main(argv: string[]): Promise<number> {
  if (!argv[0]) {
    console.log(USAGE);
    return 1;
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    console.log(USAGE);
    return 0;
  }

  try {
    let pattern: string | undefined;
    let ratesFilePath = ratesPath();
    let jsonOut = false;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--rates") ratesFilePath = argv[++i];
      else if (argv[i] === "--json") jsonOut = true;
      else pattern = argv[i];
    }
    if (!pattern) throw new ZError(`Usage: ${USAGE}`);

    const files = expandGlob(pattern);
    if (files.length === 0) throw new ZError(`No files matched "${pattern}".`);

    const rates = loadRates(ratesFilePath);
    const result = costOfFiles(files, rates);

    if (jsonOut) {
      console.log(JSON.stringify(result));
      return 0;
    }
    console.log(`$${result.total.toFixed(2)} total across ${result.requests} request(s), ${files.length} file(s)`);
    for (const m of result.by_model) {
      console.log(
        `  ${m.model}: $${m.dollars.toFixed(2)} ` +
          `(fresh=${m.tokens.fresh_input_tokens} cached=${m.tokens.cached_input_tokens} output=${m.tokens.output_tokens})`
      );
    }
    return 0;
  } catch (e) {
    return handleCliError(e);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
