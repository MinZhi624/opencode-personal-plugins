import { readFile, stat, writeFile } from "node:fs/promises"
import { executeCommand, failed, isAlive } from "../session/commands.js"
import { withMutex } from "../session/mutex.js"
import { shellQuote } from "../session/shell.js"
import { authorizeTransfer } from "../permission.js"
import { resolveRemotePath } from "../remote-path.js"
import type { SshRuntime } from "../workspace.js"
import type { ToolContext, ToolOutput } from "../types.js"

const TRANSFER_TIMEOUT = 120_000

/**
 * 迁移上游 `ssh_upload`。
 *
 * 差异只有两处：`Bun.file()` → `node:fs/promises` 的 `stat`/`readFile`；
 * `context.ask` → `ctx.permission.assert`。分块、临时文件与 base64 编码流程
 * 与上游逐行一致。
 */
export function createUploadTool(runtime: SshRuntime) {
  return {
    name: "ssh_upload",
    description:
      "Upload a local file to the remote host through the active SSH session, using base64 " +
      "over the existing connection. Requires ssh_connect first. " +
      "Relative remote paths resolve against the session's remote working directory.",
    input: {
      type: "object",
      properties: {
        localPath: { type: "string", description: "Path to the local file to upload" },
        remotePath: { type: "string", description: "Destination path on the remote host" },
      },
      required: ["localPath", "remotePath"],
      additionalProperties: false,
    } as const,
    async execute(input: unknown, tool: ToolContext): Promise<ToolOutput> {
      const args = (input ?? {}) as { localPath?: string; remotePath?: string }
      const resolved = await runtime.peekFor(tool)
      if (!resolved || !isAlive(resolved.state) || !resolved.state.host) {
        return { content: "No active SSH session. Use ssh_connect to establish a connection first." }
      }
      const { state } = resolved
      const remotePath = resolveRemotePath(state, args.remotePath ?? "")

      const localPath = await authorizeTransfer(runtime.ctx, tool, {
        host: state.host!,
        localPath: args.localPath ?? "",
        localAction: "read",
        remotePath,
        remoteAction: "edit",
      })

      let bytes: Buffer
      try {
        await stat(localPath)
        bytes = await readFile(localPath)
      } catch {
        return { content: `Local file not found: ${args.localPath}` }
      }

      const base64 = bytes.toString("base64")
      const chunkSize = 4096
      const chunks: string[] = []
      for (let i = 0; i < base64.length; i += chunkSize) chunks.push(base64.slice(i, i + chunkSize))

      return {
        content: await withMutex(state, async () => {
          const tmpFile = `/tmp/.oc_upload_${Date.now()}`
          const quotedTmpFile = shellQuote(tmpFile)
          const initResult = await executeCommand(state, `> ${quotedTmpFile}`, TRANSFER_TIMEOUT, tool.signal)
          if (failed(initResult)) return `Failed to create temp file on remote: ${initResult}`

          for (const chunk of chunks) {
            const result = await executeCommand(
              state,
              `printf '%s' '${chunk}' >> ${quotedTmpFile}`,
              TRANSFER_TIMEOUT,
              tool.signal,
            )
            if (failed(result)) {
              await executeCommand(state, `rm -f ${quotedTmpFile}`, TRANSFER_TIMEOUT)
              return `Failed to write chunk to remote: ${result}`
            }
          }

          const decodeCmd = `base64 -d < ${quotedTmpFile} > ${shellQuote(remotePath)} && rm -f ${quotedTmpFile}`
          const decodeResult = await executeCommand(state, decodeCmd, TRANSFER_TIMEOUT, tool.signal)
          if (failed(decodeResult)) {
            await executeCommand(state, `rm -f ${quotedTmpFile}`, TRANSFER_TIMEOUT)
            return `Failed to decode file on remote: ${decodeResult}`
          }

          return `Uploaded ${localPath} to ${state.host}:${remotePath} (${bytes.length} bytes)`
        }),
      }
    },
  }
}

/**
 * 迁移上游 `ssh_download`。同样只是 `Bun.write()` → `node:fs/promises.writeFile`
 * 与权限接口的替换。
 */
export function createDownloadTool(runtime: SshRuntime) {
  return {
    name: "ssh_download",
    description:
      "Download a file from the remote host to the local machine through the active SSH session, " +
      "using base64 over the existing connection. Requires ssh_connect first.",
    input: {
      type: "object",
      properties: {
        remotePath: { type: "string", description: "Path to the file on the remote host" },
        localPath: { type: "string", description: "Destination path on the local machine" },
      },
      required: ["remotePath", "localPath"],
      additionalProperties: false,
    } as const,
    async execute(input: unknown, tool: ToolContext): Promise<ToolOutput> {
      const args = (input ?? {}) as { remotePath?: string; localPath?: string }
      const resolved = await runtime.peekFor(tool)
      if (!resolved || !isAlive(resolved.state) || !resolved.state.host) {
        return { content: "No active SSH session. Use ssh_connect to establish a connection first." }
      }
      const { state } = resolved
      const remotePath = resolveRemotePath(state, args.remotePath ?? "")

      const localPath = await authorizeTransfer(runtime.ctx, tool, {
        host: state.host!,
        localPath: args.localPath ?? "",
        localAction: "edit",
        remotePath,
        remoteAction: "read",
      })

      return {
        content: await withMutex(state, async () => {
          const quoted = shellQuote(remotePath)
          const check = await executeCommand(
            state,
            `test -f ${quoted} && echo "EXISTS" || echo "NOT_FOUND"`,
            TRANSFER_TIMEOUT,
            tool.signal,
          )
          if (check.trim() === "NOT_FOUND") return `Remote file not found: ${remotePath}`

          const b64 = await executeCommand(state, `base64 < ${quoted}`, TRANSFER_TIMEOUT, tool.signal)
          if (failed(b64)) return `Failed to read remote file: ${b64}`

          const bytes = Buffer.from(b64.replace(/\s/g, ""), "base64")
          await writeFile(localPath, bytes)
          return `Downloaded ${state.host}:${remotePath} to ${localPath} (${bytes.length} bytes)`
        }),
      }
    },
  }
}
