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
    expect(text).toBe("额度：DeepSeek 5h额度剩余 12%，2 小时后重置。输入 /quota 查看详情。");
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

  it("formats the lowest fresh percent in a partial projection without unknown-count copy", () => {
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
    expect(text).toBe("额度：NanoGPT 额度剩余 9%。输入 /quota 查看详情。");
    expect(text).not.toContain("部分可用");
    expect(text).not.toContain("状态未知");
    expect(text).not.toContain("最相关");
  });

  it("hides the startup hint when every provider failed, never inferring exhaustion", () => {
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

    // No fresh percent window: hide instead of a diagnostic or inferred 0%.
    expect(formatStartupHintText(projection.startupHint, FIXED_NOW)).toBeNull();
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

  it("formats the concise fresh-percent sentence for an OpenAI Weekly 85% window", () => {
    const snapshot: UnifiedQuotaSnapshot = {
      version: QUOTA_SNAPSHOT_VERSION,
      integrity: "complete",
      providers: [{ providerId: "openai", quality: "fresh", errors: [] }],
      windows: [
        percentWindow({
          providerId: "openai",
          providerLabel: "OpenAI",
          percentRemaining: 85,
          windowLabel: "Weekly:",
          resetTimeIso: "2026-08-17T22:00:00.000Z",
        }),
      ],
    };
    const projection = projectQuotaSnapshot({
      config: makeConfig(),
      snapshot,
      now: FIXED_NOW,
      state: EMPTY_QUOTA_PROJECTION_STATE,
    });

    expect(formatStartupHintText(projection.startupHint, FIXED_NOW)).toBe(
      "额度：OpenAI 周额度剩余 85%，166 小时后重置。输入 /quota 查看详情。",
    );
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

describe("formatStartupHintText (fresh lowest-percent window only)", () => {
  function project(snapshot: UnifiedQuotaSnapshot) {
    return projectQuotaSnapshot({
      config: makeConfig(),
      snapshot,
      now: FIXED_NOW,
      state: EMPTY_QUOTA_PROJECTION_STATE,
    }).startupHint;
  }

  it("selects the lowest fresh percent across competing windows", () => {
    const snapshot: UnifiedQuotaSnapshot = {
      version: QUOTA_SNAPSHOT_VERSION,
      integrity: "complete",
      providers: [
        { providerId: "deepseek", quality: "fresh", errors: [] },
        { providerId: "nanogpt", quality: "fresh", errors: [] },
      ],
      windows: [
        percentWindow({
          providerId: "nanogpt",
          providerLabel: "NanoGPT",
          percentRemaining: 80,
          windowLabel: "Weekly:",
        }),
        percentWindow({
          providerId: "deepseek",
          providerLabel: "DeepSeek",
          percentRemaining: 12,
          windowLabel: "5h:",
        }),
      ],
    };

    const payload = project(snapshot);
    expect(payload.mostRelevant?.providerId).toBe("deepseek");
    expect(formatStartupHintText(payload, FIXED_NOW)).toBe(
      "额度：DeepSeek 5h额度剩余 12%。输入 /quota 查看详情。",
    );
  });

  it("keeps the first window when competing fresh percents tie", () => {
    const snapshot: UnifiedQuotaSnapshot = {
      version: QUOTA_SNAPSHOT_VERSION,
      integrity: "complete",
      providers: [
        { providerId: "nanogpt", quality: "fresh", errors: [] },
        { providerId: "deepseek", quality: "fresh", errors: [] },
      ],
      windows: [
        percentWindow({
          providerId: "nanogpt",
          providerLabel: "NanoGPT",
          percentRemaining: 30,
          windowLabel: "Daily:",
        }),
        percentWindow({
          providerId: "deepseek",
          providerLabel: "DeepSeek",
          percentRemaining: 30,
          windowLabel: "5h:",
        }),
      ],
    };

    const payload = project(snapshot);
    expect(payload.mostRelevant?.providerId).toBe("nanogpt");
    expect(formatStartupHintText(payload, FIXED_NOW)).toBe(
      "额度：NanoGPT 天额度剩余 30%。输入 /quota 查看详情。",
    );
  });

  it("hides when a fresh provider only reports a balance, never a percent window", () => {
    const snapshot: UnifiedQuotaSnapshot = {
      version: QUOTA_SNAPSHOT_VERSION,
      integrity: "complete",
      providers: [{ providerId: "openai", quality: "fresh", errors: [] }],
      windows: [
        {
          metricType: "balance",
          providerId: "openai",
          providerLabel: "OpenAI",
          currency: "USD",
          amount: 5,
          quality: "fresh",
          authority: "provider_reported",
        },
      ],
    };

    expect(formatStartupHintText(project(snapshot), FIXED_NOW)).toBeNull();
  });

  it("omits the reset countdown when no reset time is reported", () => {
    const snapshot: UnifiedQuotaSnapshot = {
      version: QUOTA_SNAPSHOT_VERSION,
      integrity: "complete",
      providers: [{ providerId: "deepseek", quality: "fresh", errors: [] }],
      windows: [
        percentWindow({
          providerId: "deepseek",
          providerLabel: "DeepSeek",
          percentRemaining: 30,
        }),
      ],
    };

    expect(formatStartupHintText(project(snapshot), FIXED_NOW)).toBe(
      "额度：DeepSeek 额度剩余 30%。输入 /quota 查看详情。",
    );
  });

  it("omits only the window segment for an unclassifiable label, never raw colons", () => {
    const snapshot: UnifiedQuotaSnapshot = {
      version: QUOTA_SNAPSHOT_VERSION,
      integrity: "complete",
      providers: [{ providerId: "openai", quality: "fresh", errors: [] }],
      windows: [
        percentWindow({
          providerId: "openai",
          providerLabel: "OpenAI",
          percentRemaining: 70,
          windowLabel: "Foobar:",
        }),
      ],
    };

    const text = formatStartupHintText(project(snapshot), FIXED_NOW);
    expect(text).toBe("额度：OpenAI 额度剩余 70%。输入 /quota 查看详情。");
    expect(text).not.toContain("Foobar");
    expect(text).not.toContain("（）");
  });

  it("never infers 0% exhaustion from a fresh window rounding to zero", () => {
    const snapshot: UnifiedQuotaSnapshot = {
      version: QUOTA_SNAPSHOT_VERSION,
      integrity: "complete",
      providers: [{ providerId: "openai", quality: "fresh", errors: [] }],
      windows: [
        percentWindow({
          providerId: "openai",
          providerLabel: "OpenAI",
          percentRemaining: 0.4,
          windowLabel: "Weekly:",
        }),
      ],
    };

    expect(formatStartupHintText(project(snapshot), FIXED_NOW)).toBeNull();
  });
});
