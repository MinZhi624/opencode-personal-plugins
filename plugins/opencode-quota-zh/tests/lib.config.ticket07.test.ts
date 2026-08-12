/**
 * Ticket 07: canonical v2 configuration contract — startupHint / promptBar /
 * alerts sections with strict validation, plus migration diagnostics for old
 * toast fields and legacy entrypoints (never silently accepted).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ConfigLoaderWorkspace,
  createConfigLoaderWorkspace,
  createEmptyRuntimeDirCandidates,
} from "./helpers/config-loader-test-harness.js";

const runtimeDirs = vi.hoisted(() => ({
  value: {
    dataDirs: [] as string[],
    configDirs: [] as string[],
    cacheDirs: [] as string[],
    stateDirs: [] as string[],
  },
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => runtimeDirs.value,
}));

import { createLoadConfigMeta, loadConfig } from "../src/lib/config.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";

describe("Ticket 07 canonical config contract", () => {
  let workspace: ConfigLoaderWorkspace;
  let isolatedCwd: string;
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    savedConfigDir = process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OPENCODE_CONFIG_DIR;
    workspace = createConfigLoaderWorkspace("opencode-quota-ticket07-");
    isolatedCwd = workspace.workspaceDir;
    runtimeDirs.value = createEmptyRuntimeDirCandidates();
  });

  afterEach(() => {
    if (savedConfigDir !== undefined) process.env.OPENCODE_CONFIG_DIR = savedConfigDir;
    else delete process.env.OPENCODE_CONFIG_DIR;
    workspace.cleanup();
  });

  async function loadSdkConfig(
    quotaToast: Record<string, unknown>,
    meta = createLoadConfigMeta(),
  ) {
    const config = await loadConfig(
      {
        config: {
          get: async () => ({
            data: {
              experimental: {
                quotaToast,
              },
            },
          }),
        },
      },
      meta,
      { cwd: isolatedCwd },
    );

    return { config, meta };
  }

  it("defaults the canonical sections and keeps the prompt bar off", async () => {
    const { config } = await loadSdkConfig({});

    expect(config.startupHint).toEqual({ enabled: true });
    expect(config.startupHint).not.toBe(DEFAULT_CONFIG.startupHint);
    expect(config.promptBar).toEqual({ enabled: false });
    expect(config.promptBar).not.toBe(DEFAULT_CONFIG.promptBar);
    expect(config.alerts).toEqual({
      enabled: true,
      percentRemainingThreshold: 0,
      repeatAfterMinutes: null,
      balanceThresholds: {},
    });
    expect(config.alerts).not.toBe(DEFAULT_CONFIG.alerts);
    // Wave A compat mirror stays in sync with the canonical section.
    expect(config.tuiPromptBar).toEqual(config.promptBar);
    expect(config.tuiPromptBar).not.toBe(config.promptBar);
  });

  it("accepts validated canonical overrides with provenance", async () => {
    const { config, meta } = await loadSdkConfig({
      startupHint: { enabled: false },
      promptBar: { enabled: true },
      alerts: {
        enabled: false,
        percentRemainingThreshold: 10,
        repeatAfterMinutes: 30,
        balanceThresholds: {
          deepseek: { CNY: 2, USD: 0.5 },
        },
      },
    });

    expect(config.startupHint).toEqual({ enabled: false });
    expect(config.promptBar).toEqual({ enabled: true });
    expect(config.tuiPromptBar).toEqual({ enabled: true });
    expect(config.alerts).toEqual({
      enabled: false,
      percentRemainingThreshold: 10,
      repeatAfterMinutes: 30,
      balanceThresholds: { deepseek: { CNY: 2, USD: 0.5 } },
    });
    expect(meta.settingSources).toEqual({
      "startupHint.enabled": "client.config.get",
      "promptBar.enabled": "client.config.get",
      "alerts.enabled": "client.config.get",
      "alerts.percentRemainingThreshold": "client.config.get",
      "alerts.repeatAfterMinutes": "client.config.get",
      "alerts.balanceThresholds": "client.config.get",
    });
    expect(meta.configIssues).toEqual([]);
  });

  it("strictly rejects invalid startupHint and promptBar values", async () => {
    const { config, meta } = await loadSdkConfig({
      startupHint: { enabled: "yes" },
      promptBar: { enabled: 1 },
    });

    expect(config.startupHint).toEqual({ enabled: true });
    expect(config.promptBar).toEqual({ enabled: false });
    expect(config.tuiPromptBar).toEqual({ enabled: false });
    expect(meta.settingSources).toEqual({});
    expect(meta.configIssues).toEqual([
      {
        path: "client.config.get",
        key: "startupHint.enabled",
        message: "expected boolean",
      },
      {
        path: "client.config.get",
        key: "promptBar.enabled",
        message: "expected boolean",
      },
    ]);
  });

  it("strictly validates alerts field types and value domains", async () => {
    const { config, meta } = await loadSdkConfig({
      alerts: {
        enabled: "off",
        percentRemainingThreshold: 101,
        repeatAfterMinutes: 10,
        balanceThresholds: {
          deepseek: { USD: -1 },
        },
      },
    });

    expect(config.alerts).toEqual(DEFAULT_CONFIG.alerts);
    expect(meta.settingSources).toEqual({});
    expect(meta.configIssues).toContainEqual({
      path: "client.config.get",
      key: "alerts.enabled",
      message: "expected boolean",
    });
    expect(meta.configIssues).toContainEqual({
      path: "client.config.get",
      key: "alerts.percentRemainingThreshold",
      message: "expected a number between 0 and 100 (percent remaining)",
    });
    expect(meta.configIssues).toContainEqual({
      path: "client.config.get",
      key: "alerts.repeatAfterMinutes",
      message: "expected null or an integer of at least 15 minutes",
    });
    expect(meta.configIssues).toContainEqual({
      path: "client.config.get",
      key: "alerts.balanceThresholds",
      message: "expected provider -> ISO currency -> positive number",
    });
  });

  it("accepts alert repeat boundaries: null, 15, and larger integers", async () => {
    for (const repeatAfterMinutes of [null, 15, 120]) {
      const { config, meta } = await loadSdkConfig({
        alerts: { repeatAfterMinutes: repeatAfterMinutes as number | null },
      });
      expect(config.alerts.repeatAfterMinutes).toBe(repeatAfterMinutes);
      expect(meta.configIssues).toEqual([]);
    }

    for (const invalid of [0, 14, 14.5, "15", 15.5, Number.NaN]) {
      const { config } = await loadSdkConfig({
        alerts: { repeatAfterMinutes: invalid as number | null },
      });
      expect(config.alerts.repeatAfterMinutes).toBeNull();
    }
  });

  it("rejects non-ISO currencies and non-numeric balances in balanceThresholds", async () => {
    const { config, meta } = await loadSdkConfig({
      alerts: {
        balanceThresholds: {
          deepseek: { cny: 2, USD: "0.5", EUR: Number.NaN },
        },
      },
    });

    expect(config.alerts.balanceThresholds).toEqual({});
    expect(meta.configIssues).toContainEqual({
      path: "client.config.get",
      key: "alerts.balanceThresholds",
      message: "expected provider -> ISO currency -> positive number",
    });
  });

  it("reports old toast fields as migration diagnostics instead of silent acceptance", async () => {
    const { config, meta } = await loadSdkConfig({
      enableToast: false,
      showOnIdle: false,
      showOnQuestion: false,
      showOnCompact: false,
      showOnBothFail: false,
    });

    // The dead path may still parse them until Ticket 13 removes the contract,
    // but their presence must never be silently accepted.
    expect(config.enableToast).toBe(false);
    for (const key of [
      "enableToast",
      "showOnIdle",
      "showOnQuestion",
      "showOnCompact",
      "showOnBothFail",
    ]) {
      expect(meta.configIssues).toContainEqual(
        expect.objectContaining({
          path: "client.config.get",
          key,
          message: expect.stringContaining("migrate") as string,
        }),
      );
    }
  });

  it("treats the upstream tuiPromptBar section as a legacy entrypoint with a migration note", async () => {
    const { config, meta } = await loadSdkConfig({
      tuiPromptBar: { enabled: true },
    });

    // Behavior is preserved through the canonical section (not silently dropped).
    expect(config.promptBar).toEqual({ enabled: true });
    expect(config.tuiPromptBar).toEqual({ enabled: true });
    expect(meta.settingSources).toEqual({
      "tuiPromptBar.enabled": "client.config.get",
    });
    expect(meta.configIssues).toEqual([
      {
        path: "client.config.get",
        key: "tuiPromptBar",
        message: 'legacy upstream section; use the canonical "promptBar" section',
      },
    ]);
  });

  it("lets the canonical promptBar section win over the legacy tuiPromptBar section", async () => {
    const { config, meta } = await loadSdkConfig({
      tuiPromptBar: { enabled: true },
      promptBar: { enabled: false },
    });

    expect(config.promptBar).toEqual({ enabled: false });
    expect(config.tuiPromptBar).toEqual({ enabled: false });
    expect(meta.configIssues).toEqual([
      {
        path: "client.config.get",
        key: "tuiPromptBar",
        message: 'legacy upstream section; use the canonical "promptBar" section',
      },
    ]);
  });

  it("reports migration diagnostics identically for the sidecar config entrypoint", async () => {
    const { writeQuotaSidecarConfig } = await import("./helpers/config-loader-test-harness.js");
    const sourcePath = writeQuotaSidecarConfig(isolatedCwd, {
      showOnIdle: true,
      startupHint: { enabled: false },
    });

    const meta = createLoadConfigMeta();
    await loadConfig(undefined, meta, { cwd: isolatedCwd });

    expect(meta.configIssues).toContainEqual({
      path: sourcePath + " (opencode-quota/quota-toast.json)",
      key: "showOnIdle",
      message: expect.stringContaining("migrate") as string,
    });
  });
});
