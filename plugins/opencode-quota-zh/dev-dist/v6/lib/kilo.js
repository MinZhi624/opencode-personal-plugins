/**
 * Kilo Gateway API client.
 *
 * Reports Kilo Pass credit totals and usage from the authenticated tRPC
 * subscription-state endpoint, with a balance-only fallback for accounts
 * without an active Kilo Pass.
 */
import { API_KEY_VENDORS, resolveApiKey } from "./api-key-resolver.js";
import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import { isRecord } from "./json-guards.js";
const KILO_PASS_STATE_URL = `https://app.kilo.ai/api/trpc/kiloPass.getState?${new URLSearchParams({
    batch: "1",
    input: JSON.stringify({ "0": null }),
})}`;
const KILO_BALANCE_URL = "https://api.kilo.ai/api/profile/balance";
const MAX_RESPONSE_BYTES = 64 * 1024;
function sanitizeMessage(text, secret, maxLength = 200) {
    const redacted = secret ? text.split(secret).join("[redacted]") : text;
    return (sanitizeSingleLineDisplayText(redacted) || "unknown").slice(0, maxLength);
}
async function readResponseText(response, endpoint) {
    const reader = response.body?.getReader();
    if (!reader)
        return "";
    const chunks = [];
    let byteLength = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            byteLength += value.byteLength;
            if (byteLength > MAX_RESPONSE_BYTES) {
                await reader.cancel().catch(() => undefined);
                throw new Error(`Kilo Gateway ${endpoint} API response exceeded ${MAX_RESPONSE_BYTES} bytes`);
            }
            chunks.push(value);
        }
    }
    finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
}
function nonnegativeNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function firstValidResetTimeIso(...values) {
    for (const value of values) {
        if (typeof value !== "string")
            continue;
        const timestamp = Date.parse(value);
        if (Number.isFinite(timestamp))
            return new Date(timestamp).toISOString();
    }
    return undefined;
}
function stateError(error) {
    return { success: false, error: `Kilo Gateway state API returned ${error}` };
}
function parseKiloPassState(payload) {
    const item = Array.isArray(payload) ? payload[0] : payload;
    const result = isRecord(item) ? item.result : undefined;
    const data = isRecord(result) ? result.data : undefined;
    // The batched tRPC reply wraps the state in `json`; the unbatched one does not.
    if (!isRecord(data) || ("json" in data && !isRecord(data.json))) {
        return stateError("an unexpected response shape");
    }
    const root = isRecord(data.json) ? data.json : data;
    const subscription = root.subscription;
    if (subscription === null || !("subscription" in root)) {
        return {
            success: false,
            reason: "no_active_subscription",
            error: "Kilo Gateway state API returned no active Kilo Pass subscription",
        };
    }
    if (!isRecord(subscription))
        return stateError("an invalid Kilo Pass subscription");
    const baseCreditsUsd = nonnegativeNumber(subscription.currentPeriodBaseCreditsUsd);
    const usageUsd = nonnegativeNumber(subscription.currentPeriodUsageUsd);
    const rawBonusCreditsUsd = subscription.currentPeriodBonusCreditsUsd;
    const bonusCreditsUsd = rawBonusCreditsUsd === null || rawBonusCreditsUsd === undefined
        ? 0
        : nonnegativeNumber(rawBonusCreditsUsd);
    if (baseCreditsUsd === null)
        return stateError("invalid currentPeriodBaseCreditsUsd");
    if (usageUsd === null)
        return stateError("invalid currentPeriodUsageUsd");
    if (bonusCreditsUsd === null)
        return stateError("invalid currentPeriodBonusCreditsUsd");
    const resetTimeIso = firstValidResetTimeIso(subscription.nextBillingAt, subscription.nextRenewalAt);
    const totalCreditsUsd = baseCreditsUsd + bonusCreditsUsd;
    const remainingUsd = Math.round(Math.max(0, totalCreditsUsd - usageUsd) * 100) / 100;
    const overageUsd = Math.round(Math.max(0, usageUsd - totalCreditsUsd) * 100) / 100;
    return {
        success: true,
        baseCreditsUsd,
        usageUsd,
        bonusCreditsUsd,
        remainingUsd,
        overageUsd,
        ...(resetTimeIso ? { resetTimeIso } : {}),
    };
}
function parseKiloBalance(payload) {
    if (!isRecord(payload)) {
        return {
            success: false,
            error: "Kilo Gateway balance API returned an unexpected response shape",
        };
    }
    const balanceUsd = nonnegativeNumber(payload.balance);
    if (balanceUsd === null) {
        return {
            success: false,
            error: "Kilo Gateway balance API returned an invalid balance",
        };
    }
    return { success: true, balanceUsd };
}
async function requestKiloJson(url, endpoint, key, options, parse) {
    try {
        return await fetchWithTimeout(url, {
            request: {
                method: "GET",
                headers: {
                    Accept: "application/json",
                    Authorization: `Bearer ${key}`,
                    "Content-Type": "application/json",
                },
                redirect: "manual",
            },
            timeoutMs: options.requestTimeoutMs,
            consume: async (response) => {
                const text = await readResponseText(response, endpoint);
                if (!response.ok) {
                    return {
                        success: false,
                        error: `Kilo Gateway ${endpoint} API error ${response.status}: ${sanitizeMessage(text, key)}`,
                    };
                }
                return parse(JSON.parse(text));
            },
        });
    }
    catch (error) {
        return {
            success: false,
            error: sanitizeMessage(error instanceof Error ? error.message : String(error), key),
        };
    }
}
export async function queryKiloQuota(options = {}) {
    const resolved = await resolveApiKey(API_KEY_VENDORS.kilo);
    if (!resolved)
        return null;
    const passResult = await requestKiloJson(KILO_PASS_STATE_URL, "state", resolved.key, options, parseKiloPassState);
    if (passResult.success) {
        return { ...passResult, mode: "kilo_pass" };
    }
    // Only a valid reply without an active pass falls back to the balance.
    if (!("reason" in passResult)) {
        return passResult;
    }
    const balanceResult = await requestKiloJson(KILO_BALANCE_URL, "balance", resolved.key, options, parseKiloBalance);
    if (balanceResult.success) {
        return { ...balanceResult, mode: "gateway_balance" };
    }
    return {
        success: false,
        error: `Kilo Gateway has no active Kilo Pass subscription; balance fallback failed: ${balanceResult.error}`,
    };
}
