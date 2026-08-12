/**
 * Ticket 02 shared sample inputs for the Chinese runtime golden fixtures.
 *
 * These samples are deliberately implementation-neutral: they describe
 * provider-normalized runtime data (quota entries, aggregated token stats,
 * session token models, compact-status render data, and a synthetic
 * models.dev API payload). Both the one-time capture script
 * (scripts/capture-runtime-golden.mjs, executed against the pre-Ticket-01
 * runtime dist) and the runtime-boundary test (tests/runtime-golden.test.ts,
 * executed against src) use exactly the same samples, so fixture equality
 * proves that source behavior reproduces the pre-existing runtime output.
 *
 * All wall-clock dependent values are derived from FIXED_NOW so the capture
 * step (plain Node) and the vitest step (fake timers) observe the same clock.
 */

export const FIXED_NOW_MS = Date.parse("2026-08-11T12:00:00.000Z");

export const fixedNowIso = (offsetMs) => new Date(FIXED_NOW_MS + offsetMs).toISOString();

const accounting = (resultType, sourceId, extra = {}) => ({
  resultType,
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
  sourceId,
  ...extra,
});

/** /quota verbose command sample: percent rows, value rows, errors, session tokens. */
export const quotaCommandSample = {
  generatedAtMs: FIXED_NOW_MS,
  entries: [
    {
      kind: "percent",
      name: "[Copilot] 5h:",
      label: "5h:",
      group: "GitHub Copilot",
      percentRemaining: 62,
      resetTimeIso: fixedNowIso(2 * 86_400_000 + 5 * 3_600_000),
      right: "186/300",
      accounting: accounting("quota", "copilot"),
    },
    {
      kind: "percent",
      name: "Usage:",
      label: "Usage:",
      group: "GitHub Copilot",
      percentRemaining: 25,
      accounting: accounting("usage", "copilot"),
    },
    {
      kind: "percent",
      name: "Weekly:",
      label: "Weekly:",
      group: "OpenAI",
      percentRemaining: 80,
      resetTimeIso: fixedNowIso(90_000),
      accounting: accounting("quota", "openai"),
    },
    {
      kind: "percent",
      name: "Budget:",
      label: "Budget:",
      group: "OpenAI",
      percentRemaining: 10,
      accounting: accounting("budget", "openai"),
    },
    {
      kind: "value",
      name: "[OpenCode Go] Balance:",
      label: "Balance:",
      group: "OpenCode Go",
      value: "$42.50",
      accounting: accounting("balance", "opencode-go"),
    },
    {
      kind: "value",
      name: "Status",
      label: "Status",
      value: "Active",
      accounting: accounting("status", "opencode-go"),
    },
    {
      kind: "percent",
      name: "Monthly spend:",
      label: "Monthly spend:",
      group: "Anthropic",
      percentRemaining: 55,
      resetTimeIso: fixedNowIso(-3_600_000),
      accounting: accounting("spend", "anthropic"),
    },
  ],
  errors: [{ label: "Anthropic", message: "Quota unavailable via local Claude CLI or Claude OAuth fallback" }],
  sessionTokens: {
    models: [
      { modelID: "claude-3-5-sonnet-20241022", input: 1234, cachedInput: 500, output: 200 },
      { modelID: "gpt-4o-mini", input: 15000, output: 3000 },
    ],
    totalInput: 16234,
    totalCachedInput: 500,
    totalOutput: 3200,
  },
};

/** /tokens_* aggregated report sample (standard + session + session_tree variants). */
export const statsReportSample = {
  title: "最近 7 天 token 用量（/tokens_weekly）",
  generatedAtMs: FIXED_NOW_MS,
  result: {
    window: { sinceMs: FIXED_NOW_MS - 7 * 86_400_000, untilMs: FIXED_NOW_MS },
    totals: {
      priced: { input: 1234567, output: 234567, reasoning: 12000, cache_read: 300000, cache_write: 50000 },
      unknown: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
      unpriced: { input: 1000, output: 500, reasoning: 0, cache_read: 0, cache_write: 0 },
      costUsd: 12.34,
      messageCount: 567,
      sessionCount: 12,
    },
    bySourceModel: [
      {
        sourceProviderID: "opencode",
        sourceModelID: "claude-3-5-sonnet",
        tokens: { input: 1000000, output: 200000, reasoning: 12000, cache_read: 300000, cache_write: 50000 },
        costUsd: 8.88,
        messageCount: 400,
      },
      {
        sourceProviderID: "opencode",
        sourceModelID: "gpt-4o-mini",
        tokens: { input: 234567, output: 34567, reasoning: 0, cache_read: 0, cache_write: 0 },
        costUsd: 3.46,
        messageCount: 167,
      },
    ],
    bySession: [
      {
        sessionID: "ses_current",
        title: "Implement Ticket 02",
        tokens: { input: 500000, output: 100000, reasoning: 5000, cache_read: 100000, cache_write: 20000 },
        costUsd: 4.2,
        messageCount: 200,
      },
      {
        sessionID: "ses_old",
        title: "旧会话标题",
        tokens: { input: 700000, output: 130000, reasoning: 7000, cache_read: 200000, cache_write: 30000 },
        costUsd: 8.0,
        messageCount: 350,
      },
    ],
    unknown: [
      {
        key: {
          sourceProviderID: "opencode",
          sourceModelID: "unknown-model-x",
          mappedProvider: "openai",
          mappedModel: "gpt-4o-mini",
          providerCandidates: ["openai", "google"],
        },
        tokens: { input: 100, output: 50, reasoning: 0, cache_read: 0, cache_write: 0 },
        messageCount: 3,
      },
    ],
    unpriced: [
      {
        key: {
          sourceProviderID: "opencode",
          sourceModelID: "local-model",
          mappedProvider: "anthropic",
          mappedModel: "claude-3-5-sonnet",
          reason: "missing_model",
        },
        tokens: { input: 1000, output: 500, reasoning: 0, cache_read: 0, cache_write: 0 },
        messageCount: 9,
      },
    ],
  },
  focusSessionID: "ses_current",
  tableOptions: { compactHeaders: false },
};

export const statsReportCompactSample = {
  title: "最近 30 天 token 用量（/tokens_monthly）",
  generatedAtMs: FIXED_NOW_MS,
  result: statsReportSample.result,
  tableOptions: { compactHeaders: true, modelNameMaxWidth: 12 },
};

export const statsReportSessionSample = {
  title: "当前会话 token 用量（/tokens_session）",
  generatedAtMs: FIXED_NOW_MS,
  result: statsReportSample.result,
  reportKind: "session",
  tableOptions: { compactHeaders: false },
};

/** format-utils samples. */
export const formatUtilsSample = {
  formatDisplayedPercentLabel: [
    [62, undefined],
    [25, "used"],
    [80, "remaining"],
  ],
  formatTokenCount: [500, 1500, 15000, 1500000, 0],
  formatResetCountdown: [
    { iso: fixedNowIso(-60_000), opts: undefined },
    { iso: fixedNowIso(2 * 86_400_000 + 5 * 3_600_000 + 30 * 60_000), opts: undefined },
    { iso: fixedNowIso(3 * 3_600_000 + 45 * 60_000), opts: undefined },
    { iso: fixedNowIso(45_000), opts: undefined },
    { iso: fixedNowIso(13 * 86_400_000 + 5 * 3_600_000), opts: { compactRounded: true } },
    { iso: fixedNowIso(2 * 3_600_000 + 14 * 60_000), opts: { compactRounded: true } },
    { iso: fixedNowIso(14 * 60_000), opts: { compactRounded: true } },
    { iso: fixedNowIso(30 * 60_000), opts: { compactRounded: true } },
    { iso: fixedNowIso(90 * 60_000), opts: { compactRounded: true } },
    { iso: fixedNowIso(2 * 86_400_000 + 12 * 3_600_000), opts: { compactRounded: true, decimals: 2 } },
    { iso: undefined, opts: { missing: "-" } },
  ],
};

/** session-tokens-format samples. */
export const sessionTokensSample = {
  sessionTokens: {
    models: [
      { modelID: "claude-3-5-sonnet-20241022", input: 1234, cachedInput: 500, output: 200 },
      { modelID: "gpt-4o-mini", input: 15000, output: 3000 },
    ],
    totalInput: 16234,
    totalCachedInput: 500,
    totalOutput: 3200,
  },
  renderWide: { maxWidth: 45 },
  renderNarrow: { maxWidth: 28 },
  renderVeryNarrow: { maxWidth: 12 },
  sidebarSummary: { maxWidth: 40, variant: "sidebar_summary" },
};

/** compact status sample (QuotaRenderData). */
export const compactStatusSample = {
  data: {
    entries: [
      {
        kind: "percent",
        name: "[Copilot] 5h:",
        label: "5h:",
        group: "GitHub Copilot",
        percentRemaining: 62,
        accounting: accounting("quota", "copilot"),
      },
      {
        kind: "percent",
        name: "OpenAI",
        percentRemaining: 80,
        accounting: accounting("quota", "openai"),
      },
      {
        kind: "value",
        name: "[OpenCode Go] Balance:",
        label: "Balance:",
        value: "$42.50",
        accounting: accounting("balance", "opencode-go"),
      },
    ],
    errors: [{ label: "Anthropic", message: "rate limit hit" }],
    sessionTokens: {
      models: [{ modelID: "claude-3-5-sonnet", input: 1234, cachedInput: 500, output: 200 }],
      totalInput: 1234,
      totalCachedInput: 500,
      totalOutput: 200,
    },
  },
  maxWidth: 96,
};

export const compactStatusNarrowSample = {
  data: {
    entries: [
      {
        kind: "percent",
        name: "[Copilot] 5h:",
        label: "5h:",
        group: "GitHub Copilot",
        percentRemaining: 62,
        accounting: accounting("quota", "copilot"),
      },
    ],
    errors: [
      { label: "Anthropic", message: "rate limit hit" },
      { label: "OpenAI", message: "temporary error" },
      { label: "Google", message: "auth expired" },
    ],
    sessionTokens: {
      models: [{ modelID: "claude-3-5-sonnet", input: 1234, cachedInput: 500, output: 200 }],
      totalInput: 1234,
      totalCachedInput: 500,
      totalOutput: 200,
    },
  },
  maxWidth: 40,
};

export const compactStatusErrorOnlySample = {
  data: {
    entries: [],
    errors: [{ label: "Anthropic", message: "rate limit hit" }],
  },
  maxWidth: 96,
};

/** Synthetic models.dev API payload (raw api.json shape: per-model `cost`). */
export const syntheticModelsDevApi = {
  _meta: {
    source: "https://models.dev/api.json",
    generatedAt: FIXED_NOW_MS / 1000,
    providers: ["deepseek", "openai"],
    units: "USD per 1M tokens",
  },
  deepseek: {
    models: {
      "deepseek-chat": { cost: { input: 0.27, output: 1.1, cache_read: 0.07, reasoning: 0.5 } },
      "deepseek-reasoner": { cost: { input: 0.55, output: 2.19, reasoning: 0.9 } },
    },
  },
  openai: {
    models: {
      "gpt-4o-mini": { cost: { input: 0.15, output: 0.6, cache_read: 0.03, cache_write: 0.2 } },
    },
  },
};
