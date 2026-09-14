import { compareAccountingSemanticEntries } from "./accounting-format.js";
import type { QuotaToastEntry } from "./entries.js";
import { cloneQuotaToastEntry } from "./entries.js";

export type GroupedRenderTarget = "toast" | "quota";

export type NormalizedGroupedQuotaEntry = QuotaToastEntry & {
  group: string;
};

export type QuotaEntryGroup = {
  group: string;
  entries: NormalizedGroupedQuotaEntry[];
};

type RankedGroupedQuotaEntry = {
  entry: NormalizedGroupedQuotaEntry;
  originalIndex: number;
  rank: number | null;
};

function trimOptional(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeDurationText(value?: string): string | undefined {
  const trimmed = trimOptional(value);
  return trimmed?.replace(/:+$/u, "").trim().toLowerCase();
}

function looksLikeGoogleModel(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === "claude" ||
    lower === "g3pro" ||
    lower === "g3flash" ||
    lower === "g3image" ||
    lower === "gpt-oss"
  );
}

function getGoogleFallbackMeta(name: string): { group: string; label: string } | undefined {
  const match = name.match(/^(.+?)\s*\((.+)\)\s*$/);
  if (!match) return undefined;

  const model = match[1]!.trim();
  const account = match[2]!.trim();
  if (!looksLikeGoogleModel(model) || !account) return undefined;

  return {
    group: `[Antigravity (${account})]`,
    label: `${model}:`,
  };
}

function getDurationRankFromText(value?: string): number | null {
  const text = normalizeDurationText(value);
  if (!text) return null;

  if (/\b(?:rpm|per minute|minute|minutes)\b/u.test(text)) return 1;
  if (/\b(?:rolling|5h|5 h|5-hour|5 hour|five-hour|five hour)\b/u.test(text)) return 300;
  if (/\b(?:hourly|1h|1 h|1-hour|1 hour|hour)\b/u.test(text)) return 60;
  if (/\b(?:7d|7 d|7-day|7 day|weekly|week)\b/u.test(text)) return 10080;
  if (/\b(?:daily|1d|1 d|1-day|1 day|day)\b/u.test(text)) return 1440;
  if (/\b(?:monthly|month)\b/u.test(text)) return 43200;
  if (/\b(?:yearly|annual|annually|year)\b/u.test(text)) return 525600;

  return null;
}

function getDurationRank(entry: NormalizedGroupedQuotaEntry): number | null {
  if (Number.isFinite(entry.sortPriority)) return entry.sortPriority!;
  return entry.label ? getDurationRankFromText(entry.label) : getDurationRankFromText(entry.name);
}

function ownStructuredEntry(entry: QuotaToastEntry): QuotaToastEntry {
  // Normalized provider results always have accounting metadata. The guard keeps this
  // presentation helper tolerant of isolated legacy test fixtures without weakening the type.
  return (entry as { accounting?: unknown }).accounting ? cloneQuotaToastEntry(entry) : entry;
}

function normalizeGroupedQuotaEntry(
  entry: QuotaToastEntry,
  target: GroupedRenderTarget,
): NormalizedGroupedQuotaEntry {
  const owned = ownStructuredEntry(entry);
  const group = trimOptional(owned.group);
  const label = trimOptional(owned.label);
  const right = trimOptional(owned.right);
  const normalized = {
    ...owned,
    ...(label ? { label } : {}),
    ...(right ? { right } : {}),
  };
  if (!label) delete normalized.label;
  if (!right) delete normalized.right;

  if (group) {
    return { ...normalized, group };
  }

  const googleFallback = getGoogleFallbackMeta(owned.name);
  if (googleFallback) {
    return {
      ...normalized,
      group: googleFallback.group,
      ...(label || target === "quota" ? { label: label ?? googleFallback.label } : {}),
    };
  }

  return {
    ...normalized,
    group: owned.name.trim(),
    ...(target === "quota" ? { label: label ?? "Status:" } : {}),
  };
}

function sortLegacyEntries(entries: RankedGroupedQuotaEntry[]): RankedGroupedQuotaEntry[] {
  return entries.slice().sort((left, right) => {
    if (left.rank !== null && right.rank !== null && left.rank !== right.rank) {
      return left.rank - right.rank;
    }
    if (left.rank !== null && right.rank === null) return -1;
    if (left.rank === null && right.rank !== null) return 1;
    return left.originalIndex - right.originalIndex;
  });
}

function sortMixedEntries(entries: RankedGroupedQuotaEntry[]): RankedGroupedQuotaEntry[] {
  if (!entries.some(({ entry }) => entry.semantic)) return sortLegacyEntries(entries);

  const sorted = entries.slice();
  let index = 0;
  while (index < sorted.length) {
    if (!sorted[index]!.entry.semantic) {
      index += 1;
      continue;
    }

    const start = index;
    while (index < sorted.length && sorted[index]!.entry.semantic) index += 1;
    const run = sorted.slice(start, index).sort((left, right) => {
      const semanticOrder = compareAccountingSemanticEntries(left.entry, right.entry);
      return semanticOrder || left.originalIndex - right.originalIndex;
    });
    sorted.splice(start, run.length, ...run);
  }
  return sorted;
}

export function groupQuotaEntries(
  entries: QuotaToastEntry[],
  target: GroupedRenderTarget,
): QuotaEntryGroup[] {
  const groupOrder: string[] = [];
  const groupedEntries = new Map<string, RankedGroupedQuotaEntry[]>();

  for (const [originalIndex, entry] of entries.entries()) {
    const normalizedEntry = normalizeGroupedQuotaEntry(entry, target);
    const rankedEntry: RankedGroupedQuotaEntry = {
      entry: normalizedEntry,
      originalIndex,
      rank: normalizedEntry.semantic ? null : getDurationRank(normalizedEntry),
    };
    const existing = groupedEntries.get(normalizedEntry.group);
    if (existing) {
      existing.push(rankedEntry);
      continue;
    }

    groupOrder.push(normalizedEntry.group);
    groupedEntries.set(normalizedEntry.group, [rankedEntry]);
  }

  return groupOrder.map((group) => {
    const rankedEntries = groupedEntries.get(group) ?? [];
    const entries = sortMixedEntries(rankedEntries).map(({ entry }) => entry);
    return { group, entries };
  });
}

export function normalizeGroupedQuotaEntries(
  entries: QuotaToastEntry[],
  target: GroupedRenderTarget,
): NormalizedGroupedQuotaEntry[] {
  return groupQuotaEntries(entries, target).flatMap((group) => group.entries);
}
