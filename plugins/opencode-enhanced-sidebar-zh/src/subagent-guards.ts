/**
 * Pure helpers shared by the sub-agent panel: cost display semantics and
 * session-end eligibility. Kept free of JSX so they can be unit-tested.
 */

/** Cost info from the shared metrics service (never from OpenCode cost fields). */
export interface CostInfo {
  usd: number
  partial: boolean
  complete: boolean
  hasUsage: boolean
}

/** Minimal entry shape the cost helpers need (the panel's SubEntry). */
export interface CostCarrier {
  cost?: number
  costPartial?: boolean
  costComplete?: boolean
}

/**
 * Apply a fresh self-calculated cost to an entry.
 * Incomplete/absent results never overwrite existing values; a complete
 * calculation with no usage clears the legacy display value.
 */
export function applyCostInfo<T extends CostCarrier>(entry: T, info: CostInfo | undefined): T {
  if (!info) return entry
  if (!info.complete) return entry
  if (!info.hasUsage) {
    return { ...entry, cost: undefined, costPartial: undefined, costComplete: true }
  }
  return { ...entry, cost: info.usd, costPartial: info.partial, costComplete: true }
}

/**
 * Entry cost display text. `+` marks an estimate that contains unpriced
 * messages; incomplete fresh calculations are never shown.
 * Legacy KV numeric costs (no flags) are shown as a display migration until a
 * fresh calculation overwrites them.
 */
export function entryCostText(entry: CostCarrier): string | null {
  if (entry.cost === undefined) return null
  if (entry.costComplete === false) return null
  if (entry.costPartial === true && entry.cost === 0) return "未定价"
  const base = `$${entry.cost.toFixed(4)}`
  return entry.costPartial === true ? `${base}+` : base
}

/**
 * Decide whether a `session.idle`/`session.error` event should touch sub-agent
 * entries. Sub-agent entries belong to CHILD sessions only:
 * - a parent session ending (isChildSession === false) must never write its
 *   sessionId/cost into a child entry (agent-name fallback guard),
 * - the currently viewed session itself ending never updates entries either.
 */
export function shouldProcessSessionEnd(
  eventSessionID: string,
  isChildSession: boolean,
  viewSessionID: string,
): boolean {
  return isChildSession && eventSessionID !== viewSessionID
}
