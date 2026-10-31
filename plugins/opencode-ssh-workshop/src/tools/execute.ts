import { executeCommand, isAlive } from "../session/commands.js"
import { withMutex } from "../session/mutex.js"
import { assertPermission } from "../permission.js"
import { scanBashCommand, UnscannableCommandError } from "../shell-parser.js"
import type { SshRuntime } from "../workspace.js"
import type { ToolContext, ToolOutput } from "../types.js"

const DEFAULT_TIMEOUT = 120_000

/**
 * 迁移上游 `ssh` 工具。差异：
 * - `context.ask({ permission: "bash" })` → V2 的 `shell` action；
 * - 权限资源来自 Bash 语法解析（见 `shell-parser.ts`），因此 `$()`、反引号、
 *   `if…then`、子 shell 等结构里藏的命令同样会被检查；
 * - **先解析、后授权、最后才发送**：任一资源被 deny、或命令无法可靠分析，
 *   整条命令都不会写进 SSH 的 stdin。此前的实现先切分再授权，且对无法分析的
 *   写法按原文放行，正是权限绕过的来源。
 */
export function createExecuteTool(runtime: SshRuntime) {
  return {
    name: "ssh",
    description:
      "Execute a command on the active persistent SSH session. " +
      "Shell state (cd, exported variables, etc.) persists across calls. " +
      "Requires ssh_connect first. Does NOT support interactive/TUI commands (vim, top, etc.). " +
      "Commands must be statically analysable: dynamic command names, eval with runtime values, " +
      "dynamic arguments (including substitution results), unsupported wrappers/options, " +
      "and malformed shell syntax are rejected before execution.",
    input: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute on the remote host" },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default 120000 = 2 minutes)",
        },
      },
      required: ["command"],
      additionalProperties: false,
    } as const,
    async execute(input: unknown, tool: ToolContext): Promise<ToolOutput> {
      const args = (input ?? {}) as { command?: string; timeout?: number }
      const resolved = await runtime.peekFor(tool)
      if (!resolved || !isAlive(resolved.state)) {
        return { content: "No active SSH session. Use ssh_connect to establish a connection first." }
      }
      const { state } = resolved
      const command = args.command ?? ""

      let resources: readonly string[]
      try {
        resources = (await scanBashCommand(command)).resources
      } catch (error) {
        // 无法可靠分析：直接拒绝，不退回按原文授权，也不发送到远端。
        if (error instanceof UnscannableCommandError) return { content: error.message }
        throw error
      }

      await assertPermission(runtime.ctx, tool, {
        action: "shell",
        resources,
        // 保存整条原文而不是单段：范围更窄，不会顺带放行后续同类命令。
        save: [command],
        metadata: { host: state.host },
      })

      try {
        return {
          content: await withMutex(state, () =>
            executeCommand(state, command, args.timeout ?? DEFAULT_TIMEOUT, tool.signal),
          ),
        }
      } catch (error) {
        runtime.sessions.remove(resolved.rootID)
        runtime.workspaces.clear(resolved.rootID)
        throw error
      }
    },
  }
}
