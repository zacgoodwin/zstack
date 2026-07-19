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
import { isAbsolute, join } from "node:path";
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
  requestId: string;
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
  // requestId is what dedupes split-content-block lines back to one API call
  // (fact 1 above). Falling back to `where` (file:line) if it's ever absent
  // means a line is never silently dropped -- worst case it's priced once,
  // uniquely, same as today's behavior without this fallback.
  const requestId = typeof obj.requestId === "string" && obj.requestId ? obj.requestId : where;
  return { requestId, model, usage };
}

export function costOfFiles(paths: string[], rates: RatesFile): CostResult {
  const seenRequests = new Set<string>();
  const perModel = new Map<string, TokenTotals>();
  let linesParsed = 0;

  for (const path of paths) {
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const parsed = parseLine(lines[i], `${path}:${i + 1}`);
      if (!parsed) continue;
      linesParsed++;

      if (seenRequests.has(parsed.requestId)) continue; // duplicate content-block line
      seenRequests.add(parsed.requestId);

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

  return { total: roundCents(total), by_model, requests: seenRequests.size, lines_parsed: linesParsed };
}

// Native glob (Bun.Glob is already part of the runtime -- no new dependency).
// Handles both cwd-relative patterns ("transcripts/*.jsonl") and absolute
// ones (a real "~/.claude/projects/.../*.jsonl" expansion) by re-joining any
// relative match against cwd; absolute matches pass through unchanged.
export function expandGlob(pattern: string, cwd: string = process.cwd()): string[] {
  const matches = [...new Bun.Glob(pattern).scanSync({ cwd })];
  return matches.map((m) => (isAbsolute(m) ? m : join(cwd, m))).sort();
}

// -- CLI ---------------------------------------------------------------------
const USAGE = `z-cost <glob-pattern> [--rates <path>]

  glob-pattern: Claude Code transcript jsonl files for a ticket's agents,
                e.g. "$HOME/.claude/projects/*/*.jsonl"`;

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
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--rates") ratesFilePath = argv[++i];
      else pattern = argv[i];
    }
    if (!pattern) throw new ZError(`Usage: ${USAGE}`);

    const files = expandGlob(pattern);
    if (files.length === 0) throw new ZError(`No files matched "${pattern}".`);

    const rates = loadRates(ratesFilePath);
    const result = costOfFiles(files, rates);

    console.log(`$${result.total.toFixed(2)} total across ${result.requests} request(s), ${files.length} file(s)`);
    for (const m of result.by_model) {
      console.log(
        `  ${m.model}: $${m.dollars.toFixed(2)} ` +
          `(fresh=${m.tokens.fresh_input_tokens} cached=${m.tokens.cached_input_tokens} output=${m.tokens.output_tokens})`
      );
    }
    return 0;
  } catch (e) {
    if (e instanceof ZError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
