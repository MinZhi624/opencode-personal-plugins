import { hasOpenRouterApiKeyConfigured, queryOpenRouterQuota, resolveOpenRouterApiKey, } from "../lib/openrouter.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import { failedAccount } from "./contract.js";
import { simpleApiKeyStatusDetails } from "./result-helpers.js";
const LABEL = "OpenRouter";
export const openRouterProvider = {
    id: "openrouter",
    async isAvailable(_ctx) {
        return await hasOpenRouterApiKeyConfigured();
    },
    matchesCurrentModel(model) {
        return modelProviderMatchesRuntimeId(model, "openrouter");
    },
    async fetch(ctx) {
        const resolved = await resolveOpenRouterApiKey();
        const debug = simpleApiKeyStatusDetails({
            configured: Boolean(resolved.key),
            source: resolved.source,
            checkedPaths: resolved.checkedPaths,
            credentialDatabasePaths: resolved.credentialDatabasePaths,
        });
        const result = await queryOpenRouterQuota({
            requestTimeoutMs: ctx.config?.requestTimeoutMs,
            resolved,
        });
        if (!result)
            return { attempted: false, accounts: [], debug };
        if (!result.success) {
            return { attempted: true, accounts: [failedAccount(LABEL, result.error)], debug };
        }
        return {
            attempted: true,
            accounts: [
                {
                    name: LABEL,
                    // The key's one row: its budget (percent left) or, without a limit, its spend.
                    rows: result.rows.map((row) => ({ ...row, key: "key" })),
                    errors: (result.rowErrors ?? []).map((message) => ({ message })),
                },
            ],
            debug,
        };
    },
};
