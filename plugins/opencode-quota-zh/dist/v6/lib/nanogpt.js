/**
 * NanoGPT live quota and balance fetcher.
 *
 * Queries:
 * - https://nano-gpt.com/api/subscription/v1/usage
 * - https://nano-gpt.com/api/check-balance
 */
import { isCanonicalAccountingDecimal } from "./accounting-format.js";
import { API_KEY_VENDORS, resolveApiKey } from "./api-key-resolver.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { clampPercent } from "./format-utils.js";
import { fetchWithTimeout } from "./http.js";
import { finiteNumber, nonEmptyString } from "./json-guards.js";
const USER_AGENT = "OpenCode-Quota-Toast/1.0";
const NANOGPT_USAGE_URL = "https://nano-gpt.com/api/subscription/v1/usage";
const NANOGPT_BALANCE_URL = "https://nano-gpt.com/api/check-balance";
/** An object or an array (an array window reads as one with no counts). */
function isRecord(value) {
    return Boolean(value) && typeof value === "object";
}
function getFinitePositiveNumber(value) {
    const n = finiteNumber(value);
    return n !== undefined && n > 0 ? n : undefined;
}
function getIsoString(value) {
    const raw = nonEmptyString(value);
    if (!raw)
        return undefined;
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms))
        return undefined;
    return new Date(ms).toISOString();
}
function getIsoFromEpochMs(value) {
    const ms = getFinitePositiveNumber(value);
    if (ms === undefined)
        return undefined;
    return new Date(Math.round(ms)).toISOString();
}
function normalizeUsageWindow(value, limitValue, fallbackResetTimeIso) {
    if (!isRecord(value))
        return undefined;
    const used = finiteNumber(value.used);
    const remainingRaw = finiteNumber(value.remaining);
    const limitFromResponse = getFinitePositiveNumber(limitValue);
    const percentUsed = finiteNumber(value.percentUsed);
    const derivedLimit = limitFromResponse ??
        (used !== undefined && remainingRaw !== undefined ? used + remainingRaw : undefined);
    if (derivedLimit === undefined || derivedLimit <= 0)
        return undefined;
    const safeUsed = used ?? 0;
    const safeRemaining = remainingRaw ??
        (percentUsed !== undefined ? Math.max(0, derivedLimit * (1 - percentUsed)) : derivedLimit);
    const percentRemaining = safeRemaining >= 0
        ? clampPercent((safeRemaining / derivedLimit) * 100)
        : clampPercent(percentUsed !== undefined ? (1 - percentUsed) * 100 : 0);
    return {
        used: safeUsed,
        limit: derivedLimit,
        remaining: Math.max(0, safeRemaining),
        percentRemaining,
        resetTimeIso: getIsoFromEpochMs(value.resetAt) ?? fallbackResetTimeIso,
        reportedBasis: {
            ...(used !== undefined && used >= 0 ? { used } : {}),
            ...(limitFromResponse !== undefined ? { limit: limitFromResponse } : {}),
            ...(remainingRaw !== undefined && remainingRaw >= 0 ? { remaining: remainingRaw } : {}),
        },
    };
}
function parseNanoGptUsage(payload) {
    if (!isRecord(payload)) {
        throw new Error("NanoGPT 用量响应结构异常");
    }
    const data = payload;
    const currentPeriodEndIso = getIsoString(data.period?.currentPeriodEnd);
    const daily = normalizeUsageWindow(data.daily, data.limits?.daily);
    const monthly = normalizeUsageWindow(data.monthly, data.limits?.monthly, currentPeriodEndIso);
    const hasSubscriptionShape = typeof data.active === "boolean" ||
        typeof data.enforceDailyLimit === "boolean" ||
        Boolean(nonEmptyString(data.state)) ||
        daily !== undefined ||
        monthly !== undefined;
    if (!hasSubscriptionShape) {
        throw new Error("NanoGPT 用量响应结构异常");
    }
    return {
        active: typeof data.active === "boolean" ? data.active : false,
        state: nonEmptyString(data.state) ?? (data.active ? "active" : "unknown"),
        enforceDailyLimit: typeof data.enforceDailyLimit === "boolean" ? data.enforceDailyLimit : false,
        daily,
        monthly,
        currentPeriodEndIso,
        graceUntilIso: getIsoString(data.graceUntil),
    };
}
function parseNanoGptBalance(payload) {
    if (!isRecord(payload)) {
        throw new Error("NanoGPT 余额响应结构异常");
    }
    const data = payload;
    const fields = [
        ["usd_balance", data.usd_balance],
        ["nano_balance", data.nano_balance],
    ];
    const balance = {};
    const fieldErrors = [];
    let presentFieldCount = 0;
    for (const [name, value] of fields) {
        if (value === undefined)
            continue;
        presentFieldCount++;
        if (typeof value !== "string" || !isCanonicalAccountingDecimal(value)) {
            fieldErrors.push(`NanoGPT 余额响应的 ${name} 小数无效`);
            continue;
        }
        if (name === "usd_balance")
            balance.usdBalanceRaw = value;
        else
            balance.nanoBalanceRaw = value;
    }
    if (presentFieldCount === 0) {
        throw new Error("NanoGPT 余额响应结构异常");
    }
    if (!balance.usdBalanceRaw && !balance.nanoBalanceRaw) {
        throw new Error(fieldErrors.join("; "));
    }
    return { balance, fieldErrors };
}
async function fetchNanoGptEndpoint(url, method, headers, requestTimeoutMs, parse) {
    try {
        return await fetchWithTimeout(url, {
            request: { method, headers },
            timeoutMs: requestTimeoutMs,
            consume: async (response) => {
                if (!response.ok) {
                    let text;
                    try {
                        text = await response.text();
                    }
                    catch (error) {
                        text = sanitizeDisplayText(error instanceof Error ? error.message : String(error));
                    }
                    return {
                        success: false,
                        message: `NanoGPT API 错误 ${response.status}：${sanitizeDisplaySnippet(text, 120)}`,
                    };
                }
                return { success: true, ...parse(await response.json()) };
            },
        });
    }
    catch (err) {
        return {
            success: false,
            message: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
        };
    }
}
export async function queryNanoGptQuota(options = {}) {
    const resolved = await resolveApiKey(API_KEY_VENDORS.nanogpt);
    if (!resolved)
        return null;
    const headers = {
        "x-api-key": resolved.key,
        "User-Agent": USER_AGENT,
    };
    const [usageResult, balanceResult] = await Promise.all([
        fetchNanoGptEndpoint(NANOGPT_USAGE_URL, "GET", headers, options.requestTimeoutMs, (payload) => ({
            subscription: parseNanoGptUsage(payload),
        })),
        fetchNanoGptEndpoint(NANOGPT_BALANCE_URL, "POST", headers, options.requestTimeoutMs, parseNanoGptBalance),
    ]);
    const endpointErrors = [];
    if (!usageResult.success) {
        endpointErrors.push({ endpoint: "usage", message: usageResult.message });
    }
    if (!balanceResult.success) {
        endpointErrors.push({ endpoint: "balance", message: balanceResult.message });
    }
    else if (balanceResult.fieldErrors.length > 0) {
        endpointErrors.push({ endpoint: "balance", message: balanceResult.fieldErrors.join("; ") });
    }
    if (!usageResult.success && !balanceResult.success) {
        return {
            success: false,
            error: endpointErrors
                .map((entry) => `${entry.endpoint === "usage" ? "用量" : "余额"}：${entry.message}`)
                .join("; "),
        };
    }
    return {
        success: true,
        subscription: usageResult.success ? usageResult.subscription : undefined,
        balance: balanceResult.success ? balanceResult.balance : undefined,
        endpointErrors: endpointErrors.length > 0 ? endpointErrors : undefined,
    };
}
