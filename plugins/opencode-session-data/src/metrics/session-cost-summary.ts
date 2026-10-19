import { createEffect, createMemo, onCleanup } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import type { SessionMetricsService } from "./session-metrics.ts"
import { formatCompactCostUsd, formatCostUsd } from "./token-cost.ts"
import { formatSessionCost } from "./session-overview-view.ts"
import { totalTokenBuckets } from "./token-buckets.ts"
import type { SessionUsageCost, SessionUsageReport } from "./quota-usage-rpc.ts"

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

/** Shared shape of every readiness answer the panel renders. */
type CostStatus = "loading" | "failed" | "incomplete" | "stale" | "ready"

/**
 * The three cost surfaces of one session, all read from ONE server report per
 * surface: the v6 usage engine's answer behind the quota plugin's
 * `sessionUsage` RPC (see ./quota-usage-rpc.ts).
 *
 * - `session` is the requested session's `own` cost;
 * - `subagent` is the current session's report `bySession`, itself excluded;
 * - `tree` is the ROOT report's own `tree` total, taken as the engine computed
 *   it, and the descendant list is that report's `sessionIDs`.
 *
 * So every number of one surface comes from a single report at a single data
 * point and a single price snapshot: nothing is stitched together across
 * reports or price generations, and a locally known-but-unread session never
 * stands in for a total. A surface stays null while its report is missing or
 * incomplete, so a partial sum is never rendered as a total; unknown prices
 * render 未定价 via formatCostUsd, never $0; a failed read never fabricates a
 * zero — it shows 加载失败, or （旧数据） when the last complete report is
 * being kept after a failed refresh. The amount strings carry that （旧数据）
 * marker themselves, so a row rendered without a status beside it still says
 * its numbers are old, and a surface whose report never arrived falls back to
 * the cached per-session results so a failure reads as failed rather than as
 * an eternal "loading".
 *
 * The tree surfaces additionally validate the root report before trusting it:
 * it must be the report requested for the root and must have read the root.
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
  // not itself be reactive. Suppress unchanged sets so the refreshes below do
  // not refetch every session on each display tick. The client-side family is
  // used ONLY to notice that the tree changed; its numbers are never summed.
  const family = createMemo(() => {
    void tick()
    return context.data.session.family(sessionID())
  }, undefined, { equals: (a, b) => a.length === b.length && a.every((id) => b.includes(id)) })
  // Root identity stays a client fact (the TUI knows the parent chain); every
  // tree NUMBER comes from the root's report, not from this local view.
  const rootID = createMemo(() => {
    void tick()
    return context.data.session.root(sessionID())
  })
  // One report per requested session: the current session's own subtree, and
  // the root's whole tree. `undefined` means "not answered yet" — never a
  // fabricated zero.
  const rootReport = createMemo(() => {
    void tick()
    return runtime.metrics.getUsageReport(rootID())
  })
  const sessionReport = createMemo(() => {
    void tick()
    return runtime.metrics.getUsageReport(sessionID())
  })
  /**
   * The root's report, validated before any tree surface trusts it: it must be
   * the report requested FOR the root, and that report must really have read
   * the root. A tree resolved without its own root (an empty or foreign
   * membership) must never pass as a complete total.
   */
  const validRootReport = createMemo(() => {
    void tick()
    const report = rootReport()
    if (!report) return undefined
    const root = rootID()
    if (report.sessionID !== root) return undefined
    if (!report.sessionIDs.includes(root)) return undefined
    return report
  })
  // A family change (a subagent appeared or vanished) is the trigger to
  // re-request: the current session's report plus the root's, whose tree
  // totals the panel shows. The remaining members are refreshed too, because
  // hosts render per-session own costs from their reports.
  //
  // The same effect holds the active-reader subscriptions for the two
  // reports every tree surface reads: the current session's and the root's.
  // The bounded report cache in session-metrics.ts evicts the oldest entry
  // past its target and only pins the session of the transaction in flight,
  // so a later child request completing after this one could otherwise evict
  // the root report that is on screen — the family set did not change, so
  // nothing would re-request it and the tree would stick on loading. A live
  // subscription is exactly the "someone is displaying this" signal that
  // eviction now respects. The listener is a presence marker (noop): the
  // display re-renders through `tick`, not through these notifications.
  //
  // The family is deliberately NOT subscribed: those sessions are refreshed
  // for their hosts' cards, and pinning the whole family would replace the
  // bound with a no-op instead of protecting the visible views.
  //
  // `onCleanup` runs before the next effect run (session or root switch —
  // the old subscription is dropped, the new one held) and on unmount, so
  // the protection lasts exactly as long as the view reading the report;
  // after it the next cache write reclaims the entry normally.
  createEffect(() => {
    const currentID = sessionID()
    const root = rootID()
    const unsubscribeCurrent = runtime.metrics.subscribe(currentID, () => {})
    const unsubscribeRoot = runtime.metrics.subscribe(root, () => {})
    onCleanup(() => {
      unsubscribeCurrent()
      unsubscribeRoot()
    })
    runtime.metrics.refresh(currentID, { delayMs: 0 })
    runtime.metrics.refresh(root, { delayMs: 0 })
    for (const id of family()) {
      if (id !== currentID && id !== root) runtime.metrics.refresh(id, { delayMs: 0 })
    }
  })
  /** One session's cost inside one report; `own` for the requested session. */
  const costIn = (report: SessionUsageReport, id: string): SessionUsageCost | undefined =>
    id === report.sessionID ? report.own : report.bySession[id]
  /**
   * Sum costs of one report. Every listed session must have been read by that
   * very report and read completely: a session it did not cover blocks the
   * total instead of being skipped, so an unread member can never silently
   * shrink a sum.
   */
  const sumCost = (report: SessionUsageReport, ids: readonly string[], compact = false): string | null => {
    const costs = ids.map((id) => costIn(report, id))
    if (!costs.length) return null
    if (costs.some((cost) => !cost || !cost.complete)) return null
    const used = costs.filter((cost): cost is SessionUsageCost => cost.hasUsage)
    if (!used.length) return null
    const amount = used.reduce((sum, cost) => sum + cost.usd, 0)
    const options = {
      hasUsage: true,
      partial: used.some((cost) => cost.partial),
    }
    return compact ? formatCompactCostUsd(amount, options) : formatCostUsd(amount, options)
  }
  const sumTokens = (report: SessionUsageReport, ids: readonly string[]): number | null => {
    const costs = ids.map((id) => costIn(report, id))
    if (costs.some((cost) => !cost || !cost.complete)) return null
    return costs.reduce((sum, cost) => sum + totalTokenBuckets(cost.tokens), 0)
  }
  /** A report whose refresh failed: what is on screen are its last numbers. */
  const isStaleReport = (report: SessionUsageReport | undefined): boolean =>
    report !== undefined && runtime.metrics.isStale(report.sessionID)
  /** Keep a rendered amount honest about belonging to an older report. */
  const withStale = (text: string | null, stale: boolean): string | null =>
    text === null ? null : stale ? `${text}（旧数据）` : text
  /**
   * Amount text when no report arrived: a read that failed says 加载失败 —
   * never $0, and never a null the panel would render as "still loading".
   * Anything else stays null so the panel keeps its loading state.
   */
  const failedText = (ids: readonly string[]): string | null =>
    ids.some((id) => {
      const result = runtime.metrics.get(id)
      return result?.error && result.error !== "truncated"
    })
      ? "加载失败"
      : null
  /** Readiness from the cached per-session results, for when no report arrived. */
  const resultStatus = (ids: readonly string[]): CostStatus => {
    // Without a report the member list is unknown too, so an empty one means
    // "not answered yet", not "nothing left to load".
    if (!ids.length) return "loading"
    const results = ids.map((id) => runtime.metrics.get(id))
    if (results.some((result) => result?.error && result.error !== "truncated")) return "failed"
    if (results.some((result) => result && !result.complete)) return "incomplete"
    if (results.some((result) => !result)) return "loading"
    if (ids.some((id) => runtime.metrics.isStale(id))) return "stale"
    return "ready"
  }
  /**
   * Readiness of the sessions one report covers. The staleness that counts is
   * the one of the session the report was REQUESTED for: when that refresh
   * failed the whole report is old, even though the members' own reads may
   * still have succeeded — so a child's fresh result must never make the tree
   * look current. Statuses are never stitched across two reports.
   */
  const statusOf = (report: SessionUsageReport | undefined, ids: readonly string[]): CostStatus => {
    if (!report) return resultStatus(ids)
    const costs = ids.map((id) => costIn(report, id))
    if (costs.some((cost) => !cost)) return "loading"
    if (costs.some((cost) => cost.error && cost.error !== "truncated")) return "failed"
    if (costs.some((cost) => !cost.complete)) return "incomplete"
    if (runtime.metrics.isStale(report.sessionID)) return "stale"
    return "ready"
  }
  const session = createMemo(() => {
    void tick()
    return withStale(
      formatSessionCost(runtime.metrics.get(sessionID())),
      runtime.metrics.isStale(sessionID()),
    )
  })
  const subagent = createMemo(() => {
    void tick()
    const report = sessionReport()
    if (!report) return failedText([sessionID()])
    const own = sessionID()
    return withStale(
      sumCost(report, Object.keys(report.bySession).filter((id) => id !== own)),
      isStaleReport(report),
    )
  })
  // The tree total is the root report's own total — never re-added here, and
  // never mixed with a different report's or price generation's members.
  const tree = createMemo(() => {
    void tick()
    const report = validRootReport()
    if (!report) return failedText([rootID()])
    const cost = report.tree
    if (!cost.complete || !cost.hasUsage) return null
    return withStale(
      formatCostUsd(cost.usd, { hasUsage: true, partial: cost.partial }),
      isStaleReport(report),
    )
  })
  const treeTokens = createMemo(() => {
    void tick()
    const cost = validRootReport()?.tree
    if (!cost || !cost.complete) return null
    return totalTokenBuckets(cost.tokens)
  })
  const treeTokenStatus = createMemo(() => {
    void tick()
    const report = validRootReport()
    if (!report) return resultStatus([rootID()])
    const cost = report.tree
    if (cost.error && cost.error !== "truncated") return "failed" as CostStatus
    if (!cost.complete) return "incomplete" as CostStatus
    if (runtime.metrics.isStale(report.sessionID)) return "stale" as CostStatus
    return "ready" as CostStatus
  })
  // The descendants are the ones the root report really read — which can be
  // more (or, while it is still loading, fewer) than the client family knows.
  const descendantIDs = createMemo(() => {
    void tick()
    const report = validRootReport()
    if (!report) return []
    return report.sessionIDs.filter((id) => id !== rootID())
  })
  const descendantCount = createMemo(() => descendantIDs().length)
  const descendantTokens = createMemo(() => {
    void tick()
    const report = validRootReport()
    if (!report) return null
    return sumTokens(report, descendantIDs())
  })
  // The marker is deliberately NOT added here: this amount's only consumer
  // (the subagent magazine) already labels it from `descendantTokenStatus`,
  // and two markers on one row would read as a bug.
  const descendantCost = createMemo(() => {
    void tick()
    const report = validRootReport()
    if (!report) return failedText([rootID()])
    return sumCost(report, descendantIDs(), true)
  })
  const descendantTokenStatus = createMemo(() => {
    void tick()
    // The report first: without it the member list is unknown, so the ROOT's
    // own result decides — the same failure / not-ready answer
    // treeTokenStatus gives, instead of an eternal "loading" on an empty set.
    const report = validRootReport()
    if (!report) return resultStatus([rootID()])
    return statusOf(report, descendantIDs())
  })
  return { session, subagent, tree, treeTokens, treeTokenStatus, rootID, descendantIDs, descendantCount, descendantTokens, descendantTokenStatus, descendantCost }
}
