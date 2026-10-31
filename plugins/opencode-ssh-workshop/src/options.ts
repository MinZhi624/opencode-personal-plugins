import { z } from "zod"

/** 七个 SSH 角色，与 Workshop 原角色一一对应。 */
export const SSH_AGENT_IDS = [
  "ssh-drafter",
  "ssh-tinker",
  "ssh-foreman",
  "ssh-maker",
  "ssh-inspector",
  "ssh-archivist",
  "ssh-surveyor",
] as const

export type SshAgentId = (typeof SSH_AGENT_IDS)[number]

const runtimeOverrideSchema = z
  .object({
    model: z.string().regex(/^[^/\s]+\/[^/\s]+$/).optional(),
    variant: z.string().min(1).optional(),
    temperature: z.number().min(0).max(2).optional(),
    steps: z.number().int().positive().optional(),
  })
  .strict()

const sshOptionsSchema = z
  .object({
    agents: z
      .object({
        "ssh-drafter": runtimeOverrideSchema.optional(),
        "ssh-tinker": runtimeOverrideSchema.optional(),
        "ssh-foreman": runtimeOverrideSchema.optional(),
        "ssh-maker": runtimeOverrideSchema.optional(),
        "ssh-inspector": runtimeOverrideSchema.optional(),
        "ssh-archivist": runtimeOverrideSchema.optional(),
        "ssh-surveyor": runtimeOverrideSchema.optional(),
      })
      .strict()
      .default({}),
    /** 是否自动把成功连接记成设备档案。默认开启。 */
    rememberDevices: z.boolean().default(true),
  })
  .strict()

export type SshAgentOverride = z.infer<typeof runtimeOverrideSchema>
export type SshOptions = z.infer<typeof sshOptionsSchema>

export class SshOptionsError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid opencode-ssh-workshop options: ${issues.join("; ")}`)
    this.name = "SshOptionsError"
  }
}

export function parseSshOptions(input: unknown): SshOptions {
  const parsed = sshOptionsSchema.safeParse(input ?? {})
  if (parsed.success) return parsed.data
  throw new SshOptionsError(
    parsed.error.issues.map((issue) => `${issue.path.join(".") || "options"}: ${issue.message}`),
  )
}
