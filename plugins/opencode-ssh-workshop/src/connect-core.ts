import { isAlive } from "./session/commands.js"
import { spawnSSH } from "./session/connection.js"
import { withMutex } from "./session/mutex.js"
import { profileFromTarget } from "./devices/types.js"
import type { SessionState } from "./session/state.js"
import type { SshRuntime } from "./workspace.js"

export interface ConnectRequest {
  /** 最终 ssh 目标，例如 `axiang@192.168.1.20`。 */
  target: string
  options?: string
  remoteDirectory: string | null
  deviceID: string | null
  /** 是否把这次连接自动记成一份设备档案。 */
  remember: boolean
  signal?: AbortSignal
}

/**
 * 现有连接是否真的对应本次请求。
 *
 * 只比较 target + 目录会漏掉端口、密钥、跳板机等 options，导致同地址的
 * 不同设备被误判为“已连接”并继续使用旧会话。参数变化必须重连。
 */
export function isSameConnection(
  state: Pick<SessionState, "host" | "initialDirectory" | "options">,
  request: Pick<ConnectRequest, "target" | "options" | "remoteDirectory">,
): boolean {
  const requestedOptions = request.options?.trim() || null
  const requestedDirectory = request.remoteDirectory?.trim() || null
  return (
    state.host === request.target &&
    state.options === requestedOptions &&
    state.initialDirectory === requestedDirectory
  )
}

/**
 * 建立连接并登记远端工作区。
 *
 * 抽出来是因为有两条入口都要用它：`ssh_connect` 工具（Agent 自然语言调用）与
 * `/ssh-devices` 界面（用户在 TUI 里选设备）。两者必须得到完全一致的结果，
 * 否则同一条连接会因为入口不同而状态不同。
 *
 * 权限检查不在此处做——调用方各自决定用什么 action 与资源。
 */
export async function connectSession(
  runtime: SshRuntime,
  rootID: string,
  request: ConnectRequest,
): Promise<string> {
  let state = runtime.sessions.get(rootID)
  const requestedDirectory = request.remoteDirectory?.trim() || null

  if (isAlive(state) && isSameConnection(state, request)) {
    // 复用连接也要把当前设备身份同步到状态；否则 ssh_info 可能仍显示旧档案。
    state.deviceID = request.deviceID
    runtime.workspaces.set(rootID, {
      deviceID: request.deviceID,
      host: request.target,
      remoteDirectory: requestedDirectory,
    })
    return `Already connected to ${request.target}.`
  }

  if (isAlive(state)) state = runtime.sessions.replace(rootID)

  try {
    const message = await withMutex(state, () =>
      spawnSSH(state, request.target, request.options, request.signal, requestedDirectory ?? undefined),
    )
    state.deviceID = request.deviceID
    state.remoteDirectory = requestedDirectory
    runtime.workspaces.set(rootID, {
      deviceID: request.deviceID,
      host: request.target,
      remoteDirectory: requestedDirectory,
    })

    const now = Date.now()
    if (request.deviceID) {
      await runtime.devices.touch(request.deviceID, now).catch(() => undefined)
    } else if (request.remember) {
      try {
        const derived = profileFromTarget(request.target, request.options)
        const saved = await runtime.devices.save({ ...derived, name: request.target })
        state.deviceID = saved.id
        runtime.workspaces.set(rootID, {
          deviceID: saved.id,
          host: request.target,
          remoteDirectory: requestedDirectory,
        })
      } catch {
        // 重名等原因记不下来不影响连接本身。
      }
    }

    return message
  } catch (error) {
    runtime.sessions.remove(rootID)
    runtime.workspaces.clear(rootID)
    throw error
  }
}
