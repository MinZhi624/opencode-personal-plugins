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
 * - 排序设置由宿主拥有：卸载某张卡片不删除其他卡片的设置，宿主卸载不删设置。
 */

/** 宿主自己的设置键（与旧聚合插件的 `sidebar-cards-zh-v1` 是不同键，互不覆写）。 */
export const HOST_SETTINGS_KEY = "sidebar-host-zh-v1"

/** 旧聚合插件的设置键：只读来源，宿主绝不写入或删除该键。 */
export const LEGACY_SIDEBAR_CARD_SETTINGS_KEY = "sidebar-cards-zh-v1"

/** 旧聚合插件的四张卡片稳定身份（迁移时原样保留，不重命名）。 */
export const LEGACY_SIDEBAR_CARD_IDS = ["quota", "sessionOverview", "subagents", "skill"] as const

export type LegacySidebarCardID = (typeof LEGACY_SIDEBAR_CARD_IDS)[number]

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
