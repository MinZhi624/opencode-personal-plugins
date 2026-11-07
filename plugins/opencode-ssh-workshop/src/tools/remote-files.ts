import { executeCommand, failed, isAlive } from "../session/commands.js"
import { withMutex } from "../session/mutex.js"
import { shellQuote } from "../session/shell.js"
import { assertPermission } from "../permission.js"
import { remoteResource, resolveRemotePath } from "../remote-path.js"
import type { SshRuntime, ResolvedSession } from "../workspace.js"
import type { ToolContext, ToolOutput } from "../types.js"

const FILE_TIMEOUT = 120_000
const MAX_OUTPUT_BYTES = 200_000

/**
 * 远端父目录。
 *
 * 无 `/` 表示当前远端工作目录——不能对 `main.py` 求 `slice(0, -1)`，
 * 那会得到 `main.p` 并凭空创建目录。
 */
export function remoteParentDirectory(path: string): string {
  const slash = path.lastIndexOf("/")
  if (slash > 0) return path.slice(0, slash)
  if (slash === 0) return "/"
  return "."
}

/** `sed -n` 的行范围；只给 offset 时读到末尾，拼出 `'25,$p'` 而不是 `'25,$pp'`。 */
export function readLineRange(
  offset?: number,
  limit?: number,
): { start: number; end: number | "$" } {
  const start = Math.max(1, Math.floor(offset ?? 1))
  const end = limit ? start + Math.max(1, Math.floor(limit)) - 1 : "$"
  return { start, end }
}

/**
 * glob 命令。
 *
 * 模式先写进变量再展开：变量值不会被重新扫描成命令文本，所以模式里的
 * `$(...)`／反引号不会执行。原先直接把模式拼进命令，等于让 `glob` 权限
 * 可以变相执行任意远端命令。
 */
export function buildGlobCommand(pattern: string): string {
  return `_p=${shellQuote(pattern)}; (shopt -s globstar nullglob; _m=($_p); if (( \${#_m[@]} == 0 )); then echo "NO_MATCH"; else printf '%s\\n' "\${_m[@]}"; fi)`
}

export const GREP_NO_MATCH = "__OC_SSH_GREP_NO_MATCH__"
export const GREP_ERROR = "__OC_SSH_GREP_ERROR__"

/**
 * grep 命令。
 *
 * GNU grep 没有 `-N`；这里用 -r 递归、-I 跳过二进制、-i 忽略大小写、-n 行号。
 * 退出码 1 表示「无匹配」而不是失败，必须和真正的错误（>1）分开，
 * 否则要么静默误报无匹配，要么把「无匹配」当成执行失败。
 *
 * 整个命令放在子 shell 里：`exit 0` 只结束子 shell，不能退出持久 SSH 会话。
 * 外层随后仍会执行结束标记，下一次命令才能继续使用同一条连接。
 */
export function buildGrepCommand(pattern: string, target: string, ignoreCase?: boolean): string {
  const flags = ignoreCase ? "-rIin" : "-rIn"
  return (
    `( grep ${flags} -e ${shellQuote(pattern)} ${shellQuote(target)}; ` +
    `__rc=$?; if [ $__rc -eq 1 ]; then echo "${GREP_NO_MATCH}"; ` +
    `elif [ $__rc -gt 1 ]; then echo "${GREP_ERROR}$__rc"; fi; exit 0 ) 2>&1`
  )
}

/** 这些工具必须落在已连接的会话上；否则返回一段可执行的提示而不是抛错。 */
async function requireSession(
  runtime: SshRuntime,
  tool: ToolContext,
): Promise<{ resolved: ResolvedSession } | { error: string }> {
  const resolved = await runtime.peekFor(tool)
  if (!resolved || !isAlive(resolved.state) || !resolved.state.host) {
    return { error: "No active SSH session. Use ssh_connect to establish a connection first." }
  }
  return { resolved }
}

/**
 * 迁移上游的远端命令通道，补上四个远端文件工具。
 *
 * 这四个工具是 SSH 角色用来代替本地 `read`/`write`/`glob`/`grep` 的：它们只在
 * 远端执行，不碰本机同名文件。权限沿用 V2 原生 action，因此规则写法与本地工具
 * 一致（`read`／`edit`／`glob`／`grep`），资源带上 `host:` 前缀以便按设备细分。
 */
export function createRemoteFileTools(runtime: SshRuntime) {
  const read = {
    name: "ssh_read",
    description:
      "Read a file on the remote host through the active SSH session. " +
      "Relative paths resolve against the session's remote working directory. " +
      "This is the remote counterpart of the local `read` tool; it never touches local files.",
    input: {
      type: "object",
      properties: {
        path: { type: "string", description: "Remote file path" },
        offset: { type: "number", description: "1-based line to start from (optional)" },
        limit: { type: "number", description: "Maximum number of lines to return (optional)" },
      },
      required: ["path"],
      additionalProperties: false,
    } as const,
    async execute(input: unknown, tool: ToolContext): Promise<ToolOutput> {
      const args = (input ?? {}) as { path?: string; offset?: number; limit?: number }
      const session = await requireSession(runtime, tool)
      if ("error" in session) return { content: session.error }
      const { state } = session.resolved
      const path = resolveRemotePath(state, args.path ?? "")

      await assertPermission(runtime.ctx, tool, {
        action: "read",
        resources: [remoteResource(state.host!, path)],
        save: [remoteResource(state.host!, path)],
        metadata: { host: state.host, path },
      })

      const { start, end } = readLineRange(args.offset, args.limit)
      const quoted = shellQuote(path)

      return {
        content: await withMutex(state, async () => {
          const probe = await executeCommand(
            state,
            `test -f ${quoted} && echo "FILE" || (test -d ${quoted} && echo "DIR" || echo "MISSING")`,
            FILE_TIMEOUT,
            tool.signal,
          )
          if (probe.trim() === "MISSING") return `Remote file not found: ${path}`
          if (probe.trim() === "DIR") return `Remote path is a directory, not a file: ${path}`

          const output = await executeCommand(
            state,
            args.offset || args.limit ? `sed -n '${start},${end}p' ${quoted}` : `cat ${quoted}`,
            FILE_TIMEOUT,
            tool.signal,
          )
          if (failed(output)) return `Failed to read remote file: ${output}`
          if (output.includes("\0")) {
            return `Remote file looks binary (${path}); use ssh_download to fetch it instead.`
          }
          return output.length > MAX_OUTPUT_BYTES
            ? `${output.slice(0, MAX_OUTPUT_BYTES)}\n… (truncated at ${MAX_OUTPUT_BYTES} bytes)`
            : output
        }),
      }
    },
  }

  const write = {
    name: "ssh_write",
    description:
      "Create or overwrite a file on the remote host through the active SSH session. " +
      "Content is sent as base64, so any text is safe. Relative paths resolve against " +
      "the session's remote working directory. This is the remote counterpart of the local " +
      "`write` tool; it never touches local files.",
    input: {
      type: "object",
      properties: {
        path: { type: "string", description: "Remote file path" },
        content: { type: "string", description: "Full new contents of the file" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    } as const,
    async execute(input: unknown, tool: ToolContext): Promise<ToolOutput> {
      const args = (input ?? {}) as { path?: string; content?: string }
      const session = await requireSession(runtime, tool)
      if ("error" in session) return { content: session.error }
      const { state } = session.resolved
      const path = resolveRemotePath(state, args.path ?? "")

      await assertPermission(runtime.ctx, tool, {
        action: "edit",
        resources: [remoteResource(state.host!, path)],
        save: [remoteResource(state.host!, path)],
        metadata: { host: state.host, path },
      })

      const body = Buffer.from(args.content ?? "", "utf8").toString("base64")
      const quoted = shellQuote(path)

      return {
        content: await withMutex(state, async () => {
          const dir = remoteParentDirectory(path)
          const output = await executeCommand(
            state,
            `mkdir -p ${shellQuote(dir)} && printf '%s' '${body}' | base64 -d > ${quoted}`,
            FILE_TIMEOUT,
            tool.signal,
          )
          if (failed(output)) return `Failed to write remote file: ${output}`
          return `Wrote ${Buffer.byteLength(args.content ?? "", "utf8")} bytes to ${state.host}:${path}`
        }),
      }
    },
  }

  const glob = {
    name: "ssh_glob",
    description:
      "Find files on the remote host by glob pattern (e.g. 'src/**/*.ts') through the active " +
      "SSH session. This is the remote counterpart of the local `glob` tool.",
    input: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, resolved from the remote working directory" },
      },
      required: ["pattern"],
      additionalProperties: false,
    } as const,
    async execute(input: unknown, tool: ToolContext): Promise<ToolOutput> {
      const args = (input ?? {}) as { pattern?: string }
      const session = await requireSession(runtime, tool)
      if ("error" in session) return { content: session.error }
      const { state } = session.resolved

      await assertPermission(runtime.ctx, tool, {
        action: "glob",
        resources: [args.pattern ?? ""],
        save: [args.pattern ?? ""],
        metadata: { host: state.host },
      })

      const pattern = (args.pattern ?? "").trim()
      return {
        content: await withMutex(state, async () => {
          const output = await executeCommand(state, buildGlobCommand(pattern), FILE_TIMEOUT, tool.signal)
          if (failed(output)) return `Failed to run glob on remote: ${output}`
          if (output.trim() === "NO_MATCH") return `No remote files match: ${pattern}`
          return output.length > MAX_OUTPUT_BYTES
            ? `${output.slice(0, MAX_OUTPUT_BYTES)}\n… (truncated at ${MAX_OUTPUT_BYTES} bytes)`
            : output
        }),
      }
    },
  }

  const grep = {
    name: "ssh_grep",
    description:
      "Search file contents on the remote host by regular expression through the active SSH " +
      "session. This is the remote counterpart of the local `grep` tool.",
    input: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for" },
        path: { type: "string", description: "Remote directory or file to search (default: remote working directory)" },
        ignoreCase: { type: "boolean", description: "Case-insensitive search" },
      },
      required: ["pattern"],
      additionalProperties: false,
    } as const,
    async execute(input: unknown, tool: ToolContext): Promise<ToolOutput> {
      const args = (input ?? {}) as { pattern?: string; path?: string; ignoreCase?: boolean }
      const session = await requireSession(runtime, tool)
      if ("error" in session) return { content: session.error }
      const { state } = session.resolved
      const target = resolveRemotePath(state, args.path ?? state.remoteDirectory ?? ".")

      await assertPermission(runtime.ctx, tool, {
        action: "grep",
        resources: [args.pattern ?? ""],
        save: [args.pattern ?? ""],
        metadata: { host: state.host, path: target },
      })

      // GNU grep 没有 `-N`；命令构造见 buildGrepCommand。
      return {
        content: await withMutex(state, async () => {
          const output = await executeCommand(
            state,
            buildGrepCommand(args.pattern ?? "", target, args.ignoreCase),
            FILE_TIMEOUT,
            tool.signal,
          )

          if (output.includes(GREP_ERROR)) {
            const detail = output.replace(GREP_ERROR, "").trim()
            return `Failed to search remote files: ${detail || "(no detail)"}`
          }
          if (output.trim() === GREP_NO_MATCH) return `No remote matches for: ${args.pattern}`

          const lines = output.split("\n").filter(Boolean)
          if (!lines.length) return `No remote matches for: ${args.pattern}`
          const clipped = lines.slice(0, 500).join("\n")
          return lines.length > 500 ? `${clipped}\n… (${lines.length - 500} more matches)` : clipped
        }),
      }
    },
  }

  return { read, write, glob, grep }
}
