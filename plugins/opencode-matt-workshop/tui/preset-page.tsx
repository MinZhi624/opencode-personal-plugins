/** @jsxImportSource @opentui/solid */

import "@opentui/solid/preload"
import type { Context } from "@opencode/plugin/tui/context"
import { createMemo, createSignal, For, Show } from "solid-js"
import type { PresetState } from "../shared/presets.ts"

interface Item {
  readonly name: string
  readonly label: string
  readonly count: number
  readonly active: boolean
}

/**
 * `/preset` 打开的模型预设页。
 *
 * 用路由页而不是 dialog：斜杠命令的 Enter 会和 dialog 的开合抢同一次按键。
 * 页面只发“应用”意图，写入仍由 Server RPC 完成。
 */
export function PresetPage(props: {
  readonly context: Context
  readonly state: () => PresetState | undefined
  readonly onApply: (name: string) => Promise<void>
  readonly onClose: () => void
}) {
  const theme = props.context.theme
  const title = () => theme.text.action.primary.base
  const muted = () => theme.text.muted
  const body = () => theme.text.base
  const [busy, setBusy] = createSignal(false)

  const items = createMemo<Item[]>(() => {
    const state = props.state()
    const rows: Item[] = [{
      name: "base",
      label: "base（插件 options）",
      count: Object.keys(state?.base ?? {}).length,
      active: !state?.active,
    }]
    for (const [name, preset] of Object.entries(state?.presets ?? {})) {
      rows.push({
        name,
        label: name,
        count: Object.keys(preset.agents ?? {}).length,
        active: state?.active === name,
      })
    }
    return rows
  })

  const [index, setIndex] = createSignal(Math.max(0, items().findIndex((item) => item.active)))

  const apply = async (name: string) => {
    if (busy()) return
    setBusy(true)
    try {
      await props.onApply(name)
    } finally {
      setBusy(false)
    }
  }

  props.context.keymap.layer(() => ({
    mode: "global",
    priority: 25,
    commands: [
      {
        id: "matt.preset.page.up",
        bind: "up",
        run: () => {
          setIndex((value) => Math.max(0, value - 1))
        },
      },
      {
        id: "matt.preset.page.down",
        bind: "down",
        run: () => {
          setIndex((value) => Math.min(items().length - 1, value + 1))
        },
      },
      {
        id: "matt.preset.page.enter",
        bind: "return",
        run: () => {
          const item = items()[index()]
          if (item) void apply(item.name)
        },
      },
      {
        id: "matt.preset.page.close",
        bind: "escape",
        run: () => {
          props.onClose()
        },
      },
    ],
  }))

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} gap={1}>
      <box flexDirection="column">
        <text fg={title()}><b>模型预设</b></text>
        <text fg={muted()}>↑↓ 选择 · Enter 应用 · Esc 返回 · 编辑用 /web-preset</text>
      </box>
      <Show when={props.state()} fallback={<text fg={muted()}>正在读取预设…</text>}>
        <For each={items()}>
          {(item, position) => (
            <box
              flexDirection="row"
              gap={1}
              width="100%"
              backgroundColor={position() === index() ? theme.background?.raised.high : undefined}
              onMouseDown={() => {
                setIndex(position())
                void apply(item.name)
              }}
            >
              <text fg={item.active ? theme.text.feedback.success.base : muted()}>{item.active ? "●" : "○"}</text>
              <text fg={position() === index() ? body() : muted()}><b>{item.label}</b></text>
              <text fg={muted()}>{item.count} 个角色</text>
              <Show when={item.active}><text fg={theme.text.feedback.success.base}>使用中</text></Show>
              <Show when={busy() && position() === index()}><text fg={title()}>应用中…</text></Show>
            </box>
          )}
        </For>
        <Show when={(props.state()?.presets ? Object.keys(props.state()!.presets).length : 0) === 0}>
          <text fg={muted()}>还没有命名预设；用 /web-preset 在网页里创建并保存。</text>
        </Show>
      </Show>
    </box>
  )
}
