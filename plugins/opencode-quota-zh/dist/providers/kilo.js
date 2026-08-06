/**
 * Kilo Gateway provider wrapper.
 */
import { fmtUsdAmount } from "../lib/format-utils.js";
import { getKiloKeyDiagnostics, hasKiloApiKey } from "../lib/kilo-config.js";
import { queryKiloBalance } from "../lib/kilo.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import { attemptedResult, mapNullableProviderResult, simpleApiKeyStatusDetails, statusDetailsFromRecord, withStatusDetails, } from "./result-helpers.js";
function mapKiloSuccess(result) {
    return withStatusDetails(attemptedResult([
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
    ]), statusDetailsFromRecord({ balance_usd: fmtUsdAmount(result.balanceUsd) }));
}
export const kiloProvider = {
    id: "kilo",
    async isAvailable(_ctx) {
        return await hasKiloApiKey();
    },
    matchesCurrentModel(model) {
        return modelProviderMatchesRuntimeId(model, "kilo");
    },
    async fetch(ctx) {
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
//# sourceMappingURL=kilo.js.map