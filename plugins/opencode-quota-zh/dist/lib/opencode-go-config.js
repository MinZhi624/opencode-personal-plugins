import { readFile } from "fs/promises";
import { join } from "path";
import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";
function getConfigCandidatePaths() {
    const { configDirs } = getOpencodeRuntimeDirCandidates();
    return configDirs.map((dir) => join(dir, "opencode-quota", "opencode-go.json"));
}
function getConfigFileError(error) {
    if (error instanceof SyntaxError) {
        return `Failed to parse JSON: ${error.message}`;
    }
    if (error instanceof Error && error.message) {
        return `Failed to read config file: ${error.message}`;
    }
    return `Failed to read config file: ${String(error)}`;
}
async function readConfigFile(path) {
    try {
        const data = await readFile(path, "utf-8");
        const parsed = JSON.parse(data);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return { state: "invalid", error: "Config file must contain a JSON object" };
        }
        return { state: "loaded", config: parsed };
    }
    catch (error) {
        if (error?.code === "ENOENT") {
            return { state: "missing" };
        }
        return { state: "invalid", error: getConfigFileError(error) };
    }
}
export function resolveOpenCodeGoConfigFromEnv(env = process.env) {
    const workspaceId = env.OPENCODE_GO_WORKSPACE_ID?.trim();
    const authCookie = env.OPENCODE_GO_AUTH_COOKIE?.trim();
    if (!workspaceId && !authCookie)
        return null;
    if (workspaceId && authCookie) {
        return {
            state: "configured",
            config: { workspaceId, authCookie },
            source: "env",
        };
    }
    return {
        state: "incomplete",
        source: "env",
        missing: workspaceId ? "OPENCODE_GO_AUTH_COOKIE" : "OPENCODE_GO_WORKSPACE_ID",
    };
}
export async function resolveOpenCodeGoConfig() {
    const envResult = resolveOpenCodeGoConfigFromEnv();
    if (envResult)
        return envResult;
    const candidates = getConfigCandidatePaths();
    for (const path of candidates) {
        const fileResult = await readConfigFile(path);
        if (fileResult.state === "missing")
            continue;
        if (fileResult.state === "invalid") {
            return { state: "invalid", source: path, error: fileResult.error };
        }
        const config = fileResult.config;
        const workspaceId = typeof config.workspaceId === "string" ? config.workspaceId.trim() : "";
        const authCookie = typeof config.authCookie === "string" ? config.authCookie.trim() : "";
        if (workspaceId && authCookie) {
            return {
                state: "configured",
                config: { workspaceId, authCookie },
                source: path,
            };
        }
        const missing = !workspaceId ? "workspaceId" : "authCookie";
        return { state: "incomplete", source: path, missing };
    }
    return { state: "none" };
}
let cachedConfig = null;
let cachedAt = 0;
const DEFAULT_CACHE_MAX_AGE_MS = 30_000;
export { DEFAULT_CACHE_MAX_AGE_MS as DEFAULT_OPENCODE_GO_CONFIG_CACHE_MAX_AGE_MS };
export async function resolveOpenCodeGoConfigCached(params) {
    const maxAgeMs = Math.max(0, params?.maxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS);
    const now = Date.now();
    if (cachedConfig && now - cachedAt < maxAgeMs) {
        return cachedConfig;
    }
    cachedConfig = await resolveOpenCodeGoConfig();
    cachedAt = now;
    return cachedConfig;
}
export async function getOpenCodeGoConfigDiagnostics() {
    const resolved = await resolveOpenCodeGoConfig();
    const checkedPaths = getConfigCandidatePaths();
    if (resolved.state === "none") {
        return { state: "none", source: null, missing: null, error: null, checkedPaths };
    }
    if (resolved.state === "incomplete") {
        return {
            state: "incomplete",
            source: resolved.source,
            missing: resolved.missing,
            error: null,
            checkedPaths,
        };
    }
    if (resolved.state === "invalid") {
        return {
            state: "invalid",
            source: resolved.source,
            missing: null,
            error: resolved.error,
            checkedPaths,
        };
    }
    return {
        state: "configured",
        source: resolved.source,
        missing: null,
        error: null,
        checkedPaths,
    };
}
//# sourceMappingURL=opencode-go-config.js.map