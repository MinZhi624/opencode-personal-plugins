import { spawn } from "node:child_process"
import { executeCommand, sendMarkerCommand, waitForMarker } from "./commands.js"
import { startErrorReader, startReader } from "./reader.js"
import { shellQuote } from "./shell.js"
import type { SessionState } from "./state.js"

/**
 * 启动一条 SSH 进程并完成初始握手。
 *
 * 与上游 v0.3.0 的差异：
 * - `Bun.spawn` → Node `child_process.spawn`（Bun 与 Node 都实现了
 *   `node:child_process`，因此这一层不再依赖任何 `Bun.*` 全局对象）。
 * - 增加 `onError`：Node 的 `spawn` 对「找不到 ssh 可执行文件」不抛同步异常，
 *   而是随后发出 `error` 事件；上游在 Bun 下是同步抛出。这里把该事件写进
 *   `stderr` 并让等待中的命令失败，否则握手只会等到 30s 超时。
 * - `remoteDirectory` 非空时先 `cd` 过去，让后续命令与远端文件工具都落在
 *   设备档案指定的远端工作目录上。
 *
 * 连接参数、握手标记与超时逻辑保持上游原样。
 */
export async function spawnSSH(
  state: SessionState,
  host: string,
  options?: string,
  signal?: AbortSignal,
  remoteDirectory?: string,
): Promise<string> {
  const sshArgs = [
    "ssh",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ServerAliveInterval=60",
    "-o",
    "ServerAliveCountMax=3",
  ]

  if (options) {
    const extra = options.trim().split(/\s+/)
    sshArgs.push(...extra)
  }

  sshArgs.push(host, "bash", "-l")

  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("SSH operation aborted.")
  }

  const proc = spawn(sshArgs[0]!, sshArgs.slice(1))
  state.proc = proc
  state.host = host
  state.options = options?.trim() || null
  state.initialDirectory = remoteDirectory?.trim() || null
  state.remoteDirectory = state.initialDirectory
  state.buffer = ""
  state.stderr = ""
  state.readerDone = false

  const onError = (error: Error) => {
    state.stderr = `${state.stderr}\n${error.message}`.trim()
    state.readerDone = true
    state.pendingReject?.(error)
  }
  proc.once("error", onError)
  proc.once("close", () => {
    state.readerDone = true
  })

  const stderrDone = startErrorReader(state, proc.stderr)
  startReader(state, proc.stdout)

  try {
    // 初始握手：吃掉 MOTD / banner，并在需要时切到远端工作目录。
    const handshakeId = Math.random().toString(36).substring(2, 10)
    if (state.remoteDirectory) {
      sendMarkerCommand(state, `cd ${shellQuote(state.remoteDirectory)} && pwd`, handshakeId)
    } else {
      sendMarkerCommand(state, "true", handshakeId)
    }
    await waitForMarker(state, handshakeId, 30000, signal)

    if (state.remoteDirectory) {
      // 确认目录确实存在：cd 失败会让握手带着远端报错结束，而不是静默停在登录目录。
      const verify = await executeCommand(state, "pwd", 10_000, signal)
      if (!verify.includes(state.remoteDirectory)) {
        killSSH(state)
        await stderrDone
        throw new Error(
          `Remote directory not reachable on ${host}: ${state.remoteDirectory}. ` +
            `cd output was: ${verify.trim() || "(empty)"}`,
        )
      }
    }

    state.connectedAt = Date.now()
  } catch (err) {
    killSSH(state)
    await stderrDone
    const errorMsg = state.stderr.trim() || (err instanceof Error ? err.message : String(err))
    throw new Error(`Failed to establish SSH session to ${host}: ${errorMsg}`)
  } finally {
    proc.removeListener("error", onError)
  }

  return state.remoteDirectory
    ? `Connected to ${host}. Working directory: ${state.remoteDirectory}. Shell state will persist between commands.`
    : `Connected to ${host}. Shell state will persist between commands.`
}

/** 结束连接并重置全部状态。与上游 v0.3.0 一致。 */
export function killSSH(state: SessionState): string {
  const prevHost = state.host

  state.pendingReject?.(new Error("SSH connection closed."))
  if (state.proc) {
    try {
      state.proc.kill()
    } catch {
      // 忽略 kill 报错
    }
  }

  state.proc = null
  state.host = null
  state.connectedAt = null
  state.deviceID = null
  state.options = null
  state.initialDirectory = null
  state.remoteDirectory = null
  state.buffer = ""
  state.readerDone = true
  state.pendingResolve = null
  state.pendingReject = null
  state.currentMarkerId = ""
  return prevHost ? `Disconnected from ${prevHost}.` : "No active SSH session."
}
