/**
 * OpenCode Go provider wrapper.
 *
 * Scrapes the OpenCode Go workspace dashboard and reports rolling (~5h),
 * weekly, and monthly usage as percentage-based quota entries.
 */
import { DEFAULT_OPENCODE_GO_CONFIG_CACHE_MAX_AGE_MS, getOpenCodeGoConfigDiagnostics, resolveOpenCodeGoConfigCached, } from "../lib/opencode-go-config.js";
import { queryOpenCodeGoQuota } from "../lib/opencode-go.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import { attemptedErrorResult, configStatusDetails, attemptedResult, notAttemptedResult, withStatusDetails, } from "./result-helpers.js";
const OPENCODE_GO_PROVIDER_LABEL = "OpenCode Go";
const OPENCODE_GO_WINDOW_ORDER = ["rolling", "weekly", "monthly"];
const OPENCODE_GO_WINDOW_LABELS = {
    rolling: {
        name: `${OPENCODE_GO_PROVIDER_LABEL} 5h`,
        label: "5h:",
        dashboardField: "rollingUsage",
    },
    weekly: {
        name: `${OPENCODE_GO_PROVIDER_LABEL} Weekly`,
        label: "Weekly:",
        dashboardField: "weeklyUsage",
    },
    monthly: {
        name: `${OPENCODE_GO_PROVIDER_LABEL} Monthly`,
        label: "Monthly:",
        dashboardField: "monthlyUsage",
    },
};
function isDefaultOpenCodeGoWindowSelection(windows) {
    const selected = new Set(windows);
    return (selected.size === OPENCODE_GO_WINDOW_ORDER.length &&
        OPENCODE_GO_WINDOW_ORDER.every((window) => selected.has(window)));
}
function formatMissingWindowList(windows) {
    return windows
        .map((window) => `${window} (${OPENCODE_GO_WINDOW_LABELS[window].dashboardField})`)
        .join(", ");
}
function buildOpenCodeGoEntries(result, selectedWindows) {
    const selected = new Set(selectedWindows);
    const entries = [];
    for (const window of OPENCODE_GO_WINDOW_ORDER) {
        if (!selected.has(window))
            continue;
        const usage = result[window];
        if (!usage)
            continue;
        const labels = OPENCODE_GO_WINDOW_LABELS[window];
        entries.push({
            accounting: {
                resultType: "quota",
                acquisitionMethod: "dashboard_scrape",
                ownership: "maintained",
                authority: "provider_reported",
            },
            name: labels.name,
            group: OPENCODE_GO_PROVIDER_LABEL,
            label: labels.label,
            percentRemaining: usage.percentRemaining,
            resetTimeIso: usage.resetTimeIso,
        });
    }
    return entries;
}
export const opencodeGoProvider = {
    id: "opencode-go",
    async isAvailable(_ctx) {
        const config = await resolveOpenCodeGoConfigCached({
            maxAgeMs: DEFAULT_OPENCODE_GO_CONFIG_CACHE_MAX_AGE_MS,
        });
        return config.state === "configured";
    },
    matchesCurrentModel(model) {
        const [provider] = model.toLowerCase().split("/", 2);
        return normalizeQuotaProviderId(provider) === "opencode-go";
    },
    async fetch(ctx) {
        const diagnostics = await getOpenCodeGoConfigDiagnostics();
        const windows = ctx.config.opencodeGoWindows ?? OPENCODE_GO_WINDOW_ORDER;
        const statusDetails = [
            ...configStatusDetails(diagnostics),
            { key: "selected_windows", value: windows.join(",") },
        ];
        const config = await resolveOpenCodeGoConfigCached({
            maxAgeMs: DEFAULT_OPENCODE_GO_CONFIG_CACHE_MAX_AGE_MS,
        });
        if (config.state === "none") {
            return withStatusDetails(notAttemptedResult(), statusDetails);
        }
        if (config.state === "incomplete") {
            return withStatusDetails(attemptedErrorResult(OPENCODE_GO_PROVIDER_LABEL, `Missing ${config.missing} (source: ${config.source})`), statusDetails);
        }
        if (config.state === "invalid") {
            return withStatusDetails(attemptedErrorResult(OPENCODE_GO_PROVIDER_LABEL, `Invalid config (${config.source}): ${config.error}`), statusDetails);
        }
        const result = await queryOpenCodeGoQuota(config.config.workspaceId, config.config.authCookie, {
            requestTimeoutMs: ctx.config?.requestTimeoutMsConfigured
                ? ctx.config.requestTimeoutMs
                : undefined,
        });
        if (!result) {
            return withStatusDetails(notAttemptedResult(), [
                ...statusDetails,
                { key: "live_fetch_error", value: "OpenCode Go returned null" },
            ]);
        }
        if (!result.success) {
            return withStatusDetails(attemptedErrorResult(OPENCODE_GO_PROVIDER_LABEL, result.error), [
                ...statusDetails,
                { key: "live_fetch_error", value: result.error },
            ]);
        }
        const entries = buildOpenCodeGoEntries(result, windows);
        const missingSelectedWindows = windows.filter((window) => !result[window]);
        const liveDetails = OPENCODE_GO_WINDOW_ORDER.flatMap((window) => {
            const usage = result[window];
            return usage
                ? [
                    {
                        key: `${window}_usage`,
                        value: `percent_used=${usage.usagePercent} percent_remaining=${usage.percentRemaining} reset_in_sec=${usage.resetInSec} reset_at=${usage.resetTimeIso}`,
                    },
                ]
                : [];
        });
        if (missingSelectedWindows.length > 0 && !isDefaultOpenCodeGoWindowSelection(windows)) {
            const message = `Selected OpenCode Go dashboard window(s) missing: ${formatMissingWindowList(missingSelectedWindows)}`;
            return withStatusDetails(attemptedResult(entries, [{ label: OPENCODE_GO_PROVIDER_LABEL, message }]), [...statusDetails, ...liveDetails, { key: "live_fetch_error", value: message }]);
        }
        return withStatusDetails(attemptedResult(entries), [...statusDetails, ...liveDetails]);
    },
};
//# sourceMappingURL=opencode-go.js.map