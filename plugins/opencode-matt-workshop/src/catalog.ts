import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { z } from "zod"

// command / guardedBy 是无行为字段（插件不再注册斜杠命令），不再进入 schema；
// 旧 manifest 中残留的这两个键由 zod 默认忽略，来源无法证实时 upstream.commit 允许为 null。
const skillRecordSchema = z.object({
  name: z.string().min(1),
  implicitInvocation: z.boolean(),
})

const manifestSchema = z.object({
  upstream: z.object({ version: z.string(), tag: z.string(), commit: z.string().nullable() }),
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
