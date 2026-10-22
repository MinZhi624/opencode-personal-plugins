/**
 * 把 OpenCode 的模型目录与预设文件合成为一份只读状态。
 *
 * 模型能力标签不靠猜：视觉来自 `capabilities.input`，免费来自所有价格档位均为 0，
 * 上下文窗口来自 `limit.context`。网页与 TUI 都消费这一份结果。
 */
import { WORKSHOP_ROLES, } from "../../shared/presets.js";
import { pathIsWritable, readPresetFile, resolvePreset } from "./store.js";
const IMAGE_INPUT = /^image(\/|$)/;
export async function readModelCatalog(context) {
    const [modelsResult, providersResult] = await Promise.all([
        context.model.list(),
        context.provider.list(),
    ]);
    const providerNames = new Map(providersResult.data.map((provider) => [provider.id, provider.name ?? provider.id]));
    const models = modelsResult.data
        .filter((model) => model.enabled !== false)
        .map((model) => {
        const input = model.capabilities?.input ?? [];
        const costs = model.cost ?? [];
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
        };
    })
        .sort((left, right) => {
        const provider = left.providerName.localeCompare(right.providerName);
        return provider !== 0 ? provider : left.name.localeCompare(right.name);
    });
    return { models, ids: new Set(models.map((model) => `${model.providerID}/${model.id}`)) };
}
export function baseAgentPresets(agents) {
    const result = {};
    for (const [role, value] of Object.entries(agents)) {
        if (!value?.model)
            continue;
        result[role] = {
            models: [value.model],
            ...(value.variant ? { variant: value.variant } : {}),
            ...(typeof value.temperature === "number" ? { temperature: value.temperature } : {}),
        };
    }
    return result;
}
export async function buildPresetState(context, filePath, base) {
    const [read, catalog] = await Promise.all([Promise.resolve(readPresetFile(filePath)), readModelCatalog(context)]);
    const effective = resolvePreset(read.file, base, catalog.ids);
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
    };
}
