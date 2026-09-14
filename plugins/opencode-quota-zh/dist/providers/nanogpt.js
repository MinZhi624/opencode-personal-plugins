/**
 * NanoGPT provider wrapper.
 */
import { getNanoGptKeyDiagnostics, hasNanoGptApiKeyConfigured, queryNanoGptQuota, } from "../lib/nanogpt.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import { attemptedResult, mapNullableProviderResult, simpleApiKeyStatusDetails, statusDetailsFromRecord, withStatusDetails, } from "./result-helpers.js";
const REQUEST_UNIT = { kind: "count", unit: "request" };
const USD_UNIT = { kind: "currency", code: "USD" };
const NANO_UNIT = { kind: "custom", symbol: "NANO" };
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
function quotaBasis(window) {
    const basis = {};
    for (const key of ["used", "limit", "remaining"]) {
        const value = window.reportedBasis[key];
        if (value === undefined)
            continue;
        basis[key] = {
            quantity: { decimal: canonicalNumberDecimal(value), unit: REQUEST_UNIT },
            authority: "provider_reported",
        };
    }
    return basis.used || basis.limit || basis.remaining ? basis : undefined;
}
function pushQuotaEntry(entries, window, accountingWindow) {
    const basis = quotaBasis(window);
    entries.push({
        accounting: {
            resultType: "quota",
            acquisitionMethod: "remote_api",
            ownership: "maintained",
            authority: "provider_reported",
        },
        name: `nanogpt-${accountingWindow}-quota`,
        group: "NanoGPT",
        percentRemaining: window.percentRemaining,
        resetTimeIso: window.resetTimeIso,
        semantic: {
            metric: { kind: "window", window: accountingWindow },
            prominence: "primary",
        },
        ...(basis ? { basis } : {}),
    });
}
function mapNanoGptSuccess(result) {
    const entries = [];
    const errors = result.endpointErrors?.map((entry) => ({
        label: entry.endpoint === "usage" ? "NanoGPT Usage" : "NanoGPT Balance",
        message: entry.message,
    })) ?? [];
    const subscription = result.subscription;
    if (subscription?.daily)
        pushQuotaEntry(entries, subscription.daily, "day");
    if (subscription?.monthly)
        pushQuotaEntry(entries, subscription.monthly, "month");
    const balance = result.balance;
    if (balance?.usdBalanceRaw || balance?.nanoBalanceRaw) {
        entries.push({
            kind: "quantity",
            accounting: {
                resultType: "balance",
                acquisitionMethod: "remote_api",
                ownership: "maintained",
                authority: "provider_reported",
            },
            name: "nanogpt-current-balance",
            group: "NanoGPT",
            semantic: {
                metric: { kind: "component", component: "current_balance" },
                prominence: "primary",
            },
            quantity: balance.usdBalanceRaw
                ? { decimal: balance.usdBalanceRaw, unit: USD_UNIT }
                : { decimal: balance.nanoBalanceRaw, unit: NANO_UNIT },
        });
    }
    if (subscription?.state && subscription.state.toLowerCase() !== "active") {
        errors.push({
            label: "NanoGPT",
            message: `Subscription state: ${subscription.state}`,
        });
    }
    if (entries.length === 0) {
        errors.push({
            label: "NanoGPT",
            message: "No usable NanoGPT quota or balance data",
        });
    }
    const formatSubscriptionUsage = (usage) => usage
        ? `${canonicalNumberDecimal(usage.used)}/${canonicalNumberDecimal(usage.limit)} remaining=${canonicalNumberDecimal(usage.remaining)} percent_remaining=${usage.percentRemaining} reset_at=${usage.resetTimeIso ?? "(none)"}`
        : undefined;
    const statusDetails = [
        ...statusDetailsFromRecord({
            subscription_active: subscription ? (subscription.active ? "true" : "false") : undefined,
            subscription_state: subscription?.state,
            enforce_daily_limit: subscription
                ? subscription.enforceDailyLimit
                    ? "true"
                    : "false"
                : undefined,
            daily_usage: formatSubscriptionUsage(subscription?.daily),
            monthly_usage: formatSubscriptionUsage(subscription?.monthly),
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
    return withStatusDetails(attemptedResult(entries, errors), statusDetails);
}
export const nanoGptProvider = {
    id: "nanogpt",
    async isAvailable(_ctx) {
        return await hasNanoGptApiKeyConfigured();
    },
    matchesCurrentModel(model) {
        return modelProviderMatchesRuntimeId(model, "nanogpt");
    },
    async fetch(ctx) {
        const diagnostics = await getNanoGptKeyDiagnostics().catch(() => ({
            configured: false,
            source: null,
            checkedPaths: [],
            authPaths: [],
        }));
        const result = await queryNanoGptQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });
        const providerResult = mapNullableProviderResult(result, {
            errorLabel: "NanoGPT",
            onSuccess: mapNanoGptSuccess,
        });
        return withStatusDetails(providerResult, [
            ...simpleApiKeyStatusDetails(diagnostics),
            ...(providerResult.statusDetails ?? []),
        ]);
    },
};
