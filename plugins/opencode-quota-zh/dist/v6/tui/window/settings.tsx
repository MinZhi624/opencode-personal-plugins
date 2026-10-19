/** @jsxImportSource @opentui/solid */
/**
 * The Settings tabs edit settings.jsonc; surfaces preview saved settings with draft changes.
 * Layout's pages are a list left of the body (`Pages`), like Usage's ranges. When a page shows,
 * the list has the keyboard: ↑↓ change the page, → or enter go to the page's first line, and ↑
 * on that line goes back to the list.
 */
import {
  type BoxRenderable,
  type MouseEvent,
  type Renderable,
  RGBA,
  type ScrollBoxRenderable,
  TextAttributes,
} from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { describeError } from "../../core/errors.js";
import type { ProviderSnapshot, QuotaRow, QuotaSnapshot, QuotaWindow } from "../../core/types.js";
import { ALL_PROVIDERS, WINDOWS } from "../../core/windows.js";
import type { CustomProviderSwitch } from "../../settings/index.js";
import { CHANGED_SINCE_REVIEW } from "../../settings/schema.js";
import { columnsOf } from "../../view/columns.js";
import { DEFAULT_WORDS, fit, percentText, resetText, rowValueText } from "../../view/format.js";
import {
  pickRow,
  type Surface,
  type SurfaceRows,
  type WindowChoice,
  windowFor,
} from "../../view/select.js";
import type { ColorRole } from "../../view/text.js";
import { rpcErrorMessage } from "../client.js";
import {
  COLOR_NAMES,
  type DisplayStore,
  FIELDS,
  type Field,
  type FieldValue,
  isSurfaceTab,
  PRESETS,
  type PresetName,
  presetChoice,
  presetValues,
  renameRow,
  resetTab,
  type SettingsTab,
  setIn,
  stepIn,
  typedColor,
  typedNumber,
} from "../display.js";
import { foundProviderIds, isTicked, PROVIDERS_KEY, withTick } from "../server-settings.js";
import type { SurfaceHost } from "../sidebar.js";
import { namedColor, roleColor } from "../theme.js";
import { plainMessage, quotaToastLines, type ToastHost } from "../toasts.js";
import { draggedTo, movedBy, surfaceTree, type TreeProvider } from "./drag.js";
import { Rail, railRoom } from "./rail.js";
import type { WindowHost, WindowTheme } from "./shell.js";

export const SETTINGS_TABS: ReadonlyArray<{
  tab: SettingsTab;
  title: string;
  /** A surface tab's switch on top. */
  switchTitle?: string;
  /** Its changes show in the sidebar, so it says when the sidebar is hidden. */
  watchesSidebar: boolean;
}> = [
  {
    tab: "layout",
    title: "所有位置",
    watchesSidebar: true,
  },
  {
    tab: "sidebar",
    title: "侧栏",
    switchTitle: "在会话侧栏中显示额度面板",
    watchesSidebar: true,
  },
  {
    tab: "collapsed",
    title: "折叠时",
    switchTitle: "面板折叠时，每个提供商显示一行",
    watchesSidebar: true,
  },
  {
    tab: "statusLine",
    title: "状态栏",
    switchTitle: "在消息框下方显示额度行",
    watchesSidebar: false,
  },
  {
    tab: "toast",
    title: "提示",
    switchTitle: "显示额度提示",
    watchesSidebar: false,
  },
  {
    tab: "colors",
    title: "颜色",
    watchesSidebar: true,
  },
  {
    tab: "providers",
    title: "提供商",
    watchesSidebar: true,
  },
];

/**
 * The Settings tabs of the window's tab bar, each with its pages: Layout has All places, then one
 * per place; the others are one page each.
 */
export const SETTINGS_GROUPS: ReadonlyArray<{ title: string; pages: readonly SettingsTab[] }> = [
  { title: "布局", pages: ["layout", "sidebar", "collapsed", "statusLine", "toast"] },
  { title: "颜色", pages: ["colors"] },
  { title: "提供商", pages: ["providers"] },
];

export function isSettingsTab(tab: string | undefined): tab is SettingsTab {
  return SETTINGS_TABS.some((item) => item.tab === tab);
}

/** The pages of `tab`'s Settings tab when it has more than one, for the list left of the body. */
function pagesOf(tab: SettingsTab): readonly SettingsTab[] | undefined {
  const pages = SETTINGS_GROUPS.find((group) => group.pages.includes(tab))?.pages ?? [];
  return pages.length > 1 ? pages : undefined;
}

function pageTitle(tab: SettingsTab): string {
  return SETTINGS_TABS.find((item) => item.tab === tab)?.title ?? tab;
}

/** What the window keeps left of a Settings tab's body: Layout's page list, else nothing. */
export function pagesRoom(tab: string | undefined): number {
  const pages = isSettingsTab(tab) ? pagesOf(tab) : undefined;
  return pages ? railRoom(PAGE_LIST_GAP) : 0;
}

/** Layout 的页面显示“重置本页”（只重置本页的各行）；其他标签显示“重置本标签”。 */
function resetLabel(tab: SettingsTab): string {
  return pagesOf(tab) ? "重置本页" : "重置本标签";
}

/** A line ↑↓ select: ‹ value › steps through values, value ▸ runs a button; some take typing. */
export type OptionLine = {
  id: string;
  /** A heading above the line, which starts a group. */
  group?: string;
  /** A blank line above the line, between blocks of one group. */
  gap?: boolean;
  title: string;
  value: () => string;
  cycle?: (delta: number) => void;
  run?: () => void;
  typed?: Typed;
  note?: () => string;
  /** The note in the warning color. */
  warning?: boolean;
  /** A second muted line under the value. */
  detail?: string;
  /** Nesting under the line above: 1 for a provider's settings under its tick. */
  depth?: number;
  /** A tick box ([x] or [ ] in its title): no ‹ ›, a click on the title flips it too. */
  tick?: boolean;
  swatches?: () => RGBA[];
};

/** What a line takes when you type into it (e, or a double-click). */
type Typed = { placeholder: string; hint: string; apply: (text: string) => void };

/** A line of a surface tab's tree. One object per line, so <For> keeps its view while it moves. */
type TreeLine = { id: string; providerId: string; row: boolean };

type Click = (run: () => void) => () => void;

const KEYS = "额度窗口";
const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0);
/** The id of a surface tab's switch line. */
const SWITCH_ID = "surface";
/** The selection id of Layout's page list: the list has the keyboard. */
const PAGES_ID = "pages";
/** The body starts right after the page list's line: its lines carry their own indent. */
const PAGE_LIST_GAP = 0;
const DOUBLE_CLICK_MS = 400;
/** A line's columns besides its title and value: the 3 spaces, the title's space, "‹ " and " ›". */
const LINE_FRAME = 8;
const TITLE_WIDTH = 26;
const TITLE_MIN = 12;
const VALUE_WIDTH = 24;
const VALUE_MIN = 6;

/**
 * A line's title and value widths in `width` columns: 26 and the value's own width when both
 * fit; else the title gives way first (down to 12 columns), then the value (down to 6).
 */
export function lineColumns(
  width: number | undefined,
  valueWidth = VALUE_WIDTH,
): { title: number; value: number } {
  if (width === undefined) return { title: TITLE_WIDTH, value: valueWidth };
  const room = width - LINE_FRAME;
  const title = Math.max(TITLE_MIN, Math.min(TITLE_WIDTH, room - valueWidth));
  const value = Math.max(Math.min(VALUE_MIN, valueWidth), Math.min(valueWidth, room - title));
  return { title, value };
}

/** Selection id of a tree line; a row id could equal a setting's path. */
function lineKey(id: string): string {
  return `line:${id}`;
}

/** Renderable id of a line, so the list can scroll it into view. */
function boxId(id: string): string {
  return `quota-settings.${id}`;
}

/** Renderable id of a page in Layout's page list. */
function pageId(tab: SettingsTab): string {
  return `quota-layout-page-${tab}`;
}

/** The windows ‹ › steps through: those of the provider's rows not hidden on the page. */
function windowChoices(provider: ProviderSnapshot, hidden: readonly string[]): WindowChoice[] {
  const windows = provider.rows.flatMap((row) =>
    row.window && row.percentRemaining !== undefined && !hidden.includes(row.id)
      ? [row.window]
      : [],
  );
  const unique = [...new Set(windows)];
  return unique.length > 1 ? ["lowest", ...unique] : [];
}

function windowTitle(choice: WindowChoice): string {
  return choice === "lowest" ? "剩余最少" : WINDOWS[choice].short;
}

/**
 * What a provider's ‹ › shows without a pick of its own: the pick for all providers when the
 * provider has that window (one of its `choices`), else lowest.
 */
function inheritedWindow(
  windows: Readonly<Record<string, WindowChoice>>,
  choices: readonly WindowChoice[],
): WindowChoice {
  const all = windows[ALL_PROVIDERS];
  return all !== undefined && choices.includes(all) ? all : "lowest";
}

/**
 * One-line text that keeps its width, unless `shrink` lets it give way. With `wrap` (notes,
 * details) it goes on to more lines between words instead of being cut.
 */
export function Cell(props: {
  fg?: RGBA;
  bold?: boolean;
  shrink?: boolean;
  wrap?: boolean;
  onUp?: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <text
      fg={props.fg}
      attributes={props.bold ? TextAttributes.BOLD : TextAttributes.NONE}
      wrapMode={props.wrap ? "word" : "none"}
      flexShrink={props.shrink ? 1 : 0}
      selectable={false}
      onMouseUp={props.onUp}
    >
      {props.children}
    </text>
  );
}

/** A window tab's option line: title, ‹ value ›, value ▸ or a tick, color swatches, then a note. */
export function OptionRow(props: {
  line: OptionLine;
  theme: WindowTheme;
  active: boolean;
  click: Click;
  /** A press anywhere on the line. */
  press: (event: MouseEvent) => void;
  /** A click on the value or on › / ▸. */
  use: () => void;
  /** The first line of a list has no gap above its group heading. */
  first?: boolean;
  valueWidth?: number;
  /**
   * The line's room: the title, then the value, narrow to fit it (`lineColumns`); a note that
   * doesn't fit after the value goes on a line under it.
   */
  width?: number;
  /** The input that replaces the value while the line takes typing, `width` columns wide. */
  input?: (width: number) => JSX.Element;
}): JSX.Element {
  const line = props.line;
  const fg = () => (props.active ? props.theme.text.action.primary.focused : props.theme.text.base);
  const arrow = () => (props.active ? fg() : props.theme.text.action.primary.selected);
  const note = () => line.note?.() ?? "";
  const columns = () => lineColumns(props.width, props.valueWidth);
  /** Where the value starts: past the 3 spaces, the title, its space and the "‹ ". */
  const valueColumn = () => 3 + columns().title + 1 + 2;
  const noteInline = () => {
    if (props.width === undefined) return true;
    const swatches = 3 * (line.swatches?.() ?? []).length;
    const end = valueColumn() + columns().value + 2 + swatches;
    return end + 3 + columnsOf(note()) <= props.width;
  };
  const indent = "  ".repeat(line.depth ?? 0);
  // A tick without a word has the value's room too, so a long name shows whole.
  const titleWidth = () =>
    line.tick && !line.value() ? columns().title + 2 + columns().value : columns().title;
  /** On the selected line's highlight, the highlight's text color; under it, its own color. */
  const noteColor = (onHighlight: boolean) =>
    props.active && onHighlight
      ? fg()
      : line.warning
        ? props.theme.text.feedback.warning.base
        : props.theme.text.muted;
  return (
    <>
      <Show when={line.group}>
        <box paddingTop={props.first ? 0 : 1}>
          <Cell fg={props.theme.text.action.primary.selected} bold>{` ${line.group}`}</Cell>
        </box>
      </Show>
      <Show when={line.gap}>
        <box height={1} />
      </Show>
      <box
        id={boxId(line.id)}
        flexDirection="row"
        backgroundColor={props.active ? props.theme.background.action.primary.focused : TRANSPARENT}
        onMouseDown={props.press}
      >
        <Cell fg={fg()} onUp={line.tick ? props.click(props.use) : undefined}>
          {`   ${indent}${fit(line.title, titleWidth() - indent.length)} `}
        </Cell>
        <Cell fg={arrow()} onUp={props.click(() => line.cycle?.(-1))}>
          {line.cycle && !line.tick ? "‹ " : "  "}
        </Cell>
        <Show
          when={props.input}
          fallback={
            <Cell fg={line.tick ? noteColor(true) : fg()} onUp={props.click(props.use)}>
              {fit(line.value(), columns().value)}
            </Cell>
          }
        >
          {props.input?.(columns().value)}
        </Show>
        <Cell fg={arrow()} onUp={props.click(props.use)}>
          {line.run ? " ▸" : line.cycle && !line.tick ? " ›" : "  "}
        </Cell>
        <Show when={line.swatches}>
          <Cell>
            {(line.swatches?.() ?? []).map((color) => (
              <span style={{ fg: color }}>{" ██"}</span>
            ))}
          </Cell>
        </Show>
        <Show when={note() && noteInline()}>
          <box paddingLeft={3} flexShrink={1}>
            <Cell fg={noteColor(true)} shrink wrap>
              {note()}
            </Cell>
          </box>
        </Show>
      </box>
      <Show when={note() && !noteInline()}>
        <box paddingLeft={valueColumn()} width={props.width}>
          <Cell fg={noteColor(false)} shrink wrap>
            {note()}
          </Cell>
        </box>
      </Show>
      <Show when={line.detail}>
        <box paddingLeft={valueColumn()} width={props.width}>
          <Cell fg={props.theme.text.muted} shrink wrap>
            {line.detail}
          </Cell>
        </box>
      </Show>
    </>
  );
}

export type SettingsEditor = ReturnType<typeof createSettingsEditor>;

export function createSettingsEditor(
  api: WindowHost,
  display: DisplayStore,
  showToast: ToastHost["show"],
) {
  const [tab, setTabNow] = createSignal<SettingsTab>();
  const [selected, setSelected] = createSignal("");
  const [typing, setTyping] = createSignal<Typed & { id: string; value: string }>();
  const [confirming, setConfirming] = createSignal(false);
  const [sidebars, setSidebars] = createSignal(0);
  const [dragging, setDragging] = createSignal<string>();
  let draggedSincePress = false;
  let lastPress = { id: "", atMs: 0 };
  /** The inline input while a line takes typing; its keys work only while it has the keyboard. */
  let typingInput: Renderable | undefined;
  const treeLines = new Map<string, TreeLine>();
  const theme = () => api.theme;
  const shown = () => display.shown();
  const server = display.server;
  const dirty = server.dirty;
  const discard = server.discard;
  const lineValue = (path: string): FieldValue => server.value(path) as FieldValue;
  function setValues(values: Readonly<Record<string, FieldValue>>): void {
    for (const [path, value] of Object.entries(values)) server.set(path, value);
  }
  function resetTabLines(settingsTab: SettingsTab): void {
    display.edit((settings) => resetTab(settings, settingsTab));
    if (settingsTab === "providers") server.set(PROVIDERS_KEY, []);
  }

  /** `run` as a click handler that skips the click OpenCode sends right after a drag. */
  const click: Click = (run) => () => {
    if (!draggedSincePress) run();
  };

  /** Two presses on the same line within 400 ms. */
  function isDoubleClick(id: string): boolean {
    const now = Date.now();
    const double = lastPress.id === id && now - lastPress.atMs < DOUBLE_CLICK_MS;
    lastPress = double ? { id: "", atMs: 0 } : { id, atMs: now };
    return double;
  }

  function editSurface(surface: Surface, change: (rows: SurfaceRows) => SurfaceRows): void {
    const rows = change(shown().surfaces[surface]);
    server.set(`${surface}.show`, rows.enabled);
    server.set(`${surface}.hidden`, rows.hidden);
    server.set(`${surface}.providerOrder`, rows.providerOrder);
    server.set(`${surface}.rowOrder`, rows.rowOrder);
  }

  function toggleSurface(surface: Surface): void {
    editSurface(surface, (rows) => ({ ...rows, enabled: !rows.enabled }));
  }

  /** What typing into a line does: a color for a color line, a number for a server number. */
  function typedValue(field: Field, role: ColorRole | undefined): Typed | undefined {
    if (role) {
      return {
        placeholder: "#rrggbb",
        hint: "输入如 #89b4fa 的颜色，按回车 · 不输入直接回车 = 使用主题颜色 · esc 停止",
        apply: (text) => display.edit((settings) => typedColor(settings, field, text)),
      };
    }
    const placeholder = field.placeholder;
    if (!placeholder) return undefined;
    return {
      placeholder,
      hint: `输入 ${placeholder}，按回车 · 不输入直接回车 = ${field.show(null)} · esc 停止`,
      apply: (text) => {
        const value = typedNumber(field, text);
        if (value !== undefined) server.set(field.path, value);
      },
    };
  }

  /** A field's line: ‹ › step through its values, or you type one. */
  function fieldLine(field: Field): OptionLine {
    const role = field.color ? (field.path.slice("colors.".length) as ColorRole) : undefined;
    const value = () => lineValue(field.path);
    return {
      id: field.path,
      group: field.group,
      title: field.title,
      depth: field.provider ? 1 : 0,
      value: () => field.show(value()),
      cycle:
        field.values.length > 0
          ? (delta) => {
              const values = field.choices?.(shown()) ?? field.values;
              setValues({ [field.path]: stepIn(values, value(), delta) });
            }
          : undefined,
      typed: typedValue(field, role),
      note: () =>
        field.preset && presetChoice(field.preset, lineValue) !== undefined
          ? "来自预设"
          : (field.note ?? ""),
      swatches: role ? () => [roleColor(theme(), shown(), role, 60)] : undefined,
    };
  }

  function presetLine(name: PresetName): OptionLine {
    const choice = () => presetChoice(name, lineValue);
    return {
      id: `preset.${name}`,
      title: PRESETS[name].title,
      value: () => choice() ?? "自定义",
      cycle: (delta) => setValues(presetValues(name, choice(), delta)),
      note: () => `设置 ${PRESETS[name].drives}`,
    };
  }

  /**
   * OpenCode's own theme list and light/dark switch; quota's colors follow them. `refocus` gives
   * the window the keyboard again.
   */
  function themeLines(refocus: () => void): OptionLine[] {
    return [
      {
        id: "theme",
        group: "OpenCode 主题",
        title: "主题",
        value: () => "打开主题列表",
        run: () => api.keymap.dispatch("theme.switch"),
        swatches: () => COLOR_NAMES.map((name) => namedColor(theme(), name)),
        note: () => "↑↓ 实时预览各主题 · 回车保留 · esc 还原",
      },
      {
        id: "themeMode",
        title: "浅色或深色",
        value: () => api.themeMode ?? "dark",
        cycle: () => {
          api.keymap.dispatch("theme.switch_mode");
          // OpenCode's switch also closes its dialogs, which gives the keyboard to whatever had
          // it before the last dialog opened (the message box); take it back after that.
          setTimeout(refocus, 50);
        },
        note: () => "部分主题只有一种",
      },
    ];
  }

  /**
   * A custom provider's switch, its web address and the key it would send; marked when the server
   * would not switch it on because it changed since the window showed it.
   */
  function customLine(entry: CustomProviderSwitch, first: boolean): OptionLine {
    const on = () => server.customOn(entry.id);
    const request = entry.request;
    const changed = server.changedSinceReview(entry.id);
    const where = !request
      ? "本地估算：不发送任何内容"
      : request.insecure
        ? `${request.url}  明文 http：密钥未经加密传输`
        : request.url;
    return {
      id: `custom.${entry.id}`,
      group: first ? "自定义提供商（在 settings.jsonc 中添加）" : undefined,
      gap: !first,
      title: entry.label,
      value: () => (on() ? "开" : "关"),
      cycle: () => server.switchCustom(entry.id, !on()),
      note: () => (changed ? `${CHANGED_SINCE_REVIEW} · ${where}` : where),
      warning: changed || request?.insecure,
      detail: request ? `密钥：${request.key}` : undefined,
    };
  }

  /**
   * The custom providers' switches (on top: an agent sends the user here to switch one on), which
   * providers quota checks (ticks, with Cursor's and OpenCode Zen's settings nested; the ones
   * quota found first), then the other groups.
   */
  function providerLines(snapshot: QuotaSnapshot | undefined): OptionLine[] {
    const loaded = server.saved();
    if (!loaded) return [];
    const found = foundProviderIds(snapshot);
    const off = () => server.value(PROVIDERS_KEY) as string[];
    const savedOff = loaded.values[PROVIDERS_KEY] as string[];
    const ordered = [
      ...loaded.providers.filter(({ id }) => found.includes(id)),
      ...loaded.providers.filter(({ id }) => !found.includes(id)),
    ];
    const ticks = ordered.flatMap(({ id, label }): OptionLine[] => {
      const ticked = isTicked(off(), id);
      const tick: OptionLine = {
        id: `provider.${id}`,
        group: id === ordered[0]?.id ? "检查哪些提供商" : undefined,
        title: `${ticked ? "[x]" : "[ ]"} ${label}`,
        tick: true,
        warning: true,
        // The tick says on or off; only a saved tick quota can't use says more (a tick not
        // saved yet is not checked yet).
        value: () =>
          ticked && isTicked(savedOff, id) && snapshot && !found.includes(id) ? "未设置" : "",
        cycle: () => server.set(PROVIDERS_KEY, withTick(off(), id, !ticked)),
      };
      const nested = ticked ? FIELDS.filter((field) => field.provider === id) : [];
      return [tick, ...nested.map(fieldLine)];
    });
    return [
      ...loaded.custom.map((entry, index) => customLine(entry, index === 0)),
      ...ticks,
      ...FIELDS.filter((field) => field.tab === "providers" && !field.provider).map(fieldLine),
    ];
  }

  /**
   * Collapsed's and Status line's window for every provider without its own pick in the list
   * below. ‹ › step through lowest and the windows the providers have.
   */
  function allProvidersLine(
    surface: "collapsed" | "statusLine",
    snapshot: QuotaSnapshot | undefined,
  ): OptionLine {
    const current = (): WindowChoice => shown()[surface].window[ALL_PROVIDERS] ?? "lowest";
    const choices = (): WindowChoice[] => {
      const found = new Set(
        (snapshot?.providers ?? []).flatMap((provider) =>
          provider.rows.flatMap((row) =>
            row.window && row.percentRemaining !== undefined ? [row.window] : [],
          ),
        ),
      );
      const windows = (Object.keys(WINDOWS) as QuotaWindow[]).filter(
        (window) => found.has(window) || window === current(),
      );
      return ["lowest", ...windows];
    };
    return {
      id: `${surface}.window.${ALL_PROVIDERS}`,
      group: "显示窗口",
      title: "所有提供商",
      value: () => windowTitle(current()),
      cycle: (delta) => {
        const next = stepIn(choices(), current(), delta);
        display.edit((settings) =>
          setIn(settings, [surface, "window", ALL_PROVIDERS], next === "lowest" ? undefined : next),
        );
      },
      note: () => "下方各提供商的单独选择优先；未单独选择的提供商显示其剩余最少的窗口",
    };
  }

  /**
   * A Settings page's lines. A preset sits above the line it names, under that line's heading,
   * or else first, under "Preset". `refocus` gives the window the keyboard again.
   */
  function optionLines(
    settingsTab: SettingsTab,
    snapshot?: QuotaSnapshot,
    refocus: () => void = () => {},
  ): OptionLine[] {
    if (settingsTab === "providers") return providerLines(snapshot);
    if (!server.saved()) return [];
    const presets = (Object.keys(PRESETS) as PresetName[]).filter(
      (name) => PRESETS[name].tab === settingsTab,
    );
    const fields = FIELDS.filter((field) => field.tab === settingsTab).flatMap((field) => {
      const line = fieldLine(field);
      const preset = presets.find((name) => PRESETS[name].before === field.path);
      return preset
        ? [
            { ...presetLine(preset), group: line.group },
            { ...line, group: undefined },
          ]
        : [line];
    });
    return [
      ...presets
        .filter((name) => PRESETS[name].before === undefined)
        .map((name) => ({ ...presetLine(name), group: "预设" })),
      ...(settingsTab === "colors" ? themeLines(refocus) : []),
      ...fields,
      ...(settingsTab === "collapsed" || settingsTab === "statusLine"
        ? [allProvidersLine(settingsTab, snapshot)]
        : []),
    ];
  }

  function firstLine(settingsTab: SettingsTab | undefined): string {
    if (settingsTab === undefined) return "";
    if (pagesOf(settingsTab)) return PAGES_ID;
    return isSurfaceTab(settingsTab) ? SWITCH_ID : (optionLines(settingsTab)[0]?.id ?? "");
  }

  /** Reads the file settings each time a Settings tab shows. */
  async function loadServer(settingsTab: SettingsTab): Promise<void> {
    try {
      await server.load();
    } catch (error) {
      api.ui.toast.show({
        variant: "error",
        title: "额度设置加载失败",
        message: rpcErrorMessage(error),
      });
      return;
    }
    if (tab() === settingsTab && selected() === "") setSelected(firstLine(settingsTab));
  }

  function Button(props: { label: string; primary?: boolean; run: () => void }): JSX.Element {
    const { text, background } = theme();
    return (
      <box
        paddingLeft={2}
        paddingRight={2}
        flexShrink={0}
        alignSelf="flex-start"
        backgroundColor={props.primary ? background.action.primary.focused : background.raised.high}
        onMouseUp={click(props.run)}
      >
        <Cell fg={props.primary ? text.action.primary.focused : text.base}>{props.label}</Cell>
      </box>
    );
  }

  function previewToast(host: SurfaceHost, sessionID: string): void {
    const settings = shown();
    const snapshot = host.quota.snapshot(sessionID);
    if (!snapshot || !settings.surfaces.toast.enabled) return;
    const lines = quotaToastLines(snapshot, settings, Date.now(), api.renderer.width);
    const message = plainMessage(lines);
    if (!message) return;
    const duration = settings.toast.seconds * 1000;
    showToast({ variant: "info", message, duration }, lines);
  }

  /**
   * Layout's pages, left of the body (`rail.tsx`). A click shows a page and gives the list the
   * keyboard.
   */
  function Pages(props: { tab: SettingsTab; showPage: (tab: SettingsTab) => void }): JSX.Element {
    return (
      <Show when={pagesOf(props.tab)}>
        {(pages: () => readonly SettingsTab[]) => (
          <Rail
            items={pages().map((page) => ({ key: page, label: pageTitle(page), id: pageId(page) }))}
            chosen={props.tab}
            theme={theme()}
            gap={PAGE_LIST_GAP}
            pick={(page) =>
              click(() => {
                props.showPage(page);
                setSelected(PAGES_ID);
              })()
            }
          />
        )}
      </Show>
    );
  }

  /**
   * Above a Settings tab's scrolling body: the surface switch under its "Enable/disable" heading,
   * and a warning when the sidebar is hidden.
   */
  function Header(props: { tab: SettingsTab; refocus: () => void }): JSX.Element {
    const info = () => SETTINGS_TABS.find((item) => item.tab === props.tab) ?? SETTINGS_TABS[0];
    const surface = () => (isSurfaceTab(props.tab) ? props.tab : undefined);
    const surfaceOn = () => {
      const current = surface();
      return current === undefined || shown().surfaces[current].enabled;
    };
    const sidebarHidden = () => info().watchesSidebar && sidebars() === 0;
    const active = () => selected() === SWITCH_ID;
    return (
      <Show when={surface() || sidebarHidden()}>
        <box flexDirection="column" flexShrink={0} marginBottom={1}>
          <Show when={surface()}>
            <Cell fg={theme().text.action.primary.selected} bold>
              {" 启用/停用"}
            </Cell>
          </Show>
          <Show when={surface()}>
            {(current: () => Surface) => (
              <box
                id={boxId(SWITCH_ID)}
                flexShrink={0}
                backgroundColor={active() ? theme().background.action.primary.focused : TRANSPARENT}
                onMouseDown={() => setSelected(SWITCH_ID)}
                onMouseUp={click(() => toggleSurface(current()))}
              >
                <Cell fg={active() ? theme().text.action.primary.focused : theme().text.base} bold>
                  {`   ${surfaceOn() ? "[x]" : "[ ]"} ${info().switchTitle}`}
                </Cell>
              </box>
            )}
          </Show>
          <Show when={sidebarHidden()}>
            <box paddingLeft={3} flexDirection="row" gap={2} flexShrink={0}>
              <text
                fg={theme().text.feedback.warning.base}
                wrapMode="word"
                selectable={false}
                flexShrink={1}
              >
                侧栏已隐藏，这里没有可实时预览的内容。
              </text>
              <Button
                label="显示侧栏"
                run={() => {
                  api.keymap.dispatch("session.sidebar.toggle");
                  setTimeout(props.refocus, 50);
                }}
              />
            </box>
          </Show>
        </box>
      </Show>
    );
  }

  /**
   * A Settings tab's lines: its options, then the surface's providers (and rows) as a tree.
   * `showPage` shows another of Layout's pages.
   */
  function Body(props: {
    tab: SettingsTab;
    showPage: (tab: SettingsTab) => void;
    host: SurfaceHost;
    sessionID: string;
    box: () => BoxRenderable | undefined;
    scroll: () => ScrollBoxRenderable | undefined;
    /** The body's room: the scrollbar's column and a gap before it stay free. */
    width: number;
  }): JSX.Element {
    /** The box with only the tree lines, so the drag math counts lines from its top. */
    let list: BoxRenderable | undefined;
    let dragId: string | undefined;
    const surface = () => (isSurfaceTab(props.tab) ? props.tab : undefined);
    const withRows = () => props.tab === "sidebar" || props.tab === "toast";
    const snapshot = () => props.host.quota.snapshot(props.sessionID);
    const words = () => snapshot()?.words ?? DEFAULT_WORDS;
    /** The picked windows of Collapsed or Status line. */
    const windows = () => shown()[props.tab === "statusLine" ? "statusLine" : "collapsed"].window;
    /** The providers and rows hidden on this page. */
    const hiddenIds = (): readonly string[] => {
      const current = surface();
      return current ? shown().surfaces[current].hidden : [];
    };
    const tree = (): TreeProvider[] => {
      const current = surface();
      const loaded = snapshot();
      return current && loaded ? surfaceTree(loaded, shown().surfaces[current]) : [];
    };
    const options = createMemo(() =>
      optionLines(props.tab, snapshot(), () => props.box()?.focus()),
    );
    const lines = createMemo(() =>
      tree().flatMap(({ provider, rowIds }) => [
        treeLine(provider.providerId, provider.providerId, false),
        ...(withRows() ? rowIds.map((id) => treeLine(id, provider.providerId, true)) : []),
      ]),
    );
    const selectedOption = () => options().find((line) => line.id === selected());
    const selectedLine = () => lines().find((line) => lineKey(line.id) === selected());

    function treeLine(id: string, providerId: string, row: boolean): TreeLine {
      const key = `${row ? "row" : "provider"}:${id}`;
      const line = treeLines.get(key) ?? { id, providerId, row };
      treeLines.set(key, line);
      return line;
    }

    /**
     * ↑↓ select the next line; past the first or last one they scroll. In Layout's page list
     * they show the page above or below.
     */
    function select(delta: number): void {
      if (selected() === PAGES_ID) {
        stepPage(delta);
        return;
      }
      const ids = [
        ...(pagesOf(props.tab) ? [PAGES_ID] : []),
        ...(surface() ? [SWITCH_ID] : []),
        ...options().map((line) => line.id),
        ...lines().map((line) => lineKey(line.id)),
      ];
      const next = ids.indexOf(selected()) + delta;
      if (next < 0 || next >= ids.length) props.scroll()?.scrollBy(delta);
      else setSelected(ids[next] as string);
    }

    function toggleHidden(id: string): void {
      const current = surface();
      if (!current) return;
      editSurface(current, (rows) => {
        const hidden = rows.hidden.includes(id);
        return {
          ...rows,
          hidden: hidden ? rows.hidden.filter((item) => item !== id) : [...rows.hidden, id],
        };
      });
    }

    function cycleWindow(providerId: string, delta: number): void {
      const provider = tree().find((item) => item.provider.providerId === providerId)?.provider;
      const choices = provider ? windowChoices(provider, hiddenIds()) : [];
      if (choices.length === 0) return;
      const inherited = inheritedWindow(windows(), choices);
      const next = stepIn(choices, windows()[providerId] ?? inherited, delta);
      // The window it would show anyway is no pick of its own, so it follows "For all providers".
      display.edit((settings) =>
        setIn(
          settings,
          [props.tab === "statusLine" ? "statusLine" : "collapsed", "window", providerId],
          next === inherited ? undefined : next,
        ),
      );
    }

    function move(delta: number): void {
      const current = surface();
      const line = selectedLine();
      if (current && line) editSurface(current, (rows) => movedBy(tree(), rows, line.id, delta));
    }

    function ownRow(line: TreeLine): QuotaRow | undefined {
      return tree()
        .find((item) => item.provider.providerId === line.providerId)
        ?.provider.rows.find((row) => row.id === line.id);
    }

    /** e or a double-click: type a color, or rename a row. */
    function startTyping(): void {
      const option = selectedOption();
      if (option?.typed) {
        setTyping({ id: option.id, value: "", ...option.typed });
        return;
      }
      const line = selectedLine();
      const row = line?.row ? ownRow(line) : undefined;
      if (!line || !row) return;
      setTyping({
        id: lineKey(line.id),
        value: "",
        placeholder:
          shown()[props.tab === "toast" ? "toast" : "sidebar"].names[line.id] ?? row.label,
        hint: `输入新名称，按回车 · 不输入直接回车 = 使用原名称（"${row.label}"） · esc 停止`,
        apply: (text) =>
          display.edit((settings) =>
            renameRow(settings, props.tab === "toast" ? "toast" : "sidebar", line.id, text),
          ),
      });
    }

    function stopTyping(): void {
      setTyping(undefined);
      props.box()?.focus();
    }

    function commitTyping(): void {
      const current = typing();
      current?.apply(current.value);
      stopTyping();
    }

    /** ↑↓ in Layout's page list: the page above or below this one, shown at once. */
    function stepPage(delta: number): void {
      const pages = pagesOf(props.tab) ?? [];
      const next = pages[pages.indexOf(props.tab) + delta];
      if (next) props.showPage(next);
    }

    /** →, enter or space in Layout's page list: the page's first line, its switch or first option. */
    function toFirstLine(): void {
      const first = surface() ? SWITCH_ID : options()[0]?.id;
      if (first) setSelected(first);
    }

    /**
     * Space or enter: to the page's lines from the page list, flip a switch, run a button, next
     * value, or show/hide a line.
     */
    function activate(): void {
      const current = surface();
      const option = selectedOption();
      const line = selectedLine();
      if (selected() === PAGES_ID) toFirstLine();
      else if (selected() === SWITCH_ID && current) toggleSurface(current);
      else if (option) useOption(option);
      else if (line) toggleHidden(line.id);
    }

    /** A click on an option's value: run its button, its next value, or start typing. */
    function useOption(option: OptionLine): void {
      if (option.run) option.run();
      else if (option.cycle) option.cycle(1);
      else startTyping();
    }

    /** ←/→ change the selected line's value; → in the page list goes to the page's lines. */
    function sideways(delta: number): void {
      const option = selectedOption();
      const line = selectedLine();
      if (selected() === PAGES_ID) {
        if (delta > 0) toFirstLine();
      } else if (option) option.cycle?.(delta);
      else if (line && !line.row) cycleWindow(line.providerId, delta);
    }

    /** A provider moves with all its rows; a row moves only among its own provider's rows. */
    function onDrag(event: MouseEvent): void {
      const current = surface();
      const id = dragId;
      if (!current || !id || !list || typing()) return;
      draggedSincePress = true;
      setDragging(id);
      // Dragging onto the top or bottom line of a list that scrolls moves it one line.
      const scroll = props.scroll();
      if (scroll && event.y <= scroll.y) scroll.scrollBy(-1);
      else if (scroll && event.y >= scroll.y + scroll.height - 1) scroll.scrollBy(1);
      // list.y already includes the scroll offset, so this counts lines from the first line.
      const pointer = event.y - list.y;
      editSurface(current, (rows) => draggedTo(tree(), rows, id, pointer, withRows()));
    }

    // On the Toast tab the real toast shows again after every change of what it shows.
    createEffect(
      on(
        () => {
          return props.tab === "toast" && JSON.stringify(shown().toast);
        },
        (key) => {
          if (key) previewToast(props.host, props.sessionID);
        },
      ),
    );
    // Keep the selected line in view when the list is taller than its room.
    createEffect(
      on(selected, (id) => {
        queueMicrotask(() => props.scroll()?.scrollChildIntoView(boxId(id)));
      }),
    );

    // Keys work only while the window has the keyboard; they win over the window's own.
    api.keymap.layer(() => ({
      target: props.box,
      priority: 11,
      enabled: () => typing() === undefined && !confirming(),
      commands: [
        { bind: "up", title: "上一行", group: KEYS, run: () => select(-1) },
        { bind: "down", title: "下一行", group: KEYS, run: () => select(1) },
        { bind: "shift+up", title: "上移", group: KEYS, run: () => move(-1) },
        { bind: "shift+down", title: "下移", group: KEYS, run: () => move(1) },
        { bind: "alt+up", title: "上移", group: KEYS, run: () => move(-1) },
        { bind: "alt+down", title: "下移", group: KEYS, run: () => move(1) },
        { bind: "space", title: "使用本行", group: KEYS, run: activate },
        { bind: "return", title: "使用本行", group: KEYS, run: activate },
        { bind: "e", title: "输入数值或重命名行", group: KEYS, run: startTyping },
        { bind: "left", title: "上一个值", group: KEYS, run: () => sideways(-1) },
        { bind: "right", title: "下一个值", group: KEYS, run: () => sideways(1) },
        {
          bind: "ctrl+r",
          title: "重置本标签或本页",
          group: KEYS,
          run: () => resetTabLines(props.tab),
        },
      ],
    }));
    // While typing, the input has the keyboard: Esc only stops typing, Enter keeps the text.
    api.keymap.layer(() => ({
      target: () => typingInput,
      priority: 20,
      enabled: () => typing() !== undefined,
      commands: [
        { bind: "escape", title: "停止输入", group: KEYS, run: stopTyping },
        { bind: "return", title: "保留输入", group: KEYS, run: commitTyping },
      ],
    }));

    function TypingInput(inputProps: { width: number; placeholder: string }): JSX.Element {
      return (
        <input
          ref={(element: Renderable) => {
            typingInput = element;
          }}
          width={inputProps.width}
          flexShrink={0}
          value=""
          placeholder={inputProps.placeholder}
          focused
          onInput={(value: string) => {
            const current = typing();
            if (current) setTyping({ ...current, value });
          }}
          onSubmit={commitTyping}
        />
      );
    }

    function TreeRow(rowProps: { line: TreeLine }): JSX.Element {
      const line = rowProps.line;
      const key = lineKey(line.id);
      const entry = () => tree().find((item) => item.provider.providerId === line.providerId);
      const rows = () => shown().surfaces[surface() as Surface];
      const active = () => selected() === key;
      // Dragging a provider carries its rows, so they light up with it.
      const lit = () =>
        active() || dragging() === line.id || (line.row && dragging() === line.providerId);
      const hidden = () => rows().hidden.includes(line.id);
      const { text } = theme();
      const fg = () =>
        lit()
          ? text.action.primary.focused
          : !rows().enabled || hidden() || (line.row && rows().hidden.includes(line.providerId))
            ? text.muted
            : text.base;
      /** Tree lines show which provider a row belongs to: ├ for a middle row, └ for the last. */
      const branch = () => {
        const rowIds = entry()?.rowIds ?? [];
        return !line.row ? "" : rowIds[rowIds.length - 1] === line.id ? "  └ " : "  ├ ";
      };
      const own = () => (line.row ? ownRow(line) : undefined);
      const label = () =>
        line.row
          ? (shown()[props.tab === "toast" ? "toast" : "sidebar"].names[line.id] ??
            own()?.label ??
            line.id)
          : (entry()?.provider.label ?? line.id);
      const summary = (row: QuotaRow) => {
        if (row.percentRemaining === undefined) return rowValueText(row);
        const reset = resetText(row, Date.now(), words());
        return `${percentText(words(), row.percentRemaining, true)}${reset ? ` · ${reset}` : ""}`;
      };
      const detail = () => {
        const provider = entry()?.provider;
        const row = own();
        if (
          row &&
          shown()[props.tab === "toast" ? "toast" : "sidebar"].names[line.id] !== undefined
        )
          return `原为 "${row.label}"`;
        if (row?.prominence === "supplementary" && words().detail !== "detailed") {
          return "仅在显示全部行时可用";
        }
        if (row) return summary(row);
        if (!provider) return "";
        if (provider.error && provider.rows.length === 0) {
          return describeError(provider.error, provider.label, Date.now());
        }
        if (withRows()) return "";
        const rows = provider.rows.filter((item) => !hiddenIds().includes(item.id));
        const picked = pickRow(
          { rows: rows.map((item) => ({ row: item, label: item.label, named: false })) },
          windowFor(windows(), provider.providerId),
        );
        return picked ? summary(picked.row) : "";
      };
      const choices = () => {
        const provider = entry()?.provider;
        return !line.row && !withRows() && provider ? windowChoices(provider, hiddenIds()) : [];
      };
      /** Rows sit 4 columns further right, so their names get 4 fewer; the details line up. */
      const labelWidth = line.row ? 24 : 28;
      return (
        <box
          id={boxId(key)}
          flexDirection="row"
          backgroundColor={lit() ? theme().background.action.primary.focused : TRANSPARENT}
          onMouseDown={(event: MouseEvent) => {
            if (event.button !== 0 || typing()) return;
            setSelected(key);
            dragId = line.id;
            if (line.row && isDoubleClick(key)) startTyping();
          }}
        >
          <Cell fg={text.muted}>{` ${branch()}`}</Cell>
          <Cell fg={lit() ? fg() : text.action.primary.selected}>
            {api.renderer.useMouse === false ? "" : "⠿ "}
          </Cell>
          <Cell fg={fg()} onUp={click(() => toggleHidden(line.id))}>
            {hidden() ? "[ ] " : "[x] "}
          </Cell>
          <Show
            when={typing()?.id === key}
            fallback={
              <Cell fg={fg()} bold={!line.row}>
                {fit(label(), labelWidth)}
              </Cell>
            }
          >
            <TypingInput width={labelWidth} placeholder={label()} />
          </Show>
          {/* One-line-per-provider tabs keep the window column, so the details line up. */}
          <Show
            when={choices().length > 0}
            fallback={<Cell>{withRows() ? " " : " ".repeat(17)}</Cell>}
          >
            <Cell
              fg={active() ? fg() : text.action.primary.selected}
              onUp={click(() => cycleWindow(line.providerId, 1))}
            >
              {` ‹ ${fit(windowTitle(windows()[line.providerId] ?? inheritedWindow(windows(), choices())), 11)} › `}
            </Cell>
          </Show>
          <Cell fg={lit() ? fg() : text.muted} shrink>
            {fit(detail(), 24)}
          </Cell>
        </box>
      );
    }

    return (
      <box flexDirection="column" width={props.width}>
        <For each={options()}>
          {(line: OptionLine, index: () => number) => (
            <OptionRow
              line={line}
              theme={theme()}
              active={selected() === line.id}
              first={index() === 0}
              width={props.width}
              click={click}
              press={(event) => {
                if (event.button !== 0 || typing()) return;
                setSelected(line.id);
                if (line.typed && isDoubleClick(line.id)) startTyping();
              }}
              use={() => useOption(line)}
              input={
                typing()?.id === line.id
                  ? (width: number) => (
                      <TypingInput width={width} placeholder={line.typed?.placeholder ?? ""} />
                    )
                  : undefined
              }
            />
          )}
        </For>
        <Show when={surface() && !snapshot()}>
          <Cell fg={theme().text.muted}>{"   正在加载额度…"}</Cell>
        </Show>
        <Show when={!server.saved()}>
          <Cell fg={theme().text.muted}>{"   正在加载设置…"}</Cell>
        </Show>
        <Show when={options().length > 0 && lines().length > 0}>
          <box height={1} />
        </Show>
        <box
          ref={(element: BoxRenderable) => {
            list = element;
          }}
          flexDirection="column"
          onMouseDrag={onDrag}
          onMouseDragEnd={() => setDragging(undefined)}
          onMouseUp={() => {
            dragId = undefined;
          }}
        >
          <For each={lines()}>{(line: TreeLine) => <TreeRow line={line} />}</For>
        </box>
      </box>
    );
  }

  /**
   * The bottom bar of a Settings tab: Close, or Save and Discard, or the "Keep your changes?"
   * question, which also shows on the other tabs when closing asks it.
   */
  function Buttons(props: {
    tab: string;
    host: SurfaceHost;
    sessionID: string;
    box: () => BoxRenderable | undefined;
    close: () => void;
  }): JSX.Element {
    const settingsTab = () => (isSettingsTab(props.tab) ? props.tab : undefined);
    const warning = () => theme().text.feedback.warning.base;
    async function save(): Promise<void> {
      try {
        await server.save();
      } catch (error) {
        const message = rpcErrorMessage(error);
        api.ui.toast.show({ variant: "error", title: "额度设置保存失败", message });
        return;
      }
      setConfirming(false);
      props.close();
      api.ui.toast.show({
        variant: "success",
        title: "额度设置已保存",
        message: "所有已打开的 OpenCode 窗口现在即可使用，重启后依然有效。",
        duration: 4_000,
      });
    }
    /** Drops the changes; from the "Keep your changes?" question it also closes the window. */
    const discardChanges = () => {
      discard();
      if (!confirming()) return;
      setConfirming(false);
      props.close();
    };

    api.keymap.layer(() => ({
      target: props.box,
      priority: 12,
      enabled: () => typing() === undefined && (settingsTab() !== undefined || dirty()),
      commands: [{ bind: "ctrl+s", title: "保存", group: KEYS, run: () => void save() }],
    }));
    // While the bottom bar asks about unsaved changes: d drops them, Esc goes back to editing.
    api.keymap.layer(() => ({
      target: props.box,
      priority: 15,
      enabled: () => confirming() && typing() === undefined,
      commands: [
        { bind: "d", title: "放弃修改", group: KEYS, run: discardChanges },
        { bind: "escape", title: "继续编辑", group: KEYS, run: () => setConfirming(false) },
      ],
    }));

    return (
      <Show when={settingsTab() !== undefined || confirming()}>
        <Show
          when={!confirming()}
          fallback={
            <>
              <Cell fg={warning()} bold>
                保留你的修改？
              </Cell>
              <Button label="保存" primary run={() => void save()} />
              <Button label="放弃" run={discardChanges} />
              <Button label="继续编辑" run={() => setConfirming(false)} />
            </>
          }
        >
          <Show when={dirty()} fallback={<Button label="关闭" primary run={props.close} />}>
            <Button label="保存" primary run={() => void save()} />
            <Button label="放弃" run={discardChanges} />
          </Show>
          <Show when={settingsTab()}>
            {(current: () => SettingsTab) => (
              <Button label={resetLabel(current())} run={() => resetTabLines(current())} />
            )}
          </Show>
          <Show when={settingsTab() === "toast" && shown().surfaces.toast.enabled}>
            <Button label="预览提示" run={() => previewToast(props.host, props.sessionID)} />
          </Show>
          <Cell fg={warning()}>{dirty() ? " 有未保存的修改" : ""}</Cell>
        </Show>
      </Show>
    );
  }

  return {
    /** The tree line selected on `surface`'s tab, which that surface marks. */
    marked(surface: Surface): string | undefined {
      const id = selected();
      return tab() === surface && id.startsWith("line:") ? id.slice("line:".length) : undefined;
    },
    /** Sidebar shows the panel expanded and Collapsed collapsed; undefined = as the user left it. */
    panelOpen(): boolean | undefined {
      if (tab() === "sidebar") return true;
      return tab() === "collapsed" ? false : undefined;
    },
    /** A sidebar panel mounts; the returned function unmounts it. */
    sidebarShown(): () => void {
      setSidebars((count) => count + 1);
      return () => setSidebars((count) => count - 1);
    },
    statusLineShown(): boolean {
      const settings = shown();
      if (!settings.surfaces.statusLine.enabled) return false;
      const sidebarQuota = sidebars() > 0 && settings.surfaces.sidebar.enabled;
      return tab() === "statusLine" || settings.statusLine.withSidebar || !sidebarQuota;
    },
    /** A line takes typing, so the window's own keys rest. */
    typing: () => typing() !== undefined,
    /** A Plugin switch's saved value (`system.exportFile`); undefined until the server answers. */
    savedSwitch(key: string): boolean | undefined {
      return server.saved() ? server.value(key) === true : undefined;
    },
    /** Saves a Plugin switch straight away; Plugin has no draft and no Save. */
    saveSwitch: (key: string, on: boolean): Promise<void> => server.saveNow(key, on),
    /** Reads the saved settings again, for Plugin's switches. */
    loadSaved: (): Promise<void> => server.load(),
    /** The snapshot with All places' unsaved words, which every surface shows while you edit. */
    withDraftWords(snapshot: QuotaSnapshot | undefined): QuotaSnapshot | undefined {
      const words = server.draftWords();
      if (!snapshot || Object.keys(words).length === 0) return snapshot;
      return { ...snapshot, words: { ...(snapshot.words ?? DEFAULT_WORDS), ...words } };
    },
    /**
     * The window shows `next`; undefined when it closed, which drops the changes. Any tab
     * change stops typing, so the window gets its keys back.
     */
    setTab(next: string | undefined): void {
      setTyping(undefined);
      typingInput = undefined;
      if (next === undefined) {
        discard();
        setConfirming(false);
      }
      const settingsTab = isSettingsTab(next) ? next : undefined;
      if (settingsTab !== tab()) setSelected(firstLine(settingsTab));
      setTabNow(settingsTab);
      if (settingsTab) void loadServer(settingsTab);
    },
    /** Esc or Close: true while there are unsaved changes; the bottom bar then asks about them. */
    askBeforeClose(): boolean {
      if (!dirty()) return false;
      setConfirming(true);
      return true;
    },
    /** A press anywhere in the window: clicks count again after a drag, and typing goes on. */
    pressed(): void {
      draggedSincePress = false;
      if (typing()) typingInput?.focus();
    },
    click,
    /** The keyboard hint, or undefined for the window's own. */
    hint(windowTab: string, hasKeyboard: boolean): string | undefined {
      const current = typing();
      if (current) return current.hint;
      if (!hasKeyboard) return undefined;
      if (confirming()) return "ctrl+s 保存 · d 放弃修改 · esc 继续编辑";
      if (!isSettingsTab(windowTab)) return undefined;
      const reset = `ctrl+r ${resetLabel(windowTab)}`;
      const end = `↑↓ 选择 · tab 下一个标签 · ctrl+s 保存 · ${reset} · esc 关闭`;
      if (selected() === PAGES_ID) {
        return `↑↓ 翻页 · → 或回车进入本页各行 · tab 下一个标签 · ctrl+s 保存 · ${reset} · esc 关闭`;
      }
      if (windowTab === "layout") return `‹ › 或 ←/→ 修改 · ${end}`;
      if (windowTab === "providers") {
        return `‹ › 或 ←/→ 修改 · 空格勾选提供商或切换开关 · 双击数值（或按 e）输入 · ${end}`;
      }
      if (!isSurfaceTab(windowTab)) {
        return `‹ › 或 ←/→ 修改 · 双击颜色（或按 e）输入自定义颜色 · ${end}`;
      }
      const rowsTab = windowTab === "sidebar" || windowTab === "toast";
      const moving =
        api.renderer.useMouse === false
          ? "shift+↑↓ 移动"
          : `拖动 ⠿ 或 shift+↑↓ 移动${rowsTab ? "（提供商携带其所有行一起移动）" : ""}`;
      const naming = rowsTab ? "双击某行（或按 e）重命名" : "‹ › 选择窗口";
      return `${moving} · [x] 或空格 显示/隐藏 · ${naming} · ${end}`;
    },
    Pages,
    Header,
    Body,
    Buttons,
  };
}
