/**
 * Z.ai and Zhipu: one GLM coding plan fetcher with two endpoints. Each key stored in OpenCode
 * is queried as its own account; without stored keys, the key the resolver finds is.
 */
import { getApiKeyLoginDiagnostics, readKeyLogins, resolveApiKeyLogin, } from "../lib/api-key-resolver.js";
import { GLM_ENDPOINTS, queryGlmCodingPlanQuota, } from "../lib/glm-coding-plan.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { FIVE_HOUR, failedAccount, fetchKeyLogins, WEEKLY, windowRows, } from "./contract.js";
import { apiKeyStatusDetails, statusDetailsFromRecord } from "./result-helpers.js";
const MCP = { key: "mcp", label: "MCP", window: "mcp" };
function glmRows(quota) {
    return windowRows([
        { slot: FIVE_HOUR, value: quota.windows.fiveHour },
        { slot: WEEKLY, value: quota.windows.weekly },
        { slot: MCP, value: quota.windows.mcp },
    ]);
}
function formatWindow(window) {
    return window
        ? `${window.percentRemaining}% reset_at=${window.resetTimeIso ?? "(none)"}`
        : undefined;
}
async function fetchGlmQuota(endpoint, ctx) {
    const requestTimeoutMs = ctx.config?.requestTimeoutMs;
    const diagnostics = await getApiKeyLoginDiagnostics(endpoint.auth);
    const authDetails = apiKeyStatusDetails(diagnostics);
    if (diagnostics.source === "opencode.db") {
        const logins = await readKeyLogins(endpoint.auth);
        if (logins.length > 0) {
            const accounts = await fetchKeyLogins({
                providerName: endpoint.label,
                logins,
                brokenFirst: false,
                async fetchLogin({ auth }) {
                    const result = await queryGlmCodingPlanQuota(endpoint, {
                        requestTimeoutMs,
                        apiKey: auth.apiKey,
                    });
                    if (!result)
                        return null;
                    if (!result.success)
                        return { rows: [], errors: [{ message: result.error }] };
                    return { rows: glmRows(result), errors: [] };
                },
            });
            return { attempted: true, accounts, debug: authDetails };
        }
    }
    const result = await queryGlmCodingPlanQuota(endpoint, { requestTimeoutMs });
    const windows = result?.success ? result.windows : {};
    const debug = [
        ...authDetails,
        ...statusDetailsFromRecord({
            live_fetch_error: !result
                ? `${endpoint.label} API key became unavailable before fetch`
                : result.success
                    ? undefined
                    : result.error,
            five_hour_remaining: formatWindow(windows.fiveHour),
            weekly_remaining: formatWindow(windows.weekly),
            mcp_remaining: formatWindow(windows.mcp),
            live_state: result?.success && !windows.fiveHour && !windows.weekly && !windows.mcp
                ? `no reportable ${endpoint.label} quota windows`
                : undefined,
        }),
    ];
    if (!result)
        return { attempted: false, accounts: [], debug };
    if (!result.success) {
        return { attempted: true, accounts: [failedAccount(endpoint.label, result.error)], debug };
    }
    return {
        attempted: true,
        accounts: [{ name: result.label, rows: glmRows(result), errors: [] }],
        debug,
    };
}
function glmProvider(id, matchesCurrentModel) {
    const endpoint = GLM_ENDPOINTS[id];
    return {
        id,
        async isAvailable(ctx) {
            const providerAvailable = await isCanonicalProviderAvailable({
                ctx,
                providerId: id,
                fallbackOnError: false,
            });
            if (!providerAvailable)
                return false;
            const auth = await resolveApiKeyLogin(endpoint.auth);
            return auth.state === "configured" || auth.state === "invalid";
        },
        matchesCurrentModel,
        fetch: (ctx) => fetchGlmQuota(endpoint, ctx),
    };
}
export const zaiProvider = glmProvider("zai", (model) => {
    const lower = model.toLowerCase();
    const provider = lower.split("/")[0] ?? "";
    return provider.includes("zai") || lower.includes("glm");
});
export const zhipuProvider = glmProvider("zhipu", (model) => {
    const provider = model.toLowerCase().split("/")[0] ?? "";
    return provider.includes("zhipu") || provider === "glm-coding-plan";
});
