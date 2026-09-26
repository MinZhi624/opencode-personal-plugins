/** @jsxImportSource @opentui/solid */

import "@opentui/solid/preload"
import type { Context } from "@opencode/plugin/tui/context"
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { collectSkillUsage, sortUsage, type SkillUsage } from "./skill-tracker.ts"

/** V2 消息分页契约：limit 1..200，order 仅第一页且不与 cursor 同用。
 * 不按 type 过滤——skill 注入在用户消息的 skills 字段，工具调用在
 * assistant 消息的 content 里，两类都要扫。 */
const MESSAGE_PAGE_SIZE = 200
const MESSAGE_MAX_PAGES = 10

async function fetchSkillUsage(context: Context, sessionID: string): Promise<SkillUsage[]> {
  const usage = collectSkillUsage([])
  let cursor: string | undefined
  for (let page = 0; page < MESSAGE_MAX_PAGES; page += 1) {
    const result = await context.client.message.list({
      sessionID,
      limit: MESSAGE_PAGE_SIZE,
      ...(cursor ? { cursor } : { order: "asc" }),
    })
    for (const [id, entry] of collectSkillUsage(result.data)) {
      const existing = usage.get(id)
      if (existing) {
        existing.count += entry.count
        existing.lastMessageID = entry.lastMessageID || existing.lastMessageID
      } else {
        usage.set(id, { ...entry })
      }
    }
    const next = result.cursor?.next
    if (!next) break
    cursor = next
  }
  return sortUsage(usage)
}

export interface SkillPanelProps {
  context: Context
  sessionID: string
  maxUsed?: number
  defaultOpen?: boolean
}

/** 「技能」面板：显示本会话已加载的 skill。
 * 由 opencode-enhanced-sidebar-zh 的 replace 树组合渲染（子代理面板之后），
 * 与 QuotaPanel / SessionOverview / SubAgentPanel 同树，顺序由 JSX 顺序保障。 */
export function SkillPanel(props: SkillPanelProps) {
  const maxUsed = () => props.maxUsed ?? 8
  const defaultOpen = () => props.defaultOpen !== false
  const [used, setUsed] = createSignal<SkillUsage[]>([])
  const [loaded, setLoaded] = createSignal(false)
  const [open, setOpen] = createSignal(defaultOpen())

  const refresh = async (sessionID: string) => {
    try {
      setUsed(await fetchSkillUsage(props.context, sessionID))
    } catch {
      setUsed([])
    } finally {
      setLoaded(true)
    }
  }

  createEffect(() => {
    const sessionID = props.sessionID
    setLoaded(false)
    void refresh(sessionID)
  })

  // 事件名与 opencode-enhanced-sidebar-zh 在 2.0.11/2.0.12 验证过的一致
  onCleanup(() => {
    for (const unsubscribe of unsubs) unsubscribe()
  })
  const unsubs = [
    props.context.data.on("session.step.ended", (event) => {
      if (event.data.sessionID === props.sessionID) void refresh(props.sessionID)
    }),
    props.context.data.on("session.execution.succeeded", (event) => {
      if (event.data.sessionID === props.sessionID) void refresh(props.sessionID)
    }),
    props.context.data.on("session.execution.interrupted", (event) => {
      if (event.data.sessionID === props.sessionID) void refresh(props.sessionID)
    }),
    props.context.data.on("session.execution.failed", (event) => {
      if (event.data.sessionID === props.sessionID) void refresh(props.sessionID)
    }),
  ]

  const theme = () => props.context.theme
  return (
    <box flexDirection="column">
      <box
        flexDirection="row"
        gap={1}
        onMouseDown={() => setOpen((value) => !value)}
      >
        <text fg={theme().text.action.primary.base}>{open() ? "▼" : "▶"}</text>
        <text fg={theme().text.action.primary.base}><b>技能</b></text>
        <Show when={!open()}>
          <text fg={theme().text.muted}>（已加载 {used().length}）</text>
        </Show>
      </box>
      <Show when={open()}>
        <Show when={!loaded()}>
          <text fg={theme().text.muted}>加载中…</text>
        </Show>
        <Show when={loaded() && used().length === 0}>
          <text fg={theme().text.muted}>本会话尚未加载 skill</text>
        </Show>
        <Show when={loaded() && used().length > 0}>
          <box flexDirection="column">
            <For each={used().slice(0, maxUsed())}>
              {(item) => (
                <text fg={theme().text.muted}>
                  {`${item.id}${item.count > 1 ? ` ×${item.count}` : ""}`}
                </text>
              )}
            </For>
            <Show when={used().length > maxUsed()}>
              <text fg={theme().text.muted}>
                {`…还有 ${used().length - maxUsed()} 个`}
              </text>
            </Show>
          </box>
        </Show>
      </Show>
    </box>
  )
}

/** 独立加载时是 no-op：侧栏内容区被 enhanced-sidebar 的 replace 独占，
 * 树外的插槽注册会被吞掉，面板经由 SkillPanel 组件进树渲染。 */
export default Plugin.define({
  id: "opencode-skill-panel",
  setup() {
    return () => {}
  },
})
