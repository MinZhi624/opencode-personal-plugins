/**
 * Anthropic Claude quota probing.
 *
 * Uses the local Claude CLI/runtime to detect install/auth state first. When
 * Claude auth is confirmed but local quota windows are missing, it falls back
 * to Anthropic's OAuth usage endpoint using the first usable OAuth access
 * token: OpenCode's own Anthropic login, then Claude OAuth credentials (macOS
 * Keychain first, then the local credentials file).
 */
import { execFile } from "child_process";
import { createHash } from "crypto";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { resolveAnthropicOAuthCached } from "./anthropic-auth.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import { asRecord, finiteNumber, nonEmptyString } from "./json-guards.js";
import { composeResolvedAuthIdentities, deriveResolvedAuthIdentity, } from "./resolved-auth-identity.js";
const DEFAULT_CLAUDE_BINARY = "claude";
/** How `binaryPath` reads when the default `claude` ran from PATH. */
const CLAUDE_ON_PATH_DISPLAY = "claude (PATH)";
const CLAUDE_COMMAND_TIMEOUT_MS = 3_000;
const ANTHROPIC_DIAGNOSTICS_TTL_MS = 5_000;
const ANTHROPIC_OAUTH_BACKOFF_BASE_MS = 30_000;
const ANTHROPIC_OAUTH_COOLDOWN_MAX_MS = 15 * 60_000;
const ANTHROPIC_OAUTH_COOLDOWN_MAX_ENTRIES = 16;
const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const ANTHROPIC_BETA_HEADER = "oauth-2025-04-20";
const CLAUDE_CODE_CREDENTIALS_SERVICE = "Claude Code-credentials";
const CLAUDE_KEYCHAIN_LOCATION = `macOS Keychain service ${CLAUDE_CODE_CREDENTIALS_SERVICE}`;
const CLAUDE_NOT_AUTHENTICATED_MESSAGE = "Claude is not authenticated. Run `claude auth login` and try again.";
const CLAUDE_NO_LOCAL_QUOTA_MESSAGE = "Claude CLI auth detected, but local quota windows were not exposed.";
const ANTHROPIC_NO_QUOTA_MESSAGE = "Claude CLI auth detected, but quota was unavailable from the local CLI and OAuth credential sources.";
const USED_PERCENT_KEYS = [
    "utilization",
    "used_percentage",
    "usedPercentage",
    "used_percent",
    "usedPercent",
    "percent_used",
    "percentUsed",
];
const NESTED_USAGE_KEYS = [
    "quota",
    "usage",
    "rate_limits",
    "rateLimits",
    "oauth_usage",
    "oauthUsage",
];
const UNSUPPORTED_COMMAND_TEXT = ["unknown command", "unrecognized command", "unexpected argument"];
const UNAUTHENTICATED_TEXT = [
    "not logged in",
    "login required",
    "authentication required",
    "run `claude login`",
    "run `claude auth login`",
    "run claude login",
    "run claude auth login",
];
const COMMAND_MISSING_TEXT = [
    "command not found",
    "not recognized as an internal or external command",
    "no such file or directory",
];
const diagnosticsCache = new Map();
const localDiagnosticsCache = new Map();
const anthropicOAuthCooldowns = new Map();
const anthropicOAuthInFlight = new Map();
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
function resolveAnthropicBinaryPath(binaryPath) {
    return binaryPath?.trim() || DEFAULT_CLAUDE_BINARY;
}
/**
 * Usual Claude CLI install locations, tried in order when `anthropicBinaryPath`
 * is not set and `claude` is not on the PATH of the OpenCode service. Windows
 * is skipped: set `anthropicBinaryPath` there.
 */
function claudeInstallFolderCandidates() {
    if (process.platform === "win32")
        return [];
    return [
        join(homedir(), ".claude", "local", "claude"),
        join(homedir(), ".local", "bin", "claude"),
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
    ];
}
function formatCommandDisplayArg(value) {
    const sanitized = sanitizeDisplayText(value);
    return /[\s"]/u.test(sanitized) ? JSON.stringify(sanitized) : sanitized;
}
function quoteWindowsCmdArg(value) {
    const escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1");
    return `"${escaped}"`;
}
export function buildClaudeCommandInvocation(binaryPath, args, runtime = {}) {
    const resolvedBinaryPath = resolveAnthropicBinaryPath(binaryPath);
    const display = [resolvedBinaryPath, ...args].map(formatCommandDisplayArg).join(" ");
    // On Windows, PATH lookups and .cmd/.bat shims only run through cmd.exe.
    const needsWindowsShell = !/[\\/]/u.test(resolvedBinaryPath) || /\.(?:cmd|bat)$/iu.test(resolvedBinaryPath);
    if ((runtime.platform ?? process.platform) === "win32" && needsWindowsShell) {
        return {
            file: runtime.comspec?.trim() || process.env["ComSpec"]?.trim() || "cmd.exe",
            args: ["/d", "/s", "/c", [resolvedBinaryPath, ...args].map(quoteWindowsCmdArg).join(" ")],
            display,
        };
    }
    return { file: resolvedBinaryPath, args: [...args], display };
}
function normalizeResetTimeIso(value) {
    const text = nonEmptyString(value);
    if (!text)
        return undefined;
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}
/** A finite number, or a numeric string such as "35". */
function normalizeUsagePercent(value) {
    if (typeof value !== "string")
        return finiteNumber(value);
    const text = nonEmptyString(value);
    return text === undefined ? undefined : finiteNumber(Number(text));
}
function parseQuotaWindow(window) {
    const record = asRecord(window);
    if (!record)
        return null;
    const used = USED_PERCENT_KEYS.map((key) => normalizeUsagePercent(record[key])).find((percent) => percent !== undefined);
    if (used === undefined)
        return null;
    return {
        percentRemaining: Math.min(100, Math.round(100 - used)),
        resetTimeIso: normalizeResetTimeIso(record["resets_at"] ?? record["resetsAt"] ?? record["reset_at"] ?? record["resetAt"]),
    };
}
function parseExtraUsageQuota(extraUsage) {
    const record = asRecord(extraUsage);
    const used = finiteNumber(record?.["utilization"]);
    if (record?.["is_enabled"] !== true || used === undefined || used < 0 || used > 100) {
        return undefined;
    }
    return { percentRemaining: Math.round(100 - used) };
}
/** The `weekly_scoped` limit for the Fable model in the OAuth usage `limits` list. */
function parseFableWeeklyWindow(limits) {
    if (!Array.isArray(limits))
        return undefined;
    for (const value of limits) {
        const limit = asRecord(value);
        const model = asRecord(asRecord(limit?.["scope"])?.["model"]);
        if (!limit || limit["kind"] !== "weekly_scoped" || model?.["display_name"] !== "Fable") {
            continue;
        }
        const window = parseQuotaWindow({
            utilization: limit["percent"],
            resets_at: limit["resets_at"],
        });
        if (window)
            return window;
    }
    return undefined;
}
/** The first of the response root and its nested usage objects that has both the 5h and 7d windows. */
function findUsageWindows(data) {
    const root = asRecord(data);
    if (!root)
        return null;
    const candidates = [root, ...NESTED_USAGE_KEYS.map((key) => asRecord(root[key]))];
    for (const candidate of candidates) {
        if (!candidate)
            continue;
        const fiveHour = parseQuotaWindow(candidate["five_hour"] ?? candidate["fiveHour"]);
        const sevenDay = parseQuotaWindow(candidate["seven_day"] ?? candidate["sevenDay"]);
        if (fiveHour && sevenDay)
            return { root: candidate, fiveHour, sevenDay };
    }
    return null;
}
/** Quota from Claude CLI `auth status --json`: only the 5h and 7d windows. */
function parseUsageResponse(data) {
    const windows = findUsageWindows(data);
    return windows
        ? { success: true, five_hour: windows.fiveHour, seven_day: windows.sevenDay }
        : null;
}
/** Quota from the OAuth usage endpoint: the 5h and 7d windows, Usage Credits and Fable weekly. */
function parseOAuthUsageResponse(data) {
    const windows = findUsageWindows(data);
    if (!windows)
        return null;
    const extraUsage = parseExtraUsageQuota(windows.root["extra_usage"]);
    const fableWeekly = parseFableWeeklyWindow(windows.root["limits"]);
    return {
        success: true,
        five_hour: windows.fiveHour,
        seven_day: windows.sevenDay,
        ...(extraUsage ? { extra_usage: extraUsage } : {}),
        ...(fableWeekly ? { fable_weekly: fableWeekly } : {}),
    };
}
function buildAnthropicNoQuotaDiagnosticsMessage(detail) {
    const normalizedDetail = detail?.trim();
    return normalizedDetail
        ? `${ANTHROPIC_NO_QUOTA_MESSAGE} ${normalizedDetail}`
        : ANTHROPIC_NO_QUOTA_MESSAGE;
}
function extractClaudeCredentialsAccessToken(data) {
    const root = asRecord(data);
    for (const candidate of [asRecord(root?.["claudeAiOauth"]), asRecord(root?.["oauth"]), root]) {
        for (const key of ["accessToken", "access_token", "token"]) {
            const token = nonEmptyString(candidate?.[key]);
            if (token)
                return token;
        }
    }
    return undefined;
}
/** Reads the access token from stored Claude credentials; the Keychain may hold the bare token. */
function parseClaudeCredentials(content, source) {
    const missing = {
        state: "unavailable",
        detail: `Claude OAuth access token missing in ${source.location}.`,
    };
    const trimmed = content.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        return source.allowPlainText && trimmed
            ? { state: "configured", accessToken: trimmed }
            : missing;
    }
    try {
        const accessToken = extractClaudeCredentialsAccessToken(JSON.parse(trimmed));
        return accessToken ? { state: "configured", accessToken } : missing;
    }
    catch (error) {
        return {
            state: "unavailable",
            detail: `Could not parse ${source.parseFailureLabel}: ${sanitizeDisplayText(errorText(error))}.`,
        };
    }
}
async function runCommand(file, args) {
    return await new Promise((resolve) => {
        execFile(file, args, { encoding: "utf8", timeout: CLAUDE_COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
            if (!error) {
                resolve({ code: 0, stdout, stderr, timedOut: false });
                return;
            }
            const execError = error;
            resolve({
                code: typeof execError.code === "number" ? execError.code : null,
                stdout,
                stderr,
                timedOut: execError.code === "ETIMEDOUT" ||
                    execError.killed === true ||
                    execError.message.toLowerCase().includes("timed out"),
                spawnErrorCode: execError.code,
                errorMessage: execError.message,
            });
        });
    });
}
async function readClaudeCredentialsFromMacOSKeychain() {
    if (process.platform !== "darwin")
        return null;
    const result = await runCommand("security", [
        "find-generic-password",
        "-s",
        CLAUDE_CODE_CREDENTIALS_SERVICE,
        "-w",
    ]);
    if (result.code !== 0)
        return { state: "not-found", location: CLAUDE_KEYCHAIN_LOCATION };
    return parseClaudeCredentials(result.stdout, {
        location: CLAUDE_KEYCHAIN_LOCATION,
        parseFailureLabel: `Claude OAuth credentials from ${CLAUDE_KEYCHAIN_LOCATION}`,
        allowPlainText: true,
    });
}
async function readClaudeCredentialsFromFile() {
    const credentialsPath = join(homedir(), ".claude", ".credentials.json");
    const location = sanitizeDisplayText(credentialsPath);
    let content;
    try {
        content = await readFile(credentialsPath, "utf8");
    }
    catch (error) {
        if (error?.code === "ENOENT") {
            return { state: "not-found", location };
        }
        return {
            state: "unavailable",
            detail: `Could not read Claude credentials file: ${sanitizeDisplayText(errorText(error))}`,
        };
    }
    return parseClaudeCredentials(content, {
        location,
        parseFailureLabel: `Claude credentials file ${location}`,
        allowPlainText: false,
    });
}
async function readClaudeOAuthAccessToken() {
    const notFoundLocations = [];
    const unavailableDetails = [];
    for (const readSource of [
        readClaudeCredentialsFromMacOSKeychain,
        readClaudeCredentialsFromFile,
    ]) {
        const result = await readSource();
        if (result?.state === "configured") {
            return { state: "configured", accessToken: result.accessToken, source: "claude-credentials" };
        }
        if (result?.state === "unavailable")
            unavailableDetails.push(result.detail);
        if (result?.state === "not-found")
            notFoundLocations.push(result.location);
    }
    return {
        state: "unavailable",
        detail: unavailableDetails[0] ??
            `Claude OAuth credentials not found in ${notFoundLocations.join(" or ")}.`,
    };
}
async function readAnthropicOAuthAccessToken(options) {
    const opencodeCredentials = await resolveAnthropicOAuthCached();
    if (opencodeCredentials.state === "configured") {
        return {
            state: "configured",
            accessToken: opencodeCredentials.accessToken,
            source: "opencode-auth",
        };
    }
    return options.includeClaudeCredentials
        ? await readClaudeOAuthAccessToken()
        : { state: "unavailable" };
}
function parseRetryAfterMs(value, nowMs) {
    const trimmed = value?.trim();
    if (!trimmed)
        return undefined;
    if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(trimmed)) {
        const seconds = Number(trimmed);
        return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : undefined;
    }
    const durationMs = Date.parse(trimmed) - nowMs;
    return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : undefined;
}
/** Records a 429 for this token and returns how long the usage probe stays paused. */
function startAnthropicOAuthCooldown(tokenFingerprint, retryAfter) {
    const nowMs = Date.now();
    const failureCount = anthropicOAuthCooldowns.get(tokenFingerprint)?.failureCount ?? 0;
    // Exponential backoff from 30s, raised to Retry-After, capped at 15 minutes.
    const durationMs = Math.min(ANTHROPIC_OAUTH_COOLDOWN_MAX_MS, Math.max(ANTHROPIC_OAUTH_BACKOFF_BASE_MS * 2 ** failureCount, parseRetryAfterMs(retryAfter, nowMs) ?? 0));
    anthropicOAuthCooldowns.set(tokenFingerprint, {
        failureCount: failureCount + 1,
        blockedUntilMs: nowMs + durationMs,
    });
    return durationMs;
}
function getAnthropicOAuthCooldownMessage(remainingMs) {
    const seconds = Math.ceil(Math.min(ANTHROPIC_OAUTH_COOLDOWN_MAX_MS, remainingMs) / 1_000);
    return `Anthropic OAuth usage probe paused after HTTP 429; retry in ${seconds}s.`;
}
/** Bounds the cooldown map, evicting the soonest-expiring entries other than this token. */
function retainAnthropicOAuthCooldownForToken(tokenFingerprint) {
    const targetSize = anthropicOAuthCooldowns.has(tokenFingerprint)
        ? ANTHROPIC_OAUTH_COOLDOWN_MAX_ENTRIES
        : ANTHROPIC_OAUTH_COOLDOWN_MAX_ENTRIES - 1;
    const oldestFirst = [...anthropicOAuthCooldowns.entries()].sort(([, left], [, right]) => left.blockedUntilMs - right.blockedUntilMs);
    for (const [fingerprint] of oldestFirst) {
        if (anthropicOAuthCooldowns.size <= targetSize)
            break;
        if (fingerprint !== tokenFingerprint)
            anthropicOAuthCooldowns.delete(fingerprint);
    }
}
/** Sanitizes a detail and removes the token, also in the form sanitizing may reassemble. */
function redactAccessToken(detail, accessToken) {
    const sanitizedAccessToken = sanitizeDisplayText(accessToken);
    const redactedDetail = sanitizeDisplayText(detail).split(accessToken).join("[redacted]");
    return sanitizedAccessToken
        ? redactedDetail.split(sanitizedAccessToken).join("[redacted]")
        : redactedDetail;
}
async function performAnthropicOAuthUsageRequest(accessToken, tokenFingerprint, requestTimeoutMs) {
    try {
        return await fetchWithTimeout(ANTHROPIC_USAGE_URL, {
            request: {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    "anthropic-beta": ANTHROPIC_BETA_HEADER,
                },
            },
            timeoutMs: requestTimeoutMs,
            consume: async (response, timeoutSignal) => {
                // The cooldown starts before the body is read, so a stalled 429 body still pauses retries.
                const cooldownMs = response.status === 429
                    ? startAnthropicOAuthCooldown(tokenFingerprint, response.headers.get("Retry-After"))
                    : undefined;
                if (cooldownMs === undefined)
                    anthropicOAuthCooldowns.delete(tokenFingerprint);
                if (!response.ok) {
                    const authenticationFailure = response.status === 401 || response.status === 403;
                    let detail = "";
                    try {
                        detail = redactAccessToken(await response.text(), accessToken).slice(0, 120);
                    }
                    catch (error) {
                        // A rejected token needs no body (it triggers the credential fallback);
                        // any other timed-out body read fails the whole request.
                        if (timeoutSignal.aborted && !authenticationFailure)
                            throw error;
                    }
                    const errorDetail = detail
                        ? `Anthropic API error ${response.status}: ${detail}`
                        : `Anthropic API returned ${response.status}`;
                    return {
                        state: "unavailable",
                        detail: cooldownMs === undefined
                            ? errorDetail
                            : `${errorDetail} ${getAnthropicOAuthCooldownMessage(cooldownMs)}`,
                        ...(authenticationFailure ? { failureKind: "authentication" } : {}),
                    };
                }
                let data;
                try {
                    data = await response.json();
                }
                catch (error) {
                    if (timeoutSignal.aborted)
                        throw error;
                    return { state: "unavailable", detail: "Failed to parse Anthropic quota response" };
                }
                const quota = parseOAuthUsageResponse(data);
                return quota
                    ? { state: "success", quota }
                    : { state: "unavailable", detail: "Unexpected Anthropic quota response shape" };
            },
        });
    }
    catch (error) {
        return { state: "unavailable", detail: redactAccessToken(errorText(error), accessToken) };
    }
}
async function queryAnthropicQuotaFromOAuthAccessToken(accessToken, requestTimeoutMs) {
    const tokenFingerprint = createHash("sha256").update(accessToken).digest("hex");
    retainAnthropicOAuthCooldownForToken(tokenFingerprint);
    const nowMs = Date.now();
    const cooldown = anthropicOAuthCooldowns.get(tokenFingerprint);
    if (cooldown && cooldown.blockedUntilMs > nowMs) {
        return {
            state: "unavailable",
            detail: getAnthropicOAuthCooldownMessage(cooldown.blockedUntilMs - nowMs),
        };
    }
    // Concurrent probes with the same token share one request.
    const existingInFlight = anthropicOAuthInFlight.get(tokenFingerprint);
    if (existingInFlight)
        return await existingInFlight;
    const inFlight = performAnthropicOAuthUsageRequest(accessToken, tokenFingerprint, requestTimeoutMs);
    anthropicOAuthInFlight.set(tokenFingerprint, inFlight);
    try {
        return await inFlight;
    }
    finally {
        if (anthropicOAuthInFlight.get(tokenFingerprint) === inFlight) {
            anthropicOAuthInFlight.delete(tokenFingerprint);
        }
    }
}
export async function queryAnthropicQuotaWithOAuth(accessToken, requestTimeoutMs) {
    const result = await queryAnthropicQuotaFromOAuthAccessToken(accessToken, requestTimeoutMs);
    return result.state === "success" ? result.quota : { success: false, error: result.detail };
}
function extractAuthBoolean(data) {
    const record = asRecord(data);
    if (!record)
        return undefined;
    const auth = asRecord(record["auth"]);
    for (const candidate of [
        record["authenticated"],
        record["isAuthenticated"],
        record["loggedIn"],
        auth?.["authenticated"],
        auth?.["loggedIn"],
    ]) {
        if (typeof candidate === "boolean")
            return candidate;
    }
    const status = nonEmptyString(record["status"])?.toLowerCase();
    if (status === "authenticated")
        return true;
    if (status === "unauthenticated")
        return false;
    return undefined;
}
function includesAnyPhrase(output, phrases) {
    const normalized = output.toLowerCase();
    return phrases.some((phrase) => normalized.includes(phrase));
}
function parseVersion(output) {
    const match = output.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
    return match ? match[0] : null;
}
function isCommandMissing(result) {
    return (result.spawnErrorCode === "ENOENT" ||
        includesAnyPhrase(`${result.stderr}\n${result.stdout}\n${result.errorMessage ?? ""}`, COMMAND_MISSING_TEXT));
}
function parseClaudeAuthStatusResult(result) {
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    if (includesAnyPhrase(combinedOutput, UNSUPPORTED_COMMAND_TEXT)) {
        return {
            authStatus: "unknown",
            unsupportedCommand: true,
            message: "Claude CLI authentication status JSON is unavailable in this version of Claude.",
        };
    }
    if (includesAnyPhrase(combinedOutput, UNAUTHENTICATED_TEXT)) {
        return { authStatus: "unauthenticated", message: CLAUDE_NOT_AUTHENTICATED_MESSAGE };
    }
    const trimmed = result.stdout.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            const payload = JSON.parse(trimmed);
            const auth = extractAuthBoolean(payload);
            if (auth === true)
                return { authStatus: "authenticated", jsonPayload: payload };
            if (auth === false) {
                return { authStatus: "unauthenticated", message: CLAUDE_NOT_AUTHENTICATED_MESSAGE };
            }
            return {
                authStatus: "unknown",
                message: "Could not verify Claude authentication status from JSON output.",
            };
        }
        catch {
            // Not JSON after all: fall through to exit-code-based handling.
        }
    }
    if (result.code === 0)
        return { authStatus: "authenticated" };
    if (result.timedOut) {
        return { authStatus: "unknown", message: "Timed out while running Claude CLI auth status." };
    }
    const detail = sanitizeDisplaySnippet(`${result.stderr}\n${result.stdout}\n${result.errorMessage ?? ""}`.trim(), 160);
    return {
        authStatus: "unknown",
        message: detail
            ? `Could not verify Claude authentication status. ${detail}`
            : "Could not verify Claude authentication status.",
    };
}
async function probeAnthropicLocalDiagnostics(configuredBinaryPath) {
    const checkedCommands = [];
    const runClaude = async (binaryPath, args) => {
        const invocation = buildClaudeCommandInvocation(binaryPath, args);
        checkedCommands.push(invocation.display);
        return await runCommand(invocation.file, invocation.args);
    };
    let binaryPath = configuredBinaryPath;
    let versionResult = await runClaude(binaryPath, ["--version"]);
    // No configured path and no `claude` on PATH: the first install folder whose CLI runs wins.
    const installFolderCandidates = configuredBinaryPath === DEFAULT_CLAUDE_BINARY ? claudeInstallFolderCandidates() : [];
    if (isCommandMissing(versionResult)) {
        for (const candidate of installFolderCandidates) {
            if (!existsSync(candidate))
                continue;
            binaryPath = candidate;
            versionResult = await runClaude(candidate, ["--version"]);
            if (!isCommandMissing(versionResult))
                break;
        }
    }
    if (isCommandMissing(versionResult)) {
        const alsoChecked = installFolderCandidates.length > 0
            ? ` Also checked: ${installFolderCandidates.map(sanitizeDisplayText).join(", ")}.`
            : "";
        return {
            installed: false,
            version: null,
            authStatus: "unknown",
            binaryPath: null,
            checkedCommands,
            message: `Claude CLI (\`${sanitizeDisplayText(configuredBinaryPath)}\`) is not installed or not on PATH.${alsoChecked}`,
        };
    }
    const installed = {
        installed: true,
        version: parseVersion(`${versionResult.stdout}\n${versionResult.stderr}`),
        binaryPath: binaryPath === DEFAULT_CLAUDE_BINARY ? CLAUDE_ON_PATH_DISPLAY : binaryPath,
        checkedCommands,
    };
    let parsedAuth = parseClaudeAuthStatusResult(await runClaude(binaryPath, ["auth", "status", "--json"]));
    if (parsedAuth.unsupportedCommand) {
        parsedAuth = parseClaudeAuthStatusResult(await runClaude(binaryPath, ["auth", "status"]));
    }
    if (parsedAuth.authStatus !== "authenticated") {
        return { ...installed, authStatus: parsedAuth.authStatus, message: parsedAuth.message };
    }
    const localQuota = parseUsageResponse(parsedAuth.jsonPayload);
    return localQuota
        ? { ...installed, authStatus: "authenticated", localQuota }
        : { ...installed, authStatus: "authenticated", message: CLAUDE_NO_LOCAL_QUOTA_MESSAGE };
}
export function clearAnthropicDiagnosticsCacheForTests() {
    diagnosticsCache.clear();
    localDiagnosticsCache.clear();
    anthropicOAuthCooldowns.clear();
    anthropicOAuthInFlight.clear();
}
/**
 * Reuses a probe result for a few seconds and shares one in-flight probe
 * between concurrent callers. A failed probe is dropped so the next call retries.
 */
async function getCachedProbe(cache, key, probe) {
    const cached = cache.get(key);
    if (cached && "inFlight" in cached)
        return await cached.inFlight;
    if (cached && Date.now() - cached.timestamp < ANTHROPIC_DIAGNOSTICS_TTL_MS)
        return cached.value;
    const pending = { inFlight: probe() };
    cache.set(key, pending);
    try {
        const value = await pending.inFlight;
        cache.set(key, { value, timestamp: Date.now() });
        return value;
    }
    catch (error) {
        if (cache.get(key) === pending)
            cache.delete(key);
        throw error;
    }
}
async function getCachedAnthropicLocalDiagnostics(binaryPath) {
    const resolvedBinaryPath = resolveAnthropicBinaryPath(binaryPath);
    return await getCachedProbe(localDiagnosticsCache, resolvedBinaryPath, () => probeAnthropicLocalDiagnostics(resolvedBinaryPath));
}
function buildDiagnostics(local, outcome) {
    return {
        installed: local.installed,
        version: local.version,
        authStatus: local.authStatus,
        quotaSupported: outcome.quota !== undefined,
        quotaSource: outcome.quotaSource,
        ...(outcome.oauthCredentialSource
            ? { oauthCredentialSource: outcome.oauthCredentialSource }
            : {}),
        binaryPath: local.binaryPath,
        checkedCommands: local.checkedCommands,
        ...(outcome.message ? { message: outcome.message } : {}),
        ...(outcome.quota ? { quota: outcome.quota } : {}),
    };
}
async function probeAnthropicDiagnostics(binaryPath, requestTimeoutMs) {
    const local = await getCachedAnthropicLocalDiagnostics(binaryPath);
    if (local.localQuota) {
        return buildDiagnostics(local, {
            quotaSource: "claude-auth-status-json",
            quota: local.localQuota,
        });
    }
    const claudeAuthenticated = local.authStatus === "authenticated";
    let credentials = await readAnthropicOAuthAccessToken({
        includeClaudeCredentials: claudeAuthenticated,
    });
    if (credentials.state !== "configured") {
        return buildDiagnostics(local, {
            quotaSource: "none",
            message: claudeAuthenticated
                ? buildAnthropicNoQuotaDiagnosticsMessage(credentials.detail)
                : local.message,
        });
    }
    let fallbackQuota = await queryAnthropicQuotaFromOAuthAccessToken(credentials.accessToken, requestTimeoutMs);
    // A rejected OpenCode login falls back to Claude's own credentials when the Claude CLI is signed in.
    if (fallbackQuota.state === "unavailable" &&
        fallbackQuota.failureKind === "authentication" &&
        credentials.source === "opencode-auth" &&
        claudeAuthenticated) {
        const claudeCredentials = await readClaudeOAuthAccessToken();
        if (claudeCredentials.state === "configured") {
            credentials = claudeCredentials;
            fallbackQuota = await queryAnthropicQuotaFromOAuthAccessToken(claudeCredentials.accessToken, requestTimeoutMs);
        }
    }
    if (fallbackQuota.state !== "success") {
        return buildDiagnostics(local, {
            quotaSource: "none",
            oauthCredentialSource: credentials.source,
            message: buildAnthropicNoQuotaDiagnosticsMessage(fallbackQuota.detail),
        });
    }
    return buildDiagnostics(local, {
        quotaSource: credentials.source === "opencode-auth"
            ? "opencode-auth-oauth-api"
            : "claude-credentials-oauth-api",
        oauthCredentialSource: credentials.source,
        quota: fallbackQuota.quota,
    });
}
export async function getAnthropicDiagnostics(options = {}) {
    const binaryPath = resolveAnthropicBinaryPath(options.binaryPath);
    return await getCachedProbe(diagnosticsCache, binaryPath, () => probeAnthropicDiagnostics(binaryPath, options.requestTimeoutMs));
}
export async function hasAnthropicCredentialsConfigured(options = {}) {
    try {
        const opencodeCredentials = await resolveAnthropicOAuthCached();
        // A login OpenCode could not return still counts, so it shows as an error.
        if (opencodeCredentials.state === "configured" || opencodeCredentials.state === "failed") {
            return true;
        }
    }
    catch {
        // Fall back to the existing local Claude CLI probe.
    }
    try {
        const diagnostics = await getCachedAnthropicLocalDiagnostics(options.binaryPath);
        return diagnostics.installed && diagnostics.authStatus === "authenticated";
    }
    catch {
        return false;
    }
}
export async function resolveAnthropicAuthIdentity(options = {}) {
    let localDiagnostics;
    try {
        localDiagnostics = await getCachedAnthropicLocalDiagnostics(options.binaryPath);
    }
    catch {
        return null;
    }
    // Claude CLI quota does not expose an account identity. Keep that winning
    // path process-local rather than risking reuse after a CLI account switch.
    if (localDiagnostics.localQuota)
        return null;
    const opencodeCredentials = await resolveAnthropicOAuthCached();
    const opencodeIdentity = opencodeCredentials.state === "configured"
        ? await deriveResolvedAuthIdentity({
            providerId: "anthropic:opencode-auth",
            principal: { kind: "credential", value: opencodeCredentials.accessToken },
        })
        : null;
    if (localDiagnostics.authStatus !== "authenticated")
        return opencodeIdentity;
    const claudeCredentials = await readClaudeOAuthAccessToken();
    const claudeIdentity = claudeCredentials.state === "configured"
        ? await deriveResolvedAuthIdentity({
            providerId: "anthropic:claude-credentials",
            principal: { kind: "credential", value: claudeCredentials.accessToken },
        })
        : null;
    if (opencodeIdentity && claudeIdentity) {
        return composeResolvedAuthIdentities({
            providerId: "anthropic",
            identities: [opencodeIdentity, claudeIdentity],
        });
    }
    return opencodeIdentity ?? claudeIdentity;
}
export async function queryAnthropicQuota(options = {}) {
    try {
        const diagnostics = await getAnthropicDiagnostics(options);
        if (diagnostics.quotaSupported)
            return diagnostics.quota ?? null;
        if ((diagnostics.authStatus === "authenticated" ||
            diagnostics.oauthCredentialSource !== undefined) &&
            diagnostics.message) {
            return { success: false, error: diagnostics.message };
        }
        return null;
    }
    catch (err) {
        return {
            success: false,
            error: `Claude CLI probe failed: ${sanitizeDisplayText(errorText(err))}`,
        };
    }
}
export { parseOAuthUsageResponse, parseUsageResponse };
