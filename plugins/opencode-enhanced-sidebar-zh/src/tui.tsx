import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, createEffect, Show, onCleanup } from "solid-js"
import { SubAgentPanel, createSubAgentSignals, type SubAgentCostSummary } from "./subagent-magazine"
import {
  SessionMetricsService,
  createClientPageFetcher,
  type SessionMessagesClientLike,
} from "./metrics/session-metrics.ts"
import { StepTpsTracker, formatTps } from "./metrics/step-tps.ts"
import { formatCostUsd } from "./metrics/token-cost.ts"
import { maybeRefreshPricingSnapshot } from "./metrics/pricing.ts"

const id = "opencode-enhanced-sidebar-zh"

const n = (v: number) => v.toLocaleString()

function Bar(props: { pct: number; fg: string; bg: string }) {
  const filled = Math.min(Math.round((props.pct / 100) * 20), 20)
  return (
    <text>
      <span style={{ fg: props.fg }}>{"█".repeat(filled)}</span>
      <span style={{ fg: props.bg }}>{"░".repeat(Math.max(20 - filled, 0))}</span>
    </text>
  )
}

interface ViewProps {
  api: TuiPluginApi
  session_id: string
  metrics: SessionMetricsService
  tps: StepTpsTracker
}

function View(props: ViewProps) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const t = theme()

  const last = createMemo(() => {
    for (let i = msg().length - 1; i >= 0; i--) {
      const m = msg()[i]
      if (m.role !== "assistant") continue
      const tk = (m as Record<string, unknown>).tokens as Record<string, unknown> | undefined
      if (tk && typeof tk.output === "number" && tk.output > 0) return m as Record<string, unknown>
    }
    return null
  })

  // ——— stats ———
  const stats = createMemo(() => {
    let out = 0, rsn = 0, cacheR = 0, cacheW = 0, input = 0
    for (const m of msg()) {
      if (m.role !== "assistant") continue
      const tk = (m as Record<string, unknown>).tokens as Record<string, unknown> | undefined
      input += (tk?.input as number) || 0; out += (tk?.output as number) || 0; rsn += (tk?.reasoning as number) || 0
      const cache = tk?.cache as Record<string, unknown> | undefined
      cacheR += (cache?.read as number) || 0; cacheW += (cache?.write as number) || 0
    }
    return { out, rsn, cacheR, cacheW, input }
  })

  const lastTokens = createMemo(() => {
    const m = last(); if (!m) return null
    const tk = m.tokens as Record<string, unknown>; const cache = tk.cache as Record<string, unknown> | undefined
    return { input: (tk.input as number) || 0, output: (tk.output as number) || 0, reasoning: (tk.reasoning as number) || 0, cacheR: (cache?.read as number) || 0, cacheW: (cache?.write as number) || 0 }
  })

  const ctxLimit = createMemo(() => {
    const m = last(); if (!m) return null
    return props.api.state.provider.find((x) => x.id === (m.providerID as string))?.models[m.modelID as string]?.limit?.context ?? null
  })
  const ctxPct = createMemo(() => {
    const limit = ctxLimit(); const lt = lastTokens()
    return (limit && lt) ? Math.round(((lt.input + lt.output + lt.reasoning + lt.cacheR + lt.cacheW) / limit) * 100) : null
  })
  const ctxUsed = createMemo(() => {
    const lt = lastTokens()
    return lt ? lt.input + lt.output + lt.reasoning + lt.cacheR + lt.cacheW : null
  })
  const cacheEfficiency = createMemo(() => {
    const s = stats(); const d = s.input + s.cacheR + s.cacheW; return d > 0 ? ((s.cacheR / d) * 100).toFixed(0) : null
  })
  const risk = createMemo(() => {
    const ctx = ctxPct(); const lt = lastTokens()
    if (ctx === null || !lt || lt.output === 0) return null
    const cur = lt.reasoning / lt.output; const avg = stats().out > 0 ? stats().rsn / stats().out : cur
    if (ctx > 90) return { level: "high", fg: t.error }
    if (ctx > 75 && cur < avg * 0.4) return { level: "medium", fg: t.warning }
    if (ctx > 60 && cur < avg * 0.2) return { level: "low", fg: t.textMuted }
    return null
  })

  // ——— session cost (shared metrics service; full paginated session) ———
  const [costTick, setCostTick] = createSignal(0)
  const [subagentCost, setSubagentCost] = createSignal<SubAgentCostSummary>({
    usd: 0,
    hasUsage: false,
    partial: false,
    complete: true,
  })
  createEffect(() => {
    const sid = props.session_id
    const unsub = props.metrics.subscribe(sid, () => setCostTick((v) => v + 1))
    onCleanup(unsub)
  })
  // First mount and every session_id switch: compute the full-session cost
  // immediately so the row appears without waiting for a message event.
  // Depends only on props.session_id (never on the result), so refresh()
  // cannot feed back into this effect — no refresh loop.
  createEffect(() => {
    props.metrics.refresh(props.session_id, { delayMs: 0 })
  })
  const sessionCostResult = createMemo(() => {
    void costTick()
    const res = props.metrics.get(props.session_id)
    return res && res.complete && res.hasUsage ? res : null
  })
  const sessionCost = createMemo(() => {
    const res = sessionCostResult()
    if (!res) return null
    return formatCostUsd(res.usd, { hasUsage: res.hasUsage, partial: res.partial })
  })
  const subagentCostText = createMemo(() => {
    const summary = subagentCost()
    if (!summary.complete || !summary.hasUsage) return null
    return formatCostUsd(summary.usd, { hasUsage: summary.hasUsage, partial: summary.partial })
  })
  const taskTreeCost = createMemo(() => {
    const own = sessionCostResult()
    const children = subagentCost()
    if (!own || !children.complete || !children.hasUsage) return null
    return formatCostUsd(own.usd + children.usd, {
      hasUsage: true,
      partial: own.partial || children.partial,
    })
  })

  // ——— step TPS (shared realtime tracker; latest fully observed step) ———
  const [tpsTick, setTpsTick] = createSignal(0)
  const [streamTick, setStreamTick] = createSignal(Date.now())
  const [streamingActive, setStreamingActive] = createSignal(false)
  createEffect(() => {
    const sid = props.session_id
    const unsub = props.tps.subscribe(sid, () => setTpsTick((v) => v + 1))
    onCleanup(unsub)
  })
  createEffect(() => {
    void tpsTick()
    setStreamingActive(props.tps.hasStreamingStep(props.session_id))
  })
  createEffect(() => {
    if (!streamingActive()) return
    const timer = setInterval(() => setStreamTick(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  const tpsDisplay = createMemo(() => {
    void tpsTick()
    const streaming = props.tps.streaming(props.session_id, streamTick())
    if (streaming) {
      const text = formatTps(streaming.tps)
      return text ? { text: `~${text} t/s`, estimated: true } : { text: "…", estimated: true }
    }
    if (props.tps.hasStreamingStep(props.session_id)) return { text: "…", estimated: true }
    const step = props.tps.latest(props.session_id)
    const text = step ? formatTps(step.tps) : null
    return text ? { text: `${text} t/s`, estimated: false } : { text: "—", estimated: true }
  })

  const [show1, set1] = createSignal(true)
  const subagentSignals = createSubAgentSignals(props.api)

  return (
    <box gap={1}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => set1((x) => !x)}>
          <text fg={t.text}>{show1() ? "▼" : "▶"}</text>
          <text fg={t.text}><b>上下文</b></text>
          <Show when={risk()} fallback={<text fg={t.textMuted}>[安全]</text>}>
            {(r) => <text fg={r().fg}>[{r().level === "high" ? "高风险" : r().level === "medium" ? "风险" : "低风险"}]</text>}
          </Show>
        </box>
        <Show when={show1()}>
          <Show when={ctxPct() !== null}>
            <box>
              <box flexDirection="row" justifyContent="space-between">
                <text fg={t.textMuted}>使用率</text>
                <text fg={t.text}>{n(ctxUsed()!)} / {n(ctxLimit()!)} · {ctxPct()}%</text>
              </box>
              <Bar pct={Math.min(ctxPct()!, 100)} fg={String(ctxPct()! > 95 ? t.error : ctxPct()! > 80 ? t.warning : t.primary)} bg={String(t.textMuted)} />
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
          <Show when={subagentCostText() !== null}>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={t.textMuted}>花费（子代理）</text>
              <text fg={t.text}>{subagentCostText()}</text>
            </box>
          </Show>
          <Show when={taskTreeCost() !== null}>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={t.textMuted}>花费（任务树合计）</text>
              <text fg={t.text}>{taskTreeCost()}</text>
            </box>
          </Show>
        </Show>
      </box>

      <SubAgentPanel
        theme={t}
        api={props.api}
        lang={subagentSignals.lang}
        maxEntries={subagentSignals.maxEntries}
        sortOrder={subagentSignals.sortOrder}
        scrollMode={subagentSignals.scrollMode}
        sessionId={props.session_id}
        metrics={props.metrics}
        onCostSummary={setSubagentCost}
      />

    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  // Shared session metrics service + TPS tracker: created once at plugin
  // registration, cleaned up on plugin disposal.
  const metrics = new SessionMetricsService({
    fetchPage: createClientPageFetcher(api.client as unknown as SessionMessagesClientLike),
    debounceMs: 120,
    pageSize: 10000,
    maxPages: 30,
  })
  const tps = new StepTpsTracker()

  // Best-effort pricing refresh; failures keep the bundled snapshot.
  void maybeRefreshPricingSnapshot().catch(() => {})

  const unsubPart = api.event.on("message.part.updated", (e) => {
    tps.handlePartUpdated(e.properties.sessionID, e.properties.part, e.properties.time)
    if (e.properties.part.type === "step-finish") metrics.refresh(e.properties.sessionID)
  })
  const unsubDelta = api.event.on("message.part.delta", (e) => {
    tps.handlePartDelta(
      e.properties.sessionID,
      e.properties.messageID,
      e.properties.field,
      e.properties.delta,
    )
  })
  const unsubMsg = api.event.on("message.updated", (e) => {
    metrics.refresh(e.properties.sessionID)
  })
  const unsubRemoved = api.event.on("message.removed", (e) => {
    metrics.refresh(e.properties.sessionID)
  })
  const unsubIdle = api.event.on("session.idle", (e) => {
    tps.abortSession(e.properties.sessionID)
    // short delay so the final token write lands before aggregation
    metrics.refresh(e.properties.sessionID, { delayMs: 150 })
  })
  const unsubError = api.event.on("session.error", (e) => {
    const sid = e.properties.sessionID
    tps.abortSession(sid)
    if (sid) metrics.refresh(sid, { delayMs: 150 })
  })

  api.lifecycle.onDispose(() => {
    unsubPart()
    unsubDelta()
    unsubMsg()
    unsubRemoved()
    unsubIdle()
    unsubError()
    metrics.dispose()
  })

  api.slots.register({ order: 60, slots: { sidebar_content(_ctx, props) { return <View api={api} session_id={props.session_id} metrics={metrics} tps={tps} /> } } })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }
export default plugin
