/**
 * Synthetic quota fetcher
 *
 * Resolves API key from multiple sources and queries:
 * https://api.synthetic.new/v2/quotas
 */
import { API_KEY_VENDORS, resolveApiKey } from "./api-key-resolver.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { clampPercent } from "./format-utils.js";
import { fetchWithTimeout } from "./http.js";
import { asRecord, nonEmptyString } from "./json-guards.js";
const SYNTHETIC_QUOTA_URL = "https://api.synthetic.new/v2/quotas";
const SYNTHETIC_CREDIT_AMOUNT_PATTERN = /^\$(\d+)(?:\.(\d{1,2}))?$/;
const MISSING_FIVE_HOUR_WINDOW = "Synthetic API 响应缺少 rollingFiveHourLimit 额度窗口";
const MISSING_WEEKLY_WINDOW = "Synthetic API 响应缺少 weeklyTokenLimit 额度窗口";
function normalizeResetTimeIso(value) {
    const raw = nonEmptyString(value);
    const parsed = raw ? Date.parse(raw) : Number.NaN;
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}
function normalizeSyntheticAmount(value) {
    if (!Number.isFinite(value))
        return 0;
    return Number(value.toFixed(6));
}
/** "$12.5" -> 12.5; anything else (no "$", more than two decimals) -> null. */
function parseSyntheticCreditAmount(value) {
    const match = typeof value === "string" ? SYNTHETIC_CREDIT_AMOUNT_PATTERN.exec(value.trim()) : null;
    if (!match)
        return null;
    const whole = Number.parseInt(match[1] ?? "0", 10);
    const fractional = Number.parseInt((match[2] ?? "").padEnd(2, "0"), 10);
    // A very long digit run parses to Infinity.
    if (!Number.isFinite(whole))
        return null;
    return normalizeSyntheticAmount((whole * 100 + fractional) / 100);
}
function isNonNegativeNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function buildRollingFiveHourWindow(payload) {
    const rolling = asRecord(payload?.rollingFiveHourLimit);
    const max = rolling?.max;
    const remaining = rolling?.remaining;
    if (!rolling || !isNonNegativeNumber(max) || max === 0 || !isNonNegativeNumber(remaining)) {
        return { success: false, error: MISSING_FIVE_HOUR_WINDOW };
    }
    const used = normalizeSyntheticAmount(max - remaining);
    if (used < 0)
        return { success: false, error: MISSING_FIVE_HOUR_WINDOW };
    return {
        limit: max,
        used,
        percentRemaining: clampPercent((remaining / max) * 100),
        resetTimeIso: normalizeResetTimeIso(rolling.nextTickAt),
    };
}
function buildWeeklyTokenWindow(payload) {
    const weekly = asRecord(payload?.weeklyTokenLimit);
    const limit = parseSyntheticCreditAmount(weekly?.maxCredits);
    const remaining = parseSyntheticCreditAmount(weekly?.remainingCredits);
    if (!weekly || limit === null || limit <= 0 || remaining === null) {
        return { success: false, error: MISSING_WEEKLY_WINDOW };
    }
    const used = normalizeSyntheticAmount(limit - remaining);
    if (used < 0)
        return { success: false, error: MISSING_WEEKLY_WINDOW };
    const reported = weekly.percentRemaining;
    const percentRemaining = isNonNegativeNumber(reported) && reported <= 100
        ? clampPercent(reported)
        : clampPercent((remaining / limit) * 100);
    return {
        limit,
        used,
        percentRemaining,
        resetTimeIso: normalizeResetTimeIso(weekly.nextRegenAt),
    };
}
export async function querySyntheticQuota(options = {}) {
    const resolved = await resolveApiKey(API_KEY_VENDORS.synthetic);
    if (!resolved)
        return null;
    try {
        return await fetchWithTimeout(SYNTHETIC_QUOTA_URL, {
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
                        error: `Synthetic API 错误 ${resp.status}：${sanitizeDisplaySnippet(text, 120)}`,
                    };
                }
                const payload = asRecord(await resp.json());
                if (payload && Object.keys(payload).length === 0) {
                    return { success: false, error: "Synthetic 没有返回该账户的额度数据。" };
                }
                const fiveHour = buildRollingFiveHourWindow(payload);
                if ("error" in fiveHour)
                    return fiveHour;
                const weekly = buildWeeklyTokenWindow(payload);
                if ("error" in weekly)
                    return weekly;
                return { success: true, windows: { fiveHour, weekly } };
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
