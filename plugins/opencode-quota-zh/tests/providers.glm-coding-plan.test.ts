import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

const mocks = vi.hoisted(() => ({
  queryZaiQuota: vi.fn(),
  queryZhipuQuota: vi.fn(),
  resolveZaiAuthCached: vi.fn(),
  resolveZhipuAuthCached: vi.fn(),
}));

vi.mock("../src/lib/zai.js", () => ({ queryZaiQuota: mocks.queryZaiQuota }));
vi.mock("../src/lib/zhipu.js", () => ({ queryZhipuQuota: mocks.queryZhipuQuota }));
vi.mock("../src/lib/zai-auth.js", () => ({
  DEFAULT_ZAI_AUTH_CACHE_MAX_AGE_MS: 5_000,
  resolveZaiAuthCached: mocks.resolveZaiAuthCached,
  getZaiAuthDiagnostics: vi.fn(async () => ({
    state: "none",
    source: null,
    checkedPaths: [],
    authPaths: [],
  })),
}));
vi.mock("../src/lib/zhipu-auth.js", () => ({
  DEFAULT_ZHIPU_AUTH_CACHE_MAX_AGE_MS: 5_000,
  resolveZhipuAuthCached: mocks.resolveZhipuAuthCached,
  getZhipuAuthDiagnostics: vi.fn(async () => ({
    state: "none",
    source: null,
    checkedPaths: [],
    authPaths: [],
  })),
}));

import { zaiProvider } from "../src/providers/zai.js";
import { zhipuProvider } from "../src/providers/zhipu.js";

const PROVIDERS = [
  {
    id: "zai",
    label: "Z.ai",
    provider: zaiProvider,
    query: mocks.queryZaiQuota,
    resolveAuth: mocks.resolveZaiAuthCached,
    providerIds: ["zai", "glm", "zai-coding-plan"],
    matchingModels: ["zai/glm-4.5", "glm/glm-4.5", "anthropic/glm-4"],
    nonMatchingModels: ["openai/gpt-5"],
  },
  {
    id: "zhipu",
    label: "Zhipu",
    provider: zhipuProvider,
    query: mocks.queryZhipuQuota,
    resolveAuth: mocks.resolveZhipuAuthCached,
    providerIds: ["zhipu", "zhipu-coding-plan", "glm-coding-plan"],
    matchingModels: ["zhipu/glm-4.5", "zhipu-coding-plan/glm-4.5", "glm-coding-plan/glm-4.5"],
    nonMatchingModels: ["zai/glm-4.5", "glm/glm-4.5", "openai/gpt-5"],
  },
] as const;

describe.each(PROVIDERS)("$label GLM provider", (descriptor) => {
  beforeEach(() => {
    vi.clearAllMocks();
    descriptor.resolveAuth.mockResolvedValue({
      state: "configured",
      apiKey: `${descriptor.id}-test-key`,
    });
  });

  it("returns attempted:false when not configured", async () => {
    descriptor.query.mockResolvedValueOnce(null);
    expectNotAttempted(await descriptor.provider.fetch({} as any));
  });

  it("maps success into grouped entries and single-window metadata", async () => {
    descriptor.query.mockResolvedValueOnce({
      success: true,
      label: descriptor.label,
      windows: {
        fiveHour: { percentRemaining: 80, resetTimeIso: "2026-01-01T00:00:00.000Z" },
        weekly: { percentRemaining: 30, resetTimeIso: "2026-01-02T00:00:00.000Z" },
        mcp: { percentRemaining: 90, resetTimeIso: "2026-01-03T00:00:00.000Z" },
      },
    });

    const out = await descriptor.provider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, descriptor.id)).toEqual([
      {
        name: `${descriptor.label} 5h`,
        group: descriptor.label,
        label: "5h:",
        percentRemaining: 80,
        resetTimeIso: "2026-01-01T00:00:00.000Z",
      },
      {
        name: `${descriptor.label} Weekly`,
        group: descriptor.label,
        label: "Weekly:",
        percentRemaining: 30,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
      },
      {
        name: `${descriptor.label} MCP`,
        group: descriptor.label,
        label: "MCP:",
        percentRemaining: 90,
        resetTimeIso: "2026-01-03T00:00:00.000Z",
      },
    ]);
    expect(out.presentation).toEqual({ singleWindowDisplayName: descriptor.label });
  });

  it("maps query errors into toast errors", async () => {
    descriptor.query.mockResolvedValueOnce({ success: false, error: "Unauthorized" });
    expectAttemptedWithErrorLabel(await descriptor.provider.fetch({} as any), descriptor.label);
  });

  it("keeps provider-specific model matching", () => {
    for (const model of descriptor.matchingModels) {
      expect(descriptor.provider.matchesCurrentModel?.(model), model).toBe(true);
    }
    for (const model of descriptor.nonMatchingModels) {
      expect(descriptor.provider.matchesCurrentModel?.(model), model).toBe(false);
    }
  });

  it("is available for every provider alias when auth is configured", async () => {
    for (const providerId of descriptor.providerIds) {
      await expect(
        descriptor.provider.isAvailable(
          createProviderAvailabilityContext({ providerIds: [providerId] }),
        ),
      ).resolves.toBe(true);
    }
    await expect(
      descriptor.provider.isAvailable(
        createProviderAvailabilityContext({ providerIds: ["openai"] }),
      ),
    ).resolves.toBe(false);
  });

  it("is available when auth is invalid so fetch can surface the error", async () => {
    descriptor.resolveAuth.mockResolvedValueOnce({
      state: "invalid",
      error: `Unsupported ${descriptor.label} auth type: "oauth"`,
    });
    await expect(
      descriptor.provider.isAvailable(
        createProviderAvailabilityContext({ providerIds: [descriptor.id] }),
      ),
    ).resolves.toBe(true);
    expect(descriptor.resolveAuth).toHaveBeenCalledWith({ maxAgeMs: 5_000 });
  });

  it("is unavailable when auth is missing", async () => {
    descriptor.resolveAuth.mockResolvedValueOnce({ state: "none" });
    await expect(
      descriptor.provider.isAvailable(
        createProviderAvailabilityContext({ providerIds: [descriptor.id] }),
      ),
    ).resolves.toBe(false);
    expect(descriptor.resolveAuth).toHaveBeenCalledWith({ maxAgeMs: 5_000 });
  });

  it("fails closed before auth resolution when provider lookup throws", async () => {
    await expect(
      descriptor.provider.isAvailable(
        createProviderAvailabilityContext({ providersError: new Error("boom") }),
      ),
    ).resolves.toBe(false);
    expect(descriptor.resolveAuth).not.toHaveBeenCalled();
  });
});
