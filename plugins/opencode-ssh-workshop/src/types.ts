import type { Plugin } from "@opencode/plugin"

/**
 * 从公开根导出推导插件上下文与工具上下文的类型，避免深路径子包导入。
 * 这样做只依赖 `@opencode/plugin` 的根入口，跟着版本升级也不会指错文件。
 */
export type PluginContext = Plugin.Context

type ListedTool = NonNullable<Awaited<ReturnType<PluginContext["tool"]["list"]>>>[number]

/** 工具执行器收到的上下文（含 signal / progress）。 */
export type ToolContext = Parameters<ListedTool["execute"]>[1]

/** 工具执行器的返回值。 */
export type ToolOutput = Awaited<ReturnType<ListedTool["execute"]>>

/**
 * `ctx.agent.transform` 回调里要写入的字段。用结构性宽类型而不是深挖
 * `DeepMutable<Agent.Info>`：模型与其余字段本就要整体覆盖，宽类型更省事。
 */
export interface AgentDraft {
  description?: string
  mode?: "primary" | "subagent" | "all"
  color?: string
  steps?: number
  system?: string
  model?: unknown
  permissions?: Array<{ action: string; resource: string; effect: "allow" | "ask" | "deny" }>
  [key: string]: unknown
}
