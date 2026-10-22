/** @jsxImportSource @opentui/solid */

import "@opentui/solid/preload"
import type { Context } from "@opencode/plugin/tui/context"
import { For, Show } from "solid-js"
import { WORKSHOP_ROLES, type PresetState } from "../shared/presets.ts"

function shortModel(id: string | undefined): string {
  if (!id) return "未设置"
  const slash = id.indexOf("/")
  return slash >= 0 ? id.slice(slash + 1) : id
}

/**
 * 侧栏里的「模型预设」卡片。
 *
 * 只读展示 Server 解析后的结果；切换与编辑分别走 `/preset` 与 `/web-preset`。
 * 不在这里写文件，也不建立第二份预设状态。
 */
export function PresetCard(props: {
  readonly context: Context
  readonly state: () => PresetState | undefined
}) {
  const theme = props.context.theme
  const active = () => props.state()?.active
  const title = () => theme.text.action.primary.base
  const muted = () => theme.text.muted
  const body = () => theme.text.base

  return (
    <box border borderColor={muted()} paddingLeft={1} paddingRight={1} flexDirection="column">
      <box flexDirection="row" gap={1} onMouseDown={() => props.context.keymap.dispatch("matt.preset.switch")}>
        <text fg={title()}><b>模型预设</b></text>
        <Show when={active()} fallback={<text fg={muted()}>base</text>}>
          <text fg={theme.text.feedback.success.base}>{active()}</text>
        </Show>
        <text fg={muted()}>/preset</text>
      </box>
      <Show when={props.state()} fallback={<text fg={muted()}>正在读取预设…</text>}>
        <For each={WORKSHOP_ROLES}>
          {(role) => {
            const resolved = () => props.state()?.resolved[role.id]
            return (
              <Show when={resolved()}>
                <box flexDirection="row" gap={1}>
                  <text fg={muted()}>{role.label.padEnd(9, " ")}</text>
                  <text fg={body()}>{shortModel(resolved()?.model)}</text>
                  <Show when={resolved()?.variant}>
                    <text fg={muted()}>{resolved()!.variant}</text>
                  </Show>
                  <Show when={(resolved()?.chain.length ?? 0) > 1}>
                    <text fg={muted()}>+{(resolved()?.chain.length ?? 1) - 1}</text>
                  </Show>
                </box>
              </Show>
            )
          }}
        </For>
        <Show when={props.state()?.error}>
          <text fg={theme.text.feedback.error.base}>{props.state()!.error}</text>
        </Show>
      </Show>
    </box>
  )
}
