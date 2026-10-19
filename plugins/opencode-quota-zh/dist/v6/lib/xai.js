/**
 * xAI SuperGrok subscription quota fetcher.
 *
 * Uses OpenCode's read-only `xai` OAuth entry and queries the same shared
 * period meter exposed by Grok Build:
 * GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
 *
 * After quota succeeds, subscription metadata may refine the display label via:
 * GET https://grok.com/rest/subscriptions
 *
 * OpenCode remains the sole owner of OAuth refresh and opencode.db persistence.
 */
import { sanitizeSingleLineDisplaySnippet } from "./display-sanitize.js";
import { clampPercent } from "./format-utils.js";
import { fetchWithTimeout } from "./http.js";
import { isRecord, nonEmptyString } from "./json-guards.js";
import { readAuthFile, readAuthFileCached } from "./opencode-auth.js";
import { deriveResolvedAuthIdentity } from "./resolved-auth-identity.js";
export const DEFAULT_XAI_AUTH_CACHE_MAX_AGE_MS = 5_000;
const CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const SUBSCRIPTIONS_URL = "https://grok.com/rest/subscriptions";
const SUBSCRIPTIONS_TIMEOUT_MS = 2_000;
const HEAVY_OFFER_ID_RE = /^heavy-p\d+m-\d{1,2}-[a-z]{3}\d{4}$/i;
const USER_AGENT = "OpenCode-Quota-Toast/1.0";
const PERIOD_KIND_LABELS = {
    weekly: "Weekly",
    monthly: "Monthly",
    daily: "Daily",
    period: "Period",
};
function isoOrUndefined(value) {
    const raw = nonEmptyString(value);
    if (!raw)
        return undefined;
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
function periodKindFromType(value) {
    const raw = nonEmptyString(value)?.toUpperCase() ?? "";
    if (raw.includes("WEEK"))
        return "weekly";
    if (raw.includes("MONTH"))
        return "monthly";
    if (raw.includes("DAY") || raw.includes("DAILY"))
        return "daily";
    return "period";
}
export function periodKindLabel(kind) {
    return PERIOD_KIND_LABELS[kind];
}
export function resolveXaiOAuth(auth) {
    const entry = auth?.xai;
    if (!entry || entry.type !== "oauth")
        return { state: "none" };
    if (entry.resolveError !== undefined)
        return { state: "failed", error: entry.resolveError };
    const accessToken = typeof entry.access === "string" ? entry.access.trim() : "";
    if (!accessToken)
        return { state: "none" };
    return {
        state: "configured",
        accessToken,
        expiresAt: typeof entry.expires === "number" && Number.isFinite(entry.expires)
            ? entry.expires
            : undefined,
    };
}
/** A login OpenCode could not return counts too, so it can show as its own error. */
export async function hasXaiOAuthCached(params) {
    const auth = await readAuthFileCached({
        maxAgeMs: Math.max(0, params?.maxAgeMs ?? DEFAULT_XAI_AUTH_CACHE_MAX_AGE_MS),
        integrationIds: ["xai"],
    });
    return resolveXaiOAuth(auth).state !== "none";
}
export async function resolveXaiAuthIdentity() {
    const resolved = resolveXaiOAuth(await readAuthFile({ integrationIds: ["xai"] }));
    if (resolved.state !== "configured")
        return null;
    return deriveResolvedAuthIdentity({
        providerId: "xai",
        principal: { kind: "credential", value: resolved.accessToken },
    });
}
function parseCreditsWindow(payload) {
    if (!isRecord(payload) || !isRecord(payload.config)) {
        throw new Error("xAI credits 响应结构异常");
    }
    const config = payload.config;
    const period = isRecord(config.currentPeriod) ? config.currentPeriod : null;
    const hasUsage = Object.hasOwn(config, "creditUsagePercent");
    const hasPeriod = Boolean(nonEmptyString(period?.type) || nonEmptyString(period?.start) || nonEmptyString(period?.end));
    if (!hasPeriod && !hasUsage)
        return null;
    // Protobuf JSON omits zero-valued fields, so an absent percentage with a
    // current period means 0% used rather than missing quota.
    const usedPercent = hasUsage ? config.creditUsagePercent : 0;
    if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
        throw new Error("xAI credits 响应的用量百分比无效");
    }
    const startedAtIso = isoOrUndefined(period?.start);
    const endsAtIso = isoOrUndefined(period?.end);
    const observedAtMs = Date.now();
    const fixedWindow = startedAtIso !== undefined &&
        endsAtIso !== undefined &&
        Date.parse(startedAtIso) < observedAtMs &&
        observedAtMs < Date.parse(endsAtIso)
        ? { startedAtIso }
        : undefined;
    return {
        percentRemaining: clampPercent(100 - usedPercent),
        resetTimeIso: endsAtIso ?? isoOrUndefined(config.billingPeriodEnd),
        ...(fixedWindow ? { fixedWindow } : {}),
        kind: periodKindFromType(period?.type),
    };
}
function xaiHeaders(accessToken) {
    return {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        "x-grok-client-surface": "grok-build",
        "x-grok-client-version": "1.0.0",
    };
}
function parseXaiLabel(payload) {
    const subscriptions = isRecord(payload) && Array.isArray(payload.subscriptions) ? payload.subscriptions : [];
    const active = subscriptions.find((subscription) => isRecord(subscription) && subscription.status === "SUBSCRIPTION_STATUS_ACTIVE");
    if (!isRecord(active))
        return "xAI SuperGrok";
    const activeOffer = isRecord(active.activeOffer) ? active.activeOffer : null;
    const providerOfferId = nonEmptyString(activeOffer?.providerOfferId);
    if (providerOfferId && HEAVY_OFFER_ID_RE.test(providerOfferId))
        return "xAI Heavy";
    const tier = nonEmptyString(active.tier);
    if (tier === "SUBSCRIPTION_TIER_SUPER_GROK_HEAVY")
        return "xAI Heavy";
    if (tier === "SUBSCRIPTION_TIER_SUPER_GROK_LITE")
        return "xAI Lite";
    // SUPER_GROK, SUPER_GROK_PRO, and unknown tiers keep the standard label.
    return "xAI SuperGrok";
}
/** Subscription metadata only refines the label, so any failure keeps the standard one. */
async function queryXaiLabel(accessToken, requestTimeoutMs) {
    try {
        return await fetchWithTimeout(SUBSCRIPTIONS_URL, {
            request: {
                method: "GET",
                headers: xaiHeaders(accessToken),
            },
            timeoutMs: Math.min(requestTimeoutMs ?? SUBSCRIPTIONS_TIMEOUT_MS, SUBSCRIPTIONS_TIMEOUT_MS),
            consume: async (response) => response.ok ? parseXaiLabel(await response.json()) : "xAI SuperGrok",
        });
    }
    catch {
        return "xAI SuperGrok";
    }
}
function safeErrorText(message, accessToken) {
    return sanitizeSingleLineDisplaySnippet(message.split(accessToken).join("[redacted]"), 160);
}
export async function queryXaiQuota(options = {}) {
    // OpenCode can replace this OAuth entry while servicing a model request.
    // Read the file directly so a post-request quota fetch cannot reuse the
    // token snapshot from before that refresh.
    const resolvedAuth = options.auth ?? resolveXaiOAuth(await readAuthFile({ integrationIds: ["xai"] }));
    if (resolvedAuth.state === "failed") {
        return {
            success: false,
            error: `xAI 登录刷新失败：${resolvedAuth.error}。请运行 \`opencode auth login xai\`。`,
        };
    }
    if (resolvedAuth.state !== "configured")
        return null;
    if (resolvedAuth.expiresAt !== undefined && resolvedAuth.expiresAt <= Date.now()) {
        return {
            success: false,
            error: "xAI OAuth Token 已过期；请在 OpenCode 里使用 xAI 以刷新登录，或重新连接 xAI",
        };
    }
    try {
        const creditsResult = await fetchWithTimeout(CREDITS_URL, {
            request: {
                method: "GET",
                headers: xaiHeaders(resolvedAuth.accessToken),
            },
            timeoutMs: options.requestTimeoutMs,
            consume: async (response) => {
                if (!response.ok) {
                    const body = await response.text();
                    return {
                        success: false,
                        error: `xAI API 错误 ${response.status}：${safeErrorText(body, resolvedAuth.accessToken)}`,
                    };
                }
                const window = parseCreditsWindow(await response.json());
                return window
                    ? { success: true, window }
                    : { success: false, error: "没有每周额度数据" };
            },
        });
        if (!creditsResult.success)
            return creditsResult;
        const label = await queryXaiLabel(resolvedAuth.accessToken, options.requestTimeoutMs);
        return { success: true, label, window: creditsResult.window };
    }
    catch (error) {
        return {
            success: false,
            error: safeErrorText(error instanceof Error ? error.message : String(error), resolvedAuth.accessToken),
        };
    }
}
