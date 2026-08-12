import { describe, expect, it } from "vitest";
import { calculateUsdFromTokenBuckets } from "../src/lib/token-cost.js";

// Rates are USD per 1M tokens: input $1, output $2, cache read $0.10,
// cache write $0.50, reasoning $4.
const RATES = {
  input: 1,
  output: 2,
  cache_read: 0.1,
  cache_write: 0.5,
  reasoning: 4,
};

describe("calculateUsdFromTokenBuckets", () => {
  it("prices every one of the five token kinds by its own rate", () => {
    const cost = calculateUsdFromTokenBuckets(RATES, {
      input: 1_000_000,
      output: 1_000_000,
      reasoning: 1_000_000,
      cache_read: 1_000_000,
      cache_write: 1_000_000,
    });
    // 1 + 2 + 4 + 0.1 + 0.5
    expect(cost).toBeCloseTo(7.6, 6);
  });

  it("falls back cache read/write rates to the input rate when missing", () => {
    const cost = calculateUsdFromTokenBuckets(
      { input: 1, output: 2 },
      { input: 0, output: 0, reasoning: 0, cache_read: 1_000_000, cache_write: 1_000_000 },
    );
    expect(cost).toBeCloseTo(2, 6);
  });

  it("falls back reasoning rate to the output rate when missing", () => {
    const cost = calculateUsdFromTokenBuckets(
      { input: 1, output: 2, cache_read: 0, cache_write: 0 },
      { input: 0, output: 0, reasoning: 1_000_000, cache_read: 0, cache_write: 0 },
    );
    expect(cost).toBeCloseTo(2, 6);
  });

  it("counts zero for kinds without a rate instead of fabricating cost", () => {
    // Only the output rate is present; input and its cache fallbacks are
    // unknown and must not be priced as free or invented.
    const cost = calculateUsdFromTokenBuckets({ output: 2 }, {
      input: 1_000_000,
      output: 0,
      reasoning: 0,
      cache_read: 1_000_000,
      cache_write: 1_000_000,
    });
    expect(cost).toBe(0);
  });
});
