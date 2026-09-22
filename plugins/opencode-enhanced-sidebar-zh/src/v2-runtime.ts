import type { Context } from "@opencode/plugin/tui/context"
import { SessionMetricsService, normalizeMessage } from "./metrics/session-metrics.ts"
import { StepTpsTracker } from "./metrics/step-tps.ts"
import { maybeRefreshPricingSnapshot } from "./metrics/pricing.ts"

/**
 * V2 `GET /api/session/{id}/message` contract (verified against opencode
 * 2.0.11 and 2.0.12):
 * - `limit` must be 1..200 per page — a larger value is rejected with
 *   `400 InvalidRequestError` before any page is returned;
 * - `order` applies to the FIRST page only and must NOT be combined with a
 *   cursor (the server answers `400 Cursor cannot be combined with order`);
 * - `type` filters before pagination and must stay identical while walking
 *   cursors;
 * - the success envelope is `{ data: PublicSessionMessage[], cursor: { next? } }`.
 *
 * The older `limit: 0` "whole session in one response" shortcut is not part of
 * this contract, so the complete history is walked with cursors.
 */
const MESSAGE_PAGE_SIZE = 200
/** 100 pages × 200 messages; beyond that the result is marked incomplete. */
const MESSAGE_MAX_PAGES = 100

export function createV2Metrics(context: Context) {
  const metrics = new SessionMetricsService({
    fetchPage: async ({ sessionID, limit, cursor }) => {
      const result = await context.client.message.list({
        sessionID,
        limit,
        type: "assistant",
        ...(cursor ? { cursor } : { order: "asc" }),
      })
      return {
        messages: result.data.map(normalizeMessage).filter((item) => item !== null),
        nextCursor: result.cursor.next ?? undefined,
      }
    },
    debounceMs: 120,
    pageSize: MESSAGE_PAGE_SIZE,
    maxPages: MESSAGE_MAX_PAGES,
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
