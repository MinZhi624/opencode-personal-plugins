import { afterEach, describe, expect, it, vi } from "vitest";

import { formatQuotaCommand, QUOTA_COMMAND_BAR_WIDTH } from "../src/lib/quota-command-format.js";
import type {
  QuotaSnapshotProjection,
  UnifiedQuotaSnapshot,
} from "../src/lib/quota-snapshot.js";

function accounting(
  resultType: "quota" | "rate_limit" | "usage" | "spend" | "budget" | "balance" | "status",
) {
  return {
    resultType,
    acquisitionMethod: "remote_api",
    ownership: "maintained",
    authority: "provider_reported",
  } as const;
}

describe("formatQuotaCommand", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("documents the main /quota printout combinations used by the default command output", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));

    const out = formatQuotaCommand({
      entries: [
        {
          accounting: accounting("quota"),
          name: "Copilot",
          group: "Copilot (personal)",
          label: "Quota:",
          right: "42/300",
          percentRemaining: 86,
          resetTimeIso: "2026-01-16T00:00:00.000Z",
        },
        {
          accounting: accounting("usage"),
          name: "Copilot",
          group: "Copilot (business)",
          label: "Usage:",
          kind: "value",
          value: "9 used | 2026-01 | org=acme-corp | user=alice",
          resetTimeIso: "2026-02-01T00:00:00.000Z",
        },
        {
          accounting: accounting("quota"),
          name: "OpenAI (Pro) 5h",
          group: "OpenAI (Pro)",
          label: "5h:",
          percentRemaining: 42,
          resetTimeIso: "2026-01-15T14:00:00.000Z",
        },
        {
          accounting: accounting("quota"),
          name: "OpenAI (Pro) Weekly",
          group: "OpenAI (Pro)",
          label: "Weekly:",
          percentRemaining: 81,
          resetTimeIso: "2026-01-18T12:00:00.000Z",
        },
        {
          accounting: accounting("quota"),
          name: "Claude (acct)",
          metricLabel: "Claude",
          percentRemaining: 67,
          resetTimeIso: "2026-01-15T15:00:00.000Z",
        },
      ],
      errors: [{ label: "Z.ai", message: "Authentication expired" }],
      sessionTokens: {
        models: [
          { modelID: "openai/gpt-5", input: 1234, cachedInput: 456, totalInput: 1690, output: 567 },
          { modelID: "github-copilot/claude-sonnet-4.5", input: 987, output: 654 },
        ],
        totalInput: 2221,
        totalCachedInput: 456,
        totalCombinedInput: 2677,
        totalOutput: 1221,
      },
    });

    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^额度（\/quota）\d{2}:\d{2} \d{2}\/\d{2}\/\d{4}$/);
    expect(lines[0]).not.toMatch(/^#/u);
    expect(lines[1]).toBe("");
    const providerHeaderIndexes = lines.flatMap((line, index) =>
      line.startsWith("→ ") ? [index] : [],
    );
    for (const index of providerHeaderIndexes) {
      expect(lines[index + 1]).toMatch(/^ {2}\S/u);
    }
    expect(out).not.toContain("```");
    expect(out.match(/[█░]{10}/gu)).toHaveLength(4);
    expect(lines.slice(2).join("\n")).toMatchInlineSnapshot(`
      "→ [Copilot] (personal)
        额度            █████████░     86% 剩余 | 42/300 | 12小时后重置

      → [Copilot] (business)
        用量            9 used | 2026-01 | org=acme-corp | user=alice | 17天后重置

      → [OpenAI] (Pro)
        5h 额度         ████░░░░░░     42% 剩余 | 2小时后重置
        周 额度          ████████░░     81% 剩余 | 3天后重置

      → [Antigravity (acct)]
        Claude        ███████░░░     67% 剩余 | 3小时后重置

      会话 token（输入/输出）
        openai/gpt-5: 1.2K 输入 | 456 缓存 | 567 输出
        github-copilot/claude-sonnet-4.5: 987 输入 | 654 输出

      部分失败
        Z.ai: Authentication expired"
    `);
  });

  it("keeps canonical accounting labels for unrelated custom-provider rows", () => {
    const out = formatQuotaCommand({
      entries: [
        {
          accounting: accounting("quota"),
          name: "Custom quota",
          group: "Custom quota",
          label: "Credits:",
          percentRemaining: 80,
        },
        {
          accounting: accounting("rate_limit"),
          name: "Custom rate",
          group: "Custom rate",
          label: "Requests:",
          percentRemaining: 70,
        },
        {
          accounting: accounting("usage"),
          name: "Custom usage",
          group: "Custom usage",
          label: "Tokens:",
          percentRemaining: 60,
        },
        {
          accounting: accounting("budget"),
          name: "Custom budget",
          group: "Custom budget",
          label: "Credits:",
          percentRemaining: 50,
        },
        {
          accounting: accounting("spend"),
          name: "Custom spend",
          group: "Custom spend",
          label: "Charges:",
          percentRemaining: 40,
        },
      ],
      errors: [],
    });

    expect(out).toMatch(/\n  额度\s/u);
    expect(out.match(/\n  额度\s/gu)).toHaveLength(2);
    expect(out).toMatch(/\n  用量\s/u);
    expect(out).toMatch(/\n  预算\s/u);
    expect(out).toMatch(/\n  花费\s/u);
    expect(out).not.toMatch(/\n  (?:Credits|Requests|Tokens|Charges)\s/u);
  });

  it("renders grouped /quota windows shortest to longest within a provider group", () => {
    const out = formatQuotaCommand({
      entries: [
        {
          name: "OpenAI Weekly",
          group: "OpenAI (Pro)",
          label: "Weekly:",
          percentRemaining: 81,
        },
        {
          name: "OpenAI 5h",
          group: "OpenAI (Pro)",
          label: "5h:",
          percentRemaining: 42,
        },
        {
          name: "OpenAI Code Review",
          group: "OpenAI (Pro)",
          label: "Code Review:",
          kind: "value" as const,
          value: "2 used",
        },
      ],
      errors: [],
    });

    expect(out.indexOf("5h 额度")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("周 额度")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("Code Review")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("5h 额度")).toBeLessThan(out.indexOf("周 额度"));
    expect(out.indexOf("周 额度")).toBeLessThan(out.indexOf("Code Review"));
  });

  it("locks rendered grouped /quota ordering for Qwen and OpenAI provider groups", () => {
    const out = formatQuotaCommand({
      entries: [
        {
          name: "Qwen Free Daily",
          group: "Qwen (free)",
          label: "Daily:",
          percentRemaining: 90,
        },
        {
          name: "OpenAI Weekly",
          group: "OpenAI (Pro)",
          label: "Weekly:",
          percentRemaining: 81,
        },
        {
          name: "Qwen Free RPM",
          group: "Qwen (free)",
          label: "RPM:",
          percentRemaining: 60,
        },
        {
          name: "OpenAI 5h",
          group: "OpenAI (Pro)",
          label: "5h:",
          percentRemaining: 42,
        },
      ],
      errors: [],
    });

    expect(out.indexOf("→ [Qwen] (free)")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("→ [OpenAI] (Pro)")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("→ [Qwen] (free)")).toBeLessThan(out.indexOf("→ [OpenAI] (Pro)"));

    expect(out.indexOf("RPM 额度")).toBeLessThan(out.indexOf("天 额度"));
    expect(out.indexOf("5h 额度")).toBeLessThan(out.indexOf("周 额度"));
  });

  it("honors used percent display mode in /quota percent rows", () => {
    const out = formatQuotaCommand({
      entries: [
        {
          name: "OpenAI Pro",
          percentRemaining: 81,
        },
      ],
      errors: [],
      percentDisplayMode: "used",
    });

    expect(out).toContain("Status        ██░░░░░░░░     19% 已用");
    expect(out).not.toContain("81% 剩余");
  });

  it("clamps the bar but preserves over-quota used percentage meaning", () => {
    const out = formatQuotaCommand({
      entries: [
        {
          name: "OpenAI Pro",
          percentRemaining: -25,
        },
      ],
      errors: [],
      percentDisplayMode: "used",
    });

    expect(out).toContain("Status        ██████████    125% 已用");
  });

  it("uses fixed labels and aligned equal-width bars", () => {
    const out = formatQuotaCommand({
      entries: [
        {
          accounting: accounting("quota"),
          name: "Example daily quota",
          group: "Example",
          label: "Daily:",
          right: "20/100",
          percentRemaining: 80,
        },
        {
          accounting: accounting("budget"),
          name: "Example daily budget",
          group: "Example",
          label: "Daily:",
          right: "$4/$20",
          percentRemaining: 80,
        },
        {
          accounting: accounting("balance"),
          name: "Example balance",
          group: "Example",
          label: "Account:",
          kind: "value",
          value: "$42.00",
        },
      ],
      errors: [],
    });

    expect(out).toContain("天 额度");
    expect(out).toContain("天 预算");
    expect(out).toContain("余额");

    const percentLines = out.split("\n").filter((line) => /[█░]/u.test(line));
    const bars = percentLines.map((line) => line.match(/[█░]+/u)![0]);
    expect(bars.map((value) => Array.from(value).length)).toEqual([
      QUOTA_COMMAND_BAR_WIDTH,
      QUOTA_COMMAND_BAR_WIDTH,
    ]);
    expect(percentLines.every((line) => /^ {2}\S/u.test(line))).toBe(true);
    expect(percentLines.map((line) => line.search(/[█░]/u))).toEqual([16, 16]);
    expect(Math.max(...percentLines.map((line) => Array.from(line).length))).toBeLessThanOrEqual(
      64,
    );
  });

  it("keeps aligned metric rows in clean plain text", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));

    const output = formatQuotaCommand({
      entries: [
        {
          accounting: accounting("quota"),
          name: "Local Rolling",
          group: "Local",
          label: "5h:",
          right: "2/5",
          percentRemaining: 60,
          resetTimeIso: "2026-01-15T17:00:00.000Z",
        },
        {
          accounting: accounting("quota"),
          name: "Local Daily",
          group: "Local",
          label: "Daily:",
          right: "2/10",
          percentRemaining: 80,
          resetTimeIso: "2026-01-15T23:00:00.000Z",
        },
      ],
      errors: [{ label: "Example", message: "secondary source failed" }],
      sessionTokens: {
        models: [{ modelID: "openai/gpt-5", input: 123, output: 45 }],
        totalInput: 123,
        totalOutput: 45,
      },
    });
    const rows = output.split("\n").filter((line) => line.includes("后重置"));

    expect(rows).toEqual([
      "  5h 额度         ██████░░░░     60% 剩余 | 2/5  | 5小时后重置",
      "  天 额度          ████████░░     80% 剩余 | 2/10 | 11小时后重置",
    ]);
    expect(output).not.toContain("```");
    expect(output).not.toMatch(/^## /mu);
    expect(rows.map((line) => line.search(/[█░]/u))).toEqual([16, 16]);
    expect(rows.map((line) => line.indexOf("2/"))).toEqual([
      rows[0]!.indexOf("2/"),
      rows[0]!.indexOf("2/"),
    ]);
    // Chinese runtime units shift the reset column when the hour count grows
    // a digit (5小时 vs 11小时); the usage/right column stays aligned.
    expect(rows.map((line) => line.indexOf("2/"))).toEqual([40, 40]);
    expect(rows.map((line) => line.indexOf("后重置"))).toEqual([
      rows[0]!.indexOf("后重置"),
      rows[0]!.indexOf("后重置") + 1,
    ]);
    expect(output).toContain("openai/gpt-5: 123 输入 | 45 输出");
    expect(output).toContain("Example: secondary source failed");
  });

  it("keeps /quota reset formatting independent from compact toast resets", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"));

    const out = formatQuotaCommand({
      entries: [
        {
          name: "OpenAI",
          group: "OpenAI",
          label: "Weekly:",
          percentRemaining: 81,
          resetTimeIso: "2026-01-15T12:40:00.000Z",
        },
      ],
      errors: [],
    });

    // /quota keeps its own formatter (hour-rounded here), not toast compact rounding.
    expect(out).toContain("3小时后重置");
  });

  it("aligns reset columns when usage values have different widths", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));

    const out = formatQuotaCommand({
      entries: [
        {
          accounting: accounting("quota"),
          name: "Local Rolling",
          group: "Local",
          label: "5h:",
          right: "2/5",
          percentRemaining: 60,
          resetTimeIso: "2026-01-15T17:00:00.000Z",
        },
        {
          accounting: accounting("quota"),
          name: "Local Daily",
          group: "Local",
          label: "Daily:",
          right: "2/10",
          percentRemaining: 80,
          resetTimeIso: "2026-01-15T23:00:00.000Z",
        },
      ],
      errors: [],
    });

    const metricLines = out.split("\n").filter((line) => line.includes(" | "));
    expect(metricLines).toHaveLength(2);
    expect(metricLines[0]).toContain(" | 2/5  | 5小时后重置");
    expect(metricLines[1]).toContain(" | 2/10 | 11小时后重置");
    expect(metricLines[0]!.indexOf("2/5")).toBe(metricLines[1]!.indexOf("2/10"));
    // v1.0.1 Chinese runtime: the reset column is not digit-aligned (5小时 vs 11小时).
    expect(metricLines.map((line) => line.indexOf("后重置"))).toEqual([
      metricLines[0]!.indexOf("后重置"),
      metricLines[0]!.indexOf("后重置") + 1,
    ]);
  });

  it("keeps a representative long /quota metric on one viewport-safe line", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));

    const out = formatQuotaCommand({
      entries: [
        {
          accounting: accounting("quota"),
          name: "Copilot",
          group: "Copilot (personal)",
          label: "Quota:",
          right: "12345678901234567890",
          percentRemaining: 86,
          resetTimeIso: "2026-01-16T00:00:00.000Z",
        },
      ],
      errors: [],
    });

    const metric = out.split("\n").find((line) => line.includes("12345678901234567890"))!;
    expect(metric).toContain(
      "额度            █████████░     86% 剩余 | 12345678901234567890 | 12小时后重置",
    );
    expect(metric).toMatch(/^ {2}\S/u);
    expect(metric).not.toContain("```");
    expect(Array.from(metric).length).toBeLessThanOrEqual(76);
  });

  it("renders the Ticket 07 unified snapshot section when snapshot and projection are provided", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));

    const snapshot: UnifiedQuotaSnapshot = {
      version: 1,
      // Real unified snapshot semantics: 2 monitored providers, only 1 fresh
      // (anthropic failed) → integrity is "partial", never "complete".
      integrity: "partial",
      providers: [
        { providerId: "openai", quality: "fresh", errors: [] },
        { providerId: "anthropic", quality: "failed", errors: [{ label: "Anthropic", message: "boom" }] },
      ],
      windows: [
        {
          metricType: "percent_remaining",
          providerId: "openai",
          providerLabel: "OpenAI",
          windowLabel: "5h",
          percentRemaining: 42,
          quality: "fresh",
          authority: "provider_reported",
        },
      ],
    };
    const projection: QuotaSnapshotProjection = {
      startupHint: {
        state: "partial",
        providerCount: 2,
        unknownCount: 1,
        mostRelevant: {
          providerId: "openai",
          providerLabel: "OpenAI",
          windowLabel: "5h",
          percentRemaining: 42,
        },
      },
      alertPlan: { version: 1, notifications: [] },
      nextState: { version: 1, alertEpisodes: [] },
    };

    const out = formatQuotaCommand({
      entries: [
        {
          accounting: accounting("quota"),
          name: "OpenAI (Pro) 5h",
          group: "OpenAI (Pro)",
          label: "5h:",
          percentRemaining: 42,
        },
      ],
      errors: [{ label: "Anthropic", message: "boom" }],
      snapshot,
      projection,
    });

    expect(out).toContain("统一快照");
    expect(out).toContain("v1 · 完整性：部分 · 总体状态：部分可用");
    expect(out).toContain("监控 Provider：2（正常 1 · 未知 1） · 额度窗口：1");
    // Pre-migration rows stay semantically equivalent.
    expect(out).toContain("5h 额度");
    expect(out).toContain("42% 剩余");
    expect(out).toContain("Anthropic: boom");
  });

  it("omits the overall state when no projection is provided", () => {
    const snapshot: UnifiedQuotaSnapshot = {
      version: 1,
      integrity: "complete",
      providers: [{ providerId: "openai", quality: "fresh", errors: [] }],
      windows: [],
    };

    const out = formatQuotaCommand({
      entries: [
        {
          accounting: accounting("quota"),
          name: "OpenAI Pro",
          percentRemaining: 81,
        },
      ],
      errors: [],
      snapshot,
    });

    expect(out).toContain("v1 · 完整性：完整");
    expect(out).not.toContain("总体状态");
  });
});
