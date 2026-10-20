/** @jsxImportSource @opentui/solid */
// 宿主编排卡片展示；宿主偏好归 cli.json，卡片私有设置仍由其所有者管理。
import "@opentui/solid/preload"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createSignal, ErrorBoundary, For } from "solid-js"
import { SEAM_VERSION, pendingQueue, type RegisteredCard } from "./seam.ts"
import { createOrAdoptSeam } from "./seam-registry.ts"
import { createCliCardConfig, cliConfigError, inlineCliConfigActive, type CliCardConfigStatus } from "./cli-config.ts"
import { createControlWindow } from "./control-window.tsx"
import { appearanceOf } from "./ui/appearance.ts"
import type { ControlFileState, ControlWindowHost, SaveResult } from "./ui/types.ts"
import { createSidebarAppearancePublisher, createSidebarShortcutsPublisher, shortcutVisible, useSidebarShortcuts, type SidebarAppearance, type SidebarShortcuts } from "./presentation.ts"
import {
  HOST_SETTINGS_KEY,
  LEGACY_SIDEBAR_CARD_LABELS,
  LEGACY_SIDEBAR_CARD_SETTINGS_KEY,
  applySidebarAppearance,
  applySidebarShortcuts,
  changeSidebarCard,
  completeSidebarCards,
  parseSidebarCards,
  readLegacyCandidate,
  sameSidebarCards,
  shortcutsOf,
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
    // 排列／显隐草稿的内存预览：只影响本进程侧栏渲染，保存前不落盘；undefined = 已保存状态。
    const [preview, setPreview] = createSignal<SidebarCardSettings | undefined>(undefined)
    // 外观草稿：宿主 effect 发布给侧栏卡片（useSidebarBarShape）；undefined = 发布已保存值。
    const [appearanceDraft, setAppearanceDraft] = createSignal<SidebarAppearance | undefined>(undefined)
    const appearancePublisher = createSidebarAppearancePublisher()
    // 快捷入口的唯一发布点：只发布已保存值（设置信号变化即刷新，命令注册方据此过滤入口）。
    const shortcutsPublisher = createSidebarShortcutsPublisher()
    // 命令注册处的响应式读取：宿主卸载时随 onCleanup 一起摘除监听。
    const sidebarShortcuts = useSidebarShortcuts()
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
    // 侧栏外观的唯一发布点：窗口编辑中发布有效草稿，否则发布已保存值（含空值＝卡片自己的设置）。
    createEffect(() => {
      appearancePublisher.publish(appearanceDraft() ?? savedAppearance())
    })
    // 快捷入口发布：跟随已保存设置（保存／重新读取／导入后自动刷新）；启动时也会发布一次。
    createEffect(() => {
      shortcutsPublisher.publish(shortcutsOf(settings()) ?? {})
    })
    if (initial.issues.length) context.ui.toast.show({ title: "侧栏配置", message: initial.issues.join("；"), variant: "warning" })

    for (const spec of [...pendingQueue(globalThis)]) {
      const result = handle.seam.register(spec)
      drained.push(`${spec.id}:${result.ok ? "已注册" : (result as { code: string }).code}`)
    }
    pendingQueue(globalThis).length = 0
    setRegistrations(handle.seam.list())

    function fullSettings(base = settings()): SidebarCardSettings {
      return effectiveSettings(base)
    }
    /** 当前生效的完整序列：草稿预览优先，否则已保存值；再补齐新注册卡片。 */
    function effectiveSettings(base = preview() ?? settings()): SidebarCardSettings {
      return completeSidebarCards(base, registrations().map((record) => record.id))
    }
    /** 原始基线：cli.json／options 里已持久化的值（不含内存补齐的新注册卡片）。 */
    function rawSettings(): SidebarCardSettings {
      return settings()
    }
    /** 已保存的外观（原始基线里的 bar/bars，无效形状一律丢弃）。 */
    function savedAppearance(): SidebarAppearance {
      return appearanceOf(rawSettings())
    }
    function findRecord(id: string) { return registrations().find((record) => record.id === id) }
    function labelFor(id: string): string {
      return findRecord(id)?.title || (Object.hasOwn(LEGACY_SIDEBAR_CARD_LABELS, id) ? LEGACY_SIDEBAR_CARD_LABELS[id as LegacySidebarCardID] : id)
    }
    function displayRecords(): RegisteredCard[] {
      const byID = new Map(registrations().map((record) => [record.id, record]))
      const current = effectiveSettings()
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

    /** 写后确认读到的状态：一次性应用到四个信号，避免各写入路径各写一份。 */
    function applyWriteStatus(status: CliCardConfigStatus) {
      if (disposed) return
      setFileStatus(status)
      setSettings(status.settings)
      setIssues(status.issues)
      setConfigured(status.hasSettings)
    }

    /** 文件被其他窗口或 /sidebar-host-* 命令改过时，写入必须让位。 */
    const FILE_CHANGED = "cli.json 的 sidebarCards 已被其他窗口或命令修改；为避免覆盖外部修改，本次保存已取消。请重新打开 /sidebar-cards 读取最新设置。"

    /**
     * 保存排列草稿：基线用**原始**设置（raw，不含内存补齐的新注册卡片），
     * 与 config.update 回调里的磁盘当前值比对，相等才写。
     */
    async function saveCards(draft: SidebarCardSettings, baseline: SidebarCardSettings): Promise<SaveResult> {
      if (disposed) return { ok: false, message: "宿主已卸载" }
      activeWrites++
      try {
        const outcome = await config.update((current) => {
          if (!sameSidebarCards(current, baseline)) throw new Error(FILE_CHANGED)
          return { settings: draft, result: "window-cards" as const, save: true }
        })
        applyWriteStatus(outcome.status)
        setPreview(undefined)
        if (outcome.saved) writes++
        return { ok: true, baseline: outcome.status.settings as SidebarCardSettings }
      } catch (error) {
        failures++
        setLastError(cliConfigError(error))
        return { ok: false, message: cliConfigError(error) }
      } finally {
        activeWrites--
      }
    }

    /**
     * 保存外观草稿：整份写回展示字段（形状／宽度／布局／颜色），order/hidden 与快捷入口
     * 原样取自磁盘当前值，因此绝不会把排列草稿或外部顺序改动一起写进去。
     * 用 host-settings 的 applySidebarAppearance 构造：
     * 未设置的键整个省略（= 删除），空覆盖等同未设置。
     */
    async function saveAppearance(appearance: SidebarAppearance, baseline: SidebarCardSettings): Promise<SaveResult> {
      if (disposed) return { ok: false, message: "宿主已卸载" }
      if (inlineCliConfigActive()) {
        return { ok: false, message: "OPENCODE_CLI_CONFIG_CONTENT 已设置；文件写入已只读降级，请先移除环境变量覆盖" }
      }
      activeWrites++
      try {
        const outcome = await config.update((current) => {
          if (!sameSidebarCards(current, baseline)) throw new Error(FILE_CHANGED)
          return { settings: applySidebarAppearance(current, appearance), result: "window-appearance" as const, save: true }
        })
        applyWriteStatus(outcome.status)
        setPreview(undefined)
        if (outcome.saved) writes++
        return { ok: true, baseline: outcome.status.settings as SidebarCardSettings }
      } catch (error) {
        failures++
        setLastError(cliConfigError(error))
        return { ok: false, message: cliConfigError(error) }
      } finally {
        activeWrites--
      }
    }

    /**
     * 保存快捷入口草稿：整份替换 shortcuts（缺省类别／通道＝显示），
     * order/hidden 与展示偏好原样取自磁盘当前值；冲突检测与另两条保存路径同一套。
     */
    async function saveShortcuts(shortcuts: SidebarShortcuts, baseline: SidebarCardSettings): Promise<SaveResult> {
      if (disposed) return { ok: false, message: "宿主已卸载" }
      if (inlineCliConfigActive()) {
        return { ok: false, message: "OPENCODE_CLI_CONFIG_CONTENT 已设置；文件写入已只读降级，请先移除环境变量覆盖" }
      }
      activeWrites++
      try {
        const outcome = await config.update((current) => {
          if (!sameSidebarCards(current, baseline)) throw new Error(FILE_CHANGED)
          return { settings: applySidebarShortcuts(current, shortcuts), result: "window-shortcuts" as const, save: true }
        })
        applyWriteStatus(outcome.status)
        setPreview(undefined)
        if (outcome.saved) writes++
        return { ok: true, baseline: outcome.status.settings as SidebarCardSettings }
      } catch (error) {
        failures++
        setLastError(cliConfigError(error))
        return { ok: false, message: cliConfigError(error) }
      } finally {
        activeWrites--
      }
    }

    /** 重新读取 cli.json 并应用；随后由调用方重建基线（预览一并回到已保存状态）。 */
    async function refreshFromDisk(): Promise<void> {
      await refreshStatus(true)
      if (!disposed) setPreview(undefined)
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
        applyWriteStatus(outcome.status)
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
        applyWriteStatus({ ...outcome.status, hasSettings: true })
        setLastError("")
        savedToast(`已从${candidate.source}导入`)
      } catch (error) { await writeFailure(error, next) }
      finally { activeWrites-- }
    }

    function statusText(): string {
      const status = fileStatus()
      const current = effectiveSettings()
      const different = status?.readable && !inlineCliConfigActive() && !sameSidebarCards(settings(), status.settings)
      return [
        `宿主 ${OWNER}｜seam v${SEAM_VERSION}｜${handle.adopted ? "已接管注册表" : "新建注册表"}`,
        `配置来源：${inlineCliConfigActive() ? "CLI options（环境变量覆盖，文件只读）" : configured() ? "cli.json" : "默认（不自动采用旧 storage）"}`,
        `文件：${config.path}`,
        `写入：${status?.writable ? "可写" : "只读／待检查"}｜${status?.reason ?? "尚未检查"}`,
        different ? "磁盘设置与当前展示不同，请重启 TUI，或打开 /sidebar-cards 重新读取。" : "菜单确认保存后本窗口立即应用；其他窗口未同步时重启 TUI。",
        preview() ? "排列预览中：/sidebar-cards 窗口有未保存的排序／显隐草稿（仅本进程生效，未写文件）。" : "无未保存预览。",
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
    const controlWindow = createControlWindow({
      context,
      fullSettings: () => effectiveSettings(),
      rawSettings,
      previewArrangement: (next) => setPreview(next),
      refreshFromDisk,
      saveCards,
      saveAppearance,
      saveShortcuts,
      savedAppearance,
      setAppearanceDraft,
      runImport: importSettings,
      labelFor,
      registrations,
      fileState: (): ControlFileState => ({
        writable: fileStatus()?.writable ?? false,
        reason: fileStatus()?.reason ?? "尚未检查",
        path: config.path,
        configured: configured(),
        inline: inlineCliConfigActive(),
      }),
    } satisfies ControlWindowHost)
    const ControlSlot = controlWindow.Slot
    const disposeSlot = context.ui.slot({ append: "sidebar.content", render: (input) => <SidebarHost sessionID={input.sessionID} /> })
    const disposeControlSlot = context.ui.slot({ append: "session.composer.top", render: () => <ControlSlot /> })
    const disposeCommands = context.ui.slot({
      append: "app",
      render: () => {
        // 宿主直接操作入口（hostDirect）按已保存的快捷入口偏好过滤：
        // slash／palette 任一一被关掉，对应命令就不注册那个键；主入口始终保留。
        const slashVisible = () => shortcutVisible(sidebarShortcuts(), "hostDirect", "slash")
        const paletteVisible = () => shortcutVisible(sidebarShortcuts(), "hostDirect", "palette")
        const hostDirectKeys = (name: string): { slash?: { name: string; arguments: true }; palette?: true } => {
          const keys: { slash?: { name: string; arguments: true }; palette?: true } = {}
          if (slashVisible()) keys.slash = { name, arguments: true }
          if (paletteVisible()) keys.palette = true
          return keys
        }
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            { id: "sidebar-host-zh.cards", title: "侧栏宿主：管理卡片", description: "排列／布局／颜色／快捷入口及各卡展示设置，按页预览与保存", group: "侧栏", palette: true, slash: { name: "sidebar-cards" }, run: () => controlWindow.open() },
            ...(["show", "hide", "up", "down"] as const).map((action) => ({
              id: `sidebar-host-zh.${action}`,
              title: `侧栏宿主：${{ show: "显示卡片", hide: "隐藏卡片", up: "卡片上移", down: "卡片下移" }[action]}`,
              description: `用法：/sidebar-host-${action} <卡片ID>`,
              group: "侧栏",
              ...hostDirectKeys(`sidebar-host-${action}`),
              run: async (input?: string) => {
                const id = (input ?? "").trim()
                if (!id) { context.ui.toast.show({ title: "侧栏宿主", message: `用法：/sidebar-host-${action} <卡片ID>`, variant: "info" }); return }
                await act(id, action)
              },
            })),
            { id: "sidebar-host-zh.import", title: "侧栏宿主：导入旧设置", group: "侧栏", ...hostDirectKeys("sidebar-host-import"), run: importSettings },
            { id: "sidebar-host-zh.status", title: "侧栏宿主：状态与诊断", group: "侧栏", ...hostDirectKeys("sidebar-host-status"), run: async () => {
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
      controlWindow.dispose()
      appearancePublisher.dispose()
      shortcutsPublisher.dispose()
      disposeListener()
      disposeSlot()
      disposeControlSlot()
      disposeCommands()
      // 不撤销卡片注册：宿主换代由下一代 adopt；注册归卡片所有者。
    }
  },
})
