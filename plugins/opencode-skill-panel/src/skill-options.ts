/** 技能面板的展示选项：纯函数，供卡片渲染与统一窗口的控制字段共用。
 *
 *  归属：skillPanelMaxUsed / skillPanelDefaultOpen 是本插件的 cli.json 插件选项，
 *  由插件自己经 host/src/plugin-options.ts 的安全写回 helper 定位唯一条目后保存；
 *  宿主不复制这份设置，统一窗口只经本模块与 card-controls.ts 读写。
 */

export const SKILL_PANEL_MAX_USED_DEFAULT = 8

/** 有效范围：0 是合法值（原有 slice(0, 0) 语义，表示不列项目），上界取安全整数。
 *  展示层迁移不收窄已有选项：读取时任何已有的非负安全整数都按原值生效。 */
export const SKILL_PANEL_MAX_USED_MIN = 0
export const SKILL_PANEL_MAX_USED_MAX = Number.MAX_SAFE_INTEGER

export interface SkillPanelDisplayOptions {
  skillPanelMaxUsed: number
  skillPanelDefaultOpen: boolean
}

function parseCount(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN
  if (!Number.isFinite(parsed)) return undefined
  return Math.floor(parsed)
}

/** 读取沿用既有含义：已是非负安全整数就按原值生效，否则回退默认；不因接入统一窗口收窄取值。 */
export function readMaxUsed(value: unknown): number {
  const parsed = parseCount(value)
  return parsed !== undefined && parsed >= SKILL_PANEL_MAX_USED_MIN && parsed <= SKILL_PANEL_MAX_USED_MAX
    ? parsed
    : SKILL_PANEL_MAX_USED_DEFAULT
}

/** 初始展开沿用现有含义：只有布尔 false 才算折叠。 */
export function readDefaultOpen(value: unknown): boolean {
  return value !== false
}

export function readSkillPanelOptions(options: Record<string, unknown> | undefined): SkillPanelDisplayOptions {
  return {
    skillPanelMaxUsed: readMaxUsed(options?.skillPanelMaxUsed),
    skillPanelDefaultOpen: readDefaultOpen(options?.skillPanelDefaultOpen),
  }
}

/** 新输入只接受 0 或安全整数范围内的正整数；非法值明确拒绝，不静默 clamp 成别的数。 */
export function writeMaxUsed(value: unknown): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value.trim()) : Number.NaN
  if (!Number.isInteger(parsed) || parsed < SKILL_PANEL_MAX_USED_MIN || parsed > SKILL_PANEL_MAX_USED_MAX) {
    throw new Error("最多显示只能填 0 或正整数")
  }
  return parsed
}

/** 写入只产出真正的布尔值，避免手写 "false" 字符串被读成展开。 */
export function writeDefaultOpen(value: unknown): boolean {
  return value === true
}
