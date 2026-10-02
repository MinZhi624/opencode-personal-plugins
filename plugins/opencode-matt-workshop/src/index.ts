import { Plugin } from "@opencode/plugin"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { manifest } from "./catalog.js"
import { buildWorkshopAgents, mergePermissions, type PermissionRule, type WorkshopPermissionLayers } from "./agents.js"
import { WORKSHOP_SKILLS_PATH } from "./config.js"
import { parseWorkshopOptions } from "./options.js"

export default Plugin.define({
  id: "opencode-matt-workshop",
  async setup(context) {
    const definitions = buildWorkshopAgents(parseWorkshopOptions(context.options)) as Record<string, Record<string, any>>
    await context.agent.transform((editor) => {
      for (const [id, definition] of Object.entries(definitions)) {
        editor.update(id, (agent) => {
          agent.description = definition.description
          agent.mode = definition.mode
          agent.color = definition.color
          agent.steps = definition.steps
          agent.system = definition.prompt
          // 原生 v2 ruleset：保留 agent 现有规则（原生默认 + 用户显式配置）及其相对顺序，
          // 按 base → Workshop policy → 用户规则 → Workshop hard 分层合并；不整体覆盖。
          // policy 从不在用户规则之后，不会静默收紧或放宽既有 ask / deny；职责硬限制
          // （禁递归委派 / 禁 Worker 提问用户 / 危险命令与自行 Git 变更拒绝、只读 Worker 不得 edit、
          // Drafter 不通过 shell 写文件）始终位于最后，不被用户 allow 覆盖。
          agent.permissions = mergePermissions(
            (agent.permissions ?? []) as PermissionRule[],
            (definition.permissions ?? { policy: [], hard: [] }) as WorkshopPermissionLayers,
          )
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
