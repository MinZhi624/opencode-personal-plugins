import { z } from "zod"

export const WORKSHOP_AGENT_IDS = [
  "drafter",
  "tinker",
  "foreman",
  "maker",
  "inspector",
  "archivist",
  "surveyor",
] as const

const runtimeOverrideSchema = z
  .object({
    model: z.string().regex(/^[^/\s]+\/[^/\s]+$/).optional(),
    variant: z.string().min(1).optional(),
    temperature: z.number().min(0).max(2).optional(),
    steps: z.number().int().positive().optional(),
  })
  .strict()

const workshopOptionsSchema = z
  .object({
    agents: z
      .object({
        drafter: runtimeOverrideSchema.optional(),
        tinker: runtimeOverrideSchema.optional(),
        foreman: runtimeOverrideSchema.optional(),
        maker: runtimeOverrideSchema.optional(),
        inspector: runtimeOverrideSchema.optional(),
        archivist: runtimeOverrideSchema.optional(),
        surveyor: runtimeOverrideSchema.optional(),
      })
      .strict()
      .default({}),
  })
  .strict()

export type AgentRuntimeOverride = z.infer<typeof runtimeOverrideSchema>
export type WorkshopOptions = z.infer<typeof workshopOptionsSchema>

export class WorkshopOptionsError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid opencode-matt-workshop options: ${issues.join("; ")}`)
    this.name = "WorkshopOptionsError"
  }
}

export function parseWorkshopOptions(input: unknown): WorkshopOptions {
  const parsed = workshopOptionsSchema.safeParse(input ?? {})
  if (parsed.success) return parsed.data
  throw new WorkshopOptionsError(
    parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "options"}: ${issue.message}`,
    ),
  )
}
