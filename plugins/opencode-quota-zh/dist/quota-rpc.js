import { Rpc } from "@opencode/plugin";
import { z } from "zod";
import { QUOTA_SNAPSHOT_STATUSES } from "./lib/quota-sidebar-cards.js";
// The TUI receives structured provider cards and renders them natively; it
// never reconstructs percentages from formatted display text.
const quotaSidebarRowSchema = z.union([
    z.object({
        id: z.string(),
        kind: z.literal("percent"),
        label: z.string(),
        percentRemaining: z.number(),
        resetTimeIso: z.string().optional(),
        right: z.string().optional(),
    }),
    z.object({
        id: z.string(),
        kind: z.literal("value"),
        label: z.string(),
        value: z.string(),
        resetTimeIso: z.string().optional(),
        right: z.string().optional(),
    }),
]);
const quotaSidebarCardSchema = z.object({
    id: z.string(),
    label: z.string(),
    rows: z.array(quotaSidebarRowSchema),
    error: z.string().optional(),
    refreshing: z.boolean(),
    okAtIso: z.string().optional(),
    checkedAtIso: z.string().optional(),
});
// The v6 price list in use, relayed for the session-data price cache: the same
// loaded snapshot the quota report costs with, so `source` tells an empty list
// from a real one. Amounts stay USD per 1M tokens, as in the v6 report.
const pricingCostBucketsSchema = z.object({
    input: z.number().optional(),
    output: z.number().optional(),
    reasoning: z.number().optional(),
    cache_read: z.number().optional(),
    cache_write: z.number().optional(),
});
const pricingSnapshotSchema = z.object({
    _meta: z.object({
        source: z.string(),
        generatedAt: z.number(),
        providers: z.array(z.string()),
        units: z.string(),
    }),
    providers: z.record(z.string(), z.record(z.string(), pricingCostBucketsSchema)),
});
// The price list in use changed for real: another snapshot object, another
// source or another selection. `generatedAt` and `selection` mirror the
// `pricing` route's answer, so a listener can invalidate the costs it already
// displayed without reading anything; the first load announces nothing.
const pricingChangedSchema = z.object({
    generatedAt: z.number(),
    selection: z.enum(["auto", "bundled", "runtime"]),
});
// One session's, or the whole tree's, usage at the report's prices: the five token kinds
// stay apart, reasoning included, so nothing is folded into output and split back out.
// `complete` says the read finished; usage without a price is `partial`, never a silent
// zero and never a truncation. `error` stays unset here: a failed report throws instead
// of answering, so no cost ever carries a fabricated failure or a fabricated success.
const sessionCostSchema = z.object({
    usd: z.number(),
    complete: z.boolean(),
    hasUsage: z.boolean(),
    partial: z.boolean(),
    tokens: z.object({
        input: z.number(),
        output: z.number(),
        reasoning: z.number(),
        cache_read: z.number(),
        cache_write: z.number(),
    }),
    messageCount: z.number(),
    error: z.string().optional(),
});
export const quotaRpc = Rpc.define({
    id: "opencode-quota-zh",
    methods: {
        snapshot: {
            input: z.object({
                sessionID: z.string().optional(),
            }),
            output: z.object({
                // Explicit snapshot status so consumers can tell a disabled quota
                // background from an empty result; card visibility never gates this.
                status: z.enum(QUOTA_SNAPSHOT_STATUSES),
                cards: z.array(quotaSidebarCardSchema),
            }),
        },
        pricing: {
            // No input: the answer is the snapshot already loaded, never a refresh;
            // downloadPrices stays the only way new prices enter.
            input: z.object({}),
            output: z.object({
                snapshot: pricingSnapshotSchema,
                source: z.enum(["runtime", "bundled", "empty"]),
                selection: z.enum(["auto", "bundled", "runtime"]),
            }),
        },
        sessionUsage: {
            // One session tree, straight out of the v6 usage report for that session: the
            // same engine pass, the same price snapshot and the same time point the native
            // usage view reads, so the two cannot drift apart.
            input: z.object({
                sessionID: z.string(),
            }),
            output: z.object({
                sessionID: z.string(),
                // The sessions the report really read, in resolveSessionTree order.
                sessionIDs: z.array(z.string()),
                generatedAtMs: z.number(),
                // The price snapshot the report started with, the same one its cache key used.
                pricingGeneration: z.number(),
                pricingSelection: z.enum(["auto", "bundled", "runtime"]),
                // The requested session's own messages; the tree is every session together.
                own: sessionCostSchema,
                tree: sessionCostSchema,
                bySession: z.record(z.string(), sessionCostSchema),
            }),
        },
    },
    events: {
        pricingChanged: { schema: pricingChangedSchema },
    },
});
