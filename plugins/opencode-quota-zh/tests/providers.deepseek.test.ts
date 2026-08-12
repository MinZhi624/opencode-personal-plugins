import { describe, expect, it, vi } from "vitest";
import { deepseekProvider } from "../src/providers/deepseek.js";
import { QUOTA_ALERT_METRIC_RAWDETAILS_KEY } from "../src/lib/quota-alert-metrics.js";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";

vi.mock("../src/lib/deepseek.js", () => ({
  queryDeepSeekBalance: vi.fn(),
  hasDeepSeekApiKeyConfigured: vi.fn(),
  getDeepSeekKeyDiagnostics: vi.fn(async () => ({
    configured: false,
    source: null,
    checkedPaths: [],
    authPaths: [],
  })),
  formatDeepSeekBalanceValue: vi.fn(
    (balance: { currency: "CNY" | "USD"; totalBalance: string }) =>
      `${balance.currency === "CNY" ? "¥" : "$"}${balance.totalBalance}`,
  ),
}));

vi.mock("../src/lib/provider-availability.js", () => ({
  isCanonicalProviderAvailable: vi.fn(),
}));

describe("deepseek provider", () => {
  it("returns attempted:false when not configured", async () => {
    const { queryDeepSeekBalance } = await import("../src/lib/deepseek.js");
    (queryDeepSeekBalance as any).mockResolvedValueOnce(null);

    const out = await deepseekProvider.fetch({} as any);
    expectNotAttempted(out);
  });

  it("maps balance infos into grouped value rows and structured metric facts", async () => {
    const { queryDeepSeekBalance } = await import("../src/lib/deepseek.js");
    (queryDeepSeekBalance as any).mockResolvedValueOnce({
      success: true,
      availability: "available",
      balanceInfos: [
        {
          currency: "USD",
          totalBalance: "12.34",
          grantedBalance: "2.00",
          toppedUpBalance: "10.34",
          totalBalanceAmount: 12.34,
        },
        {
          currency: "CNY",
          totalBalance: "88.00",
          grantedBalance: "0.00",
          toppedUpBalance: "88.00",
          totalBalanceAmount: 88,
        },
      ],
    });

    const out = await deepseekProvider.fetch({ config: { requestTimeoutMs: 9000 } } as any);
    expectAttemptedWithNoErrors(out);
    expect(queryDeepSeekBalance).toHaveBeenCalledWith({ requestTimeoutMs: 9000 });
    expect(visibleEntries(out.entries, "deepseek")).toEqual([
      {
        kind: "value",
        name: "DeepSeek Balance",
        group: "DeepSeek",
        label: "Balance:",
        value: "$12.34",
      },
      {
        kind: "value",
        name: "DeepSeek Balance",
        group: "DeepSeek",
        label: "Balance:",
        value: "¥88.00",
      },
    ]);
    // Structured balance + tri-state availability facts ride in rawDetails,
    // never in display text.
    expect(out.rawDetails).toEqual([
      { key: QUOTA_ALERT_METRIC_RAWDETAILS_KEY, value: '{"type":"balance","currency":"USD","amount":12.34}' },
      { key: QUOTA_ALERT_METRIC_RAWDETAILS_KEY, value: '{"type":"balance","currency":"CNY","amount":88}' },
      { key: QUOTA_ALERT_METRIC_RAWDETAILS_KEY, value: '{"type":"availability","status":"available"}' },
    ]);
  });

  it("omits the balance fact for malformed amounts while keeping the display row", async () => {
    const { queryDeepSeekBalance } = await import("../src/lib/deepseek.js");
    (queryDeepSeekBalance as any).mockResolvedValueOnce({
      success: true,
      availability: "available",
      balanceInfos: [
        {
          currency: "CNY",
          totalBalance: "0.00",
          grantedBalance: "0.00",
          toppedUpBalance: "0.00",
          totalBalanceAmount: null,
        },
      ],
    });

    const out = await deepseekProvider.fetch({ config: {} } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(1);
    expect(out.rawDetails).toEqual([
      { key: QUOTA_ALERT_METRIC_RAWDETAILS_KEY, value: '{"type":"availability","status":"available"}' },
    ]);
  });

  it("maps unavailable empty balance responses into a status row and an unavailable fact", async () => {
    const { queryDeepSeekBalance } = await import("../src/lib/deepseek.js");
    (queryDeepSeekBalance as any).mockResolvedValueOnce({
      success: true,
      availability: "unavailable",
      balanceInfos: [],
    });

    const out = await deepseekProvider.fetch({ config: {} } as any);
    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "deepseek")).toEqual([
      {
        kind: "value",
        name: "DeepSeek",
        group: "DeepSeek",
        label: "Status:",
        value: "Low balance",
      },
    ]);
    expect(out.rawDetails).toEqual([
      { key: QUOTA_ALERT_METRIC_RAWDETAILS_KEY, value: '{"type":"availability","status":"unavailable"}' },
    ]);
  });

  it("keeps a missing availability field as unknown, never as unavailable", async () => {
    const { queryDeepSeekBalance } = await import("../src/lib/deepseek.js");
    (queryDeepSeekBalance as any).mockResolvedValueOnce({
      success: true,
      availability: "unknown",
      balanceInfos: [],
    });

    const out = await deepseekProvider.fetch({ config: {} } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries[0]?.value).toBe("Unknown");
    expect(out.rawDetails).toEqual([
      { key: QUOTA_ALERT_METRIC_RAWDETAILS_KEY, value: '{"type":"availability","status":"unknown"}' },
    ]);
  });

  it("always carries the availability fact even when balance rows are shown", async () => {
    const { queryDeepSeekBalance } = await import("../src/lib/deepseek.js");
    (queryDeepSeekBalance as any).mockResolvedValueOnce({
      success: true,
      availability: "unavailable",
      balanceInfos: [
        {
          currency: "USD",
          totalBalance: "5.00",
          grantedBalance: "0.00",
          toppedUpBalance: "5.00",
          totalBalanceAmount: 5,
        },
      ],
    });

    const out = await deepseekProvider.fetch({ config: {} } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(1);
    expect(out.rawDetails).toContainEqual({
      key: QUOTA_ALERT_METRIC_RAWDETAILS_KEY,
      value: '{"type":"availability","status":"unavailable"}',
    });
  });

  it("maps errors into toast errors", async () => {
    const { queryDeepSeekBalance } = await import("../src/lib/deepseek.js");
    (queryDeepSeekBalance as any).mockResolvedValueOnce({
      success: false,
      error: "Unauthorized",
    });

    const out = await deepseekProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "DeepSeek");
  });

  it("matches DeepSeek model ids", () => {
    expect(deepseekProvider.matchesCurrentModel?.("deepseek/deepseek-chat")).toBe(true);
    expect(deepseekProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
  });

  it("is available when DeepSeek provider ids are reported by metadata", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    (isCanonicalProviderAvailable as any).mockResolvedValueOnce(true);

    await expect(deepseekProvider.isAvailable({} as any)).resolves.toBe(true);
    expect(isCanonicalProviderAvailable).toHaveBeenCalledWith({
      ctx: {},
      providerId: "deepseek",
      fallbackOnError: false,
    });
  });

  it("falls back to trusted API key presence when provider ids are absent", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    const { hasDeepSeekApiKeyConfigured } = await import("../src/lib/deepseek.js");
    (isCanonicalProviderAvailable as any).mockResolvedValueOnce(false);
    (hasDeepSeekApiKeyConfigured as any).mockResolvedValueOnce(true);

    await expect(deepseekProvider.isAvailable({} as any)).resolves.toBe(true);
  });

  it("is not available when provider ids are absent and no trusted API key exists", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    const { hasDeepSeekApiKeyConfigured } = await import("../src/lib/deepseek.js");
    (isCanonicalProviderAvailable as any).mockResolvedValueOnce(false);
    (hasDeepSeekApiKeyConfigured as any).mockResolvedValueOnce(false);

    await expect(deepseekProvider.isAvailable({} as any)).resolves.toBe(false);
  });
});
