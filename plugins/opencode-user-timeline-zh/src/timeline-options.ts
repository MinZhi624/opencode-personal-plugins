/** 用户节点卡片的展示选项：纯函数，供卡片渲染与统一窗口的控制字段共用。
 *
 *  归属：visibleRows / scroll 是本插件的 cli.json 插件选项，由插件自己经
 *  host/src/plugin-options.ts 的安全写回 helper 定位唯一条目后保存；
 *  宿主不复制这份设置。折叠状态不进 cli.json，由插件自己的 storage 拥有。
 */

export const TIMELINE_CARD_ID = "timeline"
export const TIMELINE_DEFAULT_VISIBLE_ROWS = 8
export const TIMELINE_MIN_VISIBLE_ROWS = 3
export const TIMELINE_MAX_VISIBLE_ROWS = 20

export interface TimelineOptions {
  visibleRows: number
  scroll: boolean
}

function parseRows(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN
  if (!Number.isFinite(parsed)) return undefined
  return Math.floor(parsed)
}

/** 读取沿用既有含义：合法整数按原值生效，否则回退默认；不因接入统一窗口收窄已有选项。 */
export function readVisibleRows(value: unknown): number {
  const parsed = parseRows(value)
  return parsed !== undefined && parsed >= TIMELINE_MIN_VISIBLE_ROWS && parsed <= TIMELINE_MAX_VISIBLE_ROWS
    ? parsed
    : TIMELINE_DEFAULT_VISIBLE_ROWS
}

/** 初始滚动方式是布尔：只有显式 false 才退回静态最新 N 条。 */
export function readScroll(value: unknown): boolean {
  return value !== false
}

export function readTimelineOptions(options: Record<string, unknown> | undefined): TimelineOptions {
  return {
    visibleRows: readVisibleRows(options?.visibleRows),
    scroll: readScroll(options?.scroll),
  }
}

/** 新输入只接受范围内的整数；非法值明确拒绝，不静默 clamp 成别的数。 */
export function writeVisibleRows(value: unknown): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value.trim()) : Number.NaN
  if (!Number.isInteger(parsed) || parsed < TIMELINE_MIN_VISIBLE_ROWS || parsed > TIMELINE_MAX_VISIBLE_ROWS) {
    throw new Error(`显示行数只能填 ${TIMELINE_MIN_VISIBLE_ROWS} 到 ${TIMELINE_MAX_VISIBLE_ROWS} 的整数`)
  }
  return parsed
}

/** 写入只产出真正的布尔值，避免手写 "false" 字符串被读成开启。 */
export function writeScroll(value: unknown): boolean {
  return value === true
}
