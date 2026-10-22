/** @jsxImportSource @opentui/solid */

import "@opentui/solid/preload"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { copyText } from "./clipboard.ts"
import { createSessionCostSummary } from "./metrics/session-cost-summary.ts"
import type { SessionCostSummary } from "./metrics/session-cost-summary.ts"
import { formatTokenCount, totalTokenBuckets } from "./metrics/token-buckets.ts"
import { formatCostUsd } from "./metrics/token-cost.ts"
import { createV2Metrics } from "./v2-runtime.ts"
import { useCardControlPreview } from "../../opencode-sidebar-host-zh/src/card-controls.ts"
import { shortcutVisible, useSidebarDisplay, useSidebarShortcuts } from "../../opencode-sidebar-host-zh/src/presentation.ts"

export type SubagentSortOrder = "desc" | "asc"

export type SubagentSettings = {
  version: 2
  sortOrder?: SubagentSortOrder
  maxEntries?: number
  ttlDays?: number
}

export type SubagentPluginOptions = {
  sessionOverview?: boolean
  subagents?: boolean
  subagentsSortOrder?: SubagentSortOrder
  subagentsMaxEntries?: number
  subagentsTtlDays?: number
}

/** 卡片 ID：与宿主注册、控制窗口字段使用同一个稳定身份。 */
export const SUBAGENT_CARD_ID = "subagents"

export const SUBAGENT_SETTINGS_KEY = "subagent-magazine-settings-v2"

/** 运行记录存档键：与设置键分开；命令、管理页和控制器共用同一份记录状态，不各存一份。 */
export const SUBAGENT_RECORDS_KEY = "subagent-magazine-v2"

const DEFAULT_SORT_ORDER: SubagentSortOrder = "desc"
const DEFAULT_MAX_ENTRIES = 10
const DEFAULT_TTL_DAYS = 3

export const SUBAGENT_TTL_OPTIONS = [3, 7, 14, 30, 0] as const

export function clampMaxEntries(value: unknown): number {
  const parsed = typeof value === "number" ? value : parseInt(String(value ?? ""), 10)
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_ENTRIES
  return Math.max(1, Math.min(50, Math.floor(parsed)))
}

export function clampTtlDays(value: unknown): number {
  const parsed = typeof value === "number" ? value : parseInt(String(value ?? ""), 10)
  if (!Number.isFinite(parsed)) return DEFAULT_TTL_DAYS
  if (parsed <= 0) return 0
  return Math.max(1, Math.min(30, Math.floor(parsed)))
}

export function normalizeSortOrder(value: unknown): SubagentSortOrder {
  return value === "asc" ? "asc" : "desc"
}

function normalizeSortOrderOrUndefined(value: unknown): SubagentSortOrder | undefined {
  if (value === "desc" || value === "asc") return value
  return undefined
}

function normalizeMaxEntriesOrUndefined(value: unknown): number | undefined {
  if (value === undefined) return undefined
  const parsed = typeof value === "number" ? value : parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return undefined
  return Math.max(1, Math.min(50, Math.floor(parsed)))
}

function normalizeTtlDaysOrUndefined(value: unknown): number | undefined {
  if (value === undefined) return undefined
  const parsed = typeof value === "number" ? value : parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return undefined
  if (parsed <= 0) return 0
  return Math.max(1, Math.min(30, Math.floor(parsed)))
}

/** 设置优先级：命令改的存档 > cli.json 插件选项 > 默认值。 */
export function resolveSubagentSettings(
  stored: SubagentSettings | undefined,
  options: SubagentPluginOptions | undefined,
): { sortOrder: SubagentSortOrder; maxEntries: number; ttlDays: number } {
  return {
    sortOrder:
      normalizeSortOrderOrUndefined(stored?.sortOrder) ??
      normalizeSortOrderOrUndefined(options?.subagentsSortOrder) ??
      DEFAULT_SORT_ORDER,
    maxEntries:
      normalizeMaxEntriesOrUndefined(stored?.maxEntries) ??
      normalizeMaxEntriesOrUndefined(options?.subagentsMaxEntries) ??
      DEFAULT_MAX_ENTRIES,
    ttlDays:
      normalizeTtlDaysOrUndefined(stored?.ttlDays) ??
      normalizeTtlDaysOrUndefined(options?.subagentsTtlDays) ??
      DEFAULT_TTL_DAYS,
  }
}

function entryFinishedAt(entry: Entry): number | undefined {
  return entry.ended ?? (entry.status === "running" || entry.status === "cancel_requested" ? undefined : entry.started)
}

/** 是否过期：只清已结束的，正在跑的永远保留。ttlDays 为 0 表示不限。 */
export function isEntryExpired(entry: Entry, ttlDays: number, now: number): boolean {
  if (ttlDays <= 0) return false
  if (entry.status === "running" || entry.status === "cancel_requested") return false
  const finished = entryFinishedAt(entry)
  if (finished === undefined) return false
  return finished < now - ttlDays * 24 * 60 * 60 * 1000
}

type Status = "running" | "done" | "cancel_requested" | "cancelled" | "error"
type Entry = {
  id: string
  parentID: string
  childID?: string
  agent: string
  title: string
  prompt: string
  status: Status
  started: number
  ended?: number
  error?: string
}
export type Persisted = { version: 2; byParent: Record<string, Entry[]>; clearedByParent?: Record<string, string[]> }
type ToolInfo = { name: string; input?: Record<string, unknown> }

const SUBAGENT_TOOLS = new Set(["subagent", "task", "delegate", "call_omo_agent"])

export function SubAgentPanel(props: {
  context: Context
  sessionID: string
  runtime?: ReturnType<typeof createV2Metrics>
  summary?: SessionCostSummary
  state: Persisted
  update: (mutation: (draft: Persisted) => void) => Promise<void>
}) {
  const [tick, setTick] = createSignal(0)
  const summary = props.summary ?? (props.runtime ? createSessionCostSummary(props.context, props.runtime, () => props.sessionID, tick) : undefined)
  const [view, updateView] = props.context.storage.store("subagent-magazine-view-v2", {
    initial: { version: 2, open: true },
  })
  const [settings] = props.context.storage.store(SUBAGENT_SETTINGS_KEY, {
    initial: { version: 2 } as SubagentSettings,
  })
  // 侧边栏只负责显示，改设置请去 cli.json 插件选项或命令面板，不要在侧边栏里加按钮
  // 统一窗口的预览只覆盖显示，不写存档；排序／条数的保存仍归子代理设置所有者。
  const preview = useCardControlPreview(SUBAGENT_CARD_ID)
  // 侧栏专属展示（颜色／布局覆盖）：hook 只在组件 setup 调用一次——放进 getter 会每次
  // 计算都新建 signal／注册清理，反复渲染会堆积订阅，无 owner 下调用还可能无法清理。
  const display = useSidebarDisplay(SUBAGENT_CARD_ID)
  const effective = () => resolveSubagentSettings(settings as SubagentSettings, props.context.options as SubagentPluginOptions | undefined)
  const sortOrder = () => {
    const value = preview()?.sortOrder
    return value === "asc" || value === "desc" ? value : effective().sortOrder
  }
  const maxEntries = () => {
    const value = preview()?.maxEntries
    return typeof value === "number" ? clampMaxEntries(value) : effective().maxEntries
  }
  const ttlDays = () => effective().ttlDays
  const [expanded, setExpanded] = createSignal("")
  // 二级展开：超过显示条数时临时展开全部；只影响当前卡片，不写设置存档。
  const [showAll, setShowAll] = createSignal(false)
  const timer = setInterval(() => setTick((value) => value + 1), 1000)
  onCleanup(() => clearInterval(timer))
  // 过期自动清理：只删已结束且超过保留天数的，正在跑的不动
  createEffect(() => {
    const days = ttlDays()
    if (days <= 0) return
    const now = Date.now()
    const list = props.state.byParent[props.sessionID] ?? []
    if (!list.some((entry) => isEntryExpired(entry, days, now))) return
    void props.update((draft) => {
      const entries = draft.byParent[props.sessionID]
      if (!entries) return
      const kept = entries.filter((entry) => !isEntryExpired(entry, days, Date.now()))
      if (kept.length === entries.length) return
      if (kept.length === 0) delete draft.byParent[props.sessionID]
      else draft.byParent[props.sessionID] = kept
    })
  })
  const allEntries = createMemo(() => {
    void tick()
    const list = [...(props.state.byParent[props.sessionID] ?? [])]
    if (sortOrder() === "desc") return list.sort((a, b) => b.started - a.started)
    return list.sort((a, b) => a.started - b.started)
  })
  const primaryEntries = createMemo(() => allEntries().slice(0, maxEntries()))
  const overflowEntries = createMemo(() => allEntries().slice(maxEntries()))
  const overflowCount = createMemo(() => overflowEntries().length)
  // 二级分组的摘要：让“其余”这一层自带信息，而不是一条无差别的“展开全部”链接。
  const overflowSummary = createMemo(() => {
    const entries = overflowEntries()
    const count = (statuses: Status[]) => entries.filter((entry) => statuses.includes(entry.status)).length
    return [
      { label: "已完成", value: count(["done", "cancelled"]) },
      { label: "运行中", value: count(["running", "cancel_requested"]) },
      { label: "失败", value: count(["error"]) },
    ].filter((item) => item.value > 0).map((item) => `${item.label} ${item.value}`).join(" · ")
  })
  // Status badges span records under the same root task tree, including nested agents.
  const taskEntries = createMemo(() => {
    void tick()
    const parents = new Set(summary ? [summary.rootID(), ...summary.descendantIDs()] : props.context.data.session.family(props.sessionID))
    return Object.entries(props.state.byParent).flatMap(([parentID, entries]) => parents.has(parentID) ? entries : [])
  })
  const doneCount = createMemo(() => taskEntries().filter((entry) => entry.status === "done" || entry.status === "cancelled").length)
  const runningCount = createMemo(() => taskEntries().filter((entry) => entry.status === "running" || entry.status === "cancel_requested").length)
  const errorCount = createMemo(() => taskEntries().filter((entry) => entry.status === "error").length)
  const statusText = (status: Status) => ({ running: "运行中", done: "已完成", cancel_requested: "取消中", cancelled: "已取消", error: "失败" })[status]
  const dot = (status: Status) => status === "error" ? "✕" : status === "running" || status === "cancel_requested" ? "●" : "✓"
  const color = (status: Status) => status === "error" ? theme.text.feedback.error.base : status === "running" || status === "cancel_requested" ? warnColor() : theme.text.feedback.success.base
  const duration = (entry: Entry) => {
    void tick()
    const seconds = Math.max(0, Math.round(((entry.ended ?? Date.now()) - entry.started) / 1000))
    return seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`
  }
  const cancel = async (entry: Entry) => {
    if (!entry.childID) return
    await props.update((draft) => {
      const target = draft.byParent[entry.parentID]?.find((item) => item.id === entry.id)
      if (target) target.status = "cancel_requested"
    })
    try {
      await props.context.client.session.interrupt({ sessionID: entry.childID })
      props.context.ui.toast.show({ title: entry.title, message: "已发送取消请求", variant: "success" })
    } catch {
      await props.update((draft) => {
        const target = draft.byParent[entry.parentID]?.find((item) => item.id === entry.id)
        if (target) target.status = "running"
      })
      props.context.ui.toast.show({ title: entry.title, message: "取消失败", variant: "error" })
    }
  }
  const dismissEntry = async (entry: Entry) => {
    await props.update((draft) => {
      const target = draft.byParent[entry.parentID]?.find((item) => item.id === entry.id)
      if (!target) return
      if (target.status === "running" || target.status === "cancel_requested") {
        target.status = "done"
        target.ended ??= Date.now()
      }
    })
    props.context.ui.toast.show({ title: entry.title || entry.agent, message: "已标记为完成", variant: "success" })
  }
  const deleteEntry = async (entry: Entry) => {
    await props.update((draft) => {
      const entries = draft.byParent[entry.parentID]
      if (!entries) return
      const index = entries.findIndex((item) => item.id === entry.id)
      if (index === -1) return
      entries.splice(index, 1)
      if (entries.length === 0) delete draft.byParent[entry.parentID]
      const cleared = draft.clearedByParent ??= {}
      const list = cleared[entry.parentID] ??= []
      if (!list.includes(entry.id)) {
        list.push(entry.id)
        if (list.length > 200) list.splice(0, list.length - 200)
      }
    })
    props.context.ui.toast.show({ title: entry.title || entry.agent, message: "已删除这条记录", variant: "success" })
  }
  const theme = props.context.theme
  // 颜色角色：宿主有覆盖用覆盖，缺省回退主题色；warn 承接运行中／取消等警示色
  const titleColor = () => display().colors.title ?? theme.text.action.primary.base
  const bodyColor = () => display().colors.body ?? theme.text.base
  const mutedColor = () => display().colors.muted ?? theme.text.muted
  const dividerColor = () => display().colors.divider ?? mutedColor()
  const warnColor = () => display().colors.warn ?? theme.text.feedback.warning.base
  // 布局偏好：缩进／附加行距／行名宽度／分隔线；缺省时保持原有观感
  const indent = () => display().layout.indent ?? 0
  const lineGap = () => display().layout.lineGap
  const labelWidth = () => display().layout.labelWidth
  const withDivider = () => display().layout.divider === true
  const summaryTokensText = () => {
    if (!summary) return "-"
    const status = summary.descendantTokenStatus()
    if (status === "failed" || status === "incomplete") return "-"
    const tokens = summary.descendantTokens()
    if (tokens === null) return "-"
    return `${formatTokenCount(tokens)}${status === "stale" ? "（旧数据）" : ""}`
  }
  const summaryCostText = () => {
    if (!summary) return "-"
    const status = summary.descendantTokenStatus()
    if (status === "failed" || status === "incomplete") return "-"
    const cost = summary.descendantCost()
    if (!cost) return "-"
    return `${cost}${status === "stale" ? "（旧数据）" : ""}`
  }
  const EntryItem = (row: { entry: Entry; index: number; nested?: boolean }) => {
    const entry = row.entry
    const result = () => {
      void tick()
      return entry.childID ? props.runtime?.metrics.get(entry.childID) : undefined
    }
    const entryTokens = () => result()?.complete && result()?.hasUsage ? totalTokenBuckets(result()!.tokens) : null
    return (
      <box flexDirection="column" paddingLeft={row.nested ? 2 : 0}>
        <Show when={!row.nested && row.index > 0 && withDivider()}><text fg={dividerColor()} wrapMode="none" selectable={false}>{"─".repeat(40)}</text></Show>
        <box flexDirection="row" flexWrap="wrap" gap={1} onMouseDown={() => setExpanded((value) => value === entry.id ? "" : entry.id)}>
          <text fg={color(entry.status)}>{dot(entry.status)}</text>
          <text fg={bodyColor()}>{entry.title || entry.agent}</text>
          <text fg={mutedColor()}>{duration(entry)}</text>
          <Show when={expanded() !== entry.id && entryTokens() !== null && entryTokens()! > 0}><text fg={mutedColor()}>{formatTokenCount(entryTokens()!)}</text></Show>
        </box>
        <Show when={expanded() === entry.id}>
        <box flexDirection="row" flexWrap="wrap" justifyContent="space-between"><text fg={mutedColor()}>代理</text><text fg={bodyColor()}>{entry.agent}</text></box>
        <Show when={entry.childID && props.context.data.session.get(entry.childID)?.model}><box flexDirection="row" flexWrap="wrap" justifyContent="space-between"><text fg={mutedColor()}>模型</text><text fg={bodyColor()}>{(() => { const model = props.context.data.session.get(entry.childID!)!.model!; return `${model.providerID}/${model.id}` })()}</text></box></Show>
        <box flexDirection="row" flexWrap="wrap" justifyContent="space-between"><text fg={mutedColor()}>状态</text><text fg={color(entry.status)}>{statusText(entry.status)}</text></box>
        <Show when={entry.childID}><box flexDirection="row" flexWrap="wrap" justifyContent="space-between" onMouseDown={() => void copyText(entry.childID!)}><text fg={mutedColor()}>会话 ID</text><text fg={bodyColor()}>{entry.childID!.slice(0, 18)}… ⎘</text></box></Show>
        <Show when={entryTokens() !== null}><box flexDirection="row" flexWrap="wrap" justifyContent="space-between"><text fg={mutedColor()}>Token 用量</text><text fg={bodyColor()}>{formatTokenCount(entryTokens()!)}</text></box></Show>
        <Show when={result()?.complete && result()?.hasUsage}><box flexDirection="row" flexWrap="wrap" justifyContent="space-between"><text fg={mutedColor()}>费用</text><text fg={bodyColor()}>{formatCostUsd(result()!.usd, result()!)}</text></box></Show>
        <Show when={entry.childID}><box flexDirection="row" flexWrap="wrap" gap={2}><text fg={titleColor()} onMouseDown={() => props.context.ui.router.navigate({ type: "session", sessionID: entry.childID! })}>→ 进入会话</text><Show when={entry.status === "running"}><text fg={warnColor()} onMouseDown={() => void cancel(entry)}>取消任务</text></Show></box></Show>
        <box flexDirection="row" flexWrap="wrap" gap={2}>
          <Show when={entry.status === "running" || entry.status === "cancel_requested"}><text fg={mutedColor()} onMouseDown={() => void dismissEntry(entry)}>标记完成</text></Show>
          <text fg={mutedColor()} onMouseDown={() => void deleteEntry(entry)}>删除这条</text>
        </box>
        </Show>
      </box>
    )
  }
  return (
    <box flexDirection="column" paddingLeft={indent()} gap={lineGap()}>
      <box flexDirection="row" flexWrap="wrap" gap={1} onMouseDown={() => void updateView((draft) => { draft.open = !draft.open })}>
        <text fg={titleColor()}>{view.open ? "▼" : "▶"}</text>
        <text fg={titleColor()}><b>子代理</b></text>
        <Show when={doneCount() > 0 || runningCount() > 0 || errorCount() > 0}>
          <Show when={doneCount() > 0}><text fg={theme.text.feedback.success.base}>✓{doneCount()}</text></Show>
          <Show when={runningCount() > 0}><text fg={warnColor()}>●{runningCount()}</text></Show>
          <Show when={errorCount() > 0}><text fg={theme.text.feedback.error.base}>✕{errorCount()}</text></Show>
        </Show>
         <Show when={!view.open && summary && summary.descendantCount() > 0}>
          <text fg={mutedColor()}>{summaryTokensText()}</text>
           <text fg={mutedColor()}>{summaryCostText()}</text>
        </Show>
      </box>
      <Show when={view.open}>
        <Show when={!props.runtime}><text fg={mutedColor()}>共享会话数据不可用；子代理记录仍可操作</text></Show>
        <Show when={allEntries().length === 0}><text fg={mutedColor()}>本会话暂无子代理记录</text></Show>
        <For each={primaryEntries()}>{(entry, index) => <EntryItem entry={entry} index={index()} />}</For>
        <Show when={overflowCount() > 0}>
          {/* 二级分组：独立标题条 + 缩进的组内条目，避免和普通条目混在一起。 */}
          <box flexDirection="row" flexWrap="wrap" gap={1} width="100%" backgroundColor={theme.background?.raised.high} onMouseDown={() => setShowAll((value) => !value)}>
            <text fg={titleColor()}>{showAll() ? "▾" : "▸"}</text>
            <text fg={titleColor()}><b>其余 {overflowCount()} 条</b></text>
            <Show when={overflowSummary()}><text fg={mutedColor()}>{overflowSummary()}</text></Show>
          </box>
          <Show when={showAll()}>
            <For each={overflowEntries()}>{(entry) => <EntryItem entry={entry} index={0} nested />}</For>
          </Show>
        </Show>
      </Show>
    </box>
  )
}

export function createSubagentController(
  context: Context,
  runtime?: ReturnType<typeof createV2Metrics>,
) {
    const [state, update] = context.storage.store<Persisted>(SUBAGENT_RECORDS_KEY, { initial: { version: 2, byParent: {} } })
    const tools = new Map<string, ToolInfo>()
    const key = (data: { assistantMessageID: string; id: string }) => `${data.assistantMessageID}\u0000${data.id}`
    const findEntry = (childID: string) => {
      for (const entries of Object.values(state.byParent)) {
        const entry = entries.find((item) => item.childID === childID)
        if (entry) return entry
      }
    }
    const unsubs = [
      context.data.on("session.tool.input.started", (event) => {
        tools.set(key(event.data), { name: event.data.name })
      }),
      context.data.on("session.tool.called", (event) => {
        const info = tools.get(key(event.data))
        if (!info || !SUBAGENT_TOOLS.has(info.name)) return
        info.input = event.data.input
        const input = event.data.input
        const agent = String(input.agent ?? input.subagent_type ?? input.category ?? "subagent")
        const prompt = String(input.prompt ?? "")
        const title = String(input.description ?? prompt.replace(/\s+/g, " ").slice(0, 40) ?? agent)
        void update((draft) => {
          if (draft.clearedByParent?.[event.data.sessionID]?.includes(event.data.id)) return
          const entries = draft.byParent[event.data.sessionID] ??= []
          const existing = entries.find((item) => item.id === event.data.id)
          if (existing) Object.assign(existing, { agent, prompt, title, status: "running" as const })
          else entries.push({ id: event.data.id, parentID: event.data.sessionID, agent, prompt, title, status: "running", started: event.created })
        })
      }),
      context.data.on("session.tool.progress", (event) => {
        const childID = typeof event.data.metadata.sessionID === "string" ? event.data.metadata.sessionID : undefined
        if (!childID) return
        void update((draft) => {
          const entries = draft.byParent[event.data.sessionID] ?? []
          const entry = entries.find((item) => item.id === event.data.id)
          if (!entry) return
          const previous = entries.find((item) => item.id !== entry.id && item.childID === childID)
          if (previous) {
            entry.started = Math.min(entry.started, previous.started)
            entries.splice(entries.indexOf(previous), 1)
          }
          entry.childID = childID
        })
        runtime?.metrics.refresh(childID)
      }),
      context.data.on("session.tool.success", (event) => {
        const childID = typeof event.data.metadata?.sessionID === "string" ? event.data.metadata.sessionID : undefined
        void update((draft) => {
          const entry = draft.byParent[event.data.sessionID]?.find((item) => item.id === event.data.id)
          if (!entry) return
          if (childID) {
            const previous = draft.byParent[event.data.sessionID]?.find((item) => item.id !== entry.id && item.childID === childID)
            if (previous) {
              entry.started = Math.min(entry.started, previous.started)
              draft.byParent[event.data.sessionID]!.splice(draft.byParent[event.data.sessionID]!.indexOf(previous), 1)
            }
            entry.childID = childID
          }
          if (!childID) { entry.status = "done"; entry.ended = event.created }
        })
        if (childID) runtime?.metrics.refresh(childID)
      }),
      context.data.on("session.tool.failed", (event) => {
        void update((draft) => {
          const entry = draft.byParent[event.data.sessionID]?.find((item) => item.id === event.data.id)
          if (entry) { entry.status = "error"; entry.ended = event.created; entry.error = String(event.data.error?.message ?? "") }
        })
      }),
      ...(["session.execution.succeeded", "session.execution.interrupted", "session.execution.failed"] as const).map((eventName) => context.data.on(eventName, (event) => {
        const entry = findEntry(event.data.sessionID)
        if (!entry) return
        void update((draft) => {
          const target = draft.byParent[entry.parentID]?.find((item) => item.id === entry.id)
          if (!target) return
          target.status = eventName === "session.execution.failed" ? "error" : target.status === "cancel_requested" || eventName === "session.execution.interrupted" ? "cancelled" : "done"
          target.ended = event.created
        })
        runtime?.metrics.refresh(event.data.sessionID, { delayMs: 150 })
      })),
    ]
    return {
      state,
      update,
      dispose: () => unsubs.forEach((unsubscribe) => unsubscribe()),
    }
}

function currentEffective(context: Context): { sortOrder: SubagentSortOrder; maxEntries: number; ttlDays: number } {
  const [stored] = context.storage.store(SUBAGENT_SETTINGS_KEY, { initial: { version: 2 } as SubagentSettings })
  return resolveSubagentSettings(stored as SubagentSettings, context.options as SubagentPluginOptions | undefined)
}

function selectValue(result: unknown): string | undefined {
  if (typeof result === "string") return result
  if (result && typeof result === "object") {
    const value = (result as Record<string, unknown>).value
    if (typeof value === "string") return value
  }
  return undefined
}

/** 标记完成：把该会话里运行中／取消中的记录改为已完成，不取消实际任务。
 *  命令面板与统一窗口的“子代理管理”页共用；记录状态始终只有 storage 里那一份。 */
export async function markSubagentRunningDone(context: Context, sessionID: string | undefined): Promise<void> {
  if (!sessionID) {
    context.ui.toast.show({ title: "子代理", message: "先打开一个会话再清理", variant: "info" })
    return
  }
  const [state, update] = context.storage.store<Persisted>(SUBAGENT_RECORDS_KEY, { initial: { version: 2, byParent: {} } })
  const running = (state.byParent[sessionID] ?? []).filter((entry) => entry.status === "running" || entry.status === "cancel_requested")
  if (running.length === 0) {
    context.ui.toast.show({ title: "子代理", message: "没有需要清理的运行中条目", variant: "info" })
    return
  }
  await update((draft) => {
    for (const entry of draft.byParent[sessionID] ?? []) {
      if (entry.status === "running" || entry.status === "cancel_requested") {
        entry.status = "done"
        entry.ended ??= Date.now()
      }
    }
  })
  context.ui.toast.show({ title: "子代理", message: `已标记 ${running.length} 个运行中条目为完成`, variant: "success" })
}

/** 清空记录：确认后删除该会话全部记录，并把 ID 记入 clearedByParent 防止共享数据再同步回来。
 *  命令面板与统一窗口的“子代理管理”页共用，确认对话框规则与命令版一致。 */
export async function clearSubagentSessionRecords(context: Context, sessionID: string | undefined): Promise<void> {
  if (!sessionID) {
    context.ui.toast.show({ title: "子代理", message: "先打开一个会话再清空", variant: "info" })
    return
  }
  const [state, update] = context.storage.store<Persisted>(SUBAGENT_RECORDS_KEY, { initial: { version: 2, byParent: {} } })
  const count = (state.byParent[sessionID] ?? []).length
  if (count === 0) {
    context.ui.toast.show({ title: "子代理", message: "本会话暂无记录", variant: "info" })
    return
  }
  const dialog = (context.ui.dialog as unknown as { confirm: (input: unknown) => Promise<unknown> }).confirm
  const confirmed = await dialog({ title: "清空本会话记录？", message: `共 ${count} 条，清空后不能恢复`, label: { confirm: "清空", cancel: "取消" } })
  if (!confirmed) {
    context.ui.toast.show({ title: "子代理", message: "已取消清空", variant: "info" })
    return
  }
  await update((draft) => {
    const entries = draft.byParent[sessionID] ?? []
    const ids = entries.map((entry) => entry.id)
    delete draft.byParent[sessionID]
    if (ids.length > 0) {
      const cleared = draft.clearedByParent ??= {}
      const list = cleared[sessionID] ??= []
      for (const id of ids) if (!list.includes(id)) list.push(id)
      if (list.length > 200) list.splice(0, list.length - 200)
    }
  })
  context.ui.toast.show({ title: "子代理", message: `已清空 ${count} 条记录`, variant: "success" })
}

export function registerSubagentCommands(context: Context, getActiveSessionID: () => string | undefined) {
  const disposeCommands = context.ui.slot({
    append: "app",
    render: () => {
      context.keymap.layer(() => {
        // 工厂是响应式的：宿主改快捷入口显隐后整体重算。通道关＝整个键不放进命令对象，
        // 不用 enabled:false，避免留下灰入口。类别：展示设置 vs 记录管理。
        const all = useSidebarShortcuts()
        return {
          mode: "global",
          commands: [
            {
              id: "subagent-zh.sort",
              title: "子代理：排序方式",
              group: "子代理",
              ...(shortcutVisible(all(), "subagentDisplay", "palette") ? { palette: true } : {}),
              ...(shortcutVisible(all(), "subagentDisplay", "slash") ? { slash: { name: "subagent-sort" } } : {}),
              run: async () => {
                const current = currentEffective(context).sortOrder
                const dialog = (context.ui.dialog as unknown as { select: (input: unknown) => Promise<unknown> }).select
                const picked = await dialog({ title: "排序方式", current, options: [
                  { title: "新的在上", value: "desc", description: "最新创建的子代理排前面" },
                  { title: "旧的在上", value: "asc", description: "最早创建的子代理排前面" },
                ] })
                const next = selectValue(picked)
                if (next !== "desc" && next !== "asc") return
                const [, updateSettings] = context.storage.store(SUBAGENT_SETTINGS_KEY, { initial: { version: 2 } as SubagentSettings })
                await updateSettings((draft) => { (draft as SubagentSettings).sortOrder = next })
                context.ui.toast.show({ title: "子代理", message: next === "desc" ? "新的在上" : "旧的在上", variant: "success" })
              },
            },
            {
              id: "subagent-zh.max",
              title: "子代理：显示数量",
              group: "子代理",
              ...(shortcutVisible(all(), "subagentDisplay", "palette") ? { palette: true } : {}),
              ...(shortcutVisible(all(), "subagentDisplay", "slash") ? { slash: { name: "subagent-max", arguments: true as const } } : {}),
              run: async (input?: unknown) => {
                const raw = typeof input === "string" ? input : (input as Record<string, unknown> | undefined)?.arguments
                let text = typeof raw === "string" && raw.trim() ? raw.trim() : undefined
                if (text === undefined) {
                  const answer = await context.ui.dialog.prompt({ title: "显示几条？填 1-50", placeholder: String(currentEffective(context).maxEntries) })
                  if (answer === undefined) return
                  text = answer.trim()
                }
                const next = clampMaxEntries(text)
                const [, updateSettings] = context.storage.store(SUBAGENT_SETTINGS_KEY, { initial: { version: 2 } as SubagentSettings })
                await updateSettings((draft) => { (draft as SubagentSettings).maxEntries = next })
                context.ui.toast.show({ title: "子代理", message: `只看 ${next} 条`, variant: "success" })
              },
            },
            {
              id: "subagent-zh.ttl",
              title: "子代理：保留期限",
              group: "子代理",
              ...(shortcutVisible(all(), "subagentDisplay", "palette") ? { palette: true } : {}),
              ...(shortcutVisible(all(), "subagentDisplay", "slash") ? { slash: { name: "subagent-ttl" } } : {}),
              run: async () => {
                const current = String(currentEffective(context).ttlDays)
                const dialog = (context.ui.dialog as unknown as { select: (input: unknown) => Promise<unknown> }).select
                const picked = await dialog({ title: `保留期限（当前 ${current === "0" ? "不限" : `${current} 天`}）`, current, options: [
                  { title: "3 天", value: "3", description: "默认，和上游一致" },
                  { title: "7 天", value: "7" },
                  { title: "14 天", value: "14" },
                  { title: "30 天", value: "30" },
                  { title: "不限", value: "0", description: "一直保留" },
                ] })
                const value = selectValue(picked)
                if (value === undefined) return
                const next = clampTtlDays(value)
                const [, updateSettings] = context.storage.store(SUBAGENT_SETTINGS_KEY, { initial: { version: 2 } as SubagentSettings })
                await updateSettings((draft) => { (draft as SubagentSettings).ttlDays = next })
                context.ui.toast.show({ title: "子代理", message: next === 0 ? "保留不限" : `保留 ${next} 天`, variant: "success" })
              },
            },
            {
              id: "subagent-zh.clear-running",
              title: "子代理：标记完成",
              group: "子代理",
              ...(shortcutVisible(all(), "subagentRecords", "palette") ? { palette: true } : {}),
              ...(shortcutVisible(all(), "subagentRecords", "slash") ? { slash: { name: "subagent-clear-running" } } : {}),
              run: async () => { await markSubagentRunningDone(context, getActiveSessionID()) },
            },
            {
              id: "subagent-zh.clear",
              title: "子代理：清空本会话记录",
              group: "子代理",
              ...(shortcutVisible(all(), "subagentRecords", "palette") ? { palette: true } : {}),
              ...(shortcutVisible(all(), "subagentRecords", "slash") ? { slash: { name: "subagent-clear" } } : {}),
              run: async () => { await clearSubagentSessionRecords(context, getActiveSessionID()) },
            },
          ],
        }
      })
      return null
    },
  })
  return () => {
    disposeCommands()
  }
}

export default Plugin.define({
  id: "opencode-subagent-magazine-zh",
  setup(context) {
    const runtime = createV2Metrics(context)
    const controller = createSubagentController(context, runtime)
    let activeSessionID: string | undefined
    const disposeSlot = context.ui.slot({ append: "sidebar.content", render: (props) => {
      activeSessionID = props.sessionID
      return <SubAgentPanel context={context} sessionID={props.sessionID} runtime={runtime} state={controller.state} update={controller.update} />
    } })
    const disposeCommands = registerSubagentCommands(context, () => activeSessionID)
    return () => { disposeSlot(); disposeCommands(); controller.dispose(); runtime.dispose() }
  },
})
