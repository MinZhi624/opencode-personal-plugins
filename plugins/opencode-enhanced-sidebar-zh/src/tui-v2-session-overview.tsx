/** @jsxImportSource @opentui/solid */

import "@opentui/solid/preload"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import type { JSX } from "@opentui/solid"
import type { BoxRenderable } from "@opentui/core"
import {
  cacheHitPercent,
  contextBarTier,
  contextUsagePercent,
  CONTEXT_BAR_CELLS,
  sumContextTokens,
} from "./metrics/session-overview-view.ts"
import { createSessionCostSummary } from "./metrics/session-cost-summary.ts"
import type { SessionCostSummary } from "./metrics/session-cost-summary.ts"
import { formatTokenCount, totalTokenBuckets } from "./metrics/token-buckets.ts"
import { formatTps } from "./metrics/step-tps.ts"
import { readDisplay, type SessionOverviewDisplay } from "./metrics/session-overview-settings.ts"
import { createV2Metrics } from "./v2-runtime.ts"
import { useCardControlPreview } from "../../opencode-sidebar-host-zh/src/card-controls.ts"
import { sidebarBarParts, useSidebarDisplay } from "../../opencode-sidebar-host-zh/src/presentation.ts"

/** 卡片 ID：与宿主注册、控制窗口字段使用同一个稳定身份。 */
export const SESSION_OVERVIEW_CARD_ID = "sessionOverview"
/** 展开状态的存档键；归属本插件 context，控制窗口只经本模块读写。 */
export const SESSION_OVERVIEW_SETTINGS_KEY = "session-overview-zh-v2"
/** 没有整体／单卡样式覆盖时，上下文条沿用卡片原有形状。 */
const CONTEXT_BAR_FALLBACK_SHAPE = "blocks" as const

/** 统一卡片标题行：箭头 + 粗体标题同一行。 */
function CardTitle(props: { open: boolean; title: string; color: string; toggle: () => void; children?: JSX.Element }) {
  return (
    <box flexDirection="row" gap={1} onMouseDown={props.toggle}>
      <text fg={props.color}>{props.open ? "▼" : "▶"}</text>
      <text fg={props.color}><b>{props.title}</b></text>
      {props.children}
    </box>
  )
}

export function SessionOverview(props: { context: Context; sessionID: string; runtime: ReturnType<typeof createV2Metrics>; summary?: SessionCostSummary }) {
  const [tick, setTick] = createSignal(0)
  const [settings, updateSettings] = props.context.storage.store<{ version: number; open: boolean } & Partial<SessionOverviewDisplay>>(SESSION_OVERVIEW_SETTINGS_KEY, {
    initial: { version: 2, open: true },
  })
  // 统一窗口的预览只覆盖显示，不写存档；点击标题仍是既有的即时保存语义。
  const preview = useCardControlPreview(SESSION_OVERVIEW_CARD_ID)
  const open = () => {
    const value = preview()?.open
    return typeof value === "boolean" ? value : settings.open !== false
  }
  const display = createMemo<SessionOverviewDisplay>(() => {
    const base = readDisplay(settings)
    const draft = preview()
    return draft ? readDisplay({ ...base, ...draft }) : base
  })
  // 侧栏专属展示：形状／宽度／布局／颜色走同一桥（卡片覆盖 › 整体 › 缺省）。
  // hook 只在组件 setup 调用一次：放进 getter 会反复注册订阅。
  const shown = useSidebarDisplay(SESSION_OVERVIEW_CARD_ID)
  const barShape = () => shown().shape ?? CONTEXT_BAR_FALLBACK_SHAPE
  const layout = () => shown().layout
  const colors = () => shown().colors
  const [measured, setMeasured] = createSignal(0)
  const barCells = () => {
    const mode = shown().barWidth
    if (typeof mode === "number") return mode
    return Math.max(4, measured() || CONTEXT_BAR_CELLS)
  }
  const timer = setInterval(() => setTick((value) => value + 1), 500)
  createEffect(() => {
    const unsubscribe = props.runtime.metrics.subscribe(props.sessionID, () => setTick((value) => value + 1))
    onCleanup(unsubscribe)
  })
  const costs = props.summary ?? createSessionCostSummary(props.context, props.runtime, () => props.sessionID, tick)
  onCleanup(() => {
    clearInterval(timer)
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
  // TPS：只有会话仍在运行才显示 ~ 估算（灰色）；会话一结束立即切换为
  // step 完成统计值，没有完成值则显示 —。不依赖 tracker 的空闲驱逐时机。
  const working = () => {
    void tick()
    return props.context.data.session.status(props.sessionID) === "running"
  }
  const tps = createMemo(() => {
    void tick()
    const streaming = working() ? props.runtime.tps.streaming(props.sessionID) : undefined
    if (streaming) return `~${formatTps(streaming.tps)} t/s`
    const latest = props.runtime.tps.latest(props.sessionID)
    return latest ? `${formatTps(latest.tps)} t/s` : "-"
  })
  const theme = props.context.theme
  const contextBarColor = createMemo(() => {
    // 明确设置的进度条颜色＝固定色；未设置时保持随使用率变化的原有告警方向。
    const fixed = colors().bar
    if (fixed !== undefined) return fixed
    const tier = contextBarTier(percent())
    if (tier === "danger") return theme.text.feedback.error.base
    if (tier === "warning") return theme.text.feedback.warning.base
    return theme.hue?.interactive?.[300] ?? theme.text.action.primary.base
  })
  const titleColor = () => colors().title ?? theme.text.action.primary.base
  const bodyColor = () => colors().body ?? theme.text.base
  const mutedColor = () => colors().muted ?? theme.text.muted
  const warnColor = () => colors().warn ?? theme.text.feedback.warning.base
  const dividerColor = () => colors().divider ?? theme.text.muted
  const indent = () => Math.max(0, layout().indent ?? 0)
  const lineGap = () => Math.max(0, layout().lineGap ?? 0)

  /** 一行「标签 值」；值不可用时统一显示「-」。 */
  function Row(props2: { label: string; value: string; unavailable?: boolean; muted?: boolean }) {
    return (
      <box flexDirection="row" flexWrap="wrap" justifyContent="space-between" paddingLeft={indent()}>
        <text fg={mutedColor()}>{props2.label}</text>
        <text fg={props2.unavailable ? warnColor() : props2.muted ? mutedColor() : bodyColor()}>{props2.value}</text>
      </box>
    )
  }

  const barRuns = () => {
    const [filled, empty] = sidebarBarParts(barShape(), percent() ?? 0, barCells())
    return { filled, empty }
  }

  /** 所选范围（Token 与花费共用）。 */
  const scope = () => costs.scopes[display().scope === "session" ? "session" : "tree"]

  const tokenValue = () => {
    const used = scope().tokens()
    if (used === null) return { text: "-", unavailable: true }
    return { text: `${formatTokenCount(totalTokenBuckets(used))}${scope().status() === "stale" ? "（旧数据）" : ""}`, unavailable: false }
  }
  const costValue = () => {
    const text = scope().cost()
    const status = scope().status()
    if (text === null || status === "failed" || status === "incomplete" || status === "loading" || status === "empty") return { text: "-", unavailable: true }
    return { text, unavailable: false }
  }

  return (
    <box
      flexDirection="column"
      onSizeChange={function (this: BoxRenderable) {
        if (this.width > 0 && this.width !== measured()) queueMicrotask(() => setMeasured(this.width))
      }}
    >
      <CardTitle open={open()} title="上下文" color={titleColor()} toggle={() => void updateSettings((draft) => { draft.open = !draft.open })} />
      <Show when={layout().divider === true}>
        <text fg={dividerColor()} wrapMode="none" selectable={false}>{"─".repeat(Math.max(4, measured() || 20))}</text>
      </Show>
      <Show when={open()}>
        <box flexDirection="column" gap={lineGap()}>
          <Show when={display().showContext}>
            <Show when={percent() !== undefined}>
              <Row label="使用率" value={`${contextUsed()!.toLocaleString()} / ${contextLimit()!.toLocaleString()} · ${percent()}%`} />
              <box flexDirection="row" paddingLeft={indent()}><text fg={contextBarColor()}>{barRuns().filled}</text><text fg={mutedColor()}>{barRuns().empty}</text></box>
            </Show>
            <Show when={percent() === undefined}>
              <Row label="使用率" value="-" unavailable />
            </Show>
          </Show>
          <Show when={display().showTokens}>
            <Row label="Token" value={tokenValue().text} unavailable={tokenValue().unavailable} />
          </Show>
          <Show when={display().showCost}>
            <Row label="花费" value={costValue().text} unavailable={costValue().unavailable} />
          </Show>
          <Show when={display().showCache}>
            <Show when={cacheHit() !== undefined}>
              <Row label="缓存命中率" value={`${cacheHit()}%`} />
            </Show>
            <Show when={cacheHit() === undefined}>
              <Row label="缓存命中率" value="-" unavailable />
            </Show>
          </Show>
          <Show when={display().showTps}>
            {/* 估算值（~ 前缀）灰色，完成值正文色：与既有行为一致。 */}
            <Row label="TPS" value={tps()} muted={tps().startsWith("~")} />
          </Show>
        </box>
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
