/**
 * Pure presentation rules for the V2 session overview (context usage).
 *
 * This module is the acceptance seam for the sidebar: given token totals, a
 * model context limit and a session cost result it returns exactly what the
 * panel shows. It has no OpenCode dependencies and no reactivity, so the
 * visible-state rules can be verified without rendering the TUI.
 *
 * Rules (task spec):
 * - context usage counts all five token buckets;
 * - the percentage keeps the real ratio even above 100%;
 * - the 20-cell bar fills with the used ratio and never overflows;
 * - bar colors: <= 80% normal, > 80% warning, > 95% danger;
 * - cache hit rate = cache read / (input + cache read + cache write);
 * - an incomplete aggregation is marked, never shown as a complete total;
 * - unknown prices render 未定价, never $0 (via formatCostUsd).
 */

import { formatCostUsd } from "./token-cost.ts"

export const CONTEXT_BAR_CELLS = 20

export type ContextBarTier = "normal" | "warning" | "danger"

/** The five token buckets of the most recent assistant message. */
export interface ContextTokenBucketsLike {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

/** Structural subset of SessionCostResult the overview needs. */
export interface SessionCostResultLike {
  complete: boolean
  hasUsage: boolean
  partial: boolean
  usd: number
  /** Fetch/pagination failure or truncation marker, never shown verbatim. */
  error?: string
}

/** Sum all five token buckets into the context usage figure. */
export function sumContextTokens(tokens: ContextTokenBucketsLike): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

/**
 * Usage percentage of the model context limit.
 *
 * Returns undefined when the limit is unavailable (missing, zero or negative)
 * so the panel hides only the usage rows while the other metrics keep
 * rendering. The real ratio is kept even above 100%.
 */
export function contextUsagePercent(
  used: number | undefined,
  limit: number | undefined,
): number | undefined {
  if (used === undefined || limit === undefined || limit <= 0) return undefined
  return Math.round((used / limit) * 100)
}

/** Filled cells of the 20-cell bar; never exceeds CONTEXT_BAR_CELLS. */
export function contextBarCells(percent: number | undefined): number {
  if (percent === undefined) return 0
  const filled = Math.round((Math.min(percent, 100) / 100) * CONTEXT_BAR_CELLS)
  return Math.max(0, Math.min(CONTEXT_BAR_CELLS, filled))
}

/** Color tier of the bar: <= 80% normal, > 80% warning, > 95% danger. */
export function contextBarTier(percent: number | undefined): ContextBarTier {
  if (percent === undefined) return "normal"
  if (percent > 95) return "danger"
  if (percent > 80) return "warning"
  return "normal"
}

/** Cache hit percentage across the session's assistant messages. */
export function cacheHitPercent(
  totals: { input: number; read: number; write: number },
): number | undefined {
  const denominator = totals.input + totals.read + totals.write
  return denominator > 0 ? Math.round((totals.read / denominator) * 100) : undefined
}

/**
 * Session cost row text.
 *
 * - no run yet → null (row stays hidden while loading);
 * - a successful read without token usage → null (nothing to price);
 * - a failed or truncated run with no usage at all → 加载失败, so a broken
 *   fetch can never be mistaken for "this session has no usage";
 * - unknown/unpriced models → 未定价 or a trailing `+` (formatCostUsd);
 * - a partial aggregation is suffixed with （不完整） so it can never be
 *   mistaken for a complete total. The metrics service already keeps the last
 *   complete result, so an incomplete row only appears when no complete
 *   aggregation exists yet.
 */
export function formatSessionCost(result: SessionCostResultLike | undefined): string | null {
  if (!result) return null
  if (!result.hasUsage) return result.error ? "加载失败" : null
  const base = formatCostUsd(result.usd, result)
  if (base === null) return null
  return result.complete ? base : `${base}（不完整）`
}
