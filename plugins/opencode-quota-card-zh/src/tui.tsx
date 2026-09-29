/** @jsxImportSource @opentui/solid */

import "@opentui/solid/preload"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { registerSidebarCard } from "../../opencode-sidebar-host-zh/src/register-card.ts"
import { QuotaCard } from "./quota-card.tsx"

/** 所有者＝本插件 id：卸载／撤销只影响自己的注册。 */
const OWNER = "opencode-quota-card-zh"
/** 稳定卡片身份（宿主按它保存排序／显隐，跨重启不变）。 */
const CARD_ID = "quota"
const CARD_TITLE = "额度"

/** 「额度」卡片插件：可独立启停的 TUI 入口。
 *
 * 只做三件事：向侧栏宿主注册卡片、宿主缺席时安全排队、禁用时干净撤回。
 * 明确不做：不自绘侧栏、不回退 replace、不注册命令或槽位（/quota 等命令归
 * opencode-quota-zh 后台插件所有，卡片显隐不影响它们）、不接触任何凭据。
 */
export default Plugin.define({
  id: OWNER,
  setup(context: Context) {
    const registration = registerSidebarCard({
      id: CARD_ID,
      owner: OWNER,
      title: CARD_TITLE,
      render: ({ sessionID }) => <QuotaCard context={context} sessionID={sessionID} />,
      onStatus(status) {
        if (status.state === "registered") return
        context.ui.toast.show({
          title: CARD_TITLE,
          variant: status.state === "queued" ? "warning" : "error",
          message: status.state === "queued" ? "等待侧栏宿主接入（/quota 不受影响）" : `额度卡片注册被拒：${status.code}`,
        })
      },
    })
    return () => registration.dispose()
  },
})
