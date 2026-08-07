import { z } from "zod"

export const WORKSHOP_AGENT_IDS = ["drafter", "foreman", "tinker", "maker", "inspector", "archivist", "surveyor"] as const
const runtime = z.object({ model: z.string().regex(/^[^/\s]+\/[^/\s]+$/).optional(), variant: z.string().min(1).optional(), reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).optional(), temperature: z.number().min(0).max(2).optional(), steps: z.number().int().positive().optional() }).strict()
const agents = z.object(Object.fromEntries(WORKSHOP_AGENT_IDS.map((id) => [id, runtime.optional()]))).strict()
const schema = z.object({ replace_builtin_agents: z.boolean().default(true), max_parallel_makers: z.number().int().min(1).default(3), agents: agents.default({}) }).strict()
export function parseWorkshopOptions(input: unknown) {
  const parsed = schema.safeParse(input ?? {})
  if (parsed.success) return parsed.data
  throw new Error(`Invalid opencode-matt-workshop options: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "options"}: ${issue.message}`).join("; ")}`)
}
