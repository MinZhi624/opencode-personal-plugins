import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";

const mocks = vi.hoisted(() => ({
  getKiloKeyDiagnostics: vi.fn(),
  hasKiloApiKey: vi.fn(),
  queryKiloBalance: vi.fn(),
}));

vi.mock("../src/lib/kilo-config.js", () => ({
  getKiloKeyDiagnostics: mocks.getKiloKeyDiagnostics,
  hasKiloApiKey: mocks.hasKiloApiKey,
}));

vi.mock("../src/lib/kilo.js", () => ({
  queryKiloBalance: mocks.queryKiloBalance,
}));

import { kiloProvider } from "../src/providers/kilo.js";

describe("Kilo Gateway provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getKiloKeyDiagnostics.mockResolvedValue({
      configured: true,
      source: "env:KILO_API_KEY",
      checkedPaths: ["env:KILO_API_KEY"],
      authPaths: ["/tmp/auth.json"],
    });
  });

  it("uses the documented canonical provider identity and model prefix", () => {
    expect(kiloProvider.id).toBe("kilo");
    expect(kiloProvider.matchesCurrentModel?.("kilo/anthropic/claude-sonnet-4")).toBe(true);
    expect(kiloProvider.matchesCurrentModel?.("kilo-gateway/model")).toBe(false);
    expect(kiloProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
  });

  it("is available only when a trusted Kilo API key exists", async () => {
    mocks.hasKiloApiKey.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(kiloProvider.isAvailable({} as any)).resolves.toBe(true);
    await expect(kiloProvider.isAvailable({} as any)).resolves.toBe(false);
  });

  it("does not attempt a request without trusted configuration", async () => {
    mocks.queryKiloBalance.mockResolvedValueOnce(null);

    const out = await kiloProvider.fetch({} as any);

    expectNotAttempted(out);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "api_key_configured", value: "true" },
        { key: "api_key_source", value: "env:KILO_API_KEY" },
      ]),
    );
  });

  it("maps the documented USD balance into one provider-reported value row", async () => {
    mocks.queryKiloBalance.mockResolvedValueOnce({ success: true, balanceUsd: 12.345 });

    const out = await kiloProvider.fetch({ config: { requestTimeoutMs: 9000 } } as any);

    expectAttemptedWithNoErrors(out);
    expect(mocks.queryKiloBalance).toHaveBeenCalledWith({ requestTimeoutMs: 9000 });
    expect(visibleEntries(out.entries, "kilo")).toEqual([
      {
        kind: "value",
        name: "Kilo Gateway Balance",
        group: "Kilo Gateway",
        label: "Balance:",
        value: "$12.35",
      },
    ]);
    expect(out.statusDetails).toContainEqual({ key: "balance_usd", value: "$12.35" });
  });

  it("maps API failures into a safe Kilo Gateway error", async () => {
    mocks.queryKiloBalance.mockResolvedValueOnce({ success: false, error: "Unauthorized" });

    const out = await kiloProvider.fetch({} as any);

    expectAttemptedWithErrorLabel(out, "Kilo Gateway");
  });
});
