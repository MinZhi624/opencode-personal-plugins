/** @jsxImportSource @opentui/solid */

import "@opentui/solid/preload"
import type { BoxRenderable } from "@opentui/core"
import type { Context } from "@opencode/plugin/tui/context"
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import type { JSX } from "@opentui/solid"
import { registerSidebarCard } from "../../opencode-sidebar-host-zh/src/register-card.ts"
import { useCardControlPreview } from "../../opencode-sidebar-host-zh/src/card-controls.ts"
import { useSidebarDisplay } from "../../opencode-sidebar-host-zh/src/presentation.ts"
import { collectSkillUsage, sortUsage, type SkillUsage } from "./skill-tracker.ts"
import { readSkillPanelOptions, SKILL_PANEL_MAX_USED_DEFAULT, type SkillPanelDisplayOptions } from "./skill-options.ts"
import { registerSkillCardControls } from "./card-controls.ts"

/** V2 消息分页契约：limit 1..200，order 仅第一页且不与 cursor 同用。
 * 不按 type 过滤——skill 注入在用户消息的 skills 字段，工具调用在
 * assistant 消息的 content 里，两类都要扫。 */
const MESSAGE_PAGE_SIZE = 200
const MESSAGE_MAX_PAGES = 10

const CARD_ID = "skill"

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

/** 统一卡片标题行：箭头 + 粗体标题同一行、间距 1；颜色由宿主的侧栏外观设置决定。
 *  与额度／上下文／子代理三张卡片保持同一视觉语言。 */
function CardTitle(props: { open: boolean; title: string; color: string; toggle: () => void; children?: JSX.Element }) {
  return (
    <box flexDirection="row" gap={1} onMouseDown={props.toggle}>
      <text fg={props.color}>{props.open ? "▼" : "▶"}</text>
      <text fg={props.color}><b>{props.title}</b></text>
      {props.children}
    </box>
  )
}

/** 「技能」面板：显示本会话已加载的 skill，由独立插件接入排序宿主。 */
export function SkillPanel(props: SkillPanelProps) {
  // 统一窗口的预览只覆盖显示，不写 cli.json；保存或放弃后回到已保存选项。
  const preview = useCardControlPreview(CARD_ID)
  // 侧栏专属外观：颜色与行内布局走宿主桥（卡片覆盖 › 整体），未设置时回退主题。
  const shown = useSidebarDisplay(CARD_ID)
  const [measured, setMeasured] = createSignal(0)
  /** 主题色回退：没有宿主覆盖时保持原有观感。 */
  const titleColor = () => shown().colors.title ?? props.context.theme.text.action.primary.base
  const bodyColor = () => shown().colors.body ?? props.context.theme.text.base
  const mutedColor = () => shown().colors.muted ?? props.context.theme.text.muted
  const dividerColor = () => shown().colors.divider ?? mutedColor()
  const indent = () => Math.max(0, shown().layout.indent ?? 0)
  const lineGap = () => Math.max(0, shown().layout.lineGap ?? 0)
  const withDivider = () => shown().layout.divider === true
  const maxUsed = () => {
    const value = preview()?.skillPanelMaxUsed
    return typeof value === "number" && Number.isFinite(value) ? value : props.maxUsed ?? SKILL_PANEL_MAX_USED_DEFAULT
  }
  const defaultOpen = () => {
    const value = preview()?.skillPanelDefaultOpen
    return typeof value === "boolean" ? value : props.defaultOpen !== false
  }
  const [used, setUsed] = createSignal<SkillUsage[]>([])
  const [loaded, setLoaded] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  // 开合状态本就不是长期选择：有效默认值变化（预览／保存）时回到它，手动点击仍可临时改。
  const [toggled, setToggled] = createSignal<boolean | undefined>(undefined)
  createEffect(() => {
    defaultOpen()
    setToggled(undefined)
  })
  const open = () => toggled() ?? defaultOpen()
  let generation = 0

  const refresh = async (sessionID: string) => {
    const current = ++generation
    // 首次挂载时服务／会话可能仍在就绪；短暂失败不能卡到下一次执行事件。
    // 每次重扫从第一页开始，避免分页中断后的局部结果或重复计数。
    const delays = [250, 750, 1500]
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (current !== generation) return
      try {
        const result = await fetchSkillUsage(props.context, sessionID)
        if (current !== generation) return
        setUsed(result)
        setFailed(false)
        setLoaded(true)
        return
      } catch {
        if (current !== generation) return
        if (attempt === delays.length) {
          // 持续失败仍明确报错，保留同一会话上一次成功结果。
          setFailed(true)
          setLoaded(true)
          return
        }
        await new Promise<void>((resolve) => setTimeout(resolve, delays[attempt]))
      }
    }
  }

  createEffect(() => {
    const sessionID = props.sessionID
    // 换会话先清空：失败时保留的“上次结果”不能串到别的会话上。
    setUsed([])
    setLoaded(false)
    setFailed(false)
    void refresh(sessionID)
  })

  // 事件名与 opencode-enhanced-sidebar-zh 在 2.0.11/2.0.12 验证过的一致
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
  onCleanup(() => {
    generation++
    for (const unsubscribe of unsubs) unsubscribe()
  })

  const theme = () => props.context.theme
  return (
    <box
      flexDirection="column"
      onSizeChange={function (this: BoxRenderable) {
        if (this.width > 0 && this.width !== measured()) queueMicrotask(() => setMeasured(this.width))
      }}
    >
      <CardTitle open={open()} title="技能" color={titleColor()} toggle={() => setToggled((value) => !(value ?? defaultOpen()))}>
        <Show when={!open()}>
          <text fg={mutedColor()}>（已加载 {used().length}）</text>
        </Show>
      </CardTitle>
      <Show when={withDivider()}>
        <text fg={dividerColor()} wrapMode="none" selectable={false}>{"─".repeat(Math.max(4, measured() || 20))}</text>
      </Show>
      <Show when={open()}>
        <box flexDirection="column" paddingLeft={indent()} gap={lineGap()}>
          <Show when={!loaded()}>
            <text fg={mutedColor()}>加载中…</text>
          </Show>
          <Show when={loaded() && failed()}>
            <text fg={theme().text.feedback.error.base}>{used().length > 0 ? "技能用量读取失败，以下为上次结果" : "技能用量读取失败"}</text>
          </Show>
          <Show when={loaded() && !failed() && used().length === 0}>
            <text fg={mutedColor()}>本会话暂无技能</text>
          </Show>
          <Show when={loaded() && used().length > 0}>
            <box flexDirection="column">
              <For each={used().slice(0, maxUsed())}>
                {(item) => (
                  <text fg={bodyColor()}>
                    {`${item.id}${item.count > 1 ? ` ×${item.count}` : ""}`}
                  </text>
                )}
              </For>
              <Show when={used().length > maxUsed()}>
                <text fg={mutedColor()}>
                  {`…还有 ${used().length - maxUsed()} 个`}
                </text>
              </Show>
            </box>
          </Show>
        </box>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "opencode-skill-panel",
  setup(context) {
    // cli.json 选项经安全写回 helper 保存后，本窗口立即按写回结果更新；其他窗口重启 TUI。
    const [display, setDisplay] = createSignal<SkillPanelDisplayOptions>(readSkillPanelOptions(context.options))
    const registration = registerSidebarCard({
      id: CARD_ID,
      owner: "opencode-skill-panel",
      title: "技能",
      render: ({ sessionID }) => (
        <SkillPanel
          context={context}
          sessionID={sessionID}
          maxUsed={display().skillPanelMaxUsed}
          defaultOpen={display().skillPanelDefaultOpen}
        />
      ),
      onStatus(status) {
        if (status.state === "rejected") context.ui.toast.show({ title: "技能", message: `侧栏注册被拒：${status.code}`, variant: "error" })
      },
    })
    // 展示设置随本插件 setup 注册、cleanup 撤销：本插件已加载而卡片被隐藏时，
    // 统一窗口仍可设置；插件未加载则不注册 provider，窗口里不会出现可用入口。
    const disposeControls = registerSkillCardControls(context, setDisplay)
    return () => { disposeControls(); registration.dispose() }
  },
})
