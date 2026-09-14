import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import type {
  AccountingMetadata,
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import {
  OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR,
  queryOpenCodeZenQuota,
} from "../lib/opencode-zen.js";
import {
  DEFAULT_OPENCODE_ZEN_CONFIG_CACHE_MAX_AGE_MS,
  getOpenCodeZenConfigDiagnostics,
  resolveOpenCodeZenConfigCached,
} from "../lib/opencode-zen-config.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import {
  attemptedErrorResult,
  attemptedResult,
  configStatusDetails,
  notAttemptedResult,
  withStatusDetails,
} from "./result-helpers.js";

const OPENCODE_PROVIDER_LABEL = "OpenCode";
const OPENCODE_ZEN_GROUP = "OpenCode Zen";
const OPENCODE_ZEN_BALANCE_ACCOUNTING: AccountingMetadata = {
  resultType: "balance",
  acquisitionMethod: "dashboard_scrape",
  ownership: "maintained",
  authority: "provider_reported",
};
const OPENCODE_ZEN_BUDGET_ACCOUNTING: AccountingMetadata = {
  resultType: "budget",
  acquisitionMethod: "dashboard_scrape",
  ownership: "maintained",
  authority: "locally_derived",
};
const OPENCODE_ZEN_STATUS_ACCOUNTING: AccountingMetadata = {
  resultType: "status",
  acquisitionMethod: "dashboard_scrape",
  ownership: "maintained",
  authority: "provider_reported",
};
const USD_UNIT = { kind: "currency", code: "USD" } as const;

function zenUsdDecimal(value: number): string {
  const fixed = value.toFixed(8);
  return fixed.replace(/0+$/u, "").replace(/\.$/u, "");
}

export const opencodeZenProvider: QuotaProvider = {
  id: "opencode",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    const config = await resolveOpenCodeZenConfigCached({
      maxAgeMs: DEFAULT_OPENCODE_ZEN_CONFIG_CACHE_MAX_AGE_MS,
    });
    return config.state === "configured";
  },

  matchesCurrentModel(model: string): boolean {
    const [provider] = model.toLowerCase().split("/", 2);
    return normalizeQuotaProviderId(provider) === "opencode";
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const diagnostics = await getOpenCodeZenConfigDiagnostics();
    const statusDetails = configStatusDetails({
      ...diagnostics,
      error: diagnostics.error ? sanitizeDisplayText(diagnostics.error) : undefined,
    });
    const config = await resolveOpenCodeZenConfigCached({
      maxAgeMs: DEFAULT_OPENCODE_ZEN_CONFIG_CACHE_MAX_AGE_MS,
    });

    if (config.state === "none") return withStatusDetails(notAttemptedResult(), statusDetails);

    if (config.state === "incomplete") {
      return withStatusDetails(
        attemptedErrorResult(
          OPENCODE_PROVIDER_LABEL,
          `Missing ${config.missing} (source: ${config.source})`,
        ),
        statusDetails,
      );
    }

    if (config.state === "invalid") {
      return withStatusDetails(
        attemptedErrorResult(
          OPENCODE_PROVIDER_LABEL,
          `Invalid config (${config.source}): ${config.error}`,
        ),
        statusDetails,
      );
    }

    const result = await queryOpenCodeZenQuota(
      config.config.workspaceId,
      config.config.authCookie,
      {
        requestTimeoutMs: ctx.config?.requestTimeoutMsConfigured
          ? ctx.config.requestTimeoutMs
          : undefined,
      },
    );

    if (!result.success) {
      return withStatusDetails(attemptedErrorResult(OPENCODE_PROVIDER_LABEL, result.error), [
        ...statusDetails,
        { key: "live_fetch_error", value: result.error },
      ]);
    }

    const balanceUsd = result.data.balance / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;
    const configuredMonthlyLimit = ctx.config?.opencodeMonthlyLimit;
    const effectiveMonthlyLimit = configuredMonthlyLimit ?? result.data.monthlyLimit;
    const monthlyUsageUsd =
      result.data.monthlyUsage === null
        ? null
        : result.data.monthlyUsage / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;

    const hasMonthlyBudget =
      effectiveMonthlyLimit !== null &&
      Number.isFinite(effectiveMonthlyLimit) &&
      effectiveMonthlyLimit > 0 &&
      monthlyUsageUsd !== null &&
      Number.isFinite(monthlyUsageUsd) &&
      monthlyUsageUsd >= 0;
    const entries: QuotaToastEntry[] = [];

    if (hasMonthlyBudget) {
      const monthlyRemainingUsd = Math.max(0, effectiveMonthlyLimit - monthlyUsageUsd);
      entries.push({
        accounting: OPENCODE_ZEN_BUDGET_ACCOUNTING,
        name: "zen-monthly-budget",
        group: OPENCODE_ZEN_GROUP,
        percentRemaining: Math.min(100, (monthlyRemainingUsd / effectiveMonthlyLimit) * 100),
        semantic: {
          metric: { kind: "window", window: "month" },
          prominence: "primary",
        },
        basis: {
          used: {
            quantity: { decimal: zenUsdDecimal(monthlyUsageUsd), unit: USD_UNIT },
            authority: "provider_reported",
          },
          limit: {
            quantity: { decimal: zenUsdDecimal(effectiveMonthlyLimit), unit: USD_UNIT },
            authority:
              configuredMonthlyLimit === undefined ? "provider_reported" : "user_configured",
          },
          remaining: {
            quantity: { decimal: zenUsdDecimal(monthlyRemainingUsd), unit: USD_UNIT },
            authority: "locally_derived",
          },
        },
      });
    }

    entries.push({
      accounting: OPENCODE_ZEN_BALANCE_ACCOUNTING,
      kind: "quantity",
      name: "zen-current-balance",
      group: OPENCODE_ZEN_GROUP,
      semantic: {
        metric: { kind: "component", component: "current_balance" },
        prominence: hasMonthlyBudget ? "supplementary" : "primary",
      },
      quantity: { decimal: zenUsdDecimal(balanceUsd), unit: USD_UNIT },
    });
    entries.push({
      accounting: OPENCODE_ZEN_STATUS_ACCOUNTING,
      kind: "boolean",
      name: "zen-auto-reload",
      group: OPENCODE_ZEN_GROUP,
      semantic: {
        metric: { kind: "component", component: "auto_reload" },
        prominence: "supplementary",
      },
      value: result.data.reload,
    });

    return withStatusDetails(attemptedResult(entries), [
      ...statusDetails,
      { key: "balance_usd", value: `USD ${zenUsdDecimal(balanceUsd)}` },
      {
        key: "monthly_limit_usd",
        value:
          result.data.monthlyLimit === null
            ? "(none)"
            : `USD ${zenUsdDecimal(result.data.monthlyLimit)}`,
      },
      {
        key: "last_payment_usd",
        value:
          result.data.lastPayment === null
            ? "(none)"
            : `USD ${zenUsdDecimal(result.data.lastPayment)}`,
      },
      { key: "auto_reload", value: result.data.reload ? "true" : "false" },
      {
        key: "auto_reload_amount_raw",
        value: result.data.reloadAmount === null ? "(none)" : String(result.data.reloadAmount),
      },
      {
        key: "auto_reload_trigger_raw",
        value: result.data.reloadTrigger === null ? "(none)" : String(result.data.reloadTrigger),
      },
    ]);
  },
};
