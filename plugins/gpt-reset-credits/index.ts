import { Plugin } from "@opencode/plugin"
import { z } from "zod"
import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const moduleDirectory =
  (import.meta as ImportMeta & { dir?: string }).dir ?? dirname(fileURLToPath(import.meta.url))
const script = join(moduleDirectory, "reset_credits.py")

function pythonCommand(): [string, ...string[]] {
  const configured = process.env.OPENCODE_PYTHON?.trim()
  if (configured) return [configured]
  return process.platform === "win32" ? ["py", "-3"] : ["python3"]
}

const commandTemplate = `使用本插件提供的重置卡工具完成请求。

命令参数：$ARGUMENTS

- 参数未以“兑换”开头：只调用 gpt_reset_credits_query，绝不调用兑换工具。
- 参数以“兑换”开头：先调用 gpt_reset_credits_query。按 expires_at 顺序展示所有 cards；若指定“第 N 张”则选择该行，否则选择第 1 张。
- 查询成功后显示“可用重置卡：N 张”，并渲染表格：选择｜重置卡｜剩余有效期｜到期时间（UTC+8）。不要展示 selection_key 或 snapshot_key。
- 兑换时展示目标卡，然后调用 gpt_reset_credits_redeem。OpenCode 会先进行原生权限确认；拒绝即停止。
- 只有 result=redeem_success 才报告成功。对 aborted_changed、not_redeemed、consumed_no_windows、uncertain 和错误结果，按 message 如实说明且不重试。
- 只能使用这两个工具，不得使用 Bash、Python 命令或手写 HTTP 请求。`

type SafeResult = {
  result: string
  snapshot_key?: string
  available_count?: number
  cards?: Array<{
    number: number
    title: string
    remaining: string
    expires_at: string
    selection_key: string
  }>
  [key: string]: unknown
}

function toolError(args: string[]): SafeResult {
  return {
    result: "tool_error",
    operation: args[0] ?? "unknown",
    message: "重置卡工具执行失败；未展示内部错误详情。",
  }
}

async function runPython(args: string[], accessToken?: string): Promise<SafeResult> {
  const [command, ...prefix] = pythonCommand()
  return await new Promise((resolve) => {
    const child = spawn(command, [...prefix, script, ...args], {
      env: accessToken ? { ...process.env, OPENCODE_V2_ACCESS_TOKEN: accessToken } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.once("error", () => resolve(toolError(args)))
    child.once("close", (code) => {
      if (code !== 0) return resolve(toolError(args))
      try {
        const result = JSON.parse(stdout) as SafeResult
        resolve(result && typeof result.result === "string" ? result : toolError(args))
      } catch {
        resolve(toolError(args))
      }
    })
  })
}

const redeemInput = z.object({
  selectionKey: z.string().min(1),
  snapshotKey: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string().min(1),
  remaining: z.string().min(1),
  expiresAt: z.string().min(1),
})

export default Plugin.define({
  id: "gpt-reset-credits",
  async setup(context) {
    const accessToken = async () => {
      for (const integrationID of ["openai", "chatgpt", "codex"]) {
        const connection = await context.integration.connection.active(integrationID)
        if (!connection) continue
        const credential = await context.integration.connection.resolve(connection)
        if (credential?.type === "oauth" && credential.access) return credential.access
      }
    }
    await context.tool.transform((editor) => {
      editor.add({
        name: "gpt_reset_credits_query",
        description: "查询当前 ChatGPT 账户的可用重置卡，返回安全 JSON。",
        input: z.object({}),
        options: { permission: "gpt-reset-credits.query" },
        async execute() {
          return { content: JSON.stringify(await runPython(["query"], await accessToken())) }
        },
      })
      editor.add({
        name: "gpt_reset_credits_redeem",
        description: "兑换一张已查询的重置卡；执行前由 OpenCode 原生权限确认。",
        input: redeemInput,
        options: { permission: "gpt-reset-credits.redeem" },
        async execute(args) {
          const token = await accessToken()
          const latest = await runPython(["query"], token)
          if (latest.result !== "query_success" || !latest.cards || !latest.snapshot_key) {
            return { content: JSON.stringify(latest) }
          }
          const target = latest.cards.find((card) => card.selection_key === args.selectionKey)
          const unchanged = target !== undefined &&
            latest.snapshot_key === args.snapshotKey &&
            target.number === args.number &&
            target.title === args.title &&
            target.remaining === args.remaining &&
            target.expires_at === args.expiresAt
          if (!unchanged || !target) {
            return {
              content: JSON.stringify({
                result: "aborted_changed",
                message: "重置卡列表或目标卡已变化，未执行兑换。",
                available_count: latest.available_count,
                cards: latest.cards,
              }),
            }
          }
          return {
            content: JSON.stringify(
              await runPython([
                "redeem",
                "--selection-key",
                args.selectionKey,
                "--snapshot-key",
                args.snapshotKey,
              ], token),
            ),
          }
        },
      })
    })

    await context.command.transform((editor) => {
      editor.add({
        name: "gpt-reset-credits",
        description: "查询或兑换 ChatGPT 重置卡",
        async execute(input) {
          await context.session.prompt({
            sessionID: input.sessionID,
            ...input.prompt,
            text: commandTemplate.replace("$ARGUMENTS", input.prompt.text),
            delivery: input.delivery,
          })
        },
      })
    })
  },
})
