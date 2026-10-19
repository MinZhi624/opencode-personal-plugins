/**
 * One API key resolver for every API-key vendor.
 *
 * Order (first wins): environment variables, then the trusted global
 * `opencode.json(c)` (`providers.<id>.settings.apiKey`, or the legacy
 * `provider.<id>.options.apiKey`, with `{env:NAME}` templates), then OpenCode's
 * stored logins. Each vendor is one entry in `API_KEY_VENDORS` or
 * `API_KEY_LOGIN_VENDORS`.
 */
import { existsSync } from "fs";
import { sanitizeDisplayText } from "./display-sanitize.js";
import { resolveEnvTemplate } from "./env-template.js";
import { asRecord } from "./json-guards.js";
import { credentialRowAuthEntry, getCredentialDatabasePaths, readAuthFile, readAuthFileCached, readCredentialRows, } from "./opencode-auth.js";
import { buildOpenCodeConfigCandidates, readOpenCodeConfigCandidate, } from "./opencode-config-read.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
/** Vendors whose stored login is used only when it is a usable API key. */
export const API_KEY_VENDORS = {
    chutes: { envVars: ["CHUTES_API_KEY"], providerKeys: ["chutes"] },
    deepseek: { envVars: ["DEEPSEEK_API_KEY"], providerKeys: ["deepseek"] },
    kilo: { envVars: ["KILO_API_KEY"], providerKeys: ["kilo"] },
    nanogpt: {
        envVars: ["NANOGPT_API_KEY", "NANO_GPT_API_KEY"],
        providerKeys: ["nanogpt", "nano-gpt"],
    },
    "ollama-cloud": { envVars: ["OLLAMA_API_KEY"], providerKeys: ["ollama-cloud"] },
    synthetic: { envVars: ["SYNTHETIC_API_KEY"], providerKeys: ["synthetic"] },
};
/** Vendors that report a broken stored login (wrong type, empty key, unreadable) as an error. */
export const API_KEY_LOGIN_VENDORS = {
    zai: {
        displayName: "Z.ai",
        envVars: ["ZAI_API_KEY", "ZAI_CODING_PLAN_API_KEY"],
        providerKeys: ["zai", "zai-coding-plan", "glm"],
        authKeys: ["zai-coding-plan"],
    },
    zhipu: {
        displayName: "Zhipu",
        envVars: ["ZHIPU_API_KEY", "ZHIPU_CODING_PLAN_API_KEY"],
        providerKeys: ["zhipu", "zhipu-coding-plan", "zhipuai-coding-plan", "glm-coding-plan"],
        authKeys: ["zhipu-coding-plan", "zhipuai-coding-plan"],
    },
    // `opencode-go` is what `opencode auth login opencode-go` writes; `opencode` stays as a
    // fallback alias for older manual setups. Key logins only: the active `opencode` login is
    // usually the OpenCode Console sign-in, and resolving it could refresh its token for nothing.
    "opencode-go": {
        displayName: "OpenCode Go",
        envVars: ["OPENCODE_API_KEY"],
        providerKeys: ["opencode-go", "opencode"],
        authKeys: ["opencode-go", "opencode"],
        keyLoginsOnly: true,
        unsupportedTypeError: "OpenCode Go auth entry has unsupported type",
    },
    "kimi-code-plan-global": {
        displayName: "Kimi",
        envVars: ["KIMI_GLOBAL_API_KEY"],
        providerKeys: ["kimi-code-plan-global"],
        authKeys: ["kimi-code-plan-global"],
    },
    "kimi-code-plan-cn": {
        displayName: "Kimi",
        envVars: ["KIMI_CN_API_KEY", "KIMI_API_KEY", "KIMI_CODE_API_KEY"],
        providerKeys: ["kimi-code-plan-cn", "kimi-for-coding", "kimi-code", "kimi"],
        authKeys: ["kimi-code-plan-cn", "kimi-for-coding", "kimi-code", "kimi"],
    },
    "minimax-coding-plan": {
        displayName: "MiniMax",
        envVars: ["MINIMAX_CODING_PLAN_API_KEY", "MINIMAX_API_KEY"],
        providerKeys: ["minimax-coding-plan", "minimax"],
        authKeys: ["minimax-coding-plan"],
    },
    "minimax-china-coding-plan": {
        displayName: "MiniMax",
        envVars: ["MINIMAX_CHINA_CODING_PLAN_API_KEY"],
        providerKeys: [
            "minimax-china-coding-plan",
            "minimax-cn-coding-plan",
            "minimax-cn",
            "minimax-china",
        ],
        authKeys: ["minimax-china-coding-plan", "minimax-cn-coding-plan"],
    },
    "alibaba-coding-plan": {
        displayName: "Alibaba Coding Plan",
        envVars: ["ALIBABA_CODING_PLAN_API_KEY", "ALIBABA_API_KEY"],
        providerKeys: ["alibaba-coding-plan", "alibaba"],
        authKeys: ["alibaba-coding-plan", "alibaba"],
    },
};
/** How long a stored login read stays cached, unless the caller asks for another age. */
const API_KEY_LOGIN_CACHE_MAX_AGE_MS = 5_000;
/**
 * Trusted global-only `opencode.jsonc` / `opencode.json` paths. Provider secrets
 * are never read from repo-local config: the current workspace may be untrusted.
 */
export function getGlobalOpencodeConfigCandidatePaths() {
    const { configDir } = getOpencodeRuntimeDirs();
    return buildOpenCodeConfigCandidates({
        directories: [configDir],
        formatOrder: ["jsonc", "json"],
    }).map((candidate) => ({ path: candidate.path, isJsonc: candidate.format === "jsonc" }));
}
/** The parsed config of one candidate; undefined when it is missing or does not parse. */
export async function readConfigCandidate(candidate) {
    const result = await readOpenCodeConfigCandidate({
        path: candidate.path,
        format: candidate.isJsonc ? "jsonc" : "json",
    });
    return result.state === "parsed" ? result.value : undefined;
}
export function getFirstAuthEntryValue(auth, authKeys) {
    const root = asRecord(auth);
    if (!root)
        return undefined;
    const authKey = authKeys.find((key) => Object.hasOwn(root, key));
    return authKey === undefined ? undefined : root[authKey];
}
/**
 * Read one provider's settings the way OpenCode 2 normalizes its config.
 *
 * A native `providers.<id>` entry replaces the legacy `provider.<id>` entry,
 * whose `options` OpenCode 2 migrates into `settings`.
 */
export function getProviderConfigSettings(config, providerKey) {
    const root = asRecord(config);
    const nativeProvider = asRecord(root?.providers)?.[providerKey];
    // Any object here, even a malformed array, replaces the legacy entry.
    if (typeof nativeProvider === "object" && nativeProvider !== null) {
        return asRecord(nativeProvider.settings);
    }
    return asRecord(asRecord(asRecord(root?.provider)?.[providerKey])?.options);
}
/**
 * Read one provider string setting from trusted user/global OpenCode config.
 * The first candidate (`opencode.jsonc`, then `opencode.json`) that sets it wins.
 */
export async function readGlobalProviderConfigString(providerKey, settingKey) {
    for (const candidate of getGlobalOpencodeConfigCandidatePaths()) {
        const value = getProviderConfigSettings(await readConfigCandidate(candidate), providerKey)?.[settingKey];
        if (typeof value === "string" && value.trim().length > 0)
            return value.trim();
    }
    return undefined;
}
function extractConfigApiKey(config, spec) {
    for (const providerKey of spec.providerKeys) {
        const apiKey = getProviderConfigSettings(config, providerKey)?.apiKey;
        if (typeof apiKey !== "string" || apiKey.trim().length === 0)
            continue;
        const resolved = resolveEnvTemplate(apiKey.trim(), spec.envVars);
        if (resolved)
            return resolved;
    }
    return null;
}
/** Environment variables, then the trusted global config. */
export async function resolveApiKeyFromEnvAndConfig(spec) {
    for (const name of spec.envVars) {
        const value = process.env[name]?.trim();
        if (value)
            return { key: value, source: `env:${name}` };
    }
    for (const candidate of getGlobalOpencodeConfigCandidatePaths()) {
        const config = await readConfigCandidate(candidate);
        if (config === undefined)
            continue;
        const key = extractConfigApiKey(config, spec);
        if (key)
            return { key, source: candidate.isJsonc ? "opencode.jsonc" : "opencode.json" };
    }
    return null;
}
/** Env vars that are set and trusted config files that exist (no values). */
export function getApiKeyCheckedPaths(spec) {
    return [
        ...spec.envVars.filter((name) => process.env[name] !== undefined).map((name) => `env:${name}`),
        ...getGlobalOpencodeConfigCandidatePaths()
            .map((candidate) => candidate.path)
            .filter((path) => existsSync(path)),
    ];
}
function loginReadOptions(spec) {
    return {
        integrationIds: spec.authKeys ?? spec.providerKeys,
        ...(spec.keyLoginsOnly ? { methods: ["key"] } : {}),
    };
}
/** The first stored login among `authKeys` that is a usable API key; others are skipped. */
function extractStoredApiKey(auth, authKeys) {
    for (const authKey of authKeys) {
        const record = asRecord(getFirstAuthEntryValue(auth, [authKey]));
        const key = record?.key;
        if (record?.type === "api" && typeof key === "string" && key.trim().length > 0) {
            return key.trim();
        }
    }
    return null;
}
export async function resolveApiKey(spec) {
    const fromEnvOrConfig = await resolveApiKeyFromEnvAndConfig(spec);
    if (fromEnvOrConfig)
        return fromEnvOrConfig;
    const auth = await readAuthFile(loginReadOptions(spec));
    const key = extractStoredApiKey(auth, spec.authKeys ?? spec.providerKeys);
    return key ? { key, source: "opencode.db" } : null;
}
export async function hasApiKey(spec) {
    return (await resolveApiKey(spec)) !== null;
}
export async function getApiKeyDiagnostics(spec) {
    const checkedPaths = getApiKeyCheckedPaths(spec);
    const result = await resolveApiKey(spec);
    return {
        configured: result !== null,
        source: result?.source ?? null,
        checkedPaths,
        credentialDatabasePaths: getCredentialDatabasePaths(),
    };
}
/** Read the vendor's stored logins (cached for 5 seconds). */
export async function readApiKeyLoginAuth(spec) {
    return readAuthFileCached({
        maxAgeMs: API_KEY_LOGIN_CACHE_MAX_AGE_MS,
        ...loginReadOptions(spec),
    });
}
/** The first stored login among `authKeys` decides: a broken one is `invalid`, not skipped. */
export function parseApiKeyLogin(spec, auth) {
    const entry = getFirstAuthEntryValue(auth, spec.authKeys);
    if (entry === null || entry === undefined)
        return { state: "none" };
    if (typeof entry !== "object") {
        return { state: "invalid", error: `${spec.displayName} auth entry has invalid shape` };
    }
    const record = entry;
    if (typeof record.resolveError === "string") {
        return {
            state: "invalid",
            error: `OpenCode could not read this login: ${record.resolveError}`,
        };
    }
    if (typeof record.type !== "string") {
        return {
            state: "invalid",
            error: `${spec.displayName} auth entry present but type is missing or invalid`,
        };
    }
    if (record.type !== "api") {
        const sanitized = sanitizeDisplayText(record.type).replace(/\s+/g, " ").trim();
        return {
            state: "invalid",
            error: spec.unsupportedTypeError ??
                `Unsupported ${spec.displayName} auth type: "${(sanitized || "unknown").slice(0, 120)}"`,
        };
    }
    const apiKey = typeof record.key === "string" ? record.key.trim() : "";
    return apiKey
        ? { state: "configured", apiKey }
        : { state: "invalid", error: `${spec.displayName} auth entry present but key is empty` };
}
export async function resolveApiKeyLoginWithDiagnostics(spec) {
    const fromEnvOrConfig = await resolveApiKeyFromEnvAndConfig(spec);
    const auth = fromEnvOrConfig
        ? { state: "configured", apiKey: fromEnvOrConfig.key }
        : parseApiKeyLogin(spec, await readApiKeyLoginAuth(spec));
    const paths = {
        checkedPaths: getApiKeyCheckedPaths(spec),
        credentialDatabasePaths: getCredentialDatabasePaths(),
    };
    if (auth.state === "none")
        return { auth, diagnostics: { state: "none", source: null, ...paths } };
    if (auth.state === "invalid") {
        return {
            auth,
            diagnostics: { state: "invalid", source: "opencode.db", error: auth.error, ...paths },
        };
    }
    return {
        auth,
        diagnostics: {
            state: "configured",
            source: fromEnvOrConfig?.source ?? "opencode.db",
            ...paths,
        },
    };
}
export async function resolveApiKeyLogin(spec) {
    const fromEnvOrConfig = await resolveApiKeyFromEnvAndConfig(spec);
    if (fromEnvOrConfig)
        return { state: "configured", apiKey: fromEnvOrConfig.key };
    return parseApiKeyLogin(spec, await readApiKeyLoginAuth(spec));
}
export async function getApiKeyLoginDiagnostics(spec) {
    return (await resolveApiKeyLoginWithDiagnostics(spec)).diagnostics;
}
/**
 * Every key login of the vendor stored in OpenCode, in OpenCode's order, with what each one
 * holds. `selectRows` narrows the logins further, for example to drop alias duplicates.
 */
export async function readKeyLogins(spec, options = {}) {
    const vendorRows = (await readCredentialRows(spec.authKeys, { methods: ["key"] })).filter((row) => spec.authKeys.includes(row.integrationId));
    const rows = options.selectRows ? options.selectRows(vendorRows) : vendorRows;
    return rows.flatMap((row) => {
        const auth = parseApiKeyLogin(spec, {
            [row.integrationId]: credentialRowAuthEntry(row),
        });
        return auth.state === "none" ? [] : [{ row, auth }];
    });
}
