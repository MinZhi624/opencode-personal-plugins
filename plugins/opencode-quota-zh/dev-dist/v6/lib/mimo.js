import { sanitizeSingleLineDisplaySnippet } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import { isRecord } from "./json-guards.js";
const MIMO_ORIGIN = "https://platform.xiaomimimo.com";
const MIMO_REQUEST_TIMEOUT_MS = 10_000;
const MIMO_RESPONSE_MAX_BYTES = 256 * 1024;
const MIMO_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
function parseEnvelope(json) {
    if (!isRecord(json) || json.code !== 0 || !isRecord(json.data)) {
        throw new Error("invalid envelope");
    }
    return json.data;
}
function parseNonNegativeNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
/** Balances arrive as decimal strings ("50.00") or numbers; a missing or empty field is not reported. */
function parseOptionalBalance(value) {
    if (value === undefined || value === null || value === "")
        return null;
    const amount = parseNonNegativeNumber(typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value.trim()) ? Number(value) : value);
    if (amount === null)
        throw new Error("invalid balance");
    return amount;
}
function nonBlankStringOrNull(value) {
    return typeof value === "string" && value.trim() ? value : null;
}
function parseMimoUsageResponse(json) {
    const data = parseEnvelope(json);
    if (!isRecord(data.monthUsage) || !Array.isArray(data.monthUsage.items)) {
        throw new Error("missing monthly usage");
    }
    const item = data.monthUsage.items.find((candidate) => isRecord(candidate) && candidate.name === "month_total_token");
    if (!isRecord(item))
        throw new Error("missing monthly quota");
    const used = parseNonNegativeNumber(item.used);
    const limit = parseNonNegativeNumber(item.limit);
    if (used === null || limit === null || limit <= 0) {
        throw new Error("invalid monthly quota");
    }
    return { used, limit };
}
function parseMimoDetailResponse(json) {
    const data = parseEnvelope(json);
    if (typeof data.expired !== "boolean")
        throw new Error("invalid plan state");
    return {
        planName: nonBlankStringOrNull(data.planName),
        planCode: nonBlankStringOrNull(data.planCode),
        expired: data.expired,
    };
}
function parseMimoBalanceResponse(json) {
    const data = parseEnvelope(json);
    return {
        total: parseOptionalBalance(data.balance),
        cash: parseOptionalBalance(data.cashBalance),
        gift: parseOptionalBalance(data.giftBalance),
        currency: typeof data.currency === "string" && /^[A-Za-z]{3}$/u.test(data.currency.trim())
            ? data.currency.trim().toUpperCase()
            : null,
    };
}
async function readBoundedJson(response) {
    if (!response.body)
        throw new Error("empty response");
    const reader = response.body.getReader();
    const chunks = [];
    let byteLength = 0;
    try {
        const contentLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > MIMO_RESPONSE_MAX_BYTES) {
            throw new Error("response too large");
        }
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            byteLength += value.byteLength;
            if (byteLength > MIMO_RESPONSE_MAX_BYTES) {
                throw new Error("response too large");
            }
            chunks.push(value);
        }
    }
    catch (error) {
        try {
            await reader.cancel();
        }
        catch {
            // Preserve the original read or size-limit error.
        }
        throw error;
    }
    finally {
        reader.releaseLock();
    }
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
}
function formatMimoDashboardTimeZone(timezoneOffsetMinutes) {
    const javascriptOffset = timezoneOffsetMinutes ?? new Date().getTimezoneOffset();
    const utcOffset = -javascriptOffset;
    const sign = utcOffset >= 0 ? "+" : "-";
    const absoluteMinutes = Math.abs(utcOffset);
    const hours = Math.floor(absoluteMinutes / 60);
    const minutes = absoluteMinutes % 60;
    return `UTC${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
/** Redacts the whole cookie and each cookie value, since request errors can echo them. */
function sanitizeRequestError(error, cookie) {
    const cookieValues = cookie
        .split(";")
        .map((part) => part.slice(part.indexOf("=") + 1).trim())
        .filter(Boolean);
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of [cookie, ...cookieValues]) {
        message = message.split(secret).join("[redacted]");
    }
    return sanitizeSingleLineDisplaySnippet(message, 120) || "request failed";
}
async function fetchMimoEndpoint(name, path, parse, context) {
    const fail = (problem) => ({
        state: "error",
        error: `Xiaomi MiMo ${name} ${problem}`,
    });
    try {
        return await fetchWithTimeout(`${MIMO_ORIGIN}/api/v1${path}`, {
            request: {
                method: "GET",
                redirect: "manual",
                headers: {
                    Accept: "application/json, text/plain, */*",
                    "Accept-Language": "en-US,en;q=0.9",
                    Cookie: context.cookie,
                    Origin: MIMO_ORIGIN,
                    Referer: `${MIMO_ORIGIN}/#/console/balance`,
                    "User-Agent": MIMO_USER_AGENT,
                    "x-timeZone": context.timeZone,
                },
            },
            timeoutMs: context.timeoutMs,
            consume: async (response, timeoutSignal) => {
                if (response.status >= 300 && response.status < 400)
                    return fail("request requires login");
                if (!response.ok)
                    return fail(`request failed (HTTP ${response.status})`);
                let json;
                try {
                    json = await readBoundedJson(response);
                }
                catch (error) {
                    // Let a timeout reach the outer catch so it is reported as a timeout.
                    if (timeoutSignal.aborted)
                        throw error;
                    return fail("response could not be parsed");
                }
                try {
                    return { state: "success", data: parse(json) };
                }
                catch {
                    return fail("response did not match the expected schema");
                }
            },
        });
    }
    catch (error) {
        return fail(`request failed: ${sanitizeRequestError(error, context.cookie)}`);
    }
}
export async function queryMimoDashboard(cookie, options = {}) {
    const context = {
        cookie,
        timeoutMs: options.requestTimeoutMs ?? MIMO_REQUEST_TIMEOUT_MS,
        timeZone: formatMimoDashboardTimeZone(),
    };
    const [usage, detail, balance] = await Promise.all([
        fetchMimoEndpoint("usage", "/tokenPlan/usage", parseMimoUsageResponse, context),
        fetchMimoEndpoint("detail", "/tokenPlan/detail", parseMimoDetailResponse, context),
        fetchMimoEndpoint("balance", "/balance", parseMimoBalanceResponse, context),
    ]);
    return { usage, detail, balance };
}
