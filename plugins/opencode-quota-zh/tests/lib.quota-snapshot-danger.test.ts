/**
 * Ticket 09: pure snapshot-level danger evaluation — typed metric contract
 * tests.
 *
 * Percent, balance and availability are explicit metric kinds that are never
 * converted into one another. Danger uses current value <= configured
 * threshold with a default percent threshold of 0. Explicit provider-reported
 * unavailability forms a critical candidate even without monetary thresholds.
 * Missing, failed, stale and synthetic observations neither trigger nor
 * recover danger, and a missing percent window never synthesizes an alertable
 * 0% entry.
 */

import { describe, expect, it } from "vitest";

import {
  buildQuotaAlertPlan,
  buildUnifiedQuotaSnapshot,
  evaluateQuotaDangerMetrics,
  QUOTA_SNAPSHOT_VERSION,
  type QuotaProviderResult,
  type UnifiedQuotaSnapshot,
} from "../src/lib/quota-snapshot.js";
import { serializeQuotaAlertMetric } from "../src/lib/quota-alert-metrics.js";
import type { QuotaToastConfig } from "../src/lib/types.js";

const FRESH_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

function alertConfig(
  overrides: Partial<QuotaToastConfig["alerts"]> = {},
): Pick<QuotaToastConfig, "alerts">["alerts"] {
  return {
    enabled: true,
    percentRemainingThreshold: 0,
    repeatAfterMinutes: null,
    balanceThresholds: {},
    ...overrides,
  };
}

function providerResult(params: {
  entries?: QuotaProviderResult["entries"];
  rawDetails?: QuotaProviderResult["rawDetails"];
  errors?: QuotaProviderResult["errors"];
}): QuotaProviderResult {
  return {
    attempted: true,
    entries: params.entries ?? [],
    errors: params.errors ?? [],
    ...(params.rawDetails ? { rawDetails: params.rawDetails } : {}),
  };
}

function buildSnapshot(params: {
  providerId?: string;
  result?: QuotaProviderResult;
  available?: boolean;
}): UnifiedQuotaSnapshot {
  return buildUnifiedQuotaSnapshot({
    monitoredProviderIds: [params.providerId ?? "deepseek"],
    availability: [{ providerId: params.providerId ?? "deepseek", ok: params.available ?? true }],
    results: params.result
      ? [{ providerId: params.providerId ?? "deepseek", result: params.result }]
      : [],
  });
}

function window(params: {
  providerId?: string;
  providerLabel?: string;
  quality?: UnifiedQuotaSnapshot["windows"][number]["quality"];
  percentRemaining?: number;
  amount?: number;
  currency?: string;
  status?: "available" | "unavailable" | "unknown";
  windowLabel?: string;
  resetTimeIso?: string;
}): UnifiedQuotaSnapshot["windows"][number] {
  const metricType = params.amount !== undefined
    ? "balance" as const
    : params.status !== undefined
      ? "availability" as const
      : "percent_remaining" as const;
  return {
    metricType,
    providerId: params.providerId ?? "deepseek",
    providerLabel: params.providerLabel ?? "DeepSeek",
    quality: params.quality ?? ("fresh" as const),
    authority: "provider_reported",
    ...(params.windowLabel ? { windowLabel: params.windowLabel } : {}),
    ...(params.percentRemaining !== undefined ? { percentRemaining: params.percentRemaining } : {}),
    ...(params.amount !== undefined ? { amount: params.amount } : {}),
    ...(params.currency !== undefined ? { currency: params.currency } : {}),
    ...(params.status !== undefined ? { status: params.status } : {}),
    ...(params.resetTimeIso ? { resetTimeIso: params.resetTimeIso } : {}),
  };
}

function snapshotWithWindows(windows: UnifiedQuotaSnapshot["windows"]): UnifiedQuotaSnapshot {
  return {
    version: QUOTA_SNAPSHOT_VERSION,
    integrity: "complete",
    providers: [{ providerId: "deepseek", quality: "fresh", errors: [] }],
    windows,
  };
}

describe("evaluateQuotaDangerMetrics", () => {
  it("flags percent windows at or below the configured threshold with critical severity at 0", () => {
    const snapshot = snapshotWithWindows([
      window({ percentRemaining: 0, windowLabel: "5h:", resetTimeIso: "2026-08-11T02:00:00.000Z" }),
      window({ percentRemaining: 50 }),
    ]);
    const candidates = evaluateQuotaDangerMetrics({ alerts: alertConfig(), snapshot });
    expect(candidates).toEqual([
      {
        metricType: "percent_remaining",
        providerId: "deepseek",
        providerLabel: "DeepSeek",
        severity: "critical",
        windowLabel: "5h:",
        percentRemaining: 0,
        thresholdPercentRemaining: 0,
        resetTimeIso: "2026-08-11T02:00:00.000Z",
      },
    ]);
  });

  it("uses warning severity for a configured early threshold while the provider remains usable", () => {
    const snapshot = snapshotWithWindows([
      window({ percentRemaining: 3 }),
      window({ percentRemaining: 0 }),
    ]);
    const candidates = evaluateQuotaDangerMetrics({
      alerts: alertConfig({ percentRemainingThreshold: 5 }),
      snapshot,
    });
    expect(candidates.map((candidate) => [candidate.percentRemaining, candidate.severity])).toEqual([
      [3, "warning"],
      [0, "critical"],
    ]);
    expect(candidates[0]?.thresholdPercentRemaining).toBe(5);
  });

  it("keeps percent values above the threshold safe", () => {
    const snapshot = snapshotWithWindows([window({ percentRemaining: 0.1 })]);
    expect(
      evaluateQuotaDangerMetrics({ alerts: alertConfig({ percentRemainingThreshold: 0 }), snapshot }),
    ).toEqual([]);
  });

  it("evaluates balance per provider and currency independently", () => {
    const snapshot = snapshotWithWindows([
      window({ amount: 1.5, currency: "CNY" }),
      window({ amount: 0.4, currency: "USD" }),
      window({ amount: 9, currency: "EUR" }),
    ]);
    const candidates = evaluateQuotaDangerMetrics({
      alerts: alertConfig({
        balanceThresholds: { deepseek: { CNY: 2, USD: 0.5 } },
      }),
      snapshot,
    });
    expect(candidates).toEqual([
      {
        metricType: "balance",
        providerId: "deepseek",
        providerLabel: "DeepSeek",
        severity: "warning",
        currency: "CNY",
        amount: 1.5,
        thresholdAmount: 2,
      },
      {
        metricType: "balance",
        providerId: "deepseek",
        providerLabel: "DeepSeek",
        severity: "warning",
        currency: "USD",
        amount: 0.4,
        thresholdAmount: 0.5,
      },
    ]);
    // EUR has no configured threshold and never becomes a candidate.
  });

  it("treats a zero balance as critical and never converts it into a percent", () => {
    const snapshot = snapshotWithWindows([window({ amount: 0, currency: "USD" })]);
    const candidates = evaluateQuotaDangerMetrics({
      alerts: alertConfig({ balanceThresholds: { deepseek: { USD: 0 } } }),
      snapshot,
    });
    expect(candidates).toEqual([
      {
        metricType: "balance",
        providerId: "deepseek",
        providerLabel: "DeepSeek",
        severity: "critical",
        currency: "USD",
        amount: 0,
        thresholdAmount: 0,
      },
    ]);
    expect(candidates[0]).not.toHaveProperty("percentRemaining");
  });

  it("forms a critical candidate for explicit unavailability without monetary thresholds", () => {
    const snapshot = snapshotWithWindows([window({ status: "unavailable" })]);
    const candidates = evaluateQuotaDangerMetrics({ alerts: alertConfig(), snapshot });
    expect(candidates).toEqual([
      {
        metricType: "availability",
        providerId: "deepseek",
        providerLabel: "DeepSeek",
        severity: "critical",
        status: "unavailable",
      },
    ]);
  });

  it("never alerts on unknown availability", () => {
    const snapshot = snapshotWithWindows([window({ status: "unknown" })]);
    expect(evaluateQuotaDangerMetrics({ alerts: alertConfig(), snapshot })).toEqual([]);
  });

  it("produces no candidates when alerts are disabled", () => {
    const snapshot = snapshotWithWindows([
      window({ percentRemaining: 0 }),
      window({ status: "unavailable" }),
      window({ amount: 0, currency: "USD" }),
    ]);
    expect(
      evaluateQuotaDangerMetrics({
        alerts: alertConfig({ enabled: false, balanceThresholds: { deepseek: { USD: 0 } } }),
        snapshot,
      }),
    ).toEqual([]);
  });

  it("excludes missing, failed, stale and synthetic observations from trigger and recovery", () => {
    const snapshot: UnifiedQuotaSnapshot = {
      version: QUOTA_SNAPSHOT_VERSION,
      integrity: "unknown",
      providers: [
        { providerId: "missing-provider", quality: "missing", errors: [] },
        { providerId: "failed-provider", quality: "failed", errors: [{ label: "F", message: "timeout" }] },
        { providerId: "stale-provider", quality: "stale", errors: [] },
        { providerId: "synthetic-provider", quality: "synthetic", errors: [] },
      ],
      windows: [
        window({ providerId: "missing-provider", quality: "missing", percentRemaining: 0 }),
        window({ providerId: "failed-provider", quality: "failed", percentRemaining: 0 }),
        window({ providerId: "stale-provider", quality: "stale", percentRemaining: 0 }),
        window({ providerId: "synthetic-provider", quality: "synthetic", percentRemaining: 0 }),
        window({ providerId: "synthetic-provider", quality: "synthetic", status: "unavailable" }),
        window({ providerId: "failed-provider", quality: "failed", amount: 0, currency: "USD" }),
      ],
    };
    expect(
      evaluateQuotaDangerMetrics({
        alerts: alertConfig({ balanceThresholds: { "failed-provider": { USD: 0 } } }),
        snapshot,
      }),
    ).toEqual([]);
  });
});

describe("buildQuotaAlertPlan", () => {
  it("wraps candidates in a versioned plan with an empty notification list", () => {
    const snapshot = snapshotWithWindows([window({ status: "unavailable" })]);
    expect(buildQuotaAlertPlan(alertConfig(), snapshot)).toEqual({
      version: 2,
      notifications: [],
      candidates: [
        {
          metricType: "availability",
          providerId: "deepseek",
          providerLabel: "DeepSeek",
          severity: "critical",
          status: "unavailable",
        },
      ],
    });
  });
});

describe("buildUnifiedQuotaSnapshot typed metric windows", () => {
  it("maps balance and availability facts into typed windows without parsing display text", () => {
    const snapshot = buildSnapshot({
      result: providerResult({
        entries: [
          {
            kind: "value",
            accounting: FRESH_ACCOUNTING,
            name: "DeepSeek Balance",
            value: "¥88.00",
          },
        ],
        rawDetails: [
          serializeQuotaAlertMetric({ kind: "balance", currency: "CNY", amount: 88 }),
          serializeQuotaAlertMetric({ kind: "availability", status: "available" }),
        ],
      }),
    });

    expect(snapshot.windows).toContainEqual({
      metricType: "balance",
      providerId: "deepseek",
      providerLabel: "DeepSeek",
      currency: "CNY",
      amount: 88,
      quality: "fresh",
      authority: "provider_reported",
    });
    expect(snapshot.windows).toContainEqual({
      metricType: "availability",
      providerId: "deepseek",
      providerLabel: "DeepSeek",
      status: "available",
      quality: "fresh",
      authority: "provider_reported",
    });
  });

  it("does not synthesize an alertable 0% percent window when percent data is missing", () => {
    const noPercent = buildSnapshot({
      result: providerResult({
        entries: [
          {
            kind: "value",
            accounting: FRESH_ACCOUNTING,
            name: "DeepSeek",
            value: "Low balance",
          },
        ],
        rawDetails: [serializeQuotaAlertMetric({ kind: "availability", status: "unavailable" })],
      }),
    });
    expect(noPercent.windows.filter((w) => w.metricType === "percent_remaining")).toEqual([]);

    const candidates = evaluateQuotaDangerMetrics({ alerts: alertConfig(), snapshot: noPercent });
    expect(candidates).toEqual([
      {
        metricType: "availability",
        providerId: "deepseek",
        providerLabel: "DeepSeek",
        severity: "critical",
        status: "unavailable",
      },
    ]);
  });

  it("skips non-finite percent entries instead of treating them as 0", () => {
    const snapshot = buildSnapshot({
      result: providerResult({
        entries: [{ accounting: FRESH_ACCOUNTING, name: "DeepSeek", percentRemaining: Number.NaN }],
      }),
    });
    expect(snapshot.windows.filter((w) => w.metricType === "percent_remaining")).toEqual([]);
    expect(evaluateQuotaDangerMetrics({ alerts: alertConfig(), snapshot })).toEqual([]);
  });

  it("does not produce balance windows for malformed amounts", () => {
    const snapshot = buildSnapshot({
      result: providerResult({
        entries: [],
        rawDetails: [
          // A non-finite amount cannot survive JSON on the wire; whatever the
          // source sends, the normalization helper rejects non-number facts.
          { key: "quota.alert.metric", value: '{"type":"balance","currency":"CNY","amount":null}' },
          { key: "quota.alert.metric", value: '{"type":"balance","currency":"CNY","amount":"88"}' },
        ],
      }),
    });
    expect(snapshot.windows.filter((w) => w.metricType === "balance")).toEqual([]);
    expect(evaluateQuotaDangerMetrics({ alerts: alertConfig(), snapshot })).toEqual([]);
  });

  it("propagates failed provider quality to every window so errors never alert", () => {
    const snapshot = buildSnapshot({
      available: false,
      result: undefined,
    });
    expect(snapshot.providers[0]?.quality).toBe("failed");
    expect(evaluateQuotaDangerMetrics({ alerts: alertConfig(), snapshot })).toEqual([]);
  });
});

describe("candidate determinism", () => {
  it("produces identical candidates for identical inputs", () => {
    const snapshot = snapshotWithWindows([
      window({ percentRemaining: 0, windowLabel: "5h:" }),
      window({ amount: 1, currency: "USD" }),
      window({ status: "unavailable" }),
    ]);
    const alerts = alertConfig({ balanceThresholds: { deepseek: { USD: 2 } } });
    const first = evaluateQuotaDangerMetrics({ alerts, snapshot });
    const second = evaluateQuotaDangerMetrics({ alerts, snapshot });
    expect(second).toEqual(first);
    expect(second).toHaveLength(3);
  });
});
