import { describe, expect, it } from "vitest";
import { formatQuotaStatsReport } from "../src/lib/quota-stats-format.js";
import type { AggregateResult } from "../src/lib/quota-stats.js";

function makeEmptyResult(overrides?: Partial<AggregateResult>): AggregateResult {
  return {
    window: { sinceMs: 0, untilMs: 1 },
    totals: {
      priced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
      unknown: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
      unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
      costUsd: 0,
      messageCount: 0,
      sessionCount: 0,
    },
    bySourceProvider: [],
    bySourceModel: [],
    byModel: [],
    bySession: [],
    unknown: [],
    unpriced: [],
    pricing: { source: "bundled", generatedAt: 0, units: "USD per 1M tokens" },
    ...overrides,
  };
}

function makeSessionRow(
  overrides?: Partial<AggregateResult["bySession"][number]>,
): AggregateResult["bySession"][number] {
  return {
    sessionID: "ses_default",
    title: "Default Session",
    tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
    costUsd: 0,
    messageCount: 0,
    ...overrides,
  };
}

describe("formatQuotaStatsReport (markdown)", () => {
  it("renders a markdown table for models with separator rows", () => {
    const r = makeEmptyResult({
      totals: {
        priced: { input: 1000, output: 2000, reasoning: 0, cache_read: 0, cache_write: 0 },
        unknown: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        costUsd: 1.23,
        messageCount: 2,
        sessionCount: 1,
      },
      bySourceModel: [
        {
          sourceProviderID: "opencode",
          sourceModelID: "claude-opus-4-5-high",
          tokens: { input: 1000, output: 2000, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 1.23,
          messageCount: 2,
        },
        {
          sourceProviderID: "cursor",
          sourceModelID: "gpt-5.2",
          tokens: { input: 10, output: 20, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0.01,
          messageCount: 1,
        },
      ],
    });

    const out = formatQuotaStatsReport({
      title: "最近 7 天 token 用量（/tokens_weekly）",
      result: r,
      topModels: 99,
    });
    expect(out).toMatch(
      /^# 最近 7 天 token 用量（\/tokens_weekly） \d{2}:\d{2} \d{2}\/\d{2}\/\d{4}\n\n/,
    );
    expect(out).toContain("## 模型");
    expect(out).toContain("| 来源");
    // blank separator row between sources
    expect(out).toContain("|          |");
    expect(out).toContain("OpenCode");
    expect(out).toContain("Cursor");
  });

  it("compacts token dialog table headers and middle-ellipsizes long model names when requested", () => {
    const longModel = "openai/gpt-5.2-super-long-context-2026-06-16";
    const r = makeEmptyResult({
      totals: {
        priced: { input: 1000, output: 2000, reasoning: 0, cache_read: 100, cache_write: 50 },
        unknown: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        costUsd: 1.23,
        messageCount: 2,
        sessionCount: 1,
      },
      bySourceModel: [
        {
          sourceProviderID: "openai",
          sourceModelID: longModel,
          tokens: { input: 1000, output: 2000, reasoning: 0, cache_read: 100, cache_write: 50 },
          costUsd: 1.23,
          messageCount: 2,
        },
      ],
    });

    const standard = formatQuotaStatsReport({
      title: "最近 7 天 token 用量（/tokens_weekly）",
      result: r,
    });
    expect(standard).toContain(longModel);
    expect(standard).toContain("缓存读取");
    expect(standard).toContain("缓存写入");
    expect(standard).toContain("缓存读取");

    const compact = formatQuotaStatsReport({
      title: "最近 7 天 token 用量（/tokens_weekly）",
      result: r,
      tableOptions: {
        compactHeaders: true,
        modelNameMaxWidth: 20,
      },
    });

    expect(compact).not.toContain(longModel);
    expect(compact).toContain("openai/gpt…026-06-16");
    expect(compact).toContain("消息");
    expect(compact).toContain("会话");
    expect(compact).toContain("token");
    expect(compact).toContain("输入");
    expect(compact).toContain("输出");
    expect(compact).toContain("缓存读");
    expect(compact).toContain("缓存写");
    expect(compact).not.toContain("缓存读取");
    expect(compact).not.toContain("缓存写入");
    expect(compact).not.toContain("缓存读取");
    expect(compact).not.toContain("缓存写入");
  });

  it("abbreviates antigravity model names before width enforcement", () => {
    const sourceModelID = "antigravity-gemini-3-pro-preview";
    const r = makeEmptyResult({
      totals: {
        priced: { input: 10, output: 20, reasoning: 0, cache_read: 0, cache_write: 0 },
        unknown: { input: 5, output: 6, reasoning: 0, cache_read: 0, cache_write: 0 },
        unpriced: { input: 7, output: 8, reasoning: 0, cache_read: 0, cache_write: 0 },
        costUsd: 0.01,
        messageCount: 3,
        sessionCount: 1,
      },
      bySourceModel: [
        {
          sourceProviderID: "google-antigravity",
          sourceModelID,
          tokens: { input: 10, output: 20, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0.01,
          messageCount: 1,
        },
      ],
      unpriced: [
        {
          key: {
            sourceProviderID: "google-antigravity",
            sourceModelID,
            mappedProvider: "google",
            mappedModel: "gemini-3-pro-preview",
            reason: "snapshot missing model",
          },
          tokens: { input: 7, output: 8, reasoning: 0, cache_read: 0, cache_write: 0 },
          messageCount: 1,
        },
      ],
      unknown: [
        {
          key: {
            sourceProviderID: "google-antigravity",
            sourceModelID,
            mappedProvider: "google",
            mappedModel: "gemini-3-pro-preview",
          },
          tokens: { input: 5, output: 6, reasoning: 0, cache_read: 0, cache_write: 0 },
          messageCount: 1,
        },
      ],
    });

    const out = formatQuotaStatsReport({
      title: "最近 7 天 token 用量（/tokens_weekly）",
      result: r,
      tableOptions: {
        compactHeaders: true,
        modelNameMaxWidth: 20,
      },
    });

    expect(out).not.toContain("antigravity");
    expect(out).toContain("agy-gemini…o-preview");
  });

  it("omits Reasoning column when all reasoning is zero", () => {
    const r = makeEmptyResult({
      totals: {
        priced: { input: 1, output: 1, reasoning: 0, cache_read: 0, cache_write: 0 },
        unknown: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        costUsd: 0,
        messageCount: 1,
        sessionCount: 1,
      },
      bySourceModel: [
        {
          sourceProviderID: "opencode",
          sourceModelID: "gpt-5.2",
          tokens: { input: 1, output: 1, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0,
          messageCount: 1,
        },
      ],
    });

    const out = formatQuotaStatsReport({
      title: "最近 7 天 token 用量（/tokens_weekly）",
      result: r,
      topModels: 99,
    });
    expect(out).not.toContain("推理 token");
  });

  it("sessionOnly mode hides Window/Sessions columns and Top Sessions section", () => {
    const r = makeEmptyResult({
      totals: {
        priced: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
        unknown: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        costUsd: 0.5,
        messageCount: 3,
        sessionCount: 1,
      },
      bySourceModel: [
        {
          sourceProviderID: "opencode",
          sourceModelID: "claude-opus-4-5-high",
          tokens: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0.5,
          messageCount: 3,
        },
      ],
      bySession: [
        {
          sessionID: "ses_123",
          title: "Test Session",
          tokens: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0.5,
          messageCount: 3,
        },
      ],
    });

    const out = formatQuotaStatsReport({
      title: "当前会话 token 用量（/tokens_session）",
      result: r,
      sessionOnly: true,
    });

    // Title should be present
    expect(out).toMatch(
      /^# 当前会话 token 用量（\/tokens_session） \d{2}:\d{2} \d{2}\/\d{2}\/\d{4}\n\n/,
    );

    // Summary table should NOT have Window or Sessions columns
    expect(out).not.toContain("| 时间范围");
    expect(out).not.toContain("| 会话数");

    // Summary table SHOULD have Messages, Tokens, Cost columns
    expect(out).toContain("消息数");
    expect(out).toContain("token");
    expect(out).toContain("费用");

    // Top Sessions section should NOT be present
    expect(out).not.toContain("## 主要会话");
  });

  it("session_tree mode renders a session breakdown and counts zero-usage descendants", () => {
    const r = makeEmptyResult({
      totals: {
        priced: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
        unknown: { input: 5, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        costUsd: 0.5,
        messageCount: 4,
        sessionCount: 2,
      },
      bySourceModel: [
        {
          sourceProviderID: "opencode",
          sourceModelID: "claude-opus-4-5-high",
          tokens: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0.5,
          messageCount: 3,
        },
      ],
      bySession: [
        {
          sessionID: "ses_parent",
          title: "Parent Session",
          tokens: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0.5,
          messageCount: 3,
        },
        {
          sessionID: "ses_child",
          title: "Child Session",
          tokens: { input: 5, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0,
          messageCount: 1,
        },
      ],
    });

    const out = formatQuotaStatsReport({
      title: "会话树 token 用量（/tokens_session_all）",
      result: r,
      reportKind: "session_tree",
      sessionTree: {
        rootSessionID: "ses_parent",
        nodes: [
          { sessionID: "ses_parent", title: "Parent Session", depth: 0 },
          {
            sessionID: "ses_child",
            parentID: "ses_parent",
            title: "Child Session",
            depth: 1,
          },
          {
            sessionID: "ses_grandchild",
            parentID: "ses_child",
            title: "Grandchild Session",
            depth: 2,
          },
        ],
      },
    });

    expect(out).toContain("| 消息数");
    expect(out).toContain("| 会话数");
    expect(out).toContain("## Session Tree");
    expect(out).toContain("当前会话");
    expect(out).toContain("子会话");
    expect(out).toContain("孙会话");
    expect(out).toContain("ses_parent");
    expect(out).toContain("ses_grandchild");
    expect(out).toContain("$0.00");
    expect(out).not.toContain("## 主要会话");
  });

  it("standard mode includes Window/Sessions columns and Top Sessions section", () => {
    const r = makeEmptyResult({
      totals: {
        priced: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
        unknown: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        costUsd: 0.5,
        messageCount: 3,
        sessionCount: 1,
      },
      bySourceModel: [
        {
          sourceProviderID: "opencode",
          sourceModelID: "claude-opus-4-5-high",
          tokens: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0.5,
          messageCount: 3,
        },
      ],
      bySession: [
        {
          sessionID: "ses_123",
          title: "Test Session",
          tokens: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0.5,
          messageCount: 3,
        },
      ],
    });

    const out = formatQuotaStatsReport({
      title: "最近 7 天 token 用量（/tokens_weekly）",
      result: r,
      sessionOnly: false, // explicit false, same as omitting
    });

    // Summary table SHOULD have Window and Sessions columns
    expect(out).toContain("时间范围");
    expect(out).toContain("会话数");

    // Top Sessions section SHOULD be present
    expect(out).toContain("## 主要会话");
    // Marker column should be named and not render as an empty header
    expect(out).toContain("| 当前会话");
    expect(out).toContain("| 会话");
  });

  it("uses a Unicode ellipsis when shortening visible session titles", () => {
    const out = formatQuotaStatsReport({
      title: "最近 7 天 token 用量（/tokens_weekly）",
      result: makeEmptyResult({
        bySession: [
          makeSessionRow({
            sessionID: "ses_long_title",
            title: "abcdefghij-very-long-middle-section-klmnopqrst",
            tokens: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
            costUsd: 0.75,
            messageCount: 4,
          }),
        ],
      }),
    });

    expect(out).toContain("abcdefghij…klmnopqrst");
    expect(out).not.toContain("abcdefghij...klmnopqrst");
  });

  it("does not render a concrete focus session id when the current session is outside the selected window", () => {
    const out = formatQuotaStatsReport({
      title: "最近 7 天 token 用量（/tokens_weekly）",
      result: makeEmptyResult({
        bySession: [
          makeSessionRow({
            sessionID: "ses_visible",
            title: "Visible Session",
            tokens: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
            costUsd: 0.75,
            messageCount: 4,
          }),
        ],
      }),
      focusSessionID: "ses_missing",
    });

    expect(out).toContain("（当前会话不在所选时间范围内）");
    expect(out).toContain("ses_visible");
    expect(out).not.toContain("ses_missing");
    expect(out).not.toContain("No current session");
  });

  it("does not render a concrete focus session id when it has no token usage in the selected window", () => {
    const out = formatQuotaStatsReport({
      title: "最近 7 天 token 用量（/tokens_weekly）",
      result: makeEmptyResult({
        bySession: [
          makeSessionRow({
            sessionID: "ses_zero",
            title: "Zero Session",
            messageCount: 2,
          }),
          makeSessionRow({
            sessionID: "ses_visible",
            title: "Visible Session",
            tokens: { input: 50, output: 75, reasoning: 0, cache_read: 0, cache_write: 0 },
            costUsd: 0.25,
            messageCount: 3,
          }),
        ],
      }),
      focusSessionID: "ses_zero",
    });

    expect(out).toContain("（当前会话在所选时间范围内没有 token 用量）");
    expect(out).toContain("ses_visible");
    expect(out).not.toContain("ses_zero");
  });

  it("filters zero-token session rows from top sessions", () => {
    const out = formatQuotaStatsReport({
      title: "最近 7 天 token 用量（/tokens_weekly）",
      result: makeEmptyResult({
        bySession: [
          makeSessionRow({
            sessionID: "ses_zero",
            title: "Zero Session",
            messageCount: 2,
          }),
          makeSessionRow({
            sessionID: "ses_visible",
            title: "Visible Session",
            tokens: { input: 10, output: 20, reasoning: 0, cache_read: 0, cache_write: 0 },
            costUsd: 0.05,
            messageCount: 1,
          }),
        ],
      }),
    });

    expect(out).toContain("ses_visible");
    expect(out).not.toContain("ses_zero");
  });

  it("shows provider candidates for ambiguous unknown pricing rows", () => {
    const r = makeEmptyResult({
      totals: {
        priced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        unknown: { input: 10, output: 20, reasoning: 0, cache_read: 0, cache_write: 0 },
        unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        costUsd: 0,
        messageCount: 1,
        sessionCount: 1,
      },
      unknown: [
        {
          key: {
            sourceProviderID: "opencode",
            sourceModelID: " foo-model ",
            mappedModel: "foo-model",
            providerCandidates: ["openai", "anthropic"],
          },
          tokens: { input: 10, output: 20, reasoning: 0, cache_read: 0, cache_write: 0 },
          messageCount: 1,
        },
      ],
    });

    const out = formatQuotaStatsReport({
      title: "最近 7 天 token 用量（/tokens_weekly）",
      result: r,
    });

    expect(out).toContain("candidates: openai,anthropic");
    expect(out).toContain("| OpenCode |  foo-model  |");
  });

  it("locks the full markdown report layout for the shared report-document renderer", () => {
    const out = formatQuotaStatsReport({
      title: "最近 7 天 token 用量（/tokens_weekly）",
      generatedAtMs: Date.UTC(2026, 0, 15, 12, 0, 0),
      result: makeEmptyResult({
        window: {},
        totals: {
          priced: { input: 1000, output: 2000, reasoning: 0, cache_read: 0, cache_write: 0 },
          unknown: { input: 10, output: 20, reasoning: 0, cache_read: 0, cache_write: 0 },
          unpriced: { input: 30, output: 40, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 1.23,
          messageCount: 6,
          sessionCount: 2,
        },
        bySourceModel: [
          {
            sourceProviderID: "opencode",
            sourceModelID: "claude-opus-4-5-high",
            tokens: { input: 1000, output: 2000, reasoning: 0, cache_read: 0, cache_write: 0 },
            costUsd: 1.23,
            messageCount: 2,
          },
        ],
        bySession: [
          {
            sessionID: "ses_123",
            title: "Test Session",
            tokens: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
            costUsd: 0.5,
            messageCount: 3,
          },
        ],
        unpriced: [
          {
            key: {
              sourceProviderID: "cursor",
              sourceModelID: "foo-model",
              mappedProvider: "openai",
              mappedModel: "foo-model",
              reason: "snapshot missing model",
            },
            tokens: { input: 30, output: 40, reasoning: 0, cache_read: 0, cache_write: 0 },
            messageCount: 1,
          },
        ],
        unknown: [
          {
            key: {
              sourceProviderID: "opencode",
              sourceModelID: "bar-model",
              mappedProvider: "openai",
              mappedModel: "bar-model",
              providerCandidates: ["openai", "anthropic"],
            },
            tokens: { input: 10, output: 20, reasoning: 0, cache_read: 0, cache_write: 0 },
            messageCount: 1,
          },
        ],
      }),
    });

    const [heading, blank, ...body] = out.split("\n");
    expect(heading).toMatch(
      /^# 最近 7 天 token 用量（\/tokens_weekly） \d{2}:\d{2} \d{2}\/\d{2}\/\d{4}$/,
    );
    expect(blank).toBe("");

    expect(body.join("\n")).toMatchInlineSnapshot(`
      "| 时间范围 | 消息数 | 会话数 | token |    费用 |
      | ---- | ---: | ---: | ----: | ----: |
      | 全部时间 |   6 |   2 |  3.1K | $1.23 |

      定价快照：bundled（未记录）

      ## 模型

      | 来源       | 模型                   |   输入 |   输出 | 缓存读取 | 缓存写入 |   总计 |    费用 |
      | -------- | -------------------- | ---: | ---: | ---: | ---: | ---: | ----: |
      | OpenCode | claude-opus-4-5-high | 1.0K | 2.0K |    0 |    0 | 3.0K | $1.23 |

      ## 主要会话

      | 当前会话 | 会话      |    费用 | token | 消息数 | 标题           |
      | ---- | ------- | ----: | ----: | ---: | ------------ |
      |      | ses_123 | $0.50 |   300 |   3 | Test Session |

      ## 未定价模型

      | 来源     | 模型        | 已映射              | 原因                     | token | 消息数 |
      | ------ | --------- | ---------------- | ---------------------- | ----: | ---: |
      | Cursor | foo-model | openai/foo-model | snapshot missing model |    70 |   1 |

      ## 未知价格

      | 来源       | 模型        | 已映射                                             | token | 消息数 |
      | -------- | --------- | ----------------------------------------------- | ----: | ---: |
      | OpenCode | bar-model | openai/bar-model (candidates: openai,anthropic) |    30 |   1 |

      运行 /quota_status 查看完整的价格诊断报告。"
    `);
  });

  it("renders the pricing snapshot identity used for the estimates", () => {
    const out = formatQuotaStatsReport({
      title: "最近 7 天 token 用量（/tokens_weekly）",
      result: makeEmptyResult({
        pricing: { source: "runtime", generatedAt: 0, units: "USD per 1M tokens" },
      }),
    });
    expect(out).toContain("定价快照：runtime（未记录）");
  });

  it("renders the snapshot generation time when one exists", () => {
    const out = formatQuotaStatsReport({
      title: "最近 7 天 token 用量（/tokens_weekly）",
      generatedAtMs: Date.UTC(2026, 0, 15, 12, 0, 0),
      result: makeEmptyResult({
        pricing: {
          source: "runtime",
          generatedAt: Date.UTC(2026, 0, 15, 10, 0, 0),
          units: "USD per 1M tokens",
        },
      }),
    });
    expect(out).toContain("定价快照：runtime（");
    expect(out).toMatch(/定价快照：runtime（\d{2}:\d{2} \d{4}-\d{2}-\d{2}）/u);
  });

  it("shows 本会话/子代理/任务树合计 as separate task-tree totals", () => {
    const r = makeEmptyResult({
      totals: {
        priced: { input: 110, output: 220, reasoning: 0, cache_read: 0, cache_write: 0 },
        unknown: { input: 5, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        unpriced: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
        costUsd: 0.55,
        messageCount: 5,
        sessionCount: 3,
      },
      bySession: [
        {
          sessionID: "ses_parent",
          title: "Parent Session",
          tokens: { input: 100, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0.5,
          messageCount: 3,
        },
        {
          sessionID: "ses_child",
          title: "Child Session",
          tokens: { input: 10, output: 20, reasoning: 0, cache_read: 0, cache_write: 0 },
          costUsd: 0.05,
          messageCount: 2,
        },
      ],
    });

    const out = formatQuotaStatsReport({
      title: "会话树 token 用量（/tokens_session_all）",
      result: r,
      reportKind: "session_tree",
      sessionTree: {
        rootSessionID: "ses_parent",
        nodes: [
          { sessionID: "ses_parent", title: "Parent Session", depth: 0 },
          { sessionID: "ses_child", parentID: "ses_parent", title: "Child Session", depth: 1 },
          {
            sessionID: "ses_grandchild",
            parentID: "ses_child",
            title: "Grandchild Session",
            depth: 2,
          },
        ],
      },
    });

    expect(out).toContain("| 本会话");
    expect(out).toContain("| 子代理");
    expect(out).toContain("| 任务树合计");
    // Root session row: 3 messages, 1 session, 300 tokens, $0.50.
    expect(out).toMatch(/\| 本会话 +\|\s+3 +\|\s+1 +\|\s+300 +\|\s+\$0\.50 +\|\n/u);
    // Subagents: only the child has usage (grandchild is zero-usage); both
    // descendant sessions are still counted as sessions.
    expect(out).toMatch(/\| 子代理 +\|\s+2 +\|\s+2 +\|\s+30 +\|\s+\$0\.05 +\|\n/u);
    // Task-tree total: 5 messages across 3 sessions.
    expect(out).toMatch(/\| 任务树合计 +\|\s+5 +\|\s+3 +\|\s+330 +\|\s+\$0\.55 +\|\n/u);
  });
});
