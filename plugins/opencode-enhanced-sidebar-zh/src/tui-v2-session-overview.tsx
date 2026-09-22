/** @jsxImportSource @opentui/solid */

import "@opentui/solid/preload"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import {
  cacheHitPercent,
  contextBarCells,
  contextBarTier,
  contextUsagePercent,
  CONTEXT_BAR_CELLS,
  sumContextTokens,
} from "./metrics/session-overview-view.ts"
import { createSessionCostSummary } from "./metrics/session-cost-summary.ts"
import { formatTps } from "./metrics/step-tps.ts"
import { createV2Metrics } from "./v2-runtime.ts"

export function SessionOverview(props: { context: Context; sessionID: string; runtime: ReturnType<typeof createV2Metrics> }) {
  const [tick, setTick] = createSignal(0)
  const [settings, updateSettings] = props.context.storage.store("session-overview-zh-v2", {
    initial: { version: 2, open: true },
  })
  const timer = setInterval(() => setTick((value) => value + 1), 500)
  const unsubscribe = props.runtime.metrics.subscribe(props.sessionID, () => setTick((value) => value + 1))
  const costs = createSessionCostSummary(props.context, props.runtime, props.sessionID, tick)
  onCleanup(() => {
    clearInterval(timer)
    unsubscribe()
  })
  const messages = createMemo(() => {
    void tick()
    return props.context.data.session.message.list(props.sessionID)
  })
  type Message = ReturnType<typeof messages>[number]
  type AssistantMessage = Extract<Message, { type: "assistant" }>
  type AssistantWithTokens = AssistantMessage & { tokens: NonNullable<AssistantMessage["tokens"]> }
  const assistants = createMemo(() => messages().filter(
    (message): message is AssistantWithTokens => message.type === "assistant" && message.tokens !== undefined,
  ))
  const last = createMemo(() => [...assistants()].reverse().find((message) => message.tokens.output > 0))
  const contextLimit = createMemo(() => {
    const model = last()?.model
    if (!model) return
    const location = props.context.location ?? props.context.data.location.default()
    return props.context.data.location.model.list(location)?.find(
      (item) => item.providerID === model.providerID && (item.id === model.id || item.modelID === model.id),
    )?.limit.context
  })
  const contextUsed = createMemo(() => {
    const tokens = last()?.tokens
    return tokens ? sumContextTokens(tokens) : undefined
  })
  const percent = createMemo(() => contextUsagePercent(contextUsed(), contextLimit()))
  const cacheHit = createMemo(() => {
    const totals = assistants().reduce(
      (sum, message) => ({ input: sum.input + message.tokens.input, read: sum.read + message.tokens.cache.read, write: sum.write + message.tokens.cache.write }),
      { input: 0, read: 0, write: 0 },
    )
    return cacheHitPercent(totals)
  })
  const tps = createMemo(() => {
    void tick()
    const streaming = props.runtime.tps.streaming(props.sessionID)
    if (streaming) return `~${formatTps(streaming.tps)} t/s`
    const latest = props.runtime.tps.latest(props.sessionID)
    return latest ? `${formatTps(latest.tps)} t/s` : "—"
  })
  const theme = props.context.theme
  const contextBarColor = createMemo(() => {
    const tier = contextBarTier(percent())
    if (tier === "danger") return theme.text.feedback.error.base
    if (tier === "warning") return theme.text.feedback.warning.base
    return theme.hue?.interactive?.[300] ?? theme.text.action.primary.base
  })
  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1} onMouseDown={() => void updateSettings((draft) => { draft.open = !draft.open })}>
        <text fg={theme.text.action.primary.base}>{settings.open ? "▼" : "▶"}</text><text fg={theme.text.action.primary.base}><b>上下文</b></text>
      </box>
      <Show when={settings.open}>
        <Show when={percent() !== undefined}>
          <box flexDirection="row" justifyContent="space-between"><text fg={theme.text.muted}>使用率</text><text fg={theme.text.base}>{contextUsed()!.toLocaleString()} / {contextLimit()!.toLocaleString()} · {percent()}%</text></box>
          <box flexDirection="row"><text fg={contextBarColor()}>{"█".repeat(contextBarCells(percent()))}</text><text fg={theme.text.muted}>{"░".repeat(CONTEXT_BAR_CELLS - contextBarCells(percent()))}</text></box>
        </Show>
        <Show when={cacheHit() !== undefined}><box flexDirection="row" justifyContent="space-between"><text fg={theme.text.muted}>缓存命中</text><text fg={theme.text.base}>{cacheHit()}%</text></box></Show>
        <box flexDirection="row" justifyContent="space-between"><text fg={theme.text.muted}>TPS</text><text fg={tps().startsWith("~") ? theme.text.muted : theme.text.base}>{tps()}</text></box>
        <Show when={costs.session()}><box flexDirection="row" justifyContent="space-between"><text fg={theme.text.muted}>花费（本会话）</text><text fg={theme.text.base}>{costs.session()}</text></box></Show>
        <Show when={costs.subagent()}><box flexDirection="row" justifyContent="space-between"><text fg={theme.text.muted}>花费（子代理）</text><text fg={theme.text.action.primary.base}>{costs.subagent()}</text></box></Show>
        <Show when={costs.tree()}><box flexDirection="row" justifyContent="space-between"><text fg={theme.text.muted}>花费（任务树合计）</text><text fg={theme.text.action.primary.base}>{costs.tree()}</text></box></Show>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "opencode-session-overview-zh",
  setup(context) {
    const runtime = createV2Metrics(context)
    const disposeSlot = context.ui.slot({ append: "sidebar.content", render: (props) => <SessionOverview context={context} sessionID={props.sessionID} runtime={runtime} /> })
    return () => { disposeSlot(); runtime.dispose() }
  },
})
