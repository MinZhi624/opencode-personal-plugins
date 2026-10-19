import type { Amount } from "../core/types.js";
import { API_KEY_VENDORS, hasApiKey } from "../lib/api-key-resolver.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { fmtUsdAmount } from "../lib/format-utils.js";
import { type KiloQuotaResult, queryKiloQuota } from "../lib/kilo.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import { accountingDecimalFromNumber } from "./accounting-decimal.js";
import { failedAccount, type ProviderFetchResult, type ProviderRow } from "./contract.js";
import { apiKeyVendorDetails, statusDetailsFromRecord } from "./result-helpers.js";

const LABEL = "Kilo Gateway";

type KiloPassSuccess = Extract<NonNullable<KiloQuotaResult>, { success: true; mode: "kilo_pass" }>;

function usd(value: number): Amount {
  return { decimal: accountingDecimalFromNumber(value), unit: { kind: "currency", code: "USD" } };
}

/** The Kilo Pass credits: percent left of base plus bonus credits, else the USD left. */
function passCreditsRow(state: KiloPassSuccess): ProviderRow {
  const totalCreditsUsd = state.baseCreditsUsd + state.bonusCreditsUsd;
  const row = {
    key: "pass_credits",
    label: "Pass 额度",
    type: "quota",
    method: "remote_api",
    authority: "locally_derived",
    prominence: "primary",
    ...(state.resetTimeIso ? { resetsAt: state.resetTimeIso } : {}),
  } as const;
  if (totalCreditsUsd > 0) {
    return {
      ...row,
      percentRemaining: Math.min(
        100,
        Math.max(0, ((totalCreditsUsd - state.usageUsd) / totalCreditsUsd) * 100),
      ),
      used: usd(state.usageUsd),
      limit: usd(totalCreditsUsd),
      remaining: usd(state.remainingUsd),
    };
  }
  return { ...row, amount: usd(state.remainingUsd) };
}

export const kiloProvider: QuotaProvider = {
  id: "kilo",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    return await hasApiKey(API_KEY_VENDORS.kilo);
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderMatchesRuntimeId(model, "kilo");
  },

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const keyDetails = await apiKeyVendorDetails(API_KEY_VENDORS.kilo);

    const state = await queryKiloQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });
    if (!state) return { attempted: false, accounts: [], debug: keyDetails };
    if (!state.success) {
      return { attempted: true, accounts: [failedAccount(LABEL, state.error)], debug: keyDetails };
    }

    if (state.mode === "kilo_pass") {
      return {
        attempted: true,
        accounts: [{ name: LABEL, rows: [passCreditsRow(state)], errors: [] }],
        debug: [
          ...keyDetails,
          ...statusDetailsFromRecord({
            accounting_mode: "kilo_pass",
            base_credits_usd: fmtUsdAmount(state.baseCreditsUsd),
            usage_usd: fmtUsdAmount(state.usageUsd),
            bonus_credits_usd: fmtUsdAmount(state.bonusCreditsUsd),
            remaining_usd: fmtUsdAmount(state.remainingUsd),
            overage_usd: fmtUsdAmount(state.overageUsd),
            reset_at: state.resetTimeIso ?? "(none)",
          }),
        ],
      };
    }

    const balanceRow: ProviderRow = {
      key: "balance",
      label: "余额",
      type: "balance",
      method: "remote_api",
      authority: "provider_reported",
      prominence: "primary",
      amount: usd(state.balanceUsd),
    };
    return {
      attempted: true,
      accounts: [{ name: LABEL, rows: [balanceRow], errors: [] }],
      debug: [
        ...keyDetails,
        ...statusDetailsFromRecord({
          accounting_mode: "gateway_balance",
          balance_usd: fmtUsdAmount(state.balanceUsd),
        }),
      ],
    };
  },
};
