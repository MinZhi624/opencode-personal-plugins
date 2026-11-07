import { MARKER_PREFIX, MARKER_SUFFIX } from "./marker.js"
import { checkBuffer } from "./reader.js"
import type { SessionState } from "./state.js"

/**
 * 向 SSH 进程 stdin 写入一条命令，并追加一个 echo 结束标记用于切分输出。
 *
 * 与上游 v0.3.0 的差异：上游的 stdin 是 Bun `FileSink`，写完要 `flush()`；
 * Node 的 `Writable` 没有 `flush()`，`write()` 本身即投递到管道，因此去掉该调用。
 */
export function sendMarkerCommand(state: SessionState, command: string, id: string): void {
  const stdin = state.proc?.stdin
  if (!stdin) throw new Error("SSH process stdin is not available.")
  // 结束标记同时携带当前 shell 的 PWD（Base64，避免路径中的字符破坏标记）。
  // 这样 ssh 命令里的 cd 会同步到 state，后续相对路径和权限资源不会仍按连接
  // 时的旧目录解析；命令原文和退出码语义保持不变。
  const payload =
    `${command} 2>&1\n` +
    `__oc_ec=$?; __oc_pwd=$(pwd | base64 -w0); echo "${MARKER_PREFIX}${id}_\${__oc_ec}_\${__oc_pwd}${MARKER_SUFFIX}"\n`
  stdin.write(payload)
}

/**
 * 等待某个标记出现在缓冲区，带超时与取消。
 * 与上游 v0.3.0 逐行一致。
 */
export async function waitForMarker(
  state: SessionState,
  id: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout>

    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      if (state.currentMarkerId !== id) return
      state.pendingResolve = null
      state.pendingReject = null
      state.currentMarkerId = ""
    }
    const complete =
      <T>(callback: (value: T) => void) =>
      (value: T) => {
        if (settled) return
        settled = true
        cleanup()
        callback(value)
      }
    const onAbort = () => {
      const reason = signal?.reason
      complete(reject)(reason instanceof Error ? reason : new Error("SSH operation aborted."))
    }

    state.currentMarkerId = id
    state.pendingResolve = complete(resolve)
    state.pendingReject = complete(reject)
    timer = setTimeout(() => {
      if (state.currentMarkerId === id) {
        state.pendingReject?.(new Error(`Command timed out after ${timeout}ms`))
      }
    }, timeout)
    signal?.addEventListener("abort", onAbort, { once: true })

    if (signal?.aborted) {
      onAbort()
      return
    }
    checkBuffer(state)
  })
}

/**
 * 在活动连接上执行一条命令并返回其输出。
 * 与上游 v0.3.0 逐行一致。
 */
export async function executeCommand(
  state: SessionState,
  command: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!isAlive(state)) {
    // 不能把连接已断开的提示当成命令输出：调用方可能将它当文件内容、
    // Base64 或成功结果继续处理。连接状态失效时必须让调用明确失败。
    throw new Error("No active SSH session. Use ssh_connect to establish a connection first.")
  }
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("SSH operation aborted.")
  }

  const id = Math.random().toString(36).substring(2, 10)
  sendMarkerCommand(state, command, id)

  const result = await waitForMarker(state, id, timeout, signal)

  if (result.exitCode !== 0) {
    return `${result.output}\n[exit code: ${result.exitCode}]`
  }
  return result.output
}

/** 连接是否仍然存活。 */
export function isAlive(state: SessionState | undefined): boolean {
  return state?.proc != null && !state.readerDone
}

/** 上游用 `output.includes("[exit code:")` 判断命令失败，这里把它收成一个函数，语义不变。 */
export function failed(output: string): boolean {
  return output.includes("[exit code:")
}
