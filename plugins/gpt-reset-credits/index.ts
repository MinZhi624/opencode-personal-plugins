import { tool, type Plugin, type ToolContext } from "@opencode-ai/plugin"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const moduleDirectory =
  (import.meta as ImportMeta & { dir?: string }).dir ?? dirname(fileURLToPath(import.meta.url))
const script = join(moduleDirectory, "reset_credits.py")

function pythonCommand(): string[] {
  const configured = process.env.OPENCODE_PYTHON?.trim()
  if (configured) return [configured]
  return process.platform === "win32" ? ["py", "-3"] : ["python3"]
}

const commandTemplate = `使用本插件提供的重置卡工具完成请求。

命令参数：$ARGUMENTS

- 参数未以“兑换”开头：只调用 gpt_reset_credits_query，绝不调用兑换工具。
- 参数以“兑换”开头：先调用 gpt_reset_credits_query。按 expires_at 顺序展示所有 cards；若指定“第 N 张”则选择该行，否则选择第 1 张。
- 查询成功后显示“可用重置卡：N 张”，并渲染表格：选择｜重置卡｜剩余有效期｜到期时间（UTC+8）。不要展示 selection_key 或 snapshot_key。
- 兑换时展示目标卡，然后调用 gpt_reset_credits_redeem，传入该行的 selection_key、顶层 snapshot_key、number、title、remaining、expires_at。工具会使用 OpenCode 原生权限确认；拒绝即停止。
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

async function runPython(args: string[], context: ToolContext): Promise<SafeResult> {
  const child = Bun.spawn([...pythonCommand(), script, ...args], {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const abort = () => child.kill()
  context.abort.addEventListener("abort", abort, { once: true })
  if (context.abort.aborted) abort()

  try {
    const [stdout, , exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exitCode !== 0) throw new Error("helper failed")
    const result = JSON.parse(stdout) as unknown
    if (!result || typeof result !== "object" || typeof (result as SafeResult).result !== "string") {
      throw new Error("invalid helper output")
    }
    return result as SafeResult
  } catch {
    return {
      result: "tool_error",
      operation: args[0] ?? "unknown",
      message: "重置卡工具执行失败；未展示内部错误详情。",
    }
  } finally {
    context.abort.removeEventListener("abort", abort)
  }
}

function output(result: SafeResult): string {
  return JSON.stringify(result)
}

const query = tool({
  description: "查询当前 ChatGPT 账户的可用重置卡，返回安全 JSON。",
  args: {},
  async execute(_args, context) {
    context.metadata({ title: "查询重置卡" })
    return output(await runPython(["query"], context))
  },
})

const redeem = tool({
  description: "兑换一张已查询的重置卡；执行前使用 OpenCode 原生权限确认。",
  args: {
    selectionKey: tool.schema.string().min(1).describe("查询结果中目标卡的 selection_key"),
    snapshotKey: tool.schema.string().min(1).describe("查询结果顶层的 snapshot_key"),
    number: tool.schema.number().int().positive().describe("表格中的目标序号"),
    title: tool.schema.string().min(1).describe("表格中的目标名称"),
    remaining: tool.schema.string().min(1).describe("表格中的剩余有效期"),
    expiresAt: tool.schema.string().min(1).describe("表格中的 UTC+8 到期时间"),
  },
  async execute(args, context) {
    const latest = await runPython(["query"], context)
    if (latest.result !== "query_success" || !latest.cards || !latest.snapshot_key) {
      return output(latest)
    }

    const target = latest.cards.find((card) => card.selection_key === args.selectionKey)
    const unchanged =
      latest.snapshot_key === args.snapshotKey &&
      target?.number === args.number &&
      target.title === args.title &&
      target.remaining === args.remaining &&
      target.expires_at === args.expiresAt

    if (!unchanged || !target) {
      return output({
        result: "aborted_changed",
        message: "重置卡列表或目标卡已变化，未执行兑换。",
        available_count: latest.available_count,
        snapshot_key: latest.snapshot_key,
        cards: latest.cards,
      })
    }

    const confirmation = `第 ${target.number} 张：${target.title}（剩余 ${target.remaining}，到期 ${target.expires_at} UTC+8）`
    context.metadata({
      title: `确认兑换第 ${target.number} 张重置卡`,
      metadata: {
        number: target.number,
        title: target.title,
        remaining: target.remaining,
        expiresAt: target.expires_at,
      },
    })
    await context.ask({
      permission: "gpt_reset_credits_redeem_confirm",
      patterns: [confirmation],
      always: [],
      metadata: {
        irreversible: true,
        number: target.number,
        title: target.title,
        remaining: target.remaining,
        expiresAt: target.expires_at,
      },
    })

    return output(
      await runPython(
        [
          "redeem",
          "--selection-key",
          args.selectionKey,
          "--snapshot-key",
          args.snapshotKey,
        ],
        context,
      ),
    )
  },
})

const plugin = (async () => ({
  config: async (config) => {
    config.command ??= {}
    config.command["gpt-reset-credits"] = {
      description: "查询或兑换 ChatGPT 重置卡",
      template: commandTemplate,
      agent: "tinker",
    }

    const permissions: Record<string, unknown> =
      typeof config.permission === "string"
        ? { "*": config.permission }
        : ((config.permission ?? {}) as Record<string, unknown>)
    permissions.gpt_reset_credits_query = "allow"
    permissions.gpt_reset_credits_redeem = "allow"
    permissions.gpt_reset_credits_redeem_confirm = "ask"
    config.permission = permissions as typeof config.permission
  },
  tool: {
    gpt_reset_credits_query: query,
    gpt_reset_credits_redeem: redeem,
  },
})) satisfies Plugin

export default plugin
