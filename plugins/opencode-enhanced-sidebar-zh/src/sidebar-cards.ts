/**
 * 侧栏新增卡片的稳定身份、默认顺序，以及显隐／排序设置的持久化逻辑。
 *
 * 只放纯函数和类型：不 import context、不做 IO，方便脱离 TUI 直接验证。
 * 命令面板菜单见 tui-v2-sidebar-card-menu.tsx，宿主渲染见 tui-v2.tsx。
 *
 * 设置契约：
 * - 顺序／显隐的权威来源是宿主写入 cli.json 插件选项的文件配置（options.sidebarCards），
 *   统一窗口保存的就是它；旧 storage 存档仅作无文件配置时的遗留回退；
 * - 首次两者皆无时按既有顺序（额度、会话概览、子代理、技能）初始化，旧启用选项决定首次显隐；
 * - 读取时忽略未知 ID、补齐缺失的已知 ID，防止旧设置或将来增减卡片导致空白侧栏；
 * - 顺序包含隐藏卡片：上移／下移以完整序列为准，重新显示后位置可预测。
 */

/** 四张新增卡片的稳定身份。新增卡片往数组末尾加，不要重排既有 ID。 */
export const SIDEBAR_CARD_IDS = ["quota", "sessionOverview", "subagents", "skill"] as const

export type SidebarCardID = (typeof SIDEBAR_CARD_IDS)[number]

export type SidebarCardSettings = {
  version: 1
  /** 完整保存的卡片序列：隐藏卡片也占位，菜单的上移／下移以它为准。 */
  order: SidebarCardID[]
  /** 被隐藏的卡片 ID。不参与渲染，但始终留在 order 里。 */
  hidden: SidebarCardID[]
}

/** 存储键：和子代理／会话概览的设置键同风格，带版本号。 */
export const SIDEBAR_CARD_SETTINGS_KEY = "sidebar-cards-zh-v1"

export const SIDEBAR_CARD_LABELS: Record<SidebarCardID, string> = {
  quota: "额度",
  sessionOverview: "会话概览",
  subagents: "子代理",
  skill: "技能",
}

/** 旧启动选项：只决定“首次没有新设置时”的显隐，之后由保存值覆盖。 */
export type SidebarCardOptions = {
  sessionOverview?: boolean
  subagents?: boolean
  /** 技能卡片的启用选项历史上叫 skillPanel。 */
  skillPanel?: boolean
  /**
   * 宿主写入 cli.json 的文件配置（统一窗口的安全写回目标）。
   * 文件配置是顺序／显隐的权威来源；旧 storage 仅作无文件配置时的遗留回退。
   */
  sidebarCards?: { order?: unknown; hidden?: unknown }
}

const CARD_OPTION_KEYS: Record<Exclude<SidebarCardID, "quota">, keyof SidebarCardOptions> = {
  sessionOverview: "sessionOverview",
  subagents: "subagents",
  skill: "skillPanel",
}

/** 未初始化的哨兵值：order 为空表示用户还没用过菜单，按旧选项初始化。 */
export function uninitializedSidebarCardSettings(): SidebarCardSettings {
  return { version: 1, order: [], hidden: [] }
}

function isCardID(value: unknown): value is SidebarCardID {
  return typeof value === "string" && (SIDEBAR_CARD_IDS as readonly string[]).includes(value)
}

function toIDArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 是否已有菜单保存的设置。空的或损坏的 order 都视为未初始化。 */
export function isSidebarCardInitialized(settings: SidebarCardSettings): boolean {
  return toIDArray(settings.order).length > 0
}

/** 首次无新设置：既有顺序 + 旧启用选项决定显隐。额度卡片没有对应选项，默认显示。 */
export function defaultSidebarCardSettings(options?: SidebarCardOptions): SidebarCardSettings {
  const hidden = (Object.keys(CARD_OPTION_KEYS) as Exclude<SidebarCardID, "quota">[])
    .filter((id) => options?.[CARD_OPTION_KEYS[id]] === false)
  return { version: 1, order: [...SIDEBAR_CARD_IDS], hidden }
}

/** 读取时容错：丢未知 ID、去重、补齐缺失的已知 ID，避免旧设置或将来增减卡片导致空白侧栏。 */
export function normalizeSidebarCardSettings(settings: SidebarCardSettings): SidebarCardSettings {
  const order: SidebarCardID[] = []
  for (const id of toIDArray(settings.order)) {
    if (isCardID(id) && !order.includes(id)) order.push(id)
  }
  for (const id of SIDEBAR_CARD_IDS) {
    if (!order.includes(id)) order.push(id)
  }
  const hidden = new Set(toIDArray(settings.hidden).filter(isCardID))
  return { version: 1, order, hidden: order.filter((id) => hidden.has(id)) }
}

/** 文件配置（宿主 cli.json 插件选项）：order 非空即权威；损坏或空视为未配置。 */
function fileConfigSidebarCardSettings(options?: SidebarCardOptions): SidebarCardSettings | undefined {
  const config = options?.sidebarCards
  if (!config || toIDArray(config.order).length === 0) return undefined
  return normalizeSidebarCardSettings({ version: 1, order: toIDArray(config.order) as SidebarCardID[], hidden: toIDArray(config.hidden) as SidebarCardID[] })
}

/**
 * 解析优先级：宿主文件配置（cli.json 插件选项）> 旧 storage 存档 > 旧启用选项默认。
 * 统一窗口保存写的是文件配置，因此它是顺序／显隐的权威来源；
 * 旧菜单写过的 storage 仅在没有文件配置时回退，避免旧存档覆盖窗口保存结果。
 */
export function resolveSidebarCardSettings(
  settings: SidebarCardSettings,
  options?: SidebarCardOptions,
): SidebarCardSettings {
  const fileConfig = fileConfigSidebarCardSettings(options)
  if (fileConfig !== undefined) return fileConfig
  if (!isSidebarCardInitialized(settings)) return defaultSidebarCardSettings(options)
  return normalizeSidebarCardSettings(settings)
}

/** 实际渲染的卡片：按完整顺序过滤掉隐藏项。 */
export function visibleSidebarCards(settings: SidebarCardSettings): SidebarCardID[] {
  return settings.order.filter((id) => !settings.hidden.includes(id))
}

/** 显示／隐藏单张卡片。隐藏不改变它在 order 里的位置。 */
export function setSidebarCardVisible(
  settings: SidebarCardSettings,
  id: SidebarCardID,
  visible: boolean,
): SidebarCardSettings {
  if (visible) {
    return { ...settings, hidden: settings.hidden.filter((item) => item !== id) }
  }
  if (settings.hidden.includes(id)) return settings
  return { ...settings, hidden: [...settings.hidden, id] }
}

/** 上移／下移：以完整序列交换相邻项，隐藏卡片同样参与；到边界时原样返回。 */
export function moveSidebarCard(
  settings: SidebarCardSettings,
  id: SidebarCardID,
  direction: "up" | "down",
): SidebarCardSettings {
  const index = settings.order.indexOf(id)
  if (index === -1) return settings
  const target = direction === "up" ? index - 1 : index + 1
  if (target < 0 || target >= settings.order.length) return settings
  const order = [...settings.order]
  const [moved] = order.splice(index, 1)
  order.splice(target, 0, moved)
  return { ...settings, order }
}
