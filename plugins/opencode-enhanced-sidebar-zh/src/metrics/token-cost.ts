/**
 * USD cost calculation from token buckets and models.dev pricing.
 *
 * Formula ported from @slkiser/opencode-quota (dist/lib/token-cost.js), MIT.
 * See LICENSES/opencode-quota.LICENSE.
 *
 * Fallback rules (identical to opencode-quota):
 * - `cache_read` missing → priced at `input`
 * - `cache_write` missing → priced at `input`
 * - `reasoning` missing → priced at `output`
 *
 * This module is pure: it never touches OpenCode `cost` fields.
 */

import type { CostBuckets } from "./pricing.ts"
import type { TokenBuckets } from "./token-buckets.ts"

export interface TokenBucketLike {
  input: number
  output: number
  reasoning: number
  cache_read: number
  cache_write: number
}

function perToken(usdPer1M: number | undefined): number {
  return typeof usdPer1M === "number" ? usdPer1M / 1_000_000 : 0
}

export function calculateUsdFromTokenBuckets(
  rates: CostBuckets,
  tokens: TokenBucketLike,
): number {
  const inputRate = perToken(rates.input)
  const outputRate = perToken(rates.output)
  const cacheReadRate = perToken(rates.cache_read ?? rates.input)
  const cacheWriteRate = perToken(rates.cache_write ?? rates.input)
  const reasoningRate = perToken(rates.reasoning ?? rates.output)
  return (
    tokens.input * inputRate +
    tokens.output * outputRate +
    tokens.cache_read * cacheReadRate +
    tokens.cache_write * cacheWriteRate +
    tokens.reasoning * reasoningRate
  )
}

/**
 * Format a session/subagent cost with the sidebar's fixed 4-decimal style.
 *
 * - `partial = true` means at least one message carried tokens that could not be
 *   priced (unknown model or unpriced model); the trailing `+` marks it.
 * - A session that has usage but zero priced amount and some unpriced messages
 *   renders as `$0.0000+` (all unpriced).
 * - No usage at all → returns null so the caller hides the row.
 */
export function formatCostUsd(
  usd: number,
  opts: { hasUsage: boolean; partial: boolean },
): string | null {
  if (!opts.hasUsage) return null
  const base = `$${usd.toFixed(4)}`
  return opts.partial ? `${base}+` : base
}
