import { Plugin } from "@opencode/plugin"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { manifest } from "./catalog.js"
import { buildWorkshopAgents } from "./agents.js"
import { WORKSHOP_SKILLS_PATH } from "./config.js"
import { parseWorkshopOptions } from "./options.js"

function permissions(value: Record<string, unknown>) {
  const result: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }> = []
  const actionNames: Record<string, string | undefined> = {
    bash: "shell",
    task: "subagent",
    todowrite: undefined,
    list: undefined,
    lsp: undefined,
  }
  for (const [legacyAction, rule] of Object.entries(value)) {
    const action = legacyAction in actionNames ? actionNames[legacyAction] : legacyAction
    if (!action) continue
    if (rule === "allow" || rule === "deny" || rule === "ask") {
      result.push({ action, resource: "*", effect: rule })
      continue
    }
    if (!rule || typeof rule !== "object") continue
    for (const [resource, effect] of Object.entries(rule)) {
      if (effect === "allow" || effect === "deny" || effect === "ask") result.push({ action, resource, effect })
    }
  }
  return result
}

export default Plugin.define({
  id: "opencode-matt-workshop",
  async setup(context) {
    const definitions = buildWorkshopAgents(parseWorkshopOptions(context.options)) as Record<string, Record<string, any>>
    await context.agent.transform((editor) => {
      for (const [id, definition] of Object.entries(definitions)) {
        editor.update(id, (agent) => {
          agent.description = definition.description
          agent.mode = definition.mode
          agent.hidden = definition.hidden ?? false
          agent.color = definition.color
          agent.steps = definition.steps
          agent.system = definition.prompt
          agent.permissions = permissions(definition.permission ?? {})
          if (typeof definition.model === "string") {
            const [providerID, ...model] = definition.model.split("/")
            agent.model = {
              providerID,
              id: model.join("/"),
              ...(definition.variant ? { variant: definition.variant } : {}),
            } as unknown as typeof agent.model
          }
        })
      }
      editor.default("tinker" as never)
    })

    const skills = await Promise.all(manifest.skills.map(async (item) => {
      const path = join(WORKSHOP_SKILLS_PATH, item.name, "SKILL.md")
      const content = await readFile(path, "utf8")
      const description = content.match(/^---\r?\n[\s\S]*?^description:\s*(.+)$/m)?.[1]
      if (!description) throw new Error(`Missing skill description: ${path}`)
      return { id: item.name, name: item.name, description: JSON.parse(description), autoinvoke: item.implicitInvocation, path, content }
    }))
    await context.skill.transform((editor) => {
      for (const skill of skills) editor.add(skill as never)
    })
  },
})
