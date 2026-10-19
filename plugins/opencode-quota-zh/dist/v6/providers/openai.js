/**
 * OpenAI (Plus/Pro) provider wrapper.
 */
import { readCodexQuotaAuth } from "../../lib/codex-quota-auth.js";
import { hasOpenAIOAuthCached, OPENAI_AUTH_SOURCE_KEYS, queryOpenAIQuota, readOpenAIAuthCached, resolveOpenAIOAuth, } from "../lib/openai.js";
import { credentialRowAuthEntry, readCredentialRows, } from "../lib/opencode-auth.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import { resolveQuotaProviderSessionModelIdentity } from "../lib/quota-providers.js";
import { FIVE_HOUR, failedAccount, fetchEachLogin, MONTHLY, WEEKLY, windowRows, } from "./contract.js";
import { statusDetailsFromRecord } from "./result-helpers.js";
/**
 * OpenCode 2's "Sign in with ChatGPT" login. Its token is scoped to
 * api.openai.com, and ChatGPT's usage endpoint rejects it with HTTP 401
 * `no_matching_rule` (#316), so it gets a status row instead of a request.
 */
const TOKEN_SHARING_METHOD_ID = "chatgpt-token-sharing";
function isTokenSharingLogin(row) {
    return row.value.methodID === TOKEN_SHARING_METHOD_ID;
}
/** A row that says why a login has no ChatGPT quota number. */
function statusRow(text) {
    return {
        key: "status",
        label: "状态",
        type: "status",
        method: "local_estimation",
        authority: "locally_derived",
        prominence: "primary",
        text,
    };
}
/**
 * Active is per integration: keep the session's active login first, then
 * other active logins, preserving source order within each set. Without the
 * session's login, an active OAuth login (which has quota numbers) goes before
 * an active API key (which only has a status).
 */
function sortActiveLoginsFirst(rows, currentIntegrationId) {
    return [...rows].sort((left, right) => {
        const activeOrder = Number(right.active) - Number(left.active);
        if (activeOrder !== 0 || !left.active)
            return activeOrder;
        const sessionOrder = Number(right.integrationId === currentIntegrationId) -
            Number(left.integrationId === currentIntegrationId);
        if (sessionOrder !== 0)
            return sessionOrder;
        return Number(left.value.type === "api") - Number(right.value.type === "api");
    });
}
function tokenStatus(row, login) {
    if (row.value.type === "api")
        return row.resolveError !== undefined ? "failed" : "api key";
    if (!login)
        return "(none)";
    if (login.state === "failed")
        return "failed";
    return login.expiresAt && login.expiresAt < Date.now() ? "expired" : "valid";
}
/**
 * Status details of the login OpenCode marks active. A row it did not mark
 * active (e.g. an env-selected connection or a failed active lookup) is never
 * reported as the active one.
 */
function activeLoginStatusDetails(rows, logins) {
    const activeRow = rows.find((row) => row.active);
    if (!activeRow) {
        // With stored logins but none marked active, which one OpenCode uses is unknown.
        const value = rows.length > 0 ? "unknown" : "(none)";
        return {
            auth_configured: rows.length > 0 ? "true" : "false",
            auth_source: value,
            auth_method: value,
            token_status: value,
            token_expires_at: value,
        };
    }
    const isKey = activeRow.value.type === "api";
    const login = logins.get(activeRow);
    const expiresAt = login?.state === "configured" ? login.expiresAt : undefined;
    return {
        auth_configured: isKey || login ? "true" : "false",
        auth_source: isKey ? activeRow.integrationId : (login?.sourceKey ?? "(none)"),
        // OpenCode 2's sign-in method, e.g. chatgpt-token-sharing ("Sign in with ChatGPT").
        auth_method: typeof activeRow.value.methodID === "string" ? activeRow.value.methodID : "(none)",
        token_status: tokenStatus(activeRow, login),
        token_expires_at: expiresAt ? new Date(expiresAt).toISOString() : "(none)",
    };
}
const CODE_REVIEW = { key: "code_review", label: "代码审查", window: "code_review" };
function quotaWindowRows(result) {
    return windowRows([
        { slot: FIVE_HOUR, value: result.windows.hourly },
        { slot: WEEKLY, value: result.windows.weekly },
        { slot: MONTHLY, value: result.windows.monthly },
        { slot: CODE_REVIEW, value: result.windows.codeReview },
    ]);
}
/**
 * Without any listed login, OpenCode can still report an active OpenAI
 * sign-in (one its connection list does not show), so query that one.
 */
async function fetchActiveLoginQuota(requestTimeoutMs) {
    const auth = await readOpenAIAuthCached();
    if (auth.state === "none")
        return { attempted: false, accounts: [] };
    const result = await queryOpenAIQuota({ requestTimeoutMs, auth });
    if (!result.success) {
        return { attempted: true, accounts: [failedAccount("OpenAI", result.error)] };
    }
    return {
        attempted: true,
        accounts: [{ name: result.label, rows: quotaWindowRows(result), errors: [] }],
    };
}
export const openaiProvider = {
    id: "openai",
    async isAvailable(ctx) {
        // Best-effort: if provider lookup errors, preserve current permissive fallback.
        if (await isCanonicalProviderAvailable({ ctx, providerId: "openai", fallbackOnError: true })) {
            return true;
        }
        if (await hasOpenAIOAuthCached())
            return true;
        if (await readCodexQuotaAuth())
            return true;
        // Without an OpenAI alias or OAuth login, a stored API key still counts.
        const keyRows = await readCredentialRows(OPENAI_AUTH_SOURCE_KEYS, {
            methods: ["key"],
            firstOnly: true,
        });
        return keyRows.length > 0;
    },
    matchesCurrentModel(model) {
        return modelProviderIncludesAny(model, ["openai", "chatgpt", "codex"]);
    },
    async fetch(ctx) {
        const currentIntegrationId = ctx.config?.currentProviderID ??
            resolveQuotaProviderSessionModelIdentity({ currentModel: ctx.config?.currentModel ?? "" })
                ?.providerId;
        const rows = sortActiveLoginsFirst(await readCredentialRows(OPENAI_AUTH_SOURCE_KEYS, { methods: ["oauth", "key"] }), currentIntegrationId);
        // A login OpenCode could not return stays here, so it shows as its own error.
        const logins = new Map();
        for (const row of rows) {
            if (row.value.type === "api")
                continue;
            const login = resolveOpenAIOAuth({
                [row.integrationId]: credentialRowAuthEntry(row),
            });
            if (login.state !== "none")
                logins.set(row, login);
        }
        const requestTimeoutMs = ctx.config?.requestTimeoutMs;
        // Names span every stored account (OAuth and API key) so numbering and the
        // `(active)` marker match the accounts OpenCode actually holds.
        const accounts = await fetchEachLogin({
            providerName: "OpenAI",
            logins: rows.map((row) => ({ row, login: logins.get(row) })),
            numberUnnamed: (row) => row.value.type === "api",
            async fetchLogin({ row, login }) {
                if (isTokenSharingLogin(row)) {
                    return {
                        rows: [statusRow("ChatGPT quota unavailable for Sign in with ChatGPT")],
                        errors: [],
                    };
                }
                if (row.value.type === "api") {
                    if (row.resolveError !== undefined) {
                        return {
                            rows: [],
                            errors: [{ message: `OpenAI API key 读取失败：${row.resolveError}` }],
                        };
                    }
                    // ChatGPT's usage endpoint only accepts OAuth credentials, so an API-key
                    // account reports its lack of ChatGPT quota instead of a quota number.
                    return { rows: [statusRow("ChatGPT quota unavailable for API key")], errors: [] };
                }
                if (!login)
                    return null;
                const result = await queryOpenAIQuota({
                    requestTimeoutMs,
                    auth: login,
                    loginLabel: row.label,
                });
                if (!result.success)
                    return { rows: [], errors: [{ message: result.error }] };
                return { rows: quotaWindowRows(result), errors: [], fallbackName: result.label };
            },
        });
        const debug = statusDetailsFromRecord(activeLoginStatusDetails(rows, logins));
        // Keep external credentials as a separate, explicitly attributed account.
        // Never relabel their quota as the active OpenCode connection's quota.
        const codexAuth = await readCodexQuotaAuth();
        if (codexAuth) {
            const result = await queryOpenAIQuota({ requestTimeoutMs, auth: codexAuth });
            accounts.push(result.success
                ? { name: `${result.label}（Codex CLI 登录）`, rows: quotaWindowRows(result), errors: [] }
                : failedAccount("OpenAI（Codex CLI 登录）", `${result.error}；请在终端运行 codex login 更新登录`));
        }
        if (accounts.length > 0)
            return { attempted: true, accounts, debug };
        return { ...(await fetchActiveLoginQuota(requestTimeoutMs)), debug };
    },
};
