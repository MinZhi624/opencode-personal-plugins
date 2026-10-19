/**
 * The export file (version 3) for scripts and status bars, and `opencode-quota show --json`,
 * written from quota rows. Each check gives its provider's part of the file
 * (`exportProviderFromCheck`, from the check's rows as the snapshot shows them): the server
 * keeps that part, in memory only, next to the provider's snapshot, so the file shows the last
 * check, a failed one too. A provider without one (in the terminal command, or before its first
 * check since the server started) is written from its snapshot.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { describeError } from "../core/errors.js";
import { rowValueText } from "../view/format.js";
import { writeJsonAtomic } from "./atomic-json.js";
import { sanitizeSingleLineDisplaySnippet } from "./display-sanitize.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { MAINTAINED_LOCAL_ESTIMATE_IDS, QUOTA_PROVIDERS_AGGREGATE_ID, } from "./quota-providers.js";
/** Max length for an exported provider error message after sanitization. */
const EXPORT_ERROR_MAX_LENGTH = 240;
const EXPORT_WINDOW_LABELS = {
    rpm: "RPM",
    hour: "Hourly",
    five_hour: "5h",
    session: "Session",
    day: "Daily",
    week: "Weekly",
    month: "Monthly",
    year: "Yearly",
    mcp: "MCP",
    code_review: "Code Review",
};
/**
 * Resolves the export file path from a configured value.
 *
 * - Empty string → XDG cache default: `$XDG_CACHE_HOME/opencode/quota-export.json`
 * - Starts with `~/` → expands `~` to `homedir()`
 * - Starts with `~\` → expands `~` and treats backslashes as path separators
 * - Otherwise → returns as-is (caller is responsible for absolute paths)
 */
export function resolveExportPath(configured) {
    if (configured === "") {
        return join(getOpencodeRuntimeDirs().cacheDir, "quota-export.json");
    }
    if (configured.startsWith("~/")) {
        return join(homedir(), configured.slice(2));
    }
    if (configured.startsWith("~\\")) {
        return join(homedir(), ...configured.slice(2).split(/\\+/u));
    }
    return configured;
}
function unixSecondsFromIso(value) {
    if (!value)
        return undefined;
    const milliseconds = new Date(value).getTime();
    return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : undefined;
}
function toExportError(error) {
    return {
        label: sanitizeSingleLineDisplaySnippet(error.label, EXPORT_ERROR_MAX_LENGTH),
        message: sanitizeSingleLineDisplaySnippet(error.message, EXPORT_ERROR_MAX_LENGTH),
    };
}
/**
 * Each custom definition in its configured order, never its URL, key or format. Its account in
 * this check (the definition id is the account's login) gives its status: "error" when it gave
 * only errors, "ok" otherwise, and "unavailable" when it was not checked. A switched-off
 * definition is never checked: it says `enabled: false` instead.
 */
function customSourceStatuses(definitions, accounts) {
    return definitions
        .filter((source) => !MAINTAINED_LOCAL_ESTIMATE_IDS.includes(source.id))
        .map((source) => {
        const identity = { id: source.id, providerId: source.providerId };
        if (source.enabled === false)
            return { ...identity, entryCount: 0, enabled: false };
        const account = accounts.find((candidate) => candidate.login === source.id);
        if (!account)
            return { ...identity, status: "unavailable", entryCount: 0 };
        const failed = account.rows.length === 0 && account.errors.length > 0;
        return { ...identity, status: failed ? "error" : "ok", entryCount: account.rows.length };
    });
}
/** One row as an export entry; provider text loses terminal escapes and control characters. */
function rowEntry(providerId, providerLabel, row) {
    const account = row.account ? ` (${row.account})` : "";
    const resetAt = unixSecondsFromIso(row.resetsAt);
    const base = {
        id: row.id,
        name: sanitizeSingleLineDisplaySnippet(`${providerLabel}${account} ${row.label}`, EXPORT_ERROR_MAX_LENGTH),
        ...(row.account
            ? { account: sanitizeSingleLineDisplaySnippet(row.account, EXPORT_ERROR_MAX_LENGTH) }
            : {}),
        resultType: row.type,
        acquisitionMethod: row.method,
        ownership: providerId === QUOTA_PROVIDERS_AGGREGATE_ID
            ? "user_configured"
            : "maintained",
        authority: row.authority,
        ...(row.window ? { window: EXPORT_WINDOW_LABELS[row.window] } : {}),
        ...(resetAt !== undefined ? { resetAt } : {}),
    };
    if (row.percentRemaining !== undefined) {
        return { ...base, renderType: "percent", percentRemaining: row.percentRemaining };
    }
    return {
        ...base,
        renderType: "value",
        value: sanitizeSingleLineDisplaySnippet(rowValueText(row), EXPORT_ERROR_MAX_LENGTH),
    };
}
/**
 * A provider's part: "ok" or "partial" with its rows, "error" when it has no rows, and
 * "unavailable" when it is not set up. `answeredAtMs` is when the rows or the error came.
 */
function exportProvider(provider, answeredAtMs, nowMs) {
    if (provider.error?.code === "not_configured" && provider.rows.length === 0) {
        return { status: "unavailable" };
    }
    const fetchedAt = Math.floor(answeredAtMs / 1000);
    const entries = provider.rows.map((row) => rowEntry(provider.providerId, provider.label, row));
    if (!provider.error)
        return { status: "ok", fetchedAt, entries };
    const error = sanitizeSingleLineDisplaySnippet(describeError(provider.error, provider.label, nowMs), EXPORT_ERROR_MAX_LENGTH);
    if (entries.length === 0)
        return { status: "error", fetchedAt, error };
    return {
        status: "partial",
        fetchedAt,
        entries,
        errors: [toExportError({ label: provider.label, message: error })],
    };
}
/**
 * A provider's part of the export file from one check: this check's rows as the snapshot
 * shows them, or its error. The custom providers also list each definition, from this check's
 * `accounts`.
 */
export function exportProviderFromCheck(params) {
    const { providerId, label, rows, error, checkedAtMs } = params;
    const part = exportProvider({ providerId, label, rows, error }, checkedAtMs, checkedAtMs);
    if (providerId !== QUOTA_PROVIDERS_AGGREGATE_ID)
        return part;
    return { ...part, sources: customSourceStatuses(params.customDefinitions, params.accounts) };
}
/** A provider's part written from its snapshot; "unavailable" until it first answered. */
function exportProviderFromSnapshot(provider, nowMs) {
    const answeredAtMs = provider.okAtMs ?? provider.checkedAtMs;
    if (answeredAtMs === undefined)
        return { status: "unavailable" };
    return exportProvider(provider, answeredAtMs, nowMs);
}
/** Builds the export document from the quota snapshot; no provider is asked again. */
export function buildQuotaExportFromSnapshot(snapshot, nowMs = Date.now()) {
    const providers = {};
    const fetchedAtValues = [];
    for (const provider of snapshot.providers) {
        const part = provider.exportPart ?? exportProviderFromSnapshot(provider, nowMs);
        providers[provider.providerId] = part;
        if (part.status !== "unavailable")
            fetchedAtValues.push(part.fetchedAt);
    }
    const exportedAt = Math.floor(nowMs / 1000);
    return {
        version: 3,
        exportedAt,
        fromCache: true,
        cacheAgeSeconds: fetchedAtValues.length > 0 ? exportedAt - Math.min(...fetchedAtValues) : 0,
        providers,
    };
}
/**
 * Writes a `QuotaExport` document atomically to disk.
 *
 * Errors are re-thrown — callers are responsible for catching and logging them.
 */
export async function writeQuotaExport(exportData, resolvedPath) {
    await writeJsonAtomic(resolvedPath, exportData, { trailingNewline: true });
}
