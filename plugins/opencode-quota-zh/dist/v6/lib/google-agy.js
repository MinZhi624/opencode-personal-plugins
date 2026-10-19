import crypto from "node:crypto";
import { agyCompanion } from "./google-companion-credentials.js";
import { hasGoogleQuotaRuntimeAvailable, inspectGoogleAuthPresence, queryGoogleQuota, resolveGoogleAuthIdentity, } from "./google-oauth-quota.js";
import { nonEmptyString } from "./json-guards.js";
export const AGY_AUTH_KEYS = [
    "google-agy",
    "opencode-agy-auth",
    "google-agy-auth",
];
const AGY = {
    providerId: "google-agy",
    name: "Google AGY",
    authKeys: AGY_AUTH_KEYS,
    projectIdEnvVar: "OPENCODE_AGY_PROJECT_ID",
    projectIdConfigProvider: "google-agy",
    failedLoginCountsAsPresent: false,
    companion: agyCompanion,
    quotaUrl: "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    quotaHeaders: () => ({
        "User-Agent": "antigravity/cli/1.3.5 darwin/amd64",
        "x-activity-request-id": crypto.randomUUID(),
    }),
    toBuckets: toAgyBuckets,
};
function normalizeWindow(value) {
    const normalized = nonEmptyString(value)
        ?.toUpperCase()
        .replace(/[\s-]+/gu, "_");
    if (normalized === "WEEKLY")
        return { window: "weekly", windowLabel: "Weekly" };
    if (normalized === "FIVE_HOUR" || normalized === "5H") {
        return { window: "five_hour", windowLabel: "5h" };
    }
    return undefined;
}
function normalizeFamily(value) {
    const displayName = nonEmptyString(value);
    if (!displayName)
        return undefined;
    const normalized = displayName.toLowerCase();
    if (normalized.includes("gemini"))
        return "Gemini 模型";
    if (normalized.includes("claude") || normalized.includes("gpt"))
        return "Claude 与 GPT 模型";
    return displayName;
}
function familyRank(family) {
    if (family === "Gemini 模型")
        return 0;
    if (family === "Claude 与 GPT 模型")
        return 1;
    return 2;
}
/** Account, then Gemini before Claude/GPT before other families, then weekly before 5h. */
export function compareAgyBuckets(left, right) {
    return (left.accountIndex - right.accountIndex ||
        familyRank(left.family) - familyRank(right.family) ||
        left.family.localeCompare(right.family) ||
        (left.window === "weekly" ? 0 : 1) - (right.window === "weekly" ? 0 : 1) ||
        (left.bucketLabel ?? "").localeCompare(right.bucketLabel ?? "") ||
        (left.bucketId ?? "").localeCompare(right.bucketId ?? ""));
}
function toAgyBucket(bucket, family, account, accountIndex) {
    if (!bucket || typeof bucket !== "object" || bucket.disabled)
        return undefined;
    const window = normalizeWindow(bucket.window);
    const remainingFraction = bucket.remainingFraction;
    if (!window || typeof remainingFraction !== "number" || !Number.isFinite(remainingFraction)) {
        return undefined;
    }
    const bucketId = nonEmptyString(bucket.bucketId);
    const bucketLabel = nonEmptyString(bucket.displayName);
    const remainingAmount = nonEmptyString(bucket.remainingAmount) ?? nonEmptyString(bucket.remaining);
    const resetTimeMs = Date.parse(nonEmptyString(bucket.resetTime) ?? "");
    return {
        family,
        ...window,
        ...(bucketId ? { bucketId } : {}),
        ...(bucketLabel ? { bucketLabel } : {}),
        remainingFraction,
        percentRemaining: Math.round(Math.min(1, Math.max(0, remainingFraction)) * 100),
        ...(Number.isFinite(resetTimeMs) ? { resetTimeIso: new Date(resetTimeMs).toISOString() } : {}),
        ...(remainingAmount ? { remainingAmount } : {}),
        ...(account.email ? { accountEmail: account.email } : {}),
        accountIndex,
        sourceKey: account.sourceKey,
    };
}
/**
 * Rows of the grouped summary, or of the top-level buckets when no group has a
 * usable row. Duplicate rows keep the most constrained one.
 */
function toAgyBuckets(response, account, accountIndex) {
    const rows = [];
    const addRows = (buckets, family) => {
        if (!family || !Array.isArray(buckets))
            return;
        for (const bucket of buckets) {
            const row = toAgyBucket(bucket, family, account, accountIndex);
            if (row)
                rows.push(row);
        }
    };
    if (response && typeof response === "object") {
        for (const group of Array.isArray(response.groups) ? response.groups : []) {
            addRows(group?.buckets, normalizeFamily(group?.displayName));
        }
        if (rows.length === 0) {
            addRows(response.buckets, normalizeFamily(response.description) ?? "额度汇总");
        }
    }
    const deduplicated = new Map();
    for (const row of rows) {
        const identity = `${row.family}\0${row.window}\0${row.bucketId ?? row.bucketLabel ?? row.window}`;
        const existing = deduplicated.get(identity);
        if (!existing || row.remainingFraction < existing.remainingFraction) {
            deduplicated.set(identity, row);
        }
    }
    // A summary without one usable row fails this account.
    if (deduplicated.size === 0)
        throw new Error("额度汇总接口不可用");
    return [...deduplicated.values()].sort(compareAgyBuckets);
}
export function resolveGoogleAgyAuthIdentity() {
    return resolveGoogleAuthIdentity(AGY);
}
export function inspectAgyAuthPresence() {
    return inspectGoogleAuthPresence(AGY);
}
export function inspectAgyCompanionPresence() {
    return agyCompanion.inspect();
}
export function hasAgyQuotaRuntimeAvailable() {
    return hasGoogleQuotaRuntimeAvailable(AGY);
}
export function queryGoogleAgyQuota(options = {}) {
    return queryGoogleQuota(AGY, options);
}
