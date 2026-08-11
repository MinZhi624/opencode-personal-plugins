import { beforeEach, describe, expect, it, vi } from "vitest";

import { queryGoogleQuota } from "../src/lib/google.js";

const companionMocks = vi.hoisted(() => ({
  resolveAntigravityClientCredentials: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("fs", () => ({
  existsSync: vi.fn(() => true),
}));

vi.mock("../src/lib/google-token-cache.js", () => ({
  getCachedAccessToken: vi.fn(async () => null),
  makeAccountCacheKey: vi.fn(() => "key"),
  setCachedAccessToken: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/google-antigravity-companion.js", () => ({
  resolveAntigravityClientCredentials: companionMocks.resolveAntigravityClientCredentials,
  inspectAntigravityCompanionPresence: vi.fn(async () => ({
    state: "present" as const,
    importSpecifier: "opencode-antigravity-auth/dist/src/constants.js",
    resolvedPath: "/plugins/opencode-antigravity-auth/dist/src/constants.js",
  })),
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => ({
    dataDirs: ["/home/test/.local/share/opencode"],
    configDirs: ["/home/test/.config/opencode"],
    cacheDirs: ["/home/test/.cache/opencode"],
    stateDirs: ["/home/test/.local/state/opencode"],
  }),
  getOpencodeRuntimeDirs: () => ({
    dataDir: "/home/test/.local/share/opencode",
    configDir: "/home/test/.config/opencode",
    cacheDir: "/home/test/.cache/opencode",
    stateDir: "/home/test/.local/state/opencode",
  }),
}));

describe("google antigravity multi-account refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    companionMocks.resolveAntigravityClientCredentials.mockReset();
    companionMocks.resolveAntigravityClientCredentials.mockResolvedValue({
      state: "configured" as const,
      clientId: "client-id",
      clientSecret: "client-secret",
      resolvedPath: "/plugins/opencode-antigravity-auth/dist/src/constants.js",
    });
  });

  it("refreshes account access token on cache miss and fetches quota", async () => {
    const { readFile } = await import("fs/promises");

    // antigravity-accounts.json exists with one account.
    (readFile as any).mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        accounts: [
          {
            email: "a@b.com",
            refreshToken: "rtok",
            projectId: "proj",
            addedAt: 0,
            lastUsed: 0,
          },
        ],
      }),
    );

    // First refresh token endpoint call, then quota endpoint call.
    const fetchSpy = vi.fn();

    // First refresh token endpoint call, then quota endpoint call.
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: "new_token", expires_in: 3600 }),
    });

    // Second call: quota API
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          models: {
            "claude-opus-4-5-thinking": {
              quotaInfo: { remainingFraction: 0.75, resetTime: "2026-01-01T01:00:00Z" },
            },
          },
        }),
    });

    vi.stubGlobal("fetch", fetchSpy as any);

    const out = await queryGoogleQuota(["CLAUDE"] as any);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toBe("https://oauth2.googleapis.com/token");

    expect(out).not.toBeNull();
    expect(out!.success).toBe(true);
    if (out!.success) {
      expect(out!.models.length).toBe(1);
      expect(out!.models[0].percentRemaining).toBe(75);
    }
  });

  it("applies actual companion reset keys to remote quota buckets", async () => {
    const { readFile } = await import("fs/promises");
    (readFile as any).mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        accounts: [
          {
            email: "a@b.com",
            refreshToken: "rtok",
            projectId: "proj",
            addedAt: 0,
            lastUsed: 0,
            rateLimitResetTimes: {
              claude: Date.parse("2026-01-01T02:00:00.000Z"),
              gemini: Date.parse("2026-01-01T03:00:00.000Z"),
              "gemini-antigravity": Date.parse("2026-01-01T04:00:00.000Z"),
            },
          },
        ],
      }),
    );

    const fetchSpy = vi.fn();
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: "new_token", expires_in: 3600 }),
    });
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          models: {
            "claude-opus-4-6-thinking": {
              quotaInfo: { remainingFraction: 0.75, resetTime: "2026-01-01T01:00:00Z" },
            },
            "gemini-3-flash": {
              quotaInfo: { remainingFraction: 0.5, resetTime: "2026-01-01T01:30:00Z" },
            },
          },
        }),
    });

    vi.stubGlobal("fetch", fetchSpy as any);

    const out = await queryGoogleQuota(["CLAUDE", "G3FLASH"] as any);

    expect(out).not.toBeNull();
    expect(out!.success).toBe(true);
    if (out!.success) {
      expect(out!.models).toEqual([
        {
          modelId: "CLAUDE",
          displayName: "Claude",
          percentRemaining: 0,
          resetTimeIso: "2026-01-01T02:00:00.000Z",
          accountEmail: "a@b.com",
        },
        {
          modelId: "G3FLASH",
          displayName: "G3Flash",
          percentRemaining: 0,
          resetTimeIso: "2026-01-01T04:00:00.000Z",
          accountEmail: "a@b.com",
        },
      ]);
    }
  });

  it("preserves configured GPT-OSS alias reset rows when the remote bucket is missing", async () => {
    const { readFile } = await import("fs/promises");
    (readFile as any).mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        accounts: [
          {
            email: "a@b.com",
            refreshToken: "rtok",
            projectId: "proj",
            addedAt: 0,
            lastUsed: 0,
            rateLimitResetTimes: {
              "gemini-antigravity:gpt-oss-120b-high": Date.parse("2026-01-01T05:00:00.000Z"),
            },
          },
        ],
      }),
    );

    const fetchSpy = vi.fn();
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: "new_token", expires_in: 3600 }),
    });
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ models: {} }),
    });

    vi.stubGlobal("fetch", fetchSpy as any);

    const out = await queryGoogleQuota(["GPTOSS", "G3PRO"] as any);

    expect(out).not.toBeNull();
    expect(out!.success).toBe(true);
    if (out!.success) {
      expect(out!.models).toEqual([
        {
          modelId: "GPTOSS",
          displayName: "GPT-OSS",
          percentRemaining: 0,
          resetTimeIso: "2026-01-01T05:00:00.000Z",
          accountEmail: "a@b.com",
        },
      ]);
    }
  });

  it("ignores expired reset rows and missing remote buckets", async () => {
    const { readFile } = await import("fs/promises");
    (readFile as any).mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        accounts: [
          {
            email: "a@b.com",
            refreshToken: "rtok",
            projectId: "proj",
            addedAt: 0,
            lastUsed: 0,
            rateLimitResetTimes: {
              "gemini-antigravity:gpt-oss-120b-high": Date.parse("2025-12-31T23:59:00.000Z"),
              "gemini-antigravity:gemini-3.1-pro": Date.parse("2025-12-31T23:59:00.000Z"),
            },
          },
        ],
      }),
    );

    const fetchSpy = vi.fn();
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: "new_token", expires_in: 3600 }),
    });
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          models: {
            "gpt-oss-120b-medium": {
              quotaInfo: { remainingFraction: 0.5, resetTime: "2026-01-01T01:30:00Z" },
            },
          },
        }),
    });

    vi.stubGlobal("fetch", fetchSpy as any);

    const out = await queryGoogleQuota(["GPTOSS", "G3PRO"] as any);

    expect(out).not.toBeNull();
    expect(out!.success).toBe(true);
    if (out!.success) {
      expect(out!.models).toEqual([
        {
          modelId: "GPTOSS",
          displayName: "GPT-OSS",
          percentRemaining: 50,
          resetTimeIso: "2026-01-01T01:30:00Z",
          accountEmail: "a@b.com",
        },
      ]);
    }
  });

  it("returns a deterministic error when the companion plugin is missing", async () => {
    const { readFile } = await import("fs/promises");
    (readFile as any).mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        accounts: [
          {
            email: "a@b.com",
            refreshToken: "rtok",
            projectId: "proj",
            addedAt: 0,
            lastUsed: 0,
          },
        ],
      }),
    );

    companionMocks.resolveAntigravityClientCredentials.mockResolvedValueOnce({
      state: "missing" as const,
      error: "Install opencode-antigravity-auth separately to enable Google Antigravity quota",
    });

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy as any);

    const out = await queryGoogleQuota(["CLAUDE"] as any);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out).toEqual({
      success: false,
      error: "Google Antigravity requires the opencode-antigravity-auth plugin",
    });
  });

  it("prioritizes managedProjectId and quotaProjectId over projectId/projectID", async () => {
    const { readFile } = await import("fs/promises");

    (readFile as any).mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        accounts: [
          {
            email: "a@b.com",
            refreshToken: "rtok",
            projectId: "dev-proj",
            projectID: "dev-proj-2",
            managedProjectId: "managed-proj",
            addedAt: 0,
            lastUsed: 0,
          },
        ],
      }),
    );

    const fetchSpy = vi.fn();
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: "new_token", expires_in: 3600 }),
    });
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          models: {
            "claude-opus-4-5-thinking": {
              quotaInfo: { remainingFraction: 0.75, resetTime: "2026-01-01T01:00:00Z" },
            },
          },
        }),
    });

    vi.stubGlobal("fetch", fetchSpy as any);

    await queryGoogleQuota(["CLAUDE"] as any);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const secondCall = fetchSpy.mock.calls[1];
    expect(secondCall[0]).toBe("https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels");
    const bodyObj = JSON.parse(secondCall[1].body);
    expect(bodyObj.project).toBe("managed-proj");
  });
});
