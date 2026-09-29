/** @jsxImportSource @opentui/solid */
import "@opentui/solid/preload"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { Show } from "solid-js"
import { registerSidebarCard } from "../../opencode-sidebar-host-zh/src/register-card.ts"
import { useSharedSessionData } from "../../opencode-session-data/src/use-session-data.ts"
import { createSubagentController, registerSubagentCommands, SubAgentPanel } from "../../opencode-enhanced-sidebar-zh/src/tui-v2-subagent-magazine.tsx"

function MagazineCard(props: { context: Context; sessionID: string; controller: ReturnType<typeof createSubagentController> }) {
  const data = useSharedSessionData(props.context, "opencode-subagent-card-zh", props.sessionID)
  return <Show when={data()} fallback={<SubAgentPanel context={props.context} sessionID={props.sessionID} state={props.controller.state} update={props.controller.update} />}>
    {(handle) => <SubAgentPanel context={props.context} sessionID={props.sessionID} runtime={handle().runtime} state={props.controller.state} update={props.controller.update} />}
  </Show>
}

export default Plugin.define({
  id: "opencode-subagent-card-zh",
  setup(context) {
    // 子代理的私有记录与交互不由概览持有，也不由卡片显隐控制。
    const controller = createSubagentController(context)
    let activeSessionID: string | undefined
    const registration = registerSidebarCard({
      id: "subagents", owner: "opencode-subagent-card-zh", title: "子代理",
      render: ({ sessionID }) => {
        activeSessionID = sessionID
        return <MagazineCard context={context} sessionID={sessionID} controller={controller} />
      },
      onStatus(status) {
        if (status.state === "rejected") context.ui.toast.show({ title: "子代理", message: `侧栏注册被拒：${status.code}`, variant: "error" })
      },
    })
    const disposeCommands = registerSubagentCommands(context, () => activeSessionID)
    return () => { registration.dispose(); disposeCommands(); controller.dispose() }
  },
})
