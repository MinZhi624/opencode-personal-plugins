/**
 * 预设文件的所有权边界：只有这里读写 `presets.json`，也只有这里校验内容。
 *
 * 文件格式保持纯 JSON，方便用户手改和版本管理；写入使用同目录临时文件 + rename，
 * 保留已有权限，避免写一半留下损坏文件。读取失败不抛给插件启动流程：返回错误，
 * Server 继续使用插件 options，网页仍可展示错误。
 */
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { presetModelChain, WORKSHOP_ROLE_IDS, } from "../../shared/presets.js";
const modelRef = z
    .string()
    .trim()
    .regex(/^[^/\s]+\/[^/\s]+$/, "模型 id 必须是 provider/model");
const agentPresetSchema = z
    .object({
    models: z.array(modelRef).min(1).max(16).optional(),
    model: modelRef.optional(),
    variant: z.string().min(1).max(80).optional(),
    temperature: z.number().min(0).max(2).optional(),
})
    .strict();
const roleIDs = new Set(WORKSHOP_ROLE_IDS);
const presetDefinitionSchema = z
    .object({
    extends: z.string().min(1).max(120).optional(),
    agents: z
        .record(z.string(), agentPresetSchema)
        .default({})
        .superRefine((agents, context) => {
        for (const id of Object.keys(agents)) {
            if (!roleIDs.has(id))
                context.addIssue({ code: "custom", message: `未知 Workshop 角色：${id}` });
        }
    }),
})
    .strict();
export const presetFileSchema = z
    .object({
    version: z.literal(1).default(1),
    active: z.string().min(1).max(120).optional(),
    presets: z.record(z.string(), presetDefinitionSchema).default({}),
})
    .strict();
const emptyFile = { version: 1, presets: {} };
export function defaultPresetPath() {
    const configRoot = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
    return join(configRoot, "opencode", "opencode-matt-workshop", "presets.json");
}
export function resolvePresetPath(configured) {
    const value = configured?.trim();
    if (!value)
        return defaultPresetPath();
    if (value === "~")
        return homedir();
    if (value.startsWith("~/"))
        return join(homedir(), value.slice(2));
    return isAbsolute(value) ? value : resolve(value);
}
export function readPresetFile(path) {
    if (!existsSync(path))
        return { exists: false, file: emptyFile };
    try {
        const parsed = presetFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
        return { exists: true, file: parsed };
    }
    catch (error) {
        return {
            exists: true,
            file: emptyFile,
            error: `预设文件无法解析：${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
export function validatePresetFile(value) {
    const parsed = presetFileSchema.parse(value);
    validateInheritance(parsed.presets);
    return parsed;
}
export function writePresetFile(path, file) {
    const validated = validatePresetFile(file);
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true });
    const temp = join(directory, `.${randomBytes(6).toString("hex")}.presets.tmp`);
    const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o644;
    writeFileSync(temp, `${JSON.stringify(validated, null, 2)}\n`, { mode });
    chmodSync(temp, mode);
    renameSync(temp, path);
}
export function pathIsWritable(path) {
    try {
        // 只检查最近的已存在祖先目录，不在读取状态时创建目录。
        let directory = dirname(path);
        while (!existsSync(directory) && dirname(directory) !== directory)
            directory = dirname(directory);
        accessSync(directory, constants.W_OK);
        if (existsSync(path))
            accessSync(path, constants.W_OK);
        return true;
    }
    catch {
        return false;
    }
}
function validateInheritance(presets) {
    for (const name of Object.keys(presets)) {
        const seen = new Set();
        let current = name;
        while (current) {
            if (seen.has(current))
                throw new Error(`预设继承出现循环：${[...seen, current].join(" → ")}`);
            seen.add(current);
            const definition = presets[current];
            if (!definition)
                throw new Error(`预设 ${name} 继承了不存在的预设 ${current}`);
            current = definition.extends;
        }
    }
}
function chainFor(name, presets) {
    const chain = [];
    const seen = new Set();
    let current = name;
    while (current) {
        if (seen.has(current))
            return chain;
        const definition = presets[current];
        if (!definition)
            return chain;
        seen.add(current);
        chain.unshift(current);
        current = definition.extends;
    }
    return chain;
}
function mergeAgent(base, override) {
    if (!override)
        return base;
    const next = { ...(base ?? {}), ...override };
    const chain = presetModelChain(override);
    // override 只改 variant 时保留基础模型链；显式给了 models/model 才替换整条链。
    if (chain.length > 0)
        return { ...next, models: chain, model: undefined };
    return next;
}
/**
 * 解析 active preset。`availableModels` 为空时不做可用性裁剪，保留链首项；
 * 有模型目录时按链顺序选第一个可用项，避免把已注销的模型交给 OpenCode。
 */
export function resolvePreset(file, base, availableModels) {
    const active = file.active && file.presets[file.active] ? file.active : undefined;
    const chain = active ? chainFor(active, file.presets) : [];
    const agents = {};
    const resolved = {};
    for (const role of WORKSHOP_ROLE_IDS) {
        const baseValue = base[role];
        let merged;
        let source = baseValue ? "base" : "none";
        for (const presetName of chain) {
            const override = file.presets[presetName]?.agents[role];
            if (!override)
                continue;
            merged = mergeAgent(merged ?? baseValue, override);
            source = "preset";
        }
        if (!merged)
            merged = baseValue;
        if (!merged)
            continue;
        agents[role] = merged;
        const fullChain = presetModelChain(merged);
        const model = fullChain.find((id) => !availableModels || availableModels.size === 0 || availableModels.has(id)) ?? fullChain[0];
        resolved[role] = {
            ...(model ? { model } : {}),
            ...(merged.variant ? { variant: merged.variant } : {}),
            chain: fullChain,
            source,
        };
    }
    return { agents, resolved, active, chain };
}
/** 把有效预设覆盖转成 `buildWorkshopAgents` 认识的 runtime override。 */
export function effectiveAgentOverrides(effective) {
    const result = {};
    for (const role of WORKSHOP_ROLE_IDS) {
        const resolved = effective.resolved[role];
        if (!resolved?.model)
            continue;
        result[role] = {
            model: resolved.model,
            ...(resolved.variant ? { variant: resolved.variant } : {}),
        };
    }
    return result;
}
