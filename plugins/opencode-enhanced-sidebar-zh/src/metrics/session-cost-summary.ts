import { createMemo } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import type { createV2Metrics } from "../v2-runtime.ts"
import { formatCostUsd } from "./token-cost.ts"
import { formatSessionCost } from "./session-overview-view.ts"

export type SessionCostSummary = {
  /** 花费（本会话）: this session only, keeps 加载失败 / （不完整） visibility. */
  session: () => string | null
  /** 花费（子代理）: descendant sessions only; null while any is still loading. */
  subagent: () => string | null
  /** 花费（任务树合计）: whole task tree, root session included. */
  tree: () => string | null
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
 * @param tick accessor read for re-render; cost aggregation is poll-driven.
 */
export function createSessionCostSummary(
  context: Context,
  runtime: ReturnType<typeof createV2Metrics>,
  sessionID: string,
  tick: () => void,
): SessionCostSummary {
  const family = createMemo(() => context.data.session.family(sessionID))
  const descendants = createMemo(() => {
    const pending = new Set([sessionID])
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
  const refreshCosts = () => {
    runtime.metrics.refresh(sessionID, { delayMs: 0 })
    for (const id of family()) runtime.metrics.refresh(id, { delayMs: 0 })
  }
  refreshCosts()
  const session = createMemo(() => {
    void tick()
    return formatSessionCost(runtime.metrics.get(sessionID))
  })
  const subagent = createMemo(() => {
    void tick()
    const results = descendants().map((id) => runtime.metrics.get(id))
    if (!results.length || results.some((result) => !result?.complete)) return null
    const used = results.filter((result) => result?.hasUsage)
    if (!used.length) return null
    return formatCostUsd(used.reduce((sum, result) => sum + result!.usd, 0), {
      hasUsage: true,
      partial: used.some((result) => result!.partial),
    })
  })
  const tree = createMemo(() => {
    void tick()
    const rootID = context.data.session.root(sessionID)
    const treeSessions = family().map((id) => runtime.metrics.get(id))
    if (!treeSessions.length || treeSessions.some((result) => !result?.complete)) return null
    const root = runtime.metrics.get(rootID)
    if (!root?.complete) return null
    const all = treeSessions.filter((result) => result !== undefined)
    if (!all.some((result) => result.hasUsage)) return null
    return formatCostUsd(all.reduce((sum, result) => sum + result.usd, 0), {
      hasUsage: true,
      partial: all.some((result) => result.partial),
    })
  })
  return { session, subagent, tree }
}
