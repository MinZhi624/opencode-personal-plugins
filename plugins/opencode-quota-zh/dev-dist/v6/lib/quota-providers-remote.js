import { isIsoTime } from "../core/validate.js";
import { getApiKeyCheckedPaths, resolveApiKey } from "./api-key-resolver.js";
import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import { fmtUsdAmount } from "./format-utils.js";
import { REQUEST_TIMEOUT_MS } from "./http.js";
import { hasOnlyKeys, isRecord } from "./json-guards.js";
import { getCredentialDatabasePaths } from "./opencode-auth.js";
import { CUSTOM_RESULT_TYPES, customRow, customRowKey, JSON_V1_MAX_DISPLAY_CODE_POINTS, JSON_V1_MAX_NUMBER_MAGNITUDE, normalizeJsonV1Timestamp, } from "./quota-providers.js";
export const QUOTA_PROVIDER_MAX_BODY_BYTES = 256 * 1024;
const MAX_REMOTE_ROWS = 100;
const JSON_V1_MAX_RESPONSE_DEPTH = 32;
const JSON_V1_MAX_CANDIDATES = 1_600;
const JSON_V1_MAX_ENTRIES = 100;
const JSON_V1_MAX_DETAILED_ERRORS = 16;
const PERCENT_RESULT_TYPES = new Set(["quota", "rate_limit", "budget"]);
/** `right` and `observedAtIso` are checked but not shown. */
const QUOTA_V1_ROW_KEYS = [
    "kind",
    "name",
    "resultType",
    "percentRemaining",
    "value",
    "label",
    "right",
    "resetTimeIso",
    "observedAtIso",
];
const JSON_V1_DECIMAL_TEXT_RE = /^-?\d+(?:\.\d+)?$/;
function boundedDisplayText(value, maxCodePoints) {
    if (typeof value !== "string")
        return null;
    const normalized = sanitizeSingleLineDisplayText(value);
    const length = Array.from(normalized).length;
    return length >= 1 && length <= maxCodePoints ? normalized : null;
}
export async function resolveQuotaProviderApiKey(source) {
    // A switched-off provider's key is never read, whoever asks.
    if (source.enabled === false) {
        return { source: null, checkedPaths: [], credentialDatabasePaths: [] };
    }
    const spec = {
        envVars: source.apiKeyEnv ? [source.apiKeyEnv] : [],
        providerKeys: [source.providerId],
        // Key logins only: `providerId` can name an integration with OAuth sign-ins
        // (for example `opencode`), and resolving one could refresh its token for nothing.
        keyLoginsOnly: true,
    };
    const resolved = await resolveApiKey(spec);
    return {
        ...(resolved ? { key: resolved.key } : {}),
        // Custom providers report every environment variable source as plain "env".
        source: !resolved
            ? null
            : resolved.source.startsWith("env:")
                ? "env"
                : resolved.source,
        checkedPaths: getApiKeyCheckedPaths(spec),
        credentialDatabasePaths: getCredentialDatabasePaths(),
    };
}
function isJsonContentType(response) {
    const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (!type)
        return false;
    return type === "application/json" || (type.startsWith("application/") && type.endsWith("+json"));
}
/** Reads at most QUOTA_PROVIDER_MAX_BODY_BYTES, so a huge reply never sits in memory. */
async function readBoundedJson(response) {
    const tooLarge = {
        ok: false,
        error: `Response exceeded ${QUOTA_PROVIDER_MAX_BODY_BYTES} bytes`,
    };
    if (!isJsonContentType(response))
        return { ok: false, error: "Expected a JSON response" };
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > QUOTA_PROVIDER_MAX_BODY_BYTES) {
        return tooLarge;
    }
    let text = "";
    if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let total = 0;
        try {
            for (let next = await reader.read(); !next.done; next = await reader.read()) {
                total += next.value.byteLength;
                if (total > QUOTA_PROVIDER_MAX_BODY_BYTES) {
                    await reader.cancel();
                    return tooLarge;
                }
                text += decoder.decode(next.value, { stream: true });
            }
            text += decoder.decode();
        }
        finally {
            reader.releaseLock();
        }
    }
    try {
        return { ok: true, body: JSON.parse(text) };
    }
    catch {
        return { ok: false, error: "Invalid JSON response" };
    }
}
/** A quota-v1 row keyed by its name. */
function parseQuotaV1Row(raw) {
    if (!isRecord(raw) || !hasOnlyKeys(raw, QUOTA_V1_ROW_KEYS))
        return null;
    const name = boundedDisplayText(raw.name, 80);
    const resultType = typeof raw.resultType === "string" &&
        CUSTOM_RESULT_TYPES.has(raw.resultType)
        ? raw.resultType
        : null;
    // Optional fields are undefined when absent and null when present but invalid.
    const label = raw.label === undefined ? undefined : boundedDisplayText(raw.label, 80);
    const right = raw.right === undefined ? undefined : boundedDisplayText(raw.right, 160);
    const resetTimeIso = raw.resetTimeIso === undefined
        ? undefined
        : isIsoTime(raw.resetTimeIso)
            ? raw.resetTimeIso
            : null;
    const observedAtIso = raw.observedAtIso === undefined
        ? undefined
        : isIsoTime(raw.observedAtIso)
            ? raw.observedAtIso
            : null;
    if (!name ||
        !resultType ||
        label === null ||
        right === null ||
        resetTimeIso === null ||
        observedAtIso === null) {
        return null;
    }
    const row = (value) => customRow({
        key: customRowKey(name),
        name,
        label,
        resultType,
        method: "remote_api",
        value,
        resetsAt: resetTimeIso,
    });
    if (raw.kind === "percent" &&
        typeof raw.percentRemaining === "number" &&
        Number.isFinite(raw.percentRemaining) &&
        raw.percentRemaining <= 100 &&
        PERCENT_RESULT_TYPES.has(resultType) &&
        raw.value === undefined) {
        return row({ percentRemaining: raw.percentRemaining });
    }
    const value = boundedDisplayText(raw.value, 160);
    if (raw.kind === "value" && value !== null && raw.percentRemaining === undefined) {
        return row({ text: value });
    }
    return null;
}
function parseQuotaV1(body) {
    const invalid = { success: false, error: "Invalid quota-v1 response" };
    if (!isRecord(body) ||
        !hasOnlyKeys(body, ["version", "entries"]) ||
        body.version !== "quota-v1" ||
        !Array.isArray(body.entries) ||
        body.entries.length < 1 ||
        body.entries.length > MAX_REMOTE_ROWS) {
        return invalid;
    }
    const rows = [];
    for (const raw of body.entries) {
        const row = parseQuotaV1Row(raw);
        if (!row)
            return invalid;
        rows.push(row);
    }
    return { success: true, rows };
}
function exceedsJsonDepth(value, maxDepth) {
    if (!value || typeof value !== "object")
        return false;
    const stack = [{ value, depth: 1 }];
    while (stack.length > 0) {
        const current = stack.pop();
        if (current.depth > maxDepth)
            return true;
        const children = Array.isArray(current.value) ? current.value : Object.values(current.value);
        for (const child of children) {
            if (child && typeof child === "object") {
                stack.push({ value: child, depth: current.depth + 1 });
            }
        }
    }
    return false;
}
function resolveJsonV1Path(root, path) {
    let current = root;
    for (const segment of path) {
        if (!isRecord(current))
            return { ok: false, issue: "had wrong type" };
        if (!Object.hasOwn(current, segment))
            return { ok: false, issue: "was missing" };
        current = current[segment];
        if (current === null)
            return { ok: false, issue: "was null" };
    }
    return { ok: true, value: current };
}
function resolveJsonV1Source(row, source) {
    return "literal" in source
        ? { ok: true, value: source.literal }
        : resolveJsonV1Path(row, source.path);
}
function resolveJsonV1Number(row, source) {
    const resolved = resolveJsonV1Source(row, source);
    if (!resolved.ok)
        return resolved;
    // Some APIs write numbers as text (`"95.50"`); only a plain decimal is read as a number.
    const raw = typeof resolved.value === "string" && JSON_V1_DECIMAL_TEXT_RE.test(resolved.value.trim())
        ? Number(resolved.value.trim())
        : resolved.value;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return { ok: false, issue: "had wrong type" };
    }
    if (Math.abs(raw) > JSON_V1_MAX_NUMBER_MAGNITUDE) {
        return { ok: false, issue: "exceeded the numeric magnitude limit" };
    }
    const divideBy = "path" in source ? source.divideBy : undefined;
    return { ok: true, value: divideBy === undefined ? raw : raw / divideBy };
}
function resolveJsonV1Text(row, source) {
    const resolved = resolveJsonV1Source(row, source);
    if (!resolved.ok)
        return resolved;
    if (typeof resolved.value !== "string")
        return { ok: false, issue: "had wrong type" };
    const text = boundedDisplayText(resolved.value, JSON_V1_MAX_DISPLAY_CODE_POINTS);
    return text
        ? { ok: true, value: text }
        : { ok: false, issue: "did not resolve to bounded display text" };
}
function resolveJsonV1Timestamp(row, source) {
    const resolved = resolveJsonV1Source(row, source);
    if (!resolved.ok)
        return resolved;
    const timestamp = normalizeJsonV1Timestamp(resolved.value, source.encoding);
    return timestamp
        ? { ok: true, value: timestamp }
        : { ok: false, issue: "did not resolve to a valid timestamp" };
}
function jsonV1CandidateError(mappingIndex, field, issue, rowIndex) {
    return `adapter.mappings[${mappingIndex}].${field} ${issue} at row ${rowIndex}`;
}
function formatJsonV1Value(value, mapping) {
    if (!mapping.unit)
        return `${value}`;
    return mapping.unitPosition === "prefix" ? `${mapping.unit}${value}` : `${value} ${mapping.unit}`;
}
/** One mapping applied to one reply row: a row keyed by the mapping's name, or why not. */
function mapJsonV1Candidate(row, rowIndex, mapping, mappingIndex) {
    const fail = (field, issue) => ({
        error: jsonV1CandidateError(mappingIndex, field, issue, rowIndex),
    });
    let resetTimeIso;
    if (mapping.resetTime) {
        const resolved = resolveJsonV1Timestamp(row, mapping.resetTime);
        if (!resolved.ok)
            return fail("resetTime", resolved.issue);
        resetTimeIso = resolved.value;
    }
    // The observed time is checked but not shown.
    if (mapping.observedTime) {
        const resolved = resolveJsonV1Timestamp(row, mapping.observedTime);
        if (!resolved.ok)
            return fail("observedTime", resolved.issue);
    }
    const mapped = (value) => ({
        row: customRow({
            key: customRowKey(mapping.name),
            name: mapping.name,
            label: mapping.label,
            resultType: mapping.resultType,
            method: "remote_api",
            value,
            resetsAt: resetTimeIso,
        }),
    });
    // Shared by used-limit, remaining-limit, spend-budget and remaining-budget:
    // an amount (used, spent, or remaining) out of a positive total.
    const share = (amountKey, amountSource, totalKey, totalSource) => {
        const amountField = `metric.${amountKey}`;
        const totalField = `metric.${totalKey}`;
        const amountIsRemaining = amountKey === "remaining";
        const amount = resolveJsonV1Number(row, amountSource);
        if (!amount.ok)
            return fail(amountField, amount.issue);
        const total = resolveJsonV1Number(row, totalSource);
        if (!total.ok)
            return fail(totalField, total.issue);
        if (!amountIsRemaining && amount.value < 0)
            return fail(amountField, "must be non-negative");
        if (total.value <= 0)
            return fail(totalField, "must be greater than zero");
        if (amountIsRemaining && amount.value > total.value) {
            return fail(amountField, `must not exceed ${totalKey}`);
        }
        const percentRemaining = amountIsRemaining
            ? (amount.value / total.value) * 100
            : ((total.value - amount.value) / total.value) * 100;
        // Finite operands can still overflow, for example a tiny literal total.
        if (!Number.isFinite(percentRemaining)) {
            return fail(totalField, "produced a non-finite percentage");
        }
        if (Math.abs(percentRemaining) > JSON_V1_MAX_NUMBER_MAGNITUDE) {
            return fail(totalField, "produced a percentage beyond the numeric magnitude limit");
        }
        return mapped({ percentRemaining });
    };
    const { metric } = mapping;
    switch (metric.type) {
        case "percentage": {
            const percentage = resolveJsonV1Number(row, metric.percentage);
            if (!percentage.ok)
                return fail("metric.percentage", percentage.issue);
            if (metric.meaning === "remaining" && percentage.value > 100) {
                return fail("metric.percentage", "must not exceed 100 for remaining meaning");
            }
            if (metric.meaning === "used" && percentage.value < 0) {
                return fail("metric.percentage", "must be non-negative for used meaning");
            }
            const percentRemaining = metric.meaning === "remaining" ? percentage.value : 100 - percentage.value;
            return mapped({ percentRemaining });
        }
        case "used-limit":
            return share("used", metric.used, "limit", metric.limit);
        case "remaining-limit":
            return share("remaining", metric.remaining, "limit", metric.limit);
        case "spend-budget":
            return share("spend", metric.spend, "budget", metric.budget);
        case "remaining-budget":
            return share("remaining", metric.remaining, "budget", metric.budget);
        case "value": {
            const value = resolveJsonV1Number(row, metric.value);
            if (!value.ok)
                return fail("metric.value", value.issue);
            // Remaining and balance values may legitimately be negative (overdrawn).
            const mayBeNegative = metric.valueType === "remaining" || metric.valueType === "balance";
            if (!mayBeNegative && value.value < 0)
                return fail("metric.value", "must be non-negative");
            return mapped({ text: formatJsonV1Value(value.value, mapping) });
        }
        case "status": {
            const value = resolveJsonV1Text(row, metric.value);
            if (!value.ok)
                return fail("metric.value", value.issue);
            return mapped({ text: value.value });
        }
    }
}
function parseJsonV1(source, body) {
    const invalid = (message) => ({
        success: false,
        error: `Invalid json-v1 response: ${message}`,
    });
    if (exceedsJsonDepth(body, JSON_V1_MAX_RESPONSE_DEPTH)) {
        return invalid(`nesting depth exceeded ${JSON_V1_MAX_RESPONSE_DEPTH}`);
    }
    let rows;
    if (source.adapter.rowsPath) {
        if (!isRecord(body))
            return invalid("adapter.rowsPath requires an object root");
        const resolved = resolveJsonV1Path(body, source.adapter.rowsPath);
        if (!resolved.ok)
            return invalid(`adapter.rowsPath ${resolved.issue}`);
        if (!Array.isArray(resolved.value)) {
            return invalid("adapter.rowsPath did not resolve to an array");
        }
        rows = resolved.value;
    }
    else if (Array.isArray(body)) {
        rows = body;
    }
    else if (isRecord(body)) {
        rows = [body];
    }
    else {
        return invalid("expected an object or array root");
    }
    if (rows.length < 1 || rows.length > MAX_REMOTE_ROWS) {
        return invalid(`selected rows must contain 1-${MAX_REMOTE_ROWS} elements`);
    }
    const { mappings } = source.adapter;
    if (rows.length * mappings.length > JSON_V1_MAX_CANDIDATES) {
        return invalid(`candidate count exceeded ${JSON_V1_MAX_CANDIDATES}`);
    }
    const mappedRows = [];
    const rowErrors = [];
    let errorCount = 0;
    const recordError = (error) => {
        errorCount += 1;
        if (rowErrors.length < JSON_V1_MAX_DETAILED_ERRORS)
            rowErrors.push(error);
    };
    for (const [rowIndex, row] of rows.entries()) {
        for (const [mappingIndex, mapping] of mappings.entries()) {
            if (!isRecord(row)) {
                recordError(jsonV1CandidateError(mappingIndex, "metric", "requires an object row", rowIndex));
                continue;
            }
            const mapped = mapJsonV1Candidate(row, rowIndex, mapping, mappingIndex);
            if ("error" in mapped) {
                recordError(mapped.error);
                continue;
            }
            mappedRows.push(mapped.row);
            if (mappedRows.length > JSON_V1_MAX_ENTRIES) {
                return invalid(`more than ${JSON_V1_MAX_ENTRIES} entries were produced`);
            }
        }
    }
    if (mappedRows.length === 0) {
        return invalid(rowErrors[0] ?? "no mappings produced entries");
    }
    if (errorCount > rowErrors.length) {
        rowErrors.push("Additional json-v1 mapping errors omitted");
    }
    return {
        success: true,
        rows: mappedRows,
        ...(rowErrors.length > 0 ? { rowErrors } : {}),
    };
}
/**
 * The key's budget (percent left), or its spend when the key has no limit: this month's
 * (`usage_monthly`, the current UTC month) when the reply has it, else all time.
 */
function parseOpenRouterKeyV1(body) {
    const invalid = { success: false, error: "Invalid openrouter-key-v1 response" };
    if (!isRecord(body) || !isRecord(body.data))
        return invalid;
    const { usage, usage_monthly: usageMonthly, limit, limit_remaining: remaining } = body.data;
    const isValidUsage = typeof usage === "number" && Number.isFinite(usage) && usage >= 0;
    const isValidLimit = limit === null ||
        limit === undefined ||
        (typeof limit === "number" && Number.isFinite(limit) && limit >= 0);
    // A null remaining is valid only for a key without a limit (free tier).
    const isValidRemaining = remaining === undefined ||
        (remaining === null
            ? limit === null
            : typeof remaining === "number" && Number.isFinite(remaining));
    if (!isValidUsage || !isValidLimit || !isValidRemaining)
        return invalid;
    if (typeof limit === "number" && limit > 0) {
        // `limit_remaining` covers the current limit window, while `usage` is the key's lifetime total.
        const remainingUsd = typeof remaining === "number" ? remaining : limit - usage;
        if (remainingUsd > limit)
            return invalid;
        const percentRemaining = (remainingUsd / limit) * 100;
        return {
            success: true,
            rows: [
                customRow({
                    key: "budget",
                    name: "budget",
                    label: "Budget",
                    resultType: "budget",
                    method: "remote_api",
                    value: { percentRemaining },
                }),
            ],
        };
    }
    // A reply without a usable monthly figure (an older or compatible endpoint) keeps the
    // all-time spend.
    const hasMonthly = typeof usageMonthly === "number" && Number.isFinite(usageMonthly) && usageMonthly >= 0;
    return {
        success: true,
        rows: [
            customRow({
                key: "spend",
                name: "spend",
                label: hasMonthly ? "This month" : "Spend",
                resultType: "spend",
                method: "remote_api",
                value: { text: fmtUsdAmount(hasMonthly ? usageMonthly : usage) },
            }),
        ],
    };
}
export async function fetchRemoteQuotaProvider(source, apiKey, requestTimeoutMs) {
    // A switched-off provider is never sent a request or its key, whoever asks.
    if (source.enabled === false)
        return { success: false, error: "Provider is switched off" };
    const timeoutMs = requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(source.url, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: {
                Authorization: `Bearer ${apiKey}`,
                Accept: "application/json",
            },
        });
        if (response.redirected || (response.status >= 300 && response.status < 400)) {
            return { success: false, error: "Redirect rejected" };
        }
        if (!response.ok) {
            return { success: false, error: `HTTP ${response.status}` };
        }
        const read = await readBoundedJson(response);
        if (!read.ok)
            return { success: false, error: read.error };
        switch (source.format) {
            case "quota-v1":
                return parseQuotaV1(read.body);
            case "openrouter-key-v1":
                return parseOpenRouterKeyV1(read.body);
            case "json-v1":
                return parseJsonV1(source, read.body);
        }
    }
    catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
            return {
                success: false,
                error: `Request timeout after ${Math.round(timeoutMs / 1000)}s`,
            };
        }
        // Never echo thrown text: it can contain the endpoint or response data.
        return { success: false, error: "Failed to read accounting data" };
    }
    finally {
        clearTimeout(timeoutId);
    }
}
