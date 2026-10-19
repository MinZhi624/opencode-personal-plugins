/**
 * The lines of the quota window's Limits tab: every provider and row of the snapshot, in the
 * sidebar's order, under your names for the rows, else their full names. Pure. Its times are
 * always exact ("2h 30m"), whatever the reset words.
 *
 * All rows share one grid: label │ bar │ percent │ reset │ pace, each column as wide as its
 * widest entry, the percent right-aligned. The bar has your bar shape (the thin ━─ line when bars
 * are off) with the even-use marker ┃ (`core/pace.ts`) and takes the room the other columns
 * leave, so the grid always spans the window. A provider's line has its name and plan; an error
 * gets its own line under it. Like the window's other tabs, a provider's line starts one column
 * in, its rows and its error three.
 *
 * A narrower window first shortens "2h 30m 后重置" to "2h", then the labels, and then puts
 * the reset and the pace on a line under the bar (on two lines when they don't fit together).
 */
import { describeError } from "../../core/errors.js";
import { paceOf, paceText } from "../../core/pace.js";
import type { QuotaSnapshot, Words } from "../../core/types.js";
import { columnsOf, padEndColumns, padStartColumns, sliceColumns } from "../../view/columns.js";
import {
  type BarShape,
  DEFAULT_WORDS,
  fit,
  percentText,
  resetText,
  rowValueText,
} from "../../view/format.js";
import { type Group, type RowSettings, type VisibleRow, visibleGroups } from "../../view/select.js";
import { barSegments, type Layout, type Line, type Segment } from "../../view/text.js";

/** Before a provider's name. */
const HEADING_INDENT = " ";
/** Before a row's label, an error and the line that says no provider was found. */
const INDENT = "   ";
/** Between the label, the bar and the percent. */
const GAP = "  ";
/** Before the reset and before the pace. */
const WIDE_GAP = "   ";
const LABEL_MAX = 24;
/** The labels are cut to this before the reset and the pace move under the bar. */
const LABEL_NARROW = 12;
const BAR_MAX = 80;
/** The bar each step down to a narrower grid needs; below the last, rows take two lines. */
const BAR_ROOMY = 20;
const BAR_SHORT = 14;
const BAR_MIN = 8;

/** One row's texts, before they are fitted to the grid. */
type RowTexts = {
  item: VisibleRow;
  percent?: number;
  percentWords: string;
  /** The reset in the words' style, and in the short style ("2h", "4d 12h"). */
  reset: string;
  shortReset: string;
  pace?: Segment;
  evenLeft?: number;
};

/** The grid's column widths; `narrow` puts the reset and the pace under the bar. */
type Grid = {
  label: number;
  bar: number;
  percent: number;
  reset: number;
  pace: number;
  longReset: boolean;
  narrow: boolean;
  /** Where the bar starts; the narrow layout's reset and pace line starts there too. */
  barColumn: number;
};

export type LimitsInput = {
  snapshot: QuotaSnapshot;
  /** The display settings: row names, the sidebar's order and the bar shape. */
  display: RowSettings & { layout: Pick<Layout, "bar"> };
  nowMs: number;
  /** Columns inside the window. */
  width: number;
};

function rowTexts(item: VisibleRow, words: Words, nowMs: number): RowTexts {
  const percent = item.row.percentRemaining;
  if (percent === undefined) {
    return { item, percentWords: rowValueText(item.row), reset: "", shortReset: "" };
  }
  const pace = paceOf(item.row, nowMs);
  const exact: Words = { ...words, reset: "exact" };
  return {
    item,
    percent,
    percentWords: percentText(words, percent, true),
    reset: resetText(item.row, nowMs, exact),
    shortReset: resetText(item.row, nowMs, { ...words, reset: "short" }),
    ...(pace
      ? {
          pace: { text: paceText(pace, exact), role: pace.kind === "fast" ? "warning" : "value" },
          evenLeft: pace.evenLeft,
        }
      : {}),
  };
}

const widest = (texts: string[]) => Math.max(0, ...texts.map(columnsOf));
function resetWords(row: RowTexts, long: boolean): string {
  if (!row.reset) return "";
  return long ? `${row.reset} 后重置` : row.shortReset;
}

/** The widest grid that fits `width`, giving way in the order the file comment describes. */
function gridFor(rows: RowTexts[], width: number): Grid {
  const bars = rows.filter((row) => row.percent !== undefined);
  const labelWidest = Math.min(LABEL_MAX, widest(rows.map((row) => row.item.label)));
  if (bars.length === 0) {
    // Only balances and other values: they line up at their right ends.
    const barColumn = INDENT.length + labelWidest + GAP.length;
    const values = widest(rows.map((row) => row.percentWords));
    const percent = Math.max(1, Math.min(values, width - barColumn));
    return {
      label: labelWidest,
      bar: 0,
      percent,
      reset: 0,
      pace: 0,
      longReset: true,
      narrow: false,
      barColumn,
    };
  }
  const percent = widest(bars.map((row) => row.percentWords));
  const pace = widest(bars.map((row) => row.pace?.text ?? ""));
  const build = (longReset: boolean, label: number, narrow: boolean): Grid => {
    const reset = widest(bars.map((row) => resetWords(row, longReset)));
    const barColumn = INDENT.length + label + GAP.length;
    const tail = narrow
      ? 0
      : (reset > 0 ? WIDE_GAP.length + reset : 0) + (pace > 0 ? WIDE_GAP.length + pace : 0);
    const fixed = barColumn + GAP.length + percent + tail;
    const bar = Math.min(BAR_MAX, Math.max(1, width - fixed));
    return { label, bar, percent, reset, pace, longReset, narrow, barColumn };
  };
  const roomy = build(true, labelWidest, false);
  if (roomy.bar >= BAR_ROOMY) return roomy;
  const short = build(false, labelWidest, false);
  if (short.bar >= BAR_SHORT) return short;
  const cut = build(false, Math.min(labelWidest, LABEL_NARROW), false);
  if (cut.bar >= BAR_MIN) return cut;
  // A very narrow window cuts the labels further, down to 4 columns, to keep the bar.
  const room = width - INDENT.length - 2 * GAP.length - percent - BAR_MIN;
  return build(true, Math.min(labelWidest, LABEL_NARROW, Math.max(4, room)), true);
}

/** The line without the spaces at its end. */
function trimmed(segments: Segment[]): Segment[] {
  const out = segments.map((segment) => ({ ...segment }));
  while (out.length > 0) {
    const last = out[out.length - 1];
    last.text = last.text.trimEnd();
    if (last.text !== "") break;
    out.pop();
  }
  return out;
}

function rowLines(texts: RowTexts, grid: Grid, width: number, shape: BarShape): Line[] {
  const { item, percent, percentWords } = texts;
  const id = item.row.id;
  const label: Segment = {
    text: `${INDENT}${fit(item.label, grid.label)}${GAP}`,
    role: "label",
    percent,
  };
  if (percent === undefined) {
    // A balance or other value ends where the percents end, so the amounts line up.
    const end = grid.bar > 0 ? grid.bar + GAP.length + grid.percent : grid.percent;
    const room = Math.max(1, Math.min(end, width - grid.barColumn));
    const value = padStartColumns(fit(percentWords, room).trimEnd(), room);
    return [{ id, segments: [label, { text: value, role: "value" }] }];
  }
  const bar = barSegments(shape, percent, grid.bar, texts.evenLeft);
  const percentSegment: Segment = {
    text: `${GAP}${padStartColumns(percentWords, grid.percent)}`,
    role: "percent",
    percent,
  };
  const reset = resetWords(texts, grid.longReset);
  if (!grid.narrow) {
    const segments: Segment[] = [label, ...bar, percentSegment];
    if (grid.reset > 0) {
      const text = `${WIDE_GAP}${padEndColumns(reset, grid.reset)}`;
      segments.push({ text, role: "reset", percent });
    }
    if (texts.pace) segments.push({ ...texts.pace, text: `${WIDE_GAP}${texts.pace.text}` });
    return [{ id, segments: trimmed(segments) }];
  }
  const under: Segment = { text: " ".repeat(grid.barColumn), role: "label" };
  const lines: Line[] = [{ id, segments: [label, ...bar, percentSegment] }];
  const resetSegment: Segment = { text: reset, role: "reset", percent };
  const together = grid.barColumn + columnsOf(reset) + 3 + columnsOf(texts.pace?.text ?? "");
  if (reset && texts.pace && together <= width) {
    const dot: Segment = { text: " · ", role: "reset", percent };
    lines.push({ id, segments: [under, resetSegment, dot, texts.pace] });
    return lines;
  }
  if (reset) lines.push({ id, segments: [under, resetSegment] });
  if (texts.pace) lines.push({ id, segments: [under, texts.pace] });
  return lines;
}

/** `line` cut to `width` columns: the last guard that keeps every line inside the window. */
function clipped(line: Line, width: number): Line {
  const segments: Segment[] = [];
  let room = width;
  for (const segment of line.segments) {
    const text = sliceColumns(segment.text, Math.max(0, room));
    if (text) segments.push({ ...segment, text });
    room -= columnsOf(text);
  }
  return { id: line.id, segments };
}

/** The provider's line: its name and plan. */
function providerLine(group: Group): Line {
  const indent: Segment = { text: HEADING_INDENT, role: "label" };
  const name: Segment = { text: group.name, role: "provider", bold: true };
  const account: Segment[] = group.account ? [{ text: `  ${group.account}`, role: "account" }] : [];
  return { id: group.id, segments: [indent, name, ...account] };
}

export function limitsLines(input: LimitsInput): Line[] {
  const { snapshot, display, nowMs, width } = input;
  // Every row: the supplementary ones too, and none hidden.
  const words: Words = { ...(snapshot.words ?? DEFAULT_WORDS), detail: "detailed" };
  const sidebar = { ...display.surfaces.sidebar, hidden: [] };
  const settings: RowSettings = { ...display, surfaces: { ...display.surfaces, sidebar } };
  const groups = visibleGroups(snapshot, settings, "sidebar", {
    ...words,
    onlyCurrentModel: false,
  });
  if (groups.length === 0) {
    return [
      {
        id: "",
        segments: [
          { text: `${INDENT}未找到任何 quota 提供商，插件页会说明原因。`, role: "value" },
        ],
      },
    ];
  }
  const texts = new Map(
    groups.map((group) => [group.id, group.rows.map((item) => rowTexts(item, words, nowMs))]),
  );
  const grid = gridFor([...texts.values()].flat(), width);
  // With bars off elsewhere, Limits keeps a thin line: the even-use marker needs a bar.
  const shape = display.layout.bar === "none" ? "line" : display.layout.bar;
  return groups.flatMap((group, index) => {
    const lines: Line[] = index > 0 ? [{ id: "", segments: [] }] : [];
    lines.push(providerLine(group));
    if (group.error) {
      const error = describeError(group.error, group.name, nowMs);
      lines.push({
        id: group.id,
        segments: [{ text: fit(`${INDENT}${error}`, width).trimEnd(), role: "error" }],
      });
    }
    for (const row of texts.get(group.id) ?? []) lines.push(...rowLines(row, grid, width, shape));
    return lines.map((line) => clipped(line, width));
  });
}
