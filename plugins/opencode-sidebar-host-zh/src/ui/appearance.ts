/**
 * 外观（进度条形状）草稿的纯函数：与文件字段 bar/bars 一一对应。
 *
 * 优先级在消费者侧固定为：卡片覆盖 › 整体 › 卡片自己的设置。
 * `none` 只让 `sidebarBarParts` 返回空串（进度条消失），数字行由卡片自己保留。
 *
 * 覆盖表的键是任意合法卡片 ID（含 `__proto__`）：一律用 defineProperty 写自有属性、
 * 用 hasOwn 读自有属性，不走赋值／索引的原型链语义。
 */
import {
  isSidebarBarShape,
  isSidebarBarWidth,
  isSidebarColor,
  SIDEBAR_BAR_SHAPES,
  sidebarBarParts,
  type SidebarAppearance,
  type SidebarBarShape,
  type SidebarBarWidth,
  type SidebarColors,
  type SidebarLayout,
} from "../presentation.ts"

/** 外观提取的输入面：各字段以未知值进来，逐项校验。 */
export interface AppearanceInput {
  bar?: unknown
  bars?: unknown
  barWidth?: unknown
  barWidths?: unknown
  layout?: unknown
  cardLayout?: unknown
  colors?: unknown
  cardColors?: unknown
}

/** 六种形状的中文名。 */
export const SHAPE_TITLES: Record<SidebarBarShape, string> = {
  blocks: "方块",
  shades: "阴影",
  line: "细线",
  squares: "方形",
  dots: "圆点",
  none: "无",
}

/** 形状的可选项：不设置（整体＝卡片自己的设置；覆盖＝继承整体）+ 六种形状。 */
export const SHAPE_CHOICES: readonly (SidebarBarShape | undefined)[] = [undefined, ...SIDEBAR_BAR_SHAPES]

/** 覆盖行“继承整体”的显示词。 */
export const INHERIT_TITLE = "继承"
/** 整体行“不设置”的显示词。 */
export const UNSET_TITLE = "卡片自己的设置"

/** 覆盖表副本：只复制自有可枚举条目，`__proto__` 等键落成自有数据属性。 */
export function copyBars(bars: Record<string, SidebarBarShape> | undefined): Record<string, SidebarBarShape> {
  return bars === undefined ? {} : Object.fromEntries(Object.entries(bars))
}

/** 设／清单卡覆盖：`shape` 为 undefined 即删除该卡条目（恢复跟随整体）。 */
export function withCardBar(
  bars: Record<string, SidebarBarShape> | undefined,
  id: string,
  shape: SidebarBarShape | undefined,
): Record<string, SidebarBarShape> {
  const next = copyBars(bars)
  if (shape === undefined) delete next[id]
  else Object.defineProperty(next, id, { value: shape, enumerable: true, writable: true, configurable: true })
  return next
}

/** 读单卡覆盖（只读自有属性；原型链上的同名属性不算）。 */
export function ownCardBar(bars: Record<string, SidebarBarShape> | undefined, id: string): SidebarBarShape | undefined {
  return bars !== undefined && Object.hasOwn(bars, id) ? bars[id] : undefined
}

/** 从任意来路的对象里取出有效外观（无效值一律丢弃，不猜默认值）。 */
export function appearanceOf(value: AppearanceInput | undefined): SidebarAppearance {
  const result: SidebarAppearance = {}
  const bar = value?.bar
  if (isSidebarBarShape(bar)) result.bar = bar
  const bars = shapeRecord(value?.bars)
  if (bars !== undefined) result.bars = bars
  if (isSidebarBarWidth(value?.barWidth)) result.barWidth = value.barWidth
  const widths = widthRecord(value?.barWidths)
  if (widths !== undefined) result.barWidths = widths
  const layout = layoutValue(value?.layout)
  if (layout !== undefined) result.layout = layout
  const cardLayout = recordOf(value?.cardLayout, layoutValue)
  if (cardLayout !== undefined) result.cardLayout = cardLayout
  const colors = colorsValue(value?.colors)
  if (colors !== undefined) result.colors = colors
  const cardColors = recordOf(value?.cardColors, colorsValue)
  if (cardColors !== undefined) result.cardColors = cardColors
  return result
}

/** 两份外观在持久化意义上是否相同（undefined 与缺键等价，只比自有条目）。 */
export function sameAppearance(a: SidebarAppearance, b: SidebarAppearance): boolean {
  return (
    a.bar === b.bar &&
    sameRecordMap(a.bars, b.bars, (left, right) => left === right) &&
    a.barWidth === b.barWidth &&
    sameRecordMap(a.barWidths, b.barWidths, (left, right) => left === right) &&
    sameObject(a.layout, b.layout) &&
    sameRecordMap(a.cardLayout, b.cardLayout, sameObject) &&
    sameObject(a.colors, b.colors) &&
    sameRecordMap(a.cardColors, b.cardColors, sameObject)
  )
}

/** 生效形状：卡片覆盖 › 整体 › 卡片自己的设置（undefined）。 */
export function effectiveShape(appearance: SidebarAppearance, cardID: string): SidebarBarShape | undefined {
  return ownCardBar(appearance.bars, cardID) ?? appearance.bar
}

/** 形状的显示词；`undefined` 用调用方给的词（继承／卡片自己的设置）。 */
export function shapeTitle(shape: SidebarBarShape | undefined, unset: string): string {
  return shape === undefined ? unset : SHAPE_TITLES[shape]
}

/** 在一组可选项里循环：未知值从一端进入，不会卡住。 */
export function stepChoice<T>(choices: readonly T[], current: T | undefined, delta: number): T {
  const index = choices.indexOf(current as T)
  const base = index === -1 ? (delta < 0 ? 0 : choices.length - 1) : index
  return choices[(base + delta + choices.length * 2) % choices.length]!
}

// ---------------------------------------------------------------- 提取与比较

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 覆盖表提取：只留合法条目（`__proto__` 等键落成自有数据属性），空表即未设置。 */
function recordOf<T>(value: unknown, pick: (item: unknown) => T | undefined): Record<string, T> | undefined {
  if (!isRecord(value)) return undefined
  const result: Record<string, T> = {}
  for (const [id, item] of Object.entries(value)) {
    const picked = pick(item)
    if (picked !== undefined) {
      Object.defineProperty(result, id, { value: picked, enumerable: true, writable: true, configurable: true })
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

const shapeRecord = (value: unknown) => recordOf(value, (item) => (isSidebarBarShape(item) ? item : undefined))
const widthRecord = (value: unknown) => recordOf(value, (item) => (isSidebarBarWidth(item) ? item : undefined))

const LAYOUT_NUMBER_KEYS = ["gap", "lineGap", "indent", "labelWidth"] as const

function layoutValue(value: unknown): SidebarLayout | undefined {
  if (!isRecord(value)) return undefined
  const result: SidebarLayout = {}
  for (const key of LAYOUT_NUMBER_KEYS) {
    const item = value[key]
    if (typeof item === "number" && Number.isSafeInteger(item) && item >= 0) result[key] = item
  }
  if (typeof value.divider === "boolean") result.divider = value.divider
  return Object.keys(result).length > 0 ? result : undefined
}

function colorsValue(value: unknown): SidebarColors | undefined {
  if (!isRecord(value)) return undefined
  const result: SidebarColors = {}
  for (const [role, item] of Object.entries(value)) {
    if (isSidebarColor(item)) Object.defineProperty(result, role, { value: item, enumerable: true, writable: true, configurable: true })
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function sameObject<T extends object>(a: T | undefined, b: T | undefined): boolean {
  const left = a ?? {}
  const right = b ?? {}
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && (left as Record<string, unknown>)[key] === (right as Record<string, unknown>)[key])
  )
}

function sameRecordMap<T>(
  a: Record<string, T> | undefined,
  b: Record<string, T> | undefined,
  same: (left: T | undefined, right: T | undefined) => boolean,
): boolean {
  const left = a ?? {}
  const right = b ?? {}
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => same(Object.hasOwn(left, key) ? left[key] : undefined, Object.hasOwn(right, key) ? right[key] : undefined))
}

/** 通用覆盖表读写（形状、宽度、布局、颜色共用）：只认自有属性，undefined＝删除条目。 */
export function ownCardValue<T>(record: Record<string, T> | undefined, id: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, id) ? record[id] : undefined
}

export function withCardValue<T>(
  record: Record<string, T> | undefined,
  id: string,
  value: T | undefined,
): Record<string, T> {
  const next: Record<string, T> = record === undefined ? {} : Object.fromEntries(Object.entries(record))
  if (value === undefined) delete next[id]
  else Object.defineProperty(next, id, { value, enumerable: true, writable: true, configurable: true })
  return next
}

/** 选项行里的进度条小样例：50% 处 6 格，直观区分形状。 */
export function shapeSample(shape: SidebarBarShape): string {
  const [filled, empty] = sidebarBarParts(shape, 50, 6)
  return `${filled}${empty}`
}
