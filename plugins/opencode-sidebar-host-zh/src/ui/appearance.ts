/**
 * 外观（进度条形状）草稿的纯函数：与文件字段 bar/bars 一一对应。
 *
 * 优先级在消费者侧固定为：卡片覆盖 › 整体 › 卡片自己的设置。
 * `none` 只让 `sidebarBarParts` 返回空串（进度条消失），数字行由卡片自己保留。
 *
 * 覆盖表的键是任意合法卡片 ID（含 `__proto__`）：一律用 defineProperty 写自有属性、
 * 用 hasOwn 读自有属性，不走赋值／索引的原型链语义。
 */
import { isSidebarBarShape, SIDEBAR_BAR_SHAPES, type SidebarAppearance, type SidebarBarShape } from "../presentation.ts"

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

/** 从任意来路的对象里取出有效外观（无效形状一律丢弃，不猜默认值）。 */
export function appearanceOf(value: { bar?: unknown; bars?: unknown } | undefined): SidebarAppearance {
  const result: SidebarAppearance = {}
  if (value?.bar !== undefined && isSidebarBarShape(value.bar)) result.bar = value.bar
  if (value?.bars !== undefined && typeof value.bars === "object" && value.bars !== null) {
    const bars: Record<string, SidebarBarShape> = {}
    for (const [id, shape] of Object.entries(value.bars as Record<string, unknown>)) {
      if (isSidebarBarShape(shape)) {
        Object.defineProperty(bars, id, { value: shape, enumerable: true, writable: true, configurable: true })
      }
    }
    if (Object.keys(bars).length > 0) result.bars = bars
  }
  return result
}

/** 两份外观在持久化意义上是否相同（undefined 与缺键等价，只比自有条目）。 */
export function sameAppearance(a: SidebarAppearance, b: SidebarAppearance): boolean {
  if (a.bar !== b.bar) return false
  const left = a.bars ?? {}
  const right = b.bars ?? {}
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => Object.hasOwn(right, key) && ownCardBar(left, key) === ownCardBar(right, key))
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
