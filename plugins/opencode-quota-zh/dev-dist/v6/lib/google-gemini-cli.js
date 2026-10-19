import { geminiCliCompanion, } from "./google-companion-credentials.js";
import { hasGoogleQuotaRuntimeAvailable, inspectGoogleAuthPresence, queryGoogleQuota, resolveGoogleAuthIdentity, } from "./google-oauth-quota.js";
import { nonEmptyString } from "./json-guards.js";
export const GEMINI_CLI_AUTH_KEYS = [
    "google-gemini-cli",
    "gemini-cli",
    "opencode-gemini-auth",
    "gemini",
    "google",
];
const GEMINI_CLI = {
    providerId: "google-gemini-cli",
    name: "Gemini CLI",
    authKeys: GEMINI_CLI_AUTH_KEYS,
    projectIdEnvVar: "OPENCODE_GEMINI_PROJECT_ID",
    projectIdConfigProvider: "google",
    failedLoginCountsAsPresent: true,
    companion: geminiCliCompanion,
    missingCompanionError: "Gemini CLI requires the opencode-gemini-auth plugin",
    quotaUrl: "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    quotaHeaders: () => ({
        "User-Agent": `GeminiCLI/opencode-quota (${process.platform}; ${process.arch})`,
    }),
    toBuckets: toGeminiCliBuckets,
};
/** "gemini-2.5-flash" → "Gemini 2.5 Flash". */
function formatDisplayName(modelId) {
    const words = modelId
        .replace(/_/g, "-")
        .replace(/^gemini-/i, "")
        .split("-")
        .filter(Boolean)
        .map((part) => /^[0-9]+(?:\.[0-9]+)*$/.test(part)
        ? part
        : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase());
    return words.length > 0 ? `Gemini ${words.join(" ")}` : "Gemini";
}
const QUALITY_TIERS = ["Gemini Pro", "Gemini Flash", "Gemini Flash Lite"];
function qualityTier(modelId) {
    const normalized = modelId.toLowerCase().replace(/_/g, "-");
    const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
    if (normalized.includes("flash-lite") || (tokens.includes("flash") && tokens.includes("lite"))) {
        return "Gemini Flash Lite";
    }
    if (tokens.includes("pro"))
        return "Gemini Pro";
    if (tokens.includes("flash"))
        return "Gemini Flash";
    return undefined;
}
/** The most constrained model per quality tier (Pro, Flash, Flash Lite), then models without one. */
function aggregateQualityTiers(buckets) {
    const byTier = new Map();
    const untiered = [];
    for (const bucket of buckets) {
        const tier = qualityTier(bucket.modelId);
        if (!tier) {
            untiered.push(bucket);
            continue;
        }
        const existing = byTier.get(tier);
        if (!existing || bucket.percentRemaining < existing.percentRemaining) {
            byTier.set(tier, { ...bucket, displayName: tier });
        }
    }
    return [...QUALITY_TIERS.flatMap((tier) => byTier.get(tier) ?? []), ...untiered];
}
function toGeminiCliBuckets(response, account) {
    const buckets = response.buckets;
    if (!buckets)
        return [];
    // Filter first: a non-array `buckets` reports "buckets.filter is not a function".
    return aggregateQualityTiers(buckets
        .filter((bucket) => nonEmptyString(bucket.modelId) !== undefined)
        .map((bucket) => {
        const modelId = nonEmptyString(bucket.modelId) ?? "";
        const fraction = bucket.remainingFraction;
        const resetTimeIso = nonEmptyString(bucket.resetTime);
        const remainingAmount = nonEmptyString(bucket.remainingAmount);
        const tokenType = nonEmptyString(bucket.tokenType);
        return {
            modelId,
            displayName: formatDisplayName(modelId),
            percentRemaining: typeof fraction === "number" && Number.isFinite(fraction)
                ? Math.round(fraction * 100)
                : 0,
            ...(resetTimeIso ? { resetTimeIso } : {}),
            ...(remainingAmount ? { remainingAmount } : {}),
            ...(tokenType ? { tokenType } : {}),
            ...(account.email ? { accountEmail: account.email } : {}),
            sourceKey: account.sourceKey,
        };
    }));
}
export function inspectGeminiCliAuthPresence() {
    return inspectGoogleAuthPresence(GEMINI_CLI);
}
export function inspectGeminiCliCompanionPresence() {
    return geminiCliCompanion.inspect();
}
export function hasGeminiCliQuotaRuntimeAvailable() {
    return hasGoogleQuotaRuntimeAvailable(GEMINI_CLI);
}
export function resolveGeminiCliAuthIdentity() {
    return resolveGoogleAuthIdentity(GEMINI_CLI);
}
export function queryGeminiCliQuota(options = {}) {
    return queryGoogleQuota(GEMINI_CLI, options);
}
