/** @jsxImportSource @opentui/solid */

import "@opentui/solid/preload"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { copyText } from "./clipboard.ts"
import { formatCostUsd } from "./metrics/token-cost.ts"
import { createV2Metrics } from "./v2-runtime.ts"

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

const SUBAGENT_SETTINGS_KEY = "subagent-magazine-settings-v2"

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
  runtime: ReturnType<typeof createV2Metrics>
  state: Persisted
  update: (mutation: (draft: Persisted) => void) => Promise<void>
}) {
  const [tick, setTick] = createSignal(0)
  const [view, updateView] = props.context.storage.store("subagent-magazine-view-v2", {
    initial: { version: 2, open: true },
  })
  const [settings] = props.context.storage.store("subagent-magazine-settings-v2", {
    initial: { version: 2 } as SubagentSettings,
  })
  // 侧边栏只负责显示，改设置请去 cli.json 插件选项或命令面板，不要在侧边栏里加按钮
  const effective = () => resolveSubagentSettings(settings as SubagentSettings, props.context.options as SubagentPluginOptions | undefined)
  const sortOrder = () => effective().sortOrder
  const maxEntries = () => effective().maxEntries
  const ttlDays = () => effective().ttlDays
  const [expanded, setExpanded] = createSignal("")
  const timer = setInterval(() => setTick((value) => value + 1), 500)
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
  const visibleEntries = createMemo(() => allEntries().slice(0, maxEntries()))
  const hiddenCount = createMemo(() => Math.max(0, allEntries().length - visibleEntries().length))
  const statusText = (status: Status) => ({ running: "运行中", done: "已完成", cancel_requested: "取消中", cancelled: "已取消", error: "失败" })[status]
  const dot = (status: Status) => status === "error" ? "✕" : status === "running" || status === "cancel_requested" ? "●" : "✓"
  const color = (status: Status) => status === "error" ? props.context.theme.text.feedback.error.base : status === "running" || status === "cancel_requested" ? props.context.theme.text.feedback.warning.base : props.context.theme.text.feedback.success.base
  const duration = (entry: Entry) => {
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
  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1} onMouseDown={() => void updateView((draft) => { draft.open = !draft.open })}>
        <text fg={theme.text.action.primary.base}>{view.open ? "▼" : "▶"}</text>
        <text fg={theme.text.action.primary.base}><b>子代理</b></text>
        <text fg={theme.text.muted}>{allEntries().length} 个</text>
        <Show when={hiddenCount() > 0}><text fg={theme.text.muted}>（已隐藏 {hiddenCount()} 个）</text></Show>
      </box>
      <Show when={view.open}>
        <For each={visibleEntries()}>{(entry) => {
          const result = () => entry.childID ? props.runtime.metrics.get(entry.childID) : undefined
          return (
            <box flexDirection="column">
              <box flexDirection="row" gap={1} onMouseDown={() => setExpanded((value) => value === entry.id ? "" : entry.id)}>
                <text fg={color(entry.status)}>{dot(entry.status)}</text>
                <text fg={theme.text.base}>{entry.title || entry.agent}</text>
                <text fg={theme.text.muted}>{duration(entry)}</text>
              </box>
              <Show when={expanded() === entry.id}>
                <box flexDirection="row" justifyContent="space-between"><text fg={theme.text.muted}>代理</text><text fg={theme.text.base}>{entry.agent}</text></box>
                <Show when={entry.childID && props.context.data.session.get(entry.childID)?.model}><box flexDirection="row" justifyContent="space-between"><text fg={theme.text.muted}>模型</text><text fg={theme.text.base}>{(() => { const model = props.context.data.session.get(entry.childID!)!.model!; return `${model.providerID}/${model.id}` })()}</text></box></Show>
                <box flexDirection="row" justifyContent="space-between"><text fg={theme.text.muted}>状态</text><text fg={color(entry.status)}>{statusText(entry.status)}</text></box>
                <Show when={entry.childID}><box flexDirection="row" justifyContent="space-between" onMouseDown={() => void copyText(entry.childID!)}><text fg={theme.text.muted}>会话 ID</text><text fg={theme.text.base}>{entry.childID!.slice(0, 18)}… ⎘</text></box></Show>
                <Show when={result()?.complete && result()?.hasUsage}><box flexDirection="row" justifyContent="space-between"><text fg={theme.text.muted}>Token 用量</text><text fg={theme.text.base}>{Object.values(result()!.tokens).reduce((sum: number, value) => sum + Number(value), 0).toLocaleString()}</text></box></Show>
                <Show when={result()?.complete && result()?.hasUsage}><box flexDirection="row" justifyContent="space-between"><text fg={theme.text.muted}>费用</text><text fg={theme.text.base}>{formatCostUsd(result()!.usd, result()!)}</text></box></Show>
                <Show when={entry.childID}><box flexDirection="row" gap={2}><text fg={theme.text.action.primary.base} onMouseDown={() => props.context.ui.router.navigate({ type: "session", sessionID: entry.childID! })}>→ 进入会话</text><Show when={entry.status === "running"}><text fg={theme.text.feedback.warning.base} onMouseDown={() => void cancel(entry)}>取消任务</text></Show></box></Show>
                <box flexDirection="row" gap={2}>
                  <Show when={entry.status === "running" || entry.status === "cancel_requested"}><text fg={theme.text.muted} onMouseDown={() => void dismissEntry(entry)}>标记完成</text></Show>
                  <text fg={theme.text.muted} onMouseDown={() => void deleteEntry(entry)}>删除这条</text>
                </box>
              </Show>
            </box>
          )
        }}</For>
      </Show>
    </box>
  )
}

export function createSubagentController(
  context: Context,
  runtime = createV2Metrics(context),
) {
    const [state, update] = context.storage.store<Persisted>("subagent-magazine-v2", { initial: { version: 2, byParent: {} } })
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
        runtime.metrics.refresh(childID)
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
        if (childID) runtime.metrics.refresh(childID)
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
        runtime.metrics.refresh(event.data.sessionID, { delayMs: 150 })
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

export function registerSubagentCommands(context: Context, getActiveSessionID: () => string | undefined) {
  const disposeCommands = context.ui.slot({
    append: "app",
    render: () => {
      context.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: "subagent-zh.sort",
            title: "子代理：排序方式",
            group: "子代理",
            palette: true,
            slash: { name: "subagent-sort" },
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
            palette: true,
            slash: { name: "subagent-max", arguments: true as const },
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
            palette: true,
            slash: { name: "subagent-ttl" },
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
            palette: true,
            slash: { name: "subagent-clear-running" },
            run: async () => {
              const sessionID = getActiveSessionID()
              if (!sessionID) {
                context.ui.toast.show({ title: "子代理", message: "先打开一个会话再清理", variant: "info" })
                return
              }
              const [state, update] = context.storage.store<Persisted>("subagent-magazine-v2", { initial: { version: 2, byParent: {} } })
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
            },
          },
          {
            id: "subagent-zh.clear",
            title: "子代理：清空本会话记录",
            group: "子代理",
            palette: true,
            slash: { name: "subagent-clear" },
            run: async () => {
              const sessionID = getActiveSessionID()
              if (!sessionID) {
                context.ui.toast.show({ title: "子代理", message: "先打开一个会话再清空", variant: "info" })
                return
              }
              const [state, update] = context.storage.store<Persisted>("subagent-magazine-v2", { initial: { version: 2, byParent: {} } })
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
            },
          },
        ],
      }))
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
