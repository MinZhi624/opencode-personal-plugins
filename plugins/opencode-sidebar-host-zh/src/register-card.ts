/**
 * 第三方卡片插件的消费者侧注册助手（宿主包公开 Interface）。
 *
 * 卡片插件只需从宿主包导入本模块，不需要知道 Seam 的锚点细节，也不需要镜像契约：
 *
 *   import { registerSidebarCard } from "opencode-sidebar-host-zh/card"
 *   // 或高层工厂：
 *   import { defineSidebarCardPlugin } from "opencode-sidebar-host-zh/card"
 *
 * 本模块封装了原型 S1 验证过、正式契约固化的全部卸载语义：
 * - 宿主已在（同版本）：直接 register，保留 revoke 句柄；
 * - 宿主缺席：进待接单队列（queuePending），宿主后到由它 drain；
 * - 注册被拒（duplicate-id / incompatible-version）：确定性失败，绝不自绘侧栏；
 * - dispose()：撤销自身注册（revoke + revokeOwner 兜底，覆盖“排队后由宿主代注册”
 *   拿不到句柄的路径）、撤回排队请求（withdrawPending，防止宿主后到时“复活”）、
 *   调用卡片自己的 dispose。幂等，可安全放在 setup 返回的 cleanup 里。
 *
 * 注意：宿主与卡片可能各持一份本模块拷贝（独立安装），但两边的 Seam 实例经
 * globalThis[Symbol.for(...)] 收敛到同一对象，因此撤销与撤回对宿主一定可见。
 */

import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import {
  SEAM_VERSION,
  pendingQueue,
  queuePending,
  seamOn,
  withdrawPending,
  type CardInput,
  type CardSpec,
  type RegisterFailureCode,
} from "./seam.ts"

export { SEAM_VERSION }
export type { CardInput, CardSpec, RegisterFailureCode }

export type CardRegistrationState = "registered" | "queued" | "rejected"

export interface CardRegistrationStatus {
  readonly state: CardRegistrationState
  /** state === "registered" 时的注册代数（同一 owner 换代从 1 起）。 */
  readonly generation?: number
  /** state === "rejected" 时的确定性错误码。 */
  readonly code?: RegisterFailureCode
  readonly message?: string
}

export interface RegisterSidebarCardInput {
  /** 稳定、带命名空间的卡片身份，如 "vendor.my-card"。排序设置按它保存。 */
  readonly id: string
  /** 所有者：通常填本插件 id。撤销只影响自己的注册。 */
  readonly owner: string
  readonly title: string
  /** 声明所需的 Interface 版本；缺省为当前 SEAM_VERSION。 */
  readonly requiredSeam?: number
  /** 卡片自己的可交互 TUI 展示（Solid/OpenTUI 组件或渲染函数）。 */
  readonly render: (input: CardInput) => unknown
  /** 注册被撤销（含换代）时的卡片侧清理。 */
  readonly dispose?: () => void
  /** 状态回调：便于卡片在自己的 UI／命令里展示“已接入／排队中／被拒绝”。 */
  readonly onStatus?: (status: CardRegistrationStatus) => void
}

export interface SidebarCardRegistration {
  /** 当前注册状态（可重复调用）。 */
  readonly status: () => CardRegistrationStatus
  /** 只撤销这一条注册（不影响排队请求；通常不需要单独调用）。 */
  readonly revoke: () => void
  /**
   * 卡片 setup cleanup 调用的完整回收：撤销注册（含所有者兜底）、撤回排队请求、
   * 调用卡片侧 dispose。幂等；重复调用是安全的。
   */
  readonly dispose: () => void
}

function requireText(value: string | undefined, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`registerSidebarCard 需要非空 ${field}`)
  }
  return value
}

/**
 * 低层注册入口：在卡片插件 setup 里调用，返回的 registration 用于 cleanup。
 * 同步完成（不返回 Promise）：Seam 是内存对象，没有需要等待的 IO。
 */
export function registerSidebarCard(input: RegisterSidebarCardInput): SidebarCardRegistration {
  const id = requireText(input.id, "id")
  const owner = requireText(input.owner, "owner")
  const title = requireText(input.title, "title")
  const spec: CardSpec = {
    id,
    owner,
    title,
    requiredSeam: input.requiredSeam ?? SEAM_VERSION,
    render: input.render,
    dispose: input.dispose,
  }

  let current: CardRegistrationStatus = { state: "queued" }
  let revoke: (() => void) | undefined
  let disposed = false

  function setStatus(status: CardRegistrationStatus) {
    current = status
    input.onStatus?.(status)
  }

  const seam = seamOn(globalThis)
  if (seam) {
    const result = seam.register(spec)
    if (result.ok) {
      revoke = result.revoke
      setStatus({ state: "registered", generation: result.generation })
    } else {
      // 宿主在场但拒绝：确定性失败，不排队（排队给不兼容的宿主没有意义），
      // 由卡片自行展示不可用状态；诊断已由宿主记录。
      const failed = result as { code: RegisterFailureCode; message: string }
      setStatus({ state: "rejected", code: failed.code, message: failed.message })
    }
  } else {
    // 宿主缺席：排队等待接入，绝不回退自绘侧栏
    queuePending(globalThis, spec)
    setStatus({ state: "queued" })
  }

  return {
    status: () => current,
    revoke: () => {
      revoke?.()
      revoke = undefined
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      revoke?.()
      revoke = undefined
      // 排队后由宿主代为注册的路径拿不到 revoke 句柄：按所有者兜底撤销，只影响自己
      const active = seamOn(globalThis)
      // 旧代迟到的 cleanup 不可误撤同 owner 新代；只撤自己的 spec。
      if (active?.list().some((record) => record.spec === spec)) active.revokeOwner(owner)
      // 排队请求随卡片禁用一并撤回，宿主后到不得“复活”已禁用卡片
      withdrawPending(globalThis, spec)
      try {
        spec.dispose?.()
      } catch {
        // 卡片侧清理抛错不得阻断宿主与其他卡片的回收
      }
    },
  }
}

export interface SidebarCardDefinition {
  /** 卡片插件 id（同时作为注册的 owner）。 */
  readonly id: string
  /** 稳定、带命名空间的卡片身份，如 "vendor.my-card"。 */
  readonly cardID: string
  readonly title: string
  /** 声明所需的 Interface 版本；缺省为当前 SEAM_VERSION。 */
  readonly requiredSeam?: number
  /** 卡片自己的可交互 TUI 展示。 */
  readonly render: (input: CardInput) => unknown
  /** 卡片自有能力（命令、订阅、存储等）的 setup；返回 cleanup。 */
  readonly setup?: (context: Context) => (() => void) | void
  /** 注册被撤销（含换代）时的卡片侧清理。 */
  readonly dispose?: () => void
}

/**
 * 高层工厂：用一份声明直接产出可安装的 TUI 插件定义。
 * 适合只需要“一张卡 + 少量自有命令／订阅”的第三方卡片：
 *
 *   export default defineSidebarCardPlugin({
 *     id: "my-sidebar-card",
 *     cardID: "vendor.my-card",
 *     title: "我的卡片",
 *     render: (input) => <MyCard sessionID={input.sessionID} />,
 *     setup: (context) => registerMyCommands(context),
 *   })
 */
export function defineSidebarCardPlugin(definition: SidebarCardDefinition) {
  return Plugin.define({
    id: definition.id,
    setup(context: Context) {
      const registration = registerSidebarCard({
        id: definition.cardID,
        owner: definition.id,
        title: definition.title,
        requiredSeam: definition.requiredSeam,
        render: definition.render,
        dispose: definition.dispose,
        onStatus: (status) => {
          if (status.state === "registered") {
            context.ui.toast.show({
              title: definition.title,
              message: `已接入侧栏宿主（第 ${status.generation ?? 1} 代）`,
              variant: "success",
            })
          } else if (status.state === "queued") {
            context.ui.toast.show({
              title: definition.title,
              message: "未发现侧栏宿主，已排队等待接入（不会自绘侧栏）",
              variant: "warning",
            })
          } else {
            context.ui.toast.show({
              title: definition.title,
              message: `注册被拒绝：${status.code ?? "unknown"}${status.message ? `（${status.message}）` : ""}`,
              variant: "error",
              duration: 8000,
            })
          }
        },
      })
      const extra = definition.setup?.(context)
      return () => {
        if (typeof extra === "function") extra()
        registration.dispose()
      }
    },
  })
}

/** 待接单队列当前长度（卡片侧诊断用；宿主 setup 时会 drain 清空）。 */
export function pendingCardCount(): number {
  return pendingQueue(globalThis).length
}
