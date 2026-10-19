/**
 * The `/quota` text of Web and Desktop: the quotas next to what OpenCode's own history used.
 * Pure. One block per provider: a provider OpenCode used gets its cost and, when quota checks it
 * too, its limits; a quota provider OpenCode did not use gets only its limits.
 * `quotaProviderIdsOfUsage` matches the two.
 */
import { describeError } from "../core/errors.js";
import { paceOf, paceText } from "../core/pace.js";
import type { QuotaSnapshot, Words } from "../core/types.js";
import type { UsageProviderRow, UsageReport } from "../core/usage.js";
import { type UsageRange, usageRangeLabel } from "../core/usage-ranges.js";
import { WINDOWS } from "../core/windows.js";
import {
  getQuotaProviderDisplayLabel,
  getQuotaProviderIdsForRuntimeId,
} from "../lib/provider-metadata.js";
import { columnsOf } from "./columns.js";
import {
  DEFAULT_WORDS,
  fit,
  formatTokens,
  formatUsd,
  percentText,
  rowValueText,
} from "./format.js";
import { type Group, type RowSettings, visibleGroups } from "./select.js";
import { costText, type UsageMode, type UsageRole } from "./usage.js";

/** The range of the usage `/quota` shows. */
export const DEFAULT_QUICK_LOOK_RANGE: Exclude<UsageRange, "between"> = "7d";

type QuickLookTextInput = {
  snapshot: QuotaSnapshot | undefined;
  usage: UsageReport | undefined;
  settings: RowSettings;
  nowMs: number;
  /** The columns a line may take; without it lines are as long as they get. */
  width?: number;
};

/** A provider's block: its usage (when OpenCode used it) and its quota groups (when checked). */
type Block = { name: string; dot: UsageRole; usage?: UsageProviderRow; groups: Group[] };

/** A limit label is cut to this many columns. */
const LABEL_MAX_WIDTH = 16;
const TEXT_NAME_MAX = 20;
/** A short-text line that goes on under the one before starts this far in. */
const TEXT_CONTINUE = "  ";

/**
 * The matching table: the quota providers an OpenCode provider id (a model's `providerID`,
 * like "github-copilot" or "zai-coding-plan") stands for. The id itself (a custom provider
 * named after it), then every quota provider that lists it among its OpenCode ids.
 */
export function quotaProviderIdsOfUsage(usageProviderID: string): string[] {
  return [usageProviderID, ...getQuotaProviderIdsForRuntimeId(usageProviderID)];
}

/**
 * The quota group serves what OpenCode used under `usageProviderID`: its quota provider is one
 * that id stands for, or it shows a custom definition serving that id (`customRowProviders`).
 */
function groupServesUsage(
  group: Group,
  usageProviderID: string,
  customRowProviders: Readonly<Record<string, string>>,
): boolean {
  if (quotaProviderIdsOfUsage(usageProviderID).includes(group.providerId)) return true;
  const prefixes = Object.keys(customRowProviders).filter(
    (prefix) => customRowProviders[prefix] === usageProviderID,
  );
  return group.rows.some(({ row }) => prefixes.some((prefix) => row.id.startsWith(prefix)));
}

/** There are providers, but `onlyCurrentModel` hides them all: none serves the session's model. */
function servesNoCurrentModel(snapshot: QuotaSnapshot): boolean {
  return snapshot.providers.length > 0 && (snapshot.words ?? DEFAULT_WORDS).onlyCurrentModel;
}

/**
 * The providers and rows `/quota` shows: the sidebar's, and with `onlyCurrentModel` only
 * those serving the session's current model.
 */
function quotaGroups(snapshot: QuotaSnapshot | undefined, settings: RowSettings): Group[] {
  if (!snapshot) return [];
  return visibleGroups(snapshot, settings, "sidebar", snapshot.words ?? DEFAULT_WORDS);
}

/**
 * One block per provider OpenCode used (most cost, or most tokens, first) with the quota groups
 * it matches, then one per quota group no used provider matched, in the sidebar's order.
 */
function blocksOf(
  groups: Group[],
  snapshot: QuotaSnapshot | undefined,
  report: UsageReport | undefined,
  mode: UsageMode,
): Block[] {
  const customRowProviders = snapshot?.customRowProviders ?? {};
  const used = (report?.providers ?? []).filter((row) => row.tokens > 0);
  const ordered = mode === "cost" ? used : [...used].sort((a, b) => b.tokens - a.tokens);
  const claimed = new Set<Group>();
  const usedBlocks = ordered.map((row): Block => {
    const own = groups.filter(
      (group) => !claimed.has(group) && groupServesUsage(group, row.providerID, customRowProviders),
    );
    for (const group of own) claimed.add(group);
    const index = report?.providers.indexOf(row) ?? 0;
    // One group: its title names the account ("Custom providers (Team)").
    const name = own.length === 1 ? own[0].title : own[0]?.name;
    return {
      name: name ?? getQuotaProviderDisplayLabel(row.providerID),
      dot: `provider:${index}`,
      usage: row,
      groups: own,
    };
  });
  const unused = groups.filter((group) => !claimed.has(group));
  const quotaBlocks = unused.map(
    (group, index): Block => ({
      name: group.title,
      dot: `provider:${(report?.providers.length ?? 0) + index}`,
      groups: [group],
    }),
  );
  return [...usedBlocks, ...quotaBlocks];
}

/** A group's error and its limits in a few words: "5h 41% left · 7d 68% left". */
function shortLimits(group: Group, words: Words, nowMs: number): string[] {
  const error = group.error ? [describeError(group.error, group.name, nowMs)] : [];
  const limits = group.rows.map(({ row, label }) => {
    const name = row.window ? WINDOWS[row.window].short : fit(label, LABEL_MAX_WIDTH).trimEnd();
    if (row.percentRemaining === undefined) return `${name} ${rowValueText(row)}`;
    const percent = `${name} ${percentText(words, row.percentRemaining, true)}`;
    const pace = paceOf(row, nowMs);
    return pace?.kind === "fast" ? `${percent} ${paceText(pace, words)}` : percent;
  });
  return [...error, ...limits];
}

/** A piece of a short-text line, and what goes before it when it follows on the same line. */
type Piece = { text: string; before: string };

/**
 * The pieces on lines of at most `width` columns: a piece never splits (a wider one gets a line
 * of its own), and a line that goes on starts with `TEXT_CONTINUE`. No width: one line.
 */
function flowPieces(pieces: Piece[], width: number | undefined): string[] {
  const lines: string[] = [];
  let line = "";
  for (const piece of pieces) {
    const joined = line ? `${line}${piece.before}${piece.text}` : piece.text;
    if (!line || width === undefined || columnsOf(joined) <= width) {
      line = joined;
      continue;
    }
    lines.push(line.trimEnd());
    line = `${TEXT_CONTINUE}${piece.text}`;
  }
  return line ? [...lines, line.trimEnd()] : lines;
}

/**
 * The short text: the range and totals, then one line per provider with its limits and its
 * cost. Pace words show when the quota runs out before its reset. With `width`, a line that
 * would be wider goes on under itself, never inside an amount or a limit.
 */
export function quickLookText(input: QuickLookTextInput): string {
  const { usage, nowMs, width } = input;
  const words = input.snapshot?.words ?? DEFAULT_WORDS;
  const blocks = blocksOf(
    quotaGroups(input.snapshot, input.settings),
    input.snapshot,
    usage,
    "cost",
  );
  const header: Piece[] = [{ text: "额度", before: "" }];
  if (usage) {
    const totals =
      usage.totals.tokens.processed > 0
        ? [
            formatUsd(usage.totals.costUsd),
            `${formatTokens(usage.totals.tokens.processed)} Token`,
          ]
        : ["无用量"];
    for (const text of [usageRangeLabel(usage.range), ...totals])
      header.push({ text, before: " · " });
  }
  const nameWidth = Math.min(
    TEXT_NAME_MAX,
    Math.max(0, ...blocks.map((block) => columnsOf(block.name))),
  );
  const lines = blocks.flatMap((block) => {
    const limits = block.groups.flatMap((group) => shortLimits(group, words, nowMs));
    const pieces: Piece[] = [
      { text: `● ${fit(block.name, nameWidth)}`, before: "" },
      ...limits.map((text, index) => ({ text, before: index === 0 ? "  " : " · " })),
      ...(block.usage ? [{ text: costText(block.usage), before: "  " }] : []),
    ];
    return flowPieces(pieces, width);
  });
  if (lines.length === 0 && input.snapshot) {
    lines.push(
      servesNoCurrentModel(input.snapshot)
        ? "没有提供商为当前会话的模型提供额度。运行 /quota_status 查看原因。"
        : "未找到任何提供商。运行 /quota_status 查看原因。",
    );
  }
  return [...flowPieces(header, width), ...lines].join("\n");
}
