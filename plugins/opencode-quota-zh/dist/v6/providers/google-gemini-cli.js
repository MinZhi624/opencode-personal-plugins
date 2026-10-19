import { classifyWindow } from "../core/windows.js";
import { GEMINI_CLI_AUTH_KEYS, hasGeminiCliQuotaRuntimeAvailable, inspectGeminiCliAuthPresence, inspectGeminiCliCompanionPresence, queryGeminiCliQuota, } from "../lib/google-gemini-cli.js";
import { parseProviderModelRef } from "../lib/provider-model-matching.js";
import { keySlug, quotaRow } from "./contract.js";
import { fetchGoogleProviderQuota, isGoogleRuntimeAvailable, remainingCount, } from "./google-oauth-provider.js";
function isGeminiCliModel(model) {
    const { providerId, modelId } = parseProviderModelRef(model);
    if (["google-gemini-cli", "gemini-cli", "gemini", "opencode-gemini-auth"].includes(providerId)) {
        return true;
    }
    return (providerId === "google" && !modelId.startsWith("antigravity-") && modelId.includes("gemini"));
}
const GEMINI_TIER_KEYS = {
    "Gemini Pro": "pro",
    "Gemini Flash": "flash",
    "Gemini Flash Lite": "flash_lite",
};
/** Gemini's token types as count units; a type it does not name counts plain units. */
const GEMINI_TOKEN_UNITS = {
    REQUESTS: "request",
    TOKENS: "token",
};
/**
 * The quality tiers keep fixed keys; other models are keyed `model.<name>`. The row has the
 * remaining count when Gemini gives one.
 */
function geminiCliRow(bucket) {
    const model = bucket.displayName.replace(/:+$/u, "").trim();
    if (!model)
        return undefined;
    const short = model.replace(/^Gemini\s+/u, "") || model;
    const unit = GEMINI_TOKEN_UNITS[bucket.tokenType?.trim().toUpperCase() ?? ""] ?? "unit";
    const remaining = remainingCount(bucket.remainingAmount, unit);
    return {
        ...quotaRow({
            key: GEMINI_TIER_KEYS[model] ?? `model.${keySlug(short)}`,
            label: short,
            window: classifyWindow(model),
            percentRemaining: bucket.percentRemaining,
            resetsAt: bucket.resetTimeIso,
        }),
        ...(remaining ? { remaining } : {}),
    };
}
const GEMINI_CLI_PROVIDER = {
    name: "Gemini CLI",
    authKeys: GEMINI_CLI_AUTH_KEYS,
    inspectAuth: inspectGeminiCliAuthPresence,
    inspectCompanion: inspectGeminiCliCompanionPresence,
    query: queryGeminiCliQuota,
    failedLoginError: (resolveError) => `Gemini CLI sign-in could not be refreshed: ${resolveError}. Run \`opencode auth login google\`.`,
    row: geminiCliRow,
    defaultAccount: (bucket, accountLabel = "Unknown") => ({
        name: `Gemini CLI (${accountLabel})`,
        login: bucket.accountEmail,
    }),
};
export const googleGeminiCliProvider = {
    id: "google-gemini-cli",
    isAvailable: () => isGoogleRuntimeAvailable(hasGeminiCliQuotaRuntimeAvailable),
    matchesCurrentModel: isGeminiCliModel,
    fetch: (ctx) => fetchGoogleProviderQuota(GEMINI_CLI_PROVIDER, ctx),
};
