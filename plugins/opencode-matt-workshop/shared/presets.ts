/**
 * Workshop 模型预设的共享词汇。
 *
 * 这里只放类型、角色目录和纯函数，不读取文件、不导入服务端模块：
 * Server 插件、TUI 卡片与网页编辑端共用同一份角色定义，避免三处各写一套名字。
 */

export const WORKSHOP_ROLE_IDS = [
  "drafter",
  "tinker",
  "foreman",
  "maker",
  "inspector",
  "archivist",
  "surveyor",
] as const

export type WorkshopRoleID = (typeof WORKSHOP_ROLE_IDS)[number]

export interface WorkshopRole {
  readonly id: WorkshopRoleID
  /** 中文名，显示用。 */
  readonly name: string
  /** OpenCode agent id 之外的短标签（保留英文原名，便于对照日志）。 */
  readonly label: string
  readonly mode: "primary" | "subagent"
  readonly description: string
  readonly color: string
}

export const WORKSHOP_ROLES: readonly WorkshopRole[] = [
  {
    id: "drafter",
    name: "规划者",
    label: "Drafter",
    mode: "primary",
    description: "只做澄清与规划，产出 Implementation Plan；不实施生产代码。",
    color: "#8B5CF6",
  },
  {
    id: "tinker",
    name: "通用助手",
    label: "Tinker",
    mode: "primary",
    description: "默认角色：解释、调研、设计、实现与调试，按需委派 Worker。",
    color: "#10B981",
  },
  {
    id: "foreman",
    name: "协作实现",
    label: "Foreman",
    mode: "primary",
    description: "主线自持，识别可并行的独立工作并协调 Worker 整合结果。",
    color: "#F59E0B",
  },
  {
    id: "maker",
    name: "实施者",
    label: "Maker",
    mode: "subagent",
    description: "在 Assigned Scope 内完成一个有界的端到端实现单元。",
    color: "#F97316",
  },
  {
    id: "inspector",
    name: "独立审查",
    label: "Inspector",
    mode: "subagent",
    description: "只读审查一个 Standards、Spec 或设计维度，不修改文件。",
    color: "#EF4444",
  },
  {
    id: "archivist",
    name: "资料调研",
    label: "Archivist",
    mode: "subagent",
    description: "调研一手来源，把带引用的结论写入指定 Markdown 报告。",
    color: "#3B82F6",
  },
  {
    id: "surveyor",
    name: "代码测绘",
    label: "Surveyor",
    mode: "subagent",
    description: "只读映射代码结构、约定和关系，为委派提供上下文。",
    color: "#06B6D4",
  },
]

export const WORKSHOP_ROLE_BY_ID = new Map(WORKSHOP_ROLES.map((role) => [role.id, role] as const))

/** 单个角色在一套预设里的模型选择。`models` 是首选到备用链，`model` 兼容旧格式。 */
export interface AgentPreset {
  readonly models?: readonly string[]
  readonly model?: string
  readonly variant?: string
  readonly temperature?: number
}

/** 一套命名预设。`extends` 先应用父预设，再应用本预设的角色覆盖。 */
export interface PresetDefinition {
  readonly extends?: string
  readonly agents: Readonly<Record<string, AgentPreset>>
}

export interface PresetFile {
  readonly version: 1
  /** 当前应用的预设名；省略表示继续使用插件 options 里的基础模型。 */
  readonly active?: string
  readonly presets: Readonly<Record<string, PresetDefinition>>
}

export interface ResolvedAgent {
  /** 实际交给 OpenCode 的模型；链中第一个可用项。 */
  readonly model?: string
  readonly variant?: string
  /** 保存的完整候选链，按优先级排列。 */
  readonly chain: readonly string[]
  /** 当前值来自 active preset 还是插件 options / 内置默认。 */
  readonly source: "preset" | "base" | "none"
}

export interface ModelSummary {
  readonly id: string
  readonly providerID: string
  readonly providerName: string
  readonly name: string
  readonly vision: boolean
  readonly free: boolean
  readonly context: number
  readonly inputCost: number
  readonly outputCost: number
  readonly variants: readonly string[]
  readonly status: "alpha" | "beta" | "deprecated" | "active"
}

/** RPC `state` 的返回体，也是网页端一次加载的全部数据。 */
export interface PresetState {
  readonly filePath: string
  readonly exists: boolean
  readonly error?: string
  /** 当前应用预设；null 表示没有写入文件，使用插件 options。 */
  readonly active: string | null
  readonly presets: Readonly<Record<string, PresetDefinition>>
  /** 插件 options / 内置默认提供的基线覆盖。 */
  readonly base: Readonly<Record<string, AgentPreset>>
  /** `base` 叠加 active preset 后的有效值（模型链已尝试解析首项）。 */
  readonly resolved: Readonly<Record<string, ResolvedAgent>>
  readonly roles: readonly WorkshopRole[]
  readonly models: readonly ModelSummary[]
  /** 预设文件的原始内容是否可写；不可写时网页只读预览。 */
  readonly writable: boolean
}

export function isWorkshopRoleID(value: string): value is WorkshopRoleID {
  return (WORKSHOP_ROLE_IDS as readonly string[]).includes(value)
}

/** 从旧 `model` 字段与新 `models` 字段统一取出候选链。 */
export function presetModelChain(value: AgentPreset | undefined): string[] {
  if (!value) return []
  if (Array.isArray(value.models)) return value.models.filter((item): item is string => typeof item === "string" && item.length > 0)
  if (typeof value.model === "string" && value.model.length > 0) return [value.model]
  return []
}
