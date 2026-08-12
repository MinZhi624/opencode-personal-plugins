/**
 * Ticket 07: unified quota snapshot projection seam — pure contract tests.
 *
 * The seam consumes a unified quota snapshot, validated configuration, an
 * injected clock and current projection state, and returns passive-surface
 * payloads (startup hint), an alert plan, and the next state. It performs no
 * I/O and is fully deterministic: identical inputs yield identical outputs.
 *
 * These tests never assert private helper calls or internal collection shapes.
 */

import { describe, expect, it } from "vitest";

import {
  buildUnifiedQuotaSnapshot,
  EMPTY_QUOTA_PROJECTION_STATE,
  formatStartupHintText,
  projectQuotaSnapshot,
  QUOTA_SNAPSHOT_VERSION,
  type QuotaProviderResult,
  type UnifiedQuotaSnapshot,
} from "../src/lib/quota-snapshot.js";
import type { QuotaToastConfig } from "../src/lib/types.js";

const FIXED_NOW = new Date("2026-08-11T00:00:00.000Z");

const FRESH_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

function percentWindow(params: {
  providerId: string;
  providerLabel: string;
  percentRemaining: number;
  windowLabel?: string;
  resetTimeIso?: string;
  quality?: UnifiedQuotaSnapshot["windows"][number]["quality"];
}) {
  return {
    metricType: "percent_remaining" as const,
    providerId: params.providerId,
    providerLabel: params.providerLabel,
    windowLabel: params.windowLabel,
    percentRemaining: params.percentRemaining,
    resetTimeIso: params.resetTimeIso,
    quality: params.quality ?? ("fresh" as const),
    authority: "provider_reported" as const,
  };
}

function providerResult(params: {
  attempted?: boolean;
  entries?: QuotaProviderResult["entries"];
  errors?: QuotaProviderResult["errors"];
}): QuotaProviderResult {
  return {
    attempted: params.attempted ?? true,
    entries: params.entries ?? [],
    errors: params.errors ?? [],
  };
}

function makeConfig(
  overrides: Partial<QuotaToastConfig["startupHint"]> = {},
): Pick<QuotaToastConfig, "startupHint" | "alerts"> {
  return {
    startupHint: { enabled: true, ...overrides },
    alerts: {
      enabled: true,
      percentRemainingThreshold: 0,
      repeatAfterMinutes: null,
      balanceThresholds: {},
    },
  };
}

describe("projectQuotaSnapshot (unified quota snapshot seam)", () => {
  it("projects a healthy snapshot into an ok startup hint with the most relevant item", () => {
    const snapshot = buildUnifiedQuotaSnapshot({
      monitoredProviderIds: ["deepseek", "nanogpt"],
      availability: [
        { providerId: "deepseek", ok: true },
        { providerId: "nanogpt", ok: true },
      ],
      results: [
        {
          providerId: "deepseek",
          result: providerResult({
            entries: [
              {
                accounting: FRESH_ACCOUNTING,
                name: "DeepSeek",
                label: "5h:",
                percentRemaining: 12,
                resetTimeIso: "2026-08-11T02:00:00.000Z",
              },
              {
                accounting: FRESH_ACCOUNTING,
                name: "DeepSeek",
                label: "Daily:",
                percentRemaining: 55,
              },
            ],
          }),
        },
        {
          providerId: "nanogpt",
          result: providerResult({
            entries: [
              {
                accounting: FRESH_ACCOUNTING,
                name: "NanoGPT",
                percentRemaining: 80,
              },
            ],
          }),
        },
      ],
    });

    expect(snapshot.version).toBe(QUOTA_SNAPSHOT_VERSION);
    expect(snapshot.integrity).toBe("complete");
    expect(snapshot.providers).toHaveLength(2);

    const projection = projectQuotaSnapshot({
      config: makeConfig(),
      snapshot,
      now: FIXED_NOW,
      state: EMPTY_QUOTA_PROJECTION_STATE,
    });

    expect(projection.startupHint.state).toBe("ok");
    expect(projection.startupHint.providerCount).toBe(2);
    expect(projection.startupHint.unknownCount).toBe(0);
    // Most relevant item: lowest reliable remaining-percent window across all
    // monitored providers (DeepSeek 5h at 12%, not NanoGPT 80%).
    expect(projection.startupHint.mostRelevant).toEqual({
      providerId: "deepseek",
      providerLabel: "DeepSeek",
      windowLabel: "5h:",
      percentRemaining: 12,
      resetTimeIso: "2026-08-11T02:00:00.000Z",
    });

    const text = formatStartupHintText(projection.startupHint, FIXED_NOW);
    expect(text).toContain("整体正常");
    expect(text).toContain("DeepSeek");
    expect(text).toContain("12% 剩余");
    expect(text).toContain("2 个 Provider");
    expect(text).toContain("/quota");
  });

  it("shows no startup hint when no provider is monitored", () => {
    const snapshot = buildUnifiedQuotaSnapshot({
      monitoredProviderIds: [],
      availability: [],
      results: [],
    });
    const projection = projectQuotaSnapshot({
      config: makeConfig(),
      snapshot,
      now: FIXED_NOW,
      state: EMPTY_QUOTA_PROJECTION_STATE,
    });

    expect(projection.startupHint.state).toBe("none");
    expect(projection.startupHint.providerCount).toBe(0);
    expect(projection.startupHint.mostRelevant).toBeUndefined();
    expect(formatStartupHintText(projection.startupHint, FIXED_NOW)).toBeNull();
  });

  it("summarizes partial failure with an unknown count without hiding fresh providers", () => {
    const snapshot = buildUnifiedQuotaSnapshot({
      monitoredProviderIds: ["deepseek", "nanogpt", "openai"],
      availability: [
        { providerId: "deepseek", ok: true },
        { providerId: "nanogpt", ok: true },
        { providerId: "openai", ok: true },
      ],
      results: [
        {
          providerId: "deepseek",
          result: providerResult({
            entries: [
              {
                accounting: FRESH_ACCOUNTING,
                name: "DeepSeek",
                percentRemaining: 42,
              },
            ],
          }),
        },
        {
          providerId: "nanogpt",
          result: providerResult({
            entries: [
              {
                accounting: FRESH_ACCOUNTING,
                name: "NanoGPT",
                percentRemaining: 9,
              },
            ],
          }),
        },
        {
          providerId: "openai",
          result: providerResult({
            errors: [{ label: "OpenAI", message: "Failed to read quota data" }],
          }),
        },
      ],
    });

    expect(snapshot.integrity).toBe("partial");
    expect(snapshot.providers.find((p) => p.providerId === "openai")?.quality).toBe("failed");

    const projection = projectQuotaSnapshot({
      config: makeConfig(),
      snapshot,
      now: FIXED_NOW,
      state: EMPTY_QUOTA_PROJECTION_STATE,
    });

    expect(projection.startupHint.state).toBe("partial");
    expect(projection.startupHint.providerCount).toBe(3);
    expect(projection.startupHint.unknownCount).toBe(1);
    // Fresh providers are never hidden by partial failure.
    expect(projection.startupHint.mostRelevant?.providerId).toBe("nanogpt");

    const text = formatStartupHintText(projection.startupHint, FIXED_NOW);
    expect(text).toContain("部分可用");
    expect(text).toContain("3 个 Provider");
    expect(text).toContain("1 个状态未知");
    expect(text).toContain("/quota");
  });

  it("reports total failure as a passive unknown diagnostic, never as exhaustion", () => {
    const snapshot = buildUnifiedQuotaSnapshot({
      monitoredProviderIds: ["deepseek", "nanogpt"],
      availability: [
        { providerId: "deepseek", ok: true },
        { providerId: "nanogpt", ok: true },
      ],
      results: [
        {
          providerId: "deepseek",
          result: providerResult({
            errors: [{ label: "DeepSeek", message: "Failed to read quota data" }],
          }),
        },
        {
          providerId: "nanogpt",
          result: providerResult({
            errors: [{ label: "NanoGPT", message: "timeout" }],
          }),
        },
      ],
    });

    const projection = projectQuotaSnapshot({
      config: makeConfig(),
      snapshot,
      now: FIXED_NOW,
      state: EMPTY_QUOTA_PROJECTION_STATE,
    });

    expect(projection.startupHint.state).toBe("unknown");
    expect(projection.startupHint.providerCount).toBe(2);
    expect(projection.startupHint.unknownCount).toBe(2);
    expect(projection.startupHint.mostRelevant).toBeUndefined();

    const text = formatStartupHintText(projection.startupHint, FIXED_NOW);
    expect(text).toContain("额度状态未知");
    expect(text).toContain("/quota");
    expect(text).not.toMatch(/%\s*剩余/);
    expect(text).not.toContain("0%");
  });

  it("never selects unreliable windows as the most relevant item", () => {
    const snapshot: UnifiedQuotaSnapshot = {
      version: QUOTA_SNAPSHOT_VERSION,
      integrity: "partial",
      providers: [
        { providerId: "synthetic", quality: "synthetic", errors: [] },
        { providerId: "stale-provider", quality: "stale", errors: [] },
      ],
      windows: [
        percentWindow({
          providerId: "synthetic",
          providerLabel: "Synthetic",
          percentRemaining: 0,
          quality: "synthetic",
        }),
        percentWindow({
          providerId: "stale-provider",
          providerLabel: "Stale",
          percentRemaining: 3,
          quality: "stale",
        }),
      ],
    };

    const projection = projectQuotaSnapshot({
      config: makeConfig(),
      snapshot,
      now: FIXED_NOW,
      state: EMPTY_QUOTA_PROJECTION_STATE,
    });

    expect(projection.startupHint.state).toBe("unknown");
    expect(projection.startupHint.mostRelevant).toBeUndefined();
  });

  it("suppresses the startup hint when startupHint.enabled is false", () => {
    const snapshot = buildUnifiedQuotaSnapshot({
      monitoredProviderIds: ["deepseek"],
      availability: [{ providerId: "deepseek", ok: true }],
      results: [
        {
          providerId: "deepseek",
          result: providerResult({
            entries: [
              { accounting: FRESH_ACCOUNTING, name: "DeepSeek", percentRemaining: 50 },
            ],
          }),
        },
      ],
    });

    const projection = projectQuotaSnapshot({
      config: makeConfig({ enabled: false }),
      snapshot,
      now: FIXED_NOW,
      state: EMPTY_QUOTA_PROJECTION_STATE,
    });

    expect(projection.startupHint.state).toBe("none");
    expect(formatStartupHintText(projection.startupHint, FIXED_NOW)).toBeNull();
  });

  it("formats the reset countdown deterministically from the injected clock", () => {
    const snapshot: UnifiedQuotaSnapshot = {
      version: QUOTA_SNAPSHOT_VERSION,
      integrity: "complete",
      providers: [{ providerId: "deepseek", quality: "fresh", errors: [] }],
      windows: [
        percentWindow({
          providerId: "deepseek",
          providerLabel: "DeepSeek",
          percentRemaining: 12,
          windowLabel: "5h:",
          resetTimeIso: "2026-08-11T02:00:00.000Z",
        }),
      ],
    };

    const projection = projectQuotaSnapshot({
      config: makeConfig(),
      snapshot,
      now: FIXED_NOW,
      state: EMPTY_QUOTA_PROJECTION_STATE,
    });

    const near = formatStartupHintText(projection.startupHint, new Date("2026-08-11T00:30:00.000Z"));
    expect(near).toContain("2 小时后重置");

    const close = formatStartupHintText(projection.startupHint, new Date("2026-08-11T01:45:00.000Z"));
    expect(close).toContain("15 分钟后重置");
  });

  it("returns an empty alert plan and echoes the current state unchanged", () => {
    const snapshot = buildUnifiedQuotaSnapshot({
      monitoredProviderIds: ["deepseek"],
      availability: [{ providerId: "deepseek", ok: true }],
      results: [
        {
          providerId: "deepseek",
          result: providerResult({
            entries: [
              { accounting: FRESH_ACCOUNTING, name: "DeepSeek", percentRemaining: 50 },
            ],
          }),
        },
      ],
    });

    const projection = projectQuotaSnapshot({
      config: makeConfig(),
      snapshot,
      now: FIXED_NOW,
      state: EMPTY_QUOTA_PROJECTION_STATE,
    });

    // Ticket 09 typed danger metrics: safe observations produce no candidates
    // (50% remaining is above the default 0% threshold) and the projection
    // state is still echoed unchanged until Tickets 11/12 add episodes.
    expect(projection.alertPlan).toEqual({ version: 2, notifications: [], candidates: [] });
    expect(projection.nextState).toBe(EMPTY_QUOTA_PROJECTION_STATE);
  });

  it("is deterministic: identical inputs produce identical outputs", () => {
    const snapshot = buildUnifiedQuotaSnapshot({
      monitoredProviderIds: ["deepseek"],
      availability: [{ providerId: "deepseek", ok: true }],
      results: [
        {
          providerId: "deepseek",
          result: providerResult({
            entries: [
              { accounting: FRESH_ACCOUNTING, name: "DeepSeek", percentRemaining: 30 },
            ],
          }),
        },
      ],
    });

    const params = {
      config: makeConfig(),
      snapshot,
      now: FIXED_NOW,
      state: EMPTY_QUOTA_PROJECTION_STATE,
    };
    const first = projectQuotaSnapshot(params);
    const second = projectQuotaSnapshot(params);

    expect(second).toEqual(first);
    expect(formatStartupHintText(first.startupHint, FIXED_NOW)).toBe(
      formatStartupHintText(second.startupHint, FIXED_NOW),
    );
  });
});
