import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import {
  SessionMetricsService,
  createClientPageFetcher,
  type SessionMessagesClientLike,
} from "./metrics/session-metrics.ts"
import { StepTpsTracker } from "./metrics/step-tps.ts"
import { maybeRefreshPricingSnapshot } from "./metrics/pricing.ts"

export type SidebarBlock = "session-overview" | "subagent-magazine"

export interface SidebarRuntime {
  metrics: SessionMetricsService
  tps: StepTpsTracker
  release(): void
}

type RuntimeRecord = {
  metrics: SessionMetricsService
  tps: StepTpsTracker
  refs: number
  dispose(): void
}

let runtime: RuntimeRecord | undefined
const claimedBlocks = new Set<SidebarBlock>()

function createRuntime(api: TuiPluginApi): RuntimeRecord {
  const metrics = new SessionMetricsService({
    fetchPage: createClientPageFetcher(api.client as unknown as SessionMessagesClientLike),
    debounceMs: 120,
    pageSize: 10000,
    maxPages: 30,
  })
  const tps = new StepTpsTracker()

  void maybeRefreshPricingSnapshot().catch(() => {})

  const unsubPart = api.event.on("message.part.updated", (event) => {
    tps.handlePartUpdated(event.properties.sessionID, event.properties.part, event.properties.time)
    if (event.properties.part.type === "step-finish") metrics.refresh(event.properties.sessionID)
  })
  const unsubDelta = api.event.on("message.part.delta", (event) => {
    tps.handlePartDelta(
      event.properties.sessionID,
      event.properties.messageID,
      event.properties.field,
      event.properties.delta,
    )
  })
  const unsubMessage = api.event.on("message.updated", (event) => {
    metrics.refresh(event.properties.sessionID)
  })
  const unsubRemoved = api.event.on("message.removed", (event) => {
    metrics.refresh(event.properties.sessionID)
  })
  const unsubIdle = api.event.on("session.idle", (event) => {
    tps.abortSession(event.properties.sessionID)
    metrics.refresh(event.properties.sessionID, { delayMs: 150 })
  })
  const unsubError = api.event.on("session.error", (event) => {
    const sessionID = event.properties.sessionID
    tps.abortSession(sessionID)
    if (sessionID) metrics.refresh(sessionID, { delayMs: 150 })
  })

  return {
    metrics,
    tps,
    refs: 0,
    dispose() {
      unsubPart()
      unsubDelta()
      unsubMessage()
      unsubRemoved()
      unsubIdle()
      unsubError()
      metrics.dispose()
    },
  }
}

export function acquireSidebarRuntime(api: TuiPluginApi): SidebarRuntime {
  if (!runtime) runtime = createRuntime(api)
  const current = runtime
  current.refs += 1
  let released = false

  return {
    metrics: current.metrics,
    tps: current.tps,
    release() {
      if (released) return
      released = true
      current.refs -= 1
      if (current.refs > 0 || runtime !== current) return
      current.dispose()
      runtime = undefined
    },
  }
}

/** Prevent the legacy aggregate entry and split entries from rendering a block twice. */
export function claimSidebarBlock(block: SidebarBlock): (() => void) | null {
  if (claimedBlocks.has(block)) return null
  claimedBlocks.add(block)
  let released = false
  return () => {
    if (released) return
    released = true
    claimedBlocks.delete(block)
  }
}
