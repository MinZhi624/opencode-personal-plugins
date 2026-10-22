/**
 * 把 OpenCode 的模型目录与预设文件合成为一份只读状态。
 *
 * 模型能力标签不靠猜：视觉来自 `capabilities.input`，免费来自所有价格档位均为 0，
 * 上下文窗口来自 `limit.context`。网页与 TUI 都消费这一份结果。
 */
import {
  WORKSHOP_ROLES,
  type AgentPreset,
  type ModelSummary,
  type PresetState,
} from "../../shared/presets.js"
import { pathIsWritable, readPresetFile, resolvePreset } from "./store.js"

interface ModelInfoLike {
  readonly id: string
  readonly providerID: string
  readonly name?: string
  readonly enabled?: boolean
  readonly status?: ModelSummary["status"]
  readonly capabilities?: { readonly input?: readonly string[] }
  readonly cost?: readonly { readonly input: number; readonly output: number }[]
  readonly limit?: { readonly context?: number }
  readonly variants?: readonly { readonly id: string }[]
}

interface ProviderInfoLike {
  readonly id: string
  readonly name?: string
}

export interface ModelCatalogContext {
  readonly model: { list(): Promise<{ readonly data: readonly ModelInfoLike[] }> }
  readonly provider: { list(): Promise<{ readonly data: readonly ProviderInfoLike[] }> }
}

export interface ModelCatalog {
  readonly models: readonly ModelSummary[]
  readonly ids: ReadonlySet<string>
}

const IMAGE_INPUT = /^image(\/|$)/

export async function readModelCatalog(context: ModelCatalogContext): Promise<ModelCatalog> {
  const [modelsResult, providersResult] = await Promise.all([
    context.model.list(),
    context.provider.list(),
  ])
  const providerNames = new Map(
    providersResult.data.map((provider) => [provider.id, provider.name ?? provider.id] as const),
  )
  const models = modelsResult.data
    .filter((model) => model.enabled !== false)
    .map((model): ModelSummary => {
      const input = model.capabilities?.input ?? []
      const costs = model.cost ?? []
      return {
        id: model.id,
        providerID: model.providerID,
        providerName: providerNames.get(model.providerID) ?? model.providerID,
        name: model.name ?? model.id,
        vision: input.some((type) => IMAGE_INPUT.test(type)),
        free: costs.length > 0 && costs.every((cost) => cost.input === 0 && cost.output === 0),
        context: model.limit?.context ?? 0,
        inputCost: costs[0]?.input ?? 0,
        outputCost: costs[0]?.output ?? 0,
        variants: (model.variants ?? []).map((variant) => variant.id),
        status: model.status ?? "active",
      }
    })
    .sort((left, right) => {
      const provider = left.providerName.localeCompare(right.providerName)
      return provider !== 0 ? provider : left.name.localeCompare(right.name)
    })

  return { models, ids: new Set(models.map((model) => `${model.providerID}/${model.id}`)) }
}

export function baseAgentPresets(
  agents: Readonly<Record<string, { readonly model?: string; readonly variant?: string; readonly temperature?: number }>>,
): Record<string, AgentPreset> {
  const result: Record<string, AgentPreset> = {}
  for (const [role, value] of Object.entries(agents)) {
    if (!value?.model) continue
    result[role] = {
      models: [value.model],
      ...(value.variant ? { variant: value.variant } : {}),
      ...(typeof value.temperature === "number" ? { temperature: value.temperature } : {}),
    }
  }
  return result
}

export async function buildPresetState(
  context: ModelCatalogContext,
  filePath: string,
  base: Readonly<Record<string, AgentPreset>>,
): Promise<PresetState> {
  const [read, catalog] = await Promise.all([Promise.resolve(readPresetFile(filePath)), readModelCatalog(context)])
  const effective = resolvePreset(read.file, base, catalog.ids)
  return {
    filePath,
    exists: read.exists,
    ...(read.error ? { error: read.error } : {}),
    active: effective.active ?? null,
    presets: read.file.presets,
    base,
    resolved: effective.resolved,
    roles: WORKSHOP_ROLES,
    models: catalog.models,
    writable: pathIsWritable(filePath),
  }
}
