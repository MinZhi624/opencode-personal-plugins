/** @jsxImportSource @opentui/solid */

import "@opentui/solid/preload"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { copyText } from "./clipboard.ts"
import { formatCostUsd } from "./metrics/token-cost.ts"
import { createV2Metrics } from "./v2-runtime.ts"

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
export type Persisted = { version: 2; byParent: Record<string, Entry[]> }
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
  const [expanded, setExpanded] = createSignal("")
  const timer = setInterval(() => setTick((value) => value + 1), 500)
  onCleanup(() => clearInterval(timer))
  const entries = createMemo(() => {
    void tick()
    return [...(props.state.byParent[props.sessionID] ?? [])].sort((a, b) => b.started - a.started)
  })
  const family = createMemo(() => props.context.data.session.family(props.sessionID))
  const descendants = createMemo(() => {
    const pending = new Set([props.sessionID])
    const result: string[] = []
    let changed = true
    while (changed) {
      changed = false
      for (const id of family()) {
        const session = props.context.data.session.get(id)
        if (!pending.has(id) && session?.parentID && pending.has(session.parentID)) {
          pending.add(id)
          result.push(id)
          changed = true
        }
      }
    }
    return result
  })
  const refreshCosts = () => {
    props.runtime.metrics.refresh(props.sessionID, { delayMs: 0 })
    for (const id of family()) props.runtime.metrics.refresh(id, { delayMs: 0 })
  }
  refreshCosts()
  const descendantResults = createMemo(() => {
    void tick()
    return descendants().map((id) => props.runtime.metrics.get(id))
  })
  const subagentCost = createMemo(() => {
    const results = descendantResults()
    if (!results.length || results.some((result) => !result?.complete)) return
    const used = results.filter((result) => result?.hasUsage)
    if (!used.length) return
    return formatCostUsd(used.reduce((sum, result) => sum + result!.usd, 0), {
      hasUsage: true,
      partial: used.some((result) => result!.partial),
    })
  })
  const treeCost = createMemo(() => {
    void tick()
    const rootID = props.context.data.session.root(props.sessionID)
    const tree = family().map((id) => props.runtime.metrics.get(id))
    if (!tree.length || tree.some((result) => !result?.complete)) return
    const root = props.runtime.metrics.get(rootID)
    if (!root?.complete) return
    const all = tree.filter((result) => result !== undefined)
    if (!all.some((result) => result.hasUsage)) return
    return formatCostUsd(all.reduce((sum, result) => sum + result.usd, 0), {
      hasUsage: true,
      partial: all.some((result) => result.partial),
    })
  })
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
  const theme = props.context.theme
  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1} onMouseDown={() => void updateView((draft) => { draft.open = !draft.open })}>
        <text fg={theme.text.action.primary.base}>{view.open ? "▼" : "▶"}</text>
        <text fg={theme.text.action.primary.base}><b>子代理</b></text>
        <text fg={theme.text.muted}>{entries().length} 个</text>
      </box>
      <Show when={view.open}>
        <Show when={subagentCost()}><box flexDirection="row" justifyContent="space-between"><text fg={theme.text.muted}>API 标价估算（子代理）</text><text fg={theme.text.action.primary.base}>{subagentCost()}</text></box></Show>
        <Show when={treeCost()}><box flexDirection="row" justifyContent="space-between"><text fg={theme.text.muted}>API 标价估算（任务树）</text><text fg={theme.text.action.primary.base}>{treeCost()}</text></box></Show>
        <For each={entries()}>{(entry) => {
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
                <Show when={result()?.complete && result()?.hasUsage}><box flexDirection="row" justifyContent="space-between"><text fg={theme.text.muted}>API 标价估算</text><text fg={theme.text.base}>{formatCostUsd(result()!.usd, result()!)}</text></box></Show>
                <Show when={entry.childID}><box flexDirection="row" gap={2}><text fg={theme.text.action.primary.base} onMouseDown={() => props.context.ui.router.navigate({ type: "session", sessionID: entry.childID! })}>→ 进入会话</text><Show when={entry.status === "running"}><text fg={theme.text.feedback.warning.base} onMouseDown={() => void cancel(entry)}>取消任务</text></Show></box></Show>
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

export default Plugin.define({
  id: "opencode-subagent-magazine-zh",
  setup(context) {
    const runtime = createV2Metrics(context)
    const controller = createSubagentController(context, runtime)
    const disposeSlot = context.ui.slot({ append: "sidebar.content", render: (props) => <SubAgentPanel context={context} sessionID={props.sessionID} runtime={runtime} state={controller.state} update={controller.update} /> })
    return () => { disposeSlot(); controller.dispose(); runtime.dispose() }
  },
})
