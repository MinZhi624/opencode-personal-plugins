import type { SessionManager } from "./session/manager.js"
import type { SessionState } from "./session/state.js"
import type { DeviceStore } from "./devices/store.js"
import type { PluginContext, ToolContext } from "./types.js"

/**
 * 「远端工作区」：某个主会话当前绑定的设备与远端目录。
 * 与 CONTEXT.md「远端工作区」一致——它归主会话所有，同一主会话内的 SSH 主角色
 * 与 SSH Worker 共用，不同主会话各自独立。
 */
export interface Workspace {
  deviceID: string | null
  host: string
  remoteDirectory: string | null
}

export interface WorkspaceRegistry {
  /** 把任意会话（含子代理）解析成它所属的主会话 id。 */
  resolveRoot(sessionID: string): Promise<string>
  get(rootSessionID: string): Workspace | undefined
  set(rootSessionID: string, workspace: Workspace): void
  clear(rootSessionID: string): void
  forgetSession(sessionID: string): void
}

export function createWorkspaceRegistry(ctx: PluginContext): WorkspaceRegistry {
  /** 子会话 → 主会话的解析缓存；会话被删除时由事件流清掉。 */
  const rootCache = new Map<string, string>()
  const workspaces = new Map<string, Workspace>()

  return {
    async resolveRoot(sessionID) {
      const cached = rootCache.get(sessionID)
      if (cached) return cached

      let current = sessionID
      // 子代理通常只有一层；32 层是防止意外自引用的护栏，不是业务需求。
      for (let depth = 0; depth < 32; depth += 1) {
        let parentID: string | undefined
        try {
          parentID = (await ctx.session.get({ sessionID: current }))?.parentID
        } catch {
          break
        }
        if (!parentID) break
        current = parentID
      }

      rootCache.set(sessionID, current)
      return current
    },
    get(rootSessionID) {
      return workspaces.get(rootSessionID)
    },
    set(rootSessionID, workspace) {
      workspaces.set(rootSessionID, workspace)
    },
    clear(rootSessionID) {
      workspaces.delete(rootSessionID)
      for (const [child, root] of rootCache) if (root === rootSessionID) rootCache.delete(child)
    },
    forgetSession(sessionID) {
      rootCache.delete(sessionID)
    },
  }
}

export interface ResolvedSession {
  rootID: string
  state: SessionState
}

/** 把插件上下文、连接集合与远端工作区捆成工具层共用的运行时。 */
export interface SshRuntime {
  ctx: PluginContext
  sessions: SessionManager
  workspaces: WorkspaceRegistry
  devices: DeviceStore
  /** 是否把成功连接自动记成设备档案（插件选项 `rememberDevices`）。 */
  rememberDevices: boolean
  /** 解析工具所属主会话并取回它的连接状态（不存在时新建空状态）。 */
  stateFor(tool: ToolContext): Promise<ResolvedSession>
  /** 只读取，不新建。 */
  peekFor(tool: ToolContext): Promise<ResolvedSession | undefined>
}

export function createRuntime(
  ctx: PluginContext,
  sessions: SessionManager,
  workspaces: WorkspaceRegistry,
  devices: DeviceStore,
  rememberDevices: boolean,
): SshRuntime {
  return {
    ctx,
    sessions,
    workspaces,
    devices,
    rememberDevices,
    async stateFor(tool) {
      const rootID = await workspaces.resolveRoot(tool.sessionID)
      return { rootID, state: sessions.get(rootID) }
    },
    async peekFor(tool) {
      const rootID = await workspaces.resolveRoot(tool.sessionID)
      const state = sessions.peek(rootID)
      return state ? { rootID, state } : undefined
    },
  }
}
