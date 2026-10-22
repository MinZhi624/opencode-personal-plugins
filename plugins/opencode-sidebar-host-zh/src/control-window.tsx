/**
 * /sidebar-cards 统一窗口：卡片排列显隐、布局、颜色、快捷入口，以及各卡片经
 * card-controls 提供的自有设置。
 *
 * 定位与边界：
 * - 形态是 `session.composer.top` 里的一个窗口（Quota 窗口同款槽位），键盘经 SDK 的
 *   keymap.layer + target 管理，只在本窗口持有键盘时响应，不抢占消息框的按键；
 * - 一切编辑都是内存草稿：排列／显隐经宿主 preview 立即反映到侧栏（不落盘），
 *   外观（布局＋颜色共用一份 SidebarAppearance 草稿）经宿主 effect 发布给侧栏卡片，
 *   卡片设置经 setCardControlPreview 预览；快捷入口不做实时预览，保存后生效；
 * - 一切保存都走宿主既有 cli.json 写通道：config.update 回调里用
 *   sameSidebarCards(current, baseline) 比对**原始基线**，文件被其他窗口或
 *   /sidebar-host-* 命令改过就拒绝写入，绝不覆盖外部修改；
 * - 卡片自己的设置由 owner 保存（save(values, baseline)），随后 read() 读回确认；
 * - 按页保存：dirty 时关闭／切页先问「保存／放弃／继续」，保存失败保留草稿。
 */
/** @jsxImportSource @opentui/solid */
import "@opentui/solid/preload"
import type { Context } from "@opencode/plugin/tui/context"
import type { BoxRenderable, Renderable, ScrollBoxRenderable } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import {
  changeSidebarCard,
  completeSidebarCards,
  resolveSidebarBar,
  sameSidebarCards,
  sameSidebarShortcuts,
  shortcutsOf,
  SIDEBAR_LAYOUT_LIMITS,
  SIDEBAR_SHORTCUT_CATEGORY_KEYS,
  type SidebarCardSettings,
  type SidebarLayoutNumberField,
} from "./host-settings.ts"
import { sameCardControlValues, setCardControlPreview, useCardControls } from "./card-controls.ts"
import type { CardControlField, CardControls, CardControlPreset, CardControlValue, CardControlValues } from "./card-controls.ts"
import {
  isSidebarColor,
  SIDEBAR_COLOR_ROLES,
  type SidebarAppearance,
  type SidebarColorRole,
  type SidebarLayout,
  type SidebarShortcutCategory,
  type SidebarShortcuts,
} from "./presentation.ts"
import {
  appearanceOf,
  sameAppearance,
  INHERIT_TITLE,
  ownCardBar,
  ownCardValue,
  SHAPE_CHOICES,
  shapeTitle,
  stepChoice,
  UNSET_TITLE,
  withCardBar,
  withCardValue,
} from "./ui/appearance.ts"
import {
  BAR_WIDTH_CHOICES,
  BAR_WIDTH_VALUES,
  COLOR_PRESETS,
  COLOR_ROLE_TITLES,
  colorTitle,
  dividerTitle,
  FOLLOW_THEME_TITLE,
  layoutChoices,
  layoutFieldTitle,
  LAYOUT_NUMBER_FIELDS,
  patchColorRole,
  patchLayoutField,
  QUOTA_STYLE_PRESET,
  widthTitle,
} from "./ui/appearance-fields.ts"
import {
  ONLY_MAIN_ENTRY_PRESET,
  SHORTCUT_CATEGORY_DESCRIPTIONS,
  SHORTCUT_CATEGORY_TITLES,
  SHORTCUT_CHANNEL_KEYS,
  SHORTCUT_CHANNEL_TITLES,
  type ShortcutCategoryKey,
  type ShortcutChannelKey,
} from "./ui/shortcut-fields.ts"
import { OptionRow, type OptionLine } from "./ui/option-row.tsx"
import { PageStrip, Rail, railRoomOf } from "./ui/rail.tsx"
import type { ControlWindowHost, SaveResult, WindowTheme } from "./ui/types.ts"

/** keymap 分组名（键盘帮助里显示）。 */
const KEYS = "侧栏卡片窗口"
/** 窗口标题。 */
const TITLE = "侧栏卡片"
/** 窗口默认高度（量到会话列之前先用它兜底，避免无限撑高）。 */
const DEFAULT_ROOM = 16
/** 高度下限：短终端也不把消息框挤没。上限不封顶——与 Quota 窗口一致，随屏幕伸展。 */
const ROOM_MIN = 10
/** 窄于这个宽度时左导航收成横排页面条。 */
const NARROW_WIDTH = 52
/** 渲染able id 前缀，供 scrollbox 滚动选中行。 */
const ROW_ID = "sidebar-cards."

export interface ControlWindow {
  /** 打开（或把已开的窗口拉回页面列表）。 */
  open(): void
  readonly Slot: () => JSX.Element
  /** 插件卸载时调用：清预览，不断言任何持久化状态。 */
  dispose(): void
}

type Zone = "rail" | "body"
/** 页面种类：卡片（排列显隐）、布局、颜色、快捷入口，以及各 provider 的卡片设置页。 */
type PageKind = "arrangement" | "layout" | "colors" | "shortcuts" | "control"

interface ControlPage {
  readonly id: string
  readonly kind: PageKind
  readonly title: string
  /** control 页对应的卡片 id（= CardControls.id）。 */
  readonly cardID?: string
  /** 页面级标识：卡片已隐藏／未加载。 */
  readonly marker?: "hidden" | "unloaded"
  /** 提供方已撤销：页面保留但不可用，草稿不能保存。 */
  readonly gone?: boolean
}

interface ProviderPageState {
  status: "idle" | "loading" | "ready" | "error"
  baseline?: CardControlValues
  draft?: CardControlValues
  dirty: boolean
  error?: string
}

export function createControlWindow(host: ControlWindowHost): ControlWindow {
  const context = host.context
  /** 本窗口的预览属主令牌：setCardControlPreview 只清自己发过的预览，
   *  旧宿主／旧窗口的迟到 cleanup 不会误清新窗口的草稿。 */
  const previewOwner = {}
  /** 卡片插件随时注册／撤销 controls，这里跟随注册表。 */
  const providers = useCardControls()
  const [opened, setOpened] = createSignal(false)
  const [page, setPage] = createSignal("arrangement")
  const [zone, setZone] = createSignal<Zone>("rail")
  const [selected, setSelected] = createSignal("")
  const [baseline, setBaseline] = createSignal<SidebarCardSettings>({ order: [], hidden: [] })
  /** 布局＋颜色两页共用一份外观草稿：各自页面只编辑自己的字段子集，脏标记按整份草稿算。 */
  const [appearance, setAppearance] = createSignal<SidebarAppearance>({})
  const [cardsDirty, setCardsDirty] = createSignal(false)
  const [appearanceDirty, setAppearanceDirty] = createSignal(false)
  /** 快捷入口草稿：一份 SidebarShortcuts（undefined 类别＝缺省显示），无实时预览，保存后生效。 */
  const [shortcuts, setShortcuts] = createSignal<SidebarShortcuts>({})
  const [shortcutsDirty, setShortcutsDirty] = createSignal(false)
  /** 颜色预设行的光标（整体与每卡覆盖行共用）。 */
  const [colorPreset, setColorPreset] = createSignal(0)
  const [busy, setBusy] = createSignal(false)
  const [providerState, setProviderState] = createSignal<Map<string, ProviderPageState>>(new Map())
  /** 窗口盒与滚动框：由 Window 组件的 ref 赋值，关闭／滚动时用。 */
  let windowBox: BoxRenderable | undefined
  let scroll: ScrollBoxRenderable | undefined
  /** 打开前持有键盘的元素（消息框），关闭时还回去。 */
  let focusBefore: Renderable | null = null
  const [opening, setOpening] = createSignal(false)
  /** 窗口生命周期代号：每次打开／关闭／卸载都递增；迟到响应据此作废，不复用读取序号。 */
  let generation = 0
  /** 每个 provider 的读取序号：只认同一代号内的最新一次回答。 */
  const reads = new Map<string, number>()
  /** 待确认（dirty 询问）中：与 busy 一起挡住新的草稿动作，避免并发对话框竞争。 */
  const [confirming, setConfirming] = createSignal(false)
  /** 曾出现过的 provider id：提供方撤销后页面仍保留（说明＋放弃），不静默丢草稿。 */
  const [knownControls, setKnownControls] = createSignal<string[]>([])

  /** 保存／询问／打开进行中：入口一律用它挡重入。 */
  function blocked(): boolean {
    return busy() || confirming() || opening()
  }

  function theme(): WindowTheme {
    return context.theme
  }

  function toast(variant: "info" | "success" | "warning" | "error", message: string): void {
    context.ui.toast.show({ title: TITLE, message, variant, duration: variant === "error" ? 8000 : 5000 })
  }

  function errorText(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error)
    return text.slice(0, 160) || "未知错误"
  }

  function providerByID(id: string | undefined): CardControls | undefined {
    return id === undefined ? undefined : providers().find((controls) => controls.id === id)
  }

  function loadedIDs(): readonly string[] {
    return host.registrations().map((record) => record.id)
  }

  function isLoaded(id: string): boolean {
    return loadedIDs().includes(id)
  }

  // ---------------------------------------------------------------- 页面模型

  function pages(): ControlPage[] {
    const list: ControlPage[] = [
      { id: "arrangement", kind: "arrangement", title: "卡片" },
      { id: "layout", kind: "layout", title: "布局" },
      { id: "colors", kind: "colors", title: "颜色" },
      { id: "shortcuts", kind: "shortcuts", title: "快捷入口" },
    ]
    const current = host.fullSettings()
    for (const id of knownControls()) {
      const controls = providerByID(id)
      const marker: ControlPage["marker"] = current.hidden.includes(id)
        ? "hidden"
        : isLoaded(id)
          ? undefined
          : "unloaded"
      list.push({
        id: `control:${id}`,
        kind: "control",
        title: controls?.title ?? host.labelFor(id),
        cardID: id,
        marker,
        gone: controls === undefined,
      })
    }
    return list
  }

  function currentPage(): ControlPage {
    return pages().find((item) => item.id === page()) ?? pages()[0]!
  }

  function railItems(): { key: string; label: string }[] {
    return pages().map((item) => ({ key: item.id, label: item.title }))
  }

  function pageDirty(id: string): boolean {
    if (id === "arrangement") return cardsDirty()
    // 布局与颜色共用一份草稿、一个脏标记：任一页的未保存修改在另一页同样可见，
    // 避免「颜色页改了、布局页保存时被顺带写盘」却不提示。
    if (id === "layout" || id === "colors") return appearanceDirty()
    if (id === "shortcuts") return shortcutsDirty()
    const state = providerState().get(id.slice("control:".length))
    return state?.dirty ?? false
  }

  // ---------------------------------------------------------------- 排列页

  function arrangementChanged(next: SidebarCardSettings): boolean {
    const saved = completeSidebarCards(baseline(), loadedIDs())
    return !sameSidebarCards({ order: next.order, hidden: next.hidden }, { order: saved.order, hidden: saved.hidden })
  }

  function moveCard(id: string, delta: number): void {
    if (blocked()) return
    const next = changeSidebarCard(host.fullSettings(), id, delta < 0 ? "up" : "down")
    if (next.result !== "ok") return
    host.previewArrangement(next.settings)
    setCardsDirty(arrangementChanged(next.settings))
  }

  function toggleCard(id: string): void {
    if (blocked()) return
    const hidden = host.fullSettings().hidden.includes(id)
    const next = changeSidebarCard(host.fullSettings(), id, hidden ? "show" : "hide")
    host.previewArrangement(next.settings)
    setCardsDirty(arrangementChanged(next.settings))
  }

  function arrangementLines(): OptionLine[] {
    const current = host.fullSettings()
    const lines: OptionLine[] = current.order.map((id, index) => {
      const hidden = current.hidden.includes(id)
      const loaded = isLoaded(id)
      return {
        id: `card:${id}`,
        title: host.labelFor(id),
        value: () => `${index + 1} · ${hidden ? "已隐藏" : loaded ? "显示中" : "未加载"}`,
        tone: hidden ? ("warning" as const) : loaded ? ("success" as const) : ("muted" as const),
        note: () => (hidden ? "已隐藏" : loaded ? undefined : "未加载"),
        cycle: (delta: number) => moveCard(id, delta),
        run: () => toggleCard(id),
      }
    })
    const file = host.fileState()
    lines.push({
      id: "action:import",
      group: "操作",
      title: "导入旧设置",
      value: () => "▸",
      run: () => void runImportAction(),
      note: () => (file.configured ? "已有配置，不覆盖" : "预览后导入"),
    })
    lines.push({
      id: "action:reread",
      title: "重新读取",
      value: () => "▸",
      run: () => void rereadAction(),
      note: () => "外部改动后刷新基线",
    })
    return lines
  }

  // ---------------------------------------------------------------- 布局页

  /** 草稿提交：写草稿、按原始基线算脏、把有效草稿发布给侧栏预览。 */
  function commitAppearance(next: SidebarAppearance): void {
    setAppearance(next)
    const dirty = !sameAppearance(next, appearanceOf(baseline()))
    setAppearanceDirty(dirty)
    host.setAppearanceDraft(dirty ? next : undefined)
  }

  function cycleBar(delta: number): void {
    if (blocked()) return
    const draft = appearance()
    commitAppearance({ ...draft, bar: stepChoice(SHAPE_CHOICES, draft.bar, delta) })
  }

  function cycleBars(id: string, delta: number): void {
    if (blocked()) return
    const draft = appearance()
    const shape = stepChoice(SHAPE_CHOICES, ownCardBar(draft.bars, id), delta)
    // 自有属性写入：`__proto__` 等键同样落成数据属性，不污染原型链。
    commitAppearance({ ...draft, bars: withCardBar(draft.bars, id, shape) })
  }

  function cycleBarWidth(delta: number): void {
    if (blocked()) return
    const draft = appearance()
    commitAppearance({ ...draft, barWidth: stepChoice(BAR_WIDTH_VALUES, draft.barWidth, delta) })
  }

  function cycleBarWidths(id: string, delta: number): void {
    if (blocked()) return
    const draft = appearance()
    const width = stepChoice(BAR_WIDTH_CHOICES, ownCardValue(draft.barWidths, id), delta)
    commitAppearance({ ...draft, barWidths: withCardValue(draft.barWidths, id, width) })
  }

  function cycleLayout(field: SidebarLayoutNumberField | "divider", delta: number): void {
    if (blocked()) return
    const draft = appearance()
    const entry = draft.layout
    const current = field === "divider" ? entry?.divider : entry?.[field]
    commitAppearance({ ...draft, layout: patchLayoutField(entry, field, stepChoice(layoutChoices(field), current, delta)) })
  }

  function cycleCardLayout(id: string, field: SidebarLayoutNumberField | "divider", delta: number): void {
    if (blocked()) return
    const draft = appearance()
    const entry = ownCardValue(draft.cardLayout, id)
    const current = field === "divider" ? entry?.divider : entry?.[field]
    commitAppearance({
      ...draft,
      cardLayout: withCardValue(draft.cardLayout, id, patchLayoutField(entry, field, stepChoice(layoutChoices(field), current, delta))),
    })
  }

  /** 真正渲染进度条的卡片：只给它们形状／宽度控件。 */
  const SHAPE_CARD_IDS: readonly string[] = ["quota", "sessionOverview"]
  /** 进度条宽度由这些卡片自身消费；额度宽度归额度设置管理。 */
  const WIDTH_CARD_IDS: readonly string[] = ["sessionOverview"]
  /** 行内布局（缩进／附加行距／行名宽度／分隔线）由这些卡片消费。 */
  const LAYOUT_CARD_IDS: readonly string[] = ["sessionOverview", "subagents", "skill"]
  /** 角色颜色由这些卡片消费；额度颜色归额度设置管理。 */
  const COLOR_CARD_IDS: readonly string[] = ["sessionOverview", "subagents", "skill"]
  /** 各卡片实际消费的布局字段：卡片间距只作用于卡片之间，行名宽度只被子代理使用。 */
  const LAYOUT_FIELDS_BY_CARD: Readonly<Record<string, readonly SidebarLayoutNumberField[]>> = {
    sessionOverview: ["lineGap", "indent"],
    subagents: ["lineGap", "indent", "labelWidth"],
    skill: ["lineGap", "indent"],
  }
  /** 各卡片实际使用的颜色角色。 */
  const COLOR_ROLES_BY_CARD: Readonly<Record<string, readonly SidebarColorRole[]>> = {
    sessionOverview: ["title", "body", "muted", "divider", "bar", "warn"],
    subagents: ["title", "body", "muted", "divider", "warn"],
    skill: ["title", "body", "muted", "divider"],
  }

  function loadedCards(ids: readonly string[]): string[] {
    return host.fullSettings().order.filter((id) => isLoaded(id) && ids.includes(id))
  }

  /** 有卡片覆盖控件的卡片（隐藏的也可设置），按完整序列排列。 */
  function overrideIDs(): string[] {
    return loadedCards([...new Set([...SHAPE_CARD_IDS, ...WIDTH_CARD_IDS, ...LAYOUT_CARD_IDS, ...COLOR_CARD_IDS])])
  }

  /** 其他卡片已保存的覆盖偏好：保留在草稿里（schema 不丢），但不展示无效控件。 */
  function preservedOverrides(draft: SidebarAppearance): string[] {
    const ids = new Set<string>()
    for (const record of [draft.bars, draft.barWidths, draft.cardLayout, draft.cardColors]) {
      for (const id of Object.keys(record ?? {})) ids.add(id)
    }
    return [...ids].filter((id) => !overrideIDs().includes(id))
  }

  /** 单卡布局字段的来源：卡片覆盖 › 整体 › 未设置。 */
  function layoutNote(entry: SidebarLayout | undefined, field: SidebarLayoutNumberField | "divider"): string {
    const own = field === "divider" ? entry?.divider : entry?.[field]
    if (own !== undefined) return "卡片覆盖"
    const shared = appearance().layout
    const base = field === "divider" ? shared?.divider : shared?.[field]
    return base !== undefined ? "整体" : ""
  }

  function applyQuotaPreset(): void {
    if (blocked()) return
    const draft = appearance()
    commitAppearance({
      ...draft,
      bar: QUOTA_STYLE_PRESET.bar,
      barWidth: QUOTA_STYLE_PRESET.barWidth,
      layout: { ...QUOTA_STYLE_PRESET.layout },
      // 颜色清空＝跟随主题；单卡颜色偏好一并清空。
      colors: undefined,
      cardColors: undefined,
    })
  }

  function layoutLines(): OptionLine[] {
    const draft = appearance()
    const draftSettings: SidebarCardSettings = { order: [], hidden: [], ...appearanceOf(draft) }
    const lines: OptionLine[] = [
      {
        id: "layout:preset",
        group: "预设",
        title: "Quota 风格",
        value: () => "▸",
        run: () => applyQuotaPreset(),
        note: () => "细线 · 间距 1 · 行名 12 · 分隔线",
      },
      {
        id: "layout:bar",
        group: "整体",
        title: "进度条形状",
        value: () => shapeTitle(draft.bar, UNSET_TITLE),
        cycle: (delta: number) => cycleBar(delta),
        note: () => "额度／上下文；none 只隐藏图形",
      },
      {
        id: "layout:barWidth",
        title: "进度条宽度",
        value: () => widthTitle(draft.barWidth, UNSET_TITLE),
        cycle: (delta: number) => cycleBarWidth(delta),
        note: () => "固定列数或填满；额度宽度见额度设置",
      },
    ]
    for (const field of LAYOUT_NUMBER_FIELDS) {
      lines.push({
        id: `layout:${field.key}`,
        title: field.title,
        value: () => layoutFieldTitle(field.key, draft.layout?.[field.key], UNSET_TITLE),
        cycle: (delta: number) => cycleLayout(field.key, delta),
        note: () =>
          `${SIDEBAR_LAYOUT_LIMITS[field.key].min} – ${SIDEBAR_LAYOUT_LIMITS[field.key].max} ${field.unit}`,
      })
    }
    lines.push({
      id: "layout:divider",
      title: "标题分隔线",
      value: () => dividerTitle(draft.layout?.divider, UNSET_TITLE),
      cycle: (delta: number) => cycleLayout("divider", delta),
      note: () => "标题下方",
    })
    for (const id of overrideIDs()) {
      const withShape = SHAPE_CARD_IDS.includes(id)
      const withWidth = WIDTH_CARD_IDS.includes(id)
      const withLayout = LAYOUT_CARD_IDS.includes(id)
      let first = true
      const group = () => {
        const value = first ? `卡片覆盖 · ${host.labelFor(id)}` : undefined
        first = false
        return value
      }
      if (withShape) {
        const resolvedBar = resolveSidebarBar(draftSettings, id)
        const barSource = resolvedBar.source === "card-override" ? "卡片覆盖" : resolvedBar.source === "shared" ? "整体" : "卡片自身"
        lines.push({
          id: `layout:bars:${id}`,
          group: group(),
          title: "进度条形状",
          value: () => shapeTitle(ownCardBar(draft.bars, id), INHERIT_TITLE),
          cycle: (delta: number) => cycleBars(id, delta),
          note: () => barSource,
        })
      }
      if (withWidth) {
        const width = ownCardValue(draft.barWidths, id)
        lines.push({
          id: `layout:barWidths:${id}`,
          group: group(),
          title: "进度条宽度",
          value: () => widthTitle(width, INHERIT_TITLE),
          cycle: (delta: number) => cycleBarWidths(id, delta),
          note: () => (width !== undefined ? "卡片覆盖" : draft.barWidth !== undefined ? "整体" : "卡片自身"),
        })
      }
      if (withLayout) {
        const entry = ownCardValue(draft.cardLayout, id)
        for (const field of LAYOUT_NUMBER_FIELDS) {
          // 卡片间距是卡片之间的全局值；其余字段按卡片实际支持的范围显示。
          if (field.key === "gap" || !LAYOUT_FIELDS_BY_CARD[id]?.includes(field.key)) continue
          lines.push({
            id: `layout:card:${id}:${field.key}`,
            group: group(),
            title: field.title,
            value: () => layoutFieldTitle(field.key, entry?.[field.key], INHERIT_TITLE),
            cycle: (delta: number) => cycleCardLayout(id, field.key, delta),
            note: () => layoutNote(entry, field.key),
          })
        }
        lines.push({
          id: `layout:card:${id}:divider`,
          group: group(),
          title: "标题分隔线",
          value: () => dividerTitle(entry?.divider, INHERIT_TITLE),
          cycle: (delta: number) => cycleCardLayout(id, "divider", delta),
          note: () => layoutNote(entry, "divider"),
        })
      }
      if (id === "quota") {
        lines.push({
          id: "layout:quota:note",
          info: true,
          title: "其余项见额度设置。",
          value: () => "",
        })
      }
    }
    const preserved = preservedOverrides(draft)
    lines.push({
      id: "layout:info",
      info: true,
      title: `优先级：覆盖 › 整体 › 卡片自身。${preserved.length > 0 ? ` 已保留其他偏好：${preserved.join("、")}。` : ""}`,
      value: () => "",
    })
    return lines
  }

  // ---------------------------------------------------------------- 颜色页

  function applyColorPreset(index: number, cardID?: string): void {
    if (blocked()) return
    const preset = COLOR_PRESETS[index] ?? COLOR_PRESETS[0]!
    const draft = appearance()
    if (cardID === undefined) commitAppearance({ ...draft, colors: { ...preset.colors } })
    else commitAppearance({ ...draft, cardColors: withCardValue(draft.cardColors, cardID, { ...preset.colors }) })
  }

  function cycleColorPreset(delta: number, cardID?: string): void {
    if (blocked()) return
    const index = stepChoice([0, 1, 2], colorPreset(), delta)
    setColorPreset(index)
    applyColorPreset(index, cardID)
  }

  function setSharedColor(role: SidebarColorRole, value: string | undefined): void {
    const draft = appearance()
    commitAppearance({ ...draft, colors: patchColorRole(draft.colors, role, value) })
  }

  function setCardColor(id: string, role: SidebarColorRole, value: string | undefined): void {
    const draft = appearance()
    commitAppearance({ ...draft, cardColors: withCardValue(draft.cardColors, id, patchColorRole(ownCardValue(draft.cardColors, id), role, value)) })
  }

  /** 自定义颜色输入：只认 #RGB／#RRGGBB，非法明确报错并保持原值，绝不钳制。 */
  async function promptColor(role: SidebarColorRole, cardID?: string): Promise<void> {
    if (blocked()) return
    const draft = appearance()
    const entry = cardID === undefined ? draft.colors : ownCardValue(draft.cardColors, cardID)
    const started = generation
    let answer: string | undefined
    setConfirming(true)
    try {
      answer = await context.ui.dialog.prompt({
        title: `${COLOR_ROLE_TITLES[role]}颜色`,
        description: "输入 #RGB 或 #RRGGBB；取消保持",
        value: entry?.[role] ?? "",
      })
    } finally {
      setConfirming(false)
    }
    // 窗口已换代：这次回答不属于当前窗口，什么都不改。
    if (started !== generation) return
    if (answer === undefined) return
    const text = answer.trim()
    if (!isSidebarColor(text)) {
      toast("error", `「${text}」不是合法颜色（#RGB 或 #RRGGBB），已保持原值`)
      return
    }
    if (cardID === undefined) setSharedColor(role, text)
    else setCardColor(cardID, role, text)
  }

  function colorsLines(): OptionLine[] {
    const draft = appearance()
    const lines: OptionLine[] = [
      {
        id: "colors:preset",
        group: "预设",
        title: "颜色预设",
        value: () => COLOR_PRESETS[colorPreset()]!.title,
        cycle: (delta: number) => cycleColorPreset(delta),
        run: () => applyColorPreset(colorPreset()),
        note: () => "整套写入草稿",
      },
    ]
    let grouped = false
    for (const role of SIDEBAR_COLOR_ROLES) {
      lines.push({
        id: `colors:${role}`,
        group: grouped ? undefined : "整体",
        title: COLOR_ROLE_TITLES[role],
        value: () => colorTitle(draft.colors?.[role], FOLLOW_THEME_TITLE),
        // ← 回到跟随主题（删值）；→／enter 输入自定义颜色。
        cycle: (delta: number) => {
          if (delta < 0) setSharedColor(role, undefined)
          else void promptColor(role)
        },
        run: () => void promptColor(role),
      })
      grouped = true
    }
    for (const id of loadedCards(COLOR_CARD_IDS)) {
      const entry = ownCardValue(draft.cardColors, id)
      lines.push({
        id: `colors:card:${id}:preset`,
        group: `卡片覆盖 · ${host.labelFor(id)}`,
        title: "颜色预设",
        value: () => COLOR_PRESETS[colorPreset()]!.title,
        cycle: (delta: number) => cycleColorPreset(delta, id),
        run: () => applyColorPreset(colorPreset(), id),
        note: () => "整套写入此卡",
      })
      for (const role of COLOR_ROLES_BY_CARD[id] ?? SIDEBAR_COLOR_ROLES) {
        lines.push({
          id: `colors:card:${id}:${role}`,
          title: COLOR_ROLE_TITLES[role],
          value: () => colorTitle(entry?.[role], INHERIT_TITLE),
          cycle: (delta: number) => {
            if (delta < 0) setCardColor(id, role, undefined)
            else void promptColor(role, id)
          },
          run: () => void promptColor(role, id),
        })
      }
    }
    lines.push({
      id: "colors:info",
      info: true,
      title: "← 跟随主题 · → 输入颜色；额度颜色见额度设置",
      value: () => "",
    })
    return lines
  }

  // ---------------------------------------------------------------- 快捷入口页

  /** 快捷入口的原始基线（缺省类别＝显示；未设置即 undefined）。 */
  function shortcutsBaseline(): SidebarShortcuts | undefined {
    return shortcutsOf(baseline())
  }

  function commitShortcuts(next: SidebarShortcuts | undefined): void {
    setShortcuts(next ?? {})
    setShortcutsDirty(!sameSidebarShortcuts(next, shortcutsBaseline()))
  }

  function toggleShortcut(key: ShortcutCategoryKey, channel: ShortcutChannelKey): void {
    if (blocked()) return
    const draft = shortcuts()
    const visible = draft[key]?.[channel] !== false
    const category: SidebarShortcutCategory = { ...draft[key], [channel]: !visible }
    const next: SidebarShortcuts = { ...draft, [key]: category }
    // 两条通道都回到缺省（显示）时删掉整个类别：与「未设置」保持同一持久化语义。
    if (category.slash !== false && category.palette !== false) delete next[key]
    // 过一次 shortcutsOf：清掉空类别，全缺省时与未设置判为同一状态。
    commitShortcuts(shortcutsOf({ order: [], hidden: [], shortcuts: next }))
  }

  function applyOnlyMainPreset(): void {
    if (blocked()) return
    commitShortcuts(shortcutsOf({ order: [], hidden: [], shortcuts: ONLY_MAIN_ENTRY_PRESET }))
  }

  function shortcutsLines(): OptionLine[] {
    const draft = shortcuts()
    const lines: OptionLine[] = [
      {
        id: "shortcuts:preset",
        group: "预设",
        title: "仅主入口",
        value: () => "▸",
        run: () => applyOnlyMainPreset(),
        note: () => "关闭三类附属入口",
      },
      { id: "shortcuts:info", info: true, title: "主入口常显；以下为附属入口。", value: () => "" },
    ]
    for (const key of SIDEBAR_SHORTCUT_CATEGORY_KEYS) {
      let first = true
      for (const channel of SHORTCUT_CHANNEL_KEYS) {
        lines.push({
          id: `shortcuts:${key}:${channel}`,
          group: first ? SHORTCUT_CATEGORY_TITLES[key] : undefined,
          title: SHORTCUT_CHANNEL_TITLES[channel],
          value: () => (draft[key]?.[channel] === false ? "关" : "开"),
          cycle: () => toggleShortcut(key, channel),
          run: () => toggleShortcut(key, channel),
          note: () => (first ? SHORTCUT_CATEGORY_DESCRIPTIONS[key] : undefined),
        })
        first = false
      }
    }
    lines.push({
      id: "shortcuts:note",
      info: true,
      title: "关闭后不再注册；保存后生效。",
      value: () => "",
    })
    return lines
  }

  // ---------------------------------------------------------------- 卡片设置页

  function patchProvider(id: string, patch: Partial<ProviderPageState>): void {
    setProviderState((current) => {
      const next = new Map(current)
      const previous = next.get(id) ?? { status: "idle" as const, dirty: false }
      next.set(id, { ...previous, ...patch })
      return next
    })
  }

  /** 读一个 provider 的值：窗口初始化与切页时调用，只认同一代号内的最新一次回答。 */
  function readProvider(id: string): Promise<void> {
    const controls = providerByID(id)
    if (!controls) return Promise.resolve()
    const started = generation
    const request = (reads.get(id) ?? 0) + 1
    reads.set(id, request)
    patchProvider(id, { status: "loading", error: undefined })
    return (async () => {
      try {
        const values = await controls.read()
        // 窗口换代、更新的读取、或提供方换代：迟到回答一律作废。
        if (started !== generation || reads.get(id) !== request || providerByID(id) !== controls) return
        patchProvider(id, { status: "ready", baseline: values, draft: { ...values }, dirty: false, error: undefined })
      } catch (error) {
        if (started !== generation || reads.get(id) !== request || providerByID(id) !== controls) return
        patchProvider(id, { status: "error", error: errorText(error) })
      }
    })()
  }

  function displayValue(field: CardControlField, value: CardControlValue | undefined): string {
    if (value === undefined) return "—"
    const choice = field.choices.find((item) => item.value === value)
    if (choice) return choice.title
    if (typeof value === "boolean") return value ? "开" : "关"
    return String(value)
  }

  function fieldNote(field: CardControlField, value: CardControlValue | undefined): string {
    if (field.choices.length > 0 && !field.choices.some((item) => item.value === value)) {
      return "当前值为自定义值（不受建议项限制）"
    }
    if (field.min !== undefined || field.max !== undefined) {
      return `范围 ${field.min ?? "-∞"} – ${field.max ?? "+∞"}`
    }
    return ""
  }

  function cycleField(controls: CardControls, field: CardControlField, delta: number): void {
    if (blocked()) return
    const state = providerState().get(controls.id)
    if (!state?.draft) return
    const current = state.draft[field.key]
    let next: CardControlValue
    if (field.choices.length > 0) {
      const values = field.choices.map((item) => item.value)
      next = stepChoice(values, current, delta)
    } else if (typeof current === "number") {
      const min = field.min ?? Number.NEGATIVE_INFINITY
      const max = field.max ?? Number.POSITIVE_INFINITY
      next = Math.max(min, Math.min(max, current + (delta < 0 ? -1 : 1)))
      if (next === current) return
    } else if (typeof current === "boolean") {
      next = !current
    } else return
    const draft: CardControlValues = { ...state.draft, [field.key]: next }
    const dirty = !sameCardControlValues(draft, state.baseline ?? {})
    patchProvider(controls.id, { draft, dirty })
    setCardControlPreview(controls.id, dirty ? draft : undefined, previewOwner)
  }

  /** 命名预设：整份写进本页草稿并按基线重算脏，同时刷新预览；保存仍走 owner 的 save。 */
  function applyPreset(controls: CardControls, preset: CardControlPreset): void {
    if (blocked()) return
    const state = providerState().get(controls.id)
    if (!state?.draft) return
    const draft: CardControlValues = { ...state.draft, ...preset.values }
    const dirty = !sameCardControlValues(draft, state.baseline ?? {})
    patchProvider(controls.id, { draft, dirty })
    setCardControlPreview(controls.id, dirty ? draft : undefined, previewOwner)
  }

  function controlLines(controls: CardControls): OptionLine[] {
    const state = providerState().get(controls.id)
    if (!state || state.status === "idle" || state.status === "loading") {
      return [{ id: "loading", info: true, title: "正在读取卡片设置…", value: () => "" }]
    }
    if (state.status === "error") {
      return [
        { id: "error", info: true, warning: true, title: `读取失败：${state.error ?? "未知错误"}`, value: () => "" },
        { id: "retry", action: true, title: "重新读取", value: () => "", run: () => void readProvider(controls.id) },
      ]
    }
    const lines: OptionLine[] = controls.fields.map((field) => {
      const value = state.draft?.[field.key]
      const note = fieldNote(field, value)
      return {
        id: `field:${field.key}`,
        title: field.title,
        value: () => displayValue(field, value),
        // 提供方自带的字段说明并入行下注释（范围／口径与字段行同显示）。
        note: () => (field.description ? (note ? `${note}；${field.description}` : field.description) : note),
        cycle: (delta: number) => cycleField(controls, field, delta),
        // 有界数值字段：enter 输入自定义值；其余行 enter 仍向前循环建议值。
        run: boundedNumber(field, value) ? () => void promptField(controls, field) : undefined,
      }
    })
    const presets = controls.presets ?? []
    for (const [index, preset] of presets.entries()) {
      lines.push({
        id: `preset:${index}`,
        group: index === 0 ? (controls.fields.length > 0 ? "预设" : undefined) : undefined,
        title: preset.title,
        value: () => "▸",
        run: () => applyPreset(controls, preset),
        note: () => preset.description,
      })
    }
    const actions = controls.actions ?? []
    for (const [index, action] of actions.entries()) {
      lines.push({
        id: `action:${index}`,
        group: index === 0 ? "操作" : undefined,
        action: true,
        title: action.title,
        value: () => "",
        run: () => void runAction(controls, action),
      })
    }
    if (controls.note) {
      lines.push({ id: "note", info: true, title: controls.note, value: () => "" })
    }
    if (state.error) {
      lines.push({ id: "readback", info: true, warning: true, title: state.error, value: () => "" })
    }
    return lines
  }

  /** 提供方已撤销的页面：保留并说明，草稿不能保存，只能放弃。 */
  function goneLines(cardID: string): OptionLine[] {
    const state = providerState().get(cardID)
    return [
      { id: "gone", info: true, warning: true, title: "该卡片的设置提供方已卸载（插件停用或换代）。", value: () => "" },
      {
        id: "gone-draft",
        info: true,
        title: state?.dirty
          ? "本页有未保存草稿：提供方不在，无法保存；只能放弃后离开。"
          : "没有未保存草稿，可以直接离开本页。",
        value: () => "",
      },
      {
        id: "gone-discard",
        action: true,
        title: "放弃本页草稿",
        value: () => "",
        run: () => {
          discardPage(`control:${cardID}`)
          toast("info", "已放弃本页草稿")
        },
      },
    ]
  }

  function bodyLines(): OptionLine[] {
    const current = currentPage()
    if (current.kind === "arrangement") return arrangementLines()
    if (current.kind === "layout") return layoutLines()
    if (current.kind === "colors") return colorsLines()
    if (current.kind === "shortcuts") return shortcutsLines()
    const controls = providerByID(current.cardID)
    if (!controls) return goneLines(current.cardID ?? "")
    return controlLines(controls)
  }

  function selectableIDs(): string[] {
    return bodyLines().filter((line) => !line.info).map((line) => line.id)
  }

  // ---------------------------------------------------------------- 焦点与滚动

  function scrollIntoView(id: string): void {
    queueMicrotask(() => scroll?.scrollChildIntoView(`${ROW_ID}${id}`))
  }

  function scrollBy(delta: number): void {
    scroll?.scrollBy(delta)
  }

  function enterBody(): void {
    setZone("body")
    const ids = selectableIDs()
    if (!ids.includes(selected())) {
      const first = ids[0]
      if (first !== undefined) {
        setSelected(first)
        scrollIntoView(first)
      }
    }
  }

  function moveSelection(delta: number): void {
    const ids = selectableIDs()
    if (ids.length === 0) {
      setSelected("")
      return
    }
    const index = ids.indexOf(selected())
    const next = index === -1 ? (delta < 0 ? ids.length - 1 : 0) : index + delta
    if (next < 0 || next >= ids.length) {
      scrollBy(delta)
      return
    }
    const id = ids[next]!
    setSelected(id)
    scrollIntoView(id)
  }

  /** space／enter 或点击值列：优先动作，其次向前循环。 */
  function useLine(delta: number): void {
    const line = bodyLines().find((item) => item.id === selected())
    if (!line || line.info) return
    if (delta !== 0) {
      line.cycle?.(delta)
      return
    }
    if (line.run) line.run()
    else line.cycle?.(1)
  }

  // ---------------------------------------------------------------- 草稿结算

  /** 数值字段且有界：enter 走对话框输入自定义值（不钳制，非法明确报错）。 */
  function boundedNumber(field: CardControlField, value: CardControlValue | undefined): boolean {
    return typeof value === "number" && (field.min !== undefined || field.max !== undefined)
  }

  /** 自定义数值输入：范围内才接受；非法／越界明确报错并保持原值，绝不钳制。 */
  async function promptField(controls: CardControls, field: CardControlField): Promise<void> {
    if (blocked()) return
    const state = providerState().get(controls.id)
    if (!state?.draft) return
    const current = state.draft[field.key]
    const started = generation
    let answer: string | undefined
    setConfirming(true)
    try {
      answer = await context.ui.dialog.prompt({
        title: field.title,
        description: `输入 ${field.min ?? "-∞"} – ${field.max ?? "+∞"} 之间的${field.integer ? "整数" : "数值"}；取消保持原值`,
        value: current === undefined ? "" : String(current),
      })
    } finally {
      setConfirming(false)
    }
    if (started !== generation || providerByID(controls.id) !== controls) return
    if (answer === undefined) return
    const text = answer.trim()
    if (text.length === 0) {
      toast("error", "没有输入值，已保持原值")
      return
    }
    const value = Number(text)
    if (!Number.isFinite(value)) {
      toast("error", `「${text}」不是有效数值，已保持原值`)
      return
    }
    if (field.integer && !Number.isSafeInteger(value)) {
      toast("error", "请输入安全范围内的整数，已保持原值")
      return
    }
    if (field.min !== undefined && value < field.min) {
      toast("error", `小于下限 ${field.min}，已保持原值（不自动钳制）`)
      return
    }
    if (field.max !== undefined && value > field.max) {
      toast("error", `大于上限 ${field.max}，已保持原值（不自动钳制）`)
      return
    }
    const draft: CardControlValues = { ...state.draft, [field.key]: value }
    const dirty = !sameCardControlValues(draft, state.baseline ?? {})
    patchProvider(controls.id, { draft, dirty })
    setCardControlPreview(controls.id, dirty ? draft : undefined, previewOwner)
  }

  async function saveProviderPage(id: string): Promise<boolean> {
    const controls = providerByID(id)
    const state = providerState().get(id)
    if (!controls || !state?.draft || !state.baseline) {
      toast("error", "这一页没有可保存的设置")
      return false
    }
    const started = generation
    try {
      await controls.save(state.draft, state.baseline)
    } catch (error) {
      toast("error", `保存失败：${errorText(error)}；草稿已保留`)
      return false
    }
    let confirmed: CardControlValues
    try {
      confirmed = await controls.read()
    } catch (error) {
      toast("error", `已保存，但读回失败：${errorText(error)}；草稿已保留`)
      return false
    }
    // 窗口已换代或提供方已换代：这次回答不属于当前窗口，什么都不改。
    if (started !== generation || providerByID(id) !== controls) return false
    if (!sameCardControlValues(confirmed, state.draft)) {
      // 不暗中接受外部修改为新基线；保留原草稿，要求用户明确重新读取。
      patchProvider(id, { status: "ready", dirty: true, error: "读回的值与草稿不一致" })
      toast("error", "已保存，但读回的值与草稿不一致；草稿已保留，请检查后再保存")
      return false
    }
    patchProvider(id, { status: "ready", baseline: confirmed, draft: { ...confirmed }, dirty: false, error: undefined })
    setCardControlPreview(id, undefined, previewOwner)
    toast("success", "已保存")
    return true
  }

  async function savePage(id: string): Promise<boolean> {
    const current = pages().find((item) => item.id === id)
    if (!current) return false
    if (current.gone) {
      toast("error", "该卡片的设置提供方已卸载，无法保存；请放弃草稿或重新启用插件")
      return false
    }
    setBusy(true)
    try {
      if (current.kind === "arrangement") {
        const result = await host.saveCards(host.fullSettings(), baseline())
        if (!result.ok) {
          toast("error", `${result.message ?? "保存失败"}；草稿已保留`)
          return false
        }
        finishCardsSave(result)
        return true
      }
      if (current.kind === "layout" || current.kind === "colors") {
        const result = await host.saveAppearance(appearance(), baseline())
        if (!result.ok) {
          toast("error", `${result.message ?? "保存失败"}；草稿已保留`)
          return false
        }
        finishAppearanceSave(result)
        return true
      }
      if (current.kind === "shortcuts") {
        const result = await host.saveShortcuts(shortcuts(), baseline())
        if (!result.ok) {
          toast("error", `${result.message ?? "保存失败"}；草稿已保留`)
          return false
        }
        finishShortcutsSave(result)
        return true
      }
      return await saveProviderPage(current.cardID ?? "")
    } finally {
      setBusy(false)
    }
  }

  function finishCardsSave(result: SaveResult): void {
    if (result.baseline) setBaseline(result.baseline)
    setCardsDirty(false)
    toast("success", "已保存到 cli.json")
  }

  function finishAppearanceSave(result: SaveResult): void {
    if (result.baseline) {
      setBaseline(result.baseline)
      setAppearance(appearanceOf(result.baseline))
    }
    setAppearanceDirty(false)
    host.setAppearanceDraft(undefined)
    toast("success", "已保存到 cli.json")
  }

  /** 快捷入口保存后：草稿回到新基线（含归一化后的空类别＝缺省显示）。 */
  function finishShortcutsSave(result: SaveResult): void {
    if (result.baseline) {
      setBaseline(result.baseline)
      setShortcuts(shortcutsOf(result.baseline) ?? {})
    }
    setShortcutsDirty(false)
    toast("success", "已保存到 cli.json")
  }

  function discardPage(id: string): void {
    if (id === "arrangement") {
      host.previewArrangement(undefined)
      setCardsDirty(false)
      return
    }
    if (id === "layout" || id === "colors") {
      const saved = appearanceOf(baseline())
      setAppearance(saved)
      setAppearanceDirty(false)
      host.setAppearanceDraft(undefined)
      return
    }
    if (id === "shortcuts") {
      setShortcuts(shortcutsBaseline() ?? {})
      setShortcutsDirty(false)
      return
    }
    const cardID = id.slice("control:".length)
    const state = providerState().get(cardID)
    if (state?.baseline) patchProvider(cardID, { draft: { ...state.baseline }, dirty: false })
    setCardControlPreview(cardID, undefined, previewOwner)
  }

  type DirtyOutcome = "clean" | "saved" | "discarded" | "cancelled"

  /** dirty 时问「保存／放弃／继续」；返回 cancelled 表示调用方中止当前动作。 */
  async function resolveDirty(): Promise<DirtyOutcome> {
    const current = currentPage()
    if (!pageDirty(current.id)) return "clean"
    // 同一时刻只允许一个待确认动作，避免并发对话框竞争草稿。
    if (confirming()) return "cancelled"
    setConfirming(true)
    try {
      const options = current.gone
        ? [
            { title: "放弃本页草稿", value: "discard", description: "提供方已卸载，无法保存" },
            { title: "继续编辑", value: "cancel", description: "留在本页" },
          ]
        : [
            { title: "保存本页", value: "save", description: current.kind === "control" ? "交给卡片自己保存，然后读回确认" : "写入 cli.json" },
            { title: "放弃本页修改", value: "discard", description: "恢复为已保存的值，不影响其他页" },
            { title: "继续编辑", value: "cancel", description: "留在本页" },
          ]
      const choice = await context.ui.dialog.select<string>({
        title: "未保存的修改",
        placeholder: `${current.title} 有未保存的修改`,
        options,
      })
      if (choice === undefined || choice === "cancel") return "cancelled"
      if (choice === "discard") {
        discardPage(current.id)
        return "discarded"
      }
      return (await savePage(current.id)) ? "saved" : "cancelled"
    } finally {
      setConfirming(false)
    }
  }

  async function switchTo(nextID: string): Promise<void> {
    setPage(nextID)
    setSelected("")
    const current = pages().find((item) => item.id === nextID)
    if (current?.kind === "control" && current.cardID) await readProvider(current.cardID)
  }

  async function requestPage(nextID: string): Promise<void> {
    if (blocked() || nextID === page()) return
    if ((await resolveDirty()) === "cancelled") return
    await switchTo(nextID)
  }

  async function requestClose(): Promise<void> {
    if (blocked()) return
    if ((await resolveDirty()) === "cancelled") return
    finishClose()
  }

  function finishClose(): void {
    // 窗口代号递增：任何在途 read/save 的回答都属于已关闭的窗口，一律作废。
    generation++
    host.previewArrangement(undefined)
    for (const controls of providers()) setCardControlPreview(controls.id, undefined, previewOwner)
    host.setAppearanceDraft(undefined)
    setCardsDirty(false)
    setAppearanceDirty(false)
    setShortcutsDirty(false)
    setOpened(false)
    if (focusBefore && !focusBefore.isDestroyed) focusBefore.focus()
    focusBefore = null
  }

  async function runImportAction(): Promise<void> {
    if (blocked()) return
    if ((await resolveDirty()) === "cancelled") return
    const before = host.rawSettings()
    setBusy(true)
    try {
      await host.runImport()
    } catch (error) {
      toast("error", `导入失败：${errorText(error)}`)
    } finally {
      setBusy(false)
    }
    const after = host.rawSettings()
    // 只有真的写盘了才重建基线；导入被取消时不动其他页的草稿。
    if (!sameSidebarCards(before, after)) {
      host.previewArrangement(undefined)
      setBaseline(after)
      setAppearance(appearanceOf(after))
      setCardsDirty(false)
      setAppearanceDirty(false)
      host.setAppearanceDraft(undefined)
      setShortcuts(shortcutsOf(after) ?? {})
      setShortcutsDirty(false)
    }
  }

  async function rereadAction(): Promise<void> {
    if (blocked()) return
    if ((await resolveDirty()) === "cancelled") return
    setBusy(true)
    try {
      await host.refreshFromDisk()
    } finally {
      setBusy(false)
    }
    const raw = host.rawSettings()
    setBaseline(raw)
    setAppearance(appearanceOf(raw))
    setCardsDirty(false)
    setAppearanceDirty(false)
    host.setAppearanceDraft(undefined)
    setShortcuts(shortcutsOf(raw) ?? {})
    setShortcutsDirty(false)
  }

  /** 动作行（如额度原生设置）：先解决 dirty 并关闭本窗口，避免两个编辑器叠加。 */
  async function runAction(controls: CardControls, action: { title: string; run(): void | Promise<void> }): Promise<void> {
    if (blocked()) return
    if ((await resolveDirty()) === "cancelled") return
    finishClose()
    try {
      await action.run()
    } catch (error) {
      toast("error", `${action.title}失败：${errorText(error)}`)
    }
  }

  async function saveCurrentPage(): Promise<void> {
    if (blocked()) return
    const current = currentPage()
    if (!pageDirty(current.id)) {
      toast("info", "本页没有未保存的修改")
      return
    }
    await savePage(current.id)
  }

  function discardCurrentPage(): void {
    if (blocked() || !pageDirty(currentPage().id)) return
    discardPage(currentPage().id)
    toast("info", "已放弃本页修改")
  }

  async function rereadCurrentPage(): Promise<void> {
    if (blocked()) return
    const current = currentPage()
    if (current.kind === "control") {
      if (!current.cardID || current.gone) {
        toast("info", "该卡片的设置提供方已卸载，无法重新读取")
        return
      }
      if ((await resolveDirty()) === "cancelled") return
      await readProvider(current.cardID)
      return
    }
    // 排列／布局／颜色／快捷入口页：r 走宿主的重新读取（与页面上的「重新读取 cli.json」同一路径）。
    if ((await resolveDirty()) === "cancelled") return
    await rereadAction()
  }

  // ---------------------------------------------------------------- 打开／关闭

  async function open(): Promise<void> {
    const route = context.ui.router.current()
    if (route.type !== "session") {
      toast("info", "请先打开会话：/sidebar-cards 会在消息框上方打开。")
      return
    }
    if (opened() || opening()) {
      setZone("rail")
      return
    }
    setOpening(true)
    const started = ++generation
    try {
      focusBefore = context.renderer.currentFocusedRenderable ?? null
      setOpened(true)
      setPage("arrangement")
      setZone("rail")
      setSelected("")
      setProviderState(new Map())
      reads.clear()
      // 先按磁盘最新值初始化，再用它作原始基线。
      await host.refreshFromDisk()
      // 打开过程中被关闭：这次初始化已作废，不要用旧回答继续。
      if (!opened() || generation !== started) return
      const raw = host.rawSettings()
      setBaseline(raw)
      setAppearance(appearanceOf(raw))
      setCardsDirty(false)
      setAppearanceDirty(false)
      host.setAppearanceDraft(undefined)
      setShortcuts(shortcutsOf(raw) ?? {})
      setShortcutsDirty(false)
      for (const controls of providers()) void readProvider(controls.id)
    } finally {
      setOpening(false)
    }
    // 命令执行完消息框还握着键盘；等它稳定后再取回来。
    setTimeout(() => windowBox?.focus(), 50)
  }

  function dispose(): void {
    generation++
    host.previewArrangement(undefined)
    for (const controls of providers()) setCardControlPreview(controls.id, undefined, previewOwner)
    for (const id of knownControls()) setCardControlPreview(id, undefined, previewOwner)
    host.setAppearanceDraft(undefined)
  }

  /** provider 新出现：记进页面列表（之后撤销也保留页面，不静默丢草稿）。 */
  createEffect(() => {
    for (const controls of providers()) {
      if (!knownControls().includes(controls.id)) setKnownControls((current) => [...current, controls.id])
    }
  })

  // ---------------------------------------------------------------- 窗口外形

  function hint(): string {
    if (blocked()) return "处理中…"
    const kind = currentPage().kind
    const keys =
      zone() === "rail"
        ? "↑↓ 页面 · enter 内容 · esc 关闭"
        : kind === "arrangement"
          ? "←→ 排序 · space 显隐 · s 保存 · tab 返回 · esc 返回"
          : kind === "layout"
            ? "←→ 切换 · enter 使用 · s 保存 · tab 返回 · esc 返回"
            : kind === "colors"
              ? "← 跟随 · → 输入 · s 保存 · tab 返回 · esc 返回"
              : kind === "shortcuts"
                ? "←→ 开关 · s 保存 · tab 返回 · esc 返回"
                : "←→ 切换 · enter 输入 · s 保存 · tab 返回 · esc 返回"
    const file = host.fileState()
    const suffix = pageDirty(currentPage().id)
      ? "未保存"
      : file.writable
        ? ""
        : `cli.json 只读：${file.reason}`
    return suffix ? `${keys}｜${suffix}` : keys
  }

  function bodyHeader(): string {
    const current = currentPage()
    if (current.kind === "arrangement") {
      const settings = host.fullSettings()
      const unloaded = settings.order.filter((id) => !isLoaded(id)).length
      const extra = unloaded > 0 ? `，${unloaded} 张未加载` : ""
      return `${current.title} · 共 ${settings.order.length} 张，隐藏 ${settings.hidden.length} 张${extra}`
    }
    if (current.kind === "layout") return `${current.title} · 整体与每卡覆盖`
    if (current.kind === "colors") return `${current.title} · 整体与每卡覆盖`
    if (current.kind === "shortcuts") return `${current.title} · 三类入口`
    if (current.gone) return `${current.title} · 已卸载，不可保存`
    const marker = current.marker === "hidden" ? "（已隐藏，仍可设置）" : current.marker === "unloaded" ? "（未加载，仍可设置）" : ""
    return `${current.title} · 卡片设置${marker}`
  }

  function statusHint(): string {
    if (blocked()) return "处理中…"
    return pageDirty(currentPage().id) ? "● 未保存" : ""
  }

  function Window(): JSX.Element {
    const [hasKeyboard, setHasKeyboard] = createSignal(false)
    const [width, setWidth] = createSignal(72)
    const [room, setRoom] = createSignal<number>()
    /** 本组件绘制的盒／滚动框：重绘后旧引用不应清掉新盒的。 */
    let ownBox: BoxRenderable | undefined
    let ownScroll: ScrollBoxRenderable | undefined
    /** 窗口持有键盘且没有被故意抢走：跨断点 resize 后把键盘拿回来。 */
    let keyboardWanted = false
    let resizedThisTurn = false
    const onResize = () => {
      resizedThisTurn = true
      setTimeout(() => {
        resizedThisTurn = false
      }, 0)
    }

    /** 会话列里消息框之上还剩几行：沿父链找消息列，扣掉其他行。 */
    function measureRoom(): void {
      const box = windowBox
      if (!box || box.isDestroyed) return
      let child: Renderable = box
      for (let parent = box.parent; parent; child = parent, parent = parent.parent) {
        const siblings = parent.getChildren()
        const messages = siblings[0]
        if (messages === child || !messages?.getChildren().some((item) => "scrollChildIntoView" in item)) continue
        const otherRows = siblings
          .filter((item) => item !== child && item !== messages)
          .reduce((total, item) => total + item.height, 0)
        const next = Math.max(ROOM_MIN, parent.height - 1 - otherRows - (child.height - box.height))
        if (next !== room()) queueMicrotask(() => setRoom(next))
        return
      }
    }

    onMount(() => {
      context.renderer.root.on("layout-changed", measureRoom)
      context.renderer.on("resize", onResize)
      onCleanup(() => {
        context.renderer.root.off("layout-changed", measureRoom)
        context.renderer.off("resize", onResize)
      })
    })
    onCleanup(() => {
      if (windowBox === ownBox) windowBox = undefined
      if (scroll === ownScroll) scroll = undefined
    })

    // 键盘只在本窗口持有键盘时响应；消息框保留自己的按键。
    context.keymap.layer(() => ({
      target: () => windowBox,
      priority: 10,
      enabled: () => opened() && !blocked(),
      commands: [
        { bind: "up", title: "上一行／上一个页面", group: KEYS, run: () => (zone() === "rail" ? void requestPage(stepPageID(-1)) : moveSelection(-1)) },
        { bind: "down", title: "下一行／下一个页面", group: KEYS, run: () => (zone() === "rail" ? void requestPage(stepPageID(1)) : moveSelection(1)) },
        { bind: "left", title: "上一个页面／上一个值", group: KEYS, run: () => (zone() === "rail" ? void requestPage(stepPageID(-1)) : useLine(-1)) },
        { bind: "right", title: "下一个页面／下一个值", group: KEYS, run: () => (zone() === "rail" ? void requestPage(stepPageID(1)) : useLine(1)) },
        { bind: "space", title: "使用该行", group: KEYS, run: () => (zone() === "body" ? useLine(0) : enterBody()) },
        { bind: "return", title: "使用该行／进入内容", group: KEYS, run: () => (zone() === "body" ? useLine(0) : enterBody()) },
        { bind: "tab", title: "进入内容／返回页面列表", group: KEYS, run: () => (zone() === "rail" ? enterBody() : setZone("rail")) },
        { bind: "escape", title: "返回页面列表／关闭", group: KEYS, run: () => (zone() === "body" ? setZone("rail") : void requestClose()) },
        { bind: "pageup", title: "向上滚动一页", group: KEYS, run: () => scroll?.scrollBy(-(scroll.height || 1)) },
        { bind: "pagedown", title: "向下滚动一页", group: KEYS, run: () => scroll?.scrollBy(scroll.height || 1) },
        { bind: "s", title: "保存本页", group: KEYS, run: () => void saveCurrentPage() },
        { bind: "r", title: "重新读取本页", group: KEYS, run: () => void rereadCurrentPage() },
      ],
    }))

    const narrow = () => width() < NARROW_WIDTH
    const items = () => railItems()
    /** 内容区实际可用宽：不设人为下限，交给行的收缩／堆叠处理。 */
    /** 内容区实际可用宽：页面标签已移到顶部，内容占满整行。 */
    const contentWidth = () => Math.max(6, width())

    return (
      <box
        ref={(element: BoxRenderable) => {
          windowBox = element
          ownBox = element
          element.on("focused", () => {
            keyboardWanted = true
            setHasKeyboard(true)
          })
          element.on("blurred", () => {
            setHasKeyboard(false)
            // 事件结束后再判断：resize 抢走的拿回来，点击／对话框拿走的让出去。
            queueMicrotask(() => {
              if (windowBox !== element || element.isDestroyed) return
              if (resizedThisTurn && keyboardWanted) element.focus()
              else keyboardWanted = false
            })
          })
          // 重绘后新盒就位：原本持有键盘就把键盘拿回来。
          if (keyboardWanted) {
            setTimeout(() => {
              if (keyboardWanted && windowBox === element) element.focus()
            }, 0)
          }
        }}
        focusable
        height={room() ?? DEFAULT_ROOM}
        border
        borderStyle="rounded"
        borderColor={hasKeyboard() ? theme().text.action.primary.base : theme().text.muted}
        paddingLeft={1}
        paddingRight={1}
        onMouseDown={() => {
          if (!busy()) windowBox?.focus()
        }}
        onSizeChange={function (this: BoxRenderable) {
          // 边框内、左右 padding 之内的宽度。
          const measured = this.width - 4
          if (measured > 0 && measured !== width()) queueMicrotask(() => setWidth(measured))
        }}
      >
        <box flexDirection="row" flexShrink={0}>
          <text fg={theme().text.base} wrapMode="none" selectable={false}>
            <b>{TITLE}</b>
          </text>
          <text fg={theme().text.muted} wrapMode="none" selectable={false}>{"  "}</text>
          <PageStrip items={items()} chosen={page()} theme={theme()} width={Math.max(10, width() - 16)} pick={(key) => void requestPage(key)} />
          <box flexGrow={1} />
          <text fg={theme().text.feedback.warning.base} wrapMode="none" selectable={false}>
            {statusHint()}
          </text>
          <text fg={theme().text.muted} wrapMode="none" selectable={false} onMouseUp={() => void requestClose()}>
            {"  esc "}
          </text>
        </box>
        <box flexDirection="row" flexGrow={1} flexBasis={0} minHeight={0} marginTop={1}>
          <box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0} overflow="hidden">
            <text fg={theme().text.muted} wrapMode="none" selectable={false}>
              {bodyHeader()}
            </text>
            <scrollbox
              ref={(element: ScrollBoxRenderable) => {
                scroll = element
                ownScroll = element
              }}
              flexGrow={1}
              flexBasis={0}
              minHeight={0}
            >
              {bodyLines().map((line) => (
                <OptionRow
                  line={line}
                  theme={theme()}
                  active={zone() === "body" && selected() === line.id}
                  width={contentWidth()}
                  press={() => {
                    setZone("body")
                    setSelected(line.id)
                  }}
                  use={() => useLine(0)}
                />
              ))}
            </scrollbox>
          </box>
        </box>
        <box flexDirection="column" marginTop={1} flexShrink={0}>
          <box flexDirection="row" flexWrap="wrap" gap={2}>
            <text
              fg={pageDirty(currentPage().id) && !blocked() ? (theme().text.action.primary.focused ?? theme().text.base) : theme().text.muted}
              bg={pageDirty(currentPage().id) && !blocked() ? (theme().background?.action?.primary?.focused ?? theme().text.action.primary.base) : theme().background?.raised.high}
              wrapMode="none"
              selectable={false}
              onMouseUp={() => void saveCurrentPage()}
            >
              {" 保存本页 "}
            </text>
            <text fg={theme().text.base} bg={theme().background?.raised.high} wrapMode="none" selectable={false} onMouseUp={discardCurrentPage}>{" 重置本页 "}</text>
            <text fg={theme().text.base} bg={theme().background?.raised.high} wrapMode="none" selectable={false} onMouseUp={() => void requestClose()}>{" 关闭 "}</text>
          </box>
          <text fg={theme().text.muted} wrapMode="word" selectable={false}>
            {hint()}
          </text>
        </box>
      </box>
    )
  }

  /** 页面列表里当前页的上／下一个页面 id。 */
  function stepPageID(delta: number): string {
    const list = pages()
    const index = list.findIndex((item) => item.id === page())
    const base = index === -1 ? 0 : index
    return list[(base + delta + list.length) % list.length]!.id
  }

  const Slot = () => (
    <Show when={opened()}>
      <Window />
    </Show>
  )

  return { open: () => void open(), Slot, dispose }
}
