/** @jsxImportSource @opentui/solid */

import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { SessionOverview } from "./session-overview.tsx"
import { acquireSidebarRuntime, claimSidebarBlock } from "./sidebar-runtime.ts"
import { SubAgentView } from "./subagent-view.tsx"

/** Legacy aggregate entry retained for existing user configurations. */
const id = "opencode-enhanced-sidebar-zh"

const tui: TuiPlugin = async (api) => {
  const releaseOverview = claimSidebarBlock("session-overview")
  const releaseSubagents = claimSidebarBlock("subagent-magazine")
  if (!releaseOverview && !releaseSubagents) return
  const runtime = acquireSidebarRuntime(api)

  api.lifecycle.onDispose(() => {
    releaseOverview?.()
    releaseSubagents?.()
    runtime.release()
  })

  api.slots.register({
    order: 60,
    slots: {
      sidebar_content(_ctx, props) {
        return (
          <box gap={1}>
            {releaseOverview ? (
              <SessionOverview
                api={api}
                sessionId={props.session_id}
                metrics={runtime.metrics}
                tps={runtime.tps}
              />
            ) : null}
            {releaseSubagents ? (
              <SubAgentView
                api={api}
                sessionId={props.session_id}
                metrics={runtime.metrics}
              />
            ) : null}
          </box>
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }
export default plugin
