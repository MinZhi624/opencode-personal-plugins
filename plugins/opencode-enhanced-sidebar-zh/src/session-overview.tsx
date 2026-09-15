/** @jsxImportSource @opentui/solid */

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import type { SessionMetricsService } from "./metrics/session-metrics.ts"
import { formatCostUsd } from "./metrics/token-cost.ts"
import { formatTps, type StepTpsTracker } from "./metrics/step-tps.ts"

const n = (value: number) => value.toLocaleString()

function Bar(props: { pct: () => number; fg: string; bg: string }) {
  const filled = createMemo(() => Math.min(Math.round((props.pct() / 100) * 20), 20))
  return (
    <text>
      <span style={{ fg: props.fg }}>{"█".repeat(filled())}</span>
      <span style={{ fg: props.bg }}>{"░".repeat(Math.max(20 - filled(), 0))}</span>
    </text>
  )
}

export function SessionOverview(props: {
  api: TuiPluginApi
  sessionId: string
  metrics: SessionMetricsService
  tps: StepTpsTracker
}) {
  const theme = () => props.api.theme.current
  const t = theme()
  const [contextTick, setContextTick] = createSignal(0)
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  createEffect(() => {
    const sessionId = props.sessionId
    setContextTick((value) => value + 1)
    const scheduleRefresh = () => {
      if (idleTimer !== null) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => setContextTick((value) => value + 1), 150)
    }
    const unsubIdle = props.api.event.on("session.idle", (event) => {
      if (event.properties.sessionID === sessionId) scheduleRefresh()
    })
    const unsubError = props.api.event.on("session.error", (event) => {
      if (event.properties.sessionID === sessionId) scheduleRefresh()
    })
    onCleanup(() => {
      unsubIdle()
      unsubError()
      if (idleTimer !== null) clearTimeout(idleTimer)
      idleTimer = null
    })
  })

  const messages = createMemo(() => {
    void contextTick()
    const snapshot = props.api.state.session.messages(props.sessionId)
    return snapshot ? Array.from(snapshot) : snapshot
  })
  const last = createMemo(() => {
    for (let index = messages().length - 1; index >= 0; index--) {
      const message = messages()[index]
      if (message.role !== "assistant") continue
      const tokens = (message as Record<string, unknown>).tokens as Record<string, unknown> | undefined
      if (tokens && typeof tokens.output === "number" && tokens.output > 0) {
        return message as Record<string, unknown>
      }
    }
    return null
  })
  const stats = createMemo(() => {
    let input = 0
    let output = 0
    let reasoning = 0
    let cacheRead = 0
    let cacheWrite = 0
    for (const message of messages()) {
      if (message.role !== "assistant") continue
      const tokens = (message as Record<string, unknown>).tokens as Record<string, unknown> | undefined
      const cache = tokens?.cache as Record<string, unknown> | undefined
      input += (tokens?.input as number) || 0
      output += (tokens?.output as number) || 0
      reasoning += (tokens?.reasoning as number) || 0
      cacheRead += (cache?.read as number) || 0
      cacheWrite += (cache?.write as number) || 0
    }
    return { input, output, reasoning, cacheRead, cacheWrite }
  })
  const lastTokens = createMemo(() => {
    const message = last()
    if (!message) return null
    const tokens = message.tokens as Record<string, unknown>
    const cache = tokens.cache as Record<string, unknown> | undefined
    return {
      input: (tokens.input as number) || 0,
      output: (tokens.output as number) || 0,
      reasoning: (tokens.reasoning as number) || 0,
      cacheRead: (cache?.read as number) || 0,
      cacheWrite: (cache?.write as number) || 0,
    }
  })
  const contextLimit = createMemo(() => {
    const message = last()
    if (!message) return null
    return props.api.state.provider.find((provider) => provider.id === message.providerID)
      ?.models[message.modelID as string]?.limit?.context ?? null
  })
  const contextUsed = createMemo(() => {
    const tokens = lastTokens()
    return tokens
      ? tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite
      : null
  })
  const contextPct = createMemo(() => {
    const limit = contextLimit()
    const used = contextUsed()
    return limit && used !== null ? Math.round((used / limit) * 100) : null
  })
  const cacheEfficiency = createMemo(() => {
    const value = stats()
    const denominator = value.input + value.cacheRead + value.cacheWrite
    return denominator > 0 ? ((value.cacheRead / denominator) * 100).toFixed(0) : null
  })

  const [costTick, setCostTick] = createSignal(0)
  createEffect(() => {
    const unsubscribe = props.metrics.subscribe(props.sessionId, () => setCostTick((value) => value + 1))
    onCleanup(unsubscribe)
  })
  createEffect(() => props.metrics.refresh(props.sessionId, { delayMs: 0 }))
  const sessionCost = createMemo(() => {
    void costTick()
    const result = props.metrics.get(props.sessionId)
    if (!result?.complete || !result.hasUsage) return null
    return formatCostUsd(result.usd, { hasUsage: result.hasUsage, partial: result.partial })
  })

  const [tpsTick, setTpsTick] = createSignal(0)
  const [streamTick, setStreamTick] = createSignal(Date.now())
  const [streamingActive, setStreamingActive] = createSignal(false)
  createEffect(() => {
    const unsubscribe = props.tps.subscribe(props.sessionId, () => setTpsTick((value) => value + 1))
    onCleanup(unsubscribe)
  })
  createEffect(() => {
    void tpsTick()
    setStreamingActive(props.tps.hasStreamingStep(props.sessionId))
  })
  createEffect(() => {
    if (!streamingActive()) return
    const timer = setInterval(() => setStreamTick(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  const tpsDisplay = createMemo(() => {
    void tpsTick()
    const streaming = props.tps.streaming(props.sessionId, streamTick())
    if (streaming) {
      const text = formatTps(streaming.tps)
      return text ? { text: `~${text} t/s`, estimated: true } : { text: "…", estimated: true }
    }
    if (props.tps.hasStreamingStep(props.sessionId)) return { text: "…", estimated: true }
    const step = props.tps.latest(props.sessionId)
    const text = step ? formatTps(step.tps) : null
    return text ? { text: `${text} t/s`, estimated: false } : { text: "—", estimated: true }
  })

  const [open, setOpen] = createSignal(true)
  return (
    <box>
      <box flexDirection="row" gap={1} onMouseDown={() => setOpen((value) => !value)}>
        <text fg={t.text}>{open() ? "▼" : "▶"}</text>
        <text fg={t.text}><b>上下文</b></text>
      </box>
      <Show when={open()}>
        <Show when={contextPct() !== null}>
          <box>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={t.textMuted}>使用率</text>
              <text fg={t.text}>{n(contextUsed()!)} / {n(contextLimit()!)} · {contextPct()}%</text>
            </box>
            <Bar
              pct={() => Math.min(contextPct() ?? 0, 100)}
              fg={String(contextPct()! > 95 ? t.error : contextPct()! > 80 ? t.warning : t.primary)}
              bg={String(t.textMuted)}
            />
          </box>
        </Show>
        <Show when={cacheEfficiency() !== null}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={t.textMuted}>缓存命中</text>
            <text fg={t.text}>{cacheEfficiency()}%</text>
          </box>
        </Show>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={t.textMuted}>TPS</text>
          <text fg={tpsDisplay().estimated ? t.textMuted : t.text}>{tpsDisplay().text}</text>
        </box>
        <Show when={sessionCost() !== null}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={t.textMuted}>花费（本会话）</text>
            <text fg={t.text}>{sessionCost()}</text>
          </box>
        </Show>
      </Show>
    </box>
  )
}
