import type { Amount } from "../core/types.js";
import { API_KEY_VENDORS, hasApiKey } from "../lib/api-key-resolver.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { queryOllamaCloudQuota } from "../lib/ollama-cloud.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import type { OllamaCloudIncludedCredits } from "../lib/types.js";
import { accountingDecimalFromNumber } from "./accounting-decimal.js";
import {
  failedAccount,
  MONTHLY,
  type ProviderFetchResult,
  type ProviderRow,
  quotaRow,
  WEEKLY,
} from "./contract.js";
import { apiKeyVendorDetails, statusDetailsFromRecord } from "./result-helpers.js";

const LABEL = "Ollama Cloud";
const SESSION = { key: "session", label: "会话", window: "session" } as const;
const NO_DATA = "Ollama Cloud returned no limits or balance";

function usd(value: number): Amount {
  return { decimal: accountingDecimalFromNumber(value), unit: { kind: "currency", code: "USD" } };
}

/** A credit plan's included credits: the share left this monthly period, with its USD. */
function includedCreditsRow(
  included: OllamaCloudIncludedCredits,
  percentRemaining: number,
): ProviderRow {
  const remainingUsd = Math.max(0, included.balanceUsd);
  return {
    ...MONTHLY,
    type: "quota",
    method: "remote_api",
    authority: "locally_derived",
    prominence: "primary",
    percentRemaining,
    used: usd(Math.max(0, included.allowanceUsd - remainingUsd)),
    limit: usd(included.allowanceUsd),
    remaining: usd(remainingUsd),
    ...(included.resetTimeIso ? { resetsAt: included.resetTimeIso } : {}),
    ...(included.periodStartIso ? { windowStartedAt: included.periodStartIso } : {}),
  };
}

export const ollamaCloudProvider: QuotaProvider = {
  id: "ollama-cloud",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    return await hasApiKey(API_KEY_VENDORS["ollama-cloud"]);
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderMatchesRuntimeId(model, "ollama-cloud");
  },

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const keyDetails = await apiKeyVendorDetails(API_KEY_VENDORS["ollama-cloud"]);

    const result = await queryOllamaCloudQuota({
      requestTimeoutMs: ctx.config?.requestTimeoutMs,
    });
    if (!result) return { attempted: false, accounts: [], debug: keyDetails };
    if (!result.success) {
      return { attempted: true, accounts: [failedAccount(LABEL, result.error)], debug: keyDetails };
    }

    const { session, weekly, includedCredits: included, purchasedUsd } = result;
    const rows: ProviderRow[] = [];
    if (session) {
      rows.push(
        quotaRow({
          ...SESSION,
          percentRemaining: session.percentRemaining,
          resetsAt: session.resetTimeIso,
        }),
      );
    }
    if (weekly) {
      rows.push(
        quotaRow({
          ...WEEKLY,
          percentRemaining: weekly.percentRemaining,
          resetsAt: weekly.resetTimeIso,
        }),
      );
    }
    // A plan with no included allowance has no share to show.
    if (included?.percentRemaining !== undefined) {
      rows.push(includedCreditsRow(included, included.percentRemaining));
    }
    // Purchased credits show when there are some, or when they are all Ollama returned.
    if (purchasedUsd !== undefined && (purchasedUsd > 0 || rows.length === 0)) {
      rows.push({
        key: "purchased",
        label: "购买",
        type: "balance",
        method: "remote_api",
        authority: "provider_reported",
        prominence: "primary",
        amount: usd(purchasedUsd),
      });
    }

    const rowErrors = result.rowErrors ?? [];
    const errors = [...rowErrors, ...(rows.length === 0 ? [NO_DATA] : [])];
    return {
      attempted: true,
      accounts: [{ name: LABEL, rows, errors: errors.map((message) => ({ message })) }],
      debug: [
        ...keyDetails,
        ...statusDetailsFromRecord({
          included_balance_usd: included?.balanceUsd.toString(),
          included_allowance_usd: included?.allowanceUsd.toString(),
          included_period_from: included?.periodStartIso,
          included_period_until: included?.resetTimeIso,
          session_remaining_percent: session?.percentRemaining.toString(),
          session_resets_at: session?.resetTimeIso,
          weekly_remaining_percent: weekly?.percentRemaining.toString(),
          weekly_resets_at: weekly?.resetTimeIso,
          purchased_balance_usd: purchasedUsd?.toString(),
        }),
        ...rowErrors.map((message, index) => ({ key: `live_error_${index + 1}`, value: message })),
      ],
    };
  },
};
