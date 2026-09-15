/** @jsxImportSource @opentui/solid */

import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { acquireSidebarRuntime, claimSidebarBlock } from "./sidebar-runtime.ts"
import { SubAgentView } from "./subagent-view.tsx"

const id = "opencode-subagent-magazine-zh"

const tui: TuiPlugin = async (api) => {
  const releaseClaim = claimSidebarBlock("subagent-magazine")
  if (!releaseClaim) return
  const runtime = acquireSidebarRuntime(api)

  api.lifecycle.onDispose(() => {
    releaseClaim()
    runtime.release()
  })

  api.slots.register({
    order: 170,
    slots: {
      sidebar_content(_ctx, props) {
        return (
          <SubAgentView
            api={api}
            sessionId={props.session_id}
            metrics={runtime.metrics}
          />
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }
export default plugin
