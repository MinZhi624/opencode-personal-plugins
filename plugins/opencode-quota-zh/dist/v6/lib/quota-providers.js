import { isIP } from "node:net";
import { classifyWindow } from "../core/windows.js";
import { daysInMonth } from "./calendar-date.js";
import { isRecord } from "./json-guards.js";
import { lookupCost } from "./modelsdev-pricing.js";
import { resolvePricingKey } from "./pricing-key.js";
import { getCanonicalQuotaProviderId } from "./provider-metadata.js";
export const QUOTA_PROVIDER_REMOTE_FORMATS = ["quota-v1", "openrouter-key-v1", "json-v1"];
export const QUOTA_PROVIDER_MODES = ["remote-api", "local-estimate"];
export const QUOTA_PROVIDER_WINDOW_TYPES = ["utc-day", "rolling"];
export const QUOTA_PROVIDERS_AGGREGATE_ID = "quota-providers";
export const MAINTAINED_LOCAL_ESTIMATE_IDS = ["alibaba-coding-plan"];
export function isMaintainedQuotaProviderTuning(definition) {
    return MAINTAINED_LOCAL_ESTIMATE_IDS.includes(definition.id);
}
/**
 * The custom definitions that run: not maintained tunings, and not switched off. A switched-off
 * definition is never fetched and its key is never sent.
 */
export function customQuotaProviderDefinitions(definitions) {
    return definitions.filter((definition) => !isMaintainedQuotaProviderTuning(definition) && definition.enabled !== false);
}
/** Hosts a plain-HTTP address may use without a warning: this computer only. */
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
/**
 * Where a remote custom provider sends its key, for the user to check before switching it on:
 * the URL's origin and path (the scheme shows http or https), and where the key comes from.
 * Never the key itself. `insecure` is true for plain HTTP to any host but localhost, 127.0.0.1
 * or ::1. Null for a local estimate, which sends nothing.
 */
export function describeQuotaProviderRequest(definition) {
    if (definition.mode !== "remote-api")
        return null;
    const url = new URL(definition.url);
    const saved = `OpenCode 里 ${definition.providerId} 的密钥`;
    return {
        url: `${url.origin}${url.pathname}`,
        key: definition.apiKeyEnv ? `${definition.apiKeyEnv}，否则用 ${saved}` : saved,
        insecure: url.protocol === "http:" && !LOCAL_HOSTNAMES.has(url.hostname),
    };
}
export function resolveQuotaProviderSessionModelIdentity(params) {
    if (params.currentProviderID) {
        return params.currentModel.length > 0
            ? { providerId: params.currentProviderID, modelId: params.currentModel }
            : null;
    }
    const slashIndex = params.currentModel.indexOf("/");
    if (slashIndex <= 0 || slashIndex === params.currentModel.length - 1)
        return null;
    return {
        providerId: params.currentModel.slice(0, slashIndex),
        modelId: params.currentModel.slice(slashIndex + 1),
    };
}
/** A short stable hash (32-bit FNV-1a, hex) that tells names apart in row keys. */
function shortNameHash(text) {
    let hash = 0x811c9dc5;
    for (const char of text) {
        hash ^= char.codePointAt(0) ?? 0;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
}
const CUSTOM_ROW_KEY_MAX_LENGTH = 48;
/**
 * The row key a custom source's mapping or entry name gets: spaces become "_", and the name
 * stays as it is when that leaves only letters, digits, "_" and "-" ("Daily limit" →
 * "Daily_limit", "Daily-limit" → "Daily-limit"). Other characters are dropped and a short hash
 * of the exact name is added, so names stay apart ("日次" → 8 hex digits).
 */
export function customRowKey(name) {
    const spaced = name.trim().replace(/\s+/gu, "_");
    const kept = spaced.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, CUSTOM_ROW_KEY_MAX_LENGTH);
    if (kept === spaced && /[A-Za-z0-9]/u.test(kept))
        return kept;
    const hash = shortNameHash(name.trim());
    return /[A-Za-z0-9]/u.test(kept) ? `${kept}_${hash}` : hash;
}
/** ADR 0001: a custom `rate_limit` is a quota and `spend` is usage. */
function customRowType(resultType) {
    if (resultType === "rate_limit")
        return "quota";
    if (resultType === "spend")
        return "usage";
    return resultType;
}
/**
 * One custom row. `key` is the part of its id after `custom.<definition id>.`; its label is the
 * configured label without a trailing colon, or else its name; its window is the one its name
 * or label names ("Daily" → day).
 */
export function customRow(params) {
    const label = (params.label ?? "").replace(/:+$/u, "").trim();
    const window = classifyWindow(params.name) ?? classifyWindow(label);
    return {
        key: params.key,
        label: label || params.name,
        type: customRowType(params.resultType),
        method: params.method,
        authority: params.method === "remote_api" ? "provider_reported" : "locally_derived",
        prominence: "primary",
        ...(window ? { window } : {}),
        ...params.value,
        ...(params.resetsAt ? { resetsAt: params.resetsAt } : {}),
    };
}
export function selectEligibleQuotaProviderDefinitions(params) {
    const runtimeEligible = customQuotaProviderDefinitions(params.definitions).filter((definition) => params.availableProviderIds.has(definition.providerId));
    if (!params.onlyCurrentModel)
        return runtimeEligible;
    if (!params.currentModel) {
        if (!params.currentProviderID)
            return [];
        return runtimeEligible.filter((definition) => definition.providerId === params.currentProviderID && definition.modelIds === undefined);
    }
    const identity = resolveQuotaProviderSessionModelIdentity({
        currentModel: params.currentModel,
        currentProviderID: params.currentProviderID,
    });
    if (!identity)
        return [];
    return runtimeEligible.filter((definition) => definition.providerId === identity.providerId &&
        (definition.modelIds === undefined || definition.modelIds.includes(identity.modelId)));
}
const BASE_FIELDS = ["id", "providerId", "label", "mode", "modelIds", "enabled"];
const REMOTE_FIELDS = [...BASE_FIELDS, "url", "format", "apiKeyEnv", "adapter"];
const LOCAL_FIELDS = [...BASE_FIELDS, "windows", "pricingModelMap"];
/** Every top-level field a definition can have, in either mode. */
export const QUOTA_PROVIDER_FIELDS = [
    ...new Set([...REMOTE_FIELDS, ...LOCAL_FIELDS]),
];
const WINDOW_FIELDS = [
    "id",
    "label",
    "type",
    "durationMinutes",
    "requestLimit",
    "usdBudget",
];
const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const ASCII_OR_UNICODE_CONTROL_PATTERN = /\p{Cc}/u;
const JSON_V1_STATIC_DISPLAY_FORBIDDEN_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const URL_WHITESPACE_OR_CONTROL_PATTERN = /[\s\p{Cc}]/u;
const MODEL_FORBIDDEN_PATTERN = /[\s\p{Cc}#?]/u;
const MAX_ID_LENGTH = 64;
const MAX_PROVIDER_ID_LENGTH = 64;
const MAX_LABEL_CODE_POINTS = 80;
const MAX_ENV_NAME_LENGTH = 128;
const MAX_WINDOWS = 16;
const MAX_ROLLING_MINUTES = 366 * 24 * 60;
const MAX_SAFE_REQUEST_LIMIT = 1_000_000_000;
const MAX_USD_BUDGET = 1_000_000_000;
const JSON_V1_MAX_MAPPINGS = 16;
const JSON_V1_MAX_ADAPTER_DEPTH = 8;
const JSON_V1_MAX_ADAPTER_OBJECTS = 128;
const JSON_V1_MAX_ADAPTER_PROPERTIES = 384;
const JSON_V1_MAX_ADAPTER_ARRAY_ELEMENTS = 640;
const JSON_V1_MAX_PATH_SEGMENTS = 8;
const JSON_V1_MAX_PATH_SEGMENT_CODE_POINTS = 64;
const JSON_V1_MAX_STATIC_NAME_CODE_POINTS = 80;
const JSON_V1_MAX_STATIC_UNIT_CODE_POINTS = 32;
export const JSON_V1_MAX_DISPLAY_CODE_POINTS = 160;
export const JSON_V1_MAX_NUMBER_MAGNITUDE = 1e15;
const JSON_V1_FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const JSON_V1_DIVISORS = new Set([100, 1_000, 1_000_000]);
const JSON_V1_TIMESTAMP_ENCODINGS = new Set([
    "iso-8601",
    "unix-seconds",
    "unix-milliseconds",
]);
export const CUSTOM_RESULT_TYPES = new Set([
    "quota",
    "rate_limit",
    "usage",
    "spend",
    "budget",
    "balance",
    "status",
]);
const JSON_V1_MIN_TIMESTAMP_MS = 0;
const JSON_V1_MAX_TIMESTAMP_MS = 253_402_300_799_999;
function hasOwnKey(value, key) {
    return Object.hasOwn(value, key);
}
function isValidId(value) {
    return (typeof value === "string" &&
        value.length >= 1 &&
        value.length <= MAX_ID_LENGTH &&
        ID_PATTERN.test(value));
}
function isValidProviderId(value) {
    return (typeof value === "string" &&
        value.length >= 1 &&
        value.length <= MAX_PROVIDER_ID_LENGTH &&
        PROVIDER_ID_PATTERN.test(value));
}
function isPositiveInteger(value, max) {
    return Number.isInteger(value) && Number(value) > 0 && Number(value) <= max;
}
function isPositiveFinite(value, max) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= max;
}
function normalizeLabel(value, fallback) {
    if (value === undefined)
        return fallback ?? null;
    if (typeof value !== "string")
        return null;
    const normalized = value.trim();
    const length = Array.from(normalized).length;
    if (length < 1 ||
        length > MAX_LABEL_CODE_POINTS ||
        ASCII_OR_UNICODE_CONTROL_PATTERN.test(value)) {
        return null;
    }
    return normalized;
}
function isLoopbackHostname(hostname) {
    const normalized = hostname.toLowerCase();
    if (normalized === "localhost" || normalized.endsWith(".localhost"))
        return true;
    if (normalized === "::1" || normalized === "[::1]")
        return true;
    if (isIP(normalized) === 4) {
        const first = Number(normalized.split(".", 1)[0]);
        return first === 127;
    }
    return false;
}
function normalizeRemoteUrl(value) {
    if (typeof value !== "string" ||
        value.length === 0 ||
        URL_WHITESPACE_OR_CONTROL_PATTERN.test(value)) {
        return {
            message: "应为不含空白与控制字符的绝对 HTTPS URL",
        };
    }
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        return { message: "应为绝对 HTTPS URL" };
    }
    if (!parsed.hostname)
        return { message: "URL 必须包含主机名" };
    if (parsed.username || parsed.password)
        return { message: "URL 不得包含凭据" };
    if (parsed.search)
        return { message: "URL 不得包含查询串" };
    if (parsed.hash)
        return { message: "URL 不得包含片段" };
    if (parsed.protocol !== "https:" &&
        !(parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname))) {
        return { message: "除回环地址的 HTTP 端点外必须使用 HTTPS" };
    }
    return { value: parsed.toString() };
}
function cloneDefinition(definition) {
    const modelIds = definition.modelIds ? { modelIds: [...definition.modelIds] } : {};
    if (definition.mode === "remote-api") {
        return definition.format === "json-v1"
            ? { ...definition, ...modelIds, adapter: structuredClone(definition.adapter) }
            : { ...definition, ...modelIds };
    }
    return {
        ...definition,
        ...modelIds,
        windows: definition.windows.map((window) => ({ ...window })),
        ...(definition.pricingModelMap ? { pricingModelMap: { ...definition.pricingModelMap } } : {}),
    };
}
function adapterIssue(issues, key, message) {
    issues.push({ key, message });
}
function validateKnownAdapterFields(value, allowed, key, issues) {
    if (Object.keys(value).some((field) => !allowed.includes(field))) {
        adapterIssue(issues, `${key}.*`, `未知字段；允许的字段：${allowed.join(", ")}`);
    }
}
function preflightJsonV1Adapter(value, key, issues) {
    const stack = [{ value, depth: 1 }];
    const seen = new WeakSet();
    let objects = 0;
    let properties = 0;
    let arrayElements = 0;
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current.value || typeof current.value !== "object")
            continue;
        if (seen.has(current.value)) {
            adapterIssue(issues, key, "应为受限的 JSON 对象树");
            return false;
        }
        seen.add(current.value);
        if (current.depth > JSON_V1_MAX_ADAPTER_DEPTH) {
            adapterIssue(issues, key, `嵌套深度不得超过 ${JSON_V1_MAX_ADAPTER_DEPTH}`);
            return false;
        }
        if (Array.isArray(current.value)) {
            arrayElements += current.value.length;
            if (arrayElements > JSON_V1_MAX_ADAPTER_ARRAY_ELEMENTS) {
                adapterIssue(issues, key, `数组元素总数不得超过 ${JSON_V1_MAX_ADAPTER_ARRAY_ELEMENTS}`);
                return false;
            }
            for (let index = current.value.length - 1; index >= 0; index -= 1) {
                stack.push({ value: current.value[index], depth: current.depth + 1 });
            }
            continue;
        }
        objects += 1;
        const keys = Object.keys(current.value);
        properties += keys.length;
        if (objects > JSON_V1_MAX_ADAPTER_OBJECTS) {
            adapterIssue(issues, key, `对象数量不得超过 ${JSON_V1_MAX_ADAPTER_OBJECTS}`);
            return false;
        }
        if (properties > JSON_V1_MAX_ADAPTER_PROPERTIES) {
            adapterIssue(issues, key, `对象属性数量不得超过 ${JSON_V1_MAX_ADAPTER_PROPERTIES}`);
            return false;
        }
        const record = current.value;
        for (let index = keys.length - 1; index >= 0; index -= 1) {
            stack.push({ value: record[keys[index]], depth: current.depth + 1 });
        }
    }
    return true;
}
function normalizeJsonV1StaticText(value, maxCodePoints) {
    if (typeof value !== "string" || JSON_V1_STATIC_DISPLAY_FORBIDDEN_PATTERN.test(value))
        return null;
    const normalized = value.trim();
    const length = Array.from(normalized).length;
    return length >= 1 && length <= maxCodePoints ? normalized : null;
}
function validateJsonV1Path(value, key, issues) {
    if (!Array.isArray(value) || value.length < 1 || value.length > JSON_V1_MAX_PATH_SEGMENTS) {
        adapterIssue(issues, key, `应为包含 1-${JSON_V1_MAX_PATH_SEGMENTS} 个路径段的数组`);
        return undefined;
    }
    const path = [];
    for (let index = 0; index < value.length; index += 1) {
        const segment = value[index];
        if (typeof segment !== "string" ||
            Array.from(segment).length < 1 ||
            Array.from(segment).length > JSON_V1_MAX_PATH_SEGMENT_CODE_POINTS ||
            ASCII_OR_UNICODE_CONTROL_PATTERN.test(segment) ||
            JSON_V1_FORBIDDEN_PATH_SEGMENTS.has(segment)) {
            adapterIssue(issues, `${key}[${index}]`, "应为 1-64 个码点的安全属性段");
            continue;
        }
        path.push(segment);
    }
    return path.length === value.length ? path : undefined;
}
const JSON_V1_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;
export function normalizeJsonV1Timestamp(value, encoding) {
    let milliseconds;
    if (encoding === "iso-8601") {
        if (typeof value !== "string")
            return null;
        const match = JSON_V1_ISO_RE.exec(value);
        if (!match)
            return null;
        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        const hour = Number(match[4]);
        const minute = Number(match[5]);
        const second = Number(match[6]);
        const fraction = (match[7] ?? "").padEnd(3, "0");
        const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
        const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);
        if (year < 1970 ||
            month < 1 ||
            month > 12 ||
            day < 1 ||
            day > daysInMonth(year, month) ||
            hour > 23 ||
            minute > 59 ||
            second > 59 ||
            offsetHour > 14 ||
            offsetMinute > 59 ||
            (offsetHour === 14 && offsetMinute !== 0)) {
            return null;
        }
        const offset = match[8] === "Z"
            ? 0
            : (match[9] === "+" ? 1 : -1) * (offsetHour * 60 + offsetMinute) * 60_000;
        milliseconds = Date.UTC(year, month - 1, day, hour, minute, second, Number(fraction)) - offset;
    }
    else {
        if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
            return null;
        }
        milliseconds = encoding === "unix-seconds" ? value * 1_000 : value;
    }
    if (!Number.isSafeInteger(milliseconds) ||
        milliseconds < JSON_V1_MIN_TIMESTAMP_MS ||
        milliseconds > JSON_V1_MAX_TIMESTAMP_MS) {
        return null;
    }
    return new Date(milliseconds).toISOString();
}
function validateJsonV1NumberSource(value, key, issues) {
    if (!isRecord(value)) {
        adapterIssue(issues, key, "应为 path 或 literal 数值来源对象");
        return undefined;
    }
    const hasPath = hasOwnKey(value, "path");
    const hasLiteral = hasOwnKey(value, "literal");
    if (hasPath === hasLiteral) {
        adapterIssue(issues, key, "path 与 literal 必须二选一");
        return undefined;
    }
    if (hasPath) {
        validateKnownAdapterFields(value, ["path", "divideBy"], key, issues);
        const path = validateJsonV1Path(value.path, `${key}.path`, issues);
        if (hasOwnKey(value, "divideBy") &&
            (typeof value.divideBy !== "number" || !JSON_V1_DIVISORS.has(value.divideBy))) {
            adapterIssue(issues, `${key}.divideBy`, "应为 100、1000 或 1000000");
        }
        if (path &&
            (!hasOwnKey(value, "divideBy") ||
                (typeof value.divideBy === "number" && JSON_V1_DIVISORS.has(value.divideBy)))) {
            return {
                path,
                ...(value.divideBy !== undefined
                    ? { divideBy: value.divideBy }
                    : {}),
            };
        }
        return undefined;
    }
    validateKnownAdapterFields(value, ["literal"], key, issues);
    if (typeof value.literal !== "number" ||
        !Number.isFinite(value.literal) ||
        Math.abs(value.literal) > JSON_V1_MAX_NUMBER_MAGNITUDE) {
        adapterIssue(issues, `${key}.literal`, `应为绝对值不超过 ${JSON_V1_MAX_NUMBER_MAGNITUDE} 的有限数`);
        return undefined;
    }
    return { literal: value.literal };
}
function validateJsonV1TextSource(value, key, issues) {
    if (!isRecord(value)) {
        adapterIssue(issues, key, "应为 path 或 literal 文本来源对象");
        return undefined;
    }
    const hasPath = hasOwnKey(value, "path");
    const hasLiteral = hasOwnKey(value, "literal");
    if (hasPath === hasLiteral) {
        adapterIssue(issues, key, "path 与 literal 必须二选一");
        return undefined;
    }
    validateKnownAdapterFields(value, hasPath ? ["path"] : ["literal"], key, issues);
    if (hasPath) {
        const path = validateJsonV1Path(value.path, `${key}.path`, issues);
        return path ? { path } : undefined;
    }
    const literal = normalizeJsonV1StaticText(value.literal, JSON_V1_MAX_DISPLAY_CODE_POINTS);
    if (!literal) {
        adapterIssue(issues, `${key}.literal`, `去掉首尾空白后应为 1-${JSON_V1_MAX_DISPLAY_CODE_POINTS} 个可打印 Unicode 码点`);
        return undefined;
    }
    return { literal };
}
function validateJsonV1TimestampSource(value, key, issues) {
    if (!isRecord(value)) {
        adapterIssue(issues, key, "应为时间戳来源对象");
        return undefined;
    }
    const hasPath = hasOwnKey(value, "path");
    const hasLiteral = hasOwnKey(value, "literal");
    if (hasPath === hasLiteral) {
        adapterIssue(issues, key, "path 与 literal 必须二选一");
        return undefined;
    }
    validateKnownAdapterFields(value, hasPath ? ["path", "encoding"] : ["literal", "encoding"], key, issues);
    const encoding = value.encoding;
    if (typeof encoding !== "string" ||
        !JSON_V1_TIMESTAMP_ENCODINGS.has(encoding)) {
        adapterIssue(issues, `${key}.encoding`, 'expected "iso-8601", "unix-seconds", or "unix-milliseconds"');
        return undefined;
    }
    const typedEncoding = encoding;
    if (hasPath) {
        const path = validateJsonV1Path(value.path, `${key}.path`, issues);
        return path ? { path, encoding: typedEncoding } : undefined;
    }
    if (normalizeJsonV1Timestamp(value.literal, typedEncoding) === null) {
        adapterIssue(issues, `${key}.literal`, "所选编码下应为有效时间戳");
        return undefined;
    }
    return { literal: value.literal, encoding: typedEncoding };
}
function literalNumber(source) {
    return source && "literal" in source ? source.literal : undefined;
}
function requireLiteralNumber(source, key, issues, rule) {
    const value = literalNumber(source);
    if (value === undefined)
        return;
    if ((rule === "positive" && value <= 0) || (rule === "non-negative" && value < 0)) {
        adapterIssue(issues, `${key}.literal`, rule === "positive"
            ? "应为大于零的数"
            : "应为非负数");
    }
}
function validateJsonV1Metric(value, resultType, key, issues) {
    if (!isRecord(value)) {
        adapterIssue(issues, key, "应为带 type 的指标对象");
        return undefined;
    }
    if (typeof value.type !== "string") {
        adapterIssue(issues, `${key}.type`, "缺少这个必填字段");
        return undefined;
    }
    const issueStart = issues.length;
    switch (value.type) {
        case "percentage": {
            validateKnownAdapterFields(value, ["type", "percentage", "meaning"], key, issues);
            const percentage = validateJsonV1NumberSource(value.percentage, `${key}.percentage`, issues);
            if (value.meaning !== "remaining" && value.meaning !== "used") {
                adapterIssue(issues, `${key}.meaning`, 'expected "remaining" or "used"');
            }
            if (resultType && !["quota", "rate_limit", "budget"].includes(resultType)) {
                adapterIssue(issues, `${key}.type`, "percentage 与 resultType 不兼容");
            }
            const literal = literalNumber(percentage);
            if (literal !== undefined &&
                ((value.meaning === "remaining" && literal > 100) ||
                    (value.meaning === "used" && literal < 0))) {
                adapterIssue(issues, `${key}.percentage.literal`, value.meaning === "remaining"
                    ? "剩余百分比不得超过 100"
                    : "已用百分比必须非负");
            }
            return issueStart === issues.length && percentage
                ? { type: "percentage", percentage, meaning: value.meaning }
                : undefined;
        }
        case "used-limit": {
            validateKnownAdapterFields(value, ["type", "used", "limit"], key, issues);
            const used = validateJsonV1NumberSource(value.used, `${key}.used`, issues);
            const limit = validateJsonV1NumberSource(value.limit, `${key}.limit`, issues);
            requireLiteralNumber(used, `${key}.used`, issues, "non-negative");
            requireLiteralNumber(limit, `${key}.limit`, issues, "positive");
            if (resultType && !["quota", "rate_limit"].includes(resultType)) {
                adapterIssue(issues, `${key}.type`, "used-limit 与 resultType 不兼容");
            }
            return issueStart === issues.length && used && limit
                ? { type: "used-limit", used, limit }
                : undefined;
        }
        case "remaining-limit": {
            validateKnownAdapterFields(value, ["type", "remaining", "limit"], key, issues);
            const remaining = validateJsonV1NumberSource(value.remaining, `${key}.remaining`, issues);
            const limit = validateJsonV1NumberSource(value.limit, `${key}.limit`, issues);
            requireLiteralNumber(limit, `${key}.limit`, issues, "positive");
            const remainingLiteral = literalNumber(remaining);
            const limitLiteral = literalNumber(limit);
            if (remainingLiteral !== undefined &&
                limitLiteral !== undefined &&
                remainingLiteral > limitLiteral) {
                adapterIssue(issues, `${key}.remaining.literal`, "remaining 不得超过 limit");
            }
            if (resultType && !["quota", "rate_limit"].includes(resultType)) {
                adapterIssue(issues, `${key}.type`, "remaining-limit 与 resultType 不兼容");
            }
            return issueStart === issues.length && remaining && limit
                ? { type: "remaining-limit", remaining, limit }
                : undefined;
        }
        case "spend-budget": {
            validateKnownAdapterFields(value, ["type", "spend", "budget"], key, issues);
            const spend = validateJsonV1NumberSource(value.spend, `${key}.spend`, issues);
            const budget = validateJsonV1NumberSource(value.budget, `${key}.budget`, issues);
            requireLiteralNumber(spend, `${key}.spend`, issues, "non-negative");
            requireLiteralNumber(budget, `${key}.budget`, issues, "positive");
            if (resultType && resultType !== "budget") {
                adapterIssue(issues, `${key}.type`, "spend-budget 与 resultType 不兼容");
            }
            return issueStart === issues.length && spend && budget
                ? { type: "spend-budget", spend, budget }
                : undefined;
        }
        case "remaining-budget": {
            validateKnownAdapterFields(value, ["type", "remaining", "budget"], key, issues);
            const remaining = validateJsonV1NumberSource(value.remaining, `${key}.remaining`, issues);
            const budget = validateJsonV1NumberSource(value.budget, `${key}.budget`, issues);
            requireLiteralNumber(budget, `${key}.budget`, issues, "positive");
            const remainingLiteral = literalNumber(remaining);
            const budgetLiteral = literalNumber(budget);
            if (remainingLiteral !== undefined &&
                budgetLiteral !== undefined &&
                remainingLiteral > budgetLiteral) {
                adapterIssue(issues, `${key}.remaining.literal`, "remaining 不得超过 budget");
            }
            if (resultType && resultType !== "budget") {
                adapterIssue(issues, `${key}.type`, "remaining-budget 与 resultType 不兼容");
            }
            return issueStart === issues.length && remaining && budget
                ? { type: "remaining-budget", remaining, budget }
                : undefined;
        }
        case "value": {
            validateKnownAdapterFields(value, ["type", "valueType", "value"], key, issues);
            const source = validateJsonV1NumberSource(value.value, `${key}.value`, issues);
            const allowed = {
                used: ["quota", "rate_limit", "usage"],
                limit: ["quota", "rate_limit"],
                remaining: ["quota", "rate_limit"],
                balance: ["balance"],
                spend: ["spend"],
                budget: ["budget"],
            };
            if (typeof value.valueType !== "string" || !hasOwnKey(allowed, value.valueType)) {
                adapterIssue(issues, `${key}.valueType`, 'expected "used", "limit", "remaining", "balance", "spend", or "budget"');
            }
            else {
                if (!["remaining", "balance"].includes(value.valueType)) {
                    requireLiteralNumber(source, `${key}.value`, issues, "non-negative");
                }
                if (resultType && !allowed[value.valueType].includes(resultType)) {
                    adapterIssue(issues, `${key}.valueType`, "valueType 与 resultType 不兼容");
                }
            }
            return issueStart === issues.length && source
                ? {
                    type: "value",
                    valueType: value.valueType,
                    value: source,
                }
                : undefined;
        }
        case "status": {
            validateKnownAdapterFields(value, ["type", "value"], key, issues);
            const source = validateJsonV1TextSource(value.value, `${key}.value`, issues);
            if (resultType && resultType !== "status") {
                adapterIssue(issues, `${key}.type`, "status 与 resultType 不兼容");
            }
            return issueStart === issues.length && source ? { type: "status", value: source } : undefined;
        }
        default:
            adapterIssue(issues, `${key}.type`, "应为受支持的指标 type");
            return undefined;
    }
}
function validateJsonV1Mapping(value, key, providerLabel, issues) {
    if (!isRecord(value)) {
        adapterIssue(issues, key, "应为对象");
        return undefined;
    }
    const issueStart = issues.length;
    validateKnownAdapterFields(value, ["resultType", "name", "label", "unit", "unitPosition", "resetTime", "observedTime", "metric"], key, issues);
    for (const field of ["resultType", "name", "metric"]) {
        if (!hasOwnKey(value, field))
            adapterIssue(issues, `${key}.${field}`, "缺少这个必填字段");
    }
    const resultType = typeof value.resultType === "string" &&
        CUSTOM_RESULT_TYPES.has(value.resultType)
        ? value.resultType
        : undefined;
    if (hasOwnKey(value, "resultType") && !resultType) {
        adapterIssue(issues, `${key}.resultType`, "应为受支持的计费 resultType");
    }
    const name = normalizeJsonV1StaticText(value.name, JSON_V1_MAX_STATIC_NAME_CODE_POINTS);
    if (hasOwnKey(value, "name") && !name) {
        adapterIssue(issues, `${key}.name`, `去掉首尾空白后应为 1-${JSON_V1_MAX_STATIC_NAME_CODE_POINTS} 个可打印 Unicode 码点`);
    }
    else if (name &&
        Array.from(`${providerLabel} ${name}`).length > JSON_V1_MAX_DISPLAY_CODE_POINTS) {
        adapterIssue(issues, `${key}.name`, `带 provider 前缀的名称码点数不得超过 ${JSON_V1_MAX_DISPLAY_CODE_POINTS}`);
    }
    const label = value.label === undefined
        ? undefined
        : normalizeJsonV1StaticText(value.label, JSON_V1_MAX_STATIC_NAME_CODE_POINTS);
    if (value.label !== undefined && !label) {
        adapterIssue(issues, `${key}.label`, `去掉首尾空白后应为 1-${JSON_V1_MAX_STATIC_NAME_CODE_POINTS} 个可打印 Unicode 码点`);
    }
    const unit = value.unit === undefined
        ? undefined
        : normalizeJsonV1StaticText(value.unit, JSON_V1_MAX_STATIC_UNIT_CODE_POINTS);
    if (value.unit !== undefined && !unit) {
        adapterIssue(issues, `${key}.unit`, `去掉首尾空白后应为 1-${JSON_V1_MAX_STATIC_UNIT_CODE_POINTS} 个可打印 Unicode 码点`);
    }
    const unitPosition = value.unitPosition === "prefix" || value.unitPosition === "suffix"
        ? value.unitPosition
        : undefined;
    if (value.unitPosition !== undefined && !unitPosition) {
        adapterIssue(issues, `${key}.unitPosition`, 'expected "prefix" or "suffix"');
    }
    if ((unit === undefined) !== (unitPosition === undefined)) {
        adapterIssue(issues, `${key}.unitPosition`, "unit 与 unitPosition 必须同时配置");
    }
    const resetTime = value.resetTime === undefined
        ? undefined
        : validateJsonV1TimestampSource(value.resetTime, `${key}.resetTime`, issues);
    const observedTime = value.observedTime === undefined
        ? undefined
        : validateJsonV1TimestampSource(value.observedTime, `${key}.observedTime`, issues);
    const metric = validateJsonV1Metric(value.metric, resultType, `${key}.metric`, issues);
    if (metric && (metric.type === "percentage" || metric.type === "status") && unit !== undefined) {
        adapterIssue(issues, `${key}.unit`, "percentage 或 status 指标不允许单位");
    }
    if (issueStart !== issues.length || !resultType || !name || !metric)
        return undefined;
    return {
        resultType,
        name,
        ...(label ? { label } : {}),
        ...(unit ? { unit, unitPosition: unitPosition } : {}),
        ...(resetTime ? { resetTime } : {}),
        ...(observedTime ? { observedTime } : {}),
        metric,
    };
}
function validateJsonV1Adapter(value, key, providerLabel, issues) {
    if (!isRecord(value)) {
        adapterIssue(issues, key, "应为对象");
        return undefined;
    }
    if (!preflightJsonV1Adapter(value, key, issues))
        return undefined;
    const issueStart = issues.length;
    validateKnownAdapterFields(value, ["rowsPath", "mappings"], key, issues);
    const rowsPath = value.rowsPath === undefined
        ? undefined
        : validateJsonV1Path(value.rowsPath, `${key}.rowsPath`, issues);
    if (!hasOwnKey(value, "mappings")) {
        adapterIssue(issues, `${key}.mappings`, "缺少这个必填字段");
    }
    if (!Array.isArray(value.mappings) ||
        value.mappings.length < 1 ||
        value.mappings.length > JSON_V1_MAX_MAPPINGS) {
        adapterIssue(issues, `${key}.mappings`, `应为包含 1-${JSON_V1_MAX_MAPPINGS} 个映射的数组`);
        return undefined;
    }
    const mappings = [];
    // Each mapping's rows are keyed by its name, so two names must not give one key.
    const rowKeys = new Map();
    for (let index = 0; index < value.mappings.length; index += 1) {
        const mapping = validateJsonV1Mapping(value.mappings[index], `${key}.mappings[${index}]`, providerLabel, issues);
        if (!mapping)
            continue;
        mappings.push(mapping);
        const rowKey = customRowKey(mapping.name);
        const first = rowKeys.get(rowKey);
        if (first === undefined) {
            rowKeys.set(rowKey, index);
        }
        else {
            adapterIssue(issues, `${key}.mappings[${index}].name`, `与 ${key}.mappings[${first}].name 产生相同的行 id`);
        }
    }
    return issueStart === issues.length && mappings.length === value.mappings.length
        ? { ...(rowsPath ? { rowsPath } : {}), mappings }
        : undefined;
}
function validateModelIds(params) {
    if (!hasOwnKey(params.raw, "modelIds"))
        return undefined;
    const rawModelIds = params.raw.modelIds;
    if (!Array.isArray(rawModelIds) || rawModelIds.length === 0) {
        params.issues.push({
            key: `${params.providerKey}.modelIds`,
            message: "应为非空数组，元素为精确的 OpenCode 模型 id",
        });
        return undefined;
    }
    const modelIds = [];
    const seen = new Map();
    for (let index = 0; index < rawModelIds.length; index += 1) {
        const modelId = rawModelIds[index];
        const key = `${params.providerKey}.modelIds[${index}]`;
        if (typeof modelId !== "string" ||
            modelId.length === 0 ||
            MODEL_FORBIDDEN_PATTERN.test(modelId)) {
            params.issues.push({
                key,
                message: "模型 id 应精确且不含空白、控制字符、# 或 ?",
            });
            continue;
        }
        const first = seen.get(modelId);
        if (first !== undefined) {
            params.issues.push({
                key,
                message: `duplicates ${params.providerKey}.modelIds[${first}]`,
            });
            continue;
        }
        seen.set(modelId, index);
        modelIds.push(modelId);
    }
    return modelIds;
}
function validateWindows(raw, providerKey, issues) {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_WINDOWS) {
        issues.push({
            key: `${providerKey}.windows`,
            message: `应为包含 1-${MAX_WINDOWS} 个窗口的数组`,
        });
        return undefined;
    }
    const windows = [];
    const ids = new Map();
    for (let index = 0; index < raw.length; index += 1) {
        const item = raw[index];
        const windowKey = `${providerKey}.windows[${index}]`;
        if (!isRecord(item)) {
            issues.push({ key: windowKey, message: "应为对象" });
            continue;
        }
        // An unknown field is named by its position: its name is the caller's, never repeated.
        Object.keys(item).forEach((field, position) => {
            if (WINDOW_FIELDS.includes(field))
                return;
            issues.push({
                key: windowKey,
                message: `第 ${position + 1} 个字段未知；允许的字段：${WINDOW_FIELDS.join(", ")}`,
            });
        });
        for (const field of ["id", "type", "requestLimit"]) {
            if (!hasOwnKey(item, field)) {
                issues.push({ key: `${windowKey}.${field}`, message: "缺少这个必填字段" });
            }
        }
        const id = item.id;
        if (hasOwnKey(item, "id") && !isValidId(id)) {
            issues.push({
                key: `${windowKey}.id`,
                message: "应为 1-64 个 ASCII kebab-case 字符",
            });
        }
        else if (isValidId(id)) {
            const first = ids.get(id);
            if (first !== undefined) {
                issues.push({
                    key: `${windowKey}.id`,
                    message: `duplicates ${providerKey}.windows[${first}].id`,
                });
            }
            else {
                ids.set(id, index);
            }
        }
        const label = normalizeLabel(item.label, isValidId(id) ? id : undefined);
        if (hasOwnKey(item, "label") && label === null) {
            issues.push({
                key: `${windowKey}.label`,
                message: "去掉首尾空白后应为 1-80 个可打印 Unicode 码点",
            });
        }
        const type = item.type;
        if (hasOwnKey(item, "type") &&
            (typeof type !== "string" ||
                !QUOTA_PROVIDER_WINDOW_TYPES.includes(type))) {
            issues.push({
                key: `${windowKey}.type`,
                message: 'expected "utc-day" or "rolling"',
            });
        }
        let durationMinutes;
        if (type === "rolling") {
            if (!isPositiveInteger(item.durationMinutes, MAX_ROLLING_MINUTES)) {
                issues.push({
                    key: `${windowKey}.durationMinutes`,
                    message: `应为 1 到 ${MAX_ROLLING_MINUTES} 的整数`,
                });
            }
            else {
                durationMinutes = item.durationMinutes;
            }
        }
        else if (hasOwnKey(item, "durationMinutes")) {
            issues.push({
                key: `${windowKey}.durationMinutes`,
                message: "仅滚动窗口可用",
            });
        }
        if (!isPositiveInteger(item.requestLimit, MAX_SAFE_REQUEST_LIMIT)) {
            issues.push({
                key: `${windowKey}.requestLimit`,
                message: `应为 1 到 ${MAX_SAFE_REQUEST_LIMIT} 的整数`,
            });
        }
        if (hasOwnKey(item, "usdBudget") && !isPositiveFinite(item.usdBudget, MAX_USD_BUDGET)) {
            issues.push({
                key: `${windowKey}.usdBudget`,
                message: `应为大于 0 且不超过 ${MAX_USD_BUDGET} 的数`,
            });
        }
        if (isValidId(id) &&
            label !== null &&
            (type === "utc-day" || type === "rolling") &&
            (type !== "rolling" || durationMinutes !== undefined) &&
            isPositiveInteger(item.requestLimit, MAX_SAFE_REQUEST_LIMIT) &&
            (!hasOwnKey(item, "usdBudget") || isPositiveFinite(item.usdBudget, MAX_USD_BUDGET))) {
            windows.push({
                id,
                label,
                type,
                ...(durationMinutes !== undefined ? { durationMinutes } : {}),
                requestLimit: item.requestLimit,
                ...(item.usdBudget !== undefined ? { usdBudget: item.usdBudget } : {}),
            });
        }
    }
    return windows.length === raw.length ? windows : undefined;
}
function validateMaintainedWindows(id, windows, providerKey, issues) {
    if (!windows || !MAINTAINED_LOCAL_ESTIMATE_IDS.includes(id))
        return;
    const expected = [
        { id: "five-hour", type: "rolling", durationMinutes: 300 },
        { id: "weekly", type: "rolling", durationMinutes: 10_080 },
        { id: "monthly", type: "rolling", durationMinutes: 43_200 },
    ];
    if (windows.length !== expected.length ||
        expected.some((item, index) => {
            const window = windows[index];
            return (!window ||
                window.id !== item.id ||
                window.type !== item.type ||
                window.durationMinutes !== item.durationMinutes ||
                window.usdBudget !== undefined);
        })) {
        issues.push({
            key: `${providerKey}.windows`,
            message: "alibaba-coding-plan 调优要求按序提供 five-hour、weekly、monthly 滚动请求窗口",
        });
    }
}
function validatePricingModelMap(raw, providerKey, providerId, issues) {
    if (raw === undefined)
        return undefined;
    if (!isRecord(raw) || Object.keys(raw).length === 0) {
        issues.push({
            key: `${providerKey}.pricingModelMap`,
            message: "应为非空对象：源模型 id → models.dev provider/model id",
        });
        return undefined;
    }
    const key = `${providerKey}.pricingModelMap`;
    const sourceModelIds = Object.keys(raw);
    const result = {};
    for (const sourceModelId of [...sourceModelIds].sort()) {
        // An entry is named by its position: its source key is the caller's, never repeated.
        const entry = `entry ${sourceModelIds.indexOf(sourceModelId) + 1}`;
        const target = raw[sourceModelId];
        if (sourceModelId.length === 0 || MODEL_FORBIDDEN_PATTERN.test(sourceModelId)) {
            issues.push({
                key,
                message: `${entry}: source key must be an exact model id without whitespace or control characters`,
            });
            continue;
        }
        if (typeof target !== "string") {
            issues.push({ key, message: `${entry}: expected a models.dev provider/model string` });
            continue;
        }
        const automatic = resolvePricingKey({ providerID: providerId, modelID: sourceModelId });
        if (automatic.ok) {
            issues.push({
                key,
                message: `${entry}: automatic models.dev matching already resolves to ${automatic.key.provider}/${automatic.key.model}`,
            });
            continue;
        }
        const slash = target.indexOf("/");
        const targetProvider = slash > 0 ? target.slice(0, slash) : "";
        const targetModel = slash > 0 ? target.slice(slash + 1) : "";
        if (!targetProvider || !targetModel || !lookupCost(targetProvider, targetModel)) {
            issues.push({
                key,
                message: `${entry}: target must be an exact priced models.dev provider/model id`,
            });
            continue;
        }
        result[sourceModelId] = target;
    }
    return Object.keys(result).length === Object.keys(raw).length ? result : undefined;
}
/** Validate and normalize the complete global-only quotaProviders array atomically. */
export function validateQuotaProviders(value) {
    if (!Array.isArray(value)) {
        return { issues: [{ key: "quotaProviders", message: "应为数组" }] };
    }
    const issues = [];
    const definitions = [];
    const ids = new Map();
    const requestIdentities = new Map();
    const coverage = [];
    for (let index = 0; index < value.length; index += 1) {
        const raw = value[index];
        const providerKey = `quotaProviders[${index}]`;
        if (!isRecord(raw)) {
            issues.push({ key: providerKey, message: "应为对象" });
            continue;
        }
        const issueStart = issues.length;
        const mode = raw.mode;
        const allowedFields = mode === "local-estimate"
            ? LOCAL_FIELDS
            : mode === "remote-api"
                ? REMOTE_FIELDS
                : QUOTA_PROVIDER_FIELDS;
        // An unknown field is named by its position: its name is the caller's, never repeated.
        const modeName = QUOTA_PROVIDER_MODES.find((known) => known === mode) ?? "额度提供商";
        Object.keys(raw).forEach((field, position) => {
            if (allowedFields.includes(field))
                return;
            issues.push({
                key: providerKey,
                message: `${modeName} 模式下第 ${position + 1} 个字段未知；允许的字段：${allowedFields.join(", ")}`,
            });
        });
        for (const field of ["id", "mode"]) {
            if (!hasOwnKey(raw, field)) {
                issues.push({ key: `${providerKey}.${field}`, message: "缺少这个必填字段" });
            }
        }
        const id = raw.id;
        const idValid = isValidId(id);
        if (hasOwnKey(raw, "id") && !idValid) {
            issues.push({
                key: `${providerKey}.id`,
                message: "应为 1-64 个 ASCII kebab-case 字符",
            });
        }
        else if (idValid) {
            if (id === QUOTA_PROVIDERS_AGGREGATE_ID) {
                issues.push({
                    key: `${providerKey}.id`,
                    message: `"${QUOTA_PROVIDERS_AGGREGATE_ID}" is reserved for the aggregate provider`,
                });
            }
            const builtIn = getCanonicalQuotaProviderId(id);
            if (builtIn && !MAINTAINED_LOCAL_ESTIMATE_IDS.includes(id)) {
                issues.push({
                    key: `${providerKey}.id`,
                    message: `与内置额度提供商 id "${id}" 冲突`,
                });
            }
            const first = ids.get(id);
            if (first !== undefined) {
                issues.push({
                    key: `${providerKey}.id`,
                    message: `与 quotaProviders[${first}].id 重复`,
                });
            }
            else {
                ids.set(id, index);
            }
        }
        let providerId;
        if (!hasOwnKey(raw, "providerId")) {
            if (idValid)
                providerId = id;
        }
        else if (!isValidProviderId(raw.providerId)) {
            issues.push({
                key: `${providerKey}.providerId`,
                message: "应为 1-64 个小写 provider-id 字符",
            });
        }
        else if (raw.providerId === id) {
            issues.push({
                key: `${providerKey}.providerId`,
                message: "providerId 与 id 相同时请省略",
            });
        }
        else {
            providerId = raw.providerId;
        }
        const label = normalizeLabel(raw.label, idValid ? id : undefined);
        if (hasOwnKey(raw, "label") && label === null) {
            issues.push({
                key: `${providerKey}.label`,
                message: "去掉首尾空白后应为 1-80 个可打印 Unicode 码点",
            });
        }
        if (typeof mode !== "string" || !QUOTA_PROVIDER_MODES.includes(mode)) {
            issues.push({
                key: `${providerKey}.mode`,
                message: 'expected "remote-api" or "local-estimate"',
            });
        }
        const modelIds = validateModelIds({ raw, providerKey, issues });
        const enabled = raw.enabled;
        if (hasOwnKey(raw, "enabled") && typeof enabled !== "boolean") {
            issues.push({ key: `${providerKey}.enabled`, message: "应为 true 或 false" });
        }
        const switchField = typeof enabled === "boolean" ? { enabled } : {};
        const modelIdsValid = !hasOwnKey(raw, "modelIds") ||
            (Array.isArray(raw.modelIds) && modelIds?.length === raw.modelIds.length);
        if (idValid &&
            MAINTAINED_LOCAL_ESTIMATE_IDS.includes(id) &&
            mode !== "local-estimate") {
            issues.push({
                key: `${providerKey}.mode`,
                message: `${id} tuning must use local-estimate mode`,
            });
        }
        if (mode === "remote-api") {
            for (const field of ["url", "format"]) {
                if (!hasOwnKey(raw, field)) {
                    issues.push({ key: `${providerKey}.${field}`, message: "缺少这个必填字段" });
                }
            }
            const normalizedUrl = hasOwnKey(raw, "url")
                ? normalizeRemoteUrl(raw.url)
                : { value: undefined };
            if (normalizedUrl.message) {
                issues.push({ key: `${providerKey}.url`, message: normalizedUrl.message });
            }
            const rawFormat = raw.format;
            const format = rawFormat === "accounting-v1" ? "quota-v1" : rawFormat;
            const formatValid = typeof format === "string" &&
                QUOTA_PROVIDER_REMOTE_FORMATS.includes(format);
            if (hasOwnKey(raw, "format") && !formatValid) {
                issues.push({
                    key: `${providerKey}.format`,
                    message: 'expected "quota-v1", "openrouter-key-v1", or "json-v1"',
                });
            }
            let adapter;
            if (format === "json-v1") {
                if (!hasOwnKey(raw, "adapter")) {
                    issues.push({ key: `${providerKey}.adapter`, message: "缺少这个必填字段" });
                }
                else if (label) {
                    adapter = validateJsonV1Adapter(raw.adapter, `${providerKey}.adapter`, label, issues);
                }
            }
            else if (hasOwnKey(raw, "adapter")) {
                issues.push({
                    key: `${providerKey}.adapter`,
                    message: "仅 json-v1 格式可用",
                });
            }
            const apiKeyEnv = raw.apiKeyEnv;
            if (hasOwnKey(raw, "apiKeyEnv") &&
                (typeof apiKeyEnv !== "string" ||
                    apiKeyEnv.length > MAX_ENV_NAME_LENGTH ||
                    !ENV_NAME_PATTERN.test(apiKeyEnv))) {
                issues.push({
                    key: `${providerKey}.apiKeyEnv`,
                    message: "最多 128 个字符且匹配 ^[A-Z_][A-Z0-9_]*$",
                });
            }
            if (providerId && normalizedUrl.value && formatValid) {
                const identity = JSON.stringify([providerId, normalizedUrl.value, format, apiKeyEnv ?? ""]);
                const first = requestIdentities.get(identity);
                if (first !== undefined) {
                    issues.push({
                        key: `${providerKey}.url`,
                        message: `与 quotaProviders[${first}] 的请求标识重复`,
                    });
                }
                else {
                    requestIdentities.set(identity, index);
                }
            }
            if (issueStart === issues.length &&
                idValid &&
                providerId &&
                label &&
                normalizedUrl.value &&
                formatValid) {
                const common = {
                    id,
                    providerId,
                    label,
                    mode: "remote-api",
                    url: normalizedUrl.value,
                    ...(apiKeyEnv !== undefined ? { apiKeyEnv: apiKeyEnv } : {}),
                    ...(modelIds ? { modelIds } : {}),
                    ...switchField,
                };
                definitions.push({
                    index,
                    config: format === "json-v1"
                        ? { ...common, format, adapter: adapter }
                        : {
                            ...common,
                            format: format,
                        },
                });
            }
        }
        else if (mode === "local-estimate") {
            if (!hasOwnKey(raw, "windows")) {
                issues.push({ key: `${providerKey}.windows`, message: "缺少这个必填字段" });
            }
            const windows = validateWindows(raw.windows, providerKey, issues);
            if (idValid)
                validateMaintainedWindows(id, windows, providerKey, issues);
            const pricingModelMap = providerId && hasOwnKey(raw, "pricingModelMap")
                ? validatePricingModelMap(raw.pricingModelMap, providerKey, providerId, issues)
                : undefined;
            if (issueStart === issues.length && idValid && providerId && label && windows) {
                definitions.push({
                    index,
                    config: {
                        id,
                        providerId,
                        label,
                        mode,
                        windows,
                        ...(modelIds ? { modelIds } : {}),
                        ...(pricingModelMap ? { pricingModelMap } : {}),
                        ...switchField,
                    },
                });
            }
        }
        if (providerId && modelIdsValid) {
            coverage.push({ index, providerId, ...(modelIds ? { modelIds } : {}) });
        }
    }
    for (let index = 0; index < coverage.length; index += 1) {
        const current = coverage[index];
        for (let earlierIndex = 0; earlierIndex < index; earlierIndex += 1) {
            const earlier = coverage[earlierIndex];
            if (current.providerId !== earlier.providerId)
                continue;
            const overlap = current.modelIds === undefined ||
                earlier.modelIds === undefined ||
                current.modelIds.some((modelId) => earlier.modelIds.includes(modelId));
            if (!overlap)
                continue;
            issues.push({
                key: current.modelIds
                    ? `quotaProviders[${current.index}].modelIds`
                    : `quotaProviders[${current.index}].providerId`,
                message: `providerId "${current.providerId}" 的 provider/model 覆盖范围与 quotaProviders[${earlier.index}] 重叠`,
            });
        }
    }
    if (issues.length > 0)
        return { issues };
    return { value: definitions.map((item) => cloneDefinition(item.config)), issues: [] };
}
export function cloneQuotaProviders(definitions) {
    return definitions.map(cloneDefinition);
}
export function findQuotaProviderDefinition(definitions, id) {
    return definitions.find((definition) => definition.id === id);
}
