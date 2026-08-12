import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { queryChutesQuota } from "../src/lib/chutes.js";
import { formatDeepSeekBalanceValue, queryDeepSeekBalance } from "../src/lib/deepseek.js";
import { queryNanoGptQuota } from "../src/lib/nanogpt.js";
import { resolveNanoGptApiKey } from "../src/lib/nanogpt-config.js";
import { querySyntheticQuota } from "../src/lib/synthetic.js";

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFile: vi.fn(async () => ({})),
  getAuthPaths: vi.fn(() => []),
}));

vi.mock("../src/lib/nanogpt-config.js", () => ({
  resolveNanoGptApiKey: vi.fn(),
  hasNanoGptApiKey: vi.fn(),
  getNanoGptKeyDiagnostics: vi.fn(),
}));

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function stubJsonFetch(body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(body)),
  );
}

function useNanoGptApiKey(): void {
  vi.mocked(resolveNanoGptApiKey).mockResolvedValueOnce({
    key: "nano-key",
    source: "env:NANOGPT_API_KEY",
  });
}

const syntheticPayload = (overrides: Record<string, unknown> = {}) => ({
  rollingFiveHourLimit: {
    max: 100,
    remaining: 74.5,
    nextTickAt: "2026-01-20T18:12:03.000Z",
  },
  weeklyTokenLimit: {
    maxCredits: "$24.00",
    remainingCredits: "$2.02",
    nextRegenAt: "2026-01-27T18:12:03.000Z",
    percentRemaining: 8.4552365,
  },
  ...overrides,
});

describe("simple API-key provider queries", () => {
  const originalEnv = process.env;
  let tempDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-provider-queries-"));
    process.env = {
      ...originalEnv,
      XDG_CONFIG_HOME: tempDir,
      XDG_DATA_HOME: tempDir,
      XDG_CACHE_HOME: tempDir,
      XDG_STATE_HOME: tempDir,
    };
    for (const name of ["CHUTES_API_KEY", "SYNTHETIC_API_KEY", "DEEPSEEK_API_KEY"]) {
      delete process.env[name];
    }
    vi.mocked(resolveNanoGptApiKey).mockReset().mockResolvedValue(null);
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    process.env = originalEnv;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.each([
    ["Chutes", queryChutesQuota],
    ["Synthetic", querySyntheticQuota],
    ["NanoGPT", queryNanoGptQuota],
    ["DeepSeek", queryDeepSeekBalance],
  ] as const)("returns null when %s is not configured", async (_name, query) => {
    await expect(query()).resolves.toBeNull();
  });

  it.each([
    ["Chutes", "CHUTES_API_KEY", queryChutesQuota, "Chutes API error 401: Unauthorized"],
    [
      "Synthetic",
      "SYNTHETIC_API_KEY",
      querySyntheticQuota,
      "Synthetic API error 401: Unauthorized",
    ],
    ["DeepSeek", "DEEPSEEK_API_KEY", queryDeepSeekBalance, "DeepSeek API error 401: Unauthorized"],
  ] as const)("sanitizes %s HTTP errors", async (_name, envName, query, error) => {
    process.env[envName] = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized\u001b[31m", { status: 401 })),
    );
    await expect(query()).resolves.toEqual({ success: false, error });
  });

  describe("Chutes", () => {
    it("maps quota data, reset time, endpoint, and authorization", async () => {
      process.env.CHUTES_API_KEY = "test-key";
      const fetchMock = vi.fn(async () => jsonResponse({ quota: 1000, used: 250 }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(queryChutesQuota()).resolves.toEqual({
        success: true,
        percentRemaining: 75,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.chutes.ai/users/me/quota_usage/me",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
        }),
      );
    });

    it("handles zero quota safely", async () => {
      process.env.CHUTES_API_KEY = "test-key";
      stubJsonFetch({ quota: 0, used: 0 });
      await expect(queryChutesQuota()).resolves.toMatchObject({
        success: true,
        percentRemaining: 0,
      });
    });
  });

  describe("Synthetic", () => {
    beforeEach(() => {
      process.env.SYNTHETIC_API_KEY = "test-key";
    });

    it("maps both top-level quota windows, endpoint, and authorization", async () => {
      const fetchMock = vi.fn(async () => jsonResponse(syntheticPayload()));
      vi.stubGlobal("fetch", fetchMock);

      await expect(querySyntheticQuota()).resolves.toEqual({
        success: true,
        windows: {
          fiveHour: {
            limit: 100,
            used: 25.5,
            percentRemaining: 75,
            resetTimeIso: "2026-01-20T18:12:03.000Z",
          },
          weekly: {
            limit: 24,
            used: 21.98,
            percentRemaining: 8,
            resetTimeIso: "2026-01-27T18:12:03.000Z",
          },
        },
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.synthetic.new/v2/quotas",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
        }),
      );
    });

    it.each([
      "bad-value",
      -5,
      150,
    ] as const)("derives weekly percent when percentRemaining is invalid (%s)", async (percentRemaining) => {
      stubJsonFetch(
        syntheticPayload({
          weeklyTokenLimit: {
            maxCredits: "$24.00",
            remainingCredits: "$2.02",
            percentRemaining,
          },
        }),
      );
      const result = await querySyntheticQuota();
      expect(result && result.success ? result.windows.weekly.percentRemaining : -1).toBe(8);
    });

    it("normalizes valid reset timestamps and drops malformed ones", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(jsonResponse(syntheticPayload()))
          .mockResolvedValueOnce(
            jsonResponse(
              syntheticPayload({
                rollingFiveHourLimit: { max: 100, remaining: 74.5, nextTickAt: "\u001b[31mbad" },
                weeklyTokenLimit: {
                  maxCredits: "$24.00",
                  remainingCredits: "$2.02",
                  nextRegenAt: "\u001b[31mbad",
                  percentRemaining: 8.4552365,
                },
              }),
            ),
          ),
      );

      const valid = await querySyntheticQuota();
      const invalid = await querySyntheticQuota();
      expect(valid && valid.success ? valid.windows.fiveHour.resetTimeIso : undefined).toBe(
        "2026-01-20T18:12:03.000Z",
      );
      expect(valid && valid.success ? valid.windows.weekly.resetTimeIso : undefined).toBe(
        "2026-01-27T18:12:03.000Z",
      );
      expect(
        invalid && invalid.success ? invalid.windows.fiveHour.resetTimeIso : "missing",
      ).toBeUndefined();
      expect(
        invalid && invalid.success ? invalid.windows.weekly.resetTimeIso : "missing",
      ).toBeUndefined();
    });

    it("reports zero percent when both top-level windows are exhausted", async () => {
      stubJsonFetch(
        syntheticPayload({
          rollingFiveHourLimit: { max: 100, remaining: 0 },
          weeklyTokenLimit: {
            maxCredits: "$24.00",
            remainingCredits: "$0.00",
            percentRemaining: 0,
          },
        }),
      );
      const result = await querySyntheticQuota();
      expect(result && result.success ? result.windows : null).toMatchObject({
        fiveHour: { used: 100, percentRemaining: 0 },
        weekly: { used: 24, percentRemaining: 0 },
      });
    });

    it("accepts the real weekly shape and ignores legacy subscription fields", async () => {
      stubJsonFetch(
        syntheticPayload({
          rollingFiveHourLimit: {
            max: 1350,
            remaining: 1195.5,
            nextTickAt: "2026-02-06T16:16:18.386Z",
          },
          weeklyTokenLimit: {
            maxCredits: "$24.00",
            remainingCredits: "$2.02",
            nextRegenAt: "2026-02-10T00:00:00.000Z",
            percentRemaining: 8.4552365,
          },
          freeToolCalls: { max: 250, remaining: 220 },
          subscription: { limit: 10, requests: 9, renewsAt: "2027-01-01T00:00:00.000Z" },
        }),
      );
      const result = await querySyntheticQuota();
      expect(result && result.success ? result.windows : null).toEqual({
        fiveHour: {
          limit: 1350,
          used: 154.5,
          percentRemaining: 89,
          resetTimeIso: "2026-02-06T16:16:18.386Z",
        },
        weekly: {
          limit: 24,
          used: 21.98,
          percentRemaining: 8,
          resetTimeIso: "2026-02-10T00:00:00.000Z",
        },
      });
    });

    it.each([
      [
        "malformed rollingFiveHourLimit payloads",
        syntheticPayload({ rollingFiveHourLimit: { max: "1350", remaining: "20" } }),
        "Synthetic API response missing rollingFiveHourLimit quota window",
      ],
      [
        "malformed weeklyTokenLimit credit strings",
        syntheticPayload({
          weeklyTokenLimit: {
            maxCredits: "24.00",
            remainingCredits: "$2.02",
            percentRemaining: 8,
          },
        }),
        "Synthetic API response missing weeklyTokenLimit quota window",
      ],
      [
        "a missing weekly top-level window",
        (() => {
          const { weeklyTokenLimit: _weekly, ...payload } = syntheticPayload();
          return payload;
        })(),
        "Synthetic API response missing weeklyTokenLimit quota window",
      ],
      [
        "legacy subscription-only payloads",
        { subscription: { limit: 200, requests: 50 } },
        "Synthetic API response missing rollingFiveHourLimit quota window",
      ],
    ] as const)("rejects %s", async (_name, payload, error) => {
      stubJsonFetch(payload);
      await expect(querySyntheticQuota()).resolves.toEqual({ success: false, error });
    });
  });

  describe("NanoGPT", () => {
    it("maps usage and balance from both authenticated endpoints", async () => {
      useNanoGptApiKey();
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/subscription/v1/usage")) {
          expect(init).toMatchObject({ method: "GET" });
          expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("nano-key");
          return jsonResponse({
            active: true,
            limits: { daily: 5000, monthly: 60000 },
            enforceDailyLimit: true,
            daily: { used: 50, remaining: 4950, percentUsed: 0.01, resetAt: 1_738_540_800_000 },
            monthly: {
              used: 1000,
              remaining: 59000,
              percentUsed: 0.0167,
              resetAt: 1_739_404_800_000,
            },
            period: { currentPeriodEnd: "2025-02-13T23:59:59.000Z" },
            state: "active",
            graceUntil: null,
          });
        }
        expect(init).toMatchObject({ method: "POST" });
        expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("nano-key");
        return jsonResponse({ usd_balance: "129.46956147", nano_balance: "26.71801147" });
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(queryNanoGptQuota()).resolves.toEqual({
        success: true,
        subscription: {
          active: true,
          state: "active",
          enforceDailyLimit: true,
          daily: {
            used: 50,
            limit: 5000,
            remaining: 4950,
            percentRemaining: 99,
            resetTimeIso: "2025-02-03T00:00:00.000Z",
          },
          monthly: {
            used: 1000,
            limit: 60000,
            remaining: 59000,
            percentRemaining: 98,
            resetTimeIso: "2025-02-13T00:00:00.000Z",
          },
          currentPeriodEndIso: "2025-02-13T23:59:59.000Z",
          graceUntilIso: undefined,
        },
        balance: {
          usdBalance: 129.46956147,
          usdBalanceRaw: "129.46956147",
          nanoBalanceRaw: "26.71801147",
        },
        endpointErrors: undefined,
      });
    });

    it("returns partial success when usage succeeds and balance fails", async () => {
      useNanoGptApiKey();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) =>
          String(input).includes("/subscription/v1/usage")
            ? jsonResponse({
                active: false,
                limits: { daily: 100, monthly: 1000 },
                enforceDailyLimit: true,
                daily: { used: 100, remaining: 0, percentUsed: 1, resetAt: 1_735_776_000_000 },
                state: "grace",
                graceUntil: "2026-01-09T00:00:00.000Z",
              })
            : new Response("Unauthorized", { status: 401 }),
        ),
      );
      await expect(queryNanoGptQuota()).resolves.toMatchObject({
        success: true,
        subscription: { active: false, state: "grace", daily: { percentRemaining: 0 } },
        balance: undefined,
        endpointErrors: [{ endpoint: "balance", message: "NanoGPT API error 401: Unauthorized" }],
      });
    });

    it("returns partial success when balance succeeds and usage fails", async () => {
      useNanoGptApiKey();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) =>
          String(input).includes("/subscription/v1/usage")
            ? new Response("bad gateway", { status: 502 })
            : jsonResponse({ usd_balance: "12.50", nano_balance: "3.25" }),
        ),
      );
      await expect(queryNanoGptQuota()).resolves.toEqual({
        success: true,
        subscription: undefined,
        balance: { usdBalance: 12.5, usdBalanceRaw: "12.50", nanoBalanceRaw: "3.25" },
        endpointErrors: [{ endpoint: "usage", message: "NanoGPT API error 502: bad gateway" }],
      });
    });

    it("returns a combined error when both endpoints fail", async () => {
      useNanoGptApiKey();
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async (input: RequestInfo | URL) =>
            new Response(String(input).includes("/usage") ? "usage failed" : "balance failed", {
              status: String(input).includes("/usage") ? 500 : 403,
            }),
        ),
      );
      await expect(queryNanoGptQuota()).resolves.toEqual({
        success: false,
        error:
          "Usage: NanoGPT API error 500: usage failed; Balance: NanoGPT API error 403: balance failed",
      });
    });

    it("treats unexpected response shapes as endpoint errors", async () => {
      useNanoGptApiKey();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) =>
          String(input).includes("/usage")
            ? jsonResponse({ nope: true })
            : jsonResponse({ usd_balance: "5.00" }),
        ),
      );
      await expect(queryNanoGptQuota()).resolves.toEqual({
        success: true,
        subscription: undefined,
        balance: { usdBalance: 5, usdBalanceRaw: "5.00", nanoBalanceRaw: undefined },
        endpointErrors: [
          {
            endpoint: "usage",
            message: "NanoGPT usage response returned an unexpected response shape",
          },
        ],
      });
    });

    it("returns caught transport errors without leaking request data", async () => {
      useNanoGptApiKey();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Promise.reject(new Error("network down"))),
      );
      await expect(queryNanoGptQuota()).resolves.toEqual({
        success: false,
        error: "Usage: network down; Balance: network down",
      });
    });
  });

  describe("DeepSeek", () => {
    beforeEach(() => {
      process.env.DEEPSEEK_API_KEY = "test-key";
    });

    it("maps balance data, supported headers, endpoint, and timeout signal", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({
          is_available: true,
          balance_infos: [
            {
              currency: "USD",
              total_balance: "12.34",
              granted_balance: "2.00",
              topped_up_balance: "10.34",
            },
          ],
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(queryDeepSeekBalance({ requestTimeoutMs: 1234 })).resolves.toEqual({
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
        ],
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.deepseek.com/user/balance",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: "Bearer test-key",
            "User-Agent": "OpenCode-Quota-Toast/1.0",
          }),
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it("normalizes malformed balance strings without producing alertable amounts", async () => {
      stubJsonFetch({
        is_available: true,
        balance_infos: [
          {
            currency: "USD",
            total_balance: "12.34\u001b[31m",
            granted_balance: "1.2345678901234567890",
            topped_up_balance: "not-a-number",
          },
        ],
      });
      const result = await queryDeepSeekBalance();
      expect(result && result.success ? result.balanceInfos : []).toEqual([
        {
          currency: "USD",
          totalBalance: "0.00",
          grantedBalance: "0.00",
          toppedUpBalance: "0.00",
          totalBalanceAmount: null,
        },
      ]);
    });

    it("filters unsupported currencies and preserves CNY balances with structured amounts", async () => {
      stubJsonFetch({
        is_available: false,
        balance_infos: [
          { currency: "EUR", total_balance: "9.99" },
          { currency: "cny", total_balance: "88.00" },
        ],
      });
      const result = await queryDeepSeekBalance();
      expect(result && result.success ? result.balanceInfos : []).toEqual([
        {
          currency: "CNY",
          totalBalance: "88.00",
          grantedBalance: "0.00",
          toppedUpBalance: "0.00",
          totalBalanceAmount: 88,
        },
      ]);
      expect(result && result.success ? result.availability : undefined).toBe("unavailable");
    });

    it("keeps a missing is_available field as unknown instead of unavailable", async () => {
      stubJsonFetch({
        balance_infos: [
          { currency: "USD", total_balance: "3.00", granted_balance: "0.00", topped_up_balance: "3.00" },
        ],
      });
      const result = await queryDeepSeekBalance();
      expect(result && result.success ? result.availability : undefined).toBe("unknown");
    });

    it("reports unexpected response shapes as sanitized errors", async () => {
      stubJsonFetch([]);
      await expect(queryDeepSeekBalance()).resolves.toEqual({
        success: false,
        error: "DeepSeek balance response returned an unexpected response shape",
      });
    });

    it("formats USD and CNY balances", () => {
      expect(formatDeepSeekBalanceValue({ currency: "USD", totalBalance: "12.34" })).toBe("$12.34");
      expect(formatDeepSeekBalanceValue({ currency: "CNY", totalBalance: "88.00" })).toBe("¥88.00");
    });
  });
});
