/** @jsxImportSource @opentui/solid */

import "@opentui/solid/preload"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { installSessionDataSeam } from "./seam.ts"

/**
 * 共享会话数据模块（独立于侧栏宿主与任一业务卡片）。
 *
 * 拥有每个 TUI 实例一份的统计运行时（消息分页聚合、费用／Token 口径、TPS），
 * 通过版本化 globalThis seam 供卡片消费；自身不渲染任何侧栏内容。
 * 禁用本插件时，消费者通过 seam 缺席明确显示“数据不可用”。
 */
export default Plugin.define({
  id: "opencode-session-data",
  setup(context) {
    const installed = installSessionDataSeam(globalThis, context)
    // 脱敏状态（仅计数，不含会话 ID／内容）：用于人工验收时确认同一作用域
    // 只有一份运行时与一套监听。
    const disposeStatus = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "opencode-session-data.status",
              title: "共享会话数据：状态（脱敏计数）",
              group: "侧栏",
              palette: true,
              slash: { name: "session-data-status" },
              run: () => {
                const seam = installed.seam
                context.ui.toast.show({
                  title: "共享会话数据",
                  message: [
                    `seam v${seam.version}${installed.adopted ? "（已接管现有运行时）" : ""}`,
                    `消费者 ${seam.consumers()}`,
                    `监听 ${seam.runtime.armed ? "已挂载" : "空闲"}`,
                    `缓存会话 ${seam.runtime.metrics.cachedSessions()}`,
                  ].join(" · "),
                  variant: "info",
                  duration: 8000,
                })
              },
            },
          ],
        }))
        return null
      },
    })
    return () => {
      disposeStatus()
      installed.dispose()
    }
  },
})
