/**
 * skill-tracker.ts —— 从会话消息中提取 skill 加载记录（纯函数，无 TUI 依赖）。
 *
 * 基于 OpenCode 2.0.18 真实 API 响应（/api/session/{id}/message）实测的两种
 * skill 加载形态：
 *
 * 1) `skill` 工具调用 —— assistant 消息 `content[]` 条目：
 *    `{ type: "tool", id, name: "skill", state: { input: { id: "research" }, ... } }`
 *    （v1 兼容：`{ type: "tool", tool: "skill", parts[] 外层 }`）
 *
 * 2) `@` 提及 / 自动注入 —— 用户消息的 `skills` 字段：
 *    `{ id: "ask-matt", name: "ask-matt", text: "<skill_content …>" }`
 *    （无加载时该字段缺失或为空数组）
 *
 * 消息条目形状（与 opencode-enhanced-sidebar-zh 验证的分页契约一致）：
 * `{ data: Message[], cursor: { next? } }`，Message 为 v2 扁平形（顶层 `id`、
 * assistant 用 `content[]`、user 带 `skills`），也兼容 v1 包裹形 `{ info, parts }`。
 */

export interface SkillUsage {
  /** skill 标识 */
  id: string
  /** 本会话加载/调用次数 */
  count: number
  /** 最近一次出现的消息 id（用于排序展示） */
  lastMessageID: string
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null

function extractInputID(input: unknown): string | null {
  const record = asRecord(input)
  if (!record) return null
  for (const key of ["id", "skill", "name", "topic"] as const) {
    const value = record[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return null
}

function messageID(raw: unknown): string {
  const message = asRecord(raw)
  const wrapper = asRecord(message?.info)
  const id = (message?.id ?? wrapper?.id) as unknown
  return typeof id === "string" ? id : ""
}

/** v2 扁平 `content[]` / `skills`；v1 包裹形 `{ info, parts }`。 */
function messageContent(raw: unknown): unknown[] {
  const message = asRecord(raw)
  if (!message) return []
  const wrapper = asRecord(message.info)
  for (const source of [message, wrapper]) {
    if (!source) continue
    if (Array.isArray(source.content)) return source.content
    if (Array.isArray(source.parts)) return source.parts
  }
  return []
}

function messageSkills(raw: unknown): unknown[] {
  const message = asRecord(raw)
  if (!message) return []
  const wrapper = asRecord(message.info)
  for (const source of [message, wrapper]) {
    if (source && Array.isArray(source.skills)) return source.skills
  }
  return []
}

/** 从一页（或一批）消息里聚合 skill 加载。相同 id 累计次数，保留最近消息。 */
export function collectSkillUsage(messages: readonly unknown[]): Map<string, SkillUsage> {
  const usage = new Map<string, SkillUsage>()
  const bump = (skillID: string, messageIDValue: string) => {
    const existing = usage.get(skillID)
    if (existing) {
      existing.count += 1
      if (messageIDValue) existing.lastMessageID = messageIDValue
    } else {
      usage.set(skillID, { id: skillID, count: 1, lastMessageID: messageIDValue })
    }
  }

  for (const raw of messages) {
    const id = messageID(raw)

    // 形态 2：用户消息 skills 字段（@ 提及 / 自动注入）
    for (const entry of messageSkills(raw)) {
      const record = asRecord(entry)
      if (!record) continue
      const skillID =
        typeof record.id === "string" && record.id.length > 0
          ? record.id
          : typeof record.name === "string" && record.name.length > 0
            ? record.name
            : null
      if (skillID) bump(skillID, id)
    }

    // 形态 1：skill 工具调用（v2 用 name 字段，v1 用 tool 字段）
    for (const itemRaw of messageContent(raw)) {
      const item = asRecord(itemRaw)
      if (!item) continue
      const toolName =
        typeof item.name === "string" ? item.name
        : typeof item.tool === "string" ? item.tool
        : undefined
      const isSkillTool = item.type === "tool" && toolName === "skill"
      if (!isSkillTool) continue
      const skillID =
        extractInputID(asRecord(item.state)?.input) ?? extractInputID(item.input)
      if (skillID) bump(skillID, id)
    }
  }
  return usage
}

/** 按最近使用排序（同一消息内按次数降序）。 */
export function sortUsage(usage: Map<string, SkillUsage>): SkillUsage[] {
  return [...usage.values()].sort((a, b) => {
    if (a.lastMessageID !== b.lastMessageID) return a.lastMessageID < b.lastMessageID ? 1 : -1
    return b.count - a.count
  })
}
