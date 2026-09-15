/** @jsxImportSource @opentui/solid */

import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { SessionOverview } from "./session-overview.tsx"
import { acquireSidebarRuntime, claimSidebarBlock } from "./sidebar-runtime.ts"

const id = "opencode-session-overview-zh"

const tui: TuiPlugin = async (api) => {
  const releaseClaim = claimSidebarBlock("session-overview")
  if (!releaseClaim) return
  const runtime = acquireSidebarRuntime(api)

  api.lifecycle.onDispose(() => {
    releaseClaim()
    runtime.release()
  })

  api.slots.register({
    order: 160,
    slots: {
      sidebar_content(_ctx, props) {
        return (
          <SessionOverview
            api={api}
            sessionId={props.session_id}
            metrics={runtime.metrics}
            tps={runtime.tps}
          />
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }
export default plugin
