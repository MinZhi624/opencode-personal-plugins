/**
 * 窄窗文本度量：纯函数，不依赖终端能力探测。
 *
 * 中文宽度按 2 列计（East Asian Wide/Fullwidth 的常用区段近似），
 * 这样 `fit`／`padEndDisplay` 在中文窄窗里不会把边框撑破或把标签切半。
 */

/** 常用宽字符区段（CJK、全角、谚文、兼容表意等）。 */
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u3000-\u303F\u4E00-\u9FFF\u3400-\u4DBF]/

/** 文本占几列。 */
export function columnsOf(text: string): number {
  let columns = 0
  for (const char of text) columns += WIDE.test(char) ? 2 : 1
  return columns
}

/** 截断到 `width` 列，超出部分用 … 收尾（宽度不足 1 列时只给 …）。 */
export function fit(text: string, width: number): string {
  if (width <= 0) return ""
  if (columnsOf(text) <= width) return text
  if (width === 1) return "…"
  let out = ""
  let used = 0
  for (const char of text) {
    const step = WIDE.test(char) ? 2 : 1
    if (used + step > width - 1) break
    out += char
    used += step
  }
  return `${out}…`
}

/** 右侧补空格到 `width` 列（已经不宽就不补）。 */
export function padEndDisplay(text: string, width: number): string {
  const pad = width - columnsOf(text)
  return pad > 0 ? `${text}${" ".repeat(pad)}` : text
}

/** 一列的框架："‹ " + 值 + " ›" 与标题前后的空格。 */
const LINE_FRAME = 8
const TITLE_WIDTH = 16
const TITLE_MIN = 6
const VALUE_WIDTH = 12
const VALUE_MIN = 4
/** 窄到这个宽度就改成上下堆叠（标题一行、值一行），不再横向排。 */
export const STACK_WIDTH = 22

/**
 * 一行的标题与值各占几列：默认 16／12；放不下时标题先让（到 6 列），值再让（到 4 列）。
 * 中文窄窗下标题仍保留卡片名的主干，值列保留状态词。
 */
export function lineColumns(
  width: number | undefined,
  valueWidth = VALUE_WIDTH,
): { title: number; value: number } {
  if (width === undefined) return { title: TITLE_WIDTH, value: valueWidth }
  const room = Math.max(0, width - LINE_FRAME)
  const title = Math.max(TITLE_MIN, Math.min(TITLE_WIDTH, room - valueWidth))
  const value = Math.max(VALUE_MIN, Math.min(valueWidth, room - title))
  return { title, value }
}

/** 行的注释放不下进行内时，行下缩进：按实际可用宽钳制，绝不强撑宽。 */
export function noteIndent(width: number | undefined, inline: number): number {
  if (width === undefined) return inline
  return Math.max(0, Math.min(inline, width - 8))
}

/** 横排页面条的一项。 */
export interface StripItem<Key> {
  readonly key: Key
  readonly label: string
}

/**
 * 横排页面条在 `width` 列里能放下的片段：全放得下就全给；
 * 否则以当前页为中心向两侧展开，被藏起来的一侧给 ‹ ／ ›。
 */
export function stripWindow<Key>(
  items: readonly StripItem<Key>[],
  chosen: Key,
  width: number,
): { items: readonly StripItem<Key>[]; left: boolean; right: boolean } {
  const start = Math.max(0, items.findIndex((item) => item.key === chosen))
  const budget = Math.max(1, width - 4)
  let first = start
  let last = start
  let used = columnsOf(items[start]?.label ?? "")
  while (first > 0 || last < items.length - 1) {
    const left = first > 0 ? columnsOf(items[first - 1]!.label) + 3 : Number.POSITIVE_INFINITY
    const right = last < items.length - 1 ? columnsOf(items[last + 1]!.label) + 3 : Number.POSITIVE_INFINITY
    const takeLeft = left <= right
    const cost = takeLeft ? left : right
    if (used + cost > budget) {
      const other = takeLeft ? right : left
      if (other === Number.POSITIVE_INFINITY || used + other > budget) break
      if (takeLeft) last += 1
      else first -= 1
      used += other
      continue
    }
    if (takeLeft) first -= 1
    else last += 1
    used += cost
  }
  return { items: items.slice(first, last + 1), left: first > 0, right: last < items.length - 1 }
}
