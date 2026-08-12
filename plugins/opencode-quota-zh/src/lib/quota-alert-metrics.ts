/**
 * Ticket 09: typed quota alert metrics and normalization helpers.
 *
 * Alert metrics are typed as percentage, Provider account balance with ISO
 * currency, or Provider-reported availability status. These metric kinds are
 * never converted into one another.
 *
 * Transport: provider adapters carry structured balance/availability facts in
 * `QuotaProviderResult.rawDetails` (safe provider-owned facts preserved in the
 * cache and JSON exports, never human presentation). Each fact is a JSON
 * string under a fixed key; the unified snapshot builder normalizes those
 * facts back into typed metric values. Malformed facts are skipped and can
 * never participate in danger evaluation — missing, unknown, malformed,
 * timed-out, failed and synthetic data never starts an alert.
 *
 * Display text is never parsed: the alert path only consumes the structured
 * facts produced by this module, never `QuotaToastEntry.value` strings.
 */

import type { QuotaProviderStatusDetail } from "./entries.js";

// =============================================================================
// Typed metric values
// =============================================================================

export interface QuotaBalanceMetricValue {
  kind: "balance";
  /** ISO 4217 currency code reported by the provider. */
  currency: string;
  /** Structured numeric amount in `currency` units. */
  amount: number;
}

export interface QuotaAvailabilityMetricValue {
  kind: "availability";
  status: "available" | "unavailable" | "unknown";
}

/** Structured provider-reported metric facts; kinds are never converted. */
export type QuotaTypedMetricValue = QuotaBalanceMetricValue | QuotaAvailabilityMetricValue;

// =============================================================================
// rawDetails fact protocol
// =============================================================================

/** Fixed rawDetails key carrying one serialized typed metric fact. */
export const QUOTA_ALERT_METRIC_RAWDETAILS_KEY = "quota.alert.metric";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeBalanceFact(payload: Record<string, unknown>): QuotaBalanceMetricValue | null {
  const currency = payload.currency;
  const amount = payload.amount;
  if (typeof currency !== "string" || currency.length === 0 || currency.length > 16) {
    return null;
  }
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return null;
  }
  return { kind: "balance", currency, amount };
}

function normalizeAvailabilityFact(
  payload: Record<string, unknown>,
): QuotaAvailabilityMetricValue | null {
  const status = payload.status;
  if (status !== "available" && status !== "unavailable" && status !== "unknown") {
    return null;
  }
  return { kind: "availability", status };
}

function normalizeMetricFactPayload(payload: unknown): QuotaTypedMetricValue | null {
  if (!isRecord(payload)) {
    return null;
  }
  switch (payload.type) {
    case "balance":
      return normalizeBalanceFact(payload);
    case "availability":
      return normalizeAvailabilityFact(payload);
    default:
      return null;
  }
}

/**
 * Serializes a typed metric fact for `rawDetails`. The JSON string survives
 * cache round-trips and JSON exports without losing structure.
 */
export function serializeQuotaAlertMetric(
  value: QuotaTypedMetricValue,
): Pick<QuotaProviderStatusDetail, "key" | "value"> {
  if (value.kind === "balance") {
    return {
      key: QUOTA_ALERT_METRIC_RAWDETAILS_KEY,
      value: JSON.stringify({
        type: "balance",
        currency: value.currency,
        amount: value.amount,
      }),
    };
  }
  return {
    key: QUOTA_ALERT_METRIC_RAWDETAILS_KEY,
    value: JSON.stringify({ type: "availability", status: value.status }),
  };
}

/**
 * Normalizes rawDetails facts into typed metric values. Malformed, unknown or
 * duplicate-invalid facts are skipped; a skipped fact can never be mistaken
 * for a zero balance or an explicit unavailability.
 */
export function normalizeQuotaAlertMetricFacts(
  rawDetails: readonly Pick<QuotaProviderStatusDetail, "key" | "value">[] | undefined,
): QuotaTypedMetricValue[] {
  if (!rawDetails) {
    return [];
  }
  const metrics: QuotaTypedMetricValue[] = [];
  for (const detail of rawDetails) {
    if (detail.key !== QUOTA_ALERT_METRIC_RAWDETAILS_KEY) {
      continue;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(detail.value) as unknown;
    } catch {
      continue;
    }
    const metric = normalizeMetricFactPayload(payload);
    if (metric) {
      metrics.push(metric);
    }
  }
  return metrics;
}

// =============================================================================
// Percent-window fallback normalization
// =============================================================================

/**
 * Normalizes a percent-remaining observation into a window value. Only finite
 * numbers qualify; missing, non-numeric or non-finite observations return
 * undefined and are never synthesized into an alertable 0%.
 */
export function normalizePercentWindowRemaining(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}
