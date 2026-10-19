/**
 * Portable client-side mirror of the quota plugin's `sessionUsage` RPC route.
 *
 * The server side (opencode-quota-zh) walks ONE usage report per request —
 * fork-copy deduplication, compaction usage, every descendant session and the
 * real v6 model/price resolver — and answers with that single report: the
 * requested session's own cost, the whole session tree, and every session of
 * the tree, all at one data time point and one price snapshot. Reusing that
 * report is what keeps the sidebar consistent with the v6 usage console; a
 * second, look-alike aggregation on this side would drift from it.
 *
 * This definition exists purely as a typed read-only client caller. It uses
 * the same route id ("opencode-quota-zh") and method name as the quota
 * plugin's own RPC, so `client.rpc(sessionUsageRpc).sessionUsage(...)`
 * addresses that handler without importing its (possibly unbuilt) dist and
 * without a build coupling between the two plugins. The zod schemas mirror
 * the server contract exactly, so a payload that does not match fails the
 * call instead of being reinterpreted here.
 *
 * Cost semantics travel as the engine computed them: `complete` says the read
 * behind the numbers finished, `hasUsage` separates a real empty session from
 * a failed one, `partial` marks usage that carries no price (its tokens are
 * still counted), and the five token kinds stay apart, reasoning included.
 */

import { Rpc } from "@opencode/plugin"
import { z } from "zod"

const sessionUsageTokensSchema = z.object({
  input: z.number(),
  output: z.number(),
  reasoning: z.number(),
  cache_read: z.number(),
  cache_write: z.number(),
})

const sessionUsageCostSchema = z.object({
  usd: z.number(),
  complete: z.boolean(),
  hasUsage: z.boolean(),
  partial: z.boolean(),
  tokens: sessionUsageTokensSchema,
  messageCount: z.number(),
  error: z.string().optional(),
})

const sessionUsageOutputSchema = z.object({
  sessionID: z.string(),
  /** Every session the report really read, the requested one included. */
  sessionIDs: z.array(z.string()),
  generatedAtMs: z.number(),
  /** The price snapshot generation that priced every number below. */
  pricingGeneration: z.number(),
  pricingSelection: z.enum(["auto", "bundled", "runtime"]),
  /** The requested session's own messages, its subagents left out. */
  own: sessionUsageCostSchema,
  /** The whole tree together, at the report's own totals. */
  tree: sessionUsageCostSchema,
  bySession: z.record(z.string(), sessionUsageCostSchema),
})

/**
 * Portable mirror of the quota plugin's `sessionUsage` route. One request per
 * session; the answer is the session-tree report described above.
 */
export const sessionUsageRpc = Rpc.define({
  id: "opencode-quota-zh",
  methods: {
    sessionUsage: {
      input: z.object({ sessionID: z.string() }),
      output: sessionUsageOutputSchema,
    },
  },
  events: {},
})

/** One session's, or a whole tree's, usage at the report's prices. */
export type SessionUsageCost = z.infer<typeof sessionUsageCostSchema>

/** One session-tree report from the v6 usage engine. */
export type SessionUsageReport = z.infer<typeof sessionUsageOutputSchema>
