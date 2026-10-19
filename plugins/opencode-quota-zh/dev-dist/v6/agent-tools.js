/**
 * Tools for AI agents: read the server settings, change the provider, checking and pricing
 * settings, and add, test and remove custom providers. Words, export and telemetry
 * are the user's, edited in the quota window or the settings file. Every write
 * holds the settings lock and goes into OpenCode Quota's own settings file, never opencode.json.
 *
 * Keys: a provider added by an agent is saved switched off (`"enabled": false`), so it is never
 * fetched and its key is never sent until the user switches it on. No tool switches a provider
 * on. Every answer is cleaned in one place: each key the plugin can read, and anything in a
 * known key format, is replaced before the agent sees it.
 */
import { rowsFromProviderResult } from "./core/rows.js";
import { getGlobalOpencodeConfigCandidatePaths, getProviderConfigSettings, readConfigCandidate, } from "./lib/api-key-resolver.js";
import { resolveEnvTemplate } from "./lib/env-template.js";
import { isRecord } from "./lib/json-guards.js";
import { readCredentialRows } from "./lib/opencode-auth.js";
import { describeQuotaProviderRequest, QUOTA_PROVIDER_FIELDS, QUOTA_PROVIDERS_AGGREGATE_ID, } from "./lib/quota-providers.js";
import { collectLocalQuotaProviderEstimate } from "./lib/quota-providers-local.js";
import { fetchRemoteQuotaProvider, resolveQuotaProviderApiKey, } from "./lib/quota-providers-remote.js";
import { customAccount } from "./providers/quota-providers.js";
import { checkSetting, describeRule, editSettings, editSettingsFile, loadSettings, SETTINGS_SCHEMA, settingsPath, } from "./settings/index.js";
const REDACTED = "[redacted]";
/** The top-level settings agents may change; the user changes the others in /quota_settings. */
const AGENT_GROUPS = ["providers"];
const TOP_LEVEL_SETTINGS = new Set(Object.keys(SETTINGS_SCHEMA).map((key) => key.split(".")[0]));
const DEFINITION_SECRET_MESSAGE = "looks like a key or other secret, so nothing was saved. Put the key in an environment " +
    "variable and set apiKeyEnv to its name, or leave apiKeyEnv out to use OpenCode's key.";
/** How the agent tells the user to switch a provider on. */
function switchOnStep() {
    return (`Ask the user to switch it on: "enabled": true in ${settingsPath()}, or ` +
        "/quota_settings → Providers");
}
const SETTING_SECRET_MESSAGE = "looks like a key or other secret, so nothing was saved";
/** A top-level definition field that would hold a secret; `apiKeyEnv` holds only a name. */
const SECRET_FIELD_PATTERN = /key|token|secret|passw|bearer|cookie|credential|authorization/i;
/** Known key formats, found anywhere in a text: refused in inputs, replaced in answers. */
const SECRET_PATTERNS = [
    /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI, Anthropic, OpenRouter, DeepSeek, Moonshot
    /\b(?:gh[opsur]|github_pat)_[A-Za-z0-9_]{20,}/g, // GitHub
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
    /\bAKIA[0-9A-Z]{16}\b/g, // AWS
    /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API key
    /\bya29\.[0-9A-Za-z_-]{20,}/g, // Google OAuth access token
    /\b1\/\/[0-9A-Za-z_-]{20,}/g, // Google OAuth refresh token
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g, // JWT, all three parts
    /\bbearer\s+\S{8,}/gi,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];
/** Fields holding names (ids, model names, URLs, JSON paths): long runs pass in them. */
const NAME_FIELDS = new Set([
    "id",
    "providerId",
    "modelIds",
    "url",
    "path",
    "rowsPath",
    "pricingModelMap",
]);
/** The validator's rule for an environment variable name, the only thing apiKeyEnv holds. */
const VARIABLE_NAME = /^[A-Z_][A-Z0-9_]*$/;
/** Environment variables whose values the answers never show: the names keys go by. */
const KEY_VARIABLE_NAME = /API_?KEY|TOKEN|SECRET|PASSW|COOKIE|CREDENTIAL/i;
/** Keys this long are replaced anywhere; shorter ones only as a whole token, so no word is cut. */
const LONG_KEY_LENGTH = 8;
/**
 * True when a run of 20+ letters and digits switches between letters, digits and case so often
 * that its pieces average under 3 characters: a random token, not words. A camelCase name such
 * as "AvailableBalanceUSD2024Total" splits into Available|Balance|USD|2024|Total and passes; a
 * hex or base62 key splits into pieces of 1-2 characters.
 */
function looksRandom(run) {
    if (!/[0-9]/.test(run) || !/[A-Za-z]/.test(run))
        return false;
    const pieces = run.match(/[0-9]+|[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? [];
    return run.length / pieces.length < 3;
}
/**
 * True when a value holds something shaped like a key: a known key format, a random run of
 * letters and digits, or (outside name fields) any run of 24+ of them. Any other character ends
 * a run, so model names such as "Qwen3-Coder-480B-A35B-Instruct-2507", UUIDs and version
 * strings pass. A heuristic: keys never belong in a definition or a setting, only in an
 * environment variable.
 */
function looksSecret(text, isName) {
    return (SECRET_PATTERNS.some((pattern) => text.search(pattern) !== -1) ||
        (text.match(/[A-Za-z0-9]{20,}/g) ?? []).some((run) => looksRandom(run) || (!isName && run.length >= 24)));
}
/** A copy of a JSON value with `redact` applied to every string in it, property names too. */
function redactStrings(value, redact) {
    if (typeof value === "string")
        return redact(value);
    if (Array.isArray(value))
        return value.map((item) => redactStrings(item, redact));
    if (isRecord(value)) {
        return Object.fromEntries(Object.entries(value).map(([name, item]) => [redact(name), redactStrings(item, redact)]));
    }
    return value;
}
/**
 * True when a value holds a string, or a property name, that looks like a secret. Property names
 * are checked like ids (a pricingModelMap is keyed by model ids).
 */
function holdsSecret(value, isName) {
    if (typeof value === "string")
        return looksSecret(value, isName);
    if (Array.isArray(value))
        return value.some((item) => holdsSecret(item, isName));
    if (isRecord(value)) {
        return Object.entries(value).some(([name, item]) => looksSecret(name, true) || holdsSecret(item, isName || NAME_FIELDS.has(name)));
    }
    return false;
}
/**
 * The definition fields that look like they hold a secret. An issue names a definition field, or
 * the position of a field definitions do not have; never a name from the input. A field named
 * like a secret is refused whatever it holds; a valid variable name in apiKeyEnv is only a name.
 */
function definitionSecretIssues(definition) {
    return Object.entries(definition).flatMap(([field, value], index) => {
        if (field === "apiKeyEnv" && typeof value === "string" && VARIABLE_NAME.test(value))
            return [];
        if (QUOTA_PROVIDER_FIELDS.includes(field)) {
            return holdsSecret(value, NAME_FIELDS.has(field))
                ? [{ key: `definition.${field}`, message: DEFINITION_SECRET_MESSAGE }]
                : [];
        }
        const secret = SECRET_FIELD_PATTERN.test(field) || looksSecret(field, true) || holdsSecret(value, false);
        return secret
            ? [{ key: "definition", message: `field ${index + 1} ${DEFINITION_SECRET_MESSAGE}` }]
            : [];
    });
}
/**
 * Every key the plugin can read: variables named like keys or named by a switched-on custom
 * provider; keys in the global opencode.json(c); and API-key logins saved in OpenCode for the
 * providers OpenCode has. OAuth tokens are not read (that could refresh them); `SECRET_PATTERNS`
 * covers their shape. The key of a switched-off provider (and of one a tool saves, always
 * switched off) is never read: until the user switches it on, nothing touches it.
 */
async function credentialValues(host) {
    // Each provider's key variable and OpenCode provider.
    const sources = (await loadSettings()).settings.providers.custom
        .filter((definition) => definition.enabled !== false)
        .map((definition) => ({
        variable: definition.mode === "remote-api" ? definition.apiKeyEnv : undefined,
        providerId: definition.providerId,
    }));
    const variables = new Set(Object.keys(process.env).filter((name) => KEY_VARIABLE_NAME.test(name)));
    for (const { variable } of sources) {
        if (typeof variable === "string")
            variables.add(variable);
    }
    const values = [...variables].map((name) => process.env[name]);
    for (const candidate of getGlobalOpencodeConfigCandidatePaths()) {
        const config = await readConfigCandidate(candidate);
        if (!isRecord(config))
            continue;
        const providerIds = [config.provider, config.providers].flatMap((group) => isRecord(group) ? Object.keys(group) : []);
        for (const providerId of providerIds) {
            const apiKey = getProviderConfigSettings(config, providerId)?.apiKey;
            if (typeof apiKey === "string")
                values.push(resolveEnvTemplate(apiKey.trim()));
        }
    }
    const providerIds = new Set([
        ...(await host.openCodeProviderIds()),
        ...sources.map(({ providerId }) => providerId),
    ]);
    const logins = await readCredentialRows([...providerIds], { methods: ["key"] });
    values.push(...logins.map((row) => row.value.key));
    return values.flatMap((value) => typeof value === "string" && value.trim() ? [value.trim()] : []);
}
/**
 * Replaces, in one string, each key the plugin can read and each known key format. A key under
 * LONG_KEY_LENGTH counts only as a whole token (letters, digits, `_` and `-`).
 */
async function credentialRedactor(host) {
    // Longest first, so a key that contains another is replaced whole.
    const values = [...new Set(await credentialValues(host))].sort((a, b) => b.length - a.length);
    const long = values.filter((value) => value.length >= LONG_KEY_LENGTH);
    const short = values
        .filter((value) => value.length < LONG_KEY_LENGTH)
        .map((value) => {
        const escaped = value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
        return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "g");
    });
    return (text) => {
        let redacted = text;
        for (const value of long)
            redacted = redacted.split(value).join(REDACTED);
        for (const pattern of short)
            redacted = redacted.replace(pattern, REDACTED);
        for (const pattern of SECRET_PATTERNS)
            redacted = redacted.replace(pattern, REDACTED);
        return redacted;
    };
}
function valueAt(settings, key) {
    return key
        .split(".")
        .reduce((value, part) => (isRecord(value) ? value[part] : undefined), settings);
}
/** Where each remote custom provider reads its API key: a variable name, never its value. */
function apiKeySources(definitions) {
    return definitions.flatMap((definition) => {
        if (definition.mode !== "remote-api")
            return [];
        if (!definition.apiKeyEnv) {
            return [
                {
                    provider: definition.id,
                    apiKeyEnv: null,
                    readsFrom: `OpenCode's API key for provider "${definition.providerId}"`,
                },
            ];
        }
        return [
            {
                provider: definition.id,
                apiKeyEnv: definition.apiKeyEnv,
                isSet: Boolean(process.env[definition.apiKeyEnv]?.trim()),
            },
        ];
    });
}
async function getSettings() {
    const loaded = await loadSettings();
    const fromFile = new Set(loaded.fromFile);
    const settings = Object.fromEntries(Object.entries(SETTINGS_SCHEMA).map(([key, rule]) => [
        key,
        {
            value: valueAt(loaded.settings, key),
            from: fromFile.has(key) ? "file" : "default",
            allowed: rule.kind === "customProviders"
                ? "custom provider definitions; change them with quota_provider_add and quota_provider_remove"
                : describeRule(rule),
        },
    ]));
    const notes = [
        `quota_settings_set changes only ${AGENT_GROUPS.join(", ")}, as nested objects, e.g. ` +
            '{ "providers": { "checking": { "minIntervalMs": 600000 } } }; null resets a key. The user changes the ' +
            "other settings in /quota_settings.",
        "All quota settings are in this file. The user changes display settings in /quota_settings.",
    ];
    if (!loaded.exists && loaded.conversion) {
        notes.push(`The file does not exist yet: the values marked "file" come from ${loaded.conversion.sources.join(", ")}. The first change writes the file.`);
    }
    return {
        file: loaded.path,
        fileExists: loaded.exists,
        settings,
        apiKeys: apiKeySources(loaded.settings.providers.custom),
        ...(loaded.issues.length > 0 ? { problemsInFile: loaded.issues } : {}),
        notes,
    };
}
/** True when a patch would change the custom providers, which only the provider tools do. */
function touchesCustomProviders(patch) {
    if (!Object.hasOwn(patch, "providers"))
        return false;
    const providers = patch.providers;
    return providers === null || (isRecord(providers) && Object.hasOwn(providers, "custom"));
}
/**
 * What an agent may not change in a patch; checked before anything is saved. An issue names a
 * settings key, or the position of a name that is not one; never a name from the patch. Names
 * deeper in a group are checked by the save, which reports them the same way.
 */
function patchIssues(patch) {
    const agentGroups = AGENT_GROUPS.join(", ");
    const issues = Object.entries(patch).flatMap(([group, value], index) => {
        const position = `key ${index + 1} of the patch`;
        if (group.includes(".")) {
            return [
                {
                    key: "patch",
                    message: `use nested objects, not dotted keys (${position}), e.g. { "providers": { "checking": { "minIntervalMs": 600000 } } }`,
                },
            ];
        }
        if (!TOP_LEVEL_SETTINGS.has(group)) {
            return [
                {
                    key: "patch",
                    message: `unknown setting (${position}); agents may change: ${agentGroups}`,
                },
            ];
        }
        if (!AGENT_GROUPS.includes(group)) {
            return [
                {
                    key: group,
                    message: `the user changes ${group} in /quota_settings; agents may change: ${agentGroups}`,
                },
            ];
        }
        return holdsSecret(value, false) ? [{ key: group, message: SETTING_SECRET_MESSAGE }] : [];
    });
    if (touchesCustomProviders(patch)) {
        issues.push({
            key: "providers.custom",
            message: "change custom providers with quota_provider_add and quota_provider_remove; " +
                "to reset other provider settings, set each one to null",
        });
    }
    return issues;
}
async function setSettings(input) {
    const patch = isRecord(input) ? input.patch : undefined;
    const issues = isRecord(patch)
        ? patchIssues(patch)
        : [{ key: "patch", message: "expected an object of settings" }];
    if (issues.length > 0)
        return { ok: false, issues, message: "Nothing was saved." };
    // Agents may also write settings /quota_settings does not show, such as the Claude CLI path.
    const saved = await editSettings(() => patch, { allowFileOnly: true });
    if (!saved.ok)
        return { ok: false, issues: saved.issues, message: "Nothing was saved." };
    return {
        ok: true,
        file: settingsPath(),
        diff: saved.diff,
        message: saved.diff.length > 0 ? "Saved." : "Nothing changed.",
    };
}
/** A list with a bad entry loads as empty, so changing it would drop every entry the user has. */
function customProviderIssues(issues) {
    return issues.filter((issue) => issue.key.startsWith("providers.custom"));
}
function fixFileFirst(problems) {
    return {
        ok: false,
        issues: problems,
        message: `Nothing was changed: fix the custom providers in ${settingsPath()} first.`,
    };
}
/** The id the caller sent is not repeated; the ids in the file are listed instead. */
function notFound(ids) {
    return { ok: false, message: "No custom provider has that id.", ids };
}
/**
 * The rows the sidebar would show for one reply of a definition, or why there are none. Row
 * ids are made from the names and ids in them, so every string in them is redacted first, to a
 * placeholder a row id may hold.
 */
function testedRows(definition, rows, rowErrors, redact) {
    const result = {
        attempted: true,
        accounts: [customAccount(definition, rows, rowErrors)],
        debug: [],
    };
    const fetched = rowsFromProviderResult(QUOTA_PROVIDERS_AGGREGATE_ID, redactStrings(result, (text) => redact(text).replaceAll(REDACTED, "redacted")));
    const problems = fetched.debug.map((detail) => detail.value);
    if (fetched.rows.length === 0) {
        return { ok: false, error: "The answer had no rows that could be read.", problems };
    }
    return { ok: true, rows: fetched.rows, ...(problems.length > 0 ? { problems } : {}) };
}
/**
 * One fetch of one switched-on definition now, as the rows the sidebar would show, or why it
 * failed. Its key is read the way the plugin reads it.
 */
async function testFetch(definition, requestTimeoutMs, redact) {
    if (definition.enabled === false) {
        return { ok: false, error: `Not tested: it is switched off. ${switchOnStep()}; then test it.` };
    }
    if (definition.mode === "local-estimate") {
        return testedRows(definition, (await collectLocalQuotaProviderEstimate(definition)).rows, [], redact);
    }
    const { key } = await resolveQuotaProviderApiKey(definition);
    if (!key) {
        return {
            ok: false,
            error: `No API key found. It is read from ${describeQuotaProviderRequest(definition)?.key}. ` +
                "The user saves it there and restarts OpenCode; then run quota_provider_test.",
        };
    }
    const result = await fetchRemoteQuotaProvider(definition, key, requestTimeoutMs);
    if (!result.success)
        return { ok: false, error: result.error };
    return testedRows(definition, result.rows, result.rowErrors ?? [], redact);
}
/** Why a saved definition would still not show, so the agent can fix it. */
async function visibilityNotes(definition, settings, host) {
    const notes = [];
    const off = settings.providers.off;
    if (off.includes("custom")) {
        notes.push('providers.off lists "custom", so custom providers are not shown; remove it with quota_settings_set.');
    }
    let openCodeIds;
    try {
        openCodeIds = await host.openCodeProviderIds();
    }
    catch {
        // Without the list, say nothing rather than guess.
    }
    if (openCodeIds && !openCodeIds.includes(definition.providerId)) {
        notes.push(`OpenCode has no provider "${definition.providerId}", so this one is not shown. Set ` +
            `providerId to the OpenCode provider it tracks; OpenCode has: ${openCodeIds.join(", ")}.`);
    }
    return notes;
}
async function addProvider(input, host) {
    const definition = isRecord(input) ? input.definition : undefined;
    if (!isRecord(definition)) {
        return {
            ok: false,
            issues: [{ key: "definition", message: "expected an object" }],
            message: "Nothing was saved.",
        };
    }
    const secrets = definitionSecretIssues(definition);
    if (secrets.length > 0)
        return { ok: false, issues: secrets, message: "Nothing was saved." };
    // Written as the agent sent it, so the file gets no filled-in defaults; a label that only
    // repeats the id is left out. Always switched off, also when it replaces one that was on.
    const { label, ...withoutLabel } = definition;
    const entry = { ...(label === definition.id ? withoutLabel : definition), enabled: false };
    // The entry alone, so its problems point into it; the save checks the whole list.
    const alone = checkSetting("providers.custom", [entry]);
    if (alone.issues.length > 0) {
        return {
            ok: false,
            issues: alone.issues.map((issue) => ({
                ...issue,
                key: issue.key.replace(/^providers\.custom\[0\]/, "definition"),
            })),
            message: "Nothing was saved. Fix the definition and add it again.",
        };
    }
    const added = alone.value[0];
    let problems = [];
    let replaced = false;
    const saved = await editSettingsFile((current, issues) => {
        problems = customProviderIssues(issues);
        if (problems.length > 0)
            return undefined;
        const at = current.providers.custom.findIndex((item) => item.id === added.id);
        replaced = at !== -1;
        // Only this entry changes (-1 appends), so the others keep their comments.
        return [{ path: ["providers", "custom", at], value: entry }];
    });
    if (problems.length > 0)
        return fixFileFirst(problems);
    if (!saved.ok)
        return { ok: false, issues: saved.issues, message: "Nothing was saved." };
    // What the user checks before switching it on: where the key would go, and from where.
    const request = describeQuotaProviderRequest(added);
    const check = request ? `, after checking that ${request.url} may get ${request.key}` : "";
    const notes = await visibilityNotes(added, (await loadSettings()).settings, host);
    return {
        ok: true,
        [replaced ? "replaced" : "added"]: added.id,
        file: settingsPath(),
        enabled: false,
        ...(request ? { request } : {}),
        ...(notes.length > 0 ? { notes } : {}),
        message: `Saved, switched off: it is not fetched and its key is not sent yet. ${switchOnStep()}` +
            `${check}; then test it with quota_provider_test.`,
    };
}
async function testProvider(input, host, redact) {
    const id = isRecord(input) ? input.id : undefined;
    const loaded = await loadSettings();
    const definitions = loaded.settings.providers.custom;
    const definition = definitions.find((item) => item.id === id);
    if (!definition) {
        const problems = customProviderIssues(loaded.issues);
        return {
            ...notFound(definitions.map((item) => item.id)),
            ...(problems.length > 0 ? { problemsInFile: problems } : {}),
        };
    }
    const test = await testFetch(definition, loaded.settings.providers.checking.requestTimeoutMs, redact);
    const notes = await visibilityNotes(definition, loaded.settings, host);
    return { id: definition.id, ...test, ...(notes.length > 0 ? { notes } : {}) };
}
async function removeProvider(input) {
    const id = isRecord(input) ? input.id : undefined;
    let problems = [];
    let ids = [];
    let found = false;
    const saved = await editSettingsFile((current, issues) => {
        problems = customProviderIssues(issues);
        if (problems.length > 0)
            return undefined;
        ids = current.providers.custom.map((item) => item.id);
        const at = typeof id === "string" ? ids.indexOf(id) : -1;
        found = at !== -1;
        // Only this entry goes, so the others keep their comments.
        return found ? [{ path: ["providers", "custom", at], value: undefined }] : undefined;
    });
    if (problems.length > 0)
        return fixFileFirst(problems);
    if (!saved.ok)
        return { ok: false, issues: saved.issues, message: "Nothing was removed." };
    if (!found)
        return notFound(ids);
    return {
        ok: true,
        removed: id,
        remaining: ids.filter((item) => item !== id),
        message: "Removed.",
    };
}
function tool(host, name, description, properties, run) {
    return {
        name,
        description,
        input: {
            type: "object",
            properties,
            // Every input is required; an empty list is not valid in every JSON Schema draft.
            ...(Object.keys(properties).length > 0 ? { required: Object.keys(properties) } : {}),
            additionalProperties: false,
        },
        async execute(input) {
            let redact;
            try {
                redact = await credentialRedactor(host);
            }
            catch {
                const message = "Nothing was done: the saved keys to hide from the answer could not be read.";
                return { content: JSON.stringify({ ok: false, message }, null, 2) };
            }
            let result;
            try {
                result = await run(input, redact);
            }
            catch (error) {
                // A thrown error would reach the agent as an internal failure without its reason.
                result = { ok: false, message: error instanceof Error ? error.message : String(error) };
            }
            // The one place answers are cleaned: whatever a file or an endpoint holds, no key gets out.
            // Each string is cleaned on its own, so a replacement never reaches the JSON around it.
            return { content: JSON.stringify(redactStrings(result, redact), null, 2) };
        },
    };
}
const ID_INPUT = { type: "string", description: "The custom provider's id." };
const DEFINITION_EXAMPLE = JSON.stringify({
    id: "my-gateway-quota",
    providerId: "my-gateway",
    mode: "remote-api",
    url: "https://gateway.example/v1/quota",
    format: "quota-v1",
    apiKeyEnv: "MY_GATEWAY_API_KEY",
});
export function quotaAgentTools(host) {
    return [
        tool(host, "quota_settings_get", "Read OpenCode Quota's server settings. Returns each value with its source (file or " +
            "default) and allowed values, the file path, and the variable each custom provider " +
            "reads its key from.", {}, () => getSettings()),
        tool(host, "quota_settings_set", "Change OpenCode Quota's providers, checking or pricing settings with a merge patch of " +
            "nested objects; null resets a key. Returns what changed, or the problems (nothing " +
            "saved). Custom providers: quota_provider_add and quota_provider_remove.", {
            patch: {
                type: "object",
                description: 'Nested settings to change, e.g. { "providers": { "checking": { "minIntervalMs": 600000 } } }.',
            },
        }, setSettings),
        tool(host, "quota_provider_add", "Add a custom OpenCode Quota provider, or replace the one with its id. It is saved " +
            "switched off; once the user switches it on (settings file or /quota_settings → " +
            "Providers), quota_provider_test fetches it. No key in the definition: apiKeyEnv " +
            "names the variable holding it; without it, OpenCode's key for providerId is used. " +
            "Rules: " +
            "https://github.com/slkiser/opencode-quota/blob/main/docs/readme/providers.md#custom-providers", {
            definition: {
                type: "object",
                description: `One custom provider definition, e.g. ${DEFINITION_EXAMPLE}.`,
            },
        }, (input) => addProvider(input, host)),
        tool(host, "quota_provider_test", "Fetch one switched-on custom OpenCode Quota provider by id now. Returns the rows or " +
            "the error.", { id: ID_INPUT }, (input, redact) => testProvider(input, host, redact)),
        tool(host, "quota_provider_remove", "Remove one custom OpenCode Quota provider by id. Returns the ids that remain.", { id: ID_INPUT }, removeProvider),
    ];
}
