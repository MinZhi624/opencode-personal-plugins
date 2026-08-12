import { describe, expect, it } from "vitest";
import {
  addTokenBuckets,
  emptyTokenBuckets,
  tokenBucketsFromMessage,
  totalTokenBuckets,
} from "../src/lib/token-buckets.js";

describe("token buckets (five token kinds)", () => {
  it("keeps all five kinds: input, output, reasoning, cache read, cache write", () => {
    expect(emptyTokenBuckets()).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cache_read: 0,
      cache_write: 0,
    });
  });

  it("adds buckets per kind without merging kinds", () => {
    const a = { input: 1, output: 2, reasoning: 3, cache_read: 4, cache_write: 5 };
    const b = { input: 10, output: 20, reasoning: 30, cache_read: 40, cache_write: 50 };
    expect(addTokenBuckets(a, b)).toEqual({
      input: 11,
      output: 22,
      reasoning: 33,
      cache_read: 44,
      cache_write: 55,
    });
  });

  it("totals every kind including reasoning and both cache directions", () => {
    expect(
      totalTokenBuckets({ input: 10, output: 20, reasoning: 30, cache_read: 40, cache_write: 50 }),
    ).toBe(150);
  });

  it("extracts all five kinds from a message and defaults missing fields to zero", () => {
    const tokens = tokenBucketsFromMessage({
      tokens: { input: 10, output: 20, reasoning: 30, cache: { read: 40, write: 50 } },
    });
    expect(tokens).toEqual({ input: 10, output: 20, reasoning: 30, cache_read: 40, cache_write: 50 });
  });

  it("keeps cache read and write separate from input/output in extraction", () => {
    expect(
      tokenBucketsFromMessage({
        tokens: { input: 1, output: 2, cache: { read: 3, write: 4 } },
      }),
    ).toEqual({ input: 1, output: 2, reasoning: 0, cache_read: 3, cache_write: 4 });
  });

  it("returns zeroed buckets for messages without token data", () => {
    expect(tokenBucketsFromMessage({})).toEqual(emptyTokenBuckets());
    expect(tokenBucketsFromMessage({ tokens: null })).toEqual(emptyTokenBuckets());
  });
});
