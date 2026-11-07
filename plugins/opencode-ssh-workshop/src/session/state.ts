import type { ChildProcessWithoutNullStreams } from "node:child_process"

/**
 * 一条持久 SSH 连接的全部运行时状态。
 *
 * 与上游 v0.3.0 的差异只有一处：`proc` 从 `Bun.spawn` 的返回值改为
 * Node `child_process.spawn` 的 `ChildProcessWithoutNullStreams`。这样在
 * Bun 与 Node 两种插件宿主下都能运行，不再依赖 `Bun.*` 全局对象。
 *
 * `deviceID` / `remoteDirectory` 是本扩展新增：连接与「远端工作区」一一对应，
 * 供远端文件工具解析相对路径。上游没有这两个字段，因为上游不区分角色与设备。
 */
export interface SessionState {
  proc: ChildProcessWithoutNullStreams | null
  host: string | null
  connectedAt: number | null
  buffer: string
  stderr: string
  pendingResolve: ((result: { output: string; exitCode: number }) => void) | null
  pendingReject: ((error: Error) => void) | null
  currentMarkerId: string
  running: boolean
  commandQueue: Array<() => void>
  readerDone: boolean
  /** 本次连接所用的设备档案 id；手工连接（未选档案）时为 null。 */
  deviceID: string | null
  /** 本次连接使用的附加 ssh 参数；用于判断能否复用现有连接。 */
  options: string | null
  /** 连接时请求的初始目录；用于判断能否复用现有连接，不随 cd 改变。 */
  initialDirectory: string | null
  /** 远端当前工作目录；连接握手和每次命令结束后更新，设备档案未提供时为登录目录。 */
  remoteDirectory: string | null
}

export function createState(): SessionState {
  return {
    proc: null,
    host: null,
    connectedAt: null,
    buffer: "",
    stderr: "",
    pendingResolve: null,
    pendingReject: null,
    currentMarkerId: "",
    running: false,
    commandQueue: [],
    readerDone: false,
    deviceID: null,
    options: null,
    initialDirectory: null,
    remoteDirectory: null,
  }
}
