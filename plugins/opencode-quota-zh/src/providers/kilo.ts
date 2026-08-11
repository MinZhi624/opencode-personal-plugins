/**
 * Kilo Gateway provider wrapper.
 */

import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import { fmtUsdAmount } from "../lib/format-utils.js";
import { getKiloKeyDiagnostics, hasKiloApiKey } from "../lib/kilo-config.js";
import { queryKiloBalance } from "../lib/kilo.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import {
  attemptedResult,
  mapNullableProviderResult,
  simpleApiKeyStatusDetails,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

type KiloSuccess = Extract<
  NonNullable<Awaited<ReturnType<typeof queryKiloBalance>>>,
  { success: true }
>;

function mapKiloSuccess(result: KiloSuccess): QuotaProviderResult {
  return withStatusDetails(
    attemptedResult([
      {
        kind: "value",
        accounting: {
          resultType: "balance",
          acquisitionMethod: "remote_api",
          ownership: "maintained",
          authority: "provider_reported",
        },
        name: "Kilo Gateway Balance",
        group: "Kilo Gateway",
        label: "Balance:",
        value: fmtUsdAmount(result.balanceUsd),
      },
    ]),
    statusDetailsFromRecord({ balance_usd: fmtUsdAmount(result.balanceUsd) }),
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
    const result = await queryKiloBalance({ requestTimeoutMs: ctx.config?.requestTimeoutMs });
    const providerResult = mapNullableProviderResult(result, {
      errorLabel: "Kilo Gateway",
      onSuccess: mapKiloSuccess,
    });

    return withStatusDetails(providerResult, [
      ...simpleApiKeyStatusDetails(diagnostics),
      ...(providerResult.statusDetails ?? []),
    ]);
  },
};
