import {
  formatAccountingBoolean,
  formatAccountingQuantity,
  getAccountingEntryLabel,
} from "./accounting-format.js";
import { sanitizeQuotaRenderData } from "./display-sanitize.js";
import {
  isBooleanEntry,
  isPercentEntry,
  isQuantityEntry,
  isValueEntry,
  type QuotaToastEntry,
} from "./entries.js";
import type { QuotaRenderData } from "./quota-render-data.js";

/**
 * Structured sidebar card model shared by the V2 server RPC and the TUI panel.
 *
 * The server runs the upstream quota core and maps its render data into these
 * cards; the TUI only renders them. Percent rows keep the raw remaining
 * percentage so the panel never has to parse display text back into numbers.
 */

export type QuotaSidebarPercentRow = {
  kind: "percent";
  label: string;
  /** Remaining quota as a percentage; may be outside [0, 100] when over quota. */
  percentRemaining: number;
  resetTimeIso?: string;
  right?: string;
};

export type QuotaSidebarValueRow = {
  kind: "value";
  label: string;
  /** Provider-reported text value, e.g. a currency balance. */
  value: string;
  resetTimeIso?: string;
  right?: string;
};

export type QuotaSidebarRow = QuotaSidebarPercentRow | QuotaSidebarValueRow;

export type QuotaSidebarCard = {
  label: string;
  rows: QuotaSidebarRow[];
  error?: string;
};

/** Rendered instead of 0% when a percentage is missing or not finite. */
export const QUOTA_SIDEBAR_UNKNOWN_VALUE = "未知";

function localizeBalanceLabel(label: string): string {
  return label.replace(/\bBalance\b:?/gi, "额度");
}

function entryGroupKey(entry: QuotaToastEntry): string {
  return entry.group || entry.accounting.sourceId || entry.name;
}

function entryRowLabel(entry: QuotaToastEntry): string {
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
function entryRowOptionals(entry: QuotaToastEntry): { resetTimeIso?: string; right?: string } {
  const optionals: { resetTimeIso?: string; right?: string } = {};
  if (entry.resetTimeIso !== undefined) optionals.resetTimeIso = entry.resetTimeIso;
  if (entry.right !== undefined) optionals.right = entry.right;
  return optionals;
}

function entryRow(entry: QuotaToastEntry): QuotaSidebarRow {
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
export function buildQuotaSidebarCards(
  data: QuotaRenderData | null | undefined,
): QuotaSidebarCard[] {
  if (!data) return [];
  const sanitized = sanitizeQuotaRenderData(data);
  const cards = new Map<string, QuotaSidebarCard>();

  for (const entry of sanitized.entries) {
    const key = entryGroupKey(entry);
    const card = cards.get(key) ?? { label: localizeBalanceLabel(key), rows: [] };
    card.rows.push(entryRow(entry));
    cards.set(key, card);
  }

  for (const error of sanitized.errors) {
    if (error.kind === "intentional-filter") continue;
    const key = error.label || "额度";
    const card = cards.get(key) ?? { label: localizeBalanceLabel(key), rows: [] };
    card.error = card.error ? `${card.error}; ${error.message}` : error.message;
    cards.set(key, card);
  }

  return [...cards.values()];
}
