import { API_KEY_VENDORS, hasApiKey } from "../lib/api-key-resolver.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import { querySyntheticQuota } from "../lib/synthetic.js";
import { FIVE_HOUR, failedAccount, WEEKLY, windowRows, } from "./contract.js";
import { apiKeyDiagnosticsDetail } from "./result-helpers.js";
export const syntheticProvider = {
    id: "synthetic",
    async isAvailable(ctx) {
        const providerAvailable = await isCanonicalProviderAvailable({
            ctx,
            providerId: "synthetic",
            fallbackOnError: false,
        });
        if (providerAvailable)
            return true;
        return await hasApiKey(API_KEY_VENDORS.synthetic);
    },
    matchesCurrentModel(model) {
        return modelProviderIncludesAny(model, ["synthetic"]);
    },
    async fetch(ctx) {
        const debug = await apiKeyDiagnosticsDetail(API_KEY_VENDORS.synthetic);
        const result = await querySyntheticQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });
        if (!result)
            return { attempted: false, accounts: [], debug };
        if (!result.success) {
            return { attempted: true, accounts: [failedAccount("Synthetic", result.error)], debug };
        }
        const rows = windowRows([
            { slot: FIVE_HOUR, value: result.windows.fiveHour },
            { slot: WEEKLY, value: result.windows.weekly },
        ]);
        return { attempted: true, accounts: [{ name: "Synthetic", rows, errors: [] }], debug };
    },
};
