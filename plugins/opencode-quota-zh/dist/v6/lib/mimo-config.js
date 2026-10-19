import { readFile } from "fs/promises";
import { join } from "path";
import { isRecord } from "./json-guards.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
const MIMO_COOKIE_ENV = "MIMO_USAGE_COOKIE";
const RETAINED_COOKIE_NAMES = [
    "api-platform_serviceToken",
    "userId",
    "api-platform_ph",
    "api-platform_slh",
];
const RETAINED_COOKIE_NAME_SET = new Set(RETAINED_COOKIE_NAMES);
const REQUIRED_COOKIE_NAMES = ["api-platform_serviceToken", "userId"];
function getConfigPath() {
    return join(getOpencodeRuntimeDirs().configDir, "opencode-quota", "mimo.json");
}
function normalizeMimoCookieHeader(raw) {
    if (raw.includes("\r") || raw.includes("\n"))
        return null;
    const withoutPrefix = raw.trim().replace(/^cookie\s*:\s*/iu, "");
    if (!withoutPrefix)
        return null;
    const retained = new Map();
    for (const rawPair of withoutPrefix.split(";")) {
        const pair = rawPair.trim();
        if (!pair)
            continue;
        const separator = pair.indexOf("=");
        if (separator <= 0)
            return null;
        const name = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();
        if (!name)
            return null;
        if (!RETAINED_COOKIE_NAME_SET.has(name))
            continue;
        if (!value || retained.has(name))
            return null;
        retained.set(name, value);
    }
    if (REQUIRED_COOKIE_NAMES.some((name) => !retained.has(name)))
        return null;
    return RETAINED_COOKIE_NAMES.flatMap((name) => {
        const value = retained.get(name);
        return value === undefined ? [] : [`${name}=${value}`];
    }).join("; ");
}
function resolveCookie(raw, source) {
    const cookie = normalizeMimoCookieHeader(raw);
    if (!cookie)
        return { state: "invalid", source, error: "Cookie 头无效" };
    return { state: "configured", config: { cookie }, source };
}
async function resolveMimoConfigFile(path) {
    const invalid = (error) => ({
        state: "invalid",
        source: path,
        error,
    });
    let data;
    try {
        data = await readFile(path, "utf8");
    }
    catch (error) {
        if (error?.code === "ENOENT")
            return { state: "none" };
        return invalid("读取配置文件失败");
    }
    let parsed;
    try {
        parsed = JSON.parse(data);
    }
    catch {
        return invalid("JSON 解析失败");
    }
    if (!isRecord(parsed))
        return invalid("配置文件必须是 JSON 对象");
    const keys = Object.keys(parsed);
    if (keys.length !== 1 || keys[0] !== "cookie") {
        return invalid("配置文件只能包含 cookie 字段");
    }
    if (typeof parsed.cookie !== "string")
        return invalid("cookie 字段必须是字符串");
    return resolveCookie(parsed.cookie, path);
}
/** A set environment variable wins over the config file, even when it is invalid. */
async function resolveMimoConfig() {
    const envCookie = process.env[MIMO_COOKIE_ENV];
    if (envCookie !== undefined)
        return resolveCookie(envCookie, `env:${MIMO_COOKIE_ENV}`);
    return resolveMimoConfigFile(getConfigPath());
}
let cachedConfig = null;
let cachedAt = 0;
export const DEFAULT_MIMO_CONFIG_CACHE_MAX_AGE_MS = 30_000;
export async function resolveMimoConfigCached(params) {
    const maxAgeMs = Math.max(0, params?.maxAgeMs ?? DEFAULT_MIMO_CONFIG_CACHE_MAX_AGE_MS);
    const now = Date.now();
    if (cachedConfig && now - cachedAt < maxAgeMs) {
        return cachedConfig;
    }
    cachedConfig = await resolveMimoConfig();
    cachedAt = now;
    return cachedConfig;
}
export async function getMimoConfigDiagnostics() {
    const resolved = await resolveMimoConfig();
    return {
        state: resolved.state,
        source: "source" in resolved ? resolved.source : null,
        error: "error" in resolved ? resolved.error : null,
        checkedPaths: [getConfigPath()],
    };
}
