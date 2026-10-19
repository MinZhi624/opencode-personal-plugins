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
 * - 展示偏好还含本套侧栏专属的整体进度条形状（bar）与单卡覆盖（bars），
 *   优先级为明确的卡片覆盖 > 明确的整体形状 > 卡片自身设置／默认形状；
 *   宿主只为侧栏派生展示，不改写 Quota 跨展示位置共用的形状设置。
 * 形状词汇（blocks、shades、line、squares、dots、none）以 presentation.ts
 * 的 `isSidebarBarShape` 为唯一来源，避免两处定义漂移。
 */

import { isSidebarBarShape, type SidebarBarShape } from "./presentation.ts"

/** 宿主自己的设置键（与旧聚合插件的 `sidebar-cards-zh-v1` 是不同键，互不覆写）。 */
export const HOST_SETTINGS_KEY = "sidebar-host-zh-v1"

/** 旧聚合插件的设置键：只读来源，宿主绝不写入或删除该键。 */
export const LEGACY_SIDEBAR_CARD_SETTINGS_KEY = "sidebar-cards-zh-v1"

/** 旧聚合插件的四张卡片稳定身份（迁移时原样保留，不重命名）。 */
export const LEGACY_SIDEBAR_CARD_IDS = ["quota", "sessionOverview", "subagents", "skill"] as const

export type LegacySidebarCardID = (typeof LEGACY_SIDEBAR_CARD_IDS)[number]

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
}

/** 六个可选形状的报错文案，parse 与界面提示共用同一份词汇。 */
const BAR_SHAPE_HINT = "blocks、shades、line、squares、dots 或 none"

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * 卡片 ID 是任意非空稳定字符串（`__proto__` 等特殊键同样是合法 ID）：
 * 覆盖表一律用 defineProperty 写自有属性、用 hasOwn 读自有属性，
 * 不走赋值／索引的原型链语义，也不因键名特殊拒绝任何合法 ID。
 */
function setOwnBar(bars: Record<string, SidebarBarShape>, id: string, shape: SidebarBarShape): void {
  Object.defineProperty(bars, id, { value: shape, enumerable: true, writable: true, configurable: true })
}

function ownBar(bars: Record<string, SidebarBarShape> | undefined, id: string): SidebarBarShape | undefined {
  if (bars === undefined || !Object.hasOwn(bars, id)) return undefined
  return bars[id]
}

/** 复制覆盖表：只复制自有可枚举条目，`__proto__` 等键落成自有数据属性而非原型赋值。 */
function copyBars(bars: Record<string, SidebarBarShape> | undefined): Record<string, SidebarBarShape> {
  return bars === undefined ? {} : Object.fromEntries(Object.entries(bars))
}

/** 规范化外观字段：空覆盖等同未设置，避免 `{}` 与缺省被当成两种持久化状态。 */
function appearanceOf(settings: SidebarCardSettings): { bar?: SidebarBarShape; bars?: Record<string, SidebarBarShape> } {
  const appearance: { bar?: SidebarBarShape; bars?: Record<string, SidebarBarShape> } = {}
  if (settings.bar !== undefined) appearance.bar = settings.bar
  if (settings.bars !== undefined && Object.keys(settings.bars).length > 0) appearance.bars = copyBars(settings.bars)
  return appearance
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
    if (isSidebarBarShape(rawBar)) settings.bar = rawBar
    else issues.push(`sidebarCards.bar 必须是 ${BAR_SHAPE_HINT} 之一，已忽略`)
  }
  const rawBars = input.bars
  if (rawBars !== undefined) {
    if (!isPlainObject(rawBars)) {
      issues.push("sidebarCards.bars 必须是对象，已忽略")
    } else {
      const bars: Record<string, SidebarBarShape> = {}
      let badID = false
      let badShape = false
      for (const [id, shape] of Object.entries(rawBars)) {
        if (id.trim().length === 0) { badID = true; continue }
        if (!isSidebarBarShape(shape)) { badShape = true; continue }
        setOwnBar(bars, id, shape)
      }
      if (badID) issues.push("sidebarCards.bars 含无效卡片 ID，已忽略无效项")
      if (badShape) issues.push(`sidebarCards.bars 的形状值必须是 ${BAR_SHAPE_HINT} 之一，已忽略无效项`)
      if (Object.keys(bars).length > 0) settings.bars = bars
    }
  }
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
  // 排序／显隐的修改不得丢失已保存的形状偏好。
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

function sameBar(a: SidebarBarShape | undefined, b: SidebarBarShape | undefined): boolean {
  return (a ?? null) === (b ?? null)
}

/** 空覆盖与未设置等价：避免把 `{}` 与缺省判成两种持久化状态。 */
function sameBars(a: Record<string, SidebarBarShape> | undefined, b: Record<string, SidebarBarShape> | undefined): boolean {
  const left = a ?? {}
  const right = b ?? {}
  const ids = Object.keys(left)
  // 只比自有条目：原型链上的同名属性不参与，也不因右表缺自有键而误判相等。
  return ids.length === Object.keys(right).length && ids.every((id) => ownBar(left, id) === ownBar(right, id))
}

/** 持久化意义上的相同：顺序、显隐与可选形状都参与比较（写回前校验与冲突检测共用）。 */
export function sameSidebarCards(a: SidebarCardSettings, b: SidebarCardSettings): boolean {
  return a.order.length === b.order.length && a.order.every((id, i) => id === b.order[i]) &&
    a.hidden.length === b.hidden.length && a.hidden.every((id, i) => id === b.hidden[i]) &&
    sameBar(a.bar, b.bar) && sameBars(a.bars, b.bars)
}

/** 只保留形状值合法的覆盖条目；没有合法条目时返回 undefined（等同未设置）。 */
function nonEmptyBars(bars: Record<string, SidebarBarShape> | undefined): Record<string, SidebarBarShape> | undefined {
  if (bars === undefined) return undefined
  const entries = Object.entries(bars).filter(([, shape]) => isSidebarBarShape(shape))
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

/**
 * 设置或清除整体进度条形状。shape 为 undefined 表示不强制，
 * 各卡片回到自身已有设置或默认形状；顺序与显隐原样保留。
 */
export function setSidebarSharedBar(settings: SidebarCardSettings, shape: SidebarBarShape | undefined): SidebarCardSettings {
  if (shape !== undefined && !isSidebarBarShape(shape)) return settings
  const next: SidebarCardSettings = { order: [...settings.order], hidden: [...settings.hidden] }
  if (shape !== undefined) next.bar = shape
  const bars = nonEmptyBars(settings.bars)
  if (bars !== undefined) next.bars = bars
  return next
}

/**
 * 设置或清除单张卡片的形状覆盖。shape 为 undefined 即恢复跟随整体；
 * 未知／暂未加载的卡片 ID 同样保留偏好（与 hidden 的占位规则一致）。
 */
export function setSidebarCardBar(settings: SidebarCardSettings, cardID: string, shape: SidebarBarShape | undefined): SidebarCardSettings {
  if (typeof cardID !== "string" || cardID.trim().length === 0) return settings
  if (shape !== undefined && !isSidebarBarShape(shape)) return settings
  const bars = copyBars(nonEmptyBars(settings.bars))
  if (shape === undefined) delete bars[cardID]
  else setOwnBar(bars, cardID, shape)
  const next: SidebarCardSettings = { order: [...settings.order], hidden: [...settings.hidden] }
  if (settings.bar !== undefined) next.bar = settings.bar
  if (Object.keys(bars).length > 0) next.bars = bars
  return next
}

/**
 * 某张卡片当前生效的形状与继承来源（界面标注用，不改变卡片自身默认值）：
 * 明确的卡片覆盖 > 明确的整体形状 > 卡片自身设置／默认（宿主不替卡片决定默认形状）。
 */
export function resolveSidebarBar(
  settings: SidebarCardSettings,
  cardID: string,
): { shape: SidebarBarShape | undefined; source: "card-override" | "shared" | "card-default" } {
  const override = ownBar(settings.bars, cardID)
  if (override !== undefined) return { shape: override, source: "card-override" }
  if (settings.bar !== undefined) return { shape: settings.bar, source: "shared" }
  return { shape: undefined, source: "card-default" }
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
