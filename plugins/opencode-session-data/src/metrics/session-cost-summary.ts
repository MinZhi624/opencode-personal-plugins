import { createEffect, createMemo } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import type { SessionMetricsService } from "./session-metrics.ts"
import { formatCompactCostUsd, formatCostUsd } from "./token-cost.ts"
import { formatSessionCost } from "./session-overview-view.ts"
import { totalTokenBuckets } from "./token-buckets.ts"

export type SessionCostSummary = {
  /** 花费（本会话）: this session only, keeps 加载失败 / （不完整） visibility. */
  session: () => string | null
  /** 花费（子代理）: descendant sessions only; null while any is still loading. */
  subagent: () => string | null
  /** 花费（任务树合计）: whole task tree, root session included. */
  tree: () => string | null
  /** Cumulative tokens across the root conversation and all descendants. */
  treeTokens: () => number | null
  treeTokenStatus: () => "loading" | "failed" | "incomplete" | "stale" | "ready"
  /** All descendant sessions of the root, independent of panel limits. */
  descendantCount: () => number
  rootID: () => string
  descendantIDs: () => readonly string[]
  descendantTokens: () => number | null
  descendantTokenStatus: () => "loading" | "failed" | "incomplete" | "stale" | "ready"
  descendantCost: () => string | null
}

/**
 * The three cost surfaces of one session, all aggregated from complete
 * client-side history (never the TUI's ~100-message window) and priced per
 * message by its own provider/model.
 *
 * A surface stays null while any contributing session is still loading, so a
 * partial sum is never rendered as a total; unknown prices render 未定价 via
 * formatCostUsd, never $0.
 *
 * `runtime` is the shared runtime owned by the opencode-session-data plugin
 * (see ../seam.ts); only its `metrics` service is read here, so any host that
 * exposes the same service shape can be passed in.
 *
 * @param tick accessor read for re-render; cost aggregation is poll-driven.
 */
export function createSessionCostSummary(
  context: Context,
  runtime: { readonly metrics: SessionMetricsService },
  sessionID: () => string,
  tick: () => void,
): SessionCostSummary {
  // Poll membership as well as per-session results: the TUI family cache may
  // not itself be reactive. Suppress unchanged sets so refreshCosts does not
  // refetch every session on each display tick.
  const family = createMemo(() => {
    void tick()
    return context.data.session.family(sessionID())
  }, undefined, { equals: (a, b) => a.length === b.length && a.every((id) => b.includes(id)) })
  const rootID = createMemo(() => {
    void tick()
    return context.data.session.root(sessionID())
  })
  const rootDescendants = createMemo(() => {
    void tick()
    const pending = new Set([rootID()])
    const result: string[] = []
    let changed = true
    while (changed) {
      changed = false
      for (const id of family()) {
        const item = context.data.session.get(id)
        if (id === rootID() || pending.has(id) || !item?.parentID || !pending.has(item.parentID)) continue
        pending.add(id)
        result.push(id)
        changed = true
      }
    }
    return result
  })
  const descendants = createMemo(() => {
    void tick()
    const pending = new Set([sessionID()])
    const result: string[] = []
    let changed = true
    while (changed) {
      changed = false
      for (const id of family()) {
        const session = context.data.session.get(id)
        if (!pending.has(id) && session?.parentID && pending.has(session.parentID)) {
          pending.add(id)
          result.push(id)
          changed = true
        }
      }
    }
    return result
  })
  createEffect(() => {
    runtime.metrics.refresh(sessionID(), { delayMs: 0 })
    for (const id of family()) runtime.metrics.refresh(id, { delayMs: 0 })
  })
  const session = createMemo(() => {
    void tick()
    return formatSessionCost(runtime.metrics.get(sessionID()))
  })
  const sumCost = (ids: readonly string[], compact = false) => {
    const results = ids.map((id) => runtime.metrics.get(id))
    if (!results.length || results.some((result) => !result?.complete)) return null
    const used = results.filter((result) => result?.hasUsage)
    if (!used.length) return null
    const amount = used.reduce((sum, result) => sum + result!.usd, 0)
    const options = {
      hasUsage: true,
      partial: used.some((result) => result!.partial),
    }
    return compact ? formatCompactCostUsd(amount, options) : formatCostUsd(amount, options)
  }
  const sumTokens = (ids: readonly string[]) => {
    const results = ids.map((id) => runtime.metrics.get(id))
    if (results.some((result) => !result?.complete)) return null
    return results.reduce((sum, result) => sum + totalTokenBuckets(result!.tokens), 0)
  }
  const tokenStatus = (ids: readonly string[]) => {
    const results = ids.map((id) => runtime.metrics.get(id))
    if (results.some((result) => result?.error && result.error !== "truncated")) return "failed" as const
    if (results.some((result) => result && !result.complete)) return "incomplete" as const
    if (results.some((result) => !result)) return "loading" as const
    if (ids.some((id) => runtime.metrics.isStale(id))) return "stale" as const
    return "ready" as const
  }
  const subagent = createMemo(() => {
    void tick()
    return sumCost(descendants())
  })
  const tree = createMemo(() => {
    void tick()
    const root = rootID()
    const treeSessions = family().map((id) => runtime.metrics.get(id))
    if (!treeSessions.length || treeSessions.some((result) => !result?.complete)) return null
    const rootResult = runtime.metrics.get(root)
    if (!rootResult?.complete) return null
    const all = treeSessions.filter((result) => result !== undefined)
    if (!all.some((result) => result.hasUsage)) return null
    return formatCostUsd(all.reduce((sum, result) => sum + result.usd, 0), {
      hasUsage: true,
      partial: all.some((result) => result.partial),
    })
  })
  const descendantCount = createMemo(() => rootDescendants().length)
  const descendantTokens = createMemo(() => {
    void tick()
    return sumTokens(rootDescendants())
  })
  const descendantCost = createMemo(() => {
    void tick()
    return sumCost(rootDescendants(), true)
  })
  const treeTokens = createMemo(() => {
    void tick()
    return sumTokens([rootID(), ...rootDescendants()])
  })
  const treeTokenStatus = createMemo(() => {
    void tick()
    return tokenStatus([rootID(), ...rootDescendants()])
  })
  const descendantTokenStatus = createMemo(() => {
    void tick()
    return tokenStatus(rootDescendants())
  })
  return { session, subagent, tree, treeTokens, treeTokenStatus, rootID, descendantIDs: rootDescendants, descendantCount, descendantTokens, descendantTokenStatus, descendantCost }
}
