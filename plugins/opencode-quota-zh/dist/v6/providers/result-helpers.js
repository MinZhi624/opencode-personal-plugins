import { readFile } from "fs/promises";
import { getApiKeyDiagnostics } from "../lib/api-key-resolver.js";
import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import { asRecord } from "../lib/json-guards.js";
export function statusDetailsFromRecord(values) {
    return Object.entries(values).flatMap(([key, value]) => value === undefined ? [] : [{ key, value }]);
}
export function configStatusDetails(diagnostics) {
    return statusDetailsFromRecord({
        config_state: diagnostics.state,
        config_source: diagnostics.source ?? "(none)",
        config_missing: diagnostics.missing ?? undefined,
        config_error: diagnostics.error ?? undefined,
        config_checked_paths: diagnostics.checkedPaths.join(" | ") || "(none)",
    });
}
export function simpleApiKeyStatusDetails(diagnostics) {
    return statusDetailsFromRecord({
        api_key_configured: diagnostics.configured ? "true" : "false",
        api_key_source: diagnostics.source ?? "(none)",
        api_key_checked_paths: diagnostics.checkedPaths.join(" | ") || "(none)",
        api_key_credential_database_paths: diagnostics.credentialDatabasePaths.join(" | ") || "(none)",
    });
}
/** Where a vendor's API key was looked for and found; "not configured" when that can't be read. */
export async function apiKeyVendorDetails(vendor) {
    const diagnostics = await getApiKeyDiagnostics(vendor).catch(() => ({
        configured: false,
        source: null,
        checkedPaths: [],
        credentialDatabasePaths: [],
    }));
    return simpleApiKeyStatusDetails(diagnostics);
}
/** One `api_key_diagnostics` line: configured, the key's source and the paths checked. */
export async function apiKeyDiagnosticsDetail(vendor) {
    const diagnostics = await getApiKeyDiagnostics(vendor).catch(() => ({
        configured: false,
        source: null,
        checkedPaths: [],
    }));
    const detail = `configured=${diagnostics.configured ? "true" : "false"}${diagnostics.source ? ` source=${diagnostics.source}` : ""}${diagnostics.checkedPaths.length > 0 ? ` checked=${diagnostics.checkedPaths.join(" | ")}` : ""}`;
    return [{ key: "api_key_diagnostics", value: detail }];
}
export function apiKeyStatusDetails(diagnostics) {
    return statusDetailsFromRecord({
        auth_state: diagnostics.state,
        api_key_configured: diagnostics.state === "configured" ? "true" : "false",
        api_key_source: diagnostics.source ?? "(none)",
        api_key_checked_paths: diagnostics.checkedPaths.join(" | ") || "(none)",
        api_key_credential_database_paths: diagnostics.credentialDatabasePaths.join(" | ") || "(none)",
        auth_error: diagnostics.error ? sanitizeDisplayText(diagnostics.error) : undefined,
    });
}
export async function inspectGeneratedCounterFile(path, expectedVersion) {
    try {
        const parsed = JSON.parse(await readFile(path, "utf8"));
        const record = asRecord(parsed);
        const version = typeof record?.version === "number" ? record.version : null;
        const updatedAt = typeof record?.updatedAt === "number" && Number.isFinite(record.updatedAt)
            ? record.updatedAt
            : null;
        return {
            exists: true,
            health: !record || version === null || updatedAt === null
                ? "malformed"
                : version === expectedVersion
                    ? "healthy"
                    : "version_mismatch",
            version,
            lastUpdatedAt: updatedAt,
        };
    }
    catch (error) {
        if (error &&
            typeof error === "object" &&
            "code" in error &&
            String(error.code) === "ENOENT") {
            return { exists: false, health: "missing", version: null, lastUpdatedAt: null };
        }
        return { exists: true, health: "malformed", version: null, lastUpdatedAt: null };
    }
}
