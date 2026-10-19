/**
 * 设置行：标题 ‹ 值 ›（或 ▸ 动作）、行下注释／详情。
 *
 * 选中态用语义色（action.primary）；值的状态词用 feedback 语义色
 * （成功＝生效中、警告＝已隐藏、muted＝未加载）。窄窗下标题与值按
 * `lineColumns` 收缩；窄于 `STACK_WIDTH` 列时改成上下堆叠（标题一行、
 * 值一行），注释放不进行内就换到行下，缩进按实际可用宽钳制，绝不撑破边框。
 */
/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { Show } from "solid-js"
import { columnsOf, fit, lineColumns, noteIndent, padEndDisplay, STACK_WIDTH } from "./text.ts"
import type { WindowTheme } from "./types.ts"

export interface OptionLine {
  id: string
  title: string
  value: () => string
  /** ←/→ 回调；没有则不是可切换行。 */
  cycle?: (delta: number) => void
  /** space／enter 或点击值列的回调。 */
  run?: () => void
  note?: () => string
  detail?: () => string
  /** 标题上方的分组标题（只在该组第一行给出）。 */
  group?: string
  /** 纯信息行：不参与选择、不高亮。 */
  info?: boolean
  /** 信息行用警告色。 */
  warning?: boolean
  /** 值列的语义色。 */
  tone?: "success" | "warning" | "muted"
  /** 值列宽度（默认自适应）。 */
  valueWidth?: number
}

export function OptionRow(props: {
  line: OptionLine
  theme: WindowTheme
  active: boolean
  /** 行可用宽度（不含导航）；undefined = 不收缩。 */
  width?: number
  /** 行上按下：选中本行。 */
  press: () => void
  /** 使用本行（space／enter／点击值列）。 */
  use: () => void
}): JSX.Element {
  const line = props.line
  const fg = () => (props.active ? props.theme.text.action.primary.base : props.theme.text.base)
  const valueColor = () => {
    if (props.active) return fg()
    if (line.tone === "success") return props.theme.text.feedback.success.base
    if (line.tone === "warning") return props.theme.text.feedback.warning.base
    return props.theme.text.muted
  }
  const columns = () => lineColumns(props.width, line.valueWidth)
  const note = () => line.note?.() ?? ""
  const noteInline = () => {
    if (props.width === undefined) return true
    const end = 3 + columns().title + 1 + 2 + columns().value + 2
    return end + 2 + columnsOf(note()) <= props.width
  }
  /** 极窄窗：上下堆叠。 */
  const stack = () => props.width !== undefined && props.width < STACK_WIDTH
  /** 行下缩进：横向排时跟在值后，堆叠时只缩进一点；都按可用宽钳制。 */
  const indent = () => noteIndent(props.width, stack() ? 2 : 3 + columns().title + 3)

  if (line.info) {
    return (
      <box paddingLeft={stack() ? 1 : 3} flexShrink={1}>
        <text
          fg={line.warning ? props.theme.text.feedback.warning.base : props.theme.text.muted}
          wrapMode="word"
          selectable={false}
        >
          {line.title}
        </text>
      </box>
    )
  }

  const arrow = (text: string, onUp: () => void) => (
    <text
      fg={props.active ? fg() : props.theme.text.action.primary.base}
      wrapMode="none"
      flexShrink={0}
      selectable={false}
      onMouseUp={onUp}
    >
      {text}
    </text>
  )

  return (
    <>
      <Show when={line.group}>
        <box paddingTop={1}>
          <text
            fg={props.theme.text.action.primary.base}
            attributes={TextAttributes.BOLD}
            wrapMode="none"
            selectable={false}
          >
            {` ${line.group}`}
          </text>
        </box>
      </Show>
      <box id={`sidebar-cards.${line.id}`} flexDirection="row" backgroundColor={props.active ? props.theme.background?.raised.high : undefined} onMouseDown={props.press}>
        <Show
          when={!stack()}
          fallback={
            <box flexDirection="column" flexShrink={1}>
              <text fg={fg()} wrapMode="none" flexShrink={0} selectable={false}>
                {`   ${fit(line.title, Math.max(4, (props.width ?? 16) - 3))}`}
              </text>
              <box flexDirection="row">
                <Show when={line.cycle} fallback={<text fg={props.theme.text.muted} wrapMode="none" flexShrink={0} selectable={false}>{"  "}</text>}>
                  {arrow("‹ ", () => line.cycle?.(-1))}
                </Show>
                <text fg={valueColor()} wrapMode="none" flexShrink={0} selectable={false} onMouseUp={props.use}>
                  {fit(line.value(), Math.max(4, (props.width ?? 12) - 8))}
                </text>
                {arrow(line.run ? " ▸" : line.cycle ? " ›" : "  ", props.use)}
              </box>
            </box>
          }
        >
          <text fg={fg()} attributes={props.active ? TextAttributes.BOLD : TextAttributes.NONE} wrapMode="none" flexShrink={0} selectable={false}>
            {`   ${padEndDisplay(fit(line.title, columns().title), columns().title)} `}
          </text>
          <Show when={line.cycle} fallback={<text fg={props.theme.text.muted} wrapMode="none" flexShrink={0} selectable={false}>{"  "}</text>}>
            {arrow("‹ ", () => line.cycle?.(-1))}
          </Show>
          <text fg={valueColor()} attributes={props.active ? TextAttributes.BOLD : TextAttributes.NONE} wrapMode="none" flexShrink={0} selectable={false} onMouseUp={props.use}>
            {padEndDisplay(fit(line.value(), columns().value), columns().value)}
          </text>
          {arrow(line.run ? " ▸" : line.cycle ? " ›" : "  ", props.use)}
          <Show when={note() && noteInline()}>
            <box paddingLeft={2} flexShrink={1}>
              <text fg={props.theme.text.muted} wrapMode="word" selectable={false}>
                {note()}
              </text>
            </box>
          </Show>
        </Show>
      </box>
      <Show when={note() && !noteInline()}>
        <box paddingLeft={indent()} width={props.width}>
          <text fg={props.theme.text.muted} wrapMode="word" selectable={false}>
            {note()}
          </text>
        </box>
      </Show>
      <Show when={line.detail?.()}>
        <box paddingLeft={indent()} width={props.width}>
          <text fg={props.theme.text.muted} wrapMode="word" selectable={false}>
            {line.detail?.() ?? ""}
          </text>
        </box>
      </Show>
    </>
  )
}
