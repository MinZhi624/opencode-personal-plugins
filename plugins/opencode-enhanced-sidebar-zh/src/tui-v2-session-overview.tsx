/** @jsxImportSource @opentui/solid */

import "@opentui/solid/preload"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { formatCostUsd } from "./metrics/token-cost.ts"
import { formatTps } from "./metrics/step-tps.ts"
import { createV2Metrics } from "./v2-runtime.ts"

export function SessionOverview(props: { context: Context; sessionID: string; runtime: ReturnType<typeof createV2Metrics> }) {
  const [tick, setTick] = createSignal(0)
  const [settings, updateSettings] = props.context.storage.store("session-overview-zh-v2", {
    initial: { version: 2, open: true },
  })
  const timer = setInterval(() => setTick((value) => value + 1), 1000)
  const unsubscribe = props.runtime.metrics.subscribe(props.sessionID, () => setTick((value) => value + 1))
  props.runtime.metrics.refresh(props.sessionID, { delayMs: 0 })
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
    return tokens ? tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write : undefined
  })
  const percent = createMemo(() => contextLimit() && contextUsed() !== undefined ? Math.round(contextUsed()! / contextLimit()! * 100) : undefined)
  const cacheHit = createMemo(() => {
    const totals = assistants().reduce(
      (sum, message) => ({ input: sum.input + message.tokens.input, read: sum.read + message.tokens.cache.read, write: sum.write + message.tokens.cache.write }),
      { input: 0, read: 0, write: 0 },
    )
    const denominator = totals.input + totals.read + totals.write
    return denominator ? Math.round(totals.read / denominator * 100) : undefined
  })
  const tps = createMemo(() => {
    void tick()
    const streaming = props.runtime.tps.streaming(props.sessionID)
    if (streaming) return `~${formatTps(streaming.tps)} t/s`
    const latest = props.runtime.tps.latest(props.sessionID)
    return latest ? `${formatTps(latest.tps)} t/s` : "—"
  })
  const cost = createMemo(() => {
    void tick()
    const result = props.runtime.metrics.get(props.sessionID)
    return result?.complete && result.hasUsage ? formatCostUsd(result.usd, result) : undefined
  })
  const theme = props.context.theme
  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1} onMouseDown={() => void updateSettings((draft) => { draft.open = !draft.open })}>
        <text fg={theme.text.action.primary.base}>{settings.open ? "▼" : "▶"}</text><text fg={theme.text.action.primary.base}><b>上下文</b></text>
      </box>
      <Show when={settings.open}>
        <Show when={percent() !== undefined}>
          <box flexDirection="row" justifyContent="space-between"><text fg={theme.text.muted}>使用率</text><text fg={theme.text.feedback.success.base}>{contextUsed()!.toLocaleString()} / {contextLimit()!.toLocaleString()} · {percent()}%</text></box>
          <box flexDirection="row"><text fg={theme.text.action.primary.base}>{"█".repeat(Math.min(20, Math.round(percent()! / 5)))}</text><text fg={theme.text.muted}>{"░".repeat(Math.max(0, 20 - Math.round(percent()! / 5)))}</text></box>
        </Show>
        <Show when={cacheHit() !== undefined}><box flexDirection="row" justifyContent="space-between"><text fg={theme.text.muted}>缓存命中</text><text fg={theme.text.feedback.success.base}>{cacheHit()}%</text></box></Show>
        <box flexDirection="row" justifyContent="space-between"><text fg={theme.text.muted}>TPS</text><text fg={tps().startsWith("~") ? theme.text.feedback.warning.base : theme.text.feedback.success.base}>{tps()}</text></box>
        <Show when={cost()}><box flexDirection="row" justifyContent="space-between"><text fg={theme.text.muted}>API 标价估算（本会话）</text><text fg={theme.text.action.primary.base}>{cost()}</text></box></Show>
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
