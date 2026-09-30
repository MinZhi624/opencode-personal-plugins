/** @jsxImportSource @opentui/solid */
// 宿主只管理注册、排列和显隐；cli.json 是唯一设置来源，storage 仅供显式导入。
import "@opentui/solid/preload"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createSignal, ErrorBoundary, For } from "solid-js"
import { SEAM_VERSION, pendingQueue, type RegisteredCard } from "./seam.ts"
import { createOrAdoptSeam } from "./seam-registry.ts"
import { createCliCardConfig, cliConfigError, inlineCliConfigActive, type CliCardConfigStatus } from "./cli-config.ts"
import {
  HOST_SETTINGS_KEY,
  LEGACY_SIDEBAR_CARD_LABELS,
  LEGACY_SIDEBAR_CARD_SETTINGS_KEY,
  changeSidebarCard,
  completeSidebarCards,
  parseSidebarCards,
  readLegacyCandidate,
  sameSidebarCards,
  uninitializedHostCardSettings,
  type HostCardSettings,
  type LegacySidebarCardID,
  type LegacySidebarCardSettings,
  type SidebarCardSettings,
} from "./host-settings.ts"

const OWNER = "opencode-sidebar-host-zh"
type CardAction = "show" | "hide" | "up" | "down"

export default Plugin.define({
  id: OWNER,
  setup(context: Context) {
    const handle = createOrAdoptSeam(globalThis)
    if (handle.conflict) {
      context.ui.toast.show({ title: "侧栏宿主", message: `检测到不兼容的 seam v${handle.seam.version}；请只启用一个宿主版本。`, variant: "error" })
      return () => {}
    }

    const config = createCliCardConfig()
    const initial = parseSidebarCards(context.options.sidebarCards)
    const [settings, setSettings] = createSignal(initial.settings)
    const [issues, setIssues] = createSignal(initial.issues)
    const [configured, setConfigured] = createSignal(Object.hasOwn(context.options, "sidebarCards"))
    const [fileStatus, setFileStatus] = createSignal<CliCardConfigStatus>()
    const [lastError, setLastError] = createSignal("")
    const [registrations, setRegistrations] = createSignal<readonly RegisteredCard[]>(handle.seam.list())
    let disposed = false
    let writes = 0
    let failures = 0
    let activeWrites = 0
    const drained: string[] = []

    // 若 options 是响应式值则跟随变化；通常 CLI 会直接重载插件并重新 setup。
    createEffect(() => {
      const parsed = parseSidebarCards(context.options.sidebarCards)
      setSettings(parsed.settings)
      setIssues(parsed.issues)
      setConfigured(Object.hasOwn(context.options, "sidebarCards"))
    })
    if (initial.issues.length) context.ui.toast.show({ title: "侧栏配置", message: initial.issues.join("；"), variant: "warning" })

    for (const spec of [...pendingQueue(globalThis)]) {
      const result = handle.seam.register(spec)
      drained.push(`${spec.id}:${result.ok ? "已注册" : (result as { code: string }).code}`)
    }
    pendingQueue(globalThis).length = 0
    setRegistrations(handle.seam.list())

    function fullSettings(base = settings()): SidebarCardSettings {
      return completeSidebarCards(base, registrations().map((record) => record.id))
    }
    function findRecord(id: string) { return registrations().find((record) => record.id === id) }
    function labelFor(id: string): string {
      return findRecord(id)?.title || LEGACY_SIDEBAR_CARD_LABELS[id as LegacySidebarCardID] || id
    }
    function displayRecords(): RegisteredCard[] {
      const byID = new Map(registrations().map((record) => [record.id, record]))
      const current = fullSettings()
      return current.order.flatMap((id) => {
        const entry = byID.get(id)
        return entry && !current.hidden.includes(id) ? [entry] : []
      })
    }

    async function refreshStatus(apply = false) {
      const status = await config.read()
      if (disposed) return status
      setFileStatus(status)
      // 读取失败／inline 覆盖时保留 CLI 实际加载的 options，不让磁盘覆盖它。
      if (apply && !inlineCliConfigActive() && status.readable) {
        setSettings(status.settings)
        setIssues(status.issues)
        setConfigured(status.hasSettings)
      }
      return status
    }
    void refreshStatus()

    async function writeFailure(error: unknown, proposed?: SidebarCardSettings) {
      failures++
      const message = cliConfigError(error)
      if (disposed) return
      setLastError(message)
      await refreshStatus()
      if (disposed) return
      context.ui.toast.show({ title: "侧栏配置未确认保存", message, variant: "error", duration: 8000 })
      // 仅展示本宿主参数，不输出用户的完整配置或其他插件选项。
      await context.ui.dialog.alert({
        title: "侧栏配置：手动编辑",
        message: `${message}\n\n文件：${config.path}\n仅合并到唯一宿主条目的 options.sidebarCards：\n${JSON.stringify(proposed ?? fullSettings(), null, 2)}\n\n未回退写入旧 storage；修复后重试。`,
      })
    }

    function savedToast(message: string) {
      if (!disposed) context.ui.toast.show({ title: "侧栏宿主", message: `${message}，已保存到 cli.json；若其他窗口未同步，请重启其 TUI。`, variant: "success", duration: 6000 })
    }

    async function act(id: string, action: CardAction) {
      if (disposed) return
      const proposed = changeSidebarCard(fullSettings(), id, action).settings
      activeWrites++
      try {
        const outcome = await config.update((current) => {
          const next = changeSidebarCard(fullSettings(current), id, action)
          return { settings: next.settings, result: next.result, save: next.result === "ok" || (next.result === "boundary" && !sameSidebarCards(current, next.settings)) }
        })
        if (disposed) return
        setFileStatus(outcome.status)
        setSettings(outcome.status.settings)
        setIssues(outcome.status.issues)
        setConfigured(outcome.status.hasSettings)
        setLastError("")
        if (outcome.saved) {
          writes++
          const label = { show: "已显示", hide: "已隐藏", up: "已上移", down: "已下移" }[action]
          savedToast(outcome.result === "boundary" ? `${labelFor(id)} 已在边界，已保留新卡片位置` : `${labelFor(id)} ${label}`)
        } else context.ui.toast.show({ title: "侧栏宿主", message: outcome.result === "boundary" ? "已在边界，顺序不变" : "未知卡片", variant: "info" })
      } catch (error) { await writeFailure(error, proposed) }
      finally { activeWrites-- }
    }

    interface ImportCandidate { source: string; settings: SidebarCardSettings }
    function importCandidates(): ImportCandidate[] {
      // 只取候选，绝不 update 或删除这些 store。旧存档不参与常规展示。
      const [previous] = context.storage.store<HostCardSettings>(HOST_SETTINGS_KEY, { initial: uninitializedHostCardSettings() })
      const [legacy] = context.storage.store<LegacySidebarCardSettings>(LEGACY_SIDEBAR_CARD_SETTINGS_KEY, { initial: { version: 1, order: [], hidden: [] } })
      const candidates: ImportCandidate[] = []
      const own = parseSidebarCards(previous)
      if (own.settings.order.length) candidates.push({ source: "旧宿主 storage", settings: own.settings })
      for (const [source, value] of [["legacySettings 选项", context.options.legacySettings], ["旧聚合 storage", legacy]] as const) {
        const candidate = readLegacyCandidate(value)
        if (candidate) candidates.push({ source, settings: parseSidebarCards(candidate).settings })
      }
      return candidates
    }

    async function importSettings() {
      const status = await refreshStatus()
      if (disposed) return
      if (status.hasSettings || configured()) {
        await context.ui.dialog.alert({ title: "已有文件配置", message: "sidebarCards 已存在，文件优先；不会用旧存档覆盖。请直接编辑文件或管理卡片。" })
        return
      }
      if (!status.writable) { await writeFailure(new Error(status.reason)); return }
      const candidates = importCandidates()
      if (!candidates.length) {
        await context.ui.dialog.alert({ title: "没有可导入设置", message: "未读到旧侧栏设置（插件存储可能隔离）。可在宿主 options 中提供 legacySettings 候选，或直接编辑 sidebarCards；未自动迁移或删除旧存档。" })
        return
      }
      const chosen = await context.ui.dialog.select<string>({ title: "选择导入来源", options: candidates.map((candidate, index) => ({ title: candidate.source, value: String(index) })) })
      const candidate = chosen === undefined ? undefined : candidates[Number(chosen)]
      if (!candidate) return
      const next = fullSettings(candidate.settings)
      const accepted = await context.ui.dialog.confirm({ title: "导入已有侧栏设置到 cli.json", message: `来源：${candidate.source}\n顺序：${next.order.join(" → ")}\n隐藏：${next.hidden.join("、") || "（无）"}\n不会删除旧存档。` })
      if (!accepted || disposed) return
      activeWrites++
      try {
        const outcome = await config.update((_current, hasSettings) => {
          if (hasSettings) throw new Error("另一进程已添加 sidebarCards，已取消导入；文件配置优先")
          return { settings: next, result: "import", save: true }
        })
        if (disposed) return
        writes++
        setSettings(outcome.status.settings)
        setIssues(outcome.status.issues)
        setConfigured(true)
        setFileStatus(outcome.status)
        setLastError("")
        savedToast(`已从${candidate.source}导入`)
      } catch (error) { await writeFailure(error, next) }
      finally { activeWrites-- }
    }

    async function manageCards() {
      await refreshStatus(true)
      while (!disposed) {
        const current = fullSettings()
        const options = current.order.map((id, index) => ({
          title: `${index + 1}. ${labelFor(id)}${findRecord(id) ? "" : "（未加载）"}`,
          value: `card:${id}`,
          description: current.hidden.includes(id) ? "已隐藏" : findRecord(id) ? "显示中" : "未加载（偏好已保留）",
        }))
        options.push({ title: "导入已有侧栏设置到 cli.json", value: "import", description: configured() ? "文件已有配置，不允许覆盖" : "预览并确认后导入旧存档／legacySettings" })
        const picked = await context.ui.dialog.select<string>({ title: "侧栏卡片", placeholder: "选择卡片或导入旧设置", options })
        if (picked === undefined || disposed) return
        if (picked === "import") { await importSettings(); continue }
        const id = picked.slice("card:".length)
        const hidden = settings().hidden.includes(id)
        const action = await context.ui.dialog.select<CardAction | "done">({
          title: `${labelFor(id)}（${hidden ? "已隐藏" : "显示中"}）`,
          options: [
            hidden ? { title: "显示这张卡片", value: "show" } : { title: "隐藏这张卡片", value: "hide" },
            { title: "上移", value: "up", description: "与完整序列的上一项交换（含隐藏／未加载项）" },
            { title: "下移", value: "down", description: "与完整序列的下一项交换（含隐藏／未加载项）" },
            { title: "完成", value: "done" },
          ],
        })
        if (action === undefined || action === "done" || disposed) return
        await act(id, action)
      }
    }

    function statusText(): string {
      const status = fileStatus()
      const current = fullSettings()
      const different = status?.readable && !inlineCliConfigActive() && !sameSidebarCards(settings(), status.settings)
      return [
        `宿主 ${OWNER}｜seam v${SEAM_VERSION}｜${handle.adopted ? "已接管注册表" : "新建注册表"}`,
        `配置来源：${inlineCliConfigActive() ? "CLI options（环境变量覆盖，文件只读）" : configured() ? "cli.json" : "默认（不自动采用旧 storage）"}`,
        `文件：${config.path}`,
        `写入：${status?.writable ? "可写" : "只读／待检查"}｜${status?.reason ?? "尚未检查"}`,
        different ? "磁盘设置与当前展示不同，请重启 TUI，或打开 /sidebar-cards 重新读取。" : "菜单确认保存后本窗口立即应用；其他窗口未同步时重启 TUI。",
        `已注册：${registrations().map((entry) => `${entry.id}#${entry.generation}`).join(" ") || "（无）"}`,
        `实际顺序：${current.order.map((id) => `${labelFor(id)}${current.hidden.includes(id) ? "（隐藏）" : ""}${findRecord(id) ? "" : "（未加载）"}`).join(" → ") || "（空）"}`,
        `写入成功 ${writes}｜失败 ${failures}｜进行中 ${activeWrites}`,
        `最近错误：${lastError() || "（无）"}`,
        `配置诊断：${issues().join("；") || "（无）"}`,
        `导入：仅显式预览确认后写入；旧存档保留，不参与常规排序。`,
        `启动待接单：${drained.join(" ") || "（无）"}｜当前排队 ${pendingQueue(globalThis).length}`,
        ...handle.seam.diagnostics().slice(-8).map((entry) => `${entry.code}: ${entry.message}`),
      ].join("\n")
    }

    function SidebarHost(props: { sessionID: string }) {
      return <box flexDirection="column" gap={1}>
        <For each={displayRecords()}>{(entry) => <box flexDirection="column">
          <ErrorBoundary fallback={() => <text>⚠ {entry.title} 渲染失败，已隔离</text>}>
            {entry.spec.render({ sessionID: props.sessionID }) as never}
          </ErrorBoundary>
        </box>}</For>
      </box>
    }
    const disposeSlot = context.ui.slot({ append: "sidebar.content", render: (input) => <SidebarHost sessionID={input.sessionID} /> })
    const disposeCommands = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            { id: "sidebar-host-zh.cards", title: "侧栏宿主：管理卡片", description: "排序／显隐保存到 cli.json", group: "侧栏", palette: true, slash: { name: "sidebar-cards" }, run: manageCards },
            ...(["show", "hide", "up", "down"] as const).map((action) => ({
              id: `sidebar-host-zh.${action}`,
              title: `侧栏宿主：${{ show: "显示卡片", hide: "隐藏卡片", up: "卡片上移", down: "卡片下移" }[action]}`,
              description: `用法：/sidebar-host-${action} <卡片ID>`,
              group: "侧栏", palette: true as const, slash: { name: `sidebar-host-${action}`, arguments: true as const },
              run: async (input?: string) => {
                const id = (input ?? "").trim()
                if (!id) { context.ui.toast.show({ title: "侧栏宿主", message: `用法：/sidebar-host-${action} <卡片ID>`, variant: "info" }); return }
                await act(id, action)
              },
            })),
            { id: "sidebar-host-zh.import", title: "侧栏宿主：导入旧设置", group: "侧栏", palette: true, slash: { name: "sidebar-host-import" }, run: importSettings },
            { id: "sidebar-host-zh.status", title: "侧栏宿主：状态与诊断", group: "侧栏", palette: true, slash: { name: "sidebar-host-status" }, run: async () => {
              await refreshStatus()
              if (!disposed) await context.ui.dialog.alert({ title: "侧栏宿主状态", message: statusText() })
            } },
          ],
        }))
        return null
      },
    })
    const disposeListener = handle.onChange(() => { setRegistrations(handle.seam.list()) })
    return () => {
      disposed = true
      disposeListener()
      disposeSlot()
      disposeCommands()
      // 不撤销卡片注册：宿主换代由下一代 adopt；注册归卡片所有者。
    }
  },
})
