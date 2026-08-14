/**
 * Kilo Gateway provider wrapper.
 */

import type {
  AccountingMetadata,
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { fmtUsdAmount } from "../lib/format-utils.js";
import { type KiloQuotaResult, queryKiloQuota } from "../lib/kilo.js";
import { getKiloKeyDiagnostics, hasKiloApiKey } from "../lib/kilo-config.js";
import { serializeQuotaAlertMetric } from "../lib/quota-alert-metrics.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import {
  attemptedResult,
  notAttemptedResult,
  simpleApiKeyStatusDetails,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

const KILO_QUOTA_ACCOUNTING: AccountingMetadata = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "locally_derived",
};

const KILO_BALANCE_ACCOUNTING: AccountingMetadata = {
  resultType: "balance",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
};

type KiloPassSuccess = Extract<NonNullable<KiloQuotaResult>, { success: true; mode: "kilo_pass" }>;
type KiloBalanceSuccess = Extract<
  NonNullable<KiloQuotaResult>,
  { success: true; mode: "gateway_balance" }
>;

function buildKiloPassEntries(state: KiloPassSuccess): QuotaToastEntry[] {
  const totalCreditsUsd = state.baseCreditsUsd + state.bonusCreditsUsd;
  const entries: QuotaToastEntry[] = [];

  if (totalCreditsUsd > 0) {
    entries.push({
      accounting: KILO_QUOTA_ACCOUNTING,
      name: "Kilo Gateway Credits",
      group: "Kilo Gateway",
      label: "Credits:",
      metricLabel: "Credits",
      right: `${fmtUsdAmount(state.remainingUsd)} left`,
      percentRemaining: Math.min(
        100,
        Math.max(0, ((totalCreditsUsd - state.usageUsd) / totalCreditsUsd) * 100),
      ),
      resetTimeIso: state.resetTimeIso,
    });
  }

  entries.push({
    kind: "value",
    accounting: KILO_QUOTA_ACCOUNTING,
    name: "Kilo Gateway Remaining Credits",
    group: "Kilo Gateway",
    label: "Left:",
    metricLabel: "Left",
    value: fmtUsdAmount(state.remainingUsd),
    ...(totalCreditsUsd === 0 && state.resetTimeIso ? { resetTimeIso: state.resetTimeIso } : {}),
  });

  return entries;
}

function mapKiloPassSuccess(state: KiloPassSuccess): QuotaProviderResult {
  const rawDetails = statusDetailsFromRecord({
    base_credits_usd: fmtUsdAmount(state.baseCreditsUsd),
    usage_usd: fmtUsdAmount(state.usageUsd),
    bonus_credits_usd: fmtUsdAmount(state.bonusCreditsUsd),
    remaining_usd: fmtUsdAmount(state.remainingUsd),
    overage_usd: fmtUsdAmount(state.overageUsd),
    reset_at: state.resetTimeIso ?? "(none)",
  });

  return withStatusDetails(
    {
      ...attemptedResult(buildKiloPassEntries(state), [], {
        singleWindowDisplayName: "Kilo Gateway",
        singleWindowShowRight: true,
      }),
      rawDetails,
    },
    [...statusDetailsFromRecord({ accounting_mode: "kilo_pass" }), ...rawDetails],
  );
}

function mapKiloBalanceSuccess(state: KiloBalanceSuccess): QuotaProviderResult {
  // Structured balance fact (Ticket 10): the gateway balance is a
  // provider-reported USD account balance and may participate in quota-alert
  // danger evaluation. Kilo Pass credits are period quota (not account
  // balance) and intentionally carry no fact.
  const rawDetails = [
    serializeQuotaAlertMetric({ kind: "balance", currency: "USD", amount: state.balanceUsd }),
  ];
  return withStatusDetails(
    {
      ...attemptedResult([
        {
          kind: "value",
          accounting: KILO_BALANCE_ACCOUNTING,
          name: "Kilo Gateway Balance",
          group: "Kilo Gateway",
          label: "Balance:",
          value: fmtUsdAmount(state.balanceUsd),
        },
      ]),
      rawDetails,
    },
    statusDetailsFromRecord({
      accounting_mode: "gateway_balance",
      balance_usd: fmtUsdAmount(state.balanceUsd),
    }),
  );
}

export const kiloProvider: QuotaProvider = {
  id: "kilo",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    return await hasKiloApiKey();
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderMatchesRuntimeId(model, "kilo");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const diagnostics = await getKiloKeyDiagnostics().catch(() => ({
      configured: false,
      source: null,
      checkedPaths: [],
      authPaths: [],
    }));
    const stateResult = await queryKiloQuota({
      requestTimeoutMs: ctx.config?.requestTimeoutMs,
    });
    const keyStatusDetails = simpleApiKeyStatusDetails(diagnostics);

    if (!stateResult) {
      return withStatusDetails(notAttemptedResult(), keyStatusDetails);
    }
    if (!stateResult.success) {
      return withStatusDetails(
        {
          attempted: true,
          entries: [],
          errors: [{ label: "Kilo Gateway", message: stateResult.error }],
        },
        keyStatusDetails,
      );
    }

    const providerResult =
      stateResult.mode === "kilo_pass"
        ? mapKiloPassSuccess(stateResult)
        : mapKiloBalanceSuccess(stateResult);

    return withStatusDetails(providerResult, [
      ...keyStatusDetails,
      ...(providerResult.statusDetails ?? []),
    ]);
  },
};
