/** @jsxImportSource @opentui/solid */
// 侧栏宿主（生产版）：只拥有侧栏追加入口、卡片注册 Interface、排序／显隐设置与管理菜单。
//
// 明确不做的事：
// - 不静态导入任何业务卡片（额度／会话概览／子代理／技能或第三方卡片）；
// - 不创建会话统计运行时、不持有 Provider 凭据、不实现卡片业务计算；
// - 不 replace 原生侧栏：只 append 到 sidebar.content 之后；
// - 不提供原型的脚手架（诊断面板、resetSettings 临时选项等）。
//
// 每 TUI 进程一个 Seam 实例（锚在 globalThis）：卡片实例、事件处理与会话统计
// 按进程天然隔离；排序／显隐走 context.storage.store，跨 TUI 同步且重启保留。

import "@opentui/solid/preload"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal, ErrorBoundary, For } from "solid-js"
import { SEAM_VERSION, pendingQueue, type RegisteredCard, type SeamDiagnostic } from "./seam.ts"
import { createOrAdoptSeam } from "./seam-registry.ts"
import {
  HOST_SETTINGS_KEY,
  LEGACY_SIDEBAR_CARD_LABELS,
  LEGACY_SIDEBAR_CARD_SETTINGS_KEY,
  appendCardIDs,
  applyCardSettings,
  isHostCardInitialized,
  moveCard,
  normalizeHostCardSettings,
  readLegacyCandidate,
  sameHostCardSettings,
  setCardVisible,
  uninitializedHostCardSettings,
  type HostCardSettings,
  type LegacySidebarCardID,
  type LegacySidebarCardSettings,
  type MigrationCandidate,
} from "./host-settings.ts"

const OWNER = "opencode-sidebar-host-zh"
/** 每 TUI 一份的运行时记账（随 TUI 退出消失，不跨窗口共享）。 */
const RUNTIME_KEY = "sidebar-host-zh-runtime-v1"
/** 写入悬置阈值：超过即视为“长期悬置”，给可诊断反馈（不谎报成功）。 */
const SLOW_WRITE_MS = 5000
/** 状态对话框里展示的最近诊断条数。 */
const DIAGNOSTICS_PREVIEW = 8

type CardAction = "show" | "hide" | "up" | "down" | "done"

interface HostRuntimeState {
  writeOk: number
  writeFail: number
  slowWrites: number
  lastWriteError: string
  /** 启动时从待接单队列 drain 的结果（脱敏：id + 结果）。 */
  drained: string
  /** 迁移说明（供状态命令与 README 回退路径对照）。 */
  migrationNote: string
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 120)
  return String(error).slice(0, 120)
}

export default Plugin.define({
  id: OWNER,
  setup(context: Context) {
    const handle = createOrAdoptSeam(globalThis)

    // 版本冲突：同 TUI 里已存在另一 Interface 版本的宿主。本代保持惰性——
    // 不占侧栏、不注册命令，避免两代宿主各渲染一份卡片；只给出可操作提示。
    if (handle.conflict) {
      const message = `检测到不兼容的侧栏宿主 seam（global v${handle.seam.version}，本代 v${SEAM_VERSION}）；请只启用一个宿主版本。`
      context.ui.toast.show({ title: "侧栏宿主", message, variant: "error", duration: 12000 })
      return () => {}
    }

    const [settings, updateSettings] = context.storage.store<HostCardSettings>(HOST_SETTINGS_KEY, {
      initial: uninitializedHostCardSettings(),
    })
    const [runtime, updateRuntime] = context.storage.memory<HostRuntimeState>(RUNTIME_KEY, {
      initial: { writeOk: 0, writeFail: 0, slowWrites: 0, lastWriteError: "", drained: "", migrationNote: "" },
    })

    const [registrations, setRegistrations] = createSignal<readonly RegisteredCard[]>(handle.seam.list())

    // 卡片先到：drain 待接单队列（宿主后启用／卡片先加载）。队列只消费存活卡片。
    const drained: string[] = []
    for (const spec of [...pendingQueue(globalThis)]) {
      const result = handle.seam.register(spec)
      drained.push(`${spec.id}:${result.ok ? `gen${result.generation}` : (result as { code: string }).code}`)
    }
    pendingQueue(globalThis).length = 0
    if (drained.length > 0) updateRuntime((draft) => {
      draft.drained = drained.join(" ")
    })

    // ---- 旧设置迁移（只读旧键；回退路径见 README「旧设置迁移」）--------------------
    function legacyCandidateFromStorage(): MigrationCandidate | undefined {
      // 只读：绝不调用该 store 的 update，绝不写入或删除旧键。
      // 若平台按插件隔离存储（未验证），这里只会得到空初值——视为“读不到”，
      // 由 options.legacySettings 或手动重排兜底（见 README）。
      const [legacyStore] = context.storage.store<LegacySidebarCardSettings>(
        LEGACY_SIDEBAR_CARD_SETTINGS_KEY,
        { initial: { version: 1, order: [], hidden: [] } },
      )
      const legacy = readLegacyCandidate(legacyStore)
      return legacy ? { source: "legacy-storage", legacy } : undefined
    }

    const optionLegacy = readLegacyCandidate(context.options.legacySettings)
    const migrationCandidate: MigrationCandidate | undefined = optionLegacy
      ? { source: "options", legacy: optionLegacy }
      : legacyCandidateFromStorage()

    // ---- 设置写入：串行队列 + 记账 -------------------------------------------------
    // 并发 read-modify-write 互相覆盖是顺序丢失的常见原因；串行化后任何一次失败
    // 只记诊断、提示用户，绝不让队列中毒（否则后续写入静默失效）。
    let chain: Promise<void> = Promise.resolve()
    const pendingWrites = new Set<{ startedAt: number; slowReported: boolean }>()

    function mutate(fn: (draft: HostCardSettings) => void): Promise<void> {
      const entry = { startedAt: Date.now(), slowReported: false }
      pendingWrites.add(entry)
      const done = chain
        .catch(() => {})
        .then(() => updateSettings(fn))
        .then(
          () => {
            pendingWrites.delete(entry)
            updateRuntime((draft) => {
              draft.writeOk += 1
            })
          },
          (error: unknown) => {
            pendingWrites.delete(entry)
            updateRuntime((draft) => {
              draft.writeFail += 1
              draft.lastWriteError = describeError(error)
            })
            throw error
          },
        )
      chain = done.catch(() => {})
      return done
    }

    function toastWriteFailure(error: unknown) {
      context.ui.toast.show({
        title: "侧栏宿主",
        message: `设置写入失败：${describeError(error)}`,
        variant: "error",
        duration: 8000,
      })
    }

    /** 自动写入（无用户操作对应）：失败时明确提示，不谎报成功。 */
    function mutateQuiet(fn: (draft: HostCardSettings) => void): Promise<void> {
      return mutate(fn).catch(toastWriteFailure)
    }

    /** 新发现的卡片确定性追加到尾；没有新卡片时不产生写入。 */
    function ensureOrder(ids: readonly string[]): Promise<void> {
      const missing = ids.filter((id) => !settings.order.includes(id))
      if (missing.length === 0) return Promise.resolve()
      return mutateQuiet((draft) => {
        for (const id of missing) if (!draft.order.includes(id)) draft.order.push(id)
      })
    }

    function assignSettings(draft: HostCardSettings, next: HostCardSettings) {
      draft.version = next.version
      draft.order = next.order
      draft.hidden = next.hidden
      draft.auto = next.auto
      draft.migrated = next.migrated
    }

    function setVisible(id: string, visible: boolean): Promise<void> {
      return mutate((draft) => {
        const next = setCardVisible(normalizeHostCardSettings(draft), id, visible)
        assignSettings(draft, next)
      })
    }

    function move(id: string, direction: "up" | "down"): Promise<"ok" | "boundary" | "unknown"> {
      let result: "ok" | "boundary" | "unknown" = "unknown"
      return mutate((draft) => {
        const current = normalizeHostCardSettings(draft)
        if (!current.order.includes(id)) return
        const next = moveCard(current, id, direction)
        result = next === current ? "boundary" : "ok"
        if (result !== "ok") return
        assignSettings(draft, next)
      }).then(() => result)
    }

    // 启动时生效的设置：迁移（若可读且用户未保存过）＋ 新注册卡片追加。
    const stored = normalizeHostCardSettings(settings)
    const effective = applyCardSettings(stored, handle.seam.list().map((record) => record.id), migrationCandidate, Date.now())
    if (!sameHostCardSettings(stored, effective)) {
      void mutateQuiet((draft) => {
        assignSettings(draft, effective)
      })
    }
    updateRuntime((draft) => {
      draft.migrationNote = effective.migrated
        ? `迁移：已从 ${effective.migrated.source} 迁移 ${effective.order.length} 个位置的顺序与显隐`
        : migrationCandidate
          ? "迁移：读到旧设置但形状不可用，已按注册顺序补齐"
          : "迁移：未读到旧侧栏卡片设置（跨插件存储不可读时按 README 回退处理）"
    })

    // ---- 展示序列 -----------------------------------------------------------------
    function labelFor(record: RegisteredCard | undefined, id: string): string {
      if (record && record.title.trim().length > 0) return record.title
      if (record) return record.id
      return LEGACY_SIDEBAR_CARD_LABELS[id as LegacySidebarCardID] ?? id
    }

    function displayRecords(): RegisteredCard[] {
      const registered = registrations()
      const byID = new Map(registered.map((record) => [record.id, record]))
      const ordered = settings.order.flatMap((id) => {
        const record = byID.get(id)
        return record && !settings.hidden.includes(id) ? [record] : []
      })
      // 双保险：尚未写入顺序的新注册卡片也立即显示（追加到尾）
      const extras = registered.filter(
        (record) => !settings.order.includes(record.id) && !settings.hidden.includes(record.id),
      )
      return [...ordered, ...extras]
    }

    function knownIDs(): string[] {
      return [...new Set([...settings.order, ...registrations().map((record) => record.id)])]
    }

    function findRecord(id: string): RegisteredCard | undefined {
      return registrations().find((record) => record.id === id)
    }

    function oldestPendingWriteMs(): number {
      const now = Date.now()
      let oldest = 0
      for (const entry of pendingWrites) oldest = Math.max(oldest, now - entry.startedAt)
      return oldest
    }

    function statusText(): string {
      const regs = registrations()
      const pending = pendingQueue(globalThis).length
      const oldest = oldestPendingWriteMs()
      const orderLabels = settings.order.map((id) => {
        const record = findRecord(id)
        const hidden = settings.hidden.includes(id)
        return `${labelFor(record, id)}${hidden ? "（隐藏）" : ""}${record ? "" : "（未加载）"}`
      })
      const diagnostics: readonly SeamDiagnostic[] = handle.seam.diagnostics()
      return [
        `宿主 ${OWNER}｜seam v${SEAM_VERSION}｜${handle.adopted ? "已接管既有注册表" : "新建注册表"}`,
        `已注册 ${regs.length} 张：${regs.map((record) => `${record.id}#${record.generation}`).join(" ") || "（无）"}`,
        `顺序：[${orderLabels.join(" → ") || "（空）"}]`,
        `待接单队列：${pending} 张`,
         runtime.drained ? `启动时接管排队：${runtime.drained}` : "启动时接管排队：（无）",
         `写入：成功 ${runtime.writeOk} 失败 ${runtime.writeFail} 悬置 ${pendingWrites.size}${
          oldest > 0 ? `（最久 ${oldest}ms）` : ""
         } 超时 ${runtime.slowWrites}`,
         runtime.lastWriteError ? `最近写入错误：${runtime.lastWriteError}` : "最近写入错误：（无）",
         runtime.migrationNote,
        `诊断（最近 ${DIAGNOSTICS_PREVIEW} 条）：`,
        ...(diagnostics.length > 0
          ? diagnostics.slice(-DIAGNOSTICS_PREVIEW).map((item) => `  ${item.code}: ${item.message}`)
          : ["  （无）"]),
      ].join("\n")
    }

    // ---- 侧栏内容：只 append，不动原生侧栏；每张卡片独立 ErrorBoundary --------------
    function SidebarHost(props: { sessionID: string }) {
      return (
        <box flexDirection="column" gap={1}>
          <For each={displayRecords()}>
            {(record) => (
              <box flexDirection="column">
                <ErrorBoundary
                   fallback={() => (
                     <box flexDirection="column">
                       <text>⚠ {labelFor(record, record.id)} 渲染失败，已隔离</text>
                       <text>请检查该卡片插件的状态，不影响其他卡片</text>
                    </box>
                  )}
                >
                  {record.spec.render({ sessionID: props.sessionID }) as never}
                </ErrorBoundary>
              </box>
            )}
          </For>
        </box>
      )
    }

    const disposeSlot = context.ui.slot({
      append: "sidebar.content",
      render: (input) => <SidebarHost sessionID={input.sessionID} />,
    })

    // ---- 管理菜单：显示／隐藏／上移／下移（含暂未加载的卡片） -----------------------
    const disposeCommands = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "sidebar-host-zh.cards",
              title: "侧栏宿主：管理卡片",
              description: "显示／隐藏、上移／下移已注册的侧栏卡片",
              group: "侧栏",
              palette: true,
               slash: { name: "sidebar-cards" },
              run: async () => {
                for (;;) {
                  const ids = knownIDs()
                  if (ids.length === 0) {
                    await context.ui.dialog.alert({
                      title: "侧栏卡片",
                      message: "当前没有已注册的卡片。安装并启用卡片插件后会出现在这里。",
                    })
                    return
                  }
                  const picked = await context.ui.dialog.select<string>({
                    title: "侧栏卡片",
                    placeholder: "选择要操作的卡片",
                    options: ids.map((id, index) => {
                      const record = findRecord(id)
                      const hidden = settings.hidden.includes(id)
                      return {
                        title: `${index + 1}. ${labelFor(record, id)}${record ? "" : "（未加载）"}`,
                        value: id,
                        description: hidden ? "已隐藏" : record ? "显示中" : "未加载（偏好已保留）",
                      }
                    }),
                  })
                  if (picked === undefined) return
                  const shown = !settings.hidden.includes(picked)
                  const label = labelFor(findRecord(picked), picked)
                  const action = await context.ui.dialog.select<CardAction>({
                    title: `${label}（${shown ? "显示中" : "已隐藏"}）`,
                    options: [
                      shown
                        ? { title: "隐藏这张卡片", value: "hide", description: "不显示，但仍留在顺序里" }
                        : { title: "显示这张卡片", value: "show", description: "按顺序里的位置恢复显示" },
                      { title: "上移", value: "up", description: "和上一张交换位置" },
                      { title: "下移", value: "down", description: "和下一张交换位置" },
                      { title: "完成", value: "done" },
                    ],
                  })
                  if (action === undefined || action === "done") return
                  if (action === "hide" || action === "show") {
                    try {
                      await setVisible(picked, action === "show")
                      context.ui.toast.show({
                        title: "侧栏宿主",
                        message: `${label} ${action === "hide" ? "已隐藏" : "已显示"}`,
                        variant: "success",
                      })
                    } catch (error) {
                      toastWriteFailure(error)
                    }
                    continue
                  }
                  try {
                    const moved = await move(picked, action)
                    context.ui.toast.show({
                      title: "侧栏宿主",
                      message:
                        moved === "ok"
                          ? `${label} 已${action === "up" ? "上移" : "下移"}`
                          : moved === "boundary"
                            ? `${label} 已在边界，顺序不变`
                            : "未知卡片",
                      variant: moved === "ok" ? "success" : "info",
                    })
                  } catch (error) {
                    toastWriteFailure(error)
                  }
                }
              },
            },
            {
              id: "sidebar-host-zh.show",
              title: "侧栏宿主：显示卡片",
              description: "用法：/sidebar-host-show <卡片ID>",
              group: "侧栏",
              palette: true,
              slash: { name: "sidebar-host-show", arguments: true },
              run: async (input) => {
                const id = (input ?? "").trim()
                if (!id) {
                  context.ui.toast.show({
                    title: "侧栏宿主",
                    message: "用法：/sidebar-host-show <卡片ID>",
                    variant: "info",
                  })
                  return
                }
                try {
                  await setVisible(id, true)
                  context.ui.toast.show({
                    title: "侧栏宿主",
                    message: `${labelFor(findRecord(id), id)} 已显示`,
                    variant: "success",
                  })
                } catch (error) {
                  toastWriteFailure(error)
                }
              },
            },
            {
              id: "sidebar-host-zh.hide",
              title: "侧栏宿主：隐藏卡片",
              description: "用法：/sidebar-host-hide <卡片ID>",
              group: "侧栏",
              palette: true,
              slash: { name: "sidebar-host-hide", arguments: true },
              run: async (input) => {
                const id = (input ?? "").trim()
                if (!id) {
                  context.ui.toast.show({
                    title: "侧栏宿主",
                    message: "用法：/sidebar-host-hide <卡片ID>",
                    variant: "info",
                  })
                  return
                }
                try {
                  await setVisible(id, false)
                  context.ui.toast.show({
                    title: "侧栏宿主",
                    message: `${labelFor(findRecord(id), id)} 已隐藏`,
                    variant: "success",
                  })
                } catch (error) {
                  toastWriteFailure(error)
                }
              },
            },
            {
              id: "sidebar-host-zh.up",
              title: "侧栏宿主：卡片上移",
              description: "用法：/sidebar-host-up <卡片ID>",
              group: "侧栏",
              palette: true,
              slash: { name: "sidebar-host-up", arguments: true },
              run: async (input) => {
                const id = (input ?? "").trim()
                if (!id) {
                  context.ui.toast.show({
                    title: "侧栏宿主",
                    message: "用法：/sidebar-host-up <卡片ID>",
                    variant: "info",
                  })
                  return
                }
                try {
                  const moved = await move(id, "up")
                  context.ui.toast.show({
                    title: "侧栏宿主",
                    message:
                      moved === "ok"
                        ? `${labelFor(findRecord(id), id)} 已上移`
                        : moved === "boundary"
                          ? "已在边界，顺序不变"
                          : "未知卡片",
                    variant: moved === "ok" ? "success" : "info",
                  })
                } catch (error) {
                  toastWriteFailure(error)
                }
              },
            },
            {
              id: "sidebar-host-zh.down",
              title: "侧栏宿主：卡片下移",
              description: "用法：/sidebar-host-down <卡片ID>",
              group: "侧栏",
              palette: true,
              slash: { name: "sidebar-host-down", arguments: true },
              run: async (input) => {
                const id = (input ?? "").trim()
                if (!id) {
                  context.ui.toast.show({
                    title: "侧栏宿主",
                    message: "用法：/sidebar-host-down <卡片ID>",
                    variant: "info",
                  })
                  return
                }
                try {
                  const moved = await move(id, "down")
                  context.ui.toast.show({
                    title: "侧栏宿主",
                    message:
                      moved === "ok"
                        ? `${labelFor(findRecord(id), id)} 已下移`
                        : moved === "boundary"
                          ? "已在边界，顺序不变"
                          : "未知卡片",
                    variant: moved === "ok" ? "success" : "info",
                  })
                } catch (error) {
                  toastWriteFailure(error)
                }
              },
            },
            {
              id: "sidebar-host-zh.status",
              title: "侧栏宿主：状态与诊断",
              description: "注册、顺序、显隐、写入记账与最近诊断",
              group: "侧栏",
              palette: true,
              slash: { name: "sidebar-host-status" },
              run: async () => {
                await context.ui.dialog.alert({ title: "侧栏宿主状态", message: statusText() })
              },
            },
          ],
        }))
        return null
      },
    })

    // 注册变化（含换代、撤销）：刷新列表并把新卡片追加进持久顺序
    const disposeListener = handle.onChange(() => {
      setRegistrations(handle.seam.list())
      void ensureOrder(handle.seam.list().map((record) => record.id))
    })

    // 写入悬置看门狗：超过阈值只提示“尚未确认”，不提示成功
    const watchdog = setInterval(() => {
      const now = Date.now()
      for (const entry of pendingWrites) {
        if (!entry.slowReported && now - entry.startedAt >= SLOW_WRITE_MS) {
          entry.slowReported = true
          updateRuntime((draft) => {
            draft.slowWrites += 1
          })
          context.ui.toast.show({
            title: "侧栏宿主",
            message: `设置写入已悬置 ${Math.round(SLOW_WRITE_MS / 1000)} 秒以上仍未确认，排序可能在重启后丢失`,
            variant: "warning",
            duration: 8000,
          })
        }
      }
    }, 1000)

    context.ui.toast.show({
      title: "侧栏宿主",
      message: handle.adopted ? `seam v${SEAM_VERSION} 已接管既有注册表` : `seam v${SEAM_VERSION} 就绪`,
      variant: "success",
    })

    return () => {
      disposeListener()
      disposeSlot()
      disposeCommands()
      clearInterval(watchdog)
      // 不撤销任何卡片注册：注册归各卡片所有者，宿主换代后由新宿主代 adopt 接管。
    }
  },
})
