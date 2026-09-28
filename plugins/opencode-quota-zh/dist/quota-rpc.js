import { Rpc } from "@opencode/plugin";
import { z } from "zod";
import { QUOTA_DIALOG_COMMANDS } from "./lib/quota-dialog-commands.js";
import { QUOTA_SNAPSHOT_STATUSES } from "./lib/quota-sidebar-cards.js";
const commandIDSchema = z.enum(QUOTA_DIALOG_COMMANDS.map((command) => command.id));
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
                suppressPartialErrorsOverride: z.boolean().optional(),
            }),
            output: z.object({
                // Explicit snapshot status so consumers can tell a disabled quota
                // background from an empty result; card visibility never gates this.
                status: z.enum(QUOTA_SNAPSHOT_STATUSES),
                cards: z.array(quotaSidebarCardSchema),
            }),
        },
        settings: {
            input: z.object({}),
            output: z.object({
                suppressPartialErrors: z.boolean(),
            }),
        },
        command: {
            input: z.object({
                command: commandIDSchema,
                arguments: z.string().optional(),
                sessionID: z.string().optional(),
            }),
            output: z.discriminatedUnion("state", [
                z.object({
                    state: z.literal("output"),
                    command: commandIDSchema,
                    title: z.string(),
                    output: z.string(),
                    dialogSize: z.enum(["medium", "large", "xlarge"]),
                }),
                z.object({
                    state: z.literal("noop"),
                    command: commandIDSchema,
                    reason: z.literal("disabled"),
                }),
            ]),
        },
    },
    events: {},
});
