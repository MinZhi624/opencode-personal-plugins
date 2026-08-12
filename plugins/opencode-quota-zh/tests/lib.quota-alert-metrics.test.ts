/**
 * Ticket 09: typed quota alert metrics — pure normalization contract tests.
 *
 * The module serializes typed balance/availability metric facts for the
 * rawDetails channel and normalizes them back into typed values. Malformed
 * facts are skipped (never alertable), display text is never parsed, and the
 * percent-window fallback normalization never synthesizes an alertable 0%.
 */

import { describe, expect, it } from "vitest";

import {
  normalizePercentWindowRemaining,
  normalizeQuotaAlertMetricFacts,
  QUOTA_ALERT_METRIC_RAWDETAILS_KEY,
  serializeQuotaAlertMetric,
} from "../src/lib/quota-alert-metrics.js";

describe("quota alert metric facts", () => {
  it("serializes balance facts with structured currency and amount", () => {
    expect(
      serializeQuotaAlertMetric({ kind: "balance", currency: "CNY", amount: 88 }),
    ).toEqual({
      key: QUOTA_ALERT_METRIC_RAWDETAILS_KEY,
      value: '{"type":"balance","currency":"CNY","amount":88}',
    });
  });

  it("serializes availability facts preserving the tri-state", () => {
    expect(
      serializeQuotaAlertMetric({ kind: "availability", status: "unavailable" }),
    ).toEqual({
      key: QUOTA_ALERT_METRIC_RAWDETAILS_KEY,
      value: '{"type":"availability","status":"unavailable"}',
    });
    expect(
      normalizeQuotaAlertMetricFacts([
        serializeQuotaAlertMetric({ kind: "availability", status: "unknown" }),
      ]),
    ).toEqual([{ kind: "availability", status: "unknown" }]);
  });

  it("round-trips multiple balance facts through rawDetails", () => {
    const facts = normalizeQuotaAlertMetricFacts([
      serializeQuotaAlertMetric({ kind: "balance", currency: "CNY", amount: 1.5 }),
      serializeQuotaAlertMetric({ kind: "balance", currency: "USD", amount: 0 }),
      serializeQuotaAlertMetric({ kind: "availability", status: "available" }),
    ]);
    expect(facts).toEqual([
      { kind: "balance", currency: "CNY", amount: 1.5 },
      { kind: "balance", currency: "USD", amount: 0 },
      { kind: "availability", status: "available" },
    ]);
  });

  it("returns no facts when rawDetails are absent", () => {
    expect(normalizeQuotaAlertMetricFacts(undefined)).toEqual([]);
    expect(normalizeQuotaAlertMetricFacts([])).toEqual([]);
  });

  it("skips unrelated rawDetails entries", () => {
    expect(
      normalizeQuotaAlertMetricFacts([{ key: "accounting_mode", value: "gateway_balance" }]),
    ).toEqual([]);
  });

  it("skips malformed facts so they can never alert", () => {
    expect(
      normalizeQuotaAlertMetricFacts([
        { key: QUOTA_ALERT_METRIC_RAWDETAILS_KEY, value: "not-json" },
        { key: QUOTA_ALERT_METRIC_RAWDETAILS_KEY, value: '{"type":"balance"}' },
        { key: QUOTA_ALERT_METRIC_RAWDETAILS_KEY, value: '{"type":"balance","currency":"CNY","amount":"88"}' },
        { key: QUOTA_ALERT_METRIC_RAWDETAILS_KEY, value: '{"type":"balance","currency":"CNY","amount":NaN}' },
        { key: QUOTA_ALERT_METRIC_RAWDETAILS_KEY, value: '{"type":"balance","currency":"","amount":88}' },
        { key: QUOTA_ALERT_METRIC_RAWDETAILS_KEY, value: '{"type":"availability","status":"maybe"}' },
        { key: QUOTA_ALERT_METRIC_RAWDETAILS_KEY, value: '{"type":"spend","amount":1}' },
        { key: QUOTA_ALERT_METRIC_RAWDETAILS_KEY, value: "[]" },
        { key: QUOTA_ALERT_METRIC_RAWDETAILS_KEY, value: "null" },
      ]),
    ).toEqual([]);
  });

  it("never converts metric kinds into one another", () => {
    const balance = serializeQuotaAlertMetric({ kind: "balance", currency: "USD", amount: 5 });
    const normalized = normalizeQuotaAlertMetricFacts([balance]);
    expect(normalized).toEqual([{ kind: "balance", currency: "USD", amount: 5 }]);
    expect(normalized[0]).not.toHaveProperty("status");
    expect(normalized[0]).not.toHaveProperty("percentRemaining");
  });
});

describe("percent-window fallback normalization", () => {
  it("keeps finite numeric percent remaining values", () => {
    expect(normalizePercentWindowRemaining(0)).toBe(0);
    expect(normalizePercentWindowRemaining(12.5)).toBe(12.5);
    expect(normalizePercentWindowRemaining(-3)).toBe(-3);
  });

  it("returns undefined for missing or non-finite values without synthesizing 0", () => {
    expect(normalizePercentWindowRemaining(undefined)).toBeUndefined();
    expect(normalizePercentWindowRemaining(null)).toBeUndefined();
    expect(normalizePercentWindowRemaining(Number.NaN)).toBeUndefined();
    expect(normalizePercentWindowRemaining(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(normalizePercentWindowRemaining("0")).toBeUndefined();
    expect(normalizePercentWindowRemaining({})).toBeUndefined();
  });
});
