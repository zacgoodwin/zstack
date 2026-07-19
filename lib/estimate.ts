// Deterministic cost estimator (C4, decision D7's estimate side): token
// buckets times references/rates.json rates, buffered, rounded to the cent.
// ESTIMATION.md's rule -- "this is arithmetic, so compute it, do not eyeball
// it" -- means every dollar figure here is computed, never asserted. The
// staleness clock is an injected parameter (never Date.now() in this file)
// so the >14-day rate-verification check is testable without racing the
// wall clock; bin/z-estimate supplies the real date at the CLI boundary.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleCliError } from "./cli.ts";
import { ZError } from "./config.ts";

export { ZError } from "./config.ts";

export interface ModelRate {
  input: number; // $ per 1M fresh input tokens
  output: number; // $ per 1M output tokens
  cached_input: number; // $ per 1M cache-read input tokens
}

export interface RatesFile {
  checked_at: string; // YYYY-MM-DD, last time these numbers were verified
  rates: Record<string, ModelRate>; // keyed by a lowercase model-family substring
}

export interface Buckets {
  output_tokens: number;
  fresh_input_tokens: number;
  cached_input_tokens: number;
  model: string;
  buffer_pct: number;
}

export interface EstimateResult {
  model: string;
  rate_key: string;
  subtotal: number; // dollars before buffer, rounded to the cent
  buffer_pct: number;
  total: number; // dollars after buffer, rounded to the cent
  stale: boolean;
  warning?: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const STALE_AFTER_DAYS = 14;
const PER_MILLION = 1_000_000;

export function ratesPath(): string {
  return join(import.meta.dir, "..", "references", "rates.json");
}

export function loadRates(path: string = ratesPath()): RatesFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ZError(`Cannot read rates at ${path}: ${(e as Error).message}`);
  }
  const cfg = raw as Partial<RatesFile>;
  if (!cfg.checked_at || typeof cfg.rates !== "object" || cfg.rates === null) {
    throw new ZError(`Rates file at ${path} is missing "checked_at" or "rates".`);
  }
  return cfg as RatesFile;
}

// Rates are keyed by model-family substring ("opus", "sonnet", "haiku",
// "fable"); resolving by case-insensitive substring match means both an
// estimate bucket's free-text model name ("Opus 4.8") and a real transcript
// model id ("claude-opus-4-1-20250805") hit the same rate row without a
// second lookup table to keep in sync.
export function resolveRate(model: string, rates: RatesFile): { key: string; rate: ModelRate } {
  const needle = model.toLowerCase();
  for (const [key, rate] of Object.entries(rates.rates)) {
    if (needle.includes(key.toLowerCase())) return { key, rate };
  }
  throw new ZError(
    `No rate for model "${model}" in rates.json. Known: ${Object.keys(rates.rates).join(", ")}.`
  );
}

export function roundCents(dollars: number): number {
  return Math.round(dollars * 100) / 100;
}

// Prices three token buckets against a rate row, rounded once to the cent.
// Shared by estimate() and lib/cost.ts so the dollar formula lives in exactly
// one place.
export function priceTokens(
  freshInputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  rate: ModelRate
): number {
  return roundCents(
    (freshInputTokens / PER_MILLION) * rate.input +
      (cachedInputTokens / PER_MILLION) * rate.cached_input +
      (outputTokens / PER_MILLION) * rate.output
  );
}

// Fractional days between checked_at and `now` (injected -- see file header).
export function staleDays(checkedAt: string, now: Date): number {
  const then = new Date(checkedAt).getTime();
  return (now.getTime() - then) / MS_PER_DAY;
}

export function isStale(checkedAt: string, now: Date): boolean {
  return staleDays(checkedAt, now) > STALE_AFTER_DAYS;
}

export function estimate(buckets: Buckets, rates: RatesFile, now: Date): EstimateResult {
  const { key, rate } = resolveRate(buckets.model, rates);
  const subtotal = priceTokens(
    buckets.fresh_input_tokens,
    buckets.cached_input_tokens,
    buckets.output_tokens,
    rate
  );
  const total = roundCents(subtotal * (1 + buckets.buffer_pct / 100));
  const stale = isStale(rates.checked_at, now);

  const result: EstimateResult = {
    model: buckets.model,
    rate_key: key,
    subtotal,
    buffer_pct: buckets.buffer_pct,
    total,
    stale,
  };
  if (stale) {
    const days = Math.floor(staleDays(rates.checked_at, now));
    result.warning =
      `Rates last checked ${rates.checked_at} (${days} days ago, over the 14-day limit). ` +
      `Verify current published rates before trusting this estimate.`;
  }
  return result;
}

// -- CLI ---------------------------------------------------------------------
const USAGE = `z-estimate <buckets.json> [--rates <path>]

  buckets.json: {output_tokens, fresh_input_tokens, cached_input_tokens, model, buffer_pct}
  buffer_pct guidance (ESTIMATION.md): 30 for a normal feature, 50-100 for a
  multi-ticket epic or unfamiliar code.`;

export function loadBuckets(path: string): Buckets {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ZError(`Cannot read buckets at ${path}: ${(e as Error).message}`);
  }
  const b = raw as Partial<Buckets>;
  const required: (keyof Buckets)[] = [
    "output_tokens",
    "fresh_input_tokens",
    "cached_input_tokens",
    "model",
    "buffer_pct",
  ];
  const missing = required.filter((k) => b[k] === undefined || b[k] === null);
  if (missing.length) throw new ZError(`Buckets at ${path} missing: ${missing.join(", ")}.`);
  // Type validation at the trust boundary (issue #14 item 18): key presence
  // alone let a string token count coerce through the arithmetic and a
  // non-string model leak a raw TypeError from resolveRate. Wrong types must
  // reject with a ZError naming the field, before any math runs.
  // Type validation at the trust boundary (issue #14 item 18): key presence
  // alone let a string token count coerce through the arithmetic and a
  // non-string model leak a raw TypeError from resolveRate. Wrong types must
  // reject with a ZError naming the field, before any math runs.
  const tokenKeys = ["output_tokens", "fresh_input_tokens", "cached_input_tokens"] as const;
  for (const k of tokenKeys) {
    const v = b[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new ZError(`Buckets at ${path}: "${k}" must be a non-negative finite number, got ${JSON.stringify(v)}.`);
    }
  }
  if (typeof b.buffer_pct !== "number" || !Number.isFinite(b.buffer_pct)) {
    throw new ZError(`Buckets at ${path}: "buffer_pct" must be a finite number, got ${JSON.stringify(b.buffer_pct)}.`);
  }
  if (typeof b.model !== "string" || !b.model) {
    throw new ZError(`Buckets at ${path}: "model" must be a non-empty string, got ${JSON.stringify(b.model)}.`);
  }
  return b as Buckets;
}

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
    let bucketsPath: string | undefined;
    let ratesFilePath = ratesPath();
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--rates") ratesFilePath = argv[++i];
      else bucketsPath = argv[i];
    }
    if (!bucketsPath) throw new ZError(`Usage: ${USAGE}`);

    const buckets = loadBuckets(bucketsPath);
    const rates = loadRates(ratesFilePath);
    const result = estimate(buckets, rates, new Date());

    console.log(
      `$${result.total.toFixed(2)} (subtotal $${result.subtotal.toFixed(2)}, ` +
        `buffer ${result.buffer_pct}%, model ${result.rate_key})`
    );
    if (result.warning) console.error(result.warning);
    return 0;
  } catch (e) {
    return handleCliError(e);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
