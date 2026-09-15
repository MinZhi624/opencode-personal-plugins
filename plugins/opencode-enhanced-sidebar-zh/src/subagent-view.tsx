/** @jsxImportSource @opentui/solid */

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { SessionMetricsService } from "./metrics/session-metrics.ts"
import { formatCostUsd } from "./metrics/token-cost.ts"
import {
  SubAgentPanel,
  createSubAgentSignals,
  type SubAgentCostSummary,
  type SharedSignals,
} from "./subagent-magazine.tsx"

export function SubAgentView(props: {
  api: TuiPluginApi
  sessionId: string
  metrics: SessionMetricsService
  signals?: SharedSignals
}) {
  const signals = props.signals ?? createSubAgentSignals(props.api)
  const [costTick, setCostTick] = createSignal(0)
  const [subagentCost, setSubagentCost] = createSignal<SubAgentCostSummary>({
    usd: 0,
    hasUsage: false,
    partial: false,
    complete: true,
  })

  createEffect(() => {
    const unsubscribe = props.metrics.subscribe(props.sessionId, () => setCostTick((value) => value + 1))
    onCleanup(unsubscribe)
  })
  createEffect(() => props.metrics.refresh(props.sessionId, { delayMs: 0 }))

  const taskTreeCost = createMemo(() => {
    void costTick()
    const own = props.metrics.get(props.sessionId)
    const children = subagentCost()
    if (!own?.complete || !own.hasUsage || !children.complete || !children.hasUsage) return null
    return formatCostUsd(own.usd + children.usd, {
      hasUsage: true,
      partial: own.partial || children.partial,
    })
  })

  return (
    <SubAgentPanel
      theme={props.api.theme.current}
      api={props.api}
      lang={signals.lang}
      maxEntries={signals.maxEntries}
      sortOrder={signals.sortOrder}
      scrollMode={signals.scrollMode}
      ttlDays={signals.ttlDays}
      sessionId={props.sessionId}
      metrics={props.metrics}
      onCostSummary={setSubagentCost}
      taskTreeCost={taskTreeCost}
    />
  )
}
