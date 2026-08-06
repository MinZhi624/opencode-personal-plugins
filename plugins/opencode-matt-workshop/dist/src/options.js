import { z } from "zod";
export const WORKSHOP_AGENT_IDS = [
    "drafter",
    "foreman",
    "tinker",
    "maker",
    "inspector",
    "archivist",
    "surveyor",
];
const modelSchema = z
    .string()
    .regex(/^[^/\s]+\/[^/\s]+$/, "must use the provider/model format");
const agentRuntimeOptionsSchema = z
    .object({
    model: modelSchema.optional(),
    variant: z.string().min(1).optional(),
    reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).optional(),
    temperature: z.number().min(0).max(2).optional(),
    steps: z.number().int().positive().optional(),
})
    .strict();
const agentOptionsSchema = z
    .object({
    drafter: agentRuntimeOptionsSchema.optional(),
    foreman: agentRuntimeOptionsSchema.optional(),
    tinker: agentRuntimeOptionsSchema.optional(),
    maker: agentRuntimeOptionsSchema.optional(),
    inspector: agentRuntimeOptionsSchema.optional(),
    archivist: agentRuntimeOptionsSchema.optional(),
    surveyor: agentRuntimeOptionsSchema.optional(),
})
    .strict();
const workshopOptionsSchema = z
    .object({
    replace_builtin_agents: z.boolean().default(true),
    max_parallel_makers: z.number().int().min(1).default(3),
    agents: agentOptionsSchema.default({}),
})
    .strict();
export function parseWorkshopOptions(input) {
    const parsed = workshopOptionsSchema.safeParse(input ?? {});
    if (parsed.success)
        return parsed.data;
    const details = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "options"}: ${issue.message}`)
        .join("; ");
    throw new Error(`Invalid opencode-matt-workshop options: ${details}`);
}
//# sourceMappingURL=options.js.map