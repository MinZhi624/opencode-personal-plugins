import type { Context } from "@opencode/plugin/tui/context"
import { SessionMetricsService, normalizeMessage } from "./metrics/session-metrics.ts"
import { StepTpsTracker } from "./metrics/step-tps.ts"
import { maybeRefreshPricingSnapshot } from "./metrics/pricing.ts"

export function createV2Metrics(context: Context) {
  const metrics = new SessionMetricsService({
    fetchPage: async ({ sessionID, limit, cursor }) => {
      const result = await context.client.message.list({ sessionID, limit, cursor, order: "asc" })
      return {
        messages: result.data.map(normalizeMessage).filter((item) => item !== null),
        nextCursor: result.cursor.next ?? undefined,
      }
    },
    debounceMs: 120,
    pageSize: 10_000,
    maxPages: 30,
  })
  const tps = new StepTpsTracker()
  void maybeRefreshPricingSnapshot().catch(() => {})
  const unsubs = [
    context.data.on("session.step.started", (event) => {
      tps.handlePartUpdated(event.data.sessionID, {
        id: event.id,
        type: "step-start",
        sessionID: event.data.sessionID,
        messageID: event.data.assistantMessageID,
      }, event.data.started)
    }),
    context.data.on("session.step.ended", (event) => {
      tps.handlePartUpdated(event.data.sessionID, {
        id: event.id,
        type: "step-finish",
        sessionID: event.data.sessionID,
        messageID: event.data.assistantMessageID,
        tokens: event.data.tokens,
      }, event.created)
      metrics.refresh(event.data.sessionID, { delayMs: 150 })
    }),
    context.data.on("session.text.delta", (event) => {
      tps.handlePartDelta(event.data.sessionID, event.data.assistantMessageID, "text", event.data.delta)
    }),
    context.data.on("session.reasoning.delta", (event) => {
      tps.handlePartDelta(event.data.sessionID, event.data.assistantMessageID, "reasoning", event.data.delta)
    }),
    context.data.on("session.execution.succeeded", (event) => {
      tps.abortSession(event.data.sessionID)
      metrics.refresh(event.data.sessionID, { delayMs: 150 })
    }),
    context.data.on("session.execution.interrupted", (event) => {
      tps.abortSession(event.data.sessionID)
      metrics.refresh(event.data.sessionID, { delayMs: 150 })
    }),
    context.data.on("session.execution.failed", (event) => {
      tps.abortSession(event.data.sessionID)
      metrics.refresh(event.data.sessionID, { delayMs: 150 })
    }),
  ]
  return {
    metrics,
    tps,
    dispose() {
      unsubs.forEach((unsubscribe) => unsubscribe())
      metrics.dispose()
    },
  }
}
