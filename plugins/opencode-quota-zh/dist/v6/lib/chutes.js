/**
 * Chutes AI quota fetcher
 *
 * Resolves API key from multiple sources and queries:
 * https://api.chutes.ai/users/me/quota_usage/me
 */
import { API_KEY_VENDORS, resolveApiKey } from "./api-key-resolver.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { clampPercent } from "./format-utils.js";
import { fetchWithTimeout } from "./http.js";
function getNextDailyResetUtc() {
    const now = new Date();
    const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
    return reset.toISOString();
}
const CHUTES_QUOTA_URL = "https://api.chutes.ai/users/me/quota_usage/me";
export async function queryChutesQuota(options = {}) {
    const resolved = await resolveApiKey(API_KEY_VENDORS.chutes);
    if (!resolved)
        return null;
    try {
        return await fetchWithTimeout(CHUTES_QUOTA_URL, {
            request: {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${resolved.key}`,
                    "User-Agent": "OpenCode-Quota-Toast/1.0",
                },
            },
            timeoutMs: options.requestTimeoutMs,
            consume: async (resp) => {
                if (!resp.ok) {
                    const text = await resp.text();
                    return {
                        success: false,
                        error: `Chutes API 错误 ${resp.status}：${sanitizeDisplaySnippet(text, 120)}`,
                    };
                }
                const data = (await resp.json());
                const used = typeof data.used === "number" ? data.used : 0;
                const quota = typeof data.quota === "number" ? data.quota : 0;
                const percentRemaining = quota > 0 ? clampPercent(((quota - used) / quota) * 100) : 0;
                return {
                    success: true,
                    percentRemaining,
                    resetTimeIso: getNextDailyResetUtc(),
                };
            },
        });
    }
    catch (err) {
        return {
            success: false,
            error: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
        };
    }
}
