import { formatAccountingBoolean, formatAccountingQuantity, getAccountingEntryLabel, } from "./accounting-format.js";
import { sanitizeQuotaRenderData, sanitizeQuotaToastError } from "./display-sanitize.js";
import { isBooleanEntry, isPercentEntry, isQuantityEntry, isValueEntry, } from "./entries.js";
/**
 * Status of the public quota snapshot interface.
 *
 * "ready" means the quota background ran and the cards carry the queried
 * data (possibly empty when no provider is configured); "disabled" is the
 * explicit unavailable state returned when the quota background is switched
 * off. Sidebar card visibility is a display preference and never gates this
 * interface, so it does not appear here.
 */
export const QUOTA_SNAPSHOT_STATUSES = ["ready", "disabled"];
/** Rendered instead of 0% when a percentage is missing or not finite. */
export const QUOTA_SIDEBAR_UNKNOWN_VALUE = "未知";
function errorKey(error) {
    return `${error.label}\u0000${error.message}`;
}
function localizeBalanceLabel(label) {
    return label.replace(/\bBalance\b:?/gi, "额度");
}
function entryGroupKey(entry) {
    return entry.group || entry.accounting.sourceId || entry.name;
}
function entryRowLabel(entry) {
    const label = entry.semantic
        ? getAccountingEntryLabel(entry)
        : entry.group
            ? entry.label || entry.name
            : entry.name;
    return localizeBalanceLabel(label);
}
// Optional keys must be omitted rather than set to undefined: the V2 RPC
// response is validated as a strict JSON value, and `{ key: undefined }` is
// rejected by it.
function entryRowOptionals(entry) {
    const optionals = {};
    if (entry.resetTimeIso !== undefined)
        optionals.resetTimeIso = entry.resetTimeIso;
    if (entry.right !== undefined)
        optionals.right = entry.right;
    return optionals;
}
function entryRow(entry) {
    const label = entryRowLabel(entry);
    const optionals = entryRowOptionals(entry);
    if (isPercentEntry(entry)) {
        // Missing or non-finite percentages must never surface as a zero quota.
        if (!Number.isFinite(entry.percentRemaining)) {
            return { kind: "value", label, value: QUOTA_SIDEBAR_UNKNOWN_VALUE, ...optionals };
        }
        return { kind: "percent", label, percentRemaining: entry.percentRemaining, ...optionals };
    }
    if (isValueEntry(entry)) {
        return { kind: "value", label, value: entry.value, ...optionals };
    }
    if (isQuantityEntry(entry)) {
        return {
            kind: "value",
            label,
            value: formatAccountingQuantity(entry.quantity),
            ...optionals,
        };
    }
    if (isBooleanEntry(entry)) {
        return {
            kind: "value",
            label,
            value: formatAccountingBoolean(entry.value, entry.semantic),
            ...optionals,
        };
    }
    return { kind: "value", label, value: QUOTA_SIDEBAR_UNKNOWN_VALUE, ...optionals };
}
/**
 * Group provider render data into per-provider sidebar cards.
 *
 * Entries are grouped by their provider group (or source id, or name); each
 * provider may own multiple independent quota windows. Currency-style rows
 * stay value rows and never become progress bars. Intentional-filter
 * diagnostics are skipped so the sidebar only shows real problems.
 */
export function buildQuotaSidebarCards(data, options = {}) {
    if (!data)
        return [];
    const sanitized = sanitizeQuotaRenderData(data);
    const cards = new Map();
    const partialErrorCounts = new Map();
    if (options.suppressPartialErrors) {
        for (const error of options.partialProviderErrors ?? []) {
            const matchKey = errorKey(sanitizeQuotaToastError(error));
            partialErrorCounts.set(matchKey, (partialErrorCounts.get(matchKey) ?? 0) + 1);
        }
    }
    for (const entry of sanitized.entries) {
        const key = entryGroupKey(entry);
        const card = cards.get(key) ?? { label: localizeBalanceLabel(key), rows: [] };
        card.rows.push(entryRow(entry));
        cards.set(key, card);
    }
    for (const error of sanitized.errors) {
        if (error.kind === "intentional-filter")
            continue;
        const matchKey = errorKey(error);
        const partialCount = partialErrorCounts.get(matchKey) ?? 0;
        if (partialCount > 0) {
            partialErrorCounts.set(matchKey, partialCount - 1);
            continue;
        }
        const cardKey = error.label || "额度";
        const card = cards.get(cardKey) ?? { label: localizeBalanceLabel(cardKey), rows: [] };
        card.error = card.error ? `${card.error}; ${error.message}` : error.message;
        cards.set(cardKey, card);
    }
    return [...cards.values()];
}
/**
 * Build the public quota snapshot response consumed by the sidebar card.
 *
 * The response status only distinguishes a running background ("ready", cards
 * may still be empty) from an explicitly disabled background ("disabled").
 * Hiding the sidebar card must not turn this into an empty or failing
 * interface: card visibility is applied where the card is rendered, never
 * here, so independent commands keep querying the same server-side data.
 */
export function buildQuotaSnapshotResponse(params) {
    if (!params.enabled) {
        return { status: "disabled", cards: [] };
    }
    const options = {};
    if (params.suppressPartialErrors !== undefined) {
        options.suppressPartialErrors = params.suppressPartialErrors;
    }
    if (params.partialProviderErrors !== undefined) {
        options.partialProviderErrors = params.partialProviderErrors;
    }
    return {
        status: "ready",
        cards: buildQuotaSidebarCards(params.data, options),
    };
}
