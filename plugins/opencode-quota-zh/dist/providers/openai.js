/**
 * OpenAI (Plus/Pro) provider wrapper.
 *
 * Reading ChatGPT usage needs a login that is allowed to call the usage
 * endpoint, and one machine can hold several OpenAI logins at once: the host
 * connection (OpenCode V2 integration), OpenCode's own auth.json and the
 * Codex CLI login file. Only some of them can read usage, so the provider
 * walks an ordered candidate chain and uses the first candidate that returns
 * quota data. A subscription-sharing token is recognized from its JWT scope
 * and skipped without sending a request, and a chain that yields no quota
 * reports one sanitized, actionable reason instead of a bare status code or
 * 0% rows.
 */
import { hasOpenAICodexAuth, readCodexAuthCredential } from "../lib/codex-auth.js";
import { sanitizeCredentialErrorText } from "../lib/display-sanitize.js";
import { HOST_CREDENTIAL_FAILURE_REASON, } from "../lib/entries.js";
import { DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS, hasOpenAIOAuthCached, isModelOnlyOpenAIToken, isOpenAITokenLocallyExpired, OPENAI_CODEX_AUTH_SOURCE_KEY, OPENAI_INTEGRATION_SOURCE_KEY, queryOpenAIQuota, resolveOpenAIOAuth, resolveOpenAIHostCredential, } from "../lib/openai.js";
import { readAuthFileCached } from "../lib/opencode-auth.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import { attemptedErrorResult, attemptedResult, groupedPercentWindowEntries, statusDetailsFromRecord, withStatusDetails, } from "./result-helpers.js";
/** Diagnostic labels of the credential chain, in candidate order. */
const HOST_CREDENTIAL_SOURCE = "宿主连接";
const LEGACY_CREDENTIAL_SOURCE = "OpenCode auth.json";
const CODEX_CREDENTIAL_SOURCE = "Codex 登录";
/** Fix action offered whenever a ChatGPT login must be (re-)established. */
const CODEX_LOGIN_ACTION = "codex login";
function toCredentialCandidate(source, resolved, rejectOnLocalExpiry) {
    // A source that exists but cannot be read is reported as a failure, never as
    // "no credential": the sanitized reason is the only clue the user gets.
    if (resolved.state === "failed") {
        return { source, resolveFailure: resolved.reason || HOST_CREDENTIAL_FAILURE_REASON };
    }
    if (resolved.state !== "configured") {
        return { source };
    }
    return {
        source,
        sourceKey: resolved.sourceKey,
        expiresAt: resolved.expiresAt,
        credential: {
            access: resolved.accessToken,
            ...(resolved.refreshToken ? { refresh: resolved.refreshToken } : {}),
            ...(resolved.expiresAt ? { expires: resolved.expiresAt } : {}),
            ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
            ...(resolved.email ? { email: resolved.email } : {}),
            rejectOnLocalExpiry,
        },
    };
}
/**
 * Ordered credential candidates. The host connection comes first because the
 * host owns token refresh; OpenCode's legacy auth.json follows and is the
 * only source rejected on local expiry (this plugin cannot refresh it); the
 * Codex CLI login file comes last and is refreshed by the Codex CLI.
 */
async function resolveOpenAICredentialCandidates(ctx) {
    const [host, legacyAuth, codex] = await Promise.all([
        resolveOpenAIHostCredential(ctx.client.integration),
        readAuthFileCached({ maxAgeMs: DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS }),
        readCodexAuthCredential(),
    ]);
    return [
        toCredentialCandidate(HOST_CREDENTIAL_SOURCE, host, false),
        toCredentialCandidate(LEGACY_CREDENTIAL_SOURCE, resolveOpenAIOAuth(legacyAuth), true),
        toCredentialCandidate(CODEX_CREDENTIAL_SOURCE, codex, false),
    ];
}
const CHAIN_OUTCOME_TEXT = {
    used: "使用中",
    rejected: "额度接口拒绝",
    failed: "查询失败",
    resolve_failed: "凭据解析失败",
    expired: "登录令牌已过期",
    model_only: "订阅共享令牌已跳过",
    none: "无凭据",
};
function chainOutcomeText(attempt) {
    if (attempt.outcome === "rejected" && attempt.status !== undefined) {
        return `额度接口拒绝（HTTP ${attempt.status}）`;
    }
    return CHAIN_OUTCOME_TEXT[attempt.outcome];
}
/**
 * Single-line summary of the chain for diagnostics. Only source labels,
 * outcome wording and HTTP statuses are joined here; failure reasons and
 * tokens never reach this string.
 */
function formatCredentialChain(attempts) {
    if (attempts.length === 0)
        return "(none)";
    return attempts.map((attempt) => `${attempt.source}: ${chainOutcomeText(attempt)}`).join(" | ");
}
function credentialTokenStatus(candidate) {
    if (!candidate)
        return "(none)";
    if (candidate.sourceKey === OPENAI_INTEGRATION_SOURCE_KEY)
        return "host_managed";
    if (candidate.sourceKey === OPENAI_CODEX_AUTH_SOURCE_KEY)
        return "codex_managed";
    // Legacy auth.json entries cannot be refreshed here, so a known expiry in
    // the past is final; host and Codex credentials are refreshed by their
    // owners and only report their managed state.
    return isOpenAITokenLocallyExpired(candidate.expiresAt) ? "expired" : "valid";
}
/**
 * Status details of the credential that the chain settled on: the winning
 * candidate on success, otherwise the last candidate that held a credential.
 */
function credentialStatusDetails(active, attempts) {
    return statusDetailsFromRecord({
        auth_configured: active ? "true" : "false",
        auth_source: active?.sourceKey ?? "(none)",
        token_status: credentialTokenStatus(active),
        token_expires_at: active?.expiresAt !== undefined ? new Date(active.expiresAt).toISOString() : "(none)",
        credential_chain: formatCredentialChain(attempts),
    });
}
/**
 * Reason embedded in a chain failure message. `queryOpenAIQuota` reports a
 * non-2xx answer as `OpenAI API error <status>: <reason>`; the chain re-labels
 * that text itself, so the redundant prefix is dropped.
 */
function apiFailureReason(error) {
    if (!error)
        return "";
    return sanitizeCredentialErrorText(error.replace(/^OpenAI API error \d+(?::\s*)?/u, ""), 60);
}
/**
 * Failure text for a chain that produced no quota. The most informative
 * outcome wins: an explicit API rejection first, then a failed request, a
 * host credential that could not be resolved, an expired legacy token, a
 * model-only token, and finally "nothing found". Every message is one
 * sanitized line, and an API reason is capped and redacted before it is
 * embedded.
 */
function chainFailureMessage(attempts) {
    const rejected = attempts.find((attempt) => attempt.outcome === "rejected");
    if (rejected) {
        const reason = apiFailureReason(rejected.reason);
        const status = rejected.status === undefined ? "" : `（HTTP ${rejected.status}）`;
        // 401/403 means the login itself cannot read usage: only a new ChatGPT
        // login (for example via the Codex CLI) can fix that.
        const retryAction = rejected.status === 401 || rejected.status === 403
            ? `，请运行 ${CODEX_LOGIN_ACTION} 后重试`
            : "";
        return sanitizeCredentialErrorText(`OpenAI 额度接口拒绝请求${status}${reason ? `：${reason}` : ""}${retryAction}`);
    }
    const failed = attempts.find((attempt) => attempt.outcome === "failed");
    if (failed) {
        const reason = failed.reason ? sanitizeCredentialErrorText(failed.reason, 60) : "";
        return sanitizeCredentialErrorText(reason ? `OpenAI 额度查询失败：${reason}` : "OpenAI 额度查询失败，请稍后重试");
    }
    // A credential source that could not be read is not a missing login: the
    // reason stays sanitized and the action is local (reconnect / restart).
    const resolveFailed = attempts.find((attempt) => attempt.outcome === "resolve_failed");
    if (resolveFailed) {
        const reason = resolveFailed.reason ? sanitizeCredentialErrorText(resolveFailed.reason, 60) : "";
        return sanitizeCredentialErrorText(reason
            ? `OpenAI 宿主连接凭据解析失败：${reason}`
            : `OpenAI 宿主连接凭据解析失败，请重新连接 OpenAI 或重启 OpenCode 后重试`);
    }
    if (attempts.some((attempt) => attempt.outcome === "expired")) {
        return sanitizeCredentialErrorText(`未找到可用的 OpenAI 登录凭据（登录令牌已过期），请重新登录 OpenAI 或运行 ${CODEX_LOGIN_ACTION} 后重试`);
    }
    if (attempts.some((attempt) => attempt.outcome === "model_only")) {
        return sanitizeCredentialErrorText(`当前 OpenAI 登录为订阅共享令牌，仅支持模型调用，无法读取用量额度；请运行 ${CODEX_LOGIN_ACTION} 后重试`);
    }
    return sanitizeCredentialErrorText(`未找到可用的 OpenAI 登录凭据，请登录 OpenAI 或运行 ${CODEX_LOGIN_ACTION} 后重试`);
}
export const openaiProvider = {
    id: "openai",
    async isAvailable(ctx) {
        // Best-effort: if provider lookup errors, preserve current permissive fallback.
        const availableByProviderId = await isCanonicalProviderAvailable({
            ctx,
            providerId: "openai",
            fallbackOnError: true,
        });
        if (availableByProviderId) {
            return true;
        }
        const host = await resolveOpenAIHostCredential(ctx.client.integration);
        // A host connection counts as configured even when it cannot be read:
        // running the fetch keeps the sanitized failure visible in the chain
        // instead of the provider silently disappearing from the panel.
        if (host.state !== "none") {
            return true;
        }
        // A Codex CLI login is a quota-capable credential even when no OpenAI
        // provider entry exists in the host config.
        if (await hasOpenAICodexAuth()) {
            return true;
        }
        return hasOpenAIOAuthCached({ maxAgeMs: DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS });
    },
    matchesCurrentModel(model) {
        return modelProviderIncludesAny(model, ["openai", "chatgpt", "codex"]);
    },
    async fetch(ctx) {
        const candidates = await resolveOpenAICredentialCandidates(ctx);
        const attempts = [];
        let used;
        let lastWithCredential;
        for (const candidate of candidates) {
            // A source that could not be read never reaches a request: record it
            // first so the chain shows the source and the sanitized reason.
            if (candidate.resolveFailure !== undefined) {
                attempts.push({
                    source: candidate.source,
                    outcome: "resolve_failed",
                    reason: candidate.resolveFailure,
                });
                continue;
            }
            const credential = candidate.credential;
            if (!credential) {
                attempts.push({ source: candidate.source, outcome: "none" });
                continue;
            }
            lastWithCredential = candidate;
            // A subscription-sharing token only authorizes model calls: the usage
            // endpoint rejects it with 401, so skip it without sending a request.
            if (isModelOnlyOpenAIToken(credential.access)) {
                attempts.push({
                    source: candidate.source,
                    outcome: "model_only",
                    expiresAt: candidate.expiresAt,
                });
                continue;
            }
            // Only legacy auth.json credentials are rejected on local expiry: this
            // plugin cannot refresh them, while the host and the Codex CLI can.
            if (credential.rejectOnLocalExpiry && isOpenAITokenLocallyExpired(candidate.expiresAt)) {
                attempts.push({
                    source: candidate.source,
                    outcome: "expired",
                    expiresAt: candidate.expiresAt,
                });
                continue;
            }
            const result = await queryOpenAIQuota({
                requestTimeoutMs: ctx.config?.requestTimeoutMs,
                credential,
            });
            if (result?.success) {
                used = candidate;
                attempts.push({
                    source: candidate.source,
                    outcome: "used",
                    expiresAt: candidate.expiresAt,
                });
                // Quota rows are only built from a successful read: a chain that
                // fails must never degrade into 0% or empty entries.
                return withStatusDetails(attemptedResult(groupedPercentWindowEntries({
                    group: result.label,
                    accounting: {
                        resultType: "rate_limit",
                        acquisitionMethod: "remote_api",
                        ownership: "maintained",
                        authority: "provider_reported",
                    },
                    windows: [
                        { window: result.windows.hourly, suffix: "5h", label: "5h:" },
                        { window: result.windows.weekly, suffix: "Weekly", label: "Weekly:" },
                        { window: result.windows.monthly, suffix: "Monthly", label: "Monthly:" },
                        { window: result.windows.codeReview, suffix: "Code Review", label: "Code Review:" },
                    ],
                }), [], {
                    singleWindowDisplayName: result.label,
                }), credentialStatusDetails(candidate, attempts));
            }
            // A non-2xx answer carries an HTTP status: the credential was rejected,
            // so the next candidate may still be able to read usage.
            if (result?.status !== undefined) {
                attempts.push({
                    source: candidate.source,
                    outcome: "rejected",
                    status: result.status,
                    reason: result.error,
                    expiresAt: candidate.expiresAt,
                });
                continue;
            }
            attempts.push({
                source: candidate.source,
                outcome: "failed",
                reason: result?.error,
                expiresAt: candidate.expiresAt,
            });
        }
        return withStatusDetails(attemptedErrorResult("OpenAI", chainFailureMessage(attempts)), credentialStatusDetails(used ?? lastWithCredential, attempts));
    },
};
