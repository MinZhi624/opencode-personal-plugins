/**
 * Workshop 预设 RPC：Server 插件注册，TUI / 网页通过同一定义调用。
 *
 * 只依赖 RPC 定义本身，不导入任何 Server 端模块；因此 TUI 进程可以安全地加载它。
 * 嵌套预设内容由 Server 端 store 再做严格校验，这里只约束传输外壳。
 */
import { Rpc } from "@opencode/plugin/rpc"
import type { PresetDefinition, PresetState } from "./presets.ts"

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
})

const stateSchema = {
  type: "object",
  additionalProperties: true,
}

export const WorkshopPresetRpc = Rpc.define({
  id: "matt-workshop.presets",
  methods: {
    state: {
      input: object({}),
      output: stateSchema,
    },
    save: {
      input: object(
        {
          presets: { type: "object", additionalProperties: true },
          active: { type: ["string", "null"] },
        },
        ["presets"],
      ),
      output: stateSchema,
    },
    activate: {
      input: object({ name: { type: "string", minLength: 1 } }, ["name"]),
      output: stateSchema,
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: {
          active: { type: ["string", "null"] },
        },
        additionalProperties: false,
      },
    },
  },
})

export interface WorkshopPresetSaveInput {
  readonly presets: Readonly<Record<string, PresetDefinition>>
  readonly active?: string | null
}

export type WorkshopPresetState = PresetState
export type WorkshopPresetRpcDefinition = typeof WorkshopPresetRpc
