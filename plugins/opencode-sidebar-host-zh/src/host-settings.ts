/**
 * 宿主的排序／显隐设置：纯函数与类型，不 import context、不做 IO。
 *
 * 设置与迁移契约：
 * - 宿主持久化**所有已知卡片**的顺序与显隐，用稳定身份（ID 字符串）保存，
 *   不保存模块引用或渲染函数；暂未加载的卡片保留偏好但不显示；
 * - 新发现的卡片（含后装的第三方卡片）确定性追加到尾，不打乱既有顺序；
 * - 显隐只是显示偏好：隐藏卡片仍占位，上移／下移以完整序列为准；
 * - 首次切换时读取旧聚合插件（opencode-enhanced-sidebar-zh）的
 *   `sidebar-cards-zh-v1` 设置，不静默丢弃用户既有顺序与显隐；
 * - 排序设置由宿主拥有：卸载某张卡片不删除其他卡片的设置，宿主卸载不删设置；
 * - 展示偏好还含本套侧栏专属的整体进度条形状（bar）与单卡覆盖（bars）、
 *   进度条宽度（barWidth／barWidths）、布局（layout／cardLayout）与颜色
 *   （colors／cardColors），以及快捷入口显隐（shortcuts）；
 *   优先级为明确的卡片覆盖 > 明确的整体值 > 卡片自身设置／默认形状；
 *   宿主只为侧栏派生展示，不改写 Quota 跨展示位置共用的形状设置。
 * 形状词汇（blocks、shades、line、squares、dots、none）以 presentation.ts
 * 的 `isSidebarBarShape` 为唯一来源，避免两处定义漂移。
 */

import {
  isSidebarBarShape,
  isSidebarBarWidth,
  isSidebarColor,
  SIDEBAR_COLOR_ROLES,
  type SidebarAppearance,
  type SidebarBarShape,
  type SidebarBarWidth,
  type SidebarColors,
  type SidebarColorRole,
  type SidebarLayout,
  type SidebarShortcutCategory,
  type SidebarShortcuts,
} from "./presentation.ts"

/** 宿主自己的设置键（与旧聚合插件的 `sidebar-cards-zh-v1` 是不同键，互不覆写）。 */
export const HOST_SETTINGS_KEY = "sidebar-host-zh-v1"

/** 旧聚合插件的设置键：只读来源，宿主绝不写入或删除该键。 */
export const LEGACY_SIDEBAR_CARD_SETTINGS_KEY = "sidebar-cards-zh-v1"

/** 旧聚合插件的四张卡片稳定身份（迁移时原样保留，不重命名）。 */
export const LEGACY_SIDEBAR_CARD_IDS = ["quota", "sessionOverview", "subagents", "skill"] as const

export type LegacySidebarCardID = (typeof LEGACY_SIDEBAR_CARD_IDS)[number]

/** 布局字段的合法范围：设置窗口的选项、说明与文件校验共用同一份数值。 */
export const SIDEBAR_LAYOUT_LIMITS = {
  gap: { min: 0, max: 3 },
  lineGap: { min: 0, max: 2 },
  indent: { min: 0, max: 4 },
  labelWidth: { min: 4, max: 24 },
} as const

export type SidebarLayoutNumberField = keyof typeof SIDEBAR_LAYOUT_LIMITS

/** 快捷入口的三个类别（按类别控制，不提供逐条命令开关）。 */
export const SIDEBAR_SHORTCUT_CATEGORY_KEYS = ["subagentDisplay", "subagentRecords", "hostDirect"] as const

/** 文件选项不携带旧 storage 的 auto／migrated 元数据。 */
export interface SidebarCardSettings {
  order: string[]
  hidden: string[]
  /**
   * 本套侧栏的整体进度条形状（展示偏好，非业务开关）。
   * 缺省＝不强制：各卡片沿用自身已有设置或默认形状，首次打开不批量写入。
   */
  bar?: SidebarBarShape
  /**
   * 单卡形状覆盖：明确的卡片形状高于 `bar`；删除某张卡的条目即恢复跟随整体。
   * 未知／暂未加载的卡片 ID 同样保留偏好（与 hidden 的占位规则一致）。
   */
  bars?: Record<string, SidebarBarShape>
  /** 整体进度条宽度：固定字符列数或 "fill"（填满可用宽度，由渲染方量宽）。 */
  barWidth?: SidebarBarWidth
  /** 单卡宽度覆盖：明确的卡片宽度高于 `barWidth`；删除条目即恢复跟随整体。 */
  barWidths?: Record<string, SidebarBarWidth>
  /** 整体布局：卡片间距、卡片内附加行距、缩进、行名宽度、标题分隔线。 */
  layout?: SidebarLayout
  /** 单卡布局覆盖：按字段叠在整体布局上，空条目等同未设置。 */
  cardLayout?: Record<string, SidebarLayout>
  /** 整体颜色（十六进制）；缺省角色由渲染方回退主题色。 */
  colors?: SidebarColors
  /** 单卡颜色覆盖：按角色叠在整体颜色上，空条目等同未设置。 */
  cardColors?: Record<string, SidebarColors>
  /**
   * 快捷入口显隐（按类别分别控制斜杠与命令面板入口）。
   * 缺省类别／通道视为显示；主入口 /sidebar-cards 没有开关，始终可达。
   */
  shortcuts?: SidebarShortcuts
}

/** 六个可选形状的报错文案，parse 与界面提示共用同一份词汇。 */
const BAR_SHAPE_HINT = "blocks、shades、line、squares、dots 或 none"

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 0 以上的安全整数（进度条宽度；"fill" 由 isSidebarBarWidth 单独接受）。 */
function isWhole(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
}

/**
 * 卡片 ID 是任意非空稳定字符串（`__proto__` 等特殊键同样是合法 ID）：
 * 覆盖表一律用 defineProperty 写自有属性、用 hasOwn 读自有属性，
 * 不走赋值／索引的原型链语义，也不因键名特殊拒绝任何合法 ID。
 */
function setOwn<T>(record: Record<string, T>, id: string, value: T): void {
  Object.defineProperty(record, id, { value, enumerable: true, writable: true, configurable: true })
}

function own<T>(record: Record<string, T> | undefined, id: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, id) ? record[id] : undefined
}

/** 复制覆盖表：只复制自有可枚举条目，`__proto__` 等键落成自有数据属性而非原型赋值。 */
function copyRecord<T>(record: Record<string, T> | undefined): Record<string, T> {
  return record === undefined ? {} : Object.fromEntries(Object.entries(record))
}

/** 规范化外观字段：空覆盖等同未设置，避免 `{}` 与缺省被当成两种持久化状态。 */
function appearanceOf(settings: SidebarAppearance): SidebarAppearance {
  const appearance: SidebarAppearance = {}
  if (settings.bar !== undefined) appearance.bar = settings.bar
  if (settings.bars !== undefined && Object.keys(settings.bars).length > 0) appearance.bars = copyRecord(settings.bars)
  if (settings.barWidth !== undefined) appearance.barWidth = settings.barWidth
  if (settings.barWidths !== undefined && Object.keys(settings.barWidths).length > 0) {
    appearance.barWidths = copyRecord(settings.barWidths)
  }
  if (settings.layout !== undefined && Object.keys(settings.layout).length > 0) appearance.layout = { ...settings.layout }
  if (settings.cardLayout !== undefined && Object.keys(settings.cardLayout).length > 0) {
    appearance.cardLayout = copyRecord(settings.cardLayout)
  }
  if (settings.colors !== undefined && Object.keys(settings.colors).length > 0) appearance.colors = { ...settings.colors }
  if (settings.cardColors !== undefined && Object.keys(settings.cardColors).length > 0) {
    appearance.cardColors = copyRecord(settings.cardColors)
  }
  return appearance
}

/** 完整展示偏好（形状／宽度／布局／颜色）：供排序、显隐与写回路径原样保留。 */
export function presentationOf(settings: SidebarCardSettings): SidebarAppearance {
  return appearanceOf(settings)
}

/** 快捷入口偏好：三类全部为空时返回 undefined（等同未设置＝全部显示）。 */
export function shortcutsOf(settings: SidebarCardSettings): SidebarShortcuts | undefined {
  return normalizeShortcuts(settings.shortcuts)
}

/** 去掉空类别；全部为空即未设置（缺省显示）。 */
function normalizeShortcuts(shortcuts: SidebarShortcuts | undefined): SidebarShortcuts | undefined {
  if (shortcuts === undefined) return undefined
  const next: SidebarShortcuts = {}
  for (const key of SIDEBAR_SHORTCUT_CATEGORY_KEYS) {
    const category = shortcuts[key]
    if (category === undefined) continue
    const slash = typeof category.slash === "boolean" ? category.slash : undefined
    const palette = typeof category.palette === "boolean" ? category.palette : undefined
    if (slash === undefined && palette === undefined) continue
    next[key] = slash === undefined ? { palette } : palette === undefined ? { slash } : { slash, palette }
  }
  return Object.keys(next).length > 0 ? next : undefined
}

/** 单卡覆盖表：无效条目整个忽略并记录问题；没有合法条目时返回 undefined。 */
function parseCardRecord<T>(
  raw: unknown,
  path: string,
  issues: string[],
  parseValue: (value: unknown, path: string, issues: string[]) => T | undefined,
): Record<string, T> | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    issues.push(`${path} 必须是对象，已忽略`)
    return undefined
  }
  const record: Record<string, T> = {}
  let badID = false
  let badValue = false
  for (const [id, value] of Object.entries(raw)) {
    if (id.trim().length === 0) {
      badID = true
      continue
    }
    const parsed = parseValue(value, `${path}.${id}`, issues)
    if (parsed === undefined) {
      badValue = true
      continue
    }
    setOwn(record, id, parsed)
  }
  if (badID) issues.push(`${path} 含无效卡片 ID，已忽略无效项`)
  if (badValue) issues.push(`${path} 含无效值，已忽略无效项`)
  return Object.keys(record).length > 0 ? record : undefined
}

function parseShape(value: unknown, path: string, issues: string[]): SidebarBarShape | undefined {
  if (value === undefined) return undefined
  if (isSidebarBarShape(value)) return value
  issues.push(`${path} 必须是 ${BAR_SHAPE_HINT} 之一，已忽略`)
  return undefined
}

function parseBarWidth(value: unknown, path: string, issues: string[]): SidebarBarWidth | undefined {
  if (value === undefined) return undefined
  if (isSidebarBarWidth(value)) return value
  issues.push(`${path} 必须是 fill 或 0 以上的整数，已忽略`)
  return undefined
}

function parseLayout(value: unknown, path: string, issues: string[]): SidebarLayout | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) {
    issues.push(`${path} 必须是对象，已忽略`)
    return undefined
  }
  const layout: SidebarLayout = {}
  for (const field of Object.keys(SIDEBAR_LAYOUT_LIMITS) as SidebarLayoutNumberField[]) {
    const raw = value[field]
    if (raw === undefined) continue
    const limit = SIDEBAR_LAYOUT_LIMITS[field]
    if (!isWhole(raw, limit.min, limit.max)) {
      issues.push(`${path}.${field} 必须是 ${limit.min} – ${limit.max} 的整数，已忽略`)
      continue
    }
    layout[field] = raw
  }
  if (value.divider !== undefined) {
    if (typeof value.divider !== "boolean") issues.push(`${path}.divider 必须是布尔值，已忽略`)
    else layout.divider = value.divider
  }
  return Object.keys(layout).length > 0 ? layout : undefined
}

function parseColors(value: unknown, path: string, issues: string[]): SidebarColors | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) {
    issues.push(`${path} 必须是对象，已忽略`)
    return undefined
  }
  const colors: SidebarColors = {}
  for (const role of SIDEBAR_COLOR_ROLES) {
    const raw = value[role]
    if (raw === undefined) continue
    if (!isSidebarColor(raw)) {
      issues.push(`${path}.${role} 必须是 #RGB 或 #RRGGBB 十六进制颜色，已忽略`)
      continue
    }
    colors[role as SidebarColorRole] = raw
  }
  return Object.keys(colors).length > 0 ? colors : undefined
}

function parseShortcutCategory(value: unknown, path: string, issues: string[]): SidebarShortcutCategory | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) {
    issues.push(`${path} 必须是对象，已忽略`)
    return undefined
  }
  const category: SidebarShortcutCategory = {}
  for (const channel of ["slash", "palette"] as const) {
    const raw = value[channel]
    if (raw === undefined) continue
    if (typeof raw !== "boolean") {
      issues.push(`${path}.${channel} 必须是布尔值，已忽略`)
      continue
    }
    category[channel] = raw
  }
  return Object.keys(category).length > 0 ? category : undefined
}

function parseShortcuts(value: unknown, path: string, issues: string[]): SidebarShortcuts | undefined {
  const parsed = parseCardRecord<SidebarShortcutCategory>(value, path, issues, parseShortcutCategory)
  if (parsed === undefined) return undefined
  const shortcuts: SidebarShortcuts = {}
  for (const key of SIDEBAR_SHORTCUT_CATEGORY_KEYS) {
    const category = own(parsed, key)
    if (category !== undefined) shortcuts[key] = category
  }
  return normalizeShortcuts(shortcuts)
}

export function parseSidebarCards(value: unknown): { settings: SidebarCardSettings; issues: string[] } {
  const issues: string[] = []
  if (value === undefined) return { settings: { order: [], hidden: [] }, issues }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { settings: { order: [], hidden: [] }, issues: ["sidebarCards 必须是对象，已使用默认值"] }
  }
  const input = value as Record<string, unknown>
  function list(field: "order" | "hidden"): string[] {
    const raw = input[field]
    if (raw === undefined) return []
    if (!Array.isArray(raw)) {
      issues.push(`sidebarCards.${field} 必须是字符串数组，已忽略`)
      return []
    }
    if (raw.some((id) => typeof id !== "string" || id.trim().length === 0)) {
      issues.push(`sidebarCards.${field} 含无效 ID，已忽略无效项`)
    }
    return toIDList(raw)
  }
  const order = list("order")
  const hidden = list("hidden")
  for (const id of hidden) if (!order.includes(id)) order.push(id)
  const settings: SidebarCardSettings = { order, hidden }
  const rawBar = input.bar
  if (rawBar !== undefined) {
    const shape = parseShape(rawBar, "sidebarCards.bar", issues)
    if (shape !== undefined) settings.bar = shape
  }
  settings.bars = parseCardRecord(input.bars, "sidebarCards.bars", issues, parseShape)
  const rawBarWidth = input.barWidth
  if (rawBarWidth !== undefined) {
    const width = parseBarWidth(rawBarWidth, "sidebarCards.barWidth", issues)
    if (width !== undefined) settings.barWidth = width
  }
  settings.barWidths = parseCardRecord(input.barWidths, "sidebarCards.barWidths", issues, parseBarWidth)
  settings.layout = parseLayout(input.layout, "sidebarCards.layout", issues)
  settings.cardLayout = parseCardRecord(input.cardLayout, "sidebarCards.cardLayout", issues, parseLayout)
  settings.colors = parseColors(input.colors, "sidebarCards.colors", issues)
  settings.cardColors = parseCardRecord(input.cardColors, "sidebarCards.cardColors", issues, parseColors)
  settings.shortcuts = parseShortcuts(input.shortcuts, "sidebarCards.shortcuts", issues)
  return { settings, issues }
}

/** 完整序列：未知／隐藏项占位；新注册项仅在内存追加，不自动写文件。 */
export function completeSidebarCards(settings: SidebarCardSettings, registeredIDs: readonly string[]): SidebarCardSettings {
  const order = [...settings.order]
  for (const id of registeredIDs) if (!order.includes(id)) order.push(id)
  return { order, hidden: [...settings.hidden], ...appearanceOf(settings) }
}

export function changeSidebarCard(
  settings: SidebarCardSettings,
  id: string,
  action: "show" | "hide" | "up" | "down",
): { settings: SidebarCardSettings; result: "ok" | "boundary" | "unknown" } {
  const order = [...settings.order]
  let hidden = [...settings.hidden]
  // 排序／显隐的修改不得丢失已保存的展示偏好（形状／宽度／布局／颜色／快捷入口）。
  const appearance = appearanceOf(settings)
  if (action === "show" || action === "hide") {
    if (!order.includes(id)) order.push(id)
    hidden = hidden.filter((item) => item !== id)
    if (action === "hide") hidden.push(id)
    return { settings: { order, hidden, ...appearance }, result: "ok" }
  }
  const index = order.indexOf(id)
  if (index === -1) return { settings, result: "unknown" }
  const target = index + (action === "up" ? -1 : 1)
  if (target < 0 || target >= order.length) return { settings, result: "boundary" }
  ;[order[index], order[target]] = [order[target]!, order[index]!]
  return { settings: { order, hidden, ...appearance }, result: "ok" }
}

function sameValue<T>(a: T | undefined, b: T | undefined): boolean {
  return (a ?? null) === (b ?? null)
}

function sameWidth(a: SidebarBarWidth | undefined, b: SidebarBarWidth | undefined): boolean {
  return (a ?? null) === (b ?? null)
}

/** 布局按字段比较：缺省键与显式 undefined 等价，`false` 与缺省不等价。 */
function sameLayout(a: SidebarLayout | undefined, b: SidebarLayout | undefined): boolean {
  if (a === undefined || b === undefined) return (a ?? null) === (b ?? null)
  const numbers = Object.keys(SIDEBAR_LAYOUT_LIMITS) as SidebarLayoutNumberField[]
  return numbers.every((field) => sameValue(a[field], b[field])) && sameValue(a.divider, b.divider)
}

/** 颜色按角色比较：缺省角色＝跟随主题，与任何显式颜色都不等价。 */
function sameColors(a: SidebarColors | undefined, b: SidebarColors | undefined): boolean {
  if (a === undefined || b === undefined) return (a ?? null) === (b ?? null)
  return SIDEBAR_COLOR_ROLES.every((role) => sameValue(a[role], b[role]))
}

function sameCategory(a: SidebarShortcutCategory | undefined, b: SidebarShortcutCategory | undefined): boolean {
  if (a === undefined || b === undefined) return (a ?? null) === (b ?? null)
  return sameValue(a.slash, b.slash) && sameValue(a.palette, b.palette)
}

/** 快捷入口在持久化意义上是否相同（缺省类别＝显示）。 */
export function sameSidebarShortcuts(a: SidebarShortcuts | undefined, b: SidebarShortcuts | undefined): boolean {
  if (a === undefined || b === undefined) return (a ?? null) === (b ?? null)
  return SIDEBAR_SHORTCUT_CATEGORY_KEYS.every((key) => sameCategory(a[key], b[key]))
}

/** 空覆盖与未设置等价：避免把 `{}` 与缺省判成两种持久化状态。 */
function sameRecord<T>(
  a: Record<string, T> | undefined,
  b: Record<string, T> | undefined,
  same: (left: T | undefined, right: T | undefined) => boolean,
): boolean {
  const left = a ?? {}
  const right = b ?? {}
  const ids = Object.keys(left)
  // 只比自有条目：原型链上的同名属性不参与，也不因右表缺自有键而误判相等。
  return ids.length === Object.keys(right).length && ids.every((id) => same(own(left, id), own(right, id)))
}

/** 持久化意义上的相同：顺序、显隐与全部展示偏好都参与比较（写回前校验与冲突检测共用）。 */
export function sameSidebarCards(a: SidebarCardSettings, b: SidebarCardSettings): boolean {
  return a.order.length === b.order.length && a.order.every((id, i) => id === b.order[i]) &&
    a.hidden.length === b.hidden.length && a.hidden.every((id, i) => id === b.hidden[i]) &&
    sameValue(a.bar, b.bar) && sameRecord(a.bars, b.bars, sameValue) &&
    sameWidth(a.barWidth, b.barWidth) && sameRecord(a.barWidths, b.barWidths, sameWidth) &&
    sameLayout(a.layout, b.layout) && sameRecord(a.cardLayout, b.cardLayout, sameLayout) &&
    sameColors(a.colors, b.colors) && sameRecord(a.cardColors, b.cardColors, sameColors) &&
    sameSidebarShortcuts(a.shortcuts, b.shortcuts)
}

/**
 * 按草稿写回外观字段（形状／宽度／布局／颜色）：
 * 草稿里出现的键整个替换（undefined＝删除文件中对应键），未出现的键原样保留；
 * 顺序与显隐取自磁盘当前值，因此绝不会把排列草稿或外部顺序改动一起写进去。
 */
export function applySidebarAppearance(settings: SidebarCardSettings, draft: SidebarAppearance): SidebarCardSettings {
  const next: SidebarCardSettings = { order: [...settings.order], hidden: [...settings.hidden] }
  const shortcuts = shortcutsOf(settings)
  if (shortcuts !== undefined) next.shortcuts = shortcuts
  // appearanceOf 会丢掉 undefined 与空覆盖：未设置即删除，不留下空的 bars／cardLayout。
  return { ...next, ...appearanceOf({ ...presentationOf(settings), ...draft }) }
}

/**
 * 按草稿写回快捷入口：整份替换（缺省类别／通道＝显示）；
 * 顺序、显隐与展示偏好原样保留。
 */
export function applySidebarShortcuts(settings: SidebarCardSettings, draft: SidebarShortcuts): SidebarCardSettings {
  const next: SidebarCardSettings = { order: [...settings.order], hidden: [...settings.hidden], ...presentationOf(settings) }
  const shortcuts = normalizeShortcuts(draft)
  if (shortcuts !== undefined) next.shortcuts = shortcuts
  return next
}

/** 单卡生效形状与来源：卡片覆盖 › 整体 › 卡片自己的设置（旧调用面的兼容视图）。 */
export function resolveSidebarBar(
  settings: SidebarCardSettings,
  id: string,
): { shape: SidebarBarShape | undefined; source: "card-override" | "shared" | "card" } {
  const override = own(settings.bars, id)
  if (override !== undefined) return { shape: override, source: "card-override" }
  if (settings.bar !== undefined) return { shape: settings.bar, source: "shared" }
  return { shape: undefined, source: "card" }
}

/** 设置整体形状（undefined＝删除文件中该键）。旧调用面的兼容写法。 */
export function setSidebarSharedBar(settings: SidebarCardSettings, bar: SidebarBarShape | undefined): SidebarCardSettings {
  return applySidebarAppearance(settings, { bar })
}

/** 设／删单卡形状覆盖（undefined＝删除条目，恢复跟随整体）。旧调用面的兼容写法。 */
export function setSidebarCardBar(
  settings: SidebarCardSettings,
  id: string,
  shape: SidebarBarShape | undefined,
): SidebarCardSettings {
  const bars = copyRecord(settings.bars)
  if (shape === undefined) delete bars[id]
  else setOwn(bars, id, shape)
  return applySidebarAppearance(settings, { bars })
}

/** 仅用于迁移后菜单里对“尚未加载”的旧卡片做可读标注，不参与任何业务判断。 */
export const LEGACY_SIDEBAR_CARD_LABELS: Record<LegacySidebarCardID, string> = {
  quota: "额度",
  sessionOverview: "会话概览",
  subagents: "子代理",
  skill: "技能",
}

export type MigrationSource = "legacy-storage" | "options"

export interface HostCardSettings {
  version: 1
  /** 完整序列：隐藏卡片与暂未加载的卡片都占位。只存稳定身份。 */
  order: string[]
  /** 被隐藏的卡片 ID。不参与渲染，但始终留在 order 里。 */
  hidden: string[]
  /**
   * true 表示当前顺序只是启动时按注册顺序自动补齐的：用户还没保存过、也没迁移过。
   * 这种顺序允许之后被一次迁移替换；用户一旦在菜单里操作过即置 false。
   */
  auto: boolean
  /** 已迁移记录；存在即不再重复迁移（用户保存值优先）。 */
  migrated: { source: MigrationSource; at: number } | null
}

/** 旧聚合插件的设置形状（sidebar-cards-zh-v1）。只读取，不校验业务语义。 */
export interface LegacySidebarCardSettings {
  version?: unknown
  order?: unknown
  hidden?: unknown
}

export interface MigrationCandidate {
  readonly source: MigrationSource
  readonly legacy: LegacySidebarCardSettings
}

export function uninitializedHostCardSettings(): HostCardSettings {
  return { version: 1, order: [], hidden: [], auto: true, migrated: null }
}

function isLegacyCardID(value: unknown): value is LegacySidebarCardID {
  return typeof value === "string" && (LEGACY_SIDEBAR_CARD_IDS as readonly string[]).includes(value)
}

function toIDList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  for (const item of value) {
    if (typeof item !== "string") continue
    const id = item.trim()
    if (id.length === 0 || ids.includes(id)) continue
    ids.push(id)
  }
  return ids
}

/** 是否已有用户保存的顺序（非自动补齐）。 */
export function isHostCardInitialized(settings: HostCardSettings): boolean {
  return settings.order.length > 0 && !settings.auto
}

/**
 * 读取时容错：去重、丢空串与非字符串、hidden 收敛为 order 的子集。
 * 未知 ID（第三方卡片或暂缺的旧卡片）原样保留——它们承载用户的排序偏好。
 */
export function normalizeHostCardSettings(settings: HostCardSettings): HostCardSettings {
  const order = toIDList(settings.order)
  const hidden = toIDList(settings.hidden).filter((id) => order.includes(id))
  const migrated =
    settings.migrated && (settings.migrated.source === "legacy-storage" || settings.migrated.source === "options")
      ? { source: settings.migrated.source, at: Number.isFinite(settings.migrated.at) ? settings.migrated.at : 0 }
      : null
  return { version: 1, order, hidden, auto: settings.auto !== false, migrated }
}

/** 两份设置在持久化意义上是否相同（用于避免无意义写入）。 */
export function sameHostCardSettings(a: HostCardSettings, b: HostCardSettings): boolean {
  return (
    a.order.length === b.order.length &&
    a.order.every((id, index) => id === b.order[index]) &&
    a.hidden.length === b.hidden.length &&
    a.hidden.every((id, index) => id === b.hidden[index]) &&
    a.auto === b.auto &&
    (a.migrated?.source ?? null) === (b.migrated?.source ?? null) &&
    (a.migrated?.at ?? 0) === (b.migrated?.at ?? 0)
  )
}

/** 把缺失的 ID 追加到尾（新卡片默认追加，既有顺序不变）。 */
export function appendCardIDs(settings: HostCardSettings, ids: readonly string[]): HostCardSettings {
  const order = [...settings.order]
  for (const id of ids) if (!order.includes(id)) order.push(id)
  return { ...settings, order }
}

/** 显示／隐藏单张卡片。隐藏不改变它在 order 里的位置；未知 ID 先入列再记偏好。 */
export function setCardVisible(settings: HostCardSettings, id: string, visible: boolean): HostCardSettings {
  const order = settings.order.includes(id) ? [...settings.order] : [...settings.order, id]
  const hidden = visible
    ? settings.hidden.filter((item) => item !== id)
    : settings.hidden.includes(id)
      ? [...settings.hidden]
      : [...settings.hidden, id]
  return { ...settings, order, hidden, auto: false }
}

/**
 * 上移／下移：以完整序列交换相邻项，隐藏卡片同样参与。
 * 未知 ID 或到边界时原样返回同一对象引用（调用方用 `===` 识别“未变化”）。
 */
export function moveCard(settings: HostCardSettings, id: string, direction: "up" | "down"): HostCardSettings {
  const index = settings.order.indexOf(id)
  if (index === -1) return settings
  const target = direction === "up" ? index - 1 : index + 1
  if (target < 0 || target >= settings.order.length) return settings
  const order = [...settings.order]
  const [moved] = order.splice(index, 1)
  order.splice(target, 0, moved)
  return { ...settings, order, auto: false }
}

/** 实际渲染的卡片：按完整顺序过滤掉隐藏项（暂未加载的卡片由调用方再过滤）。 */
export function visibleCardIDs(settings: HostCardSettings): string[] {
  return settings.order.filter((id) => !settings.hidden.includes(id))
}

/**
 * 把任意来路的值（旧存储读出的对象、context.options.legacySettings）解析成
 * 可迁移的旧设置；形状不符或 order 为空时返回 undefined（无可迁移内容）。
 */
export function readLegacyCandidate(value: unknown): LegacySidebarCardSettings | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const order = toIDList((value as LegacySidebarCardSettings).order).filter(isLegacyCardID)
  if (order.length === 0) return undefined
  const hidden = toIDList((value as LegacySidebarCardSettings).hidden).filter(
    (id): id is LegacySidebarCardID => isLegacyCardID(id) && order.includes(id),
  )
  return { version: 1, order, hidden }
}

/**
 * 计算本次启动应生效的设置：
 * - 已迁移过、或用户已保存过：保留存档，只把新注册的卡片追加到尾；
 * - 尚未保存也未迁移，且能读到旧设置：迁移（顺序与显隐原样保留，含暂缺卡片），
 *   再把新注册的卡片追加到尾；
 * - 读不到旧设置：按注册顺序自动补齐（auto 保持 true，之后读到旧设置仍可迁移）。
 */
export function applyCardSettings(
  settings: HostCardSettings,
  registeredIDs: readonly string[],
  candidate: MigrationCandidate | undefined,
  now: number,
): HostCardSettings {
  const base = normalizeHostCardSettings(settings)
  const legacy = candidate ? readLegacyCandidate(candidate.legacy) : undefined
  if (base.migrated === null && !isHostCardInitialized(base) && legacy && Array.isArray(legacy.order) && legacy.order.length > 0) {
    const migrated: HostCardSettings = {
      version: 1,
      order: [...legacy.order] as string[],
      hidden: [...(legacy.hidden as string[])],
      auto: false,
      migrated: { source: candidate!.source, at: now },
    }
    return appendCardIDs(migrated, registeredIDs)
  }
  return appendCardIDs(base, registeredIDs)
}
