import type { AmountUnit } from "../core/types.js";
import { sanitizeSingleLineDisplaySnippet } from "../lib/display-sanitize.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import type {
  MimoBalance,
  MimoDashboardResult,
  MimoEndpointResult,
  MimoPlanDetail,
} from "../lib/mimo.js";
import { queryMimoDashboard } from "../lib/mimo.js";
import { getMimoConfigDiagnostics, resolveMimoConfigCached } from "../lib/mimo-config.js";
import { getQuotaProviderRuntimeIds } from "../lib/provider-metadata.js";
import { accountingDecimalFromNumber } from "./accounting-decimal.js";
import {
  type AccountResult,
  failedAccount,
  MONTHLY,
  type ProviderFetchResult,
  type ProviderRow,
} from "./contract.js";
import { configStatusDetails } from "./result-helpers.js";

const MIMO_LABEL = "Xiaomi MiMo";
const MIMO_RUNTIME_IDS = new Set(getQuotaProviderRuntimeIds("xiaomi"));
const TOKEN_UNIT = { kind: "count", unit: "token" } as const;
const MIMO_ROW = { method: "dashboard_scrape", authority: "provider_reported" } as const;

function getPlanDisplay(detail: MimoEndpointResult<MimoPlanDetail>): string | null {
  if (detail.state !== "success" || detail.data.expired) return null;

  const planName = detail.data.planName
    ? sanitizeSingleLineDisplaySnippet(detail.data.planName, 40)
    : "";
  const planCode = detail.data.planCode
    ? sanitizeSingleLineDisplaySnippet(detail.data.planCode, 32)
    : "";

  if (planName && planCode && planName.toLowerCase() !== planCode.toLowerCase()) {
    return `${planName} [${planCode}]`;
  }
  return planName || planCode || null;
}

function balanceRows(balance: MimoBalance): ProviderRow[] {
  const unit: AmountUnit = balance.currency
    ? { kind: "currency", code: balance.currency }
    : { kind: "count", unit: "credit" };
  const components = [
    { key: "total_balance", label: "余额", amount: balance.total, prominence: "primary" },
    { key: "cash_balance", label: "现金", amount: balance.cash, prominence: "supplementary" },
    { key: "gift_balance", label: "赠送", amount: balance.gift, prominence: "supplementary" },
  ] as const;
  return components.flatMap(({ key, label, amount, prominence }) =>
    amount === null
      ? []
      : [
          {
            ...MIMO_ROW,
            key,
            label,
            type: "balance",
            prominence,
            amount: { decimal: accountingDecimalFromNumber(amount), unit },
          } as const,
        ],
  );
}

/** The plan's account (named after the plan when it has one), then each failed endpoint. */
function mimoAccounts(result: MimoDashboardResult): AccountResult[] {
  const plan = getPlanDisplay(result.detail);
  const rows: ProviderRow[] = [];
  if (
    result.usage.state === "success" &&
    !(result.detail.state === "success" && result.detail.data.expired)
  ) {
    const { used, limit } = result.usage.data;
    rows.push({
      ...MIMO_ROW,
      key: "monthly_tokens",
      label: MONTHLY.label,
      window: MONTHLY.window,
      type: "quota",
      prominence: "primary",
      percentRemaining: 100 - (used / limit) * 100,
      used: { decimal: accountingDecimalFromNumber(used), unit: TOKEN_UNIT },
      limit: { decimal: accountingDecimalFromNumber(limit), unit: TOKEN_UNIT },
    });
  }
  if (result.balance.state === "success") rows.push(...balanceRows(result.balance.data));

  return [
    { name: plan ? `${MIMO_LABEL}: ${plan}` : MIMO_LABEL, rows, errors: [] },
    ...[result.usage, result.detail, result.balance].flatMap((endpoint) =>
      endpoint.state === "error" ? [failedAccount(MIMO_LABEL, endpoint.error)] : [],
    ),
  ];
}

export const xiaomiProvider: QuotaProvider = {
  id: "xiaomi",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    const config = await resolveMimoConfigCached();
    return config.state === "configured";
  },

  matchesCurrentModel(model: string): boolean {
    const [provider] = model.trim().toLowerCase().split("/", 2);
    return MIMO_RUNTIME_IDS.has(provider);
  },

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const diagnostics = await getMimoConfigDiagnostics();
    const debug = configStatusDetails({
      ...diagnostics,
      error: diagnostics.error
        ? sanitizeSingleLineDisplaySnippet(diagnostics.error, 120)
        : undefined,
    });
    const config = await resolveMimoConfigCached();

    if (config.state === "none") return { attempted: false, accounts: [], debug };
    if (config.state === "invalid") {
      return {
        attempted: true,
        accounts: [failedAccount(MIMO_LABEL, `Invalid config (${config.source}): ${config.error}`)],
        debug,
      };
    }

    const result = await queryMimoDashboard(config.config.cookie, {
      requestTimeoutMs: ctx.config?.requestTimeoutMsConfigured
        ? ctx.config.requestTimeoutMs
        : undefined,
    });
    return { attempted: true, accounts: mimoAccounts(result), debug };
  },
};
