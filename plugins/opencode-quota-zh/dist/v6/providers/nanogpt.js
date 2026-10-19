import { API_KEY_VENDORS, hasApiKey } from "../lib/api-key-resolver.js";
import { queryNanoGptQuota } from "../lib/nanogpt.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import { DAILY, failedAccount, MONTHLY, quotaRow, } from "./contract.js";
import { apiKeyVendorDetails, statusDetailsFromRecord } from "./result-helpers.js";
const LABEL = "NanoGPT";
const REQUEST_UNIT = { kind: "count", unit: "request" };
function canonicalNumberDecimal(value) {
    if (!Number.isFinite(value))
        throw new TypeError("NanoGPT usage value must be finite");
    if (Object.is(value, -0))
        return "0";
    const raw = String(value);
    if (!/[eE]/u.test(raw))
        return raw;
    const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/u.exec(raw);
    if (!match)
        throw new TypeError("NanoGPT usage value must be decimal-compatible");
    const [, sign, integer, fraction = "", exponentRaw] = match;
    const digits = `${integer}${fraction}`;
    const decimalIndex = integer.length + Number(exponentRaw);
    if (decimalIndex <= 0)
        return `${sign}0.${"0".repeat(-decimalIndex)}${digits}`;
    if (decimalIndex >= digits.length) {
        return `${sign}${digits}${"0".repeat(decimalIndex - digits.length)}`;
    }
    return `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}
/** A daily or monthly request window with the counts NanoGPT reported. */
function windowRow(window, slot) {
    const amounts = {};
    for (const key of ["used", "limit", "remaining"]) {
        const value = window.reportedBasis[key];
        if (value === undefined)
            continue;
        amounts[key] = { decimal: canonicalNumberDecimal(value), unit: REQUEST_UNIT };
    }
    return {
        ...quotaRow({
            ...slot,
            percentRemaining: window.percentRemaining,
            resetsAt: window.resetTimeIso,
        }),
        ...amounts,
    };
}
function nanoGptAccounts(result) {
    const rows = [];
    const subscription = result.subscription;
    if (subscription?.daily)
        rows.push(windowRow(subscription.daily, DAILY));
    if (subscription?.monthly)
        rows.push(windowRow(subscription.monthly, MONTHLY));
    const balance = result.balance;
    if (balance?.usdBalanceRaw || balance?.nanoBalanceRaw) {
        rows.push({
            key: balance.usdBalanceRaw ? "balance.usd" : "balance.nano",
            label: "余额",
            type: "balance",
            method: "remote_api",
            authority: "provider_reported",
            prominence: "primary",
            amount: balance.usdBalanceRaw
                ? { decimal: balance.usdBalanceRaw, unit: { kind: "currency", code: "USD" } }
                : { decimal: balance.nanoBalanceRaw, unit: { kind: "custom", symbol: "NANO" } },
        });
    }
    const errors = [];
    if (subscription?.state && subscription.state.toLowerCase() !== "active") {
        errors.push({ message: `订阅状态：${subscription.state}` });
    }
    if (rows.length === 0)
        errors.push({ message: "没有可用的 NanoGPT 额度或余额数据" });
    return [
        ...(result.endpointErrors ?? []).map((entry) => failedAccount(entry.endpoint === "usage" ? "NanoGPT Usage" : "NanoGPT Balance", entry.message)),
        { name: LABEL, rows, errors },
    ];
}
function nanoGptDetails(result) {
    const { subscription, balance } = result;
    const formatUsage = (usage) => usage
        ? `${canonicalNumberDecimal(usage.used)}/${canonicalNumberDecimal(usage.limit)} remaining=${canonicalNumberDecimal(usage.remaining)} percent_remaining=${usage.percentRemaining} reset_at=${usage.resetTimeIso ?? "(none)"}`
        : undefined;
    return [
        ...statusDetailsFromRecord({
            subscription_active: subscription ? String(subscription.active) : undefined,
            subscription_state: subscription?.state,
            enforce_daily_limit: subscription ? String(subscription.enforceDailyLimit) : undefined,
            daily_usage: formatUsage(subscription?.daily),
            monthly_usage: formatUsage(subscription?.monthly),
            billing_period_end: subscription ? (subscription.currentPeriodEndIso ?? "(none)") : undefined,
            grace_until: subscription?.graceUntilIso,
            balance_usd: balance?.usdBalanceRaw ?? "(none)",
            balance_nano: balance?.nanoBalanceRaw ?? "(none)",
        }),
        ...(result.endpointErrors ?? []).map((endpointError) => ({
            key: `live_error_${endpointError.endpoint}`,
            value: endpointError.message,
        })),
    ];
}
export const nanoGptProvider = {
    id: "nanogpt",
    async isAvailable(_ctx) {
        return await hasApiKey(API_KEY_VENDORS.nanogpt);
    },
    matchesCurrentModel(model) {
        return modelProviderMatchesRuntimeId(model, "nanogpt");
    },
    async fetch(ctx) {
        const keyDetails = await apiKeyVendorDetails(API_KEY_VENDORS.nanogpt);
        const result = await queryNanoGptQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });
        if (!result)
            return { attempted: false, accounts: [], debug: keyDetails };
        if (!result.success) {
            return {
                attempted: true,
                accounts: [failedAccount(LABEL, result.error)],
                debug: keyDetails,
            };
        }
        const accounts = nanoGptAccounts(result);
        return { attempted: true, accounts, debug: [...keyDetails, ...nanoGptDetails(result)] };
    },
};
