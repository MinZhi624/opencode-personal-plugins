/**
 * The gate every row passes before it reaches the store, the disk or a client: known fields
 * only, valid values, display text scrubbed of control characters. A bad row is dropped and
 * noted in the provider's debug details; the provider's other rows stay.
 */
import { isCanonicalAccountingDecimal } from "../lib/accounting-format.js";
import { sanitizeSingleLineDisplayText } from "../lib/display-sanitize.js";
import { isRecord } from "../lib/json-guards.js";
import { isQuotaWindow } from "./windows.js";
const ROW_TYPES = ["quota", "budget", "usage", "balance", "status"];
const ROW_METHODS = [
    "remote_api",
    "dashboard_scrape",
    "local_cli",
    "local_estimation",
];
const ROW_AUTHORITIES = ["provider_reported", "locally_derived"];
const PROMINENCES = ["primary", "supplementary"];
/** Row key after the provider id: lower-case first segment, then dotted segments. */
const ROW_KEY_RE = /^[a-z0-9_]+(?:\.[A-Za-z0-9_-]+)*$/u;
const ROW_ID_MAX_LENGTH = 160;
const LABEL_MAX_LENGTH = 64;
const TEXT_MAX_LENGTH = 200;
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const COUNT_UNIT_RE = /^[a-z_]{1,32}$/u;
const CUSTOM_SYMBOL_RE = /^[\p{L}\p{N}._-]{1,16}$/u;
function isOneOf(value, choices) {
    return typeof value === "string" && choices.includes(value);
}
export function isIsoTime(value) {
    return typeof value === "string" && ISO_TIME_RE.test(value) && Number.isFinite(Date.parse(value));
}
/** Scrubbed single-line text, or undefined when it is empty or too long. */
function cleanText(value, maxLength) {
    if (typeof value !== "string")
        return undefined;
    const text = sanitizeSingleLineDisplayText(value);
    return text && text.length <= maxLength ? text : undefined;
}
function cleanUnit(value) {
    if (!isRecord(value))
        return undefined;
    if (value.kind === "currency" &&
        typeof value.code === "string" &&
        /^[A-Z]{3}$/u.test(value.code)) {
        return { kind: "currency", code: value.code };
    }
    if (value.kind === "count" && typeof value.unit === "string" && COUNT_UNIT_RE.test(value.unit)) {
        return { kind: "count", unit: value.unit };
    }
    if (value.kind === "custom" && typeof value.symbol === "string") {
        const symbol = sanitizeSingleLineDisplayText(value.symbol);
        return CUSTOM_SYMBOL_RE.test(symbol) ? { kind: "custom", symbol } : undefined;
    }
    return undefined;
}
function cleanAmount(value) {
    if (!isRecord(value))
        return undefined;
    if (typeof value.decimal !== "string" || !isCanonicalAccountingDecimal(value.decimal)) {
        return undefined;
    }
    const unit = cleanUnit(value.unit);
    return unit ? { decimal: value.decimal, unit } : undefined;
}
/** The clean row, or the reason it is dropped. */
function checkRow(providerId, value) {
    if (!isRecord(value))
        return "不是对象";
    const { id } = value;
    if (typeof id !== "string" ||
        id.length > ROW_ID_MAX_LENGTH ||
        !id.startsWith(`${providerId}.`) ||
        !ROW_KEY_RE.test(id.slice(providerId.length + 1))) {
        return "id 无效";
    }
    if (value.providerId !== providerId)
        return "提供商不匹配";
    const label = cleanText(value.label, LABEL_MAX_LENGTH);
    if (!label)
        return "label 无效";
    if (!isOneOf(value.type, ROW_TYPES))
        return "type 无效";
    if (!isOneOf(value.method, ROW_METHODS))
        return "method 无效";
    if (!isOneOf(value.authority, ROW_AUTHORITIES))
        return "authority 无效";
    if (!isOneOf(value.prominence, PROMINENCES))
        return "prominence 无效";
    const row = {
        id,
        providerId,
        label,
        type: value.type,
        method: value.method,
        authority: value.authority,
        prominence: value.prominence,
    };
    if (value.account !== undefined) {
        const account = cleanText(value.account, LABEL_MAX_LENGTH);
        if (!account)
            return "account 无效";
        row.account = account;
    }
    if (value.window !== undefined) {
        if (!isQuotaWindow(value.window))
            return "window 无效";
        row.window = value.window;
    }
    if (value.percentRemaining !== undefined) {
        if (typeof value.percentRemaining !== "number" || !Number.isFinite(value.percentRemaining)) {
            return "percentRemaining 无效";
        }
        row.percentRemaining = value.percentRemaining;
    }
    for (const field of ["used", "limit", "remaining", "amount"]) {
        if (value[field] === undefined)
            continue;
        const amount = cleanAmount(value[field]);
        if (!amount)
            return `${field} 无效`;
        row[field] = amount;
    }
    if (value.flag !== undefined) {
        if (typeof value.flag !== "boolean")
            return "flag 无效";
        row.flag = value.flag;
    }
    if (value.text !== undefined) {
        const text = cleanText(value.text, TEXT_MAX_LENGTH);
        if (!text)
            return "text 无效";
        row.text = text;
    }
    for (const field of ["resetsAt", "windowStartedAt"]) {
        if (value[field] === undefined)
            continue;
        if (!isIsoTime(value[field]))
            return `${field} 无效`;
        row[field] = value[field];
    }
    if (row.percentRemaining === undefined &&
        row.amount === undefined &&
        row.flag === undefined &&
        row.text === undefined) {
        return "没有任何值";
    }
    return row;
}
/** Keeps every valid row (as a clean copy) and notes each dropped one. */
export function validateRows(providerId, candidates) {
    const rows = [];
    const dropped = [];
    candidates.forEach((candidate, index) => {
        const checked = checkRow(providerId, candidate);
        if (typeof checked === "string") {
            const id = isRecord(candidate) && typeof candidate.id === "string" ? candidate.id : "";
            const name = cleanText(id, ROW_ID_MAX_LENGTH) ?? `row ${index + 1}`;
            dropped.push({ key: "dropped_row", value: `${name}: ${checked}` });
        }
        else {
            rows.push(checked);
        }
    });
    return { rows, dropped };
}
