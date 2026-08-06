/**
 * Kilo Gateway balance API client.
 *
 * Kilo's public gateway API does not expose quota or usage-history totals.
 * Its official gateway package documents the authenticated profile balance API,
 * so this client intentionally reports only that provider-reported USD balance.
 */
import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import { resolveKiloApiKey } from "./kilo-config.js";
const KILO_BALANCE_URL = "https://api.kilo.ai/api/profile/balance";
const MAX_RESPONSE_BYTES = 64 * 1024;
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function sanitizeMessage(text, secret, maxLength = 200) {
    const redacted = secret ? text.split(secret).join("[redacted]") : text;
    return (sanitizeSingleLineDisplayText(redacted) || "unknown").slice(0, maxLength);
}
function parseKiloBalance(payload) {
    if (!isRecord(payload)) {
        return {
            success: false,
            error: "Kilo Gateway balance API returned an unexpected response shape",
        };
    }
    const balanceUsd = payload.balance;
    if (typeof balanceUsd !== "number" || !Number.isFinite(balanceUsd) || balanceUsd < 0) {
        return {
            success: false,
            error: "Kilo Gateway balance API returned an invalid balance",
        };
    }
    return { success: true, balanceUsd };
}
export async function queryKiloBalance(options = {}) {
    const resolved = await resolveKiloApiKey();
    if (!resolved)
        return null;
    try {
        return await fetchWithTimeout(KILO_BALANCE_URL, {
            request: {
                method: "GET",
                headers: {
                    Accept: "application/json",
                    Authorization: `Bearer ${resolved.key}`,
                    "Content-Type": "application/json",
                },
                redirect: "manual",
            },
            timeoutMs: options.requestTimeoutMs,
            consume: async (response) => {
                const text = await response.text();
                if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
                    throw new Error(`Kilo Gateway balance API response exceeded ${MAX_RESPONSE_BYTES} bytes`);
                }
                if (!response.ok) {
                    return {
                        success: false,
                        error: `Kilo Gateway balance API error ${response.status}: ${sanitizeMessage(text, resolved.key)}`,
                    };
                }
                return parseKiloBalance(JSON.parse(text));
            },
        });
    }
    catch (error) {
        return {
            success: false,
            error: sanitizeMessage(error instanceof Error ? error.message : String(error), resolved.key),
        };
    }
}
export { parseKiloBalance as _parseKiloBalance };
//# sourceMappingURL=kilo.js.map