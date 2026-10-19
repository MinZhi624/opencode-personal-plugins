import { API_KEY_VENDORS, hasApiKey } from "../lib/api-key-resolver.js";
import { queryChutesQuota } from "../lib/chutes.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import { DAILY, failedAccount, type ProviderFetchResult, quotaRow } from "./contract.js";
import { apiKeyDiagnosticsDetail } from "./result-helpers.js";

export const chutesProvider: QuotaProvider = {
  id: "chutes",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "chutes",
      fallbackOnError: false,
    });
    if (providerAvailable) return true;

    return await hasApiKey(API_KEY_VENDORS.chutes);
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["chutes"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const debug = await apiKeyDiagnosticsDetail(API_KEY_VENDORS.chutes);

    const result = await queryChutesQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });
    if (!result) return { attempted: false, accounts: [], debug };
    if (!result.success) {
      return { attempted: true, accounts: [failedAccount("Chutes", result.error)], debug };
    }
    const row = quotaRow({
      ...DAILY,
      percentRemaining: result.percentRemaining,
      resetsAt: result.resetTimeIso,
    });
    return { attempted: true, accounts: [{ name: "Chutes", rows: [row], errors: [] }], debug };
  },
};
