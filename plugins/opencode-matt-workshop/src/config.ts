import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

function skillsPath(): string {
  const candidates = [new URL("../skills", import.meta.url), new URL("../../skills", import.meta.url)]
  const match = candidates.map((path) => fileURLToPath(path)).find(existsSync)
  if (!match) throw new Error("opencode-matt-workshop: adapted skills directory not found")
  return match
}

export const WORKSHOP_SKILLS_PATH = skillsPath()
