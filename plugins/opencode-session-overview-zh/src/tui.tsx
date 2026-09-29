/** @jsxImportSource @opentui/solid */
import "@opentui/solid/preload"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { Show } from "solid-js"
import { registerSidebarCard } from "../../opencode-sidebar-host-zh/src/register-card.ts"
import { useSharedSessionData } from "../../opencode-session-data/src/use-session-data.ts"
import { SessionOverview } from "../../opencode-enhanced-sidebar-zh/src/tui-v2-session-overview.tsx"

function OverviewCard(props: { context: Context; sessionID: string }) {
  const data = useSharedSessionData(props.context, "opencode-session-overview-zh", props.sessionID)
  return <Show when={data()} fallback={<text fg={props.context.theme.text.muted}>上下文：共享会话数据不可用</text>}>
    {(handle) => <SessionOverview context={props.context} sessionID={props.sessionID} runtime={handle().runtime} />}
  </Show>
}

export default Plugin.define({
  id: "opencode-session-overview-zh",
  setup(context) {
    const registration = registerSidebarCard({
      id: "sessionOverview", owner: "opencode-session-overview-zh", title: "会话概览",
      render: ({ sessionID }) => <OverviewCard context={context} sessionID={sessionID} />,
      onStatus(status) {
        if (status.state === "rejected") context.ui.toast.show({ title: "会话概览", message: `侧栏注册被拒：${status.code}`, variant: "error" })
      },
    })
    return () => registration.dispose()
  },
})
