/**
 * Token bucket extraction and summation.
 *
 * Ported from @slkiser/opencode-quota (dist/lib/token-buckets.js), MIT.
 * See LICENSES/opencode-quota.LICENSE.
 *
 * Important: this module NEVER reads `message.cost` / `session.cost`. The only
 * inputs are the five token buckets carried by an assistant message.
 */

export type TokenBuckets = {
  input: number
  output: number
  reasoning: number
  cache_read: number
  cache_write: number
}

/** Minimal shape accepted by the extractor (SDK v1 `Message` or v2 `SessionMessageAssistant`). */
export interface TokenCarrier {
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  } | null
}

export function emptyTokenBuckets(): TokenBuckets {
  return { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 }
}

export function addTokenBuckets(a: TokenBuckets, b: TokenBuckets): TokenBuckets {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cache_read: a.cache_read + b.cache_read,
    cache_write: a.cache_write + b.cache_write,
  }
}

export function totalTokenBuckets(buckets: TokenBuckets): number {
  return (
    buckets.input +
    buckets.output +
    buckets.reasoning +
    buckets.cache_read +
    buckets.cache_write
  )
}

export function tokenBucketsFromMessage(message: TokenCarrier): TokenBuckets {
  const tokens = message.tokens
  if (!tokens) return emptyTokenBuckets()
  return {
    input: typeof tokens.input === "number" ? tokens.input : 0,
    output: typeof tokens.output === "number" ? tokens.output : 0,
    reasoning: typeof tokens.reasoning === "number" ? tokens.reasoning : 0,
    cache_read: typeof tokens.cache?.read === "number" ? tokens.cache.read : 0,
    cache_write: typeof tokens.cache?.write === "number" ? tokens.cache.write : 0,
  }
}

/** True when any of the five buckets is non-zero (a message that carries usage). */
export function hasTokenUsage(buckets: TokenBuckets): boolean {
  return totalTokenBuckets(buckets) > 0
}
