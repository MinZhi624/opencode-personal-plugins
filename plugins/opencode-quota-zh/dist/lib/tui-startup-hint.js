import { isPercentEntry } from "./entries.js";
import { classifyQuotaWindowText } from "./quota-entry-display.js";
import { getQuotaProviderDisplayLabel } from "./provider-metadata.js";
const STARTUP_HINT_WINDOW_LABELS = {
    rpm: "RPM",
    five_hour: "5h",
    hour: "小时",
    week: "周",
    day: "天",
    month: "月",
    year: "年",
};
function selectLowestQuota(providerResults) {
    let selected;
    for (const providerResult of providerResults) {
        for (const entry of providerResult.result.entries) {
            if (!isPercentEntry(entry) || !Number.isFinite(entry.percentRemaining))
                continue;
            if (!selected || entry.percentRemaining < selected.percentRemaining) {
                selected = {
                    providerId: providerResult.providerId,
                    windowLabel: entry.label ?? entry.name,
                    percentRemaining: entry.percentRemaining,
                    ...(entry.resetTimeIso ? { resetTimeIso: entry.resetTimeIso } : {}),
                };
            }
        }
    }
    return selected;
}
function formatResetCountdown(resetTimeIso, nowMs) {
    if (!resetTimeIso)
        return null;
    const resetMs = Date.parse(resetTimeIso);
    if (!Number.isFinite(resetMs))
        return null;
    const minutes = Math.max(1, Math.ceil((resetMs - nowMs) / 60_000));
    if (minutes < 60) {
        return `${minutes} 分钟后重置`;
    }
    return `${Math.ceil(minutes / 60)} 小时后重置`;
}
/**
 * Restores the original home-page behavior: show the lowest fresh percentage
 * window, rather than a static instruction to open /quota. Missing or
 * non-finite observations never become a fabricated zero-percent warning.
 */
export function formatTuiStartupHintText(params) {
    const selected = selectLowestQuota(params.providerResults);
    if (!selected)
        return undefined;
    const percent = Math.round(selected.percentRemaining);
    if (percent <= 0)
        return undefined;
    const kind = classifyQuotaWindowText(selected.windowLabel ?? "");
    const windowLabel = kind ? STARTUP_HINT_WINDOW_LABELS[kind] : null;
    const countdown = formatResetCountdown(selected.resetTimeIso, params.nowMs ?? Date.now());
    const windowPart = windowLabel ? `${windowLabel}额度剩余 ` : "额度剩余 ";
    const countdownPart = countdown ? `，${countdown}` : "";
    return `额度：${getQuotaProviderDisplayLabel(selected.providerId)} ${windowPart}${percent}%${countdownPart}。输入 /quota 查看详情。`;
}
