/**
 * 侧栏宿主 Seam 行为契约（生产版 v1）。
 *
 * 这是宿主与第三方卡片之间唯一的跨插件接合处：宿主与每张卡片各自持有一份本文件的
 * 拷贝（模拟独立安装），通过 `globalThis[Symbol.for(...)]` 收敛到同一 Seam 实例。
 * 契约本身不含任何运行时依赖，也不导入任何卡片或业务实现。
 *
 * 该契约按 OpenCode v2.0.18 的已测行为固化版本，不作为官方承诺的跨插件能力；
 * 升级 OpenCode 或改变插件加载机制时必须重新验收（见 README「兼容性」）。
 *
 * 确定性规则（缺一不可）：
 * - 注册归卡片所有者（owner）所有：撤销只影响自己的注册；
 * - 同 ID 不同 owner：先到者获胜，后到者确定性拒绝（duplicate-id），绝不静默覆盖；
 * - 同 owner 重新注册（插件启停换代）：撤销旧代自身注册并留 replaced-stale 诊断；
 * - requiredSeam 与宿主 SEAM_VERSION 不一致：确定性拒绝（incompatible-version）；
 * - 卡片先到、宿主后到：卡片进待接单队列，宿主 setup 时统一 drain；
 * - 卡片禁用：撤回排队请求（withdrawPending），宿主后到不得“复活”已禁用卡片；
 * - 宿主禁用／换代：不撤销任何卡片注册，新宿主代 adopt 接管同一注册表。
 */

/** Seam 实例锚点（globalThis[Symbol.for(...)]）。 */
export const SEAM_SYMBOL = Symbol.for("opencode-sidebar-host-zh.seam.v1")

/** 卡片先到、宿主后到时的待接单队列锚点。 */
export const PENDING_SYMBOL = Symbol.for("opencode-sidebar-host-zh.seam.v1.pending")

/** 当前 Interface 版本。卡片通过 requiredSeam 声明所需宿主版本；不一致即拒绝。 */
export const SEAM_VERSION = 1

/** 待接单队列上限：防御性上限，正常使用中队列长度等于“已启用且未撤销”的卡片数。 */
const PENDING_QUEUE_LIMIT = 256

/** 宿主传给卡片渲染函数的最小上下文（只含会话身份，不含任何宿主内部状态）。 */
export interface CardInput {
  readonly sessionID: string
}

/** 一张第三方卡片向宿主注册的全部内容。 */
export interface CardSpec {
  /** 稳定、带命名空间的身份，如 "vendor.my-card"。排序设置只保存这个身份。 */
  readonly id: string
  /** 所有者（卡片插件 id）。卸载／撤销只影响自己的注册。 */
  readonly owner: string
  readonly title: string
  /** 声明所需的 Interface 版本；与宿主 SEAM_VERSION 不一致即确定性拒绝。 */
  readonly requiredSeam: number
  /** 卡片自己的可交互 TUI 展示（其模块里的渲染函数，不是序列化数据）。 */
  readonly render: (input: CardInput) => unknown
  /** 注册被撤销（含热重载换代）时宿主调用的卡片侧清理。 */
  readonly dispose?: () => void
}

export interface RegisteredCard {
  readonly id: string
  readonly owner: string
  readonly title: string
  /** 同一 owner 重新注册（启停换代）的代数，从 1 起。 */
  readonly generation: number
  readonly spec: CardSpec
}

/** 注册失败的确定性错误码。 */
export type RegisterFailureCode = "duplicate-id" | "incompatible-version" | "unknown"

export type RegisterResult =
  | { readonly ok: true; readonly generation: number; readonly revoke: () => void }
  | { readonly ok: false; readonly code: RegisterFailureCode; readonly message: string }

/** 脱敏诊断：只含 owner／id／错误码与说明，不含会话内容或凭据。 */
export interface SeamDiagnostic {
  readonly at: number
  readonly code: string
  readonly message: string
}

export interface SidebarSeam {
  readonly version: number
  register(spec: CardSpec): RegisterResult
  list(): readonly RegisteredCard[]
  diagnostics(): readonly SeamDiagnostic[]
  /** 按所有者撤销其全部注册（卸载／禁用清理用；不影响其他 owner）。返回撤销条数。 */
  revokeOwner(owner: string): number
}

function anchor<T>(globalObj: object, key: symbol, create: () => T): T {
  const holder = globalObj as Record<symbol, T | undefined>
  const existing = holder[key]
  if (existing !== undefined) return existing
  const created = create()
  holder[key] = created
  return created
}

export function seamOn(globalObj: object): SidebarSeam | undefined {
  return (globalObj as Record<symbol, SidebarSeam | undefined>)[SEAM_SYMBOL]
}

export function installSeam(globalObj: object, seam: SidebarSeam): SidebarSeam {
  return anchor(globalObj, SEAM_SYMBOL, () => seam)
}

/** 待接单队列（卡片先到时由卡片侧写入，宿主 setup 时 drain）。 */
export function pendingQueue(globalObj: object): CardSpec[] {
  return anchor(globalObj, PENDING_SYMBOL, () => [] as CardSpec[])
}

/** 入队（同 owner+id 去重，替换旧请求），防止换代后重复排队。 */
export function queuePending(globalObj: object, spec: CardSpec): void {
  const queue = pendingQueue(globalObj)
  const index = queue.findIndex((item) => item.id === spec.id && item.owner === spec.owner)
  if (index >= 0) queue.splice(index, 1)
  queue.push(spec)
  // 防御性上限：只丢最早的请求，绝不丢新到的（新请求才是当前生效的插件代）。
  while (queue.length > PENDING_QUEUE_LIMIT) queue.shift()
}

/**
 * 卡片卸载／禁用时只撤回本代请求；旧代迟到清理不能撤回新代同 owner+id 的请求。
 * 没有这一步，已禁用卡片会在宿主后到、drain 队列时被“复活”注册（原型 S1 缺陷）。
 */
export function withdrawPending(globalObj: object, spec: CardSpec): void {
  const queue = pendingQueue(globalObj)
  for (let index = queue.length - 1; index >= 0; index--) {
    const item = queue[index]!
    if (item === spec) queue.splice(index, 1)
  }
}
