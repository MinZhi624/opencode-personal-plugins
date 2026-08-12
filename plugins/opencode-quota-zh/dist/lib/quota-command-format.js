/**
 * Verbose quota status formatter for /quota.
 *
 * This is intentionally more verbose than the toast:
 * - Always shows reset countdown when available
 * - Uses one line per limit, grouped under provider headers
 * - Includes session token summary (input/output per model)
 */
import { isValueEntry } from "./entries.js";
import { bar, formatDisplayedPercentLabel, formatLocalCallTimestamp, formatTokenCount, padLeft, padRight, resolveDisplayedPercent, } from "./format-utils.js";
import { formatGroupedHeader } from "./grouped-header-format.js";
import { groupQuotaEntries } from "./grouped-entry-normalization.js";
import { renderPlainTextReport, } from "./report-document.js";
import { SESSION_TOKEN_SECTION_HEADING } from "./session-tokens-format.js";
import { classifyQuotaWindowText } from "./quota-entry-display.js";
/**
 * Format reset time in compact form (different from toast countdown).
 * Uses seconds/minutes/hours/days format for /quota command.
 */
function formatResetTimeSeconds(diffSeconds) {
    if (!Number.isFinite(diffSeconds) || diffSeconds <= 0)
        return "现在";
    if (diffSeconds < 60)
        return `${Math.ceil(diffSeconds)}秒`;
    if (diffSeconds < 3600)
        return `${Math.ceil(diffSeconds / 60)}分钟`;
    if (diffSeconds < 86400)
        return `${Math.round(diffSeconds / 3600)}小时`;
    return `${Math.round(diffSeconds / 86400)}天`;
}
function formatResetsIn(iso) {
    if (!iso)
        return "";
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t))
        return "";
    const diffSeconds = (t - Date.now()) / 1000;
    return ` | ${formatResetTimeSeconds(diffSeconds)}后重置`;
}
export const QUOTA_COMMAND_BAR_WIDTH = 10;
export const QUOTA_COMMAND_LABEL_WIDTH = 12;
function normalizeMetricText(value) {
    return value?.trim().replace(/:+$/u, "").trim() ?? "";
}
const COMMAND_WINDOW_LABELS = {
    rpm: "RPM",
    five_hour: "5h",
    hour: "小时",
    week: "周",
    day: "天",
    month: "月",
    year: "年",
};
const SNAPSHOT_INTEGRITY_LABELS = {
    complete: "完整",
    partial: "部分",
    unknown: "未知",
};
const SNAPSHOT_STATE_LABELS = {
    ok: "正常",
    partial: "部分可用",
    unknown: "未知",
    none: "无",
};
/**
 * Snapshot section rendered from the Ticket 07 unified snapshot + projection
 * pipeline. Additive: row rendering keeps using the full entry data so the
 * pre-migration /quota output stays semantically equivalent.
 */
function buildSnapshotSection(params) {
    const providerCount = params.snapshot.providers.length;
    const freshCount = params.snapshot.providers.filter((provider) => provider.quality === "fresh").length;
    const state = params.projection?.startupHint.state;
    const statePart = state ? ` · 总体状态：${SNAPSHOT_STATE_LABELS[state]}` : "";
    return {
        id: "snapshot",
        title: "统一快照",
        blocks: [
            {
                kind: "lines",
                lines: [
                    `  v${params.snapshot.version} · 完整性：${SNAPSHOT_INTEGRITY_LABELS[params.snapshot.integrity]}${statePart}`,
                    `  监控 Provider：${providerCount}（正常 ${freshCount} · 未知 ${providerCount - freshCount}） · 额度窗口：${params.snapshot.windows.length}`,
                ],
            },
        ],
    };
}
function getCommandWindowLabel(entry) {
    const kind = classifyQuotaWindowText(normalizeMetricText(entry.label || entry.name));
    return kind ? (COMMAND_WINDOW_LABELS[kind] ?? null) : null;
}
function getCommandMetricLabel(entry) {
    const window = getCommandWindowLabel(entry);
    const resultType = entry.accounting?.resultType;
    if (resultType === "balance")
        return "余额";
    if (resultType === "status")
        return "状态";
    const explicit = normalizeMetricText(entry.label);
    const metricLabel = normalizeMetricText(entry.metricLabel);
    const noun = resultType === "budget"
        ? "预算"
        : resultType === "usage"
            ? "用量"
            : resultType === "spend"
                ? "花费"
                : resultType === "quota" || resultType === "rate_limit"
                    ? "额度"
                    : "";
    if (noun) {
        return window ? `${window} ${noun}` : metricLabel || noun[0].toUpperCase() + noun.slice(1);
    }
    if (window)
        return `${window} 额度`;
    return explicit || (isValueEntry(entry) ? "数值" : "额度");
}
function formatCommandDetails(entry, rightWidth) {
    const right = entry.right?.trim();
    const reset = formatResetsIn(entry.resetTimeIso).replace(/^ \| /u, "");
    if (right && reset)
        return ` | ${padRight(right, rightWidth)} | ${reset}`;
    if (right)
        return ` | ${right}`;
    if (reset)
        return ` | ${reset}`;
    return "";
}
function buildQuotaCommandDocument(params) {
    const groups = groupQuotaEntries(params.entries, "quota");
    const sections = [];
    if (params.snapshot) {
        sections.push(buildSnapshotSection({
            snapshot: params.snapshot,
            projection: params.projection,
        }));
    }
    for (const [index, group] of groups.entries()) {
        const lines = [];
        const rightWidth = Math.max(0, ...group.entries.map((row) => row.right?.trim().length ?? 0));
        for (const row of group.entries) {
            const label = padRight(getCommandMetricLabel(row), QUOTA_COMMAND_LABEL_WIDTH);
            const details = formatCommandDetails(row, rightWidth);
            if (isValueEntry(row)) {
                lines.push(`  ${label}  ${row.value}${details}`);
                continue;
            }
            const pctLabel = formatDisplayedPercentLabel(row.percentRemaining, params.percentDisplayMode);
            const displayedPercent = resolveDisplayedPercent(row.percentRemaining, params.percentDisplayMode);
            lines.push(`  ${label}  ${bar(displayedPercent, QUOTA_COMMAND_BAR_WIDTH)}  ${padLeft(pctLabel, 9)}${details}`);
        }
        sections.push({
            id: `group-${index}`,
            title: `→ ${formatGroupedHeader(group.group)}`,
            blocks: [{ kind: "lines", lines }],
        });
    }
    if (params.sessionTokens && params.sessionTokens.models.length > 0) {
        sections.push({
            id: "session-tokens",
            title: SESSION_TOKEN_SECTION_HEADING,
            blocks: [
                {
                    kind: "lines",
                    lines: params.sessionTokens.models.map((model) => {
                        const metrics = [`${formatTokenCount(model.input)} 输入`];
                        if ((model.cachedInput ?? 0) > 0) {
                            metrics.push(`${formatTokenCount(model.cachedInput ?? 0)} 缓存`);
                        }
                        metrics.push(`${formatTokenCount(model.output)} 输出`);
                        return `  ${model.modelID}: ${metrics.join(" | ")}`;
                    }),
                },
            ],
        });
    }
    if (params.errors.length > 0) {
        sections.push({
            id: "errors",
            title: "部分失败",
            blocks: [
                {
                    kind: "lines",
                    lines: params.errors.map((err) => `  ${err.label}: ${err.message}`),
                },
            ],
        });
    }
    return {
        sections: [
            {
                id: "heading",
                blocks: [
                    {
                        kind: "lines",
                        lines: [`额度（/quota）${formatLocalCallTimestamp(params.generatedAtMs)}`],
                    },
                ],
            },
            ...sections,
        ],
    };
}
export function formatQuotaCommand(params) {
    return renderPlainTextReport(buildQuotaCommandDocument(params));
}
