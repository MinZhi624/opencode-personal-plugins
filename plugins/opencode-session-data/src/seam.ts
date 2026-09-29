/**
 * 共享会话数据 seam：跨插件、版本限定、按 TUI 实例隔离的自有接合处。
 *
 * 这不是 OpenCode 官方承诺的跨插件能力，而是本插件集在已验证的 V2 环境中
 * 采用的自有机制：
 * 升级 OpenCode 或改变插件加载机制时必须复验。
 *
 * 契约：
 * - 数据模块（opencode-session-data 插件）在每个 TUI 实例中拥有且仅拥有
 *   一份统计运行时，通过 `installSessionDataSeam` 发布；
 * - 消费者（会话概览／子代理等卡片）只用 `lookupSessionData` /
 *   `acquireSessionData` 取得运行时与摘要工厂，绝不自行创建统计运行时；
 * - 实例锚定在 `globalThis[Symbol.for(...)]` 的注册表上，因此即使双方各持
 *   一份模块拷贝也收敛到同一实例；注册表以 `context.renderer` 为键，
 *   同一 TUI 内跨插件、跨会话位置共享，多个 TUI 窗口彼此隔离；
 * - 数据模块缺席时消费者必须报告“不可用”，不得回退为自建运行时或零值。
 */

import type { Context } from "@opencode/plugin/tui/context"
import type { SessionCostSummary } from "./metrics/session-cost-summary.ts"
import { createSessionCostSummary } from "./metrics/session-cost-summary.ts"
import { createSessionDataRuntime, type SessionDataRuntime } from "./runtime.ts"

/** 当前 Interface 版本。不兼容版本确定性拒绝接管，绝不静默混用。 */
export const SESSION_DATA_SEAM_VERSION = 2
/** Seam 注册表锚点（globalThis[Symbol.for(...)]）。 */
export const SESSION_DATA_SEAM_SYMBOL = Symbol.for("opencode-session-data.seam.v2")
const LEGACY_SESSION_DATA_SEAM_SYMBOL = Symbol.for("opencode-session-data.seam.v1")
/**
 * 数据插件卸载后的清理宽限（毫秒）。热重载／快速切换期间新代会接管同一
 * 运行时；只有宽限内无人接管才真正销毁，避免误杀仍在使用的运行时。
 */
export const SESSION_DATA_DISPOSE_GRACE_MS = 1000
/** 未提供稳定身份的消费者的共享计数桶（引用计数按桶累加）。 */
const ANONYMOUS_CONSUMER = "anonymous"

export type { SessionDataRuntime } from "./runtime.ts"

/** 非持有的读取视图：不增加引用计数，适合一次性查询。 */
export interface SessionDataLookup {
  readonly version: number
  readonly runtime: SessionDataRuntime
  /** 当前持有引用的消费者总数（脱敏诊断）。 */
  consumers(): number
  /** 绑定共享运行时的三面成本摘要工厂。 */
  createSummary(context: Context, sessionID: () => string, tick: () => void): SessionCostSummary
}

/** 持有的读取视图：`release()` 后必须停止使用。 */
export interface SessionDataHandle extends SessionDataLookup {
  /** 消费者身份（稳定 id 或 "anonymous"）。 */
  readonly consumer: string
  /** 归还引用；幂等。最后一个消费者离开时运行时进入空闲（断开监听）。 */
  release(): void
  /** 数据模块卸载／换代导致运行时销毁时通知；返回取消订阅函数。 */
  onDispose(listener: () => void): () => void
}

/** 一个 TUI 实例的共享数据接合处。 */
export interface SessionDataSeam {
  readonly version: number
  readonly runtime: SessionDataRuntime
  /** 持有引用的消费者总数。 */
  consumers(): number
  /** 各消费者身份的引用计数（脱敏诊断）。 */
  consumerCounts(): Record<string, number>
  /** 卸载宽限内为 true：新消费者看到“缺席”，已持有者可用到真正销毁。 */
  orphaned(): boolean
  /** 取得持有引用；运行时已销毁或正在卸载宽限时返回 undefined。 */
  acquire(consumer: string): SessionDataHandle | undefined
  /** 完整销毁运行时并通知所有持有者（数据模块自身卸载用）。 */
  dispose(): void
}

/** 数据插件 setup 的安装结果。 */
export interface SessionDataSeamInstall {
  readonly seam: SessionDataSeam
  /** true 表示接管了同一 TUI 中仍在使用的运行时（热重载换代）。 */
  readonly adopted: boolean
  /** 因版本不兼容被替换掉的旧 seam 版本。 */
  readonly replacedVersion: number | undefined
  /** 插件 teardown 调用；宽限内无人接管才真正销毁。 */
  dispose(): void
}

interface InternalSeam extends SessionDataSeam {
  /** 原始数据插件的连接客户端；换连接重新 setup 时不得接管旧运行时。 */
  readonly sourceClient: Context["client"]
  /** 每次 setup 接管递增；旧代 cleanup 不能卸载新代持有的 seam。 */
  installGeneration: number
  orphanedFlag: boolean
  pendingDisposeTimer?: ReturnType<typeof setTimeout>
}

type SeamRegistry = WeakMap<object, SessionDataSeam>
type LegacySeamRegistry = WeakMap<object, Map<string, SessionDataSeam>>

function registry(globalObj: object): SeamRegistry {
  const holder = globalObj as Record<symbol, SeamRegistry | undefined>
  const existing = holder[SESSION_DATA_SEAM_SYMBOL]
  if (existing) return existing
  const created: SeamRegistry = new WeakMap()
  holder[SESSION_DATA_SEAM_SYMBOL] = created
  return created
}

/** 换代时把旧位置表指向新代，再通知旧消费者，兼容仍在挂载的 v1 卡片。 */
export function retireLegacySessionDataSeams(globalObj: object, renderer: object, replacement: SessionDataSeam): void {
  const old = (globalObj as Record<symbol, LegacySeamRegistry | undefined>)[LEGACY_SESSION_DATA_SEAM_SYMBOL]?.get(renderer)
  if (!old) return
  const seams = new Set([...old.values()].filter((seam) => seam.version !== SESSION_DATA_SEAM_VERSION))
  for (const scope of old.keys()) old.set(scope, replacement)
  for (const seam of seams) seam.dispose()
}

/**
 * 按 TUI 实例隔离的键：同一 TUI 内所有插件共享同一个 renderer，多个 TUI
 * 窗口（含同进程多实例）各自不同。缺失时退化为 context 本身。
 * 不能以当前 location 再分区：它可能随标签切换，而数据插件只 setup 一次。
 * 运行时的统计缓存已经按 sessionID 分区。
 */
function instanceKey(context: Context): object {
  const renderer: unknown = context.renderer
  return renderer && typeof renderer === "object" ? (renderer as object) : context
}

/** 当前 TUI 实例的 seam；数据模块缺席时为 undefined。 */
export function lookupSessionDataSeam(context: Context): SessionDataSeam | undefined {
  const seam = registry(globalThis).get(instanceKey(context))
  if (!seam || seam.orphaned()) return undefined
  return seam
}

function createSeam(context: Context, createRuntime: (context: Context) => SessionDataRuntime): InternalSeam {
  const runtime = createRuntime(context)
  const counts = new Map<string, number>()
  const disposeListeners = new Set<() => void>()
  let disposed = false
  const total = (): number => {
    let sum = 0
    for (const value of counts.values()) sum += value
    return sum
  }
  const seam: InternalSeam = {
    version: SESSION_DATA_SEAM_VERSION,
    runtime,
    sourceClient: context.client,
    installGeneration: 1,
    orphanedFlag: false,
    consumers: () => total(),
    consumerCounts: () => Object.fromEntries(counts),
    orphaned: () => seam.orphanedFlag,
    acquire(consumer: string): SessionDataHandle | undefined {
      const label = consumer || ANONYMOUS_CONSUMER
      if (disposed || seam.orphanedFlag) return undefined
      counts.set(label, (counts.get(label) ?? 0) + 1)
      if (total() === 1) runtime.arm()
      let released = false
      return {
        version: seam.version,
        consumer: label,
        runtime,
        consumers: () => total(),
        createSummary: (summaryContext, sessionID, tick) =>
          createSessionCostSummary(summaryContext, runtime, sessionID, tick),
        release() {
          if (released) return
          released = true
          const count = counts.get(label) ?? 0
          if (count <= 1) counts.delete(label)
          else counts.set(label, count - 1)
          if (total() === 0) runtime.disarm()
        },
        onDispose(listener) {
          disposeListeners.add(listener)
          return () => {
            disposeListeners.delete(listener)
          }
        },
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      counts.clear()
      for (const listener of [...disposeListeners]) {
        try {
          listener()
        } catch {
          /* 消费者清理错误绝不阻塞数据模块卸载 */
        }
      }
      disposeListeners.clear()
      runtime.dispose()
    },
  }
  return seam
}

function cancelPendingDispose(seam: InternalSeam): void {
  if (seam.pendingDisposeTimer !== undefined) {
    clearTimeout(seam.pendingDisposeTimer)
    seam.pendingDisposeTimer = undefined
  }
}

/**
 * 安装（或接管）当前 TUI 实例的 seam。由数据插件 setup 调用。
 *
 * - 已有同版本 seam：接管同一运行时，不重复挂监听（热重载安全）；
 * - 已有不兼容版本：新代先就位，再完整销毁旧代并通知其消费者；
 * - 没有：创建新运行时。
 */
export function installSessionDataSeam(
  globalObj: object,
  context: Context,
  createRuntime: (context: Context) => SessionDataRuntime = createSessionDataRuntime,
): SessionDataSeamInstall {
  const map = registry(globalObj)
  const key = instanceKey(context)
  const existing = map.get(key) as InternalSeam | undefined
  if (existing && existing.version === SESSION_DATA_SEAM_VERSION && existing.sourceClient === context.client) {
    cancelPendingDispose(existing)
    existing.orphanedFlag = false
    const generation = ++existing.installGeneration
    retireLegacySessionDataSeams(globalObj, key, existing)
    return {
      seam: existing,
      adopted: true,
      replacedVersion: undefined,
      dispose: () => disposeInstall(map, key, existing, generation),
    }
  }
  const seam = createSeam(context, createRuntime)
  // v1 按位置分表；新代先发布，再使旧消费者收到销毁通知并重新接入。
  // v1 表的旧位置键改指新代；旧代卸载计时器只会检查 v1 表中的旧实例。
  map.set(key, seam)
  retireLegacySessionDataSeams(globalObj, key, seam)
  if (existing) {
    // 版本不兼容：新代先注册，旧消费者重新 acquire 时落到新代。
    cancelPendingDispose(existing)
    existing.dispose()
    return { seam, adopted: false, replacedVersion: existing.version, dispose: () => disposeInstall(map, key, seam, 1) }
  }
  return { seam, adopted: false, replacedVersion: undefined, dispose: () => disposeInstall(map, key, seam, 1) }
}

function disposeInstall(map: SeamRegistry, key: object, seam: InternalSeam, generation: number): void {
  if (seam.installGeneration !== generation || map.get(key) !== seam || seam.orphanedFlag) return
  seam.orphanedFlag = true
  seam.pendingDisposeTimer = setTimeout(() => {
    seam.pendingDisposeTimer = undefined
    if (map.get(key) !== seam) return
    map.delete(key)
    seam.dispose()
  }, SESSION_DATA_DISPOSE_GRACE_MS)
}

/**
 * 窄消费者 API：非持有地取得共享运行时与摘要工厂。
 * 数据模块缺席时返回 undefined —— 调用方必须显示“不可用”，不得自建运行时。
 * 传入 sessionID 时立即预热该会话的分页聚合。
 */
export function lookupSessionData(
  context: Context,
  sessionID?: string,
): SessionDataLookup | undefined {
  const seam = lookupSessionDataSeam(context)
  if (!seam) return undefined
  if (sessionID && seam.consumers() > 0) seam.runtime.metrics.refresh(sessionID, { delayMs: 0 })
  return {
    version: seam.version,
    runtime: seam.runtime,
    consumers: () => seam.consumers(),
    createSummary: (summaryContext, id, tick) =>
      createSessionCostSummary(summaryContext, seam.runtime, id, tick),
  }
}

/**
 * 窄消费者 API：持有引用地取得共享运行时与摘要工厂。
 *
 * 约定：
 * - 同一消费者身份重复 acquire 按桶累加，release 归还一次；
 * - 第一个消费者到达时挂上事件监听，最后一个离开时断开（缓存保留）；
 * - 插件应传入稳定身份（自己的插件 id）以便热重载时引用计数不错杀；
 * - 数据模块缺席时返回 undefined，绝不回退为自建运行时。
 */
export function acquireSessionData(
  context: Context,
  sessionID?: string,
  consumer?: string,
): SessionDataHandle | undefined {
  const seam = lookupSessionDataSeam(context)
  if (!seam) return undefined
  const handle = seam.acquire(consumer ?? ANONYMOUS_CONSUMER)
  if (!handle) return undefined
  if (sessionID) handle.runtime.metrics.refresh(sessionID, { delayMs: 0 })
  return handle
}
