import { describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";
import { visibleEntries } from "./helpers/provider-assertions.js";
import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import { formatQuotaRowsGrouped } from "../src/lib/toast-format-grouped.js";
import { buildCompactQuotaStatusLine } from "../src/lib/tui-compact-format.js";
import { googleAntigravityProvider } from "../src/providers/google-antigravity.js";

vi.mock("../src/lib/google.js", () => ({
  hasAntigravityQuotaRuntimeAvailable: vi.fn(),
  queryGoogleQuota: vi.fn(),
  inspectAntigravityAccountsPresence: vi.fn(async () => ({
    state: "missing",
    selectedPath: null,
    presentPaths: [],
    candidatePaths: [],
    accountCount: 0,
    validAccountCount: 0,
  })),
}));

vi.mock("../src/lib/google-antigravity-companion.js", () => ({
  inspectAntigravityCompanionPresence: vi.fn(async () => ({
    state: "missing",
    error: "companion unavailable",
  })),
}));

describe("google antigravity provider", () => {
  it("returns attempted:false when antigravity accounts are not configured", async () => {
    const { queryGoogleQuota } = await import("../src/lib/google.js");
    (queryGoogleQuota as any).mockResolvedValueOnce(null);

    const out = await googleAntigravityProvider.fetch({ config: { googleModels: [] } } as any);
    expectNotAttempted(out);
  });

  it("maps success into toast entries and truncated error labels", async () => {
    const { queryGoogleQuota } = await import("../src/lib/google.js");
    (queryGoogleQuota as any).mockResolvedValueOnce({
      success: true,
      models: [
        {
          modelId: "CLAUDE",
          displayName: "Claude",
          accountEmail: "alice@example.com",
          percentRemaining: 64,
          resetTimeIso: "2026-01-01T00:00:00.000Z",
        },
        {
          modelId: "CLAUDE",
          displayName: "Claude",
          accountEmail: "bob@example.com",
          percentRemaining: 37,
          resetTimeIso: "2026-01-02T00:00:00.000Z",
        },
      ],
      errors: [{ email: "bob@example.com", error: "Unauthorized" }],
    });

    const out = await googleAntigravityProvider.fetch({ config: { googleModels: [] } } as any);
    expect(out.attempted).toBe(true);
    expect(visibleEntries(out.entries, "google-antigravity")).toEqual([
      {
        name: "Antigravity (ali…): Claude",
        group: "[Antigravity (ali…)]",
        label: "Claude:",
        metricLabel: "Claude",
        percentRemaining: 64,
        resetTimeIso: "2026-01-01T00:00:00.000Z",
      },
      {
        name: "Antigravity (bob…): Claude",
        group: "[Antigravity (bob…)]",
        label: "Claude:",
        metricLabel: "Claude",
        percentRemaining: 37,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
      },
    ]);
    expect(out.entries.map((entry) => entry.accounting)).toEqual([
      {
        resultType: "quota",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
        sourceId: "alice@example.com",
      },
      {
        resultType: "quota",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
        sourceId: "bob@example.com",
      },
    ]);
    expect(JSON.stringify(out.entries)).not.toContain("Anthropic");
    expect(out.presentation).toEqual({
      classicStrategy: "preserve",
      redundantQuotaFamily: "Claude",
    });
    expect(out.errors).toEqual([{ label: "bob…", message: "Unauthorized" }]);
  });

  it("keeps colliding account prefixes distinct across grouped, command, and compact output", async () => {
    const { queryGoogleQuota } = await import("../src/lib/google.js");
    (queryGoogleQuota as any).mockResolvedValueOnce({
      success: true,
      models: [
        {
          modelId: "CLAUDE",
          displayName: "Claude",
          accountEmail: "alice@work.com",
          percentRemaining: 64,
        },
        {
          modelId: "CLAUDE",
          displayName: "Claude",
          accountEmail: "alice@personal.com",
          percentRemaining: 37,
        },
      ],
      errors: [],
    });

    const out = await googleAntigravityProvider.fetch({ config: { googleModels: [] } } as any);
    expect(out.entries.map((entry) => entry.group)).toEqual([
      "[Antigravity (alice… 1)]",
      "[Antigravity (alice… 2)]",
    ]);
    expect(out.presentation?.redundantQuotaFamily).toBe("Claude");

    const grouped = formatQuotaRowsGrouped({ entries: out.entries, errors: out.errors });
    const command = formatQuotaCommand({ entries: out.entries, errors: out.errors });
    const compact = buildCompactQuotaStatusLine({
      data: { entries: out.entries, errors: out.errors },
      maxWidth: 160,
    });
    for (const output of [grouped, command, compact]) {
      expect(output).toContain("Antigravity (alice… 1)");
      expect(output).toContain("Antigravity (alice… 2)");
    }
  });

  it("omits the account suffix when the quota result has no email", async () => {
    const { queryGoogleQuota } = await import("../src/lib/google.js");
    (queryGoogleQuota as any).mockResolvedValueOnce({
      success: true,
      models: [
        {
          modelId: "CLAUDE",
          displayName: "Claude",
          percentRemaining: 64,
        },
      ],
      errors: [],
    });

    const out = await googleAntigravityProvider.fetch({ config: { googleModels: [] } } as any);
    expect(visibleEntries(out.entries, "google-antigravity")).toEqual([
      {
        name: "Antigravity: Claude",
        group: "[Antigravity]",
        label: "Claude:",
        metricLabel: "Claude",
        percentRemaining: 64,
      },
    ]);
  });

  it("keeps family labels when one account returns multiple families", async () => {
    const { queryGoogleQuota } = await import("../src/lib/google.js");
    (queryGoogleQuota as any).mockResolvedValueOnce({
      success: true,
      models: [
        {
          modelId: "CLAUDE",
          displayName: "Claude",
          accountEmail: "alice@example.com",
          percentRemaining: 64,
        },
        {
          modelId: "G3PRO",
          displayName: "G3Pro",
          accountEmail: "alice@example.com",
          percentRemaining: 37,
        },
      ],
      errors: [],
    });

    const out = await googleAntigravityProvider.fetch({ config: { googleModels: [] } } as any);
    expect(out.presentation).toEqual({ classicStrategy: "preserve" });
    expect(out.entries.map((entry) => entry.name)).toEqual([
      "Antigravity (ali…): Claude",
      "Antigravity (ali…): G3Pro",
    ]);
  });

  it("keeps family labels when accounts return different singleton families", async () => {
    const { queryGoogleQuota } = await import("../src/lib/google.js");
    (queryGoogleQuota as any).mockResolvedValueOnce({
      success: true,
      models: [
        {
          modelId: "CLAUDE",
          displayName: "Claude",
          accountEmail: "alice@example.com",
          percentRemaining: 64,
        },
        {
          modelId: "G3PRO",
          displayName: "G3Pro",
          accountEmail: "bob@example.com",
          percentRemaining: 37,
        },
      ],
      errors: [],
    });

    const out = await googleAntigravityProvider.fetch({ config: { googleModels: [] } } as any);
    expect(out.presentation).toEqual({ classicStrategy: "preserve" });
    expect(out.entries.map((entry) => entry.name)).toEqual([
      "Antigravity (ali…): Claude",
      "Antigravity (bob…): G3Pro",
    ]);
  });

  it("maps fetch failures into toast errors", async () => {
    const { queryGoogleQuota } = await import("../src/lib/google.js");
    (queryGoogleQuota as any).mockResolvedValueOnce({
      success: false,
      error: "Token expired",
    });

    const out = await googleAntigravityProvider.fetch({ config: { googleModels: [] } } as any);
    expectAttemptedWithErrorLabel(out, "Antigravity");
  });

  it.each([
    ["google/antigravity-claude-opus-4-6-thinking", true],
    ["google/antigravity-gemini-3-pro", true],
    ["google-antigravity/claude-opus", true],
    ["antigravity/gemini-pro", true],
    ["antigravity-claude-sonnet-4-6", true],
    ["google/gemini-3-pro", false],
    ["google/claude-opus", false],
    ["google-gemini-cli/gemini-3-pro", false],
    ["opencode/gpt-5", false],
  ] as const)("matchesCurrentModel(%s) -> %s", (model, expected) => {
    expect(googleAntigravityProvider.matchesCurrentModel?.(model)).toBe(expected);
  });

  it("is available only when the antigravity runtime is configured", async () => {
    const { hasAntigravityQuotaRuntimeAvailable } = await import("../src/lib/google.js");
    (hasAntigravityQuotaRuntimeAvailable as any).mockResolvedValueOnce(true);
    await expect(googleAntigravityProvider.isAvailable({} as any)).resolves.toBe(true);

    (hasAntigravityQuotaRuntimeAvailable as any).mockResolvedValueOnce(false);
    await expect(googleAntigravityProvider.isAvailable({} as any)).resolves.toBe(false);
  });

  it("returns false when runtime detection throws", async () => {
    const { hasAntigravityQuotaRuntimeAvailable } = await import("../src/lib/google.js");
    (hasAntigravityQuotaRuntimeAvailable as any).mockRejectedValueOnce(new Error("boom"));

    await expect(googleAntigravityProvider.isAvailable({} as any)).resolves.toBe(false);
  });
});
