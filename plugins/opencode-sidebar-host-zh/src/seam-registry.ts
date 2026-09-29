// 宿主侧 Seam 注册表实现（生产版）。不导入任何卡片实现，也不导入任何业务卡片。
//
// 注册表状态锚在 seam 对象闭包里；seam 本身锚在 globalThis（每 TUI 进程一个实例，
// 因此各窗口的卡片实例、事件与会话统计彼此隔离，只有持久化排序设置跨 TUI 同步）。
// 宿主禁用再启用时由新宿主代（adopt）接管同一注册表，注册不丢失、gen 不变。

import {
  SEAM_VERSION,
  installSeam,
  seamOn,
  type CardSpec,
  type RegisterResult,
  type RegisteredCard,
  type SeamDiagnostic,
  type SidebarSeam,
} from "./seam.ts"

type Listener = () => void

/** 诊断条数上限：长期运行的 TUI 里避免无界增长（只保留最近若干条）。 */
const DIAGNOSTICS_LIMIT = 200

export function makeSeam(): SidebarSeam & { onChange(listener: Listener): () => void } {
  const records: RegisteredCard[] = []
  const diagnostics: SeamDiagnostic[] = []
  const listeners = new Set<Listener>()
  const ownerGeneration = new Map<string, number>()

  function diag(code: string, message: string) {
    diagnostics.push({ at: Date.now(), code, message })
    if (diagnostics.length > DIAGNOSTICS_LIMIT) diagnostics.splice(0, diagnostics.length - DIAGNOSTICS_LIMIT)
  }
  function notify() {
    for (const listener of [...listeners]) listener()
  }
  function remove(record: RegisteredCard) {
    const index = records.indexOf(record)
    if (index >= 0) records.splice(index, 1)
    if (index >= 0) notify()
  }

  const seam: SidebarSeam & { onChange(listener: Listener): () => void } = {
    version: SEAM_VERSION,
    register(spec: CardSpec): RegisterResult {
      if (spec.requiredSeam !== SEAM_VERSION) {
        diag("incompatible-version", `${spec.owner}/${spec.id} 要求 v${spec.requiredSeam}，宿主为 v${SEAM_VERSION}`)
        return { ok: false, code: "incompatible-version", message: `需要 seam v${spec.requiredSeam}，宿主 v${SEAM_VERSION}` }
      }
      const existing = records.find((record) => record.id === spec.id)
      if (existing && existing.spec.owner !== spec.owner) {
        // 同 ID 不同所有者：确定性拒绝，绝不静默覆盖（原型 P9 双向验证）
        diag("duplicate-id", `${spec.owner} 试图注册已被 ${existing.spec.owner} 占用的 ${spec.id}`)
        return { ok: false, code: "duplicate-id", message: `${spec.id} 已被 ${existing.spec.owner} 注册` }
      }
      let generation = 1
      if (existing && existing.spec.owner === spec.owner) {
        // 同一所有者换代（插件启停）：撤销旧代自己的注册，留下诊断，不是静默覆盖
        generation = existing.generation + 1
        diag("replaced-stale", `${spec.owner}/${spec.id} 换代 ${existing.generation} → ${generation}`)
        try {
          existing.spec.dispose?.()
        } catch {
          diag("dispose-error", `${spec.owner}/${spec.id} 旧代 dispose 抛错（已吞掉，保护宿主）`)
        }
        remove(existing)
      } else if (!existing) {
        generation = (ownerGeneration.get(spec.owner) ?? 0) + 1
      }
      ownerGeneration.set(spec.owner, Math.max(generation, ownerGeneration.get(spec.owner) ?? 0))
      const record: RegisteredCard = { id: spec.id, owner: spec.owner, title: spec.title, generation, spec }
      records.push(record)
      diag("registered", `${spec.owner}/${spec.id} 第 ${generation} 代已注册`)
      notify()
      return {
        ok: true,
        generation,
        // 身份守卫：旧代被换代移除后，迟到的 revoke 通过 indexOf 找不到自己，自然无效
        revoke: () => remove(record),
      }
    },
    list: () => [...records],
    diagnostics: () => [...diagnostics],
    revokeOwner(owner: string) {
      const owned = records.filter((record) => record.spec.owner === owner)
      for (const record of owned) remove(record)
      if (owned.length > 0) diag("revoked-owner", `${owner} 撤销自身注册 ${owned.length} 条`)
      return owned.length
    },
    onChange(listener: Listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return seam
}

export interface SeamHandle {
  readonly seam: SidebarSeam
  /** true 表示接管了先前宿主代的注册表（宿主禁用再启用）。 */
  readonly adopted: boolean
  /** true 表示存在版本不兼容的旧 seam，按契约拒绝接管并保持惰性。 */
  readonly conflict: boolean
  onChange(listener: Listener): () => void
}

/**
 * 宿主 setup 入口：创建或接管 Seam。
 * - 无 seam：新建并安装；
 * - 有同版本 seam：adopt 接管（卡片注册不丢失，宿主换代不撤销卡片）；
 * - 有不同版本 seam：conflict，本代宿主保持惰性（不占侧栏、不注册命令），
 *   避免同一 TUI 内两代宿主各渲染一份卡片。
 */
export function createOrAdoptSeam(globalObj: object): SeamHandle {
  const existing = seamOn(globalObj)
  if (existing) {
    if (existing.version !== SEAM_VERSION) {
      return {
        seam: existing,
        adopted: false,
        conflict: true,
        onChange: () => () => {},
      }
    }
    const typed = existing as SidebarSeam & { onChange?: (listener: Listener) => () => void }
    return {
      seam: existing,
      adopted: true,
      conflict: false,
      onChange: typed.onChange ? typed.onChange.bind(typed) : () => () => {},
    }
  }
  const seam = makeSeam()
  installSeam(globalObj, seam)
  return {
    seam,
    adopted: false,
    conflict: false,
    onChange: seam.onChange.bind(seam),
  }
}
