/**
 * Verbose quota status formatter for /quota.
 *
 * This is intentionally more verbose than the toast:
 * - Always shows reset countdown when available
 * - Uses one line per limit, grouped under provider headers
 * - Includes session token summary (input/output per model)
 */
import { interpretAccountingRow } from "./accounting-format.js";
import { isPercentEntry, isValueEntry } from "./entries.js";
import { bar, formatDisplayedPercentLabel, formatLocalCallTimestamp, formatQuotaModeHeading, formatResetCountdown, formatTokenCount, padLeft, padRight, resolveDisplayedPercent, } from "./format-utils.js";
import { groupQuotaEntries } from "./grouped-entry-normalization.js";
import { formatGroupedHeader } from "./grouped-header-format.js";
import { classifyQuotaWindowText } from "./quota-entry-display.js";
import { formatQuotaRunway } from "./quota-exhaustion-projection.js";
import { renderPlainTextReport, } from "./report-document.js";
import { SESSION_TOKEN_SECTION_HEADING } from "./session-tokens-format.js";
function formatCommandReset(iso, spaced) {
    if (!iso || !Number.isFinite(new Date(iso).getTime()))
        return "";
    const countdown = formatResetCountdown(iso, { spaced });
    return countdown === "reset" ? "已重置" : `重置于 ${countdown}`;
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
    day: "日",
    month: "月",
    year: "年",
};
function getCommandWindowLabel(entry) {
    const kind = classifyQuotaWindowText(normalizeMetricText(entry.label || entry.name));
    return kind ? (COMMAND_WINDOW_LABELS[kind] ?? null) : null;
}
function getCommandMetricLabel(entry, semanticLabel) {
    if (entry.semantic)
        return semanticLabel;
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
        return `${window}额度`;
    return explicit || (isValueEntry(entry) ? "值" : "额度");
}
function formatCommandDetails(entry, rightWidth, resetTimeSpaced) {
    const right = entry.right?.trim();
    const reset = formatCommandReset(entry.resetTimeIso, resetTimeSpaced);
    const runway = isPercentEntry(entry) ? formatQuotaRunway(entry.runway) : "";
    if (!runway) {
        if (right && reset)
            return ` | ${padRight(right, rightWidth)} | ${reset}`;
        if (right)
            return ` | ${right}`;
        if (reset)
            return ` | ${reset}`;
        return "";
    }
    const details = [
        ...(right ? [padRight(right, rightWidth)] : []),
        ...(reset ? [reset] : []),
        `预计耗尽 ${runway}`,
    ];
    return ` | ${details.join(" | ")}`;
}
function getCommandBasisLines(basis) {
    if (!basis)
        return [];
    const details = basis.kind === "detailed"
        ? basis.facts.map((fact) => fact.text)
        : basis.text
            ? [basis.text]
            : [];
    return details.map((detail) => `    ${detail}`);
}
function buildQuotaCommandDocument(params) {
    const groups = groupQuotaEntries(params.entries, "quota");
    const sections = groups.map((group, index) => {
        const lines = [];
        const interpretedRows = group.entries.map((entry) => ({
            entry,
            interpretation: interpretAccountingRow(entry, {
                booleanWording: "semantic",
                basis: (params.accountingDetail ?? "summary") === "detailed"
                    ? { kind: "detailed" }
                    : { kind: "summary", mode: params.percentDisplayMode ?? "remaining" },
            }),
        }));
        const rightWidth = Math.max(0, ...interpretedRows.map(({ entry }) => entry.right?.trim().length ?? 0));
        const labelWidth = Math.max(QUOTA_COMMAND_LABEL_WIDTH, ...interpretedRows
            .filter(({ entry }) => Boolean(entry.semantic))
            .map(({ entry, interpretation }) => getCommandMetricLabel(entry, interpretation.label).length));
        for (const { entry: row, interpretation } of interpretedRows) {
            const label = padRight(getCommandMetricLabel(row, interpretation.label), labelWidth);
            const details = formatCommandDetails(row, rightWidth, params.resetTimeSpaced);
            if (interpretation.display.kind === "value") {
                lines.push(`  ${label}  ${interpretation.display.text}${details}`);
                continue;
            }
            const pctLabel = formatDisplayedPercentLabel(interpretation.display.percentRemaining, params.percentDisplayMode, params.percentLabelStyle);
            const displayedPercent = resolveDisplayedPercent(interpretation.display.percentRemaining, params.percentDisplayMode);
            lines.push(`  ${label}  ${bar(displayedPercent, QUOTA_COMMAND_BAR_WIDTH)}  ${padLeft(pctLabel, Math.max(9, pctLabel.length))}${details}`);
            lines.push(...getCommandBasisLines(interpretation.basis));
        }
        return {
            id: `group-${index}`,
            title: `→ ${formatGroupedHeader(group.group)}`,
            blocks: [{ kind: "lines", lines }],
        };
    });
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
            title: "部分获取失败",
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
                        lines: [
                            `${params.percentLabelStyle === "bare"
                                ? formatQuotaModeHeading(params.percentDisplayMode)
                                : "额度"} (/quota) ${formatLocalCallTimestamp(params.generatedAtMs)}`,
                        ],
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
