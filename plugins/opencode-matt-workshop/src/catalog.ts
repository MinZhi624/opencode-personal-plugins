import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { z } from "zod"

const skillRecordSchema = z.object({
  name: z.string().min(1),
  implicitInvocation: z.boolean(),
  command: z.literal(true),
  guardedBy: z.enum(["drafter", "foreman"]).nullable(),
})

const manifestSchema = z.object({
  upstream: z.object({ version: z.string(), tag: z.string(), commit: z.string() }),
  skills: z.array(skillRecordSchema),
})

export type SkillRecord = z.infer<typeof skillRecordSchema>

function manifestPath(): string {
  const candidates = [
    new URL("../skill-manifest.json", import.meta.url),
    new URL("../../skill-manifest.json", import.meta.url),
  ]
  const match = candidates.find((candidate) => existsSync(fileURLToPath(candidate)))
  if (!match) throw new Error("opencode-matt-workshop: skill manifest not found")
  return fileURLToPath(match)
}

export const manifest = manifestSchema.parse(
  JSON.parse(readFileSync(manifestPath(), "utf8")),
)
export const skillNames = manifest.skills.map((skill) => skill.name)
export const skillByName = new Map(manifest.skills.map((skill) => [skill.name, skill]))
