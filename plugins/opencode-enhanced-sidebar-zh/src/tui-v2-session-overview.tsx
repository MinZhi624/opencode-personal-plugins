/** @jsxImportSource @opentui/solid */

import "@opentui/solid/preload"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import type { JSX } from "@opentui/solid"
import {
  cacheHitPercent,
  contextBarTier,
  contextUsagePercent,
  CONTEXT_BAR_CELLS,
  sumContextTokens,
} from "./metrics/session-overview-view.ts"
import { createSessionCostSummary } from "./metrics/session-cost-summary.ts"
import type { SessionCostSummary } from "./metrics/session-cost-summary.ts"
import { formatTokenCount } from "./metrics/token-buckets.ts"
import { formatTps } from "./metrics/step-tps.ts"
import { createV2Metrics } from "./v2-runtime.ts"
import { useCardControlPreview } from "../../opencode-sidebar-host-zh/src/card-controls.ts"
import { sidebarBarParts, useSidebarBarShape } from "../../opencode-sidebar-host-zh/src/presentation.ts"

/** 卡片 ID：与宿主注册、控制窗口字段使用同一个稳定身份。 */
export const SESSION_OVERVIEW_CARD_ID = "sessionOverview"
/** 展开状态的存档键；归属本插件 context，控制窗口只经本模块读写。 */
export const SESSION_OVERVIEW_SETTINGS_KEY = "session-overview-zh-v2"
/** 没有整体／单卡样式覆盖时，上下文条沿用卡片原有形状。 */
const CONTEXT_BAR_FALLBACK_SHAPE = "blocks" as const

/** 统一卡片标题行：箭头 + 粗体标题同一行、间距 1，颜色取主题动作色。
 *  与额度／子代理／技能三张卡片保持同一视觉语言，各卡内容布局仍自主。 */
function CardTitle(props: { context: Context; open: boolean; title: string; toggle: () => void; children?: JSX.Element }) {
  const theme = () => props.context.theme
  return (
    <box flexDirection="row" gap={1} onMouseDown={props.toggle}>
      <text fg={theme().text.action.primary.base}>{props.open ? "▼" : "▶"}</text>
      <text fg={theme().text.action.primary.base}><b>{props.title}</b></text>
      {props.children}
    </box>
  )
}

export function SessionOverview(props: { context: Context; sessionID: string; runtime: ReturnType<typeof createV2Metrics>; summary?: SessionCostSummary }) {
  const [tick, setTick] = createSignal(0)
  const [settings, updateSettings] = props.context.storage.store(SESSION_OVERVIEW_SETTINGS_KEY, {
    initial: { version: 2, open: true },
  })
  // 统一窗口的预览只覆盖显示，不写存档；点击标题仍是既有的即时保存语义。
  const preview = useCardControlPreview(SESSION_OVERVIEW_CARD_ID)
  const open = () => {
    const value = preview()?.open
    return typeof value === "boolean" ? value : settings.open
  }
  // 侧栏专属形状：明确的单卡覆盖 > 明确的整体样式 > 卡片原有形状。
  // hook 只在组件 setup 调用一次：放进 getter 会每次计算都新建 signal／注册清理，
  // 反复渲染会堆积订阅，无 owner 下调用还可能无法清理。
  const sharedBarShape = useSidebarBarShape(SESSION_OVERVIEW_CARD_ID)
  const barShape = () => sharedBarShape() ?? CONTEXT_BAR_FALLBACK_SHAPE
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
  // 进度条形状只改图形：百分比、告警档位和 20 格条宽都不变，none 只去掉图形。
  const barRuns = () => {
    const [filled, empty] = sidebarBarParts(barShape(), percent() ?? 0, CONTEXT_BAR_CELLS)
    return { filled, empty }
  }
  return (
    <box flexDirection="column">
      <CardTitle context={props.context} open={open()} title="上下文" toggle={() => void updateSettings((draft) => { draft.open = !draft.open })} />
      <Show when={open()}>
        <Show when={percent() !== undefined}>
          <box flexDirection="row" flexWrap="wrap" justifyContent="space-between"><text fg={theme.text.muted}>使用率</text><text fg={theme.text.base}>{contextUsed()!.toLocaleString()} / {contextLimit()!.toLocaleString()} · {percent()}%</text></box>
          <box flexDirection="row"><text fg={contextBarColor()}>{barRuns().filled}</text><text fg={theme.text.muted}>{barRuns().empty}</text></box>
        </Show>
        <box flexDirection="row" flexWrap="wrap" justifyContent="space-between"><text fg={theme.text.muted}>使用Token用量</text><text fg={theme.text.base}>{costs.treeTokenStatus() === "failed" ? "加载失败" : costs.treeTokenStatus() === "incomplete" ? "不完整" : costs.treeTokens() === null ? "加载中…" : `${formatTokenCount(costs.treeTokens()!)}${costs.treeTokenStatus() === "stale" ? "（旧数据）" : ""}`}</text></box>
        <Show when={cacheHit() !== undefined}><box flexDirection="row" flexWrap="wrap" justifyContent="space-between"><text fg={theme.text.muted}>缓存命中</text><text fg={theme.text.base}>{cacheHit()}%</text></box></Show>
        <box flexDirection="row" flexWrap="wrap" justifyContent="space-between"><text fg={theme.text.muted}>TPS</text><text fg={tps().startsWith("~") ? theme.text.muted : theme.text.base}>{tps()}</text></box>
        <Show when={costs.session()}><box flexDirection="row" flexWrap="wrap" justifyContent="space-between"><text fg={theme.text.muted}>花费（本会话）</text><text fg={theme.text.base}>{costs.session()}</text></box></Show>
        <Show when={costs.subagent()}><box flexDirection="row" flexWrap="wrap" justifyContent="space-between"><text fg={theme.text.muted}>花费（子代理）</text><text fg={theme.text.action.primary.base}>{costs.subagent()}</text></box></Show>
        <Show when={costs.tree()}><box flexDirection="row" flexWrap="wrap" justifyContent="space-between"><text fg={theme.text.muted}>花费（任务树合计）</text><text fg={theme.text.action.primary.base}>{costs.tree()}</text></box></Show>
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
