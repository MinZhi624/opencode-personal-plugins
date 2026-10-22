/**
 * The lines of every quota surface, built from the visible groups (`select.ts`). The TUI
 * draws each segment in its color role; the Web and terminal `/quota` text print the plain
 * text.
 */
import { describeError } from "../core/errors.js";
import { paceOf, paceText } from "../core/pace.js";
import type { QuotaRow, SessionModelInput, SessionTokens, Words } from "../core/types.js";
import { WINDOWS } from "../core/windows.js";
import { columnsOf, padEndColumns, padStartColumns } from "./columns.js";
import {
  type BarShape,
  barParts,
  type CacheHit,
  cacheHit,
  evenUseCell,
  fit,
  LOW_CACHE_MARK,
  percentText,
  percentWord,
  resetText,
  rowValueText,
  sessionTokensText,
} from "./format.js";
import { type Group, pickRow, type VisibleRow, type WindowChoice, windowFor } from "./select.js";

/** Every colored thing quota draws; the TUI maps each to a theme color. */
export type ColorRole =
  | "title"
  | "provider"
  | "account"
  | "label"
  | "good"
  | "warning"
  | "low"
  | "empty"
  | "percent"
  | "reset"
  | "value"
  | "error"
  | "statusName"
  | "separator"
  | "arrows";

/**
 * A piece of a line. `role` "bar" is the filled part of a bar, drawn in its level color.
 * `percent` is the row's percent left, for roles that follow the bar color.
 */
export type Segment = { text: string; role: ColorRole | "bar"; percent?: number; bold?: boolean };

/** A line of a surface. `id` is the provider or row it shows ("" for a spacer). */
export type Line = { id: string; segments: Segment[] };

export type Layout = {
  bar: BarShape;
  /** Bar cells, or "fill": the room the other columns leave, up to each place's most. */
  barWidth: number | "fill";
  /** The ┃ mark where even use would be, in each bar (`barSegments`). */
  evenUse: boolean;
  indent: number;
  /** The most columns a row name takes; the name column fits the names next to a bar. */
  labelWidth: number;
  /** Empty lines between providers in the sidebar. */
  providerGap: number;
  /** Between providers on the status line. */
  separator: string;
};

export function lineText(line: Line): string {
  return line.segments.map((segment) => segment.text).join("");
}

/**
 * The start of a row without a bar: its name, cut to `most` columns, then spaces up to the bar
 * column, or 2 after a name that reaches it.
 */
function valueRowStart(indent: number, name: string, most: number, barColumn: number): string {
  const text = `${" ".repeat(indent)}${columnsOf(name) > most ? fit(name, most) : name}`;
  const gap = barColumn - columnsOf(text);
  return `${text}${" ".repeat(gap >= 1 ? gap : 2)}`;
}

/** Where even use would be, the ┃ mark in a bar. */
const EVEN_USE_MARK = "┃";
/** A bar's cells at the least for the even-use mark; a shorter bar has none. */
const EVEN_USE_MIN_CELLS = 3;

/**
 * A bar in two parts: the part left in its level color, then the used part. With `evenLeft`, the
 * percent even use would leave now (`core/pace.ts`), the ┃ mark takes the place of the cell where
 * even use would be, in the row labels' color; a bar under 3 cells gets no mark.
 */
export function barSegments(
  shape: BarShape,
  percent: number,
  width: number,
  evenLeft?: number,
): Segment[] {
  const [filled, empty] = barParts(shape, percent, width);
  const bar: Segment[] = [
    { text: filled, role: "bar", percent },
    { text: empty, role: "empty", percent },
  ];
  if (evenLeft === undefined || shape === "none" || width < EVEN_USE_MIN_CELLS) return bar;
  const mark = evenUseCell(evenLeft, width);
  const marked: Segment[] = [];
  let start = 0;
  for (const segment of bar) {
    const cells = [...segment.text];
    const at = mark - start;
    start += cells.length;
    if (at < 0 || at >= cells.length) {
      marked.push(segment);
      continue;
    }
    marked.push(
      { ...segment, text: cells.slice(0, at).join("") },
      { text: EVEN_USE_MARK, role: "label" },
      { ...segment, text: cells.slice(at + 1).join("") },
    );
  }
  return marked.filter((segment) => segment.text !== "");
}

/** Where even use would be for a row's bar, when the place draws the mark and the row has a pace. */
function evenLeftOf(on: boolean | undefined, row: QuotaRow, nowMs: number): number | undefined {
  return on ? paceOf(row, nowMs)?.evenLeft : undefined;
}

/** The words for a group's last error ("请重新登录"); undefined when its last check worked. */
function errorWords(group: Group, nowMs: number): Segment | undefined {
  return group.error
    ? { text: describeError(group.error, group.name, nowMs), role: "error" }
    : undefined;
}

/** The words after a group's title: its error, or "尚未检查" before the first check. */
function groupState(group: Group, nowMs: number): Segment | undefined {
  if (group.error) return errorWords(group, nowMs);
  if (group.unchecked) return { text: "尚未检查", role: "value" };
  return undefined;
}

/**
 * "runs out in 1h 5m" when the surface shows it (`on`) and the row, used at its pace so far,
 * runs out before it resets.
 */
function runsOutText(
  on: boolean | undefined,
  row: QuotaRow,
  nowMs: number,
  words: Words,
): string | undefined {
  const pace = on ? paceOf(row, nowMs) : undefined;
  return pace?.runsOutInMs === undefined ? undefined : paceText(pace, words);
}

/** Marks rows kept from an earlier check when there is no room for the error's words. */
const ERROR_MARK = "⚠";

/** Cuts the segments so their text fits in `width` terminal columns. */
function cut(segments: Segment[], width: number): Segment[] {
  const clipped: Segment[] = [];
  let room = width;
  for (const segment of segments) {
    if (room <= 0) break;
    const text = columnsOf(segment.text) > room ? fit(segment.text, room) : segment.text;
    clipped.push({ ...segment, text });
    room -= columnsOf(text);
  }
  return clipped;
}

/**
 * Cuts the segments so their text fits in `width` terminal columns. An error never goes
 * away: when not even the start of its words fits, the line ends in " ⚠" instead.
 */
function clip(segments: Segment[], width: number): Segment[] {
  const clipped = cut(segments, width);
  const error = segments.find((segment) => segment.role === "error");
  if (!error) return clipped;
  const kept = clipped.find((segment) => segment.role === "error");
  const mark = ` ${ERROR_MARK}`;
  if ((kept && /[\p{L}\p{N}]|⚠/u.test(kept.text)) || width < columnsOf(mark)) return clipped;
  const rest = segments.filter((segment) => segment !== error);
  return [...cut(rest, width - columnsOf(mark)), { ...error, text: mark }];
}

/**
 * A row's name on the sidebar, the collapsed panel, the status line and a toast: your name for
 * it; else, with `words.rowNames` "short", its window's short name ("5h", "7d") when no other
 * row of its group has the same one; else its label.
 */
export function rowName(item: VisibleRow, group: Pick<Group, "rows">, words: Words): string {
  if (words.rowNames === "full" || item.named || !item.row.window) {
    return item.label;
  }
  const short = WINDOWS[item.row.window].short;
  const shared = group.rows.some(
    (other) => other !== item && other.row.window && WINDOWS[other.row.window].short === short,
  );
  return shared ? item.label : short;
}

type SidebarInput = {
  groups: Group[];
  layout: Layout;
  words: Words;
  nowMs: number;
  /** Columns the sidebar gives quota. */
  width: number;
  sessionTokens?: SessionTokens;
  /** A "runs out in 2h" line under each row that runs out before its reset. */
  runsOut?: boolean;
};

/** §4.1: the expanded panel's title, with the percent's word its rows leave out: "▼ 额度剩余". */
export function sidebarTitle(words: Words): string {
  const word = percentWord(words);
  return word ? `▼ 额度${word}` : "▼ 额度";
}

/**
 * A group's title line: the provider's name in bold and its account, then (`withState`) its
 * error or "尚未检查" after two spaces. Cut to `width` columns.
 */
function groupLine(group: Group, nowMs: number, width: number, withState: boolean): Line {
  const state = withState ? groupState(group, nowMs) : undefined;
  // An account that already starts with a parenthesis keeps its own brackets,
  // so "Plus · Codex CLI 登录" and "(Plus) extra" never render as "((…))".
  const account = group.account
    ? /^[（(]/u.test(group.account)
      ? ` ${group.account}`
      : ` (${group.account})`
    : "";
  return {
    id: group.providerId,
    segments: clip(
      [
        { text: group.name, role: "provider", bold: true },
        ...(account ? [{ text: account, role: "account" as const }] : []),
        ...(state ? [{ ...state, text: `  ${state.text}` }] : []),
      ],
      width,
    ),
  };
}

/** "会话  12.3K 输入 · 2.10K 输出", cut to `width` columns. */
function sessionLine(tokens: SessionTokens, width: number): Line {
  return {
    id: "session",
    segments: clip(
      [
        { text: "会话", role: "label", bold: true },
        { text: `  ${sessionTokensText(tokens)}`, role: "value" },
      ],
      width,
    ),
  };
}

/**
 * "⚠ 缓存命中率低：35% (claude-sonnet-5)" for the model with the lowest cache hit among those
 * whose cache hit is low (`cacheHit`), its name cut to fit `width`; undefined when none is.
 */
function lowCacheLine(models: SessionModelInput[], width: number): Line | undefined {
  let worst: { modelID: string; hit: CacheHit } | undefined;
  for (const model of models) {
    const hit = cacheHit(model);
    if (!hit?.low) continue;
    if (!worst || hit.share < worst.hit.share) worst = { modelID: model.modelID, hit };
  }
  if (!worst) return undefined;
  const start = `${LOW_CACHE_MARK} 缓存命中率低：${worst.hit.text}`;
  const nameRoom = width - columnsOf(start) - " ()".length;
  const name = worst.modelID;
  const text =
    nameRoom >= 2
      ? `${start} (${fit(name, Math.min(columnsOf(name), nameRoom)).trimEnd()})`
      : start;
  return { id: "session", segments: clip([{ text, role: "warning" }], width) };
}

/** The most cells a "fill" bar takes on the sidebar. */
const SIDEBAR_BAR_MOST = 20;

/**
 * §4.1: the expanded Quota panel, below its title line (`sidebarTitle`). The name column fits
 * the longest name next to a bar; a row without a bar (a balance) starts its value there, or 2
 * columns after a longer name.
 */
export function sidebarLines(input: SidebarInput): Line[] {
  const { layout, words, nowMs, width } = input;
  const percentRows = input.groups.flatMap((group) =>
    group.rows
      .filter((item) => item.row.percentRemaining !== undefined)
      .map((item) => ({ ...item, name: rowName(item, group, words) })),
  );
  const resetWidth =
    1 + Math.max(0, ...percentRows.map((item) => columnsOf(resetText(item.row, nowMs, words))));
  const nameWidth = Math.min(
    layout.labelWidth,
    Math.max(0, ...percentRows.map((item) => columnsOf(item.name))),
  );
  const barColumn = layout.indent + nameWidth + 1;
  const fixed = barColumn + 5 + resetWidth;
  const wanted = layout.barWidth === "fill" ? SIDEBAR_BAR_MOST : layout.barWidth;
  const barWidth = layout.bar === "none" ? 0 : Math.max(0, Math.min(wanted, width - fixed));

  const rowLine = (item: VisibleRow, group: Group): Line => {
    const { row } = item;
    const percent = row.percentRemaining;
    const name = rowName(item, group, words);
    if (percent === undefined) {
      const start = valueRowStart(layout.indent, name, layout.labelWidth, barColumn);
      return {
        id: row.id,
        segments: clip(
          [
            { text: start, role: "label" },
            { text: rowValueText(row), role: "value" },
          ],
          width,
        ),
      };
    }
    const labelText = `${" ".repeat(layout.indent)}${fit(name, nameWidth)} `;
    return {
      id: row.id,
      segments: [
        { text: labelText, role: "label", percent },
        ...barSegments(layout.bar, percent, barWidth, evenLeftOf(layout.evenUse, row, nowMs)),
        { text: padStartColumns(percentText(words, percent, false), 5), role: "percent", percent },
        {
          text: padStartColumns(resetText(row, nowMs, words), resetWidth),
          role: "reset",
          percent,
        },
      ],
    };
  };

  const lines: Line[] = [];
  input.groups.forEach((group, index) => {
    if (index > 0) {
      for (let gap = 0; gap < layout.providerGap; gap++) lines.push({ id: "", segments: [] });
    }
    lines.push(groupLine(group, nowMs, width, true));
    for (const item of group.rows) {
      lines.push(rowLine(item, group));
      const runsOut = runsOutText(input.runsOut, item.row, nowMs, words);
      if (!runsOut) continue;
      const text = `${" ".repeat(barColumn)}${runsOut}`;
      lines.push({ id: item.row.id, segments: clip([{ text, role: "warning" }], width) });
    }
  });
  if (input.sessionTokens) {
    for (let gap = 0; gap < layout.providerGap; gap++) lines.push({ id: "", segments: [] });
    lines.push(sessionLine(input.sessionTokens, width));
    const lowCache = lowCacheLine(input.sessionTokens.models ?? [], width);
    if (lowCache) lines.push(lowCache);
  }
  return lines;
}

/** §4.2: the collapsed panel's title. A provider with several accounts counts once. */
export function collapsedTitle(groups: Group[]): string {
  const count = new Set(groups.map((group) => group.providerId)).size;
  const errors = new Set(groups.filter((group) => group.error).map((group) => group.providerId))
    .size;
  return `▶ 额度 (${count} 个提供商${errors ? `，${errors} 个错误` : ""})`;
}

/** A collapsed line's provider (10) and row name (5) columns. */
const COLLAPSED_NAMES = 15;
/** The most cells a collapsed bar takes. */
const COLLAPSED_BAR_MOST = 10;

type CollapsedInput = {
  groups: Group[];
  layout: Layout;
  words: Words;
  nowMs: number;
  width: number;
  /** Preferred window by provider id, or for all providers (`windowFor`). */
  window: Record<string, WindowChoice>;
  /** A "runs out in 2h" line under each provider whose shown row runs out before its reset. */
  runsOut?: boolean;
};

/**
 * §4.2: one line per provider with its preferred window. When the last check failed, the
 * error's words take the place of the reset time next to the rows kept from before. The bar
 * takes the room the names, the percent and the longest reset time leave, at most 10 cells.
 */
export function collapsedLines(input: CollapsedInput): Line[] {
  const { layout, words, nowMs } = input;
  const picks = input.groups.map((group) => ({
    group,
    picked: pickRow(group, windowFor(input.window, group.providerId)),
  }));
  const withWord = words.percent === "used";
  // The percent after a space: " 100%", or "  100% 已用" with its word.
  const percentWidth = withWord ? 10 : 5;
  // The reset as wide as the longest, at least "11h 59m".
  const resetWidth = Math.max(
    7,
    ...picks.map(({ picked }) =>
      picked?.row.percentRemaining === undefined
        ? 0
        : columnsOf(resetText(picked.row, nowMs, words)),
    ),
  );
  const room = input.width - COLLAPSED_NAMES - percentWidth - 1 - resetWidth;
  const wanted = layout.barWidth === "fill" ? COLLAPSED_BAR_MOST : layout.barWidth;
  const barWidth =
    layout.bar === "none" ? 0 : Math.max(0, Math.min(wanted, COLLAPSED_BAR_MOST, room));
  const providerLine = (group: Group, picked: VisibleRow | undefined): Line => {
    const percent = picked?.row.percentRemaining;
    const name: Segment = { text: `${fit(group.title, 9)} `, role: "provider", percent };
    const state = groupState(group, nowMs);
    if (!picked || percent === undefined) {
      const value: Segment = state ?? {
        text: picked ? rowValueText(picked.row) : "",
        role: "value",
      };
      return { id: group.providerId, segments: clip([name, value], input.width) };
    }
    const error = errorWords(group, nowMs);
    return {
      id: group.providerId,
      segments: clip(
        [
          name,
          { text: `${fit(rowName(picked, group, words), 4)} `, role: "label", percent },
          ...barSegments(
            layout.bar,
            percent,
            barWidth,
            evenLeftOf(layout.evenUse, picked.row, nowMs),
          ),
          {
            text: padStartColumns(percentText(words, percent, withWord), percentWidth),
            role: "percent",
            percent,
          },
          error
            ? { ...error, text: `  ${error.text}` }
            : {
                text: ` ${padStartColumns(resetText(picked.row, nowMs, words), resetWidth)}`,
                role: "reset",
                percent,
              },
        ],
        input.width,
      ),
    };
  };
  return picks.flatMap(({ group, picked }) => {
    const line = providerLine(group, picked);
    const runsOut = picked && runsOutText(input.runsOut, picked.row, nowMs, words);
    if (!runsOut) return [line];
    const text = `${" ".repeat(10)}${runsOut}`;
    return [
      line,
      { id: group.providerId, segments: clip([{ text, role: "warning" }], input.width) },
    ];
  });
}

/** How much one status line segment shows, from the most to the least. */
export type StatusLevel = "full" | "bar" | "reset" | "numbers";
const STATUS_LEVELS: readonly StatusLevel[] = ["full", "bar", "reset", "numbers"];
/** The status line's little bar. */
const STATUS_BAR_WIDTH = 5;

export type StatusInput = {
  groups: Group[];
  layout: Layout;
  words: Words;
  nowMs: number;
  window: Record<string, WindowChoice>;
  /** "(runs out in 2h)" after each provider whose shown row runs out before its reset. */
  runsOut?: boolean;
};

/** A provider's name on the status line: with its account only when it shows several. */
function statusName(input: StatusInput, group: Group): string {
  const accounts = input.groups.filter((other) => other.providerId === group.providerId).length;
  return accounts > 1 ? group.title : group.name;
}

/**
 * One provider's status line segment at a level of detail (without the separator). When the
 * last check failed, the error's words take the place of the reset time next to the rows kept
 * from before, or "⚠" where the level shows no reset time.
 */
function statusSegment(input: StatusInput, group: Group, level: StatusLevel): Line {
  const { layout, words, nowMs } = input;
  const picked = pickRow(group, windowFor(input.window, group.providerId));
  const percent = picked?.row.percentRemaining;
  const name: Segment = { text: statusName(input, group), role: "statusName", percent };
  if (!picked || percent === undefined) {
    const state = groupState(group, nowMs);
    const value = state ?? { text: picked ? rowValueText(picked.row) : "", role: "value" };
    return { id: group.providerId, segments: [name, { ...value, text: ` ${value.text}` }] };
  }
  const withBar = layout.bar !== "none" && (level === "full" || level === "bar");
  const withReset = level === "full" || level === "reset";
  const error = errorWords(group, nowMs);
  const reset = withReset ? resetText(picked.row, nowMs, words) : "";
  const after: Segment | undefined = error
    ? { ...error, text: ` ${withReset ? error.text : ERROR_MARK}` }
    : reset
      ? { text: ` ${reset}`, role: "reset", percent }
      : undefined;
  const runsOut = runsOutText(input.runsOut, picked.row, nowMs, words);
  return {
    id: group.providerId,
    segments: [
      name,
      ...(withBar
        ? [
            { text: " ", role: "separator" as const },
            ...barSegments(
              layout.bar,
              percent,
              STATUS_BAR_WIDTH,
              evenLeftOf(layout.evenUse, picked.row, nowMs),
            ),
          ]
        : []),
      {
        text: ` ${percentText(words, percent, words.percent === "used")}`,
        role: "percent",
        percent,
      },
      ...(after ? [after] : []),
      ...(runsOut ? [{ text: ` (${runsOut})`, role: "warning" as const }] : []),
    ],
  };
}

export type StatusLayout = {
  level: StatusLevel;
  /** The first group shown (the line scrolls when not all groups fit). */
  start: number;
  shown: Line[];
  /** Groups after the shown ones: the "+N ›" marker. */
  hiddenAfter: number;
};

/** Cuts the name (the first segment) so the rest still fits in `width`; else cuts the end. */
function shortenName(segments: Segment[], width: number): Segment[] {
  const [name, ...rest] = segments;
  const nameWidth = width - columnsOf(rest.map((segment) => segment.text).join(""));
  if (!name || nameWidth < 2) return clip(segments, width);
  return [{ ...name, text: fit(name.text, nameWidth) }, ...rest];
}

/**
 * §4.3 "all" mode: the most detail that fits every group in `room` columns ("% only" when
 * nothing else fits), then the groups that fit from `start`, keeping room for the "‹ " and
 * " +N ›" markers. When not even the first of them fits, its name is cut short, so the
 * markers stay. `level` fixes the detail instead of "auto".
 */
export function statusLayout(
  input: StatusInput,
  room: number,
  start: number,
  level: StatusLevel | "auto",
): StatusLayout {
  const { groups } = input;
  const separator = input.layout.separator;
  const widthAt = (candidate: StatusLevel) =>
    groups.reduce(
      (sum, group) => sum + columnsOf(lineText(statusSegment(input, group, candidate))),
      0,
    ) +
    Math.max(0, groups.length - 1) * columnsOf(separator);
  const chosen =
    level !== "auto"
      ? level
      : (STATUS_LEVELS.find((candidate) => widthAt(candidate) <= room) ?? "numbers");
  const first = Math.max(0, Math.min(start, groups.length - 1));
  const shown: Line[] = [];
  let used = first > 0 ? 2 : 0;
  const markerWidth = (index: number) =>
    index < groups.length - 1 ? columnsOf(` +${groups.length - index} ›`) : 0;
  for (let index = first; index < groups.length; index++) {
    const segment = statusSegment(input, groups[index] as Group, chosen);
    const width = columnsOf(lineText(segment)) + (shown.length > 0 ? columnsOf(separator) : 0);
    if (used + width + markerWidth(index) > room) break;
    shown.push(segment);
    used += width;
  }
  const firstGroup = groups[first];
  const left = room - used - markerWidth(first);
  if (shown.length === 0 && firstGroup && left > 0) {
    const segment = statusSegment(input, firstGroup, chosen);
    shown.push({ ...segment, segments: shortenName(segment.segments, left) });
  }
  return { level: chosen, start: first, shown, hiddenAfter: groups.length - first - shown.length };
}

/**
 * §4.3 "one provider, big bar" (v5's prompt bar): the first group with a 10-cell bar. The
 * error's words take the place of the reset time; without a percent row the line shows the
 * group's error or value instead of a bar. Cut to `width` columns when given, keeping " ⚠"
 * when the error's words don't fit.
 */
export function bigStatusLine(input: StatusInput, width?: number): Line | undefined {
  const group = input.groups[0];
  if (!group) return undefined;
  const picked = pickRow(group, windowFor(input.window, group.providerId));
  const percent = picked?.row.percentRemaining;
  if (!picked || percent === undefined) {
    const line = statusSegment(input, group, "full");
    return width === undefined ? line : { ...line, segments: clip(line.segments, width) };
  }
  const error = errorWords(group, input.nowMs);
  const reset = resetText(picked.row, input.nowMs, input.words);
  const after: Segment | undefined = error
    ? { ...error, text: ` · ${error.text}` }
    : reset
      ? { text: ` · ${reset}`, role: "reset", percent }
      : undefined;
  const runsOut = runsOutText(input.runsOut, picked.row, input.nowMs, input.words);
  const segments: Segment[] = [
    {
      text: `${statusName(input, group)} ${rowName(picked, group, input.words)} `,
      role: "statusName",
      percent,
    },
    ...barSegments(
      input.layout.bar,
      percent,
      10,
      evenLeftOf(input.layout.evenUse, picked.row, input.nowMs),
    ),
    { text: ` ${percentText(input.words, percent, true)}`, role: "percent", percent },
    ...(after ? [after] : []),
    ...(runsOut ? [{ text: ` · ${runsOut}`, role: "warning" as const }] : []),
  ];
  return { id: group.providerId, segments: width === undefined ? segments : clip(segments, width) };
}

/** The name column of plain lines: the provider and the row's label. */
const PLAIN_NAME_WIDTH = 19;

/**
 * §4.4: plain text, one line per visible row, then a line per provider error. The Web and
 * terminal `/quota` text print these.
 */
export function plainLines(params: {
  groups: Group[];
  words: Words;
  nowMs: number;
  sessionTokens?: SessionTokens;
  /** "runs out in 2h" after each row that runs out before its reset. */
  runsOut?: boolean;
}): string[] {
  const { words, nowMs } = params;
  const lines = params.groups.flatMap((group) => {
    const rows = group.rows.map(({ row, label }) => {
      const name = fit(`${group.title} ${label}`, PLAIN_NAME_WIDTH);
      if (row.percentRemaining === undefined) return `${name} ${rowValueText(row)}`.trimEnd();
      const percent = padEndColumns(percentText(words, row.percentRemaining, true), 13);
      const line = `${name} ${percent} ${resetText(row, nowMs, words)}`.trimEnd();
      const runsOut = runsOutText(params.runsOut, row, nowMs, words);
      return runsOut ? `${line}  ${runsOut}` : line;
    });
    const state = groupState(group, nowMs);
    return state ? [...rows, `${fit(group.title, PLAIN_NAME_WIDTH)} ${state.text}`] : rows;
  });
  return params.sessionTokens
    ? [...lines, `会话  ${sessionTokensText(params.sessionTokens)}`]
    : lines;
}

/**
 * How a toast lays out its rows: one line per row under its provider's name ("grouped"), or
 * each row on two lines with a bar as wide as the toast ("detailed").
 */
export type ToastLayout = "grouped" | "detailed";

export type ToastInput = {
  groups: Group[];
  words: Words;
  nowMs: number;
  layout: ToastLayout;
  bar: BarShape;
  /** The ┃ mark where even use would be, in each bar (`layout.evenUse`). */
  evenUse?: boolean;
  /** Columns of text inside the toast (`toastRoom`); no line is wider. */
  room: number;
  /** A "runs out in 2h" line under each row that runs out before its reset. */
  runsOut?: boolean;
  sessionTokens?: SessionTokens;
};

/** A toast bar's cells at the least; with less room the row has no bar. */
const TOAST_BAR_MIN = 3;
/** A grouped toast's row indent, its name column and its bar at the most. */
const GROUPED_INDENT = 2;
const GROUPED_NAME_MAX = 9;
const GROUPED_BAR_MAX = 20;

/** The segments without the spaces at the end of their line. */
function trimEnd(segments: Segment[]): Segment[] {
  const trimmed = [...segments];
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1] as Segment;
    const text = last.text.trimEnd();
    if (text) {
      trimmed[trimmed.length - 1] = { ...last, text };
      break;
    }
    trimmed.pop();
  }
  return trimmed;
}

/** "runs out in 2h" at `column`, or further left so it ends inside `room`. */
function runsOutLine(id: string, runsOut: string, column: number, room: number): Line {
  const indent = Math.max(0, Math.min(column, room - columnsOf(runsOut)));
  return {
    id,
    segments: clip([{ text: `${" ".repeat(indent)}${runsOut}`, role: "warning" }], room),
  };
}

/**
 * The grouped toast: a line per provider account with its error, then its rows indented 2:
 * the name, a bar in the room the other columns leave (at most 20 cells), the percent and the
 * reset time. "runs out in" goes under the row at the bar's column. The name column fits the
 * longest name next to a bar; a row without a bar starts its value there, or 2 columns after a
 * longer name.
 */
function groupedToastLines(input: ToastInput): Line[] {
  const { words, nowMs, room } = input;
  const word = percentWord(words);
  // "100% 剩余": the number right-aligned, then its word.
  const percentWidth = 4 + (word ? columnsOf(word) + 1 : 0);
  const named = input.groups.map((group) => ({
    group,
    rows: group.rows.map((item) => ({ ...item, name: rowName(item, group, words) })),
  }));
  const items = named.flatMap(({ rows }) => rows);
  const resetWidth = Math.max(
    0,
    ...items.map(({ row }) =>
      row.percentRemaining === undefined ? 0 : columnsOf(resetText(row, nowMs, words)),
    ),
  );
  const nameWidth = Math.min(
    GROUPED_NAME_MAX,
    Math.max(
      0,
      ...items
        .filter(({ row }) => row.percentRemaining !== undefined)
        .map(({ name }) => columnsOf(name)),
    ),
  );
  const barColumn = GROUPED_INDENT + nameWidth + 1;
  const fixed = barColumn + 1 + percentWidth + (resetWidth > 0 ? 2 + resetWidth : 0);
  const barWidth = input.bar === "none" ? 0 : Math.min(GROUPED_BAR_MAX, room - fixed);
  const withBar = barWidth >= TOAST_BAR_MIN;

  const rowLines = (item: (typeof items)[number]): Line[] => {
    const { row } = item;
    const percent = row.percentRemaining;
    if (percent === undefined) {
      const start = valueRowStart(GROUPED_INDENT, item.name, GROUPED_NAME_MAX, barColumn);
      const value: Segment = { text: rowValueText(row), role: "value" };
      return [{ id: row.id, segments: clip([{ text: start, role: "label" }, value], room) }];
    }
    const name = `${" ".repeat(GROUPED_INDENT)}${fit(item.name, nameWidth)} `;
    const number = percentText(words, percent, false).padStart(4);
    const reset = resetText(row, nowMs, words);
    const segments: Segment[] = [
      { text: name, role: "label", percent },
      ...(withBar
        ? barSegments(input.bar, percent, barWidth, evenLeftOf(input.evenUse, row, nowMs))
        : []),
      {
        text: `${withBar ? " " : ""}${word ? `${number} ${word}` : number}`,
        role: "percent",
        percent,
      },
      ...(reset ? [{ text: `  ${reset}`, role: "reset" as const, percent }] : []),
    ];
    const line: Line = { id: row.id, segments: clip(segments, room) };
    const runsOut = runsOutText(input.runsOut, row, nowMs, words);
    return runsOut ? [line, runsOutLine(row.id, runsOut, barColumn, room)] : [line];
  };

  const lines = named.flatMap(({ group, rows }) => [
    groupLine(group, nowMs, room, true),
    ...rows.flatMap(rowLines),
  ]);
  return input.sessionTokens ? [...lines, sessionLine(input.sessionTokens, room)] : lines;
}

/**
 * `left` at the start of a line `room` columns wide and `right` at its end; `left` is cut with
 * "…" when both don't fit.
 */
function spread(left: Segment, right: Segment, room: number): Segment[] {
  const leftRoom = room - columnsOf(right.text) - 1;
  if (leftRoom < 1) return clip([left, { ...right, text: ` ${right.text}` }], room);
  const leftText = columnsOf(left.text) > leftRoom ? fit(left.text, leftRoom) : left.text;
  const gap = " ".repeat(room - columnsOf(leftText) - columnsOf(right.text));
  return [
    { ...left, text: leftText },
    { ...right, text: `${gap}${right.text}` },
  ];
}

/**
 * The detailed toast (v5's look): an empty line between providers, the provider's name, its
 * error under it, then per row its name with the reset time at the right, and a bar as wide
 * as the toast with the percent at the right. "runs out in" goes under the bar.
 */
function detailedToastLines(input: ToastInput): Line[] {
  const { words, nowMs, room } = input;
  const percents = input.groups.flatMap((group) =>
    group.rows.flatMap(({ row }) =>
      row.percentRemaining === undefined ? [] : [percentText(words, row.percentRemaining, true)],
    ),
  );
  const percentWidth = Math.max(0, ...percents.map(columnsOf));
  const barWidth = input.bar === "none" ? 0 : room - 2 - percentWidth;

  const rowLines = (item: VisibleRow, group: Group): Line[] => {
    const { row } = item;
    const percent = row.percentRemaining;
    const name: Segment = { text: rowName(item, group, words), role: "label", percent };
    if (percent === undefined) {
      const value: Segment = { text: rowValueText(row), role: "value" };
      return [{ id: row.id, segments: spread(name, value, room) }];
    }
    const reset = resetText(row, nowMs, words);
    const percentWords = padStartColumns(percentText(words, percent, true), percentWidth);
    const bar: Segment[] =
      barWidth >= TOAST_BAR_MIN
        ? [
            ...barSegments(input.bar, percent, barWidth, evenLeftOf(input.evenUse, row, nowMs)),
            { text: `  ${percentWords}`, role: "percent", percent },
          ]
        : [{ text: padStartColumns(percentWords, room), role: "percent", percent }];
    const runsOut = runsOutText(input.runsOut, row, nowMs, words);
    return [
      {
        id: row.id,
        segments: reset
          ? spread(name, { text: reset, role: "reset", percent }, room)
          : clip([name], room),
      },
      { id: row.id, segments: clip(bar, room) },
      ...(runsOut ? [runsOutLine(row.id, runsOut, 0, room)] : []),
    ];
  };

  const blank: Line = { id: "", segments: [] };
  const lines = input.groups.flatMap((group, index) => {
    const state = groupState(group, nowMs);
    return [
      ...(index > 0 ? [blank] : []),
      groupLine(group, nowMs, room, false),
      ...(state ? [{ id: group.providerId, segments: clip([state], room) }] : []),
      ...group.rows.flatMap((item) => rowLines(item, group)),
    ];
  });
  if (!input.sessionTokens) return lines;
  const session = spread(
    { text: "会话", role: "label", bold: true },
    { text: sessionTokensText(input.sessionTokens), role: "value" },
    room,
  );
  return [...lines, ...(lines.length > 0 ? [blank] : []), { id: "session", segments: session }];
}

/** §4.4: a quota toast's lines in its layout, none wider than `room` columns. */
export function toastLines(input: ToastInput): Line[] {
  const lines = input.layout === "detailed" ? detailedToastLines(input) : groupedToastLines(input);
  return lines.map((line) => ({ ...line, segments: trimEnd(line.segments) }));
}
