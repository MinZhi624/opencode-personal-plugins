import { accountingUnitsEqual, isCanonicalAccountingDecimal } from "./accounting-format.js";
import { sanitizeQuotaProviderResult, sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import { cloneQuotaToastEntry } from "./entries.js";
import { isFixedWindowProjectionEvidence } from "./quota-exhaustion-projection.js";
export const QUOTA_PROVIDER_CACHE_VERSION = 3;
export function cloneQuotaProviderResult(result) {
    return {
        attempted: result.attempted,
        entries: result.entries.map(cloneQuotaToastEntry),
        errors: result.errors.map((error) => ({ ...error })),
        ...(result.diagnostics
            ? {
                diagnostics: result.diagnostics.map((diagnostic) => ({
                    ...diagnostic,
                    modelIds: diagnostic.modelIds ? [...diagnostic.modelIds] : null,
                    checkedPaths: [...diagnostic.checkedPaths],
                    authPaths: [...diagnostic.authPaths],
                })),
            }
            : {}),
        ...(result.statusDetails
            ? { statusDetails: result.statusDetails.map((detail) => ({ ...detail })) }
            : {}),
        ...(result.rawDetails
            ? { rawDetails: result.rawDetails.map((detail) => ({ ...detail })) }
            : {}),
        ...(result.presentation ? { presentation: { ...result.presentation } } : {}),
    };
}
function hasOnlyKeys(value, allowed) {
    const allowedKeys = new Set(allowed);
    return Object.keys(value).every((key) => allowedKeys.has(key));
}
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function isDenseArray(value) {
    if (!Array.isArray(value))
        return false;
    for (let index = 0; index < value.length; index += 1) {
        if (!(index in value))
            return false;
    }
    return true;
}
function isOneOf(value, choices) {
    return typeof value === "string" && choices.includes(value);
}
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SAFE_NAMED_METRIC_RE = /^[\p{L}\p{N}][\p{L}\p{N} .+&()_-]*$/u;
const SAFE_CUSTOM_SYMBOL_RE = /^[\p{L}\p{N}._-]+$/u;
function isOptionalIsoTimestamp(value) {
    return (value === undefined ||
        (typeof value === "string" &&
            ISO_TIMESTAMP_RE.test(value) &&
            Number.isFinite(Date.parse(value))));
}
function isAccountingMetadata(value) {
    if (!isRecord(value))
        return false;
    return (hasOnlyKeys(value, [
        "resultType",
        "acquisitionMethod",
        "ownership",
        "authority",
        "sourceId",
        "observedAtIso",
    ]) &&
        isOneOf(value.resultType, [
            "quota",
            "rate_limit",
            "usage",
            "spend",
            "budget",
            "balance",
            "status",
        ]) &&
        isOneOf(value.acquisitionMethod, [
            "remote_api",
            "dashboard_scrape",
            "local_cli",
            "local_runtime_accounting",
            "local_estimation",
        ]) &&
        isOneOf(value.ownership, ["maintained", "user_configured"]) &&
        isOneOf(value.authority, ["provider_reported", "locally_derived"]) &&
        (value.sourceId === undefined || typeof value.sourceId === "string") &&
        isOptionalIsoTimestamp(value.observedAtIso));
}
function isAccountingMetric(value, safeText) {
    if (!isRecord(value))
        return false;
    if (value.kind === "aggregate")
        return hasOnlyKeys(value, ["kind"]);
    if (value.kind === "window") {
        return (hasOnlyKeys(value, ["kind", "window"]) &&
            isOneOf(value.window, [
                "rpm",
                "hour",
                "five_hour",
                "day",
                "week",
                "month",
                "year",
                "mcp",
                "code_review",
            ]));
    }
    if (value.kind === "component") {
        return (hasOnlyKeys(value, ["kind", "component"]) &&
            isOneOf(value.component, [
                "current_balance",
                "total_balance",
                "cash_balance",
                "gift_balance",
                "granted_balance",
                "topped_up_balance",
                "remaining_credits",
                "auto_reload",
                "auto_reload_amount",
                "auto_reload_trigger",
            ]));
    }
    if (value.kind !== "named" || !hasOnlyKeys(value, ["kind", "name"]))
        return false;
    if (typeof value.name !== "string" || value.name.length > 64)
        return false;
    return (!safeText ||
        (value.name.length > 0 &&
            sanitizeSingleLineDisplayText(value.name) === value.name &&
            SAFE_NAMED_METRIC_RE.test(value.name)));
}
function isAccountingSemantic(value, safeText) {
    return (isRecord(value) &&
        hasOnlyKeys(value, ["metric", "prominence"]) &&
        isAccountingMetric(value.metric, safeText) &&
        isOneOf(value.prominence, ["primary", "supplementary"]));
}
function isAccountingUnit(value, safeText) {
    if (!isRecord(value))
        return false;
    if (value.kind === "currency") {
        return (hasOnlyKeys(value, ["kind", "code"]) &&
            typeof value.code === "string" &&
            /^[A-Z]{3}$/u.test(value.code));
    }
    if (value.kind === "count") {
        return (hasOnlyKeys(value, ["kind", "unit"]) &&
            isOneOf(value.unit, ["request", "token", "credit", "message", "interaction", "unit"]));
    }
    if (value.kind !== "custom" || !hasOnlyKeys(value, ["kind", "symbol"]))
        return false;
    if (typeof value.symbol !== "string" || value.symbol.length > 16)
        return false;
    return (!safeText ||
        (value.symbol.length > 0 &&
            sanitizeSingleLineDisplayText(value.symbol) === value.symbol &&
            SAFE_CUSTOM_SYMBOL_RE.test(value.symbol)));
}
function isAccountingQuantity(value, safeText) {
    return (isRecord(value) &&
        hasOnlyKeys(value, ["decimal", "unit"]) &&
        typeof value.decimal === "string" &&
        isCanonicalAccountingDecimal(value.decimal) &&
        isAccountingUnit(value.unit, safeText));
}
function isAccountingBasisFact(value, safeText, allowNegative = false) {
    return (isRecord(value) &&
        hasOnlyKeys(value, ["quantity", "authority"]) &&
        isAccountingQuantity(value.quantity, safeText) &&
        (allowNegative || !value.quantity.decimal.startsWith("-")) &&
        isOneOf(value.authority, ["provider_reported", "locally_derived", "user_configured"]));
}
function isAccountingPercentageBasis(value, safeText) {
    if (!isRecord(value) || !hasOnlyKeys(value, ["used", "limit", "remaining"]))
        return false;
    const facts = [value.used, value.limit, value.remaining].filter((fact) => fact !== undefined);
    if (facts.length === 0 ||
        (value.used !== undefined && !isAccountingBasisFact(value.used, safeText)) ||
        (value.limit !== undefined && !isAccountingBasisFact(value.limit, safeText)) ||
        (value.remaining !== undefined && !isAccountingBasisFact(value.remaining, safeText, true))) {
        return false;
    }
    const firstFact = facts[0];
    if (!firstFact)
        return false;
    const firstUnit = firstFact.quantity.unit;
    return facts.every((fact) => accountingUnitsEqual(fact.quantity.unit, firstUnit));
}
const COMMON_ENTRY_KEYS = [
    "accounting",
    "kind",
    "name",
    "resetTimeIso",
    "group",
    "label",
    "metricLabel",
    "semantic",
    "right",
    "sortPriority",
];
function hasValidEntryBase(entry, safeText) {
    return (isAccountingMetadata(entry.accounting) &&
        typeof entry.name === "string" &&
        isOptionalIsoTimestamp(entry.resetTimeIso) &&
        (entry.sortPriority === undefined ||
            (typeof entry.sortPriority === "number" && Number.isFinite(entry.sortPriority))) &&
        ["group", "label", "metricLabel", "right"].every((key) => entry[key] === undefined || typeof entry[key] === "string") &&
        (entry.semantic === undefined || isAccountingSemantic(entry.semantic, safeText)));
}
function isQuotaToastEntry(value, safeText) {
    if (!isRecord(value) || !hasValidEntryBase(value, safeText))
        return false;
    if (value.kind === "value") {
        return hasOnlyKeys(value, [...COMMON_ENTRY_KEYS, "value"]) && typeof value.value === "string";
    }
    if (value.kind === "quantity") {
        return (hasOnlyKeys(value, [...COMMON_ENTRY_KEYS, "quantity"]) &&
            isAccountingSemantic(value.semantic, safeText) &&
            isAccountingQuantity(value.quantity, safeText));
    }
    if (value.kind === "boolean") {
        return (hasOnlyKeys(value, [...COMMON_ENTRY_KEYS, "value"]) &&
            isAccountingSemantic(value.semantic, safeText) &&
            typeof value.value === "boolean");
    }
    return ((value.kind === undefined || value.kind === "percent") &&
        hasOnlyKeys(value, [...COMMON_ENTRY_KEYS, "percentRemaining", "basis", "fixedWindow"]) &&
        typeof value.percentRemaining === "number" &&
        Number.isFinite(value.percentRemaining) &&
        (value.basis === undefined || isAccountingPercentageBasis(value.basis, safeText)) &&
        (value.fixedWindow === undefined ||
            isFixedWindowProjectionEvidence(value.fixedWindow, value.resetTimeIso)));
}
function isQuotaToastError(value) {
    if (!isRecord(value))
        return false;
    return (hasOnlyKeys(value, ["label", "message", "retryable", "kind"]) &&
        typeof value.label === "string" &&
        typeof value.message === "string" &&
        (value.retryable === undefined || typeof value.retryable === "boolean") &&
        (value.kind === undefined || value.kind === "intentional-filter"));
}
function isQuotaProviderDiagnostic(value) {
    if (!isRecord(value))
        return false;
    return (hasOnlyKeys(value, [
        "sourceId",
        "providerId",
        "mode",
        "format",
        "modelIds",
        "apiKeyEnv",
        "selected",
        "attempted",
        "credentialSource",
        "outcome",
        "httpStatus",
        "entryCount",
        "checkedPaths",
        "authPaths",
        "statePath",
        "stateHealth",
        "stateVersion",
        "stateLastUpdatedAt",
    ]) &&
        typeof value.sourceId === "string" &&
        typeof value.providerId === "string" &&
        isOneOf(value.mode, ["remote-api", "local-estimate"]) &&
        (value.format === undefined ||
            isOneOf(value.format, ["quota-v1", "openrouter-key-v1", "json-v1"])) &&
        (value.mode === "remote-api" ? value.format !== undefined : value.format === undefined) &&
        (value.modelIds === null ||
            (isDenseArray(value.modelIds) &&
                value.modelIds.every((modelId) => typeof modelId === "string"))) &&
        (value.apiKeyEnv === null || typeof value.apiKeyEnv === "string") &&
        value.selected === true &&
        typeof value.attempted === "boolean" &&
        (value.credentialSource === null ||
            isOneOf(value.credentialSource, [
                "explicit_env",
                "global_opencode_json",
                "global_opencode_jsonc",
                "auth_json",
            ])) &&
        isOneOf(value.outcome, [
            "missing_credential",
            "success",
            "http_error",
            "redirect_error",
            "timeout",
            "body_too_large",
            "invalid_content_type",
            "invalid_json",
            "invalid_response",
            "network_error",
            "local_state_error",
        ]) &&
        (value.httpStatus === undefined ||
            (typeof value.httpStatus === "number" &&
                Number.isInteger(value.httpStatus) &&
                value.httpStatus >= 100 &&
                value.httpStatus <= 599)) &&
        typeof value.entryCount === "number" &&
        Number.isInteger(value.entryCount) &&
        value.entryCount >= 0 &&
        isDenseArray(value.checkedPaths) &&
        value.checkedPaths.every((path) => typeof path === "string") &&
        isDenseArray(value.authPaths) &&
        value.authPaths.every((path) => typeof path === "string") &&
        (value.statePath === undefined || typeof value.statePath === "string") &&
        (value.stateHealth === undefined ||
            isOneOf(value.stateHealth, ["missing", "healthy", "malformed", "version_mismatch"])) &&
        (value.stateVersion === undefined ||
            value.stateVersion === null ||
            (typeof value.stateVersion === "number" &&
                Number.isInteger(value.stateVersion) &&
                value.stateVersion >= 0)) &&
        (value.stateLastUpdatedAt === undefined ||
            value.stateLastUpdatedAt === null ||
            (typeof value.stateLastUpdatedAt === "number" && Number.isFinite(value.stateLastUpdatedAt))));
}
function isQuotaProviderStatusDetail(value) {
    return (isRecord(value) &&
        hasOnlyKeys(value, ["key", "value"]) &&
        typeof value.key === "string" &&
        typeof value.value === "string");
}
function isQuotaProviderPresentation(value) {
    if (!isRecord(value))
        return false;
    return (hasOnlyKeys(value, [
        "singleWindowDisplayName",
        "singleWindowShowRight",
        "redundantQuotaFamily",
        "classicStrategy",
    ]) &&
        (value.singleWindowDisplayName === undefined ||
            typeof value.singleWindowDisplayName === "string") &&
        (value.singleWindowShowRight === undefined ||
            typeof value.singleWindowShowRight === "boolean") &&
        (value.redundantQuotaFamily === undefined || typeof value.redundantQuotaFamily === "string") &&
        (value.classicStrategy === undefined || value.classicStrategy === "preserve"));
}
function isQuotaProviderResult(value, safeText) {
    if (!isRecord(value))
        return false;
    return (hasOnlyKeys(value, [
        "attempted",
        "entries",
        "errors",
        "diagnostics",
        "statusDetails",
        "rawDetails",
        "presentation",
    ]) &&
        typeof value.attempted === "boolean" &&
        isDenseArray(value.entries) &&
        value.entries.every((entry) => isQuotaToastEntry(entry, safeText)) &&
        isDenseArray(value.errors) &&
        value.errors.every(isQuotaToastError) &&
        (value.diagnostics === undefined ||
            (isDenseArray(value.diagnostics) && value.diagnostics.every(isQuotaProviderDiagnostic))) &&
        (value.statusDetails === undefined ||
            (isDenseArray(value.statusDetails) &&
                value.statusDetails.every(isQuotaProviderStatusDetail))) &&
        (value.rawDetails === undefined ||
            (isDenseArray(value.rawDetails) && value.rawDetails.every(isQuotaProviderStatusDetail))) &&
        (value.presentation === undefined || isQuotaProviderPresentation(value.presentation)));
}
export function normalizeQuotaProviderResult(value) {
    if (!isQuotaProviderResult(value, false))
        return null;
    const sanitized = sanitizeQuotaProviderResult(value);
    return isQuotaProviderResult(sanitized, true) ? cloneQuotaProviderResult(sanitized) : null;
}
export function encodePersistedQuotaProviderCacheEntry(value) {
    return {
        version: QUOTA_PROVIDER_CACHE_VERSION,
        packageVersion: value.packageVersion,
        key: value.key,
        providerId: value.providerId,
        timestamp: value.timestamp,
        result: cloneQuotaProviderResult(value.result),
    };
}
function isPersistedQuotaProviderCacheEnvelope(value, expected) {
    return (isRecord(value) &&
        hasOnlyKeys(value, ["version", "packageVersion", "key", "providerId", "timestamp", "result"]) &&
        value.version === QUOTA_PROVIDER_CACHE_VERSION &&
        value.packageVersion === expected.packageVersion &&
        value.key === expected.key &&
        value.providerId === expected.providerId &&
        typeof value.timestamp === "number" &&
        Number.isFinite(value.timestamp));
}
export function decodePersistedQuotaProviderCacheEntry(value, expected) {
    if (!isPersistedQuotaProviderCacheEnvelope(value, expected))
        return null;
    const result = normalizeQuotaProviderResult(value.result);
    if (!result)
        return null;
    return {
        version: QUOTA_PROVIDER_CACHE_VERSION,
        packageVersion: expected.packageVersion,
        key: expected.key,
        providerId: expected.providerId,
        timestamp: value.timestamp,
        result,
    };
}
