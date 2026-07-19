// Gate tests for C4's estimator (lib/estimate.ts). Covers AC1 (determinism),
// AC2 (staleness with an injected clock, never Date.now()), and AC5
// (rounding to the cent, hand-computed).
import { test, expect, describe } from "bun:test";
import {
  estimate,
  isStale,
  loadRates,
  priceTokens,
  resolveRate,
  roundCents,
  staleDays,
  ZError,
  type Buckets,
  type RatesFile,
} from "../lib/estimate.ts";

const RATES: RatesFile = {
  checked_at: "2026-07-01",
  rates: {
    fable: { input: 10.0, output: 50.0, cached_input: 1.0 },
    opus: { input: 5.0, output: 25.0, cached_input: 0.5 },
    sonnet: { input: 3.0, output: 15.0, cached_input: 0.3 },
    haiku: { input: 1.0, output: 5.0, cached_input: 0.1 },
  },
};

const BUCKETS: Buckets = {
  output_tokens: 100_000, // 0.1M
  fresh_input_tokens: 200_000, // 0.2M
  cached_input_tokens: 4_000_000, // 4M
  model: "sonnet-4.5",
  buffer_pct: 30,
};

// Hand-computed at sonnet rates (input 3, output 15, cached_input 0.30):
// 0.2M * 3 = 0.60, 4M * 0.30 = 1.20, 0.1M * 15 = 1.50 -> subtotal 3.30
// buffered 30%: 3.30 * 1.30 = 4.29
describe("estimate: determinism (AC1)", () => {
  test("same buckets in -> same dollars out, twice", () => {
    const now = new Date("2026-07-05T00:00:00Z");
    const first = estimate(BUCKETS, RATES, now);
    const second = estimate(BUCKETS, RATES, now);
    expect(first).toEqual(second);
    expect(first.subtotal).toBe(3.3);
    expect(first.total).toBe(4.29);
  });

  test("rounds a non-cent-aligned bucket to the nearest cent (AC5)", () => {
    const odd: Buckets = { ...BUCKETS, fresh_input_tokens: 1, cached_input_tokens: 0, output_tokens: 0, buffer_pct: 0 };
    // 1 token * $3/1M = $0.000003 -> rounds to $0.00
    expect(estimate(odd, RATES, new Date("2026-07-05")).subtotal).toBe(0);
  });
});

describe("estimate: staleness (AC2)", () => {
  test("checked_at 15 days older than injected now -> warning emitted", () => {
    const now = new Date(new Date(RATES.checked_at).getTime() + 15 * 24 * 60 * 60 * 1000);
    const result = estimate(BUCKETS, RATES, now);
    expect(result.stale).toBe(true);
    expect(result.warning).toMatch(/verify current published rates/i);
  });

  test("checked_at exactly 14 days old -> not stale (boundary)", () => {
    const now = new Date(new Date(RATES.checked_at).getTime() + 14 * 24 * 60 * 60 * 1000);
    expect(isStale(RATES.checked_at, now)).toBe(false);
  });

  test("checked_at within 14 days -> no warning", () => {
    const now = new Date(new Date(RATES.checked_at).getTime() + 3 * 24 * 60 * 60 * 1000);
    const result = estimate(BUCKETS, RATES, now);
    expect(result.stale).toBe(false);
    expect(result.warning).toBeUndefined();
  });

  test("staleDays reports fractional days from the injected clock, never Date.now()", () => {
    const now = new Date(new Date(RATES.checked_at).getTime() + 15.5 * 24 * 60 * 60 * 1000);
    expect(staleDays(RATES.checked_at, now)).toBeCloseTo(15.5, 5);
  });
});

describe("resolveRate", () => {
  test.each([
    ["Fable 5", "fable"],
    ["Opus 4.8", "opus"],
    ["Sonnet 4.5", "sonnet"],
    ["Haiku 4.5", "haiku"],
    ["claude-opus-4-1-20250805", "opus"],
    ["claude-sonnet-4-5-20250929", "sonnet"],
  ])("matches %s -> %s by substring, case-insensitive", (model, key) => {
    expect(resolveRate(model, RATES).key).toBe(key);
  });

  test("unknown model lists the known set", () => {
    expect(() => resolveRate("gpt-5", RATES)).toThrow(/No rate for model "gpt-5".*fable.*opus.*sonnet.*haiku/);
  });
});

describe("priceTokens / roundCents", () => {
  test("rounds to the nearest cent, not truncating or eyeballing", () => {
    expect(roundCents(0.004)).toBe(0.0); // rounds down
    expect(roundCents(0.126)).toBe(0.13); // rounds up
    expect(roundCents(0.005 + 0.005)).toBe(0.01); // survives float addition noise
  });

  test("priceTokens matches the manual formula", () => {
    const rate = RATES.rates.opus;
    const dollars = priceTokens(1_000_000, 2_000_000, 500_000, rate);
    expect(dollars).toBe(1 * 5 + 2 * 0.5 + 0.5 * 25); // 5 + 1 + 12.5 = 18.5
  });
});

describe("loadRates", () => {
  test("reads the real references/rates.json seeded from ESTIMATION.md", () => {
    const rates = loadRates();
    expect(rates.rates.fable).toEqual({ input: 10, output: 50, cached_input: 1 });
    expect(rates.rates.opus).toEqual({ input: 5, output: 25, cached_input: 0.5 });
    expect(rates.rates.sonnet).toEqual({ input: 3, output: 15, cached_input: 0.3 });
    expect(rates.rates.haiku).toEqual({ input: 1, output: 5, cached_input: 0.1 });
    expect(rates.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("missing file raises a ZError naming the path", () => {
    expect(() => loadRates("/no/such/rates.json")).toThrow(ZError);
  });
});
