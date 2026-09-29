/**
 * 卡片侧的最小接入辅助：在组件 setup 中 acquire 共享数据，随组件卸载释放，
 * 数据模块销毁时自动按新 seam 重新接入（热重载）或明确变为不可用。
 *
 * 用法（卡片插件）：
 * ```tsx
 * const data = useSharedSessionData(context, "opencode-session-overview-zh")
 * // data() 为 undefined 表示共享数据缺席：显示“不可用”，不要自建运行时
 * const summary = data()?.createSummary(context, () => props.sessionID, tick)
 * ```
 */
import { createSignal, onCleanup } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import { acquireSessionData, type SessionDataHandle } from "./seam.ts"

export function useSharedSessionData(
  context: Context,
  consumer?: string,
  sessionID?: string,
): () => SessionDataHandle | undefined {
  const [handle, setHandle] = createSignal<SessionDataHandle | undefined>(
    acquireSessionData(context, sessionID, consumer),
  )
  let current = handle()
  let unsubscribeDispose: (() => void) | undefined

  function watch(next: SessionDataHandle | undefined): void {
    unsubscribeDispose?.()
    unsubscribeDispose = undefined
    current = next
    setHandle(next)
    if (!next) return
    unsubscribeDispose = next.onDispose(() => {
      // 运行时被销毁（数据模块卸载或换代）：释放旧句柄并尝试重新接入。
      current?.release()
      current = undefined
      unsubscribeDispose = undefined
      const again = acquireSessionData(context, sessionID, consumer)
      if (again) watch(again)
      else setHandle(undefined)
    })
  }

  watch(current)
  // 数据插件可在卡片已经挂载之后才启用；缺席时定期尝试接入，
  // 不能把首次的 unavailable 固化到该卡片实例。
  const retry = setInterval(() => {
    if (!current) {
      const next = acquireSessionData(context, sessionID, consumer)
      if (next) watch(next)
    }
  }, 500)
  onCleanup(() => {
    clearInterval(retry)
    unsubscribeDispose?.()
    current?.release()
    current = undefined
  })
  return handle
}
