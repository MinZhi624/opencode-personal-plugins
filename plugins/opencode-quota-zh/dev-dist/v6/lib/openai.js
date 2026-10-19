/**
 * OpenAI (ChatGPT) quota fetcher
 *
 * Reads OpenCode's OpenAI OAuth logins and queries
 * https://chatgpt.com/backend-api/wham/usage
 */
import { sanitizeDisplayText } from "./display-sanitize.js";
import { clampPercent } from "./format-utils.js";
import { fetchWithTimeout } from "./http.js";
import { finiteNumber, isRecord } from "./json-guards.js";
import { readAuthFileCached } from "./opencode-auth.js";
import { deriveResolvedAuthIdentity } from "./resolved-auth-identity.js";
function parseJwtPayload(token) {
    const parts = token.split(".");
    if (parts.length !== 3)
        return null;
    try {
        return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    }
    catch {
        return null;
    }
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
function positiveSeconds(value) {
    const seconds = finiteNumber(value);
    return seconds !== undefined && seconds > 0 ? seconds : undefined;
}
/** `reset_at` (epoch seconds) when it is a representable date, else `reset_after_seconds` from now. */
function resetTimeIso(window, observedAtMs) {
    const resetAt = positiveSeconds(window.reset_at);
    const resetAfter = positiveSeconds(window.reset_after_seconds);
    return ((resetAt === undefined ? undefined : isoFromMilliseconds(Math.round(resetAt * 1000))) ??
        (resetAfter === undefined
            ? undefined
            : isoFromMilliseconds(observedAtMs + Math.round(resetAfter * 1000))));
}
/** A window reporting `used_percent` (rate limits) or `remaining_percent` (spend limits). */
function parseWindowValue(window, observedAtMs, percentField = "used_percent") {
    if (!isRecord(window))
        return null;
    const percent = finiteNumber(window[percentField]);
    if (percent === undefined)
        return null;
    return {
        percentRemaining: clampPercent(percentField === "used_percent" ? 100 - percent : percent),
        resetTimeIso: resetTimeIso(window, observedAtMs),
    };
}
/** A rate-limit window, classified by its duration; unknown durations are dropped. */
function parseRateLimitWindow(window, observedAtMs) {
    if (!isRecord(window) || typeof window.limit_window_seconds !== "number")
        return null;
    const durationSeconds = window.limit_window_seconds;
    const kind = WINDOW_KIND_BY_DURATION[durationSeconds];
    const value = kind ? parseWindowValue(window, observedAtMs) : null;
    if (!kind || !value)
        return null;
    const endsAtMs = value.resetTimeIso ? Date.parse(value.resetTimeIso) : Number.NaN;
    const startedAtMs = endsAtMs - durationSeconds * 1000;
    if (Number.isFinite(startedAtMs) && startedAtMs < observedAtMs && observedAtMs < endsAtMs) {
        value.fixedWindow = { startedAtIso: new Date(startedAtMs).toISOString() };
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
const OPENAI_AUTH_CACHE_MAX_AGE_MS = 5_000;
// Not `opencode`: in OpenCode 2 its OAuth entry is the Console login, which
// authorizes Console APIs, not OpenAI.
export const OPENAI_AUTH_SOURCE_KEYS = ["openai", "codex", "chatgpt"];
/** The first OAuth login under `openai`, `codex`, `chatgpt` with a token or a resolve error. */
export function resolveOpenAIOAuth(auth) {
    for (const sourceKey of OPENAI_AUTH_SOURCE_KEYS) {
        const entry = auth?.[sourceKey];
        if (entry?.type !== "oauth")
            continue;
        if (entry.resolveError !== undefined) {
            return { state: "failed", sourceKey, error: entry.resolveError };
        }
        const accessToken = typeof entry.access === "string" ? entry.access.trim() : "";
        if (!accessToken)
            continue;
        const jwt = parseJwtPayload(accessToken);
        return {
            state: "configured",
            sourceKey,
            accessToken,
            refreshToken: typeof entry.refresh === "string" && entry.refresh.trim() ? entry.refresh : undefined,
            expiresAt: typeof entry.expires === "number" ? entry.expires : undefined,
            accountId: jwt?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? entry.accountId ?? undefined,
        };
    }
    return { state: "none" };
}
/** The login OpenCode reports as active for `openai`, `codex`, or `chatgpt` (cached briefly). */
export async function readOpenAIAuthCached() {
    return resolveOpenAIOAuth(await readAuthFileCached({
        maxAgeMs: OPENAI_AUTH_CACHE_MAX_AGE_MS,
        integrationIds: OPENAI_AUTH_SOURCE_KEYS,
    }));
}
export async function resolveOpenAIAuthIdentity() {
    const resolved = await readOpenAIAuthCached();
    if (resolved.state !== "configured")
        return null;
    return deriveResolvedAuthIdentity({
        providerId: "openai",
        principal: resolved.accountId
            ? { kind: "stable-id", value: resolved.accountId }
            : { kind: "credential", value: resolved.refreshToken ?? resolved.accessToken },
    });
}
export async function hasOpenAIOAuthCached() {
    return (await readOpenAIAuthCached()).state !== "none";
}
/** A login label that can go into a shell command unquoted and is not read as an option. */
const SHELL_SAFE_LOGIN_LABEL = /^[A-Za-z0-9._@][A-Za-z0-9._@-]*$/u;
/** OpenAI's error codes are short snake_case words, e.g. `no_matching_rule`. */
const OPENAI_ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/u;
/**
 * Only OpenAI's short error code, never the free-text body, which can echo
 * account details.
 */
async function readOpenAIErrorCode(resp) {
    try {
        const body = (await resp.json());
        const code = body?.error?.code;
        return typeof code === "string" && OPENAI_ERROR_CODE.test(code) ? code : undefined;
    }
    catch {
        return undefined;
    }
}
function parseUsageResponse(data) {
    const observedAtMs = Date.now();
    const windows = {};
    // Two windows of the same duration that disagree are both dropped instead of guessing.
    const conflictingKinds = new Set();
    for (const window of [data.rate_limit?.primary_window, data.rate_limit?.secondary_window]) {
        const parsed = parseRateLimitWindow(window, observedAtMs);
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
    const individualLimit = parseWindowValue(data.spend_control?.individual_limit, observedAtMs, "remaining_percent");
    if (!windows.monthly && individualLimit)
        windows.monthly = individualLimit;
    const codeReview = parseWindowValue(data.code_review_rate_limit?.primary_window, observedAtMs);
    if (codeReview)
        windows.codeReview = codeReview;
    if (Object.keys(windows).length === 0) {
        return { success: false, error: "No quota data" };
    }
    return { success: true, label: derivePlanLabel(data.plan_type), windows };
}
export async function queryOpenAIQuota(options) {
    const { auth } = options;
    if (auth.state === "failed") {
        // Signing in again leaves a broken login with another label in place
        // (#316), so name the command that removes it when the label is known.
        // Not trimmed: " Work " is a different login than "Work".
        const label = options.loginLabel;
        const fix = label && SHELL_SAFE_LOGIN_LABEL.test(label)
            ? `Run \`opencode auth logout ${auth.sourceKey} ${label}\`, then \`opencode auth login openai\`.`
            : "Run `opencode auth login openai`.";
        return {
            success: false,
            error: `OpenAI sign-in could not be refreshed: ${auth.error}. ${fix}`,
        };
    }
    if (auth.expiresAt && auth.expiresAt < Date.now()) {
        return { success: false, error: "Token expired" };
    }
    const headers = {
        Authorization: `Bearer ${auth.accessToken}`,
        "User-Agent": "OpenCode-Quota-Toast/1.0",
        ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
    };
    try {
        return await fetchWithTimeout(OPENAI_USAGE_URL, {
            request: { headers },
            timeoutMs: options.requestTimeoutMs,
            consume: async (resp) => {
                if (!resp.ok) {
                    const code = await readOpenAIErrorCode(resp);
                    return {
                        success: false,
                        error: `OpenAI API error ${resp.status}${code ? ` (${code})` : ""}`,
                    };
                }
                return parseUsageResponse((await resp.json()));
            },
        });
    }
    catch (err) {
        return {
            success: false,
            error: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
        };
    }
}
