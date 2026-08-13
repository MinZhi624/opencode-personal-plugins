import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Config } from "@opencode-ai/plugin"
import { buildWorkshopAgents } from "./agents.js"
import { buildWorkshopCommands } from "./commands.js"
import type { WorkshopOptions } from "./options.js"

function skillsPath(): string {
  const candidates = [new URL("../skills", import.meta.url), new URL("../../skills", import.meta.url)]
  const match = candidates.map((path) => fileURLToPath(path)).find(existsSync)
  if (!match) throw new Error("opencode-matt-workshop: adapted skills directory not found")
  return match
}

export const WORKSHOP_SKILLS_PATH = skillsPath()

export function applyWorkshopConfig(config: Config, options: WorkshopOptions): void {
  const rawSkills = Reflect.get(config, "skills")
  const skills =
    typeof rawSkills === "object" && rawSkills !== null
      ? rawSkills
      : {}
  const rawPaths = Reflect.get(skills, "paths")
  const paths = Array.isArray(rawPaths)
    ? rawPaths.filter((path): path is string => typeof path === "string")
    : []
  if (!paths.includes(WORKSHOP_SKILLS_PATH)) {
    Reflect.set(skills, "paths", [...paths, WORKSHOP_SKILLS_PATH])
  }
  Reflect.set(config, "skills", skills)
  config.command = { ...config.command, ...buildWorkshopCommands() }
  config.agent = { ...config.agent, ...buildWorkshopAgents(options) }
  Reflect.set(config, "default_agent", "tinker")
}
