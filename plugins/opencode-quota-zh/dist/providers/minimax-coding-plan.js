/**
 * MiniMax Token Plan provider wrapper.
 *
 * Fetches quota data from MiniMax API for Token Plan users and emits entries with
 * the structured accounting core: `basis` (used/limit/remaining facts with
 * authority), `semantic` (metric + prominence), and `accounting` metadata.
 */
import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import { fetchWithTimeout } from "../lib/http.js";
import { DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS, getMiniMaxAuthDiagnostics, getMiniMaxChinaAuthDiagnostics, resolveMiniMaxAuthCached, resolveMiniMaxChinaAuthCached, } from "../lib/minimax-auth.js";
import { getMiniMaxQuotaEndpoint } from "../lib/minimax-endpoints.js";
import { isAnyProviderIdAvailable, isCanonicalProviderAvailable, } from "../lib/provider-availability.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import { accountingDecimalFromNumber } from "./accounting-decimal.js";
import { apiKeyStatusDetails, attemptedErrorResult, attemptedResult, notAttemptedResult, statusDetailsFromRecord, withStatusDetails, } from "./result-helpers.js";
const MINIMAX_PROVIDER_LABEL = "MiniMax Token Plan";
const MINIMAX_CHINA_PROVIDER_LABEL = "MiniMax Token Plan (CN)";
const USER_AGENT = "OpenCode-Quota-Toast/1.0";
const MINIMAX_TOKEN_PLAN_ACCOUNTING = {
    resultType: "quota",
    acquisitionMethod: "remote_api",
    ownership: "maintained",
    authority: "provider_reported",
};
const REQUEST_UNIT = { kind: "count", unit: "request" };
const MINIMAX_WINDOW_SPECS = [
    {
        window: "five_hour",
        semanticWindow: "five_hour",
        name: "minimax-token-plan-5h",
        label: "5h:",
        getTotal: (model) => model.current_interval_total_count,
        getCount: (model) => model.current_interval_usage_count,
        getResetOffsetMs: (model) => model.remains_time,
        getPercentRemaining: (model) => model.current_interval_remaining_percent,
    },
    {
        window: "week",
        semanticWindow: "week",
        name: "minimax-token-plan-week",
        label: "Weekly:",
        getTotal: (model) => model.current_weekly_total_count,
        getCount: (model) => model.current_weekly_usage_count,
        getResetOffsetMs: (model) => model.weekly_remains_time,
        getPercentRemaining: (model) => model.current_weekly_remaining_percent,
    },
];
function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}
/**
 * Type guard that validates a value is a well-formed MiniMax model record.
 *
 * Accepts the existing count shape or the international endpoint's percentage
 * fallback shape. A finite 5-hour reset offset remains required.
 */
function isMiniMaxModelRecord(value) {
    if (value === null || typeof value !== "object" || !("model_name" in value))
        return false;
    const v = value;
    if (typeof v.model_name !== "string" || !isFiniteNumber(v.remains_time))
        return false;
    const hasCounts = isFiniteNumber(v.current_interval_total_count) &&
        isFiniteNumber(v.current_interval_usage_count);
    const hasPercent = isFiniteNumber(v.current_interval_remaining_percent);
    return hasCounts || hasPercent;
}
function roundPercent(value) {
    return Math.min(100, Math.round(value));
}
/** Wrap a numeric value in an `AccountingQuantity` for the basis facts. */
function quantity(value, unit) {
    return { decimal: accountingDecimalFromNumber(value), unit };
}
function sanitizeMiniMaxMessage(text, maxLength = 120) {
    const sanitized = sanitizeDisplayText(text).replace(/\s+/g, " ").trim();
    return (sanitized || "unknown").slice(0, maxLength);
}
function normalizeMiniMaxCounts(total, rawCount, countSemantics) {
    if (countSemantics === "used") {
        const used = Math.max(0, rawCount);
        return { used, remaining: total - used };
    }
    const remaining = Math.min(total, rawCount);
    return { used: total - remaining, remaining };
}
/** Compute the structured accounting fields for one quota window. */
function computeMiniMaxEntryData(total, rawCount, percentRaw, resetOffsetMs, endpointId) {
    const resetTimeIso = new Date(Date.now() + Math.max(0, resetOffsetMs)).toISOString();
    // Old plan row: derive used/total from rawCount with endpoint-specific semantics.
    if (isFiniteNumber(total) && total > 0 && isFiniteNumber(rawCount)) {
        const countSemantics = endpointId === "china" ? "used" : "remaining";
        const { used, remaining } = normalizeMiniMaxCounts(total, rawCount, countSemantics);
        const percentRemaining = roundPercent((remaining / total) * 100);
        const basis = {
            used: {
                quantity: quantity(used, REQUEST_UNIT),
                authority: countSemantics === "used" ? "provider_reported" : "locally_derived",
            },
            limit: { quantity: quantity(total, REQUEST_UNIT), authority: "provider_reported" },
            remaining: {
                quantity: quantity(remaining, REQUEST_UNIT),
                authority: countSemantics === "remaining" ? "provider_reported" : "locally_derived",
            },
        };
        return { basis, percentRemaining, resetTimeIso };
    }
    // New plan row (general bucket, total=0): only a percent is available from the API.
    // Skip the basis — a single percent-only fact would just duplicate percentRemaining in the display.
    if (!isFiniteNumber(percentRaw))
        return null;
    const percentRemaining = roundPercent(percentRaw);
    return { basis: undefined, percentRemaining, resetTimeIso };
}
function isMiniMaxCodingModelName(modelName) {
    const normalized = modelName.trim().toLowerCase();
    if (normalized === "minimax-m*" || normalized.startsWith("minimax-m")) {
        return true;
    }
    return normalized === "general";
}
function buildMiniMaxEntry(model, spec, providerLabel, endpointId) {
    const resetOffsetMs = spec.getResetOffsetMs(model);
    if (!isFiniteNumber(resetOffsetMs))
        return null;
    const data = computeMiniMaxEntryData(spec.getTotal(model), spec.getCount(model), endpointId === "international" || model.model_name.trim().toLowerCase() === "general"
        ? spec.getPercentRemaining(model)
        : undefined, resetOffsetMs, endpointId);
    if (!data)
        return null;
    const semantic = {
        metric: { kind: "window", window: spec.semanticWindow },
        prominence: "primary",
    };
    return {
        name: spec.name,
        group: providerLabel,
        label: spec.label,
        percentRemaining: data.percentRemaining,
        ...(data.basis ? { basis: data.basis } : {}),
        resetTimeIso: data.resetTimeIso,
        semantic,
        accounting: MINIMAX_TOKEN_PLAN_ACCOUNTING,
    };
}
function buildMiniMaxEntries(model, providerLabel, endpointId) {
    return MINIMAX_WINDOW_SPECS.flatMap((spec) => {
        const entry = buildMiniMaxEntry(model, spec, providerLabel, endpointId);
        return entry ? [entry] : [];
    });
}
function getWorstPercent(model, endpointId) {
    const percents = buildMiniMaxEntries(model, MINIMAX_PROVIDER_LABEL, endpointId).flatMap((entry) => ("percentRemaining" in entry ? [entry.percentRemaining] : []));
    return percents.length > 0 ? Math.min(...percents) : Number.POSITIVE_INFINITY;
}
function selectCanonicalMiniMaxModel(models, endpointId) {
    if (models.length === 0)
        return null;
    const wildcardModel = models.find((model) => model.model_name.trim().toLowerCase() === "minimax-m*") ?? null;
    if (wildcardModel && Number.isFinite(getWorstPercent(wildcardModel, endpointId))) {
        return wildcardModel;
    }
    return ([...models].sort((left, right) => {
        const percentDiff = getWorstPercent(left, endpointId) - getWorstPercent(right, endpointId);
        if (percentDiff !== 0)
            return percentDiff;
        return left.model_name.localeCompare(right.model_name);
    })[0] ?? null);
}
/**
 * Fetch MiniMax Token Plan quota from the API.
 *
 * Parses usage for MiniMax Token Plan models returned by the selected endpoint.
 *
 * @param apiKey - MiniMax API key
 * @returns Quota entries on success, error on failure, or empty entries when
 *          the API returns successfully but no models have reportable quota.
 */
export async function queryMiniMaxQuota(apiKey, options = {}) {
    const endpointId = options.endpoint ?? "international";
    const endpoint = getMiniMaxQuotaEndpoint(endpointId);
    try {
        return await fetchWithTimeout(endpoint.quotaUrl, {
            request: {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "User-Agent": USER_AGENT,
                },
            },
            timeoutMs: options.requestTimeoutMs,
            consume: async (response) => {
                if (!response.ok) {
                    const text = await response.text();
                    return attemptedErrorResult(options.label ?? MINIMAX_PROVIDER_LABEL, `MiniMax API error ${response.status}: ${sanitizeMiniMaxMessage(text, 120)}`);
                }
                const payload = (await response.json());
                if (payload.base_resp?.status_code !== 0) {
                    return attemptedErrorResult(options.label ?? MINIMAX_PROVIDER_LABEL, `MiniMax API error: ${sanitizeMiniMaxMessage(payload.base_resp?.status_msg ?? "unknown")}`);
                }
                const matchingModels = (payload.model_remains ?? []).filter((model) => isMiniMaxModelRecord(model) && isMiniMaxCodingModelName(model.model_name));
                const canonicalModel = selectCanonicalMiniMaxModel(matchingModels, endpointId);
                const entries = canonicalModel
                    ? buildMiniMaxEntries(canonicalModel, options.label ?? MINIMAX_PROVIDER_LABEL, endpointId)
                    : [];
                return attemptedResult(entries);
            },
        });
    }
    catch (err) {
        return attemptedErrorResult(options.label ?? MINIMAX_PROVIDER_LABEL, sanitizeMiniMaxMessage(err instanceof Error ? err.message : String(err)));
    }
}
function isMiniMaxChinaExplicitlyEnabled(context) {
    if (!context || context.enabledProviders === "auto")
        return false;
    return context.enabledProviders.some((providerId) => normalizeQuotaProviderId(providerId) === "minimax-china-coding-plan");
}
function matchesMiniMaxCurrentModel(model, spec, context) {
    const [provider = "", modelId] = model.toLowerCase().split("/", 2);
    if (!modelId || !isMiniMaxCodingModelName(modelId))
        return false;
    const normalizedProvider = normalizeQuotaProviderId(provider);
    if (spec.id === "minimax-coding-plan") {
        return normalizedProvider === "minimax-coding-plan";
    }
    return (normalizedProvider === "minimax-china-coding-plan" ||
        (provider === "minimax" && isMiniMaxChinaExplicitlyEnabled(context)));
}
async function isMiniMaxProviderRuntimeAvailable(ctx, spec) {
    const providerAvailable = await isCanonicalProviderAvailable({
        ctx,
        providerId: spec.id,
        fallbackOnError: false,
    });
    if (providerAvailable)
        return true;
    if (spec.id !== "minimax-china-coding-plan" || !isMiniMaxChinaExplicitlyEnabled(ctx.config)) {
        return false;
    }
    return isAnyProviderIdAvailable({
        ctx,
        candidateIds: ["minimax"],
        fallbackOnError: false,
    });
}
function createMiniMaxProvider(spec) {
    return {
        id: spec.id,
        async isAvailable(ctx) {
            const providerAvailable = await isMiniMaxProviderRuntimeAvailable(ctx, spec);
            if (!providerAvailable) {
                return false;
            }
            const auth = await spec.resolveAuthCached({
                maxAgeMs: DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
            });
            return auth.state === "configured" || auth.state === "invalid";
        },
        matchesCurrentModel(model, context) {
            return matchesMiniMaxCurrentModel(model, spec, context);
        },
        async fetch(ctx) {
            const diagnostics = await spec.getAuthDiagnostics({
                maxAgeMs: DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
            });
            const endpoint = diagnostics.state === "configured"
                ? getMiniMaxQuotaEndpoint(diagnostics.endpoint)
                : undefined;
            const statusDetails = [
                ...apiKeyStatusDetails(diagnostics),
                ...statusDetailsFromRecord({
                    api_endpoint: endpoint?.id,
                    api_base_url: endpoint?.apiBaseUrl,
                }),
            ];
            const auth = await spec.resolveAuthCached({
                maxAgeMs: DEFAULT_MINIMAX_AUTH_CACHE_MAX_AGE_MS,
            });
            if (auth.state === "none") {
                return withStatusDetails(notAttemptedResult(), statusDetails);
            }
            if (auth.state === "invalid") {
                return withStatusDetails(attemptedErrorResult(spec.label, auth.error), statusDetails);
            }
            const result = await queryMiniMaxQuota(auth.apiKey, {
                endpoint: spec.endpoint,
                label: spec.label,
                requestTimeoutMs: ctx.config?.requestTimeoutMs,
            });
            if (result.errors.length > 0) {
                const firstError = result.errors[0];
                return withStatusDetails(attemptedErrorResult(spec.label, firstError?.message ?? "MiniMax API error"), [
                    ...statusDetails,
                    { key: "live_fetch_error", value: firstError?.message ?? "MiniMax API error" },
                ]);
            }
            const providerResult = attemptedResult(result.entries.map((entry) => ({
                ...entry,
            })));
            const fiveHourEntry = result.entries.find((entry) => entry.semantic?.metric?.kind === "window" && entry.semantic.metric.window === "five_hour");
            const weeklyEntry = result.entries.find((entry) => entry.semantic?.metric?.kind === "window" && entry.semantic.metric.window === "week");
            const formatUsage = (entry) => {
                if (!entry)
                    return undefined;
                const percent = "percentRemaining" in entry ? entry.percentRemaining : undefined;
                return `percent_remaining=${percent ?? "(none)"} reset_at=${entry.resetTimeIso ?? "(none)"}`;
            };
            return withStatusDetails(providerResult, [
                ...statusDetails,
                ...statusDetailsFromRecord({
                    five_hour_usage: formatUsage(fiveHourEntry),
                    weekly_usage: formatUsage(weeklyEntry),
                    live_state: !fiveHourEntry && !weeklyEntry ? `no reportable ${spec.label} quota` : undefined,
                }),
            ]);
        },
    };
}
export const minimaxCodingPlanProvider = createMiniMaxProvider({
    id: "minimax-coding-plan",
    label: MINIMAX_PROVIDER_LABEL,
    endpoint: "international",
    resolveAuthCached: resolveMiniMaxAuthCached,
    getAuthDiagnostics: getMiniMaxAuthDiagnostics,
});
export const minimaxChinaCodingPlanProvider = createMiniMaxProvider({
    id: "minimax-china-coding-plan",
    label: MINIMAX_CHINA_PROVIDER_LABEL,
    endpoint: "china",
    resolveAuthCached: resolveMiniMaxChinaAuthCached,
    getAuthDiagnostics: getMiniMaxChinaAuthDiagnostics,
});
