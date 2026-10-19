/**
 * 左导航（Quota 风格）：竖排页面列表，或窄窗下的横排页面条。
 *
 * 选中态用主题 raised 背景、语义色（action.primary）、加粗与 "›" 记号；
 * 竖排右侧一条 muted 竖线，把导航和内容分开。两项都只按点击切页，
 * 键盘切页由窗口的 keymap 层负责（target 指向窗口盒子）。
 */
/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { Show } from "solid-js"
import { columnsOf, padEndDisplay, stripWindow, type StripItem } from "./text.ts"
import type { WindowTheme } from "./types.ts"

/** 每项标签前空几列；选中项的 "› " 也从这里起。 */
const RAIL_INDENT = 2

/** 左导航占几列（含右侧竖线与间隙）。 */
export function railRoomOf(items: readonly StripItem<string>[]): number {
  const labelWidth = Math.max(4, ...items.map((item) => columnsOf(item.label)))
  return RAIL_INDENT + labelWidth + 1 + 1 + 1
}

/** 竖排页面列表。 */
export function Rail(props: {
  items: readonly StripItem<string>[]
  chosen: string
  theme: WindowTheme
  pick: (key: string) => void
}): JSX.Element {
  const labelWidth = () => Math.max(4, ...props.items.map((item) => columnsOf(item.label)))
  const width = () => RAIL_INDENT + labelWidth() + 1
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      width={width() + 1}
      marginRight={1}
      overflow="hidden"
      border={["right"]}
      borderStyle="single"
      borderColor={props.theme.text.muted}
    >
      {props.items.map((item) => {
        const chosen = item.key === props.chosen
        return (
          <text
            fg={chosen ? props.theme.text.action.primary.base : props.theme.text.muted}
            bg={chosen ? props.theme.background?.raised.high : undefined}
            attributes={chosen ? TextAttributes.BOLD : TextAttributes.NONE}
            wrapMode="none"
            flexShrink={0}
            selectable={false}
            onMouseUp={() => props.pick(item.key)}
          >
            {padEndDisplay(`${chosen ? "› " : " ".repeat(RAIL_INDENT)}${item.label}`, width())}
          </text>
        )
      })}
    </box>
  )
}

/** 窄窗横排页面条：当前页用语义色＋加粗，藏起来的页用 ‹ ／ › 收进两端。 */
export function PageStrip(props: {
  items: readonly StripItem<string>[]
  chosen: string
  theme: WindowTheme
  width: number
  pick: (key: string) => void
}): JSX.Element {
  const window = () => stripWindow(props.items, props.chosen, props.width)
  const index = () => props.items.findIndex((item) => item.key === props.chosen)
  const previous = () => props.items[(index() - 1 + props.items.length) % props.items.length]
  const next = () => props.items[(index() + 1) % props.items.length]
  const label = (item: StripItem<string>) => {
    const chosen = item.key === props.chosen
    return (
      <text
        fg={chosen ? props.theme.text.action.primary.base : props.theme.text.muted}
        bg={chosen ? props.theme.background?.raised.high : undefined}
        attributes={chosen ? TextAttributes.BOLD : TextAttributes.NONE}
        wrapMode="none"
        flexShrink={0}
        selectable={false}
        onMouseUp={() => props.pick(item.key)}
      >
        {item.label}
      </text>
    )
  }
  return (
    <box flexDirection="row" flexShrink={0} marginBottom={1}>
      <Show when={window().left && previous()}>
        <text fg={props.theme.text.muted} wrapMode="none" selectable={false} onMouseUp={() => props.pick(previous()!.key)}>
          {"‹ "}
        </text>
      </Show>
      {window().items.map((item, position) => (
        <>
          {label(item)}
          <Show when={position < window().items.length - 1}>
            <text fg={props.theme.text.muted} wrapMode="none" selectable={false}>
              {" · "}
            </text>
          </Show>
        </>
      ))}
      <Show when={window().right && next()}>
        <text fg={props.theme.text.muted} wrapMode="none" selectable={false} onMouseUp={() => props.pick(next()!.key)}>
          {" ›"}
        </text>
      </Show>
    </box>
  )
}
