/** @jsxImportSource @opentui/solid */

import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { acquireSidebarRuntime, claimSidebarBlock } from "./sidebar-runtime.ts"
import { createSubAgentSignals } from "./subagent-magazine.tsx"
import { registerSubAgentSettings } from "./subagent-settings.tsx"
import { SubAgentView } from "./subagent-view.tsx"

const id = "opencode-subagent-magazine-zh"

const tui: TuiPlugin = async (api) => {
  const releaseClaim = claimSidebarBlock("subagent-magazine")
  if (!releaseClaim) return
  const runtime = acquireSidebarRuntime(api)
  const signals = createSubAgentSignals(api)
  let currentSessionId = ""
  registerSubAgentSettings(api, signals, () => currentSessionId)

  api.lifecycle.onDispose(() => {
    releaseClaim()
    runtime.release()
  })

  api.slots.register({
    order: 170,
    slots: {
      sidebar_content(_ctx, props) {
        currentSessionId = props.session_id
        return (
          <SubAgentView
            api={api}
            sessionId={props.session_id}
            metrics={runtime.metrics}
            signals={signals}
          />
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }
export default plugin
