/**
 * Task tracker — OpenCode V2 server plugin entry.
 *
 * Registers the read-only `snapshot` RPC. The server's own location is the sole
 * source authority: the caller supplies only an optional source preference, and
 * an undefined source performs a local-only detection probe (never a GitHub
 * query, never a git-remote guess). Credentials, `gh` execution and file reads
 * stay server-side; only the sanitised `Snapshot` or a safe `source_unavailable`
 * error crosses the RPC boundary.
 */

import { Plugin } from "@opencode/plugin"
import { taskRpc } from "./src/rpc.ts"
import {
  inferMattSource,
  localSourceKey,
  readGithubSnapshot,
  readLocalSnapshot,
  TaskSourceError,
} from "./src/sources.ts"
import type { Snapshot } from "./src/model.ts"

function resolveProjectKey(location: {
  directory?: string
  project?: { id?: string; canonical?: string }
}): string {
  return location.project?.id || location.project?.canonical || location.directory || "opencode-task-tracker"
}

export default Plugin.define({
  id: "opencode-task-tracker-zh",
  async setup(context) {
    await context.rpc.register(taskRpc, {
      async snapshot(input, call) {
        const directory = context.location.directory
        const projectKey = resolveProjectKey(context.location)
        try {
          // Reliable Matt tracker inference only; a git remote or a stray
          // `.scratch/` is never treated as a configured source.
          const suggestedSource = await inferMattSource(directory, call.signal)

          // Undefined source = detection-only probe. It never queries gh and never
          // treats a probe as a confirmed view; the TUI persists/confirms next.
          if (input.source === undefined) {
            const probe: Snapshot = {
              projectKey,
              source: "local",
              sourceKey: localSourceKey(directory),
              tasks: [],
              complete: true,
              syncedAt: Date.now(),
              ...(suggestedSource ? { suggestedSource } : {}),
            }
            return probe
          }

          const base =
            input.source === "github"
              ? await readGithubSnapshot(directory, projectKey, call.signal)
              : await readLocalSnapshot(directory, projectKey, call.signal)
          const snapshot: Snapshot = suggestedSource ? { ...base, suggestedSource } : base
          return snapshot
        } catch (error) {
          const message =
            error instanceof TaskSourceError ? error.safeMessage : "读取任务来源失败"
          return call.error("source_unavailable", message, { message })
        }
      },
    })
  },
})
