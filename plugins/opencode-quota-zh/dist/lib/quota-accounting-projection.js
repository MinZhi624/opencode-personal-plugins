import { compareAccountingSemanticEntries } from "./accounting-format.js";
import { cloneQuotaToastEntry, isPercentEntry } from "./entries.js";
import { formatGroupedHeader } from "./grouped-header-format.js";
import { classifyQuotaWindowText } from "./quota-entry-display.js";
import { projectQuotaRunway } from "./quota-exhaustion-projection.js";
import { getQuotaFormatStyleDefinition } from "./quota-format-style.js";
function stripSingleWindowEntryMeta(entry, showRight) {
    const { group: _group, label: _label, metricLabel: _metricLabel, ...withoutGroupLabel } = entry;
    if (showRight) {
        return { ...withoutGroupLabel };
    }
    const { right: _right, ...withoutRight } = withoutGroupLabel;
    return { ...withoutRight };
}
const SINGLE_WINDOW_PROJECTION_LABELS = {
    rpm: "RPM",
    five_hour: "5h",
    hour: "Hourly",
    week: "Weekly",
    day: "Daily",
    month: "Monthly",
    year: "Yearly",
    mcp: "MCP",
    code_review: "Code Review",
};
function normalizeSingleWindowWindowLabel(value) {
    const kind = classifyQuotaWindowText(value ?? "");
    return kind ? SINGLE_WINDOW_PROJECTION_LABELS[kind] : null;
}
function buildSingleWindowName(params) {
    const providerText = params.entry.group?.trim() ||
        params.singleWindowDisplayName?.trim() ||
        params.entry.name.trim() ||
        "";
    const provider = formatGroupedHeader(providerText);
    const windowLabel = normalizeSingleWindowWindowLabel(params.entry.label) ??
        normalizeSingleWindowWindowLabel(params.entry.name);
    return windowLabel ? `${provider} ${windowLabel}` : provider;
}
function suppressRedundantQuotaFamily(entry, redundantQuotaFamily) {
    if (!redundantQuotaFamily)
        return entry;
    const familySuffix = `: ${redundantQuotaFamily}`;
    const name = entry.name.endsWith(familySuffix)
        ? entry.name.slice(0, -familySuffix.length)
        : entry.name;
    return {
        ...entry,
        name,
        label: undefined,
        metricLabel: "Quota",
    };
}
function normalizeSingleWindowPresentation(presentation) {
    if (!presentation) {
        return undefined;
    }
    const legacyPresentation = presentation;
    const singleWindowDisplayName = typeof legacyPresentation.singleWindowDisplayName === "string"
        ? legacyPresentation.singleWindowDisplayName
        : typeof legacyPresentation.classicDisplayName === "string"
            ? legacyPresentation.classicDisplayName
            : undefined;
    const singleWindowShowRight = typeof legacyPresentation.singleWindowShowRight === "boolean"
        ? legacyPresentation.singleWindowShowRight
        : typeof legacyPresentation.classicShowRight === "boolean"
            ? legacyPresentation.classicShowRight
            : false;
    const classicStrategy = legacyPresentation.classicStrategy === "preserve"
        ? legacyPresentation.classicStrategy
        : undefined;
    const redundantQuotaFamily = typeof legacyPresentation.redundantQuotaFamily === "string"
        ? legacyPresentation.redundantQuotaFamily.trim()
        : "";
    return {
        ...(singleWindowDisplayName ? { singleWindowDisplayName } : {}),
        ...(singleWindowShowRight ? { singleWindowShowRight } : {}),
        ...(redundantQuotaFamily ? { redundantQuotaFamily } : {}),
        ...(classicStrategy ? { classicStrategy } : {}),
    };
}
function entryMatchesPreferredWindow(entry, preferredWindow) {
    if (!isPercentEntry(entry)) {
        return false;
    }
    if (entry.semantic?.metric.kind === "window") {
        return entry.semantic.metric.window === preferredWindow;
    }
    return (classifyQuotaWindowText(entry.label ?? "") === preferredWindow ||
        classifyQuotaWindowText(entry.name) === preferredWindow);
}
function selectSingleWindowEntry(entries, preferredWindow) {
    const preferredEntries = preferredWindow
        ? entries.filter((entry) => entryMatchesPreferredWindow(entry, preferredWindow))
        : [];
    const candidates = preferredEntries.length > 0 ? preferredEntries : entries;
    let selectedPercentEntry;
    for (const entry of candidates) {
        if (!isPercentEntry(entry)) {
            continue;
        }
        if (!selectedPercentEntry || entry.percentRemaining < selectedPercentEntry.percentRemaining) {
            selectedPercentEntry = entry;
        }
    }
    return selectedPercentEntry ?? candidates[0];
}
function selectSingleWindowEntries(entries, preferredWindow) {
    if (!entries.some((entry) => entry.accounting.sourceId !== undefined)) {
        const selected = selectSingleWindowEntry(entries, preferredWindow);
        return selected ? [selected] : [];
    }
    const entriesBySource = new Map();
    for (const entry of entries) {
        const sourceEntries = entriesBySource.get(entry.accounting.sourceId) ?? [];
        sourceEntries.push(entry);
        entriesBySource.set(entry.accounting.sourceId, sourceEntries);
    }
    return [...entriesBySource.values()].flatMap((sourceEntries) => {
        const selected = selectSingleWindowEntry(sourceEntries, preferredWindow);
        return selected ? [selected] : [];
    });
}
function sortSemanticRuns(entries) {
    const sorted = [...entries];
    let start = 0;
    while (start < sorted.length) {
        if (!sorted[start]?.entry.semantic) {
            start += 1;
            continue;
        }
        let end = start + 1;
        while (end < sorted.length && sorted[end]?.entry.semantic) {
            end += 1;
        }
        const run = sorted
            .slice(start, end)
            .sort((left, right) => compareAccountingSemanticEntries(left.entry, right.entry) || left.index - right.index);
        sorted.splice(start, run.length, ...run);
        start = end;
    }
    return sorted;
}
function isSemanticWindowPercentEntry(entry) {
    return isPercentEntry(entry) && entry.semantic?.metric.kind === "window";
}
function selectSemanticSingleWindowEntries(entries, preferredWindow) {
    const partitions = new Map();
    for (const indexed of entries) {
        if (!isSemanticWindowPercentEntry(indexed.entry) ||
            !Number.isFinite(indexed.entry.percentRemaining)) {
            continue;
        }
        const sourceId = indexed.entry.accounting.sourceId;
        let byResultType = partitions.get(sourceId);
        if (!byResultType) {
            byResultType = new Map();
            partitions.set(sourceId, byResultType);
        }
        const resultType = indexed.entry.accounting.resultType;
        const partition = byResultType.get(resultType) ?? [];
        partition.push({ entry: indexed.entry, index: indexed.index });
        byResultType.set(resultType, partition);
    }
    const selectedIndexes = new Set();
    for (const byResultType of partitions.values()) {
        for (const partition of byResultType.values()) {
            const preferredPartition = preferredWindow
                ? partition.filter(({ entry }) => entry.semantic?.metric.kind === "window" &&
                    entry.semantic.metric.window === preferredWindow)
                : [];
            const candidates = preferredPartition.length > 0 ? preferredPartition : partition;
            const [first, ...remaining] = candidates;
            if (!first)
                continue;
            let selected = first;
            for (const candidate of remaining) {
                const percentDifference = candidate.entry.percentRemaining - selected.entry.percentRemaining;
                const semanticOrder = compareAccountingSemanticEntries(candidate.entry, selected.entry);
                if (percentDifference < 0 ||
                    (percentDifference === 0 &&
                        (semanticOrder < 0 || (semanticOrder === 0 && candidate.index < selected.index)))) {
                    selected = candidate;
                }
            }
            selectedIndexes.add(selected.index);
        }
    }
    return entries.filter((indexed) => !isSemanticWindowPercentEntry(indexed.entry) || selectedIndexes.has(indexed.index));
}
function projectSingleWindowEntry(entry, presentation) {
    const nameEntry = presentation?.classicStrategy === "preserve" && !presentation.redundantQuotaFamily
        ? { ...entry, group: undefined }
        : entry;
    return {
        ...stripSingleWindowEntryMeta(entry, presentation?.singleWindowShowRight ?? false),
        name: buildSingleWindowName({
            entry: nameEntry,
            singleWindowDisplayName: presentation?.classicStrategy === "preserve"
                ? (presentation.singleWindowDisplayName ?? entry.name)
                : presentation?.singleWindowDisplayName,
        }),
    };
}
function projectProviderResultToStyle(result, style, accountingDetail, preferredWindow) {
    const presentation = normalizeSingleWindowPresentation(result.presentation);
    const entries = result.entries
        .map(cloneQuotaToastEntry)
        .filter((entry) => !entry.semantic ||
        accountingDetail === "detailed" ||
        entry.semantic.prominence === "primary")
        .map((entry, index) => ({
        entry: suppressRedundantQuotaFamily(entry, presentation?.redundantQuotaFamily),
        index,
    }));
    const definition = getQuotaFormatStyleDefinition(style);
    if (definition.projection === "allWindows") {
        return sortSemanticRuns(entries).map(({ entry }) => entry);
    }
    const semanticEntries = entries.filter(({ entry }) => entry.semantic);
    if (semanticEntries.length === 0) {
        const legacyEntries = entries.map(({ entry }) => entry);
        const selectedEntries = presentation?.classicStrategy === "preserve"
            ? legacyEntries
            : selectSingleWindowEntries(legacyEntries, preferredWindow);
        return selectedEntries.map((entry) => projectSingleWindowEntry(entry, presentation));
    }
    const selectedSemanticEntries = selectSemanticSingleWindowEntries(semanticEntries, preferredWindow);
    const legacyEntries = entries.filter(({ entry }) => !entry.semantic);
    const selectedLegacyEntrySet = new Set(presentation?.classicStrategy === "preserve"
        ? legacyEntries.map(({ entry }) => entry)
        : selectSingleWindowEntries(legacyEntries.map(({ entry }) => entry), preferredWindow));
    const selectedLegacyEntries = legacyEntries.filter(({ entry }) => selectedLegacyEntrySet.has(entry));
    const recombined = [...selectedSemanticEntries, ...selectedLegacyEntries].sort((left, right) => left.index - right.index);
    return sortSemanticRuns(recombined).map(({ entry }) => projectSingleWindowEntry(entry, presentation));
}
export function projectQuotaProviderResults(results, style, accountingDetail, options) {
    const entries = results.flatMap((result, index) => projectProviderResultToStyle(result, style, accountingDetail, options?.preferredWindowsByResultIndex?.get(index)));
    if (options?.quotaProjection !== "runway")
        return entries;
    const nowMs = options.nowMs ?? Date.now();
    return entries.map((entry) => {
        if (!isPercentEntry(entry))
            return entry;
        const runway = projectQuotaRunway({
            percentRemaining: entry.percentRemaining,
            fixedWindow: entry.fixedWindow,
            resetTimeIso: entry.resetTimeIso,
            nowMs,
        });
        return runway ? { ...entry, runway } : entry;
    });
}
