import { Rpc } from "@opencode/plugin/rpc"

/**
 * TUI 界面（`/ssh-devices`）与服务端插件之间的桥。
 *
 * 设备档案只存在服务端的插件持久存储里，界面不直接读写存储，而是走这份 RPC，
 * 从而保证界面和自然语言工具操作的是同一份数据、同一套校验。
 */

/** 输出刻意宽松：形状由服务端保证，界面侧只需可选字段，避免校验器过严。 */
const looseObject = { type: "object", additionalProperties: true } as const

/** 预期失败（如设备不存在、名称重复）走声明错误，界面直接展示 message。 */
const invalidErrors = {
  invalid: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  },
} as const

export const SshDevicesRpc = Rpc.define({
  id: "opencode-ssh-workshop.devices",
  methods: {
    list: {
      input: { type: "object", additionalProperties: false } as const,
      output: looseObject,
    },
    save: {
      input: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          host: { type: "string" },
          user: { type: "string" },
          port: { type: "number" },
          identityFile: { type: "string" },
          options: { type: "string" },
          remoteDirectory: { type: "string" },
        },
        required: ["name", "host"],
        additionalProperties: false,
      } as const,
      output: looseObject,
      errors: invalidErrors,
    },
    remove: {
      input: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      } as const,
      output: looseObject,
      errors: invalidErrors,
    },
    connect: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          deviceID: { type: "string" },
        },
        required: ["sessionID", "deviceID"],
        additionalProperties: false,
      } as const,
      output: looseObject,
      errors: invalidErrors,
    },
    status: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      } as const,
      output: looseObject,
    },
  },
  events: {
    updated: { schema: looseObject },
  },
})

/** 服务端注册 RPC 时收到的调用上下文（含取消信号）。 */
export interface RpcCallContext {
  readonly signal: AbortSignal
  error(type: string, message: string, data?: unknown): never
}
