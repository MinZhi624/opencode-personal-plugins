/** DeepSeek: the exact balances /user/balance reports, per currency. */

import { API_KEY_VENDORS, hasApiKey } from "../lib/api-key-resolver.js";
import { queryDeepSeekBalance } from "../lib/deepseek.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import {
  type AccountResult,
  failedAccount,
  keySlug,
  type ProviderFetchResult,
  type ProviderRow,
} from "./contract.js";
import { apiKeyVendorDetails } from "./result-helpers.js";

const LABEL = "DeepSeek";

const BALANCE_COMPONENTS = [
  ["total_balance", "totalBalance", "余额", "primary"],
  ["granted_balance", "grantedBalance", "已授予", "supplementary"],
  ["topped_up_balance", "toppedUpBalance", "已充值", "supplementary"],
] as const;

type DeepSeekBalanceSuccess = Extract<
  NonNullable<Awaited<ReturnType<typeof queryDeepSeekBalance>>>,
  { success: true }
>;

function deepseekAccounts(result: DeepSeekBalanceSuccess): AccountResult[] {
  const rows: ProviderRow[] = [];
  for (const info of result.balanceInfos) {
    for (const [component, field, label, prominence] of BALANCE_COMPONENTS) {
      const decimal = info[field];
      if (decimal === undefined) continue;
      rows.push({
        key: `${component}.${keySlug(info.currency)}`,
        label,
        type: "balance",
        method: "remote_api",
        authority: "provider_reported",
        prominence,
        amount: { decimal, unit: { kind: "currency", code: info.currency } },
      });
    }
  }

  // Without any total balance, the availability flag stands in for it.
  const hasTotalBalance = result.balanceInfos.some((info) => info.totalBalance !== undefined);
  if (!hasTotalBalance && result.isAvailable !== undefined) {
    rows.push({
      key: "available",
      label: "可用",
      type: "status",
      method: "remote_api",
      authority: "provider_reported",
      prominence: "primary",
      flag: result.isAvailable,
    });
  }

  return [
    { name: LABEL, rows, errors: [] },
    ...result.parseIssues.map((issue) =>
      failedAccount(`${LABEL} ${issue.currency}`, `${issue.field} returned an invalid decimal`),
    ),
  ];
}

export const deepseekProvider: QuotaProvider = {
  id: "deepseek",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "deepseek",
      fallbackOnError: false,
    });
    if (providerAvailable) return true;

    return await hasApiKey(API_KEY_VENDORS.deepseek);
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["deepseek"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const debug = await apiKeyVendorDetails(API_KEY_VENDORS.deepseek);

    const result = await queryDeepSeekBalance({ requestTimeoutMs: ctx.config?.requestTimeoutMs });
    if (!result) return { attempted: false, accounts: [], debug };
    if (!result.success) {
      return { attempted: true, accounts: [failedAccount(LABEL, result.error)], debug };
    }
    return { attempted: true, accounts: deepseekAccounts(result), debug };
  },
};
