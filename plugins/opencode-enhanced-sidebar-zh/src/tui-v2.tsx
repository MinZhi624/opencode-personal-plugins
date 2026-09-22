/** @jsxImportSource @opentui/solid */

import "@opentui/solid/preload"
import { Plugin } from "@opencode/plugin/tui"
import { QuotaPanel } from "../../opencode-quota-zh/dist/tui-v2.tsx"
import { SessionOverview } from "./tui-v2-session-overview.tsx"
import { createSubagentController, registerSubagentCommands, SubAgentPanel } from "./tui-v2-subagent-magazine.tsx"
import { createV2Metrics } from "./v2-runtime.ts"

export default Plugin.define({
  id: "opencode-enhanced-sidebar-zh",
  setup(context) {
    const runtime = createV2Metrics(context)
    const subagents = createSubagentController(context, runtime)
    let activeSessionID: string | undefined
    const disposeSlot = context.ui.slot({
      replace: "sidebar.content",
      render: (props) => {
        activeSessionID = props.sessionID
        return (
        <box flexDirection="column" gap={1}>
          <QuotaPanel context={context} sessionID={props.sessionID} />
          {context.options.sessionOverview !== false
            ? <SessionOverview context={context} sessionID={props.sessionID} runtime={runtime} />
            : null}
          {context.options.subagents !== false
            ? <SubAgentPanel context={context} sessionID={props.sessionID} runtime={runtime} state={subagents.state} update={subagents.update} />
            : null}
        </box>
        )
      },
    })
    const disposeCommands = registerSubagentCommands(context, () => activeSessionID)
    return () => {
      disposeSlot()
      disposeCommands()
      subagents.dispose()
      runtime.dispose()
    }
  },
})
