import { describe, expect, it } from "vitest";

import { buildCompactQuotaStatusLine } from "../src/lib/tui-compact-format.js";

describe("buildCompactQuotaStatusLine", () => {
  it("formats percent entries with text-only remaining percent semantics", () => {
    const line = buildCompactQuotaStatusLine({
      percentDisplayMode: "remaining",
      maxWidth: 96,
      data: {
        entries: [
          {
            name: "Copilot rolling window",
            group: "Copilot",
            label: "5h:",
            percentRemaining: 82,
          },
        ],
        errors: [],
      },
    });

    expect(line).toBe("Copilot 82%");
  });

  it("formats used percent mode with text-only percentages", () => {
    const line = buildCompactQuotaStatusLine({
      percentDisplayMode: "used",
      maxWidth: 96,
      data: {
        entries: [
          {
            name: "Copilot rolling window",
            group: "Copilot",
            label: "5h:",
            percentRemaining: 82,
          },
        ],
        errors: [],
      },
    });

    expect(line).toBe("Copilot 18%");
  });

  it("keeps a lone Antigravity model label in all-window compact output", () => {
    const line = buildCompactQuotaStatusLine({
      data: {
        entries: [
          {
            name: "Antigravity (ali…): Claude",
            group: "[Antigravity (ali…)]",
            label: "Claude:",
            percentRemaining: 64,
          },
          {
            name: "Antigravity (bob…): Claude",
            group: "[Antigravity (bob…)]",
            label: "Claude:",
            percentRemaining: 37,
          },
        ],
        errors: [],
      },
      maxWidth: 160,
    });

    expect(line).toBe("Antigravity (ali…): Claude 64% | Antigravity (bob…): Claude 37%");
  });

  it("preserves Gemini CLI model tiers in grouped compact status", () => {
    const line = buildCompactQuotaStatusLine({
      percentDisplayMode: "remaining",
      maxWidth: 96,
      data: {
        entries: [
          { name: "Gemini Pro", group: "Gemini CLI", label: "Gemini Pro:", percentRemaining: 20 },
          {
            name: "Gemini Flash",
            group: "Gemini CLI",
            label: "Gemini Flash:",
            percentRemaining: 50,
          },
          {
            name: "Gemini Flash Lite",
            group: "Gemini CLI",
            label: "Gemini Flash Lite:",
            percentRemaining: 10,
          },
        ],
        errors: [],
      },
    });

    expect(line).toBe("Gemini CLI: Gemini Pro 20%, Gemini Flash 50%, Gemini Flash Lite 10%");
  });

  it("preserves explicit non-duration compact labels when multiple rows share a provider", () => {
    const line = buildCompactQuotaStatusLine({
      percentDisplayMode: "remaining",
      maxWidth: 96,
      data: {
        entries: [
          { name: "Cursor API", group: "Cursor", label: "API:", percentRemaining: 25 },
          { name: "Cursor Requests", group: "Cursor", label: "Requests:", percentRemaining: 50 },
          { name: "Kimi Code Fast", group: "Kimi Code", label: "Fast:", percentRemaining: 80 },
          { name: "Kimi Code Slow", group: "Kimi Code", label: "Slow:", percentRemaining: 40 },
        ],
        errors: [],
      },
    });

    expect(line).toBe("Cursor: API 25%, Requests 50% | Kimi Code: Fast 80%, Slow 40%");
  });

  it("groups multiple percent windows under one provider with compact window labels", () => {
    const line = buildCompactQuotaStatusLine({
      percentDisplayMode: "remaining",
      maxWidth: 96,
      data: {
        entries: [
          {
            name: "OpenAI rolling window",
            group: "OpenAI (pro)",
            label: "5h:",
            percentRemaining: 100,
          },
          {
            name: "OpenAI weekly window",
            group: "OpenAI (pro)",
            label: "Weekly:",
            percentRemaining: 100,
          },
        ],
        errors: [],
      },
    });

    expect(line).toBe("OpenAI Pro 5h 100%, 7d 100%");
  });

  it("keeps compact status provider labels intentionally short", () => {
    const line = buildCompactQuotaStatusLine({
      percentDisplayMode: "remaining",
      maxWidth: 96,
      data: {
        entries: [
          {
            name: "Copilot rolling window",
            group: "Copilot (personal)",
            label: "5h:",
            percentRemaining: 75,
          },
        ],
        errors: [],
      },
    });

    expect(line).toBe("Copilot 75%");
    expect(line).not.toContain("[Copilot] (personal)");
  });

  it("formats value entries without percent mode changing the value", () => {
    const remaining = buildCompactQuotaStatusLine({
      percentDisplayMode: "remaining",
      maxWidth: 96,
      data: {
        entries: [
          {
            kind: "value",
            name: "Cursor API",
            value: "$2.40 / $20.00",
          },
        ],
        errors: [],
      },
    });
    const used = buildCompactQuotaStatusLine({
      percentDisplayMode: "used",
      maxWidth: 96,
      data: {
        entries: [
          {
            kind: "value",
            name: "Cursor API",
            value: "$2.40 / $20.00",
          },
        ],
        errors: [],
      },
    });

    expect(remaining).toBe("Cursor API - $2.40 / $20.00");
    expect(used).toBe(remaining);
  });

  it("joins multiple entry and session-token aggregate segments", () => {
    const line = buildCompactQuotaStatusLine({
      percentDisplayMode: "remaining",
      maxWidth: 96,
      data: {
        entries: [
          {
            name: "Copilot rolling window",
            group: "Copilot",
            label: "5h:",
            percentRemaining: 82,
          },
          {
            kind: "value",
            name: "Cursor API",
            value: "$2.40",
          },
        ],
        errors: [],
        sessionTokens: {
          models: [
            {
              modelID: "openai/gpt-5",
              input: 12_400,
              cachedInput: 5_600,
              totalInput: 18_000,
              output: 3_100,
            },
          ],
          totalInput: 12_400,
          totalCachedInput: 5_600,
          totalCombinedInput: 18_000,
          totalOutput: 3_100,
        },
      },
    });

    expect(line).toBe("Copilot 82% | Cursor API - $2.40 | tok 12.4K (5.6K) in / 3.1K out");
  });

  it("summarizes errors as issue counts when quota segments exist and the count fits", () => {
    const line = buildCompactQuotaStatusLine({
      percentDisplayMode: "remaining",
      maxWidth: 96,
      data: {
        entries: [
          {
            name: "Copilot",
            percentRemaining: 75,
          },
        ],
        errors: [
          { label: "OpenAI", message: "Not configured" },
          { label: "Cursor", message: "Unavailable" },
        ],
      },
    });

    expect(line).toBe("Copilot 75% | +2 issues");
  });

  it("renders the first error with a remaining count when no quota segments exist", () => {
    const line = buildCompactQuotaStatusLine({
      percentDisplayMode: "remaining",
      maxWidth: 96,
      data: {
        entries: [],
        errors: [
          { label: "OpenAI", message: "Not configured" },
          { label: "Cursor", message: "Unavailable" },
        ],
      },
    });

    expect(line).toBe("OpenAI: Not configured +1");
  });

  it("omits the issue count when quota segments exist but the count does not fit", () => {
    const line = buildCompactQuotaStatusLine({
      percentDisplayMode: "remaining",
      maxWidth: "Copilot 75%".length,
      data: {
        entries: [
          {
            name: "Copilot",
            percentRemaining: 75,
          },
        ],
        errors: [{ label: "OpenAI", message: "Not configured" }],
      },
    });

    expect(line).toBe("Copilot 75%");
  });

  it("collapses whitespace, sanitizes control text, and truncates with ellipsis", () => {
    const line = buildCompactQuotaStatusLine({
      percentDisplayMode: "remaining",
      maxWidth: 18,
      data: {
        entries: [
          {
            name: "Open\u001b[31mAI\nProvider",
            percentRemaining: 42,
          },
        ],
        errors: [{ label: "Err\u0007", message: "Bad\u0003" }],
      },
    });

    expect(line).toBe("OpenAI Provider 4…");
    expect(line.length).toBeLessThanOrEqual(18);
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain("\u0007");
    expect(line).not.toContain("\u0003");
  });
});
