/**
 * OpenAI (ChatGPT) quota fetcher
 *
 * Uses OpenCode's auth.json native OpenCode OAuth entries and queries:
 * https://chatgpt.com/backend-api/wham/usage
 */
import { sanitizeCredentialErrorText } from "./display-sanitize.js";
import { HOST_CREDENTIAL_FAILURE_REASON, isHostOAuthCredentialFailure, } from "./entries.js";
import { clampPercent } from "./format-utils.js";
import { fetchWithTimeout } from "./http.js";
import { readAuthFileCached } from "./opencode-auth.js";
import { deriveResolvedAuthIdentity } from "./resolved-auth-identity.js";
function base64UrlDecode(input) {
    const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
    const padLen = (4 - (base64.length % 4)) % 4;
    const padded = base64 + "=".repeat(padLen);
    return Buffer.from(padded, "base64").toString("utf8");
}
function parseJwt(token) {
    try {
        const parts = token.split(".");
        if (parts.length !== 3)
            return null;
        return JSON.parse(base64UrlDecode(parts[1]));
    }
    catch {
        return null;
    }
}
export function getEmailFromJwt(token) {
    return parseJwt(token)?.["https://api.openai.com/profile"]?.email ?? null;
}
export function getAccountIdFromJwt(token) {
    return parseJwt(token)?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? null;
}
/**
 * Scope marker of ChatGPT subscription-sharing tokens (the "Sign in with
 * ChatGPT" connection). Such tokens only authorize model calls; the usage
 * endpoint rejects them with 401 with or without an account header.
 */
const MODEL_ONLY_TOKEN_SCOPE = "chatgpt.tokens.use.direct";
function tokenScopes(token) {
    const scope = parseJwt(token)?.scope;
    if (typeof scope === "string") {
        const scopes = scope.split(/[\s,]+/).filter(Boolean);
        return scopes.length > 0 ? scopes : null;
    }
    if (Array.isArray(scope)) {
        return scope.filter((entry) => typeof entry === "string" && entry.length > 0);
    }
    return null;
}
/**
 * True when the access token can only call models and cannot read usage.
 *
 * Only an explicit subscription-sharing scope marks a token as model-only.
 * A token without any scope declaration stays eligible: the Codex CLI login
 * token carries no scope and is currently the only credential that can read
 * usage, so "no scope" must never be treated as "no capability".
 */
export function isModelOnlyOpenAIToken(accessToken) {
    const scopes = tokenScopes(accessToken);
    if (!scopes)
        return false;
    return scopes.includes(MODEL_ONLY_TOKEN_SCOPE);
}
/** True when a locally known token expiry is already in the past. */
export function isOpenAITokenLocallyExpired(expiresAt, nowMs = Date.now()) {
    return typeof expiresAt === "number" && expiresAt < nowMs;
}
const WINDOW_KIND_BY_DURATION = {
    18000: "hourly",
    604800: "weekly",
    2628000: "monthly",
};
function isoFromMilliseconds(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0)
        return undefined;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
function resetIsoFromNowSeconds(seconds, observedAtMs) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
        return undefined;
    }
    return isoFromMilliseconds(observedAtMs + Math.round(seconds * 1000));
}
function resetIsoFromResetAt(resetAt) {
    if (typeof resetAt !== "number" || !Number.isFinite(resetAt) || resetAt <= 0) {
        return undefined;
    }
    return isoFromMilliseconds(Math.round(resetAt * 1000));
}
function parseWindowValue(window, observedAtMs) {
    if (!window || typeof window !== "object")
        return null;
    const value = window;
    if (typeof value.used_percent !== "number" || !Number.isFinite(value.used_percent)) {
        return null;
    }
    return {
        percentRemaining: clampPercent(100 - value.used_percent),
        resetTimeIso: resetIsoFromResetAt(value.reset_at) ??
            resetIsoFromNowSeconds(value.reset_after_seconds, observedAtMs),
    };
}
function parseRemainingWindowValue(window, observedAtMs) {
    if (!window || typeof window !== "object")
        return null;
    const value = window;
    if (typeof value.remaining_percent !== "number" || !Number.isFinite(value.remaining_percent)) {
        return null;
    }
    return {
        percentRemaining: clampPercent(value.remaining_percent),
        resetTimeIso: resetIsoFromResetAt(value.reset_at) ??
            resetIsoFromNowSeconds(value.reset_after_seconds, observedAtMs),
    };
}
function parseRateLimitWindow(window, observedAtMs) {
    if (!window || typeof window !== "object")
        return null;
    const raw = window;
    if (typeof raw.limit_window_seconds !== "number" || !Number.isFinite(raw.limit_window_seconds)) {
        return null;
    }
    const kind = WINDOW_KIND_BY_DURATION[raw.limit_window_seconds];
    if (!kind)
        return null;
    const value = parseWindowValue(window, observedAtMs);
    if (!value)
        return null;
    const endsAtMs = value.resetTimeIso ? Date.parse(value.resetTimeIso) : Number.NaN;
    const startedAtMs = endsAtMs - raw.limit_window_seconds * 1000;
    if (Number.isFinite(startedAtMs) && startedAtMs < observedAtMs && observedAtMs < endsAtMs) {
        value.fixedWindow = {
            kind: "fixed_window",
            startedAtIso: new Date(startedAtMs).toISOString(),
            observedAtIso: new Date(observedAtMs).toISOString(),
            endsAtIso: new Date(endsAtMs).toISOString(),
            fullReset: true,
        };
    }
    return { kind, value };
}
function derivePlanLabel(planType) {
    const normalized = (planType ?? "").trim().toLowerCase();
    if (normalized === "team" || normalized === "business")
        return "OpenAI (Business)";
    if (normalized.includes("pro"))
        return "OpenAI (Pro)";
    if (normalized.includes("plus"))
        return "OpenAI (Plus)";
    if (planType)
        return `OpenAI (${planType})`;
    return "OpenAI";
}
const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS = 5_000;
export const OPENAI_AUTH_SOURCE_KEYS = ["openai", "codex", "chatgpt", "opencode"];
/** Host-managed connection resolved through the OpenCode V2 integration API. */
export const OPENAI_INTEGRATION_SOURCE_KEY = "opencode-integration";
/** Codex CLI login file (`~/.codex/auth.json`). */
export const OPENAI_CODEX_AUTH_SOURCE_KEY = "codex-auth-json";
/**
 * Resolve the active OpenAI OAuth credential from the host (OpenCode V2
 * integration connection). The host owns token refresh, so the returned
 * credential is authoritative and must not be rejected on local expiry alone.
 *
 * A lookup failure is reported as `{ state: "failed" }` with one sanitized
 * line, never as `{ state: "none" }`: "no connection" and "the connection
 * could not be read" are different problems, and only the first one is
 * something the user can fix by logging in.
 */
export async function resolveOpenAIHostCredential(integration) {
    if (!integration?.resolveOAuthCredential)
        return { state: "none" };
    let failure;
    for (const integrationID of ["openai", "chatgpt", "codex"]) {
        let resolved = null;
        try {
            resolved = await integration.resolveOAuthCredential(integrationID);
        }
        catch (error) {
            // Defensive: the integration contract reports a failed lookup as a value,
            // but a host error must still surface instead of ending the query.
            resolved = {
                failed: true,
                reason: sanitizeCredentialErrorText(error instanceof Error ? error.message : String(error)),
            };
        }
        if (!resolved)
            continue;
        if (isHostOAuthCredentialFailure(resolved)) {
            failure ??= resolved.reason || HOST_CREDENTIAL_FAILURE_REASON;
            continue;
        }
        if (!resolved.access)
            continue;
        return {
            state: "configured",
            sourceKey: "opencode-integration",
            accessToken: resolved.access,
            refreshToken: resolved.refresh,
            expiresAt: resolved.expiresAt,
            email: getEmailFromJwt(resolved.access) ?? undefined,
            accountId: getAccountIdFromJwt(resolved.access) ?? undefined,
        };
    }
    return failure === undefined ? { state: "none" } : { state: "failed", reason: failure };
}
function getOpenAIOAuthEntry(auth) {
    for (const sourceKey of OPENAI_AUTH_SOURCE_KEYS) {
        const entry = auth?.[sourceKey];
        if (!entry || entry.type !== "oauth") {
            continue;
        }
        const accessToken = typeof entry.access === "string" ? entry.access.trim() : "";
        if (accessToken) {
            return { sourceKey, entry, accessToken };
        }
    }
    return null;
}
export function resolveOpenAIOAuth(auth) {
    const resolved = getOpenAIOAuthEntry(auth);
    if (!resolved) {
        return { state: "none" };
    }
    const email = getEmailFromJwt(resolved.accessToken) ?? undefined;
    const accountId = getAccountIdFromJwt(resolved.accessToken) ?? resolved.entry.accountId ?? undefined;
    return {
        state: "configured",
        sourceKey: resolved.sourceKey,
        accessToken: resolved.accessToken,
        refreshToken: typeof resolved.entry.refresh === "string" && resolved.entry.refresh.trim()
            ? resolved.entry.refresh
            : undefined,
        expiresAt: typeof resolved.entry.expires === "number" ? resolved.entry.expires : undefined,
        email,
        accountId,
    };
}
export function hasOpenAIOAuth(auth) {
    return resolveOpenAIOAuth(auth).state === "configured";
}
export async function resolveOpenAIAuthIdentity(params) {
    const resolved = params?.auth !== undefined
        ? params.auth
        : resolveOpenAIOAuth(await readAuthFileCached({
            maxAgeMs: Math.max(0, params?.maxAgeMs ?? DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS),
        }));
    if (!resolved || resolved.state !== "configured")
        return null;
    if (resolved.accountId) {
        return deriveResolvedAuthIdentity({
            providerId: "openai",
            principal: { kind: "stable-id", value: resolved.accountId },
        });
    }
    const credential = resolved.refreshToken ?? resolved.accessToken;
    return deriveResolvedAuthIdentity({
        providerId: "openai",
        principal: { kind: "credential", value: credential },
    });
}
export async function hasOpenAIOAuthCached(params) {
    const auth = await readAuthFileCached({
        maxAgeMs: Math.max(0, params?.maxAgeMs ?? DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS),
    });
    return hasOpenAIOAuth(auth);
}
export async function queryOpenAIQuota(options = {}) {
    const credential = options.credential;
    let accessToken;
    let email;
    let accountId;
    let expiresAt;
    // Legacy auth.json credentials are rejected locally on expiry: the plugin
    // cannot refresh them. A caller-supplied credential comes from the host
    // (OpenCode V2) or the Codex CLI, which both own token refresh, so its
    // expiry is not authoritative here unless the caller opts in.
    let rejectOnLocalExpiry = true;
    if (credential) {
        accessToken = credential.access;
        email = credential.email ?? getEmailFromJwt(credential.access) ?? undefined;
        accountId = credential.accountId ?? getAccountIdFromJwt(credential.access) ?? undefined;
        expiresAt = credential.expires;
        rejectOnLocalExpiry = credential.rejectOnLocalExpiry === true;
    }
    else {
        const resolved = resolveOpenAIOAuth(await readAuthFileCached({ maxAgeMs: DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS }));
        if (resolved.state !== "configured")
            return null;
        accessToken = resolved.accessToken;
        email = resolved.email;
        accountId = resolved.accountId;
        expiresAt = resolved.expiresAt;
    }
    if (rejectOnLocalExpiry && isOpenAITokenLocallyExpired(expiresAt)) {
        return { success: false, error: "登录令牌已过期" };
    }
    try {
        const headers = {
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": "OpenCode-Quota-Toast/1.0",
        };
        if (accountId) {
            headers["ChatGPT-Account-Id"] = accountId;
        }
        return await fetchWithTimeout(OPENAI_USAGE_URL, {
            request: { headers },
            timeoutMs: options.requestTimeoutMs,
            consume: async (resp) => {
                if (!resp.ok) {
                    const reason = await readHttpErrorReason(resp);
                    return {
                        success: false,
                        error: reason
                            ? `OpenAI API error ${resp.status}: ${reason}`
                            : `OpenAI API error ${resp.status}`,
                        status: resp.status,
                    };
                }
                const data = (await resp.json());
                const observedAtMs = Date.now();
                const primary = parseRateLimitWindow(data.rate_limit?.primary_window, observedAtMs);
                const secondary = parseRateLimitWindow(data.rate_limit?.secondary_window, observedAtMs);
                const individualLimit = parseRemainingWindowValue(data.spend_control?.individual_limit, observedAtMs);
                const codeReview = parseWindowValue(data.code_review_rate_limit?.primary_window, observedAtMs);
                const credits = data.credits ?? null;
                const windows = {};
                const conflictingKinds = new Set();
                for (const parsed of [primary, secondary]) {
                    if (!parsed || conflictingKinds.has(parsed.kind))
                        continue;
                    const existing = windows[parsed.kind];
                    if (!existing) {
                        windows[parsed.kind] = parsed.value;
                    }
                    else if (existing.percentRemaining !== parsed.value.percentRemaining ||
                        existing.resetTimeIso !== parsed.value.resetTimeIso) {
                        delete windows[parsed.kind];
                        conflictingKinds.add(parsed.kind);
                    }
                }
                if (!windows.monthly && individualLimit)
                    windows.monthly = individualLimit;
                if (codeReview)
                    windows.codeReview = codeReview;
                if (Object.keys(windows).length === 0) {
                    return { success: false, error: "接口未返回额度数据" };
                }
                return {
                    success: true,
                    label: derivePlanLabel(data.plan_type),
                    email,
                    windows,
                    credits: credits
                        ? {
                            hasCredits: Boolean(credits.has_credits),
                            unlimited: Boolean(credits.unlimited),
                            balance: credits.balance ?? null,
                        }
                        : undefined,
                };
            },
        });
    }
    catch (err) {
        return {
            success: false,
            error: sanitizeCredentialErrorText(err instanceof Error ? err.message : String(err)),
        };
    }
}
/**
 * Short, sanitized reason from a non-2xx usage-endpoint response. Provider
 * error bodies can name the rejection cause; they can also echo request
 * data, so the text is redacted and capped before it reaches any surface.
 */
async function readHttpErrorReason(resp) {
    try {
        const raw = (await resp.text()).slice(0, 1024);
        if (!raw.trim())
            return "";
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
            const record = parsed;
            for (const key of ["detail", "message", "error"]) {
                const value = record[key];
                if (typeof value === "string" && value.trim()) {
                    return sanitizeCredentialErrorText(value, 60);
                }
            }
        }
        return sanitizeCredentialErrorText(raw, 60);
    }
    catch {
        return "";
    }
}
