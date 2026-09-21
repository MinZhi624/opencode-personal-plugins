/**
 * DeepSeek balance fetcher.
 *
 * Queries: GET https://api.deepseek.com/user/balance
 * Auth: Bearer token in Authorization header.
 */
import { isCanonicalAccountingDecimal } from "./accounting-format.js";
import { resolveDeepSeekApiKey } from "./deepseek-auth.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const USER_AGENT = "OpenCode-Quota-Toast/1.0";
const MAX_PARSE_ISSUES = 6;
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function getNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
function parseDeepSeekBalanceDecimal(value) {
    return typeof value === "string" && isCanonicalAccountingDecimal(value) ? value : undefined;
}
function parseDeepSeekBalance(payload) {
    if (!isRecord(payload)) {
        throw new Error("DeepSeek balance response returned an unexpected response shape");
    }
    const isAvailable = typeof payload.is_available === "boolean" ? payload.is_available : undefined;
    const balanceInfos = [];
    const parseIssues = [];
    const rawInfos = payload.balance_infos;
    if (Array.isArray(rawInfos)) {
        for (const info of rawInfos) {
            if (!isRecord(info))
                continue;
            const rawCurrency = getNonEmptyString(info.currency);
            if (!rawCurrency || !["CNY", "USD"].includes(rawCurrency.toUpperCase()))
                continue;
            const currency = rawCurrency.toUpperCase();
            const parsed = { currency };
            const fields = [
                ["total_balance", "totalBalance"],
                ["granted_balance", "grantedBalance"],
                ["topped_up_balance", "toppedUpBalance"],
            ];
            for (const [sourceField, targetField] of fields) {
                const rawValue = info[sourceField];
                const decimal = parseDeepSeekBalanceDecimal(rawValue);
                if (decimal !== undefined) {
                    parsed[targetField] = decimal;
                }
                else if (rawValue !== undefined && parseIssues.length < MAX_PARSE_ISSUES) {
                    parseIssues.push({ currency, field: sourceField });
                }
            }
            if (parsed.totalBalance !== undefined ||
                parsed.grantedBalance !== undefined ||
                parsed.toppedUpBalance !== undefined) {
                balanceInfos.push(parsed);
            }
        }
    }
    return { isAvailable, balanceInfos, parseIssues };
}
async function fetchDeepSeekBalance(apiKey, requestTimeoutMs) {
    try {
        return await fetchWithTimeout(DEEPSEEK_BALANCE_URL, {
            request: {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "User-Agent": USER_AGENT,
                },
            },
            timeoutMs: requestTimeoutMs,
            consume: async (response) => {
                if (!response.ok) {
                    const text = await response.text();
                    return {
                        success: false,
                        message: `DeepSeek API error ${response.status}: ${sanitizeDisplaySnippet(text, 120)}`,
                    };
                }
                return {
                    success: true,
                    data: parseDeepSeekBalance(await response.json()),
                };
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
/**
 * Query DeepSeek balance from the API.
 *
 * @returns A typed result with success/error state, or null if no API key is configured.
 */
export async function queryDeepSeekBalance(options = {}) {
    const resolved = options.apiKey ? { key: options.apiKey } : await resolveDeepSeekApiKey();
    if (!resolved)
        return null;
    const result = await fetchDeepSeekBalance(resolved.key, options.requestTimeoutMs);
    if (!result.success) {
        return { success: false, error: result.message };
    }
    return {
        success: true,
        isAvailable: result.data.isAvailable,
        balanceInfos: result.data.balanceInfos,
        parseIssues: result.data.parseIssues,
    };
}
export { getDeepSeekKeyDiagnostics, hasDeepSeekApiKey as hasDeepSeekApiKeyConfigured, } from "./deepseek-auth.js";
