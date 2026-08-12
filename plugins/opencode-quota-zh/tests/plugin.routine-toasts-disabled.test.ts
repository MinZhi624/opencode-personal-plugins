/**
 * Ticket 07: routine quota toasts are disabled for idle, question completion
 * and compaction in visible behavior. The old toast path may remain in the
 * bundle as dead code until Ticket 13 removes the contract, but ordinary
 * session lifecycle events must never reach the TUI toast API.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createConfigModuleMock,
  createPluginTestClient as createClient,
  createPluginToolMockModule,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  seedDefaultPluginBootstrapMocks,
} from "./helpers/plugin-test-harness.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getProviders: vi.fn(),
  getPricingSnapshotMeta: vi.fn(),
  getPricingSnapshotSource: vi.fn(),
  getRuntimePricingRefreshStatePath: vi.fn(),
  getRuntimePricingSnapshotPath: vi.fn(),
  maybeRefreshPricingSnapshot: vi.fn(),
  setPricingSnapshotAutoRefresh: vi.fn(),
  setPricingSnapshotSelection: vi.fn(),
}));

vi.mock("@opencode-ai/plugin", () => createPluginToolMockModule());
vi.mock("../src/lib/config.js", () => createConfigModuleMock(mocks.loadConfig));
vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);
vi.mock("../src/lib/modelsdev-pricing.js", () => createPricingModuleMock(mocks));

describe("routine quota toast suppression (Ticket 07)", () => {
  beforeEach(() => {
    seedDefaultPluginBootstrapMocks(mocks, {
      // Even the legacy trigger fields being on must not resurrect routine
      // toasts: the v2 model has no routine-toast lifecycle triggers.
      configOverrides: { enabled: true, showOnIdle: true, showOnQuestion: true, showOnCompact: true },
      providers: [
        {
          id: "deepseek",
          isAvailable: vi.fn().mockResolvedValue(true),
          fetch: vi.fn().mockResolvedValue({
            attempted: true,
            entries: [],
            errors: [],
          }),
        },
      ],
    });
  });

  async function loadPluginHooks() {
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);
    return { client, hooks };
  }

  it("does not show a quota toast on session.idle", async () => {
    const { client, hooks } = await loadPluginHooks();

    await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "session-1" } } });

    expect(client.tui.showToast).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
    const provider = mocks.getProviders()[0] as { fetch: ReturnType<typeof vi.fn> };
    expect(provider.fetch).not.toHaveBeenCalled();
  });

  it("does not show a quota toast on session.compacted", async () => {
    const { client, hooks } = await loadPluginHooks();

    await hooks.event?.({
      event: { type: "session.compacted", properties: { sessionID: "session-2" } },
    });

    expect(client.tui.showToast).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it("does not show a quota toast after the question tool completes", async () => {
    const { client, hooks } = await loadPluginHooks();

    await hooks["tool.execute.after"]?.(
      { tool: "question", sessionID: "session-3", callID: "call-1" },
      { title: "Question", output: "ok", metadata: { status: "success" } },
    );

    expect(client.tui.showToast).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
    expect(mocks.getProviders()[0].fetch).not.toHaveBeenCalled();
  });

  it("keeps unrelated events and tools untouched", async () => {
    const { client, hooks } = await loadPluginHooks();

    await hooks.event?.({ event: { type: "session.updated", properties: { sessionID: "session-4" } } });
    await hooks["tool.execute.after"]?.(
      { tool: "bash", sessionID: "session-4", callID: "call-2" },
      { title: "Bash", output: "ok", metadata: {} },
    );

    expect(client.tui.showToast).not.toHaveBeenCalled();
    expect(mocks.getProviders()[0].fetch).not.toHaveBeenCalled();
  });
});
