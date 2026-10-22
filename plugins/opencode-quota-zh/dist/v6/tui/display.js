import { getCursorPlanDisplayName, getEffectiveCursorIncludedApiUsd, } from "../lib/cursor-pricing.js";
import { isRecord } from "../lib/json-guards.js";
import { checkSetting, defaultSettings, diffSettings, SETTINGS_SCHEMA, setPath, } from "../settings/schema.js";
import { barParts, DEFAULT_WORDS, formatDuration, percentText, } from "../view/format.js";
/** Named colors follow OpenCode's theme; hex colors stay fixed; bar follows the row's level. */
export const COLOR_NAMES = ["text", "muted", "accent", "green", "yellow", "red", "blue"];
/** Every colored thing: its Colors line (and group) and the theme color it gets by default. */
const COLOR_LINES = [
    { role: "good", title: "余量充足", theme: "green", group: "进度条" },
    { role: "warning", title: "余量偏低", theme: "yellow" },
    { role: "low", title: "即将用尽", theme: "red" },
    { role: "empty", title: "已用部分", theme: "muted" },
    { role: "title", title: "面板标题", theme: "text", group: "名称" },
    { role: "provider", title: "提供商名称", theme: "text" },
    { role: "account", title: "账户（Pro、…）", theme: "muted" },
    { role: "label", title: "行标签", theme: "text" },
    { role: "percent", title: "百分比数字", theme: "bar", group: "数字与时间" },
    { role: "reset", title: "重置时间", theme: "muted" },
    { role: "value", title: "余额及其他文本", theme: "muted" },
    { role: "error", title: "错误", theme: "red" },
    { role: "statusName", title: "提供商名称", theme: "muted", group: "状态栏" },
    { role: "separator", title: "分隔符", theme: "muted" },
    { role: "arrows", title: "‹ +N › 箭头", theme: "accent" },
];
/** The theme color each role gets unless you change it. */
export const THEME_COLORS = Object.fromEntries(COLOR_LINES.map(({ role, theme }) => [role, theme]));
const SURFACES = ["sidebar", "collapsed", "statusLine", "toast"];
function isWhole(value, min, max) {
    return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
/** The tab sections as the row settings the renderers use. */
export function displaySettings(settings) {
    return {
        ...settings,
        labels: settings.sidebar.names,
        surfaces: Object.fromEntries(SURFACES.map((surface) => [
            surface,
            {
                enabled: settings[surface].show,
                hidden: settings[surface].hidden,
                providerOrder: settings[surface].providerOrder,
                rowOrder: settings[surface].rowOrder,
                names: surface === "toast" ? settings.toast.names : settings.sidebar.names,
            },
        ])),
        window: settings.collapsed.window,
        thresholds: {
            warningBelow: Math.max(settings.colors.warningBelow, settings.colors.lowBelow),
            lowBelow: settings.colors.lowBelow,
        },
        runsOut: Object.fromEntries(SURFACES.map((surface) => [surface, settings[surface].runsOut])),
    };
}
/** The value at a field's path, for example "layout.barWidth". */
export function valueAt(settings, path) {
    let value = settings;
    for (const key of path.split("."))
        value = isRecord(value) ? value[key] : undefined;
    return value;
}
/** Puts `value` at `keys` in `target` itself; undefined removes the key. */
function putAt(target, keys, value) {
    let parent = target;
    for (const key of keys.slice(0, -1)) {
        if (!isRecord(parent[key]))
            parent[key] = {};
        parent = parent[key];
    }
    const last = keys[keys.length - 1];
    if (value === undefined)
        delete parent[last];
    else
        parent[last] = value;
}
/**
 * A copy of the settings with `value` at `keys` (a key may hold a dot, like a row id);
 * undefined removes the key, which puts a color back to the theme's or a row name back.
 */
export function setIn(settings, keys, value) {
    const next = JSON.parse(JSON.stringify(settings));
    putAt(next, keys, value);
    return displaySettings(next);
}
export function defaultDisplaySettings() {
    return displaySettings(defaultSettings());
}
export function isSurfaceTab(tab) {
    return SURFACES.includes(tab);
}
/** A setting's page is its first key, for example "toast" in "toast.seconds", unless it names one. */
function tabOf(path) {
    return path.split(".")[0];
}
function listField(path, title, initial, values, show, options = {}) {
    return { path, tab: tabOf(path), title, initial, values, show, ...options };
}
const onOff = (off, on) => (value) => (value ? on : off);
function switchField(path, title, initial, options = {}) {
    return listField(path, title, initial, [false, true], onOff("关", "开"), options);
}
/** ‹ › step through `values`; a stored whole number from `min` to `max` counts too. */
function numberField(path, title, initial, [min, max], values, show, options = {}) {
    const valid = (value) => isWhole(value, min, max);
    return listField(path, title, initial, values, show, { valid, ...options });
}
/**
 * A line of the server's settings.jsonc, on All places or Providers. Its default and its
 * values (a choice, or off and on) come from SETTINGS_SCHEMA; a number line names the `values`
 * it steps through, or none when you type it.
 */
function serverField(path, title, show, options = {}) {
    const rule = SETTINGS_SCHEMA[path];
    const values = rule.kind === "choice" ? rule.values : rule.kind === "boolean" ? [false, true] : [];
    const tab = tabOf(path);
    const initial = rule.default;
    return { path, tab, title, initial, values, show, ...options };
}
/** One switch per place: the Limits tab always shows the pace. */
function runsOutField(surface, where, options = {}) {
    const note = "按你目前的使用速度，某项额度会在重置前用完时显示";
    const initial = SETTINGS_SCHEMA[`${surface}.runsOut`].default;
    return {
        ...switchField(`${surface}.runsOut`, "预计耗尽时间", initial, { note, ...options }),
        show: onOff("关", where),
    };
}
function tokensField(path, options = {}) {
    return {
        ...switchField(path, "会话 Token 行", true, options),
        show: onOff("隐藏", "显示"),
    };
}
function colorTitle(choice) {
    return choice === "bar" ? "进度条颜色" : (COLOR_LABELS[String(choice)] ?? String(choice));
}
/** A color line; undefined follows the theme. The bar colors themselves can't follow the bar. */
function colorField({ role, title, theme, group }) {
    const isLevel = role === "good" || role === "warning" || role === "low";
    const values = [undefined, ...COLOR_NAMES, ...(isLevel ? [] : ["bar"])];
    const show = (value) => value === undefined ? `${colorTitle(theme)}（主题）` : colorTitle(value);
    return { ...listField(`colors.${role}`, title, undefined, values, show, { group }), color: true };
}
const COLOR_FIELDS = COLOR_LINES.map(colorField);
const THRESHOLDS = [10, 15, 20, 25, 30, 40, 50, 60];
const STATUS_DETAILS = {
    auto: "尽量显示",
    one: "单个提供商，大进度条",
    full: "进度条、百分比与重置时间",
    bar: "进度条与百分比",
    reset: "百分比与重置时间",
    numbers: "仅百分比",
};
const BAR_SHAPES = ["blocks", "shades", "line", "squares", "dots", "none"];
const TOAST = { preset: "toast" };
const LAYOUT = { preset: "layout" };
/** The `words` lines, which every place follows: on All places. */
const ALL_PLACES = { tab: "layout" };
const unit = (word) => (value) => `${value} ${word}`;
const percentLeft = unit("% 剩余");
const RESET_NOTICES = { weekly: "周限额", all: "所有额度" };
const REPLY_TOASTS = ["off", "always", "low"];
const NOTICE_TOASTS = ["off", "weekly", "all"];
const MINUTE_MS = 60_000;
/** A reset 2h 14m away and one 5d 3h 20m away, as each reset style writes them. */
const RESET_EXAMPLES_MS = [134 * MINUTE_MS, 7_400 * MINUTE_MS];
const named = (names) => (value) => names[String(value)] ?? String(value);
/** 机器值不变，只改设置行里显示的字。 */
const REPLY_TOAST_LABELS = named({ off: "关", always: "总是", low: "余量偏低" });
const BAR_SHAPE_NAMES = {
    blocks: "方块",
    shades: "色阶",
    line: "细线",
    squares: "方点",
    dots: "圆点",
    none: "无进度条",
};
const COLOR_LABELS = {
    text: "文字",
    muted: "柔和",
    accent: "强调",
    green: "绿色",
    yellow: "黄色",
    red: "红色",
    blue: "蓝色",
    bar: "进度条颜色",
};
const usd = (unset) => (value) => typeof value === "number" ? `每月 $${value}` : unset;
const CURSOR = { provider: "cursor" };
/** A Cursor plan with the API use it includes, e.g. "Pro: $20 a month". */
const cursorPlan = (value) => {
    const plan = value;
    const includedUsd = getEffectiveCursorIncludedApiUsd({ plan });
    return includedUsd === undefined
        ? "未设置"
        : `${getCursorPlanDisplayName(plan)}：每月 $${includedUsd}`;
};
const SHOW = {
    detail: (value) => STATUS_DETAILS[value],
    width: (value) => (value ? `至多 ${value} 列` : "占满可用空间"),
    scroll: (value) => (value ? `每 ${value} 秒` : "关"),
    afterReply: (value) => REPLY_TOAST_LABELS(value),
    resetNotice: (value) => RESET_NOTICES[String(value)] ?? "关",
    bar: (value) => value === "none"
        ? "无进度条"
        : `${barParts(value, 60, 5).join("")} ${BAR_SHAPE_NAMES[value]}`,
    barWidth: (value) => (value === "fill" ? "填满可用宽度" : `${value} 列`),
    indent: (value) => (value === 1 ? "1 个空格" : `${value} 个空格`),
    gap: (value) => (value === 1 ? "1 个空行" : value ? `${value} 个空行` : "无"),
    separator: (value) => (String(value).trim() ? `“${String(value).trim()}”` : "空格"),
    percent: (value) => percentText({ ...DEFAULT_WORDS, percent: value }, 58, true),
    reset: (value) => RESET_EXAMPLES_MS.map((ms) => formatDuration(ms, value, 1)).join(" · "),
    decimals: (value) => `${value}（${formatDuration(RESET_EXAMPLES_MS[0], "decimal", Number(value))}）`,
    minutes: (value) => `每 ${Number(value) / MINUTE_MS} 分钟`,
    seconds: (value) => `${Number(value) / 1_000} 秒后`,
    days: (value) => (value === 1 ? "每天" : `每 ${value} 天`),
    day: (value) => (typeof value === "number" ? `每月 ${value} 日` : "按自然月"),
    rows: named({ summary: "仅主要行", detailed: "所有行" }),
    rowNames: named({ short: "5小时、7天、30天", full: "每周、每日、…" }),
    toastLayout: named({ grouped: "分组", detailed: "详细" }),
    models: named({ false: "全部", true: "仅当前模型" }),
    tokens: named({ current: "本次会话", tree: "含子代理" }),
    limitHit: named({ false: "照常重试", true: "等待重置" }),
};
// "Getting low" stays at or above "almost out", so ‹ › skip the values that would break that.
const warningChoices = (settings) => THRESHOLDS.filter((value) => value >= settings.colors.lowBelow);
const lowChoices = (settings) => THRESHOLDS.filter((value) => value <= settings.colors.warningBelow);
const isSeparator = (value) => typeof value === "string" && value.length <= 5;
/** Every plain setting, in the order its tab shows it. */
export const FIELDS = [
    tokensField("sidebar.sessionTokens", { group: "显示内容" }),
    runsOutField("sidebar", "行下方"),
    runsOutField("collapsed", "提供商下方", { group: "显示内容" }),
    {
        ...switchField("statusLine.withSidebar", "侧栏旁", false, {
            group: "显示时机",
        }),
        show: onOff("隐藏", "一并显示"),
    },
    switchField("statusLine.home", "Home 页底部", false, {
        note: "即使消息框下方的行已关闭",
    }),
    listField("statusLine.detail", "显示", "auto", Object.keys(STATUS_DETAILS), SHOW.detail, {
        group: "显示内容",
    }),
    runsOutField("statusLine", "提供商之后"),
    numberField("statusLine.width", "宽度", 0, [0, 1000], [0, 40, 60, 80], SHOW.width, {
        group: "宽度与滚动",
        note: "只影响状态栏；侧栏宽度随窗口",
    }),
    numberField("statusLine.autoScrollSeconds", "自动滚动", 0, [0, 600], [0, 5, 10], SHOW.scroll),
    listField("toast.afterReply", "每次回复后", "low", REPLY_TOASTS, SHOW.afterReply, {
        group: "显示时机",
        ...TOAST,
    }),
    switchField("toast.afterQuestion", "向你提问后", false, TOAST),
    switchField("toast.afterCompaction", "上下文压缩后", true, TOAST),
    switchField("toast.whenAllFail", "所有提供商均失败时", true, TOAST),
    listField("toast.resetNotice", "额度重置时", "off", NOTICE_TOASTS, SHOW.resetNotice, TOAST),
    listField("toast.layout", "布局", "grouped", ["grouped", "detailed"], SHOW.toastLayout, {
        group: "外观",
    }),
    numberField("toast.seconds", "停留时长", 9, [1, 120], [5, 9, 15, 30], unit("秒")),
    tokensField("toast.sessionTokens"),
    runsOutField("toast", "行之后"),
    ...COLOR_FIELDS.slice(0, 4),
    numberField("colors.warningBelow", "“余量偏低”阈值", 50, [0, 100], THRESHOLDS, percentLeft, {
        choices: warningChoices,
    }),
    numberField("colors.lowBelow", "“即将用尽”阈值", 20, [0, 100], THRESHOLDS, percentLeft, {
        choices: lowChoices,
    }),
    ...COLOR_FIELDS.slice(4),
    listField("layout.bar", "进度条样式", "blocks", BAR_SHAPES, SHOW.bar, {
        group: "进度条",
        note: "所有位置的额度条样式联动",
    }),
    listField("layout.barWidth", "进度条宽度", "fill", ["fill", 4, 6, 8, 10, 12], SHOW.barWidth, {
        valid: (value) => value === "fill" || isWhole(value, 1, 30),
        ...LAYOUT,
    }),
    switchField("layout.evenUse", "均匀使用参考线", false, {
        note: "在进度条上标出均匀使用应处的位置；各处联动",
    }),
    numberField("layout.indent", "行缩进", 1, [0, 4], [0, 1, 2, 3], SHOW.indent, {
        group: "间距",
        note: "仅侧栏额度行；每行左侧的空格数",
        ...LAYOUT,
    }),
    numberField("layout.labelWidth", "行名宽度", 8, [3, 20], [6, 8, 10, 12], unit("个字符"), {
        note: "仅侧栏额度行；行名最多占用的列数，超出省略",
        ...LAYOUT,
    }),
    numberField("layout.providerGap", "提供商间距", 1, [0, 2], [0, 1], SHOW.gap, {
        note: "仅侧栏额度面板；提供商之间的空行数",
        ...LAYOUT,
    }),
    listField("layout.separator", "分隔符", " · ", [" · ", " | ", " / ", "  "], SHOW.separator, {
        group: "状态栏",
        valid: isSeparator,
    }),
    serverField("words.percent", "百分比", SHOW.percent, {
        ...ALL_PLACES,
        group: "用词",
        preset: "words",
        note: "控制“剩余／已用”等用词；侧栏标题也跟随",
    }),
    serverField("words.reset", "重置时间", SHOW.reset, {
        ...ALL_PLACES,
        note: "控制倒计时的显示格式；各处联动",
        preset: "words",
    }),
    serverField("words.resetDecimals", "小数位", SHOW.decimals, {
        ...ALL_PLACES,
        note: "小数格式保留的位数；例：1 位＝2.2h",
        values: [0, 1, 2],
    }),
    serverField("words.rowNames", "行名称", SHOW.rowNames, {
        ...ALL_PLACES,
        note: "控制行名用短名还是全名；重命名的行始终保留",
        preset: "words",
    }),
    serverField("words.detail", "额外行", SHOW.rows, {
        ...ALL_PLACES,
        group: "显示内容",
        note: "是否显示额外行；卡片排序与显隐由宿主管理",
    }),
    serverField("words.onlyCurrentModel", "提供商范围", SHOW.models, ALL_PLACES),
    serverField("words.sessionTokens", "会话 Token 计数", SHOW.tokens, ALL_PLACES),
    serverField("providers.cursor.plan", "套餐", cursorPlan, {
        ...CURSOR,
        note: "套餐内含的 API 用量，按百分比显示",
    }),
    serverField("providers.cursor.includedApiUsd", "包含的 API 预算", usd("跟随套餐"), {
        ...CURSOR,
        note: "用此金额替代套餐自带额度",
        placeholder: "美元金额",
    }),
    serverField("providers.cursor.billingCycleStartDay", "账单日", SHOW.day, {
        ...CURSOR,
        note: "Cursor 账单每月的刷新日",
        placeholder: "1-28",
    }),
    serverField("providers.opencode.monthlyLimitUsd", "月度预算", usd("跟随控制台"), {
        provider: "opencode",
        note: "用此金额替代",
        placeholder: "美元金额",
    }),
    serverField("providers.checking.minIntervalMs", "检查间隔", SHOW.minutes, {
        group: "检查",
        values: [1, 2, 5, 10, 15, 30].map((count) => count * MINUTE_MS),
    }),
    serverField("providers.checking.requestTimeoutMs", "慢提供商：放弃等待", SHOW.seconds, {
        values: [5_000, 8_000, 12_000, 20_000, 30_000],
    }),
    serverField("providers.checking.waitForQuotaReset", "模型达到限额时", SHOW.limitHit),
    serverField("providers.pricing.source", "价格来源", named({ auto: "最新列表", bundled: "仅内置列表", runtime: "仅已下载列表" }), { group: "Token 价格" }),
    serverField("providers.pricing.autoRefreshDays", "自动下载新价格", SHOW.days, {
        values: [1, 7, 30],
    }),
];
function layoutChoice(barWidth, indent, labelWidth, providerGap) {
    return {
        "layout.barWidth": barWidth,
        "layout.indent": indent,
        "layout.labelWidth": labelWidth,
        "layout.providerGap": providerGap,
    };
}
function toastChoice(afterReply, afterQuestion, afterCompaction, resetNotice) {
    return {
        "toast.afterReply": afterReply,
        "toast.afterQuestion": afterQuestion,
        "toast.afterCompaction": afterCompaction,
        "toast.whenAllFail": true,
        "toast.resetNotice": resetNotice,
    };
}
/** Every color line: `changes`' colors, the theme's for the rest. */
function colorChoice(changes) {
    return Object.fromEntries(COLOR_LINES.map(({ role }) => [`colors.${role}`, changes[role]]));
}
export const PRESETS = {
    layout: {
        tab: "layout",
        title: "布局预设",
        drives: "进度条宽度、行缩进、行名宽度与提供商间距",
        choices: {
            紧凑: layoutChoice(6, 1, 6, 0),
            舒适: layoutChoice("fill", 1, 8, 1),
            宽松: layoutChoice("fill", 2, 8, 2),
        },
    },
    toast: {
        tab: "toast",
        title: "提示显示时机",
        drives: "“显示时机”下的 5 行",
        choices: {
            仅失败时: toastChoice("off", false, false, "off"),
            安静: toastChoice("off", false, true, "off"),
            常规: toastChoice("low", false, true, "off"),
            每次回复: toastChoice("always", true, true, "all"),
        },
    },
    colors: {
        tab: "colors",
        title: "颜色预设",
        drives: "所有颜色行",
        choices: {
            主题色: colorChoice({}),
            // The panel title in the text color, Almost out and errors in their red, the rest grey.
            灰色: colorChoice({
                good: "muted",
                warning: "muted",
                provider: "muted",
                label: "muted",
                arrows: "muted",
            }),
        },
    },
    words: {
        tab: "layout",
        title: "用词预设",
        drives: "百分比、重置时间与行名称",
        before: "words.percent",
        choices: {
            常规: { "words.percent": "left", "words.reset": "smart", "words.rowNames": "short" },
            简短: { "words.percent": "bare", "words.reset": "compact", "words.rowNames": "short" },
            全称: {
                "words.percent": "remaining",
                "words.reset": "exact",
                "words.rowNames": "full",
            },
        },
    },
};
/** The value `delta` steps from `current` in `values`, wrapping; an unknown one counts as the first. */
export function stepIn(values, current, delta) {
    const index = Math.max(0, values.indexOf(current));
    return values[(index + delta + values.length) % values.length];
}
/** A typed number the server takes for the field ("$" allowed); null for nothing typed. */
export function typedNumber(field, text) {
    const trimmed = text.trim().replace(/^\$/u, "");
    if (!trimmed)
        return null;
    const value = Number(trimmed);
    return checkSetting(field.path, value).issues.length === 0 ? value : undefined;
}
/** A typed "#89b4fa" (the # is optional); nothing typed puts the theme's color back. */
export function typedColor(settings, field, text) {
    const hex = text.trim().replace(/^#/u, "").toLowerCase();
    if (hex && !/^[0-9a-f]{6}$/u.test(hex))
        return settings;
    return setIn(settings, field.path.split("."), hex ? `#${hex}` : undefined);
}
/** The preset choice whose values all match the lines' values; undefined is "your own". */
export function presetChoice(name, value) {
    return Object.entries(PRESETS[name].choices).find(([, values]) => Object.entries(values).every(([path, wanted]) => value(path) === wanted))?.[0];
}
/** ‹ or ›: the values of the previous or next choice after `current`; from "your own", the first. */
export function presetValues(name, current, delta) {
    const names = Object.keys(PRESETS[name].choices);
    const next = current === undefined ? names[0] : stepIn(names, current, delta);
    return PRESETS[name].choices[next] ?? {};
}
/**
 * Your name for a row; nothing typed puts its own name back. A name equal to its own label
 * stays, so it shows where `words.rowNames` "short" would show the window's short name.
 */
export function renameRow(settings, surface, rowId, text) {
    const label = text.trim();
    return setIn(settings, [surface, "names", rowId], label || undefined);
}
/**
 * The tab's lines back to their defaults. A surface tab also puts that surface's order, hidden
 * rows and switches back (and Collapsed and Status line the preferred windows); row names stay.
 */
export function resetTab(settings, tab) {
    let next = FIELDS.filter((field) => field.tab === tab).reduce((result, field) => setIn(result, field.path.split("."), field.initial), settings);
    if (isSurfaceTab(tab)) {
        for (const key of ["show", "hidden", "providerOrder", "rowOrder"])
            next = setIn(next, [tab, key], valueAt(defaultSettings(), `${tab}.${key}`));
    }
    if (tab === "collapsed" || tab === "statusLine")
        next = setIn(next, [tab, "window"], {});
    return next;
}
export function createFileDisplay(server) {
    const shown = () => {
        const settings = defaultSettings();
        for (const key of Object.keys(SETTINGS_SCHEMA)) {
            if (key !== "version") {
                const value = server.value(key);
                if (value !== undefined)
                    setPath(settings, key, value);
            }
        }
        return displaySettings(settings);
    };
    return {
        server,
        shown,
        edit(change) {
            for (const diff of diffSettings(shown(), change(shown())))
                server.set(diff.key, diff.after);
        },
    };
}
