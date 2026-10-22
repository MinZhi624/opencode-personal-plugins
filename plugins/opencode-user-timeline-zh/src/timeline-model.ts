/** 用户节点的时间线模型与纯格式函数。
 *
 *  这里不依赖宿主 UI 或会话缓存，只把 SessionMessageInfo 转成侧栏需要的紧凑节点，
 *  供面板、跳转定位和遮罩预览共用。
 */

import type { SessionMessageInfo } from "@opencode/client"

/** 一条用户消息节点（SessionMessageInfo 联合类型中的 user 变体）。 */
export type UserMessage = Extract<SessionMessageInfo, { type: "user" }>

/** 侧边栏只保留渲染和定位所需字段，避免复制完整消息与附件元数据。 */
export type TimelineNode = {
  id: string
  created: number
  summary: string
}

export type TimelineGroup = {
  key: string
  label: string
  nodes: TimelineNode[]
}

/** 类型守卫：只关心 type === "user" 的消息。 */
export function isUser(message: SessionMessageInfo): message is UserMessage {
  return message.type === "user"
}

/** 计算字符串的终端显示宽度（CJK 记 2 列）。 */
export function displayWidth(value: string) {
  let width = 0
  for (const char of value) width += char.codePointAt(0)! > 0xff ? 2 : 1
  return width
}

/** 按终端显示宽度截断，超出时追加省略号。 */
export function truncate(value: string, max: number) {
  if (displayWidth(value) <= max) return value
  let out = ""
  let width = 0
  for (const char of value) {
    const w = char.codePointAt(0)! > 0xff ? 2 : 1
    if (width + w > max - 1) break
    out += char
    width += w
  }
  return out + "…"
}

/** 用户消息的首个非空行；纯附件消息显示附件数量。 */
export function messageSummary(message: UserMessage) {
  const line = (message.text ?? "")
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0)
  if (line) return line.slice(0, 240)
  const files = message.files?.length ?? 0
  if (files > 0) return `[附件 ×${files}]`
  return "(空消息)"
}

export function timelineNode(message: UserMessage): TimelineNode {
  return {
    id: message.id,
    created: message.time.created,
    summary: messageSummary(message),
  }
}

export function sameTimelineNode(a: TimelineNode, b: TimelineNode) {
  return a.created === b.created && a.summary === b.summary
}

function pad(value: number) {
  return value.toString().padStart(2, "0")
}

export function dateKey(created: number) {
  const date = new Date(created)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function formatDate(created: number) {
  const date = new Date(created)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function formatTime(created: number) {
  const date = new Date(created)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function groupNodes(values: TimelineNode[]) {
  const groups: TimelineGroup[] = []
  for (const node of values) {
    const key = dateKey(node.created)
    const previous = groups[groups.length - 1]
    if (previous?.key === key) {
      previous.nodes.push(node)
      continue
    }
    groups.push({ key, label: formatDate(node.created), nodes: [node] })
  }
  return groups
}

export function latestGroups(groups: TimelineGroup[], nodeLimit: number) {
  const shown: TimelineGroup[] = []
  let remaining = nodeLimit
  for (let index = groups.length - 1; index >= 0 && remaining > 0; index--) {
    const group = groups[index]
    const nodes = group.nodes.slice(Math.max(0, group.nodes.length - remaining))
    shown.unshift({ ...group, nodes })
    remaining -= nodes.length
  }
  return shown
}

/** 宿主跳转命令可定位的用户消息（与宿主实现一致：跳过空白文本消息）。 */
export function navigable(node: UserMessage) {
  return (node.text ?? "").trim().length > 0
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function nextFrame() {
  return new Promise<void>((resolve) => {
    const raf = (globalThis as typeof globalThis & {
      requestAnimationFrame?: (callback: () => void) => unknown
    }).requestAnimationFrame
    if (raf) raf(resolve)
    else setTimeout(resolve, 16)
  })
}

export async function waitForFrames(count: number) {
  for (let i = 0; i < count; i++) await nextFrame()
}
