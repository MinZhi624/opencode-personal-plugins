import type { Context } from "@opencode/plugin/tui/context"
import { SessionMetricsService, normalizeMessage } from "./metrics/session-metrics.ts"
import { StepTpsTracker } from "./metrics/step-tps.ts"
import { maybeRefreshPricingSnapshot, pricingSourceRpc } from "./metrics/pricing.ts"
import {
  sessionUsageRpc,
  type SessionUsageReport,
} from "../../opencode-session-data/src/metrics/quota-usage-rpc.ts"

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

/** How long one server RPC read may take before it is given up on. */
const RPC_TIMEOUT_MS = 60_000

/**
 * Where a server RPC read goes and how long it may take: the TUI's OWN folder
 * — never a guessed cwd, so a call can never be routed to another workspace's
 * settings — plus a one-minute budget. Same intent as the quota plugin's own
 * `quotaCallOptions` (v6/tui/client.ts), mirrored here so no client/dist of
 * that plugin is imported.
 *
 * A missing location is a hard error: falling back to cwd would silently read
 * the wrong workspace. The message carries no secrets and no paths.
 */
function serverRpcOptions(context: Context): { location: NonNullable<Context["location"]>; signal: AbortSignal } {
  const location = context.location ?? context.data.location.default()
  if (!location) throw new Error("OpenCode gave the TUI no location")
  return { location, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) }
}

export function createV2Metrics(context: Context) {
  const metrics = new SessionMetricsService({
    // The service prices from ONE source: the v6 usage engine behind the quota
    // plugin's read-only `sessionUsage` RPC (same route id/method as its
    // quotaRpc), mirrored here through session-data's portable definition so
    // this legacy entry keeps working without importing a possibly unbuilt
    // dist. Without this binding the service has no usage source at all and
    // every cost row would fail to load.
    fetchUsage: async (sessionID: string): Promise<SessionUsageReport | null> =>
      (await context.client.rpc(sessionUsageRpc).sessionUsage({ sessionID }, serverRpcOptions(context))) ?? null,
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
  /**
   * Refresh one session and, when it is not the root itself, the root as well:
   * a subagent's step changes the whole task tree's totals, and the tree
   * surfaces read the root's report.
   */
  const refreshWithRoot = (sessionID: string, delayMs = 150) => {
    metrics.refresh(sessionID, { delayMs })
    const root = context.data.session.root(sessionID)
    if (root && root !== sessionID) metrics.refresh(root, { delayMs })
  }
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
      refreshWithRoot(event.data.sessionID)
    }),
    context.data.on("session.text.delta", (event) => {
      tps.handlePartDelta(event.data.sessionID, event.data.assistantMessageID, "text", event.data.delta)
    }),
    context.data.on("session.reasoning.delta", (event) => {
      tps.handlePartDelta(event.data.sessionID, event.data.assistantMessageID, "reasoning", event.data.delta)
    }),
    context.data.on("session.execution.succeeded", (event) => {
      tps.abortSession(event.data.sessionID)
      refreshWithRoot(event.data.sessionID)
    }),
    context.data.on("session.execution.interrupted", (event) => {
      tps.abortSession(event.data.sessionID)
      refreshWithRoot(event.data.sessionID)
    }),
    context.data.on("session.execution.failed", (event) => {
      tps.abortSession(event.data.sessionID)
      refreshWithRoot(event.data.sessionID)
    }),
    // A REAL price change (another snapshot object, source or selection)
    // makes every cached amount suspect, so the service drops its caches and
    // re-requests what it tracks. Only the event definition is imported here:
    // the quota plugin stays the sole owner of pricing data, this runtime just
    // listens. `dispose` drops the subscription again.
    context.client.rpc(pricingSourceRpc).events.on("pricingChanged", () => {
      metrics.refreshForPricingChange()
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
