import { Plugin } from "@opencode/plugin"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { WorkshopPresetRpc, type WorkshopPresetSaveInput } from "../shared/rpc.js"
import type { PresetFile } from "../shared/presets.js"
import { manifest } from "./catalog.js"
import { buildWorkshopAgents, mergePermissions, type PermissionRule, type WorkshopPermissionLayers } from "./agents.js"
import { WORKSHOP_SKILLS_PATH } from "./config.js"
import { parseWorkshopOptions } from "./options.js"
import { buildPresetState, baseAgentPresets } from "./presets/state.js"
import {
  effectiveAgentOverrides,
  readPresetFile,
  resolvePreset,
  resolvePresetPath,
  validatePresetFile,
  writePresetFile,
} from "./presets/store.js"

export default Plugin.define({
  id: "opencode-matt-workshop",
  async setup(context) {
    const options = parseWorkshopOptions(context.options)
    const presetFilePath = resolvePresetPath(options.presetsFile)
    const baseAgents = baseAgentPresets(options.agents)
    let availableModels: ReadonlySet<string> | undefined

    const refreshCatalog = async () => {
      try {
        const models = await context.model.list()
        availableModels = new Set(
          models.data
            .filter((model) => model.enabled !== false)
            .map((model) => `${model.providerID}/${model.id}`),
        )
      } catch (error: unknown) {
        // 模型目录读不到时保留一层原样链，不让插件启动失败。
        console.warn("[opencode-matt-workshop] 读取模型目录失败，预设链将不做可用性裁剪", error)
        availableModels = undefined
      }
    }

    const definitionsForCurrentPreset = () => {
      const read = readPresetFile(presetFilePath)
      if (read.error) {
        console.warn(`[opencode-matt-workshop] ${read.error}；本次继续使用插件 options 中的模型`)
      }
      const effective = resolvePreset(read.file, baseAgents, availableModels)
      return buildWorkshopAgents({
        ...options,
        agents: {
          ...options.agents,
          ...effectiveAgentOverrides(effective),
        },
      }) as Record<string, Record<string, any>>
    }

    await refreshCatalog()

    await context.agent.transform((editor) => {
      const definitions = definitionsForCurrentPreset()
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

    const state = () => buildPresetState(context, presetFilePath, baseAgents)
    let notifyChange: (active: string | null) => Promise<void> = async () => {}

    const registration = await context.rpc.register(WorkshopPresetRpc, {
      state: async () => state(),
      save: async (input) => {
        const payload = input as WorkshopPresetSaveInput
        const active = typeof payload.active === "string" && payload.active.length > 0 ? payload.active : undefined
        if (active && !Object.hasOwn(payload.presets, active)) {
          throw new Error(`要应用的预设不存在：${active}`)
        }
        const file: PresetFile = validatePresetFile({
          version: 1,
          ...(active ? { active } : {}),
          presets: payload.presets,
        })
        writePresetFile(presetFilePath, file)
        await refreshCatalog()
        await context.agent.reload()
        const next = await state()
        await notifyChange(next.active)
        return next
      },
      activate: async (input) => {
        const name = String((input as { name?: unknown }).name ?? "").trim()
        if (!name) throw new Error("预设名不能为空")
        const read = readPresetFile(presetFilePath)
        if (read.error) throw new Error(read.error)
        const isBase = name === "base"
        if (!isBase && !Object.hasOwn(read.file.presets, name)) {
          throw new Error(`预设不存在：${name}`)
        }
        const next: PresetFile = {
          version: 1,
          ...(isBase ? {} : { active: name }),
          presets: read.file.presets,
        }
        writePresetFile(presetFilePath, next)
        await refreshCatalog()
        await context.agent.reload()
        const result = await state()
        await notifyChange(result.active)
        return result
      },
    })

    notifyChange = async (active) => {
      await registration.events.emit("changed", { active })
    }

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
