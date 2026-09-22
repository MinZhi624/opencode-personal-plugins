import { Rpc } from "@opencode/plugin";
import { z } from "zod";
// The TUI receives structured provider cards and renders them natively; it
// never reconstructs percentages from formatted display text.
const quotaSidebarRowSchema = z.union([
    z.object({
        kind: z.literal("percent"),
        label: z.string(),
        percentRemaining: z.number(),
        resetTimeIso: z.string().optional(),
        right: z.string().optional(),
    }),
    z.object({
        kind: z.literal("value"),
        label: z.string(),
        value: z.string(),
        resetTimeIso: z.string().optional(),
        right: z.string().optional(),
    }),
]);
const quotaSidebarCardSchema = z.object({
    label: z.string(),
    rows: z.array(quotaSidebarRowSchema),
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
                cards: z.array(quotaSidebarCardSchema),
            }),
        },
    },
    events: {},
});
