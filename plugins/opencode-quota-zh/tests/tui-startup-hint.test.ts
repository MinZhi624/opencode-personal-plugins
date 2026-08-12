/**
 * Ticket 07: thin startup-hint integration tests for the TUI home surface.
 *
 * loadTuiStartupHint reuses the resolved runtime context and the shared quota
 * render pipeline, then feeds the pure projection seam with an injected clock.
 * These tests mock only the I/O boundary (collectQuotaRenderData) and assert
 * the user-visible startup hint state, never private helpers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CollectQuotaRenderDataResult } from "../src/lib/quota-render-data.js";
import type { QuotaProviderResult } from "../src/lib/entries.js";
import type { TuiInitialRuntimeSeed } from "../src/lib/tui-runtime.js";
import { makeQuotaToastTestConfig } from "./helpers/plugin-test-harness.js";

const { collectQuotaRenderData } = vi.hoisted(() => ({
  collectQuotaRenderData: vi.fn(),
}));

vi.mock("../src/lib/quota-render-data.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/quota-render-data.js")>(
    "../src/lib/quota-render-data.js",
  );
  return {
    ...actual,
    collectQuotaRenderData,
  };
});

import { loadTuiStartupHint } from "../src/lib/tui-runtime.js";

const FIXED_NOW_MS = Date.UTC(2026, 7, 11, 0, 0, 0);

const FRESH_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

function providerResult(percentRemaining: number): QuotaProviderResult {
  return {
    attempted: true,
    entries: [
      {
        accounting: FRESH_ACCOUNTING,
        name: "DeepSeek",
        percentRemaining,
        resetTimeIso: "2026-08-11T02:00:00.000Z",
      },
    ],
    errors: [],
  };
}

function providerFixture(id: string) {
  return { id, isAvailable: vi.fn(), fetch: vi.fn() };
}

function createApi() {
  return {
    state: {
      path: { worktree: "/tmp/worktree", directory: "/tmp/worktree" },
    },
    client: {
      config: {
        providers: vi.fn().mockResolvedValue({ data: { providers: [] } }),
        get: vi.fn().mockResolvedValue({ data: {} }),
      },
    },
  };
}

function createSeed(): TuiInitialRuntimeSeed {
  const config = makeQuotaToastTestConfig({
    enabled: true,
    onlyCurrentModel: false,
    showSessionTokens: false,
    minIntervalMs: 60_000,
  });
  return {
    roots: {
      workspaceRoot: "/tmp/worktree",
      configRoot: "/tmp/worktree",
      fallbackDirectory: "/tmp/worktree",
    },
    config,
    configMeta: {
      source: "defaults",
      paths: [],
      globalConfigPaths: [],
      workspaceConfigPaths: [],
      settingSources: {},
      networkSettingSources: {},
      configIssues: [],
    },
    providers: [providerFixture("deepseek")],
  };
}

function renderDataResult(
  overrides: Partial<CollectQuotaRenderDataResult> = {},
): CollectQuotaRenderDataResult {
  return {
    selection: {
      isAutoMode: true,
      providers: [providerFixture("deepseek")],
      filtered: [providerFixture("deepseek")],
      ctx: { config: { enabledProviders: "auto" } } as never,
    },
    availability: [{ provider: providerFixture("deepseek"), ok: true }],
    active: [providerFixture("deepseek")],
    attemptedAny: true,
    hasExplicitProviderIssues: false,
    data: { entries: [], errors: [] },
    // Raw provider results aligned with `active`.
    results: [providerResult(12)],
    ...overrides,
  };
}

describe("loadTuiStartupHint (thin startup integration)", () => {
  beforeEach(() => {
    collectQuotaRenderData.mockReset();
  });

  it("renders a ready hint for a healthy snapshot with provider count and /quota guidance", async () => {
    collectQuotaRenderData.mockResolvedValue(renderDataResult());

    const hint = await loadTuiStartupHint({
      api: createApi() as never,
      nowMs: FIXED_NOW_MS,
      initialRuntimeSeed: createSeed(),
    });

    expect(hint.status).toBe("ready");
    expect(hint.status === "ready" ? hint.text : "").toContain("整体正常");
    expect(hint.status === "ready" ? hint.text : "").toContain("DeepSeek 12% 剩余");
    expect(hint.status === "ready" ? hint.text : "").toContain("1 个 Provider");
    expect(hint.status === "ready" ? hint.text : "").toContain("/quota");
    expect(collectQuotaRenderData).toHaveBeenCalledOnce();
  });

  it("shows a passive unknown diagnostic when every provider failed", async () => {
    const provider = providerFixture("deepseek");
    collectQuotaRenderData.mockResolvedValue(
      renderDataResult({
        availability: [{ provider, ok: true }],
        active: [provider],
        results: [
          {
            attempted: true,
            entries: [],
            errors: [{ label: "DeepSeek", message: "Failed to read quota data" }],
          },
        ],
      }),
    );

    const hint = await loadTuiStartupHint({
      api: createApi() as never,
      nowMs: FIXED_NOW_MS,
      initialRuntimeSeed: createSeed(),
    });

    expect(hint.status).toBe("ready");
    expect(hint.status === "ready" ? hint.text : "").toContain("额度状态未知");
    expect(hint.status === "ready" ? hint.text : "").toContain("/quota");
    expect(hint.status === "ready" ? hint.text : "").not.toMatch(/%\s*剩余/);
  });

  it("renders nothing when no provider is monitored", async () => {
    collectQuotaRenderData.mockResolvedValue(
      renderDataResult({
        selection: null,
        availability: [],
        active: [],
        attemptedAny: false,
      }),
    );

    const hint = await loadTuiStartupHint({
      api: createApi() as never,
      nowMs: FIXED_NOW_MS,
      initialRuntimeSeed: createSeed(),
    });

    expect(hint).toEqual({ status: "disabled" });
  });

  it("renders nothing when the startup hint is disabled in config", async () => {
    const seed = {
      ...createSeed(),
      config: makeQuotaToastTestConfig({ enabled: true, startupHint: { enabled: false } }),
    };

    const hint = await loadTuiStartupHint({
      api: createApi() as never,
      nowMs: FIXED_NOW_MS,
      initialRuntimeSeed: seed,
    });

    expect(hint).toEqual({ status: "disabled" });
    expect(collectQuotaRenderData).not.toHaveBeenCalled();
  });
});
