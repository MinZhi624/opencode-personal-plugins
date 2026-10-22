/** @jsxImportSource @opentui/solid */

import "@opentui/solid/preload"
import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { registerSidebarCard } from "../../opencode-sidebar-host-zh/src/register-card.ts"
import { registerTimelineCardControls } from "./card-controls.ts"
import { readTimelineOptions } from "./timeline-options.ts"
import { MaskVeil, TimelinePanel, type MaskControl, type MaskState } from "./timeline-panel.tsx"

/**
 * 用户节点卡片。
 *
 * 本插件只注册侧栏卡片，不再自己 append sidebar.content；显隐与顺序由宿主
 * 的 /sidebar-cards 与 cli.json 单一拥有。app slot 只负责定位遮罩。
 */
export default Plugin.define({
  id: "opencode-user-timeline-zh",
  setup(context) {
    const [options, setOptions] = createSignal(readTimelineOptions(context.options))

    // 遮盖层状态（内存态，重启即弃），配合 app 级 slot 渲染全屏定位遮罩。
    const [mask, setMask] = context.storage.memory("mask", {
      initial: { show: false, preview: "" } as MaskState,
    })
    let maskShownAt = 0
    let maskToken = 0
    const maskControl: MaskControl = {
      show(preview) {
        maskShownAt = Date.now()
        maskToken++
        setMask((draft) => {
          draft.show = true
          draft.preview = preview
        })
      },
      async drop() {
        if (!mask.show) return
        const token = maskToken
        // 最短显示 800ms：加载太快时视觉上也是"有内容的定位中"，而不是残影。
        const remain = 800 - (Date.now() - maskShownAt)
        if (remain > 0) await new Promise((resolve) => setTimeout(resolve, remain))
        // 旧一次定位的收尾不得摘掉新一次定位已经亮起的遮罩。
        if (token !== maskToken) return
        setMask((draft) => {
          draft.show = false
        })
      },
    }

    const unbind = context.ui.slot({
      append: "app",
      render: () => <MaskVeil context={context} mask={mask} />,
    })

    const registration = registerSidebarCard({
      id: "timeline",
      owner: "opencode-user-timeline-zh",
      title: "用户节点",
      render: ({ sessionID }) => (
        <TimelinePanel context={context} sessionID={sessionID} options={options} mask={maskControl} />
      ),
    })

    // 展示设置随插件 setup 注册、cleanup 撤销：卡片被隐藏时统一窗口仍可设置。
    const disposeControls = registerTimelineCardControls(context, (saved) => setOptions(saved))

    return () => {
      disposeControls()
      registration.dispose()
      unbind()
    }
  },
})
