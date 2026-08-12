import { rm } from "fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAlibabaAuthModuleMock,
  createConfigModuleMock,
  createPluginRuntimePathsMockModule,
  createPluginTestClient as createClient,
  createPluginToolMockModule,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  createQwenAuthModuleMock,
  seedDefaultPluginBootstrapMocks,
} from "./helpers/plugin-test-harness.js";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-plugin-announcements-tests";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getProviders: vi.fn(),
  maybeRefreshPricingSnapshot: vi.fn(),
  getPricingSnapshotMeta: vi.fn(),
  getPricingSnapshotSource: vi.fn(),
  getRuntimePricingRefreshStatePath: vi.fn(),
  getRuntimePricingSnapshotPath: vi.fn(),
  setPricingSnapshotAutoRefresh: vi.fn(),
  setPricingSnapshotSelection: vi.fn(),
  resolveQwenLocalPlanCached: vi.fn(),
  resolveAlibabaCodingPlanAuthCached: vi.fn(),
}));

vi.mock("@opencode-ai/plugin", () => createPluginToolMockModule());
vi.mock("../src/lib/config.js", () => createConfigModuleMock(mocks.loadConfig));
vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);
vi.mock("../src/lib/modelsdev-pricing.js", () => createPricingModuleMock(mocks));
vi.mock("../src/lib/qwen-auth.js", () =>
  createQwenAuthModuleMock(mocks.resolveQwenLocalPlanCached),
);
vi.mock("../src/lib/alibaba-auth.js", () =>
  createAlibabaAuthModuleMock(mocks.resolveAlibabaCodingPlanAuthCached),
);
vi.mock("../src/lib/opencode-runtime-paths.js", () =>
  createPluginRuntimePathsMockModule(TEST_RUNTIME_ROOT, { includeCandidates: true }),
);

describe("maintainer announcement plugin integration", () => {
  beforeEach(async () => {
    seedDefaultPluginBootstrapMocks(mocks, {
      configOverrides: {
        enabled: true,
        enableToast: true,
        showOnIdle: false,
        showOnQuestion: false,
        showOnCompact: false,
        maintainerAnnouncements: {
          enabled: true,
          home: true,
        },
      },
      resetPluginState: true,
    });
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("keeps /quota_announcements out of the v1.0.1 command surface", async () => {
    const provider = {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(),
    };
    mocks.getProviders.mockReturnValue([provider]);

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const { QUOTA_DIALOG_COMMANDS } = await import("../src/lib/quota-dialog-commands.js");
    expect(QUOTA_DIALOG_COMMANDS.some((command) => command.id === "quota_announcements")).toBe(
      false,
    );

    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);
    const cfg: any = {};

    await hooks.config?.(cfg);
    expect(cfg.command?.quota_announcements).toBeUndefined();
    expect(provider.isAvailable).not.toHaveBeenCalled();
  });

  it("does not expose /quota_announcements even when the provider is unavailable", async () => {
    const provider = {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(false),
      fetch: vi.fn(),
    };
    mocks.getProviders.mockReturnValue([provider]);

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);
    const cfg: any = {};
    await hooks.config?.(cfg);

    expect(cfg.command?.quota_announcements).toBeUndefined();
    // The v1.0.1 runtime keeps announcement evaluation and diagnostics, but
    // there is no announcement dialog command.
    expect(provider.isAvailable).not.toHaveBeenCalled();
  });

  it("keeps the announcement dialog unregistered when no active announcements exist", async () => {
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const { QUOTA_DIALOG_COMMANDS } = await import("../src/lib/quota-dialog-commands.js");
    expect(QUOTA_DIALOG_COMMANDS.some((command) => command.id === "quota_announcements")).toBe(
      false,
    );

    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);
    const cfg: any = {};
    await hooks.config?.(cfg);
    expect(cfg.command?.quota_announcements).toBeUndefined();
  });

  it("never routes /quota_announcements arguments (command removed in v1.0.1)", async () => {
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);
    const cfg: any = {};
    await hooks.config?.(cfg);

    expect(cfg.command?.quota_announcements).toBeUndefined();
    expect(Object.keys(cfg.command ?? {})).not.toContain("quota_announcements");
  });
});
