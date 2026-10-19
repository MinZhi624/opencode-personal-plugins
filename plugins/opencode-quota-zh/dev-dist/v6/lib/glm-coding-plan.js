import { API_KEY_LOGIN_VENDORS, resolveApiKeyLogin, } from "./api-key-resolver.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { clampPercent } from "./format-utils.js";
import { fetchWithTimeout } from "./http.js";
export const GLM_ENDPOINTS = {
    zai: {
        label: "Z.ai",
        endpoint: "https://api.z.ai/api/monitor/usage/quota/limit",
        httpErrorPrefix: "Z.ai API error",
        apiErrorPrefix: "Z.ai API error",
        envelope: "zai",
        auth: API_KEY_LOGIN_VENDORS.zai,
    },
    zhipu: {
        label: "Zhipu",
        endpoint: "https://bigmodel.cn/api/monitor/usage/quota/limit",
        httpErrorPrefix: "Zhipu API error",
        envelope: "zhipu",
        auth: API_KEY_LOGIN_VENDORS.zhipu,
    },
};
export async function queryGlmCodingPlanQuota(descriptor, options = {}) {
    const auth = options.apiKey
        ? { state: "configured", apiKey: options.apiKey }
        : await resolveApiKeyLogin(descriptor.auth);
    if (auth.state === "none")
        return null;
    if (auth.state === "invalid")
        return { success: false, error: auth.error };
    try {
        return await fetchWithTimeout(descriptor.endpoint, {
            request: {
                headers: {
                    Authorization: auth.apiKey,
                    "User-Agent": "OpenCode-Quota-Toast/1.0",
                    "Content-Type": "application/json",
                },
            },
            timeoutMs: options.requestTimeoutMs,
            consume: async (response) => {
                if (!response.ok) {
                    const body = sanitizeDisplaySnippet(await response.text(), 120);
                    return {
                        success: false,
                        error: `${descriptor.httpErrorPrefix} ${response.status}: ${body}`,
                    };
                }
                const body = (await response.json());
                if (descriptor.envelope === "zai" &&
                    (body.success === false || (typeof body.code === "number" && body.code >= 400))) {
                    const message = typeof body.msg === "string" ? sanitizeDisplayText(body.msg) : "";
                    return {
                        success: false,
                        error: message ||
                            (typeof body.code === "number"
                                ? `${descriptor.apiErrorPrefix} ${body.code}`
                                : descriptor.apiErrorPrefix),
                    };
                }
                const limits = descriptor.envelope === "zai" ? (body.data?.limits ?? body.limits) : body.data?.limits;
                if (!Array.isArray(limits))
                    return { success: false, error: "Invalid quota data" };
                const windows = {};
                for (const limit of limits) {
                    const resetDate = limit.nextResetTime ? new Date(Math.round(limit.nextResetTime)) : null;
                    const resetTimeIso = resetDate && Number.isFinite(resetDate.valueOf()) && resetDate.valueOf() > 0
                        ? resetDate.toISOString()
                        : undefined;
                    let percentRemaining = clampPercent(100 - limit.percentage);
                    if (limit.type === "CREDIT_LIMIT" &&
                        typeof limit.usage === "number" &&
                        Number.isFinite(limit.usage) &&
                        limit.usage > 0 &&
                        typeof limit.currentValue === "number" &&
                        Number.isFinite(limit.currentValue) &&
                        limit.currentValue >= 0) {
                        percentRemaining = clampPercent(((limit.usage - limit.currentValue) / limit.usage) * 100);
                    }
                    const window = { percentRemaining, resetTimeIso };
                    const isQuotaWindow = limit.type === "TOKENS_LIMIT" || limit.type === "CREDIT_LIMIT";
                    if (isQuotaWindow && limit.unit === 3)
                        windows.fiveHour = window;
                    else if (isQuotaWindow && limit.unit === 6)
                        windows.weekly = window;
                    else if (limit.type === "TIME_LIMIT")
                        windows.mcp = window;
                }
                return { success: true, label: descriptor.label, windows };
            },
        });
    }
    catch (error) {
        return {
            success: false,
            error: sanitizeDisplayText(error instanceof Error ? error.message : String(error)),
        };
    }
}
