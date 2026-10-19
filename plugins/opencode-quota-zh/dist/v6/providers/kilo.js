import { API_KEY_VENDORS, hasApiKey } from "../lib/api-key-resolver.js";
import { fmtUsdAmount } from "../lib/format-utils.js";
import { queryKiloQuota } from "../lib/kilo.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import { accountingDecimalFromNumber } from "./accounting-decimal.js";
import { failedAccount } from "./contract.js";
import { apiKeyVendorDetails, statusDetailsFromRecord } from "./result-helpers.js";
const LABEL = "Kilo Gateway";
function usd(value) {
    return { decimal: accountingDecimalFromNumber(value), unit: { kind: "currency", code: "USD" } };
}
/** The Kilo Pass credits: percent left of base plus bonus credits, else the USD left. */
function passCreditsRow(state) {
    const totalCreditsUsd = state.baseCreditsUsd + state.bonusCreditsUsd;
    const row = {
        key: "pass_credits",
        label: "Pass 额度",
        type: "quota",
        method: "remote_api",
        authority: "locally_derived",
        prominence: "primary",
        ...(state.resetTimeIso ? { resetsAt: state.resetTimeIso } : {}),
    };
    if (totalCreditsUsd > 0) {
        return {
            ...row,
            percentRemaining: Math.min(100, Math.max(0, ((totalCreditsUsd - state.usageUsd) / totalCreditsUsd) * 100)),
            used: usd(state.usageUsd),
            limit: usd(totalCreditsUsd),
            remaining: usd(state.remainingUsd),
        };
    }
    return { ...row, amount: usd(state.remainingUsd) };
}
export const kiloProvider = {
    id: "kilo",
    async isAvailable(_ctx) {
        return await hasApiKey(API_KEY_VENDORS.kilo);
    },
    matchesCurrentModel(model) {
        return modelProviderMatchesRuntimeId(model, "kilo");
    },
    async fetch(ctx) {
        const keyDetails = await apiKeyVendorDetails(API_KEY_VENDORS.kilo);
        const state = await queryKiloQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });
        if (!state)
            return { attempted: false, accounts: [], debug: keyDetails };
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
        const balanceRow = {
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
