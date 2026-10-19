import { AGY_AUTH_KEYS, compareAgyBuckets, hasAgyQuotaRuntimeAvailable, inspectAgyAuthPresence, inspectAgyCompanionPresence, queryGoogleAgyQuota, } from "../lib/google-agy.js";
import { parseProviderModelRef } from "../lib/provider-model-matching.js";
import { FIVE_HOUR, keySlug, quotaRow, WEEKLY } from "./contract.js";
import { fetchGoogleProviderQuota, isGoogleRuntimeAvailable, remainingCount, } from "./google-oauth-provider.js";
function formatFamilyLabel(family) {
    if (family === "Gemini Models")
        return "Gemini";
    if (family === "Claude and GPT models")
        return "Claude/GPT";
    return family;
}
/**
 * `<family>.<window>`, for example `claude_gpt.weekly`, labelled "Claude/GPT Weekly", with the
 * remaining count when AGY gives one (AGY does not name its unit).
 */
function agyRow(bucket) {
    const family = formatFamilyLabel(bucket.family);
    const familyKey = keySlug(family);
    if (!familyKey)
        return undefined;
    const slot = bucket.window === "weekly" ? WEEKLY : FIVE_HOUR;
    const remaining = remainingCount(bucket.remainingAmount, "unit");
    return {
        ...quotaRow({
            key: `${familyKey}.${slot.key}`,
            label: `${family} ${slot.label}`,
            window: slot.window,
            percentRemaining: bucket.percentRemaining,
            resetsAt: bucket.resetTimeIso,
        }),
        ...(remaining ? { remaining } : {}),
    };
}
const AGY_PROVIDER = {
    name: "Google AGY",
    authKeys: AGY_AUTH_KEYS,
    inspectAuth: inspectAgyAuthPresence,
    inspectCompanion: inspectAgyCompanionPresence,
    query: queryGoogleAgyQuota,
    compareBuckets: compareAgyBuckets,
    row: agyRow,
    defaultAccount: (bucket, accountLabel) => ({
        name: `AGY (${accountLabel ?? `Account ${bucket.accountIndex + 1}`})`,
        login: `account-${bucket.accountIndex + 1}`,
    }),
};
export const googleAgyProvider = {
    id: "google-agy",
    isAvailable: () => isGoogleRuntimeAvailable(hasAgyQuotaRuntimeAvailable),
    matchesCurrentModel: (model) => AGY_AUTH_KEYS.includes(parseProviderModelRef(model).providerId),
    fetch: (ctx) => fetchGoogleProviderQuota(AGY_PROVIDER, ctx),
};
