/**
 * Kimi Code quota (global and China endpoints): the weekly usage and each named limit. Each key
 * stored in OpenCode is queried as its own account; without stored keys, the key the resolver
 * finds is.
 */
import { classifyWindow } from "../core/windows.js";
import { API_KEY_LOGIN_VENDORS, readKeyLogins, resolveApiKeyLogin, resolveApiKeyLoginWithDiagnostics, } from "../lib/api-key-resolver.js";
import { queryKimiQuota } from "../lib/kimi.js";
import { getKimiQuotaEndpoint } from "../lib/kimi-endpoints.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import { failedAccount, fetchKeyLogins, keySlug, quotaRow, } from "./contract.js";
import { apiKeyStatusDetails, statusDetailsFromRecord } from "./result-helpers.js";
/** The weekly window keeps the key `weekly`; every other limit is `limit.<its name>`. */
function kimiRows(windows) {
    return windows.flatMap((window) => {
        const name = window.label.replace(/:+$/u, "").trim();
        const kind = classifyWindow(name);
        const values = { percentRemaining: window.percentRemaining, resetsAt: window.resetTimeIso };
        if (kind === "week")
            return [quotaRow({ key: "weekly", label: name, window: kind, ...values })];
        const limit = keySlug(name.replace(/\s+limit$/iu, "")) || keySlug(name);
        return limit ? [quotaRow({ key: `limit.${limit}`, label: name, window: kind, ...values })] : [];
    });
}
async function fetchKimiQuota(spec, ctx) {
    const { auth, diagnostics } = await resolveApiKeyLoginWithDiagnostics(spec.auth);
    const endpoint = getKimiQuotaEndpoint(spec.endpoint);
    const authDetails = [
        ...apiKeyStatusDetails(diagnostics),
        ...statusDetailsFromRecord({
            api_endpoint: endpoint.id,
            api_base_url: endpoint.apiBaseUrl,
        }),
    ];
    if (auth.state === "none")
        return { attempted: false, accounts: [], debug: authDetails };
    const query = (apiKey) => queryKimiQuota({
        apiKey,
        endpoint: spec.endpoint,
        label: spec.label,
        requestTimeoutMs: ctx.config?.requestTimeoutMs,
    });
    if (diagnostics.source === "opencode.db") {
        const logins = await readKeyLogins(spec.auth);
        if (logins.length > 0) {
            const accounts = await fetchKeyLogins({
                providerName: spec.label,
                logins,
                brokenFirst: true,
                async fetchLogin({ auth: login }) {
                    const result = await query(login.apiKey);
                    return result.success
                        ? { rows: kimiRows(result.windows), errors: [] }
                        : { rows: [], errors: [{ message: result.error }] };
                },
            });
            return { attempted: true, accounts, debug: authDetails };
        }
    }
    if (auth.state === "invalid") {
        return {
            attempted: true,
            accounts: [failedAccount(spec.label, auth.error)],
            debug: authDetails,
        };
    }
    const result = await query(auth.apiKey);
    if (!result.success) {
        return {
            attempted: true,
            accounts: [failedAccount(spec.label, result.error)],
            debug: [...authDetails, { key: "live_fetch_error", value: result.error }],
        };
    }
    return {
        attempted: true,
        accounts: [{ name: result.label, rows: kimiRows(result.windows), errors: [] }],
        debug: [
            ...authDetails,
            ...result.windows.map((window) => ({
                key: window.label.toLowerCase().replace(/\s+/g, "_"),
                value: `used=${window.used}/${window.limit} percent_remaining=${window.percentRemaining} reset_at=${window.resetTimeIso ?? "(none)"}`,
            })),
        ],
    };
}
function kimiProvider(spec) {
    return {
        id: spec.id,
        async isAvailable(ctx) {
            const providerAvailable = await isCanonicalProviderAvailable({
                ctx,
                providerId: spec.id,
                fallbackOnError: false,
            });
            if (!providerAvailable)
                return false;
            const auth = await resolveApiKeyLogin(spec.auth);
            return auth.state === "configured" || auth.state === "invalid";
        },
        matchesCurrentModel(model) {
            const [provider = "", modelId] = model.toLowerCase().split("/", 2);
            return Boolean(modelId) && normalizeQuotaProviderId(provider) === spec.id;
        },
        fetch: (ctx) => fetchKimiQuota(spec, ctx),
    };
}
// Each region has its own key; the legacy aliases (`kimi`, `kimi-code`, ...) belong to CN.
export const kimiCodePlanGlobalProvider = kimiProvider({
    id: "kimi-code-plan-global",
    label: "Kimi Code",
    endpoint: "global",
    auth: API_KEY_LOGIN_VENDORS["kimi-code-plan-global"],
});
export const kimiCodePlanCnProvider = kimiProvider({
    id: "kimi-code-plan-cn",
    label: "Kimi Code (CN)",
    endpoint: "cn",
    auth: API_KEY_LOGIN_VENDORS["kimi-code-plan-cn"],
});
