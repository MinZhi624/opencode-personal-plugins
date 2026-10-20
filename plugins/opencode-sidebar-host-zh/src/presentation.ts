/** Sidebars only: a small in-process display bridge, never Quota's global settings. */
import { createSignal, onCleanup } from "solid-js"

export const SIDEBAR_BAR_SHAPES = ["blocks", "shades", "line", "squares", "dots", "none"] as const
export type SidebarBarShape = (typeof SIDEBAR_BAR_SHAPES)[number]

/** 进度条宽度：固定字符列数，或 "fill"（填满可用宽度，由渲染方量宽）。 */
export type SidebarBarWidth = number | "fill"

/** 颜色角色（十六进制）；缺省的角色由渲染方回退到主题色。 */
export interface SidebarColors {
  title?: string
  body?: string
  muted?: string
  divider?: string
  bar?: string
  warn?: string
}

/** 布局偏好：卡片间空行、卡片内附加行距、缩进、行名宽度、标题分隔线。 */
export interface SidebarLayout {
  gap?: number
  lineGap?: number
  indent?: number
  labelWidth?: number
  divider?: boolean
}

export interface SidebarAppearance {
  bar?: SidebarBarShape
  bars?: Record<string, SidebarBarShape>
  barWidth?: SidebarBarWidth
  barWidths?: Record<string, SidebarBarWidth>
  layout?: SidebarLayout
  cardLayout?: Record<string, SidebarLayout>
  colors?: SidebarColors
  cardColors?: Record<string, SidebarColors>
}

/** 按卡片解析后的展示值：形状／宽度已取“卡片覆盖 › 整体”，布局与颜色已合并单卡覆盖。 */
export interface SidebarDisplay {
  shape?: SidebarBarShape
  barWidth?: SidebarBarWidth
  layout: SidebarLayout
  colors: SidebarColors
}

export const SIDEBAR_COLOR_ROLES = ["title", "body", "muted", "divider", "bar", "warn"] as const
export type SidebarColorRole = (typeof SIDEBAR_COLOR_ROLES)[number]

/** 快捷入口显隐：按类别分别控制斜杠与命令面板入口；缺省视为显示。 */
export interface SidebarShortcutCategory {
  slash?: boolean
  palette?: boolean
}
export interface SidebarShortcuts {
  /** 子代理展示设置：排序、数量、保留期限。 */
  subagentDisplay?: SidebarShortcutCategory
  /** 子代理记录管理：标记完成、清空记录。 */
  subagentRecords?: SidebarShortcutCategory
  /** 宿主直接操作：/sidebar-host-* 系列。 */
  hostDirect?: SidebarShortcutCategory
}

type State = { owner?: object; value: SidebarAppearance; listeners: Set<() => void> }
type ShortcutState = { owner?: object; value: SidebarShortcuts; listeners: Set<() => void> }
const KEY = Symbol.for("opencode-sidebar-host-zh.appearance.v1")
const SHORTCUT_KEY = Symbol.for("opencode-sidebar-host-zh.shortcuts.v1")
function state(): State {
  const scope = globalThis as unknown as Record<symbol, State | undefined>
  return scope[KEY] ??= { value: {}, listeners: new Set() }
}
function shortcutState(): ShortcutState {
  const scope = globalThis as unknown as Record<symbol, ShortcutState | undefined>
  return scope[SHORTCUT_KEY] ??= { value: {}, listeners: new Set() }
}
export function isSidebarBarShape(value: unknown): value is SidebarBarShape {
  return typeof value === "string" && (SIDEBAR_BAR_SHAPES as readonly string[]).includes(value)
}
export function isSidebarBarWidth(value: unknown): value is SidebarBarWidth {
  return value === "fill" || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
}
/** 十六进制颜色（3/6 位）；渲染方只接受合法值，其余按缺省主题色处理。 */
export function isSidebarColor(value: unknown): value is string {
  return typeof value === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)
}
export function createSidebarAppearancePublisher() {
  const owner = {}
  const current = state()
  const notify = () => { for (const listener of [...current.listeners]) listener() }
  return {
    publish(value: SidebarAppearance) { current.owner = owner; current.value = value; notify() },
    dispose() { if (current.owner === owner) { current.owner = undefined; current.value = {}; notify() } },
  }
}
export function createSidebarShortcutsPublisher() {
  const owner = {}
  const current = shortcutState()
  const notify = () => { for (const listener of [...current.listeners]) listener() }
  return {
    publish(value: SidebarShortcuts) { current.owner = owner; current.value = value; notify() },
    dispose() { if (current.owner === owner) { current.owner = undefined; current.value = {}; notify() } },
  }
}
/** 快捷入口显隐（保存后的生效值；缺省显示）。宿主发布，命令注册方响应式读取。 */
export function useSidebarShortcuts(): () => SidebarShortcuts {
  const current = shortcutState()
  const [tick, setTick] = createSignal(0)
  const listener = () => setTick((value) => value + 1)
  current.listeners.add(listener)
  onCleanup(() => current.listeners.delete(listener))
  return () => { tick(); return current.value }
}
/** 某类别某入口当前是否显示；缺省显示。 */
export function shortcutVisible(all: SidebarShortcuts, category: keyof SidebarShortcuts, channel: keyof SidebarShortcutCategory): boolean {
  return all[category]?.[channel] !== false
}

function own<T>(record: Record<string, T> | undefined, cardID: string): T | undefined {
  return record && Object.hasOwn(record, cardID) ? record[cardID] : undefined
}
function mergeLayout(base: SidebarLayout | undefined, ownValue: SidebarLayout | undefined): SidebarLayout {
  return { ...base, ...ownValue }
}
function mergeColors(base: SidebarColors | undefined, ownValue: SidebarColors | undefined): SidebarColors {
  return { ...base, ...ownValue }
}
/** 按卡片解析展示值：形状／宽度取卡片覆盖与整体的显式者，布局与颜色把单卡覆盖叠在整体上。 */
export function resolveSidebarDisplay(appearance: SidebarAppearance, cardID: string): SidebarDisplay {
  return {
    shape: own(appearance.bars, cardID) ?? appearance.bar,
    barWidth: own(appearance.barWidths, cardID) ?? appearance.barWidth,
    layout: mergeLayout(appearance.layout, own(appearance.cardLayout, cardID)),
    colors: mergeColors(appearance.colors, own(appearance.cardColors, cardID)),
  }
}
/** 订阅某卡片解析后的展示值（含草稿发布）；缺省项留给渲染方回退主题／默认值。 */
export function useSidebarDisplay(cardID: string): () => SidebarDisplay {
  const current = state()
  const [tick, setTick] = createSignal(0)
  const listener = () => setTick((value) => value + 1)
  current.listeners.add(listener)
  onCleanup(() => current.listeners.delete(listener))
  return () => { tick(); return resolveSidebarDisplay(current.value, cardID) }
}
export function useSidebarBarShape(cardID: string): () => SidebarBarShape | undefined {
  const display = useSidebarDisplay(cardID)
  return () => display().shape
}

/** Filled and empty runs; callers retain their own percentage and warning semantics. */
export function sidebarBarParts(shape: SidebarBarShape, percent: number, width: number): [string, string] {
  if (shape === "none") return ["", ""]
  const glyphs = { blocks: ["█", "░"], shades: ["▓", "░"], line: ["━", "─"], squares: ["■", "□"], dots: ["●", "○"] } as const
  const cells = Math.max(0, Math.floor(width))
  const used = Math.round(Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0)) * cells / 100)
  const [filled, empty] = glyphs[shape]
  return [filled.repeat(used), empty.repeat(cells - used)]
}
