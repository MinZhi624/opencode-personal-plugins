/** @jsxImportSource @opentui/solid */
import "@opentui/solid/preload"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { taskRpc } from "./rpc.ts"
import { markKey, projectTasks, type Snapshot, type Source, type ViewTask } from "./model.ts"

type Archive = { version: 1; marks: Record<string, boolean>; sources: Record<string, Source>; hidden: Record<string, boolean>; collapsed?: Record<string, boolean> }
const labels = { ready: "可开始", blocked: "依赖受阻", unknown: "待确认", processed: "本地已处理", closed: "来源已结" }
const shortTitle = (title: string) => {
  const chars = Array.from(title)
  return chars.slice(0, 10).join("") + (chars.length > 10 ? "…" : "")
}

export default Plugin.define({
  id: "opencode-task-tracker-zh",
  setup(context: Context) {
    const [archive, update] = context.storage.store<Archive>("task-tracker-v1", {
      initial: { version: 1, marks: {}, sources: {}, hidden: {} },
    })
    const [location, setLocation] = createSignal(context.location ?? context.data.location.default())
    const [project, setProject] = createSignal("")
    const [snapshot, setSnapshot] = createSignal<Snapshot>()
    const [loading, setLoading] = createSignal(false)
    const [error, setError] = createSignal("")
    const [needsSource, setNeedsSource] = createSignal(false)
    const [blockedOpen, setBlockedOpen] = createSignal(false)
    const [otherOpen, setOtherOpen] = createSignal(false)
    const scope = () => JSON.stringify([location().workspaceID ?? "", project() || location().directory])
    const compatible = () => archive.version === 1 && !!archive.marks && !!archive.sources && !!archive.hidden
    const rows = createMemo(() => snapshot() ? projectTasks(snapshot()!, compatible() ? archive.marks : {}) : [])
    const pending = () => rows().filter((task) => task.state !== "processed" && task.state !== "closed")
    let disposed = false
    let generation = 0
    let controller: AbortController | undefined
    let flight: Promise<void> | undefined

    function refresh(force = false): Promise<void> {
      if (disposed) return Promise.resolve()
      if (flight && !force) return flight
      controller?.abort()
      controller = new AbortController()
      const signal = controller.signal
      const epoch = ++generation
      const selected = archive.sources?.[scope()]
      const selectedScope = scope()
      const at = location()
      setLoading(true)
      const timeout = setTimeout(() => controller?.signal === signal && controller.abort(), 20000)
      const work = (async () => {
        try {
          const result = await context.client.rpc(taskRpc).snapshot({ source: selected }, { location: at, signal })
          if (disposed || epoch !== generation) return
          if (!selected) {
            if (result.suggestedSource) {
              await save((draft) => { draft.sources[selectedScope] = result.suggestedSource! })
              return
            }
            setNeedsSource(true)
            setError("")
            return
          }
          setSnapshot(result)
          setNeedsSource(false)
          setError("")
        } catch {
          if (!disposed && epoch === generation) setError("读取失败或超时，请检查服务端插件、来源配置和鉴权后重试。")
        } finally {
          clearTimeout(timeout)
          if (!disposed && epoch === generation) { setLoading(false); flight = undefined }
        }
      })()
      flight = work
      return work
    }

    createEffect(() => {
      void scope()
      void archive.sources?.[scope()]
      ++generation
      controller?.abort()
      flight = undefined
      setSnapshot(undefined)
      setError("")
      setNeedsSource(false)
      setBlockedOpen(false)
      setOtherOpen(false)
      void refresh(true)
    })
    const timer = setInterval(() => { if (!needsSource()) void refresh() }, 60000)

    async function save(mutation: (draft: Archive) => void) {
      if (!compatible()) {
        context.ui.toast.show({ title: "任务存档", message: "存档版本不兼容，未改写数据。", variant: "error" })
        return false
      }
      try { await update(mutation); return !disposed }
      catch { context.ui.toast.show({ title: "任务存档", message: "保存失败，未确认持久化。", variant: "error" }); return false }
    }
    async function mark(task: ViewTask) {
      const current = snapshot()
      if (!current) return
      const key = markKey(current, task.id)
      const undo = task.state === "processed"
      if (await save((draft) => { if (undo) delete draft.marks[key]; else draft.marks[key] = true })) {
        context.ui.toast.show({ title: task.title, message: undo ? "已撤销本地标记" : "已本地标为已处理；未修改来源", variant: "success" })
      }
    }
    async function detail(id: string) {
      const task = rows().find((row) => row.id === id)
      if (!task) return
      const current = snapshot()!
      const byID = new Map(rows().map((row) => [row.id, row]))
      const message = [
        `来源：${current.source} · ${current.sourceKey}`,
        `标识：${task.id}`,
        `来源状态：${task.sourceState}`,
        `侧栏：${labels[task.state]}${task.local ? " · 本地修正" : ""}`,
        task.problem ? `待确认：${task.problem}` : "",
        "验收条件（只读，不代表完成百分比）：",
        ...task.criteria,
        "依赖：",
        ...(task.blockers.length ? task.blockers.map((blocker) => {
          const found = byID.get(blocker)
          return `${found?.title ?? blocker} · ${found ? labels[found.state] : "待确认"}${found?.local ? " · 本地修正" : ""}`
        }) : ["无"]),
      ].filter(Boolean).join("\n")
      const action = await context.ui.dialog.select<string>({
        title: task.title,
        options: [
          { title: "查看完整详情与依赖", value: "detail", description: `${labels[task.state]}${task.local ? " · 本地修正" : ""}` },
          ...(task.state === "closed" ? [] : [{ title: task.state === "processed" ? "撤销本地标记" : "本地标为已处理", value: "mark", description: "仅改变侧栏，不写回任务来源" }]),
        ],
      })
      if (action === "detail") await context.ui.dialog.alert({ title: task.title, message })
      if (action === "mark") {
        if (snapshot() === current) await mark(task)
        else context.ui.toast.show({ message: "任务视图已更新，请重新选择后操作。", variant: "warning" })
      }
    }
    async function all() {
      const current = snapshot()
      const list = rows().filter((task) => task.state !== "closed")
      if (!list.length) { await context.ui.dialog.alert({ title: "任务追踪", message: error() || (!snapshot() ? "尚未取得任务数据，请等待或重试。" : "当前没有待处理或本地已处理任务。") }); return }
      const id = await context.ui.dialog.select<string>({
        title: "项目任务（含本地已处理）",
        options: list.map((task) => ({ title: task.title, value: task.id, description: `${labels[task.state]}${task.local ? " · 本地修正" : ""} · ${task.id}` })),
      })
      if (id !== undefined && snapshot() === current) await detail(id)
    }
    async function settings() {
      const key = scope()
      const action = await context.ui.dialog.select<Source | "visibility">({
        title: `项目任务追踪设置${snapshot()?.suggestedSource && snapshot()?.source !== snapshot()?.suggestedSource ? " · 与 Matt 配置不同" : ""}`,
        current: archive.sources?.[key] ?? snapshot()?.source,
        options: [
          { title: "本地 Markdown", value: "local", description: "项目全部 Matt tickets，只读" },
          { title: "GitHub", value: "github", description: "当前仓库全部未结 issue，只读" },
          { title: archive.hidden?.[key] ? "显示 footer" : "隐藏 footer", value: "visibility", description: "不删除标记，不停用数据能力" },
        ],
      })
      if (action === undefined || key !== scope()) return
      await save((draft) => {
        if (action === "visibility") draft.hidden[key] = !draft.hidden[key]
        else draft.sources[key] = action
      })
    }
    // Keymap.Provider belongs to the rendered app, not plugin setup.
    const stopCommands = context.ui.slot({ append: "app", render: () => {
      context.keymap.layer(() => ({ mode: "global", commands: [
      { id: "task-tracker.settings", title: "任务追踪设置", group: "任务追踪", palette: true, slash: { name: "task-settings" }, run: settings },
      { id: "task-tracker.refresh", title: "刷新项目任务", group: "任务追踪", palette: true, slash: { name: "task-refresh" }, run: () => refresh() },
      { id: "task-tracker.list", title: "查看全部项目任务", group: "任务追踪", palette: true, slash: { name: "task-list" }, run: all },
      ] }))
      return null
    } })

    function Footer(props: { sessionID: string }) {
      createEffect(() => {
        const session = context.data.session.get(props.sessionID)
        const fallback = context.location ?? context.data.location.default()
        const at: typeof fallback = session?.location && session.location.directory !== fallback.directory
          ? { directory: session.location.directory }
          : fallback
        setLocation((previous) => previous.directory === at.directory && previous.workspaceID === at.workspaceID ? previous : at)
        setProject(session?.projectID ?? "")
      })
      const groups = () => {
        const ready = pending().filter((task) => task.state === "ready")
        const blocked = pending().filter((task) => task.state === "blocked")
        const other = pending().filter((task) => task.state === "unknown")
        const reserveBlocked = blockedOpen() && blocked.length ? 1 : 0
        const reserveOther = otherOpen() && other.length ? 1 : 0
        const readyShown = ready.slice(0, 4 - reserveBlocked - reserveOther)
        const blockedShown = blockedOpen() ? blocked.slice(0, 4 - readyShown.length - reserveOther) : []
        const otherShown = otherOpen() ? other.slice(0, 4 - readyShown.length - blockedShown.length) : []
        return { ready, blocked, other, readyShown, blockedShown, otherShown }
      }
      return <Show when={!archive.hidden?.[scope()]}>
        <box flexDirection="column" marginTop={1} border={["top"]} borderColor={context.theme.text.muted}>
          <text fg={context.theme.text.action.primary.base} onMouseUp={() => { const key = scope(); void save((draft) => { const states = draft.collapsed ??= {}; states[key] = !states[key] }) }}>
            <b>{archive.collapsed?.[scope()] ? "▸" : "▾"} 任务追踪{snapshot() ? ` · ${snapshot()!.complete ? "待处理" : "已加载待处理"} ${pending().length}` : ""}</b>
          </text>
          <Show when={!archive.collapsed?.[scope()]}>
          <Show when={!compatible()}><text>存档版本不兼容 · 禁止修改</text></Show>
          <Show when={needsSource()}><text fg={context.theme.text.muted}>未设置任务来源 · 可按需打开设置</text></Show>
          <Show when={loading()}><text fg={context.theme.text.muted}>读取中…</text></Show>
          <Show when={error()}><text fg={context.theme.text.feedback.warning.base}>{snapshot() ? "旧数据 · " : "不可用 · "}{error()}</text></Show>
          <Show when={snapshot()}>{(value) => <text fg={context.theme.text.muted}>{value().source} · {value().complete ? "最近成功" : "数据不完整"} {new Date(value().syncedAt).toLocaleTimeString()}</text>}</Show>
          <Show when={snapshot()}><box flexDirection="row" gap={1}>
            <text fg={context.theme.text.feedback.success.base}>○ {groups().ready.length}</text>
            <text fg={context.theme.text.feedback.warning.base}>! {groups().blocked.length}</text>
            <text fg={context.theme.text.feedback.error.base}>? {groups().other.length}</text>
          </box></Show>
          <For each={groups().readyShown}>{(task) => <text fg={task.local ? context.theme.text.action.primary.base : context.theme.text.feedback.success.base} onMouseUp={() => void detail(task.id)}>○ {shortTitle(task.title)}{task.local ? " · 本地" : ""}</text>}</For>
          <Show when={groups().blocked.length > 0}><text fg={context.theme.text.feedback.warning.base} onMouseUp={() => setBlockedOpen(!blockedOpen())}>{blockedOpen() ? "▾" : "▸"} 依赖受阻 · {groups().blocked.length}</text></Show>
          <For each={groups().blockedShown}>{(task) => <text fg={context.theme.text.feedback.warning.base} onMouseUp={() => void detail(task.id)}>! {shortTitle(task.title)}</text>}</For>
          <Show when={groups().other.length > 0}><text fg={context.theme.text.feedback.error.base} onMouseUp={() => setOtherOpen(!otherOpen())}>{otherOpen() ? "▾" : "▸"} 待确认 · {groups().other.length}</text></Show>
          <For each={groups().otherShown}>{(task) => <text fg={context.theme.text.feedback.error.base} onMouseUp={() => void detail(task.id)}>？ {shortTitle(task.title)}</text>}</For>
          <box flexDirection="row" gap={2}>
            <text fg={context.theme.text.action.primary.base} onMouseUp={() => void all()}>查看全部</text>
            <text fg={context.theme.text.action.primary.base} onMouseUp={() => void refresh()}>刷新</text>
            <text fg={context.theme.text.action.primary.base} onMouseUp={() => void settings()}>设置</text>
          </box>
          </Show>
        </box>
      </Show>
    }
    const stopSlot = context.ui.slot({ append: "sidebar.footer", render: (props) => <Footer sessionID={props.sessionID} /> })
    return () => { disposed = true; ++generation; controller?.abort(); clearInterval(timer); stopSlot(); stopCommands() }
  },
})
