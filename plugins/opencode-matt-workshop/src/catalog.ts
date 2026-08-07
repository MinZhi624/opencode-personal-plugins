import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

export type SkillRecord = {
  name: string
  implicitInvocation: boolean
  command: true
  guardedBy: "drafter" | "foreman" | null
}

type Manifest = { upstream: { version: string; commit: string }; skills: SkillRecord[]; agentSkills: Record<string, string[]> }

function manifestPath() {
  const candidates = [new URL("../skill-manifest.json", import.meta.url), new URL("../../skill-manifest.json", import.meta.url)]
  const match = candidates.find((candidate) => existsSync(fileURLToPath(candidate)))
  if (!match) throw new Error("opencode-matt-workshop: skill manifest not found")
  return fileURLToPath(match)
}

export const manifest = JSON.parse(readFileSync(manifestPath(), "utf8")) as Manifest
export const skillNames = manifest.skills.map((skill) => skill.name)
export const skillByName = new Map(manifest.skills.map((skill) => [skill.name, skill]))
