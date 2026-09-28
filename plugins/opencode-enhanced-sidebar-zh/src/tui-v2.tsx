/** @jsxImportSource @opentui/solid */

import "@opentui/solid/preload"
import { Plugin } from "@opencode/plugin/tui"
import { createSignal, For, onCleanup } from "solid-js"
import { QuotaPanel } from "../../opencode-quota-zh/dist/tui-v2.tsx"
import { SkillPanel } from "../../opencode-skill-panel/src/tui-v2.tsx"
import { SessionOverview } from "./tui-v2-session-overview.tsx"
import { createSubagentController, registerSubagentCommands, SubAgentPanel } from "./tui-v2-subagent-magazine.tsx"
import { createV2Metrics } from "./v2-runtime.ts"
import { createSessionCostSummary } from "./metrics/session-cost-summary.ts"
import {
  resolveSidebarCardSettings,
  SIDEBAR_CARD_SETTINGS_KEY,
  uninitializedSidebarCardSettings,
  visibleSidebarCards,
  type SidebarCardID,
  type SidebarCardSettings,
} from "./sidebar-cards.ts"
import { registerSidebarCardCommands } from "./tui-v2-sidebar-card-menu.tsx"

export default Plugin.define({
  id: "opencode-enhanced-sidebar-zh",
  setup(context) {
    const runtime = createV2Metrics(context)
    const subagents = createSubagentController(context, runtime)
    let activeSessionID: string | undefined
    // 卡片顺序与显隐的存档：首次无存档时按旧顺序＋旧启用选项初始化，
    // 菜单保存后以存档为准，不被启动选项覆写（见 resolveSidebarCardSettings）
    const [cardSettings] = context.storage.store<SidebarCardSettings>(SIDEBAR_CARD_SETTINGS_KEY, {
      initial: uninitializedSidebarCardSettings(),
    })
    const cards = () => resolveSidebarCardSettings(cardSettings, context.options)
    function SidebarCards(props: { sessionID: string }) {
      const [tick, setTick] = createSignal(0)
      const timer = setInterval(() => setTick((value) => value + 1), 500)
      onCleanup(() => clearInterval(timer))
      const summary = createSessionCostSummary(context, runtime, () => props.sessionID, tick)
      const renderCard = (id: SidebarCardID) => {
        switch (id) {
          case "quota":
            return <QuotaPanel context={context} sessionID={props.sessionID} />
          case "sessionOverview":
            return <SessionOverview context={context} sessionID={props.sessionID} runtime={runtime} summary={summary} />
          case "subagents":
            return <SubAgentPanel context={context} sessionID={props.sessionID} runtime={runtime} state={subagents.state} update={subagents.update} summary={summary} />
          case "skill":
            return <SkillPanel context={context} sessionID={props.sessionID} maxUsed={context.options.skillPanelMaxUsed} defaultOpen={context.options.skillPanelDefaultOpen} />
        }
      }
      return <box flexDirection="column" gap={1}><For each={visibleSidebarCards(cards())}>{(id) => renderCard(id)}</For></box>
    }
    const disposeSlot = context.ui.slot({
      append: "sidebar.content",
      render: (props) => {
        activeSessionID = props.sessionID
        return <SidebarCards sessionID={props.sessionID} />
      },
    })
    const disposeCommands = registerSubagentCommands(context, () => activeSessionID)
    const disposeCardMenu = registerSidebarCardCommands(context)
    return () => {
      disposeSlot()
      disposeCommands()
      disposeCardMenu()
      subagents.dispose()
      runtime.dispose()
    }
  },
})
