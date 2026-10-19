/**
 * The server settings: one table of rules with their defaults. The Settings type, the defaults,
 * reading, saving and the agent tools all come from it, so a value is valid in one place exactly
 * when it is valid in the others.
 */
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { getNodeValue } from "jsonc-parser";
import { ALL_PROVIDERS, isQuotaWindow } from "../core/windows.js";
import { isRecord } from "../lib/json-guards.js";
import { normalizeQuotaProviderId, QUOTA_PROVIDER_CATALOG } from "../lib/provider-metadata.js";
import { describeQuotaProviderRequest, isMaintainedQuotaProviderTuning, validateQuotaProviders, } from "../lib/quota-providers.js";
/** The names a color setting takes besides "#rrggbb": theme colors, and the row's bar color. */
export const THEME_COLOR_NAMES = [
    "text",
    "muted",
    "accent",
    "green",
    "yellow",
    "red",
    "blue",
    "bar",
];
const bool = (value) => ({ kind: "boolean", default: value });
const choice = (values, value) => ({ kind: "choice", values, default: value });
const above0 = (value) => ({ kind: "number", integer: false, above: 0, default: value });
const whole = (min, max) => ({ kind: "number", integer: true, min, max });
const USD = { kind: "number", integer: false, above: 0, nullable: true, default: null };
/** Every setting by its dotted key with its default, in the order a new file lists them. */
export const SETTINGS_SCHEMA = {
    version: { ...whole(6, 6), default: 6 },
    "sidebar.show": bool(true),
    "sidebar.sessionTokens": bool(true),
    "sidebar.runsOut": bool(true),
    "sidebar.hidden": { kind: "strings", default: [] },
    "sidebar.providerOrder": { kind: "strings", default: [] },
    "sidebar.rowOrder": { kind: "rowOrder", default: {} },
    "sidebar.names": { kind: "names", default: {} },
    "collapsed.show": bool(true),
    "collapsed.runsOut": bool(false),
    "collapsed.hidden": { kind: "strings", default: [] },
    "collapsed.providerOrder": { kind: "strings", default: [] },
    "collapsed.rowOrder": { kind: "rowOrder", default: {} },
    /** A window by provider id; `ALL_PROVIDERS` ("*") for every provider without its own. */
    "collapsed.window": { kind: "window", default: {} },
    "statusLine.show": bool(true),
    /** Also while a sidebar panel shows quota; else only when none is on screen. */
    "statusLine.withSidebar": bool(false),
    "statusLine.runsOut": bool(false),
    "statusLine.hidden": { kind: "strings", default: [] },
    "statusLine.providerOrder": { kind: "strings", default: [] },
    "statusLine.rowOrder": { kind: "rowOrder", default: {} },
    "statusLine.window": { kind: "window", default: {} },
    "statusLine.detail": choice(["auto", "one", "full", "bar", "reset", "numbers"], "auto"),
    "statusLine.width": { ...whole(0, 1000), default: 0 },
    "statusLine.autoScrollSeconds": { ...whole(0, 600), default: 0 },
    "statusLine.home": bool(false),
    "toast.show": bool(false),
    "toast.runsOut": bool(true),
    "toast.hidden": { kind: "strings", default: [] },
    "toast.providerOrder": { kind: "strings", default: [] },
    "toast.rowOrder": { kind: "rowOrder", default: {} },
    "toast.names": { kind: "names", default: {} },
    "toast.afterReply": choice(["off", "always", "low"], "low"),
    "toast.afterQuestion": bool(false),
    "toast.afterCompaction": bool(true),
    "toast.whenAllFail": bool(true),
    "toast.resetNotice": choice(["off", "weekly", "all"], "off"),
    /** "grouped": a line per row under its provider; "detailed": v5's two lines per row. */
    "toast.layout": choice(["grouped", "detailed"], "grouped"),
    "toast.seconds": { ...whole(1, 120), default: 9 },
    "toast.sessionTokens": bool(true),
    "colors.good": { kind: "color", default: undefined },
    "colors.warning": { kind: "color", default: undefined },
    "colors.low": { kind: "color", default: undefined },
    "colors.empty": { kind: "color", default: undefined },
    "colors.title": { kind: "color", default: undefined },
    "colors.provider": { kind: "color", default: undefined },
    "colors.account": { kind: "color", default: undefined },
    "colors.label": { kind: "color", default: undefined },
    "colors.percent": { kind: "color", default: undefined },
    "colors.reset": { kind: "color", default: undefined },
    "colors.value": { kind: "color", default: undefined },
    "colors.error": { kind: "color", default: undefined },
    "colors.statusName": { kind: "color", default: undefined },
    "colors.separator": { kind: "color", default: undefined },
    "colors.arrows": { kind: "color", default: undefined },
    "colors.warningBelow": { ...whole(0, 100), default: 50 },
    "colors.lowBelow": { ...whole(0, 100), default: 20 },
    "layout.bar": choice(["blocks", "shades", "line", "squares", "dots", "none"], "blocks"),
    /** "fill": the room the other columns leave, up to each place's most. */
    "layout.barWidth": { ...whole(1, 30), word: "fill", default: "fill" },
    /** The ┃ mark where even use would be, in every place's bars (the Limits tab always has it). */
    "layout.evenUse": bool(false),
    "layout.indent": { ...whole(0, 4), default: 1 },
    "layout.labelWidth": { ...whole(3, 20), default: 8 },
    "layout.providerGap": { ...whole(0, 2), default: 1 },
    "layout.separator": { kind: "separator", default: " · " },
    /** The words every client uses: "58% left", "58% remaining", "58%", or "42% used". */
    "words.percent": choice(["left", "remaining", "bare", "used"], "left"),
    /** "4.5d" (smart), "2h 14m", "2h14m", "2h", or "2.2h" (with `resetDecimals`). */
    "words.reset": choice(["smart", "exact", "compact", "short", "decimal"], "smart"),
    "words.resetDecimals": { ...whole(0, 4), default: 1 },
    /** Rows named by their window ("5h", "7d") where that tells them apart, or by their labels. */
    "words.rowNames": choice(["short", "full"], "short"),
    /** "detailed" also shows supplementary rows. */
    "words.detail": choice(["summary", "detailed"], "summary"),
    /** Show only the providers serving the session's current model. */
    "words.onlyCurrentModel": bool(false),
    /** Session tokens of this session, or with its subagents. */
    "words.sessionTokens": choice(["current", "tree"], "current"),
    "providers.off": { kind: "providers", default: [] },
    "providers.custom": { kind: "customProviders", default: [], fileOnly: true },
    /** The Claude CLI quota runs for Claude limits. */
    "providers.anthropic.binaryPath": {
        kind: "path",
        allowCommand: true,
        default: "claude",
        fileOnly: true,
    },
    "providers.cursor.plan": choice(["none", "pro", "pro-plus", "ultra"], "none"),
    "providers.cursor.includedApiUsd": USD,
    "providers.cursor.billingCycleStartDay": { ...whole(1, 28), nullable: true, default: null },
    "providers.opencode.monthlyLimitUsd": USD,
    "providers.checking.minIntervalMs": above0(300_000),
    "providers.checking.requestTimeoutMs": above0(5_000),
    "providers.checking.waitForQuotaReset": bool(true),
    "providers.pricing.source": choice(["auto", "bundled", "runtime"], "auto"),
    "providers.pricing.autoRefreshDays": { ...whole(1), default: 7 },
    "system.exportFile": bool(false),
    /** "" = `$XDG_CACHE_HOME/opencode/quota-export.json`. */
    "system.exportPath": { kind: "path", allowEmpty: true, default: "", fileOnly: true },
    "system.telemetry": bool(false),
    /** The 4.x and 5.x /tokens_* commands, each `/quota_usage` on its range. */
    "system.oldCommands": bool(true),
};
const RULES = SETTINGS_SCHEMA;
export function defaultSettings() {
    const settings = {};
    for (const [key, rule] of Object.entries(RULES)) {
        setPath(settings, key, structuredClone(rule.default));
    }
    return settings;
}
/** Every key that holds other settings, e.g. "providers" and "providers.cursor". */
const GROUPS = new Set(Object.keys(RULES).flatMap((key) => {
    const parts = key.split(".");
    return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join("."));
}));
export function isSettingsGroup(key) {
    return GROUPS.has(key);
}
/** Whether `key` is a file-only setting or a group that holds one. */
export function isFileOnly(key) {
    return Object.entries(RULES).some(([name, rule]) => rule.fileOnly === true && (name === key || name.startsWith(`${key}.`)));
}
/** The names directly inside `group` ("" = the top level), in file order. */
export function keysUnder(group) {
    const prefix = group ? `${group}.` : "";
    const names = Object.keys(RULES)
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length).split(".")[0]);
    return [...new Set(names)];
}
/** Provider ids `providers.off` accepts; `custom` switches all custom providers off. */
export const PROVIDER_IDS = Object.keys(QUOTA_PROVIDER_CATALOG).map((id) => id === "quota-providers" ? "custom" : id);
/** A provider id or one of its aliases ("nano-gpt", "quota-providers") as `providers.off` stores it. */
function canonicalProviderId(id) {
    const normalized = normalizeQuotaProviderId(id);
    const canonical = normalized === "quota-providers" ? "custom" : normalized;
    return PROVIDER_IDS.includes(canonical) ? canonical : undefined;
}
/** What a rule accepts, in words, for issue messages and the agent tools. */
export function describeRule(rule) {
    switch (rule.kind) {
        case "boolean":
            return "true or false";
        case "choice":
            return `取值之一：${rule.values.map((value) => JSON.stringify(value)).join(", ")}`;
        case "number": {
            const kind = rule.integer ? "整数" : "数字";
            const bounds = rule.min !== undefined && rule.max !== undefined
                ? rule.min === rule.max
                    ? ` 等于 ${rule.min}`
                    : ` 在 ${rule.min} 到 ${rule.max} 之间`
                : rule.above !== undefined
                    ? ` 大于 ${rule.above}`
                    : rule.min !== undefined
                        ? ` 不小于 ${rule.min}`
                        : "";
            const word = rule.word === undefined ? "" : `${JSON.stringify(rule.word)} 或 `;
            return `${word}${rule.nullable ? "null 或 " : ""}${kind}${bounds}`;
        }
        case "path": {
            const or = rule.allowEmpty ? '"" 或 ' : rule.allowCommand ? "命令名或 " : "";
            return `${or}绝对路径或 ~/ 路径，不含 ".."`;
        }
        case "providers":
            return `列表，元素取自：${PROVIDER_IDS.join(", ")}`;
        case "customProviders":
            return "自定义提供商定义的列表";
        case "strings":
            return "字符串列表";
        case "names":
            return "对象：行 id → 名称";
        case "rowOrder":
            return "对象：提供商 id → 行 id 列表";
        case "window":
            return `对象：提供商 id（或用 "${ALL_PROVIDERS}" 表示全部提供商）→ 额度窗口或 lowest`;
        case "color":
            return "主题色名、bar 或 #rrggbb";
        case "separator":
            return "最多 5 个字符的字符串";
    }
}
function checkNumber(rule, value) {
    if (value === null)
        return rule.nullable === true;
    if (rule.word !== undefined && value === rule.word)
        return true;
    return (typeof value === "number" &&
        Number.isFinite(value) &&
        (!rule.integer || Number.isInteger(value)) &&
        (rule.min === undefined || value >= rule.min) &&
        (rule.above === undefined || value > rule.above) &&
        (rule.max === undefined || value <= rule.max));
}
/** An absolute or `~/` path with no `..` part, so it never depends on a working folder. */
function isSafePath(path) {
    return (isAbsolute(path) || /^~[\\/]/u.test(path)) && !path.split(/[\\/]/u).includes("..");
}
function checkProviders(key, value) {
    if (!Array.isArray(value)) {
        return { issues: [{ key, message: `应为：${describeRule(RULES[key])}` }] };
    }
    const known = [];
    const unknown = [];
    value.forEach((item, index) => {
        const id = typeof item === "string" ? canonicalProviderId(item) : undefined;
        // Anything but a string is named by its position, so no name inside it is repeated.
        if (id)
            known.push(id);
        else
            unknown.push(typeof item === "string" ? item : `item ${index + 1}`);
    });
    if (unknown.length === 0)
        return { value: [...new Set(known)], issues: [] };
    const message = `unknown provider id(s): ${unknown.join(", ")}; valid: ${PROVIDER_IDS.join(", ")}`;
    const issues = [{ key, message }];
    // Keep valid ids; a list of only unknown ids uses the empty default.
    return known.length > 0 ? { value: [...new Set(known)], issues } : { issues };
}
function checkCustomProviders(key, value) {
    const result = validateQuotaProviders(value);
    if (result.value)
        return { value: result.value, issues: [] };
    return {
        issues: result.issues.map((issue) => ({
            key: issue.key.replace(/^quotaProviders/u, key),
            message: issue.message,
        })),
    };
}
export function isRecordSetting(key) {
    const kind = RULES[key]?.kind;
    return kind === "names" || kind === "rowOrder" || kind === "window";
}
function isStringList(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}
/** Checks one value against its rule; `key` must be in SETTINGS_SCHEMA. */
export function checkSetting(key, value) {
    const rule = Object.hasOwn(RULES, key) ? RULES[key] : undefined;
    if (!rule)
        return { issues: [{ key, message: "未知设置" }] };
    const invalid = { issues: [{ key, message: `应为：${describeRule(rule)}` }] };
    switch (rule.kind) {
        case "boolean":
            return typeof value === "boolean" ? { value, issues: [] } : invalid;
        case "choice":
            return typeof value === "string" && rule.values.includes(value)
                ? { value, issues: [] }
                : invalid;
        case "number":
            return checkNumber(rule, value) ? { value, issues: [] } : invalid;
        case "path": {
            if (typeof value !== "string")
                return invalid;
            const path = value.trim();
            const isCommand = rule.allowCommand === true && /^\w[\w.-]*$/u.test(path);
            const valid = path === "" ? rule.allowEmpty === true : isCommand || isSafePath(path);
            return valid ? { value: path, issues: [] } : invalid;
        }
        case "providers":
            return checkProviders(key, value);
        case "customProviders":
            return checkCustomProviders(key, value);
        case "strings":
            return isStringList(value) ? { value, issues: [] } : invalid;
        case "separator":
            return typeof value === "string" && value.length <= 5 ? { value, issues: [] } : invalid;
        case "color":
            return value === undefined ||
                THEME_COLOR_NAMES.includes(String(value)) ||
                (typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value))
                ? { value, issues: [] }
                : invalid;
        case "names":
        case "rowOrder":
        case "window": {
            if (!isRecord(value))
                return invalid;
            const entries = Object.entries(value);
            const valid = (item) => rule.kind === "names"
                ? typeof item === "string"
                : rule.kind === "rowOrder"
                    ? isStringList(item)
                    : item === "lowest" || isQuotaWindow(item);
            const kept = entries.filter(([, item]) => valid(item));
            return {
                value: Object.fromEntries(kept),
                issues: kept.length === entries.length ? [] : invalid.issues,
            };
        }
    }
}
/** The issue key for the top level of a file or patch, which has no settings key of its own. */
const TOP_LEVEL_KEY = "$top";
/** A name at `position` (from 1) in `group` ("" for the top level) that is not a setting. */
function unknownKeyIssue(group, position) {
    const where = group ? `（${group}）` : "";
    return {
        key: group || TOP_LEVEL_KEY,
        message: `未知设置（第 ${position} 个键）；${where}可用的有：${keysUnder(group).join(", ")}`,
    };
}
export const PLAIN_WALKER = {
    entries: (value) => (isRecord(value) ? Object.entries(value) : undefined),
    leaf: (value) => value,
};
export const NODE_WALKER = {
    entries: (node) => {
        if (node.type !== "object")
            return undefined;
        const pairs = [];
        for (const property of node.children ?? []) {
            const [name, value] = property.children ?? [];
            // A half-written property; the parse error already says where it is.
            if (name?.type === "string" && value)
                pairs.push([String(name.value), value]);
        }
        return pairs;
    },
    leaf: getNodeValue,
};
/** A file sets a key twice: reading uses the last valid value, saving refuses. */
export const DUPLICATE_KEY = "duplicate key; the last valid value is used";
/** A name with a dot ("words.percent") is not read (settings nest), and saving refuses it. */
export const DOTTED_KEY = "a key with a dot is not read";
/**
 * The settings an object sets, as dotted keys in order. Unknown, duplicate and dotted keys
 * become issues; a group set to something other than an object becomes an assignment of the group
 * key, so the caller decides (an issue when reading, a reset when a patch says null). An issue
 * names a settings key, or the position of a name that is not one: a name that is not a setting
 * is never repeated, so a secret typed as a key name stays out of every message.
 */
export function flattenSettings(walker, value, prefix = "") {
    const assignments = [];
    const issues = [];
    const names = new Set();
    for (const [index, [name, child]] of (walker.entries(value) ?? []).entries()) {
        const key = prefix ? `${prefix}.${name}` : name;
        const isSetting = Object.hasOwn(RULES, key) || GROUPS.has(key);
        if (isSetting && names.has(name))
            issues.push({ key, message: DUPLICATE_KEY });
        names.add(name);
        if (name.includes(".")) {
            issues.push({
                key: prefix || TOP_LEVEL_KEY,
                message: `${DOTTED_KEY} (key ${index + 1}); nest it instead`,
            });
        }
        else if (Object.hasOwn(RULES, key)) {
            assignments.push({ key, value: walker.leaf(child) });
        }
        else if (GROUPS.has(key) && walker.entries(child)) {
            const nested = flattenSettings(walker, child, key);
            assignments.push(...nested.assignments);
            issues.push(...nested.issues);
        }
        else if (GROUPS.has(key)) {
            assignments.push({ key, value: walker.leaf(child) });
        }
        else {
            issues.push(unknownKeyIssue(prefix, index + 1));
        }
    }
    return { assignments, issues };
}
function getSetting(settings, key) {
    let value = settings;
    for (const part of key.split("."))
        value = isRecord(value) ? value[part] : undefined;
    return value;
}
/** Sets a dotted key in a nested object, making the groups on the way. */
export function setPath(target, key, value) {
    const parts = key.split(".");
    let group = target;
    for (const part of parts.slice(0, -1)) {
        group[part] ??= {};
        group = group[part];
    }
    group[parts[parts.length - 1]] = value;
}
/**
 * The defaults with every valid assignment applied in order. An invalid value is reported and
 * changes nothing, so a bad value later in the file never replaces a good one before it.
 */
export function settingsFrom(assignments) {
    const settings = defaultSettings();
    const issues = [];
    const fromFile = new Set();
    for (const { key, value } of assignments) {
        if (GROUPS.has(key)) {
            issues.push({ key, message: "expected an object" });
            continue;
        }
        const checked = checkSetting(key, value);
        issues.push(...checked.issues);
        if (checked.value === undefined)
            continue;
        setPath(settings, key, checked.value);
        fromFile.add(key);
    }
    // The warning level stays at or above the low level, as the display settings require.
    settings.colors.warningBelow = Math.max(settings.colors.warningBelow, settings.colors.lowBelow);
    return { settings, issues, fromFile: [...fromFile] };
}
/** Every setting whose value differs between `before` and `after`. */
export function diffSettings(before, after) {
    return Object.keys(RULES)
        .map((key) => ({ key, before: getSetting(before, key), after: getSetting(after, key) }))
        .filter((change) => JSON.stringify(change.before) !== JSON.stringify(change.after));
}
/** Why a custom provider is not switched on: its definition is not the one the user saw. */
export const CHANGED_SINCE_REVIEW = "changed since you reviewed it; look again";
/**
 * A hash of what the user checks before switching a custom provider on (`request`) and of the
 * fields that decide where its request goes and which key it reads.
 */
export function customProviderFingerprint(definition) {
    const { mode, providerId } = definition;
    const sent = definition.mode === "remote-api" ? [definition.url, definition.apiKeyEnv ?? null] : [];
    const seen = [describeQuotaProviderRequest(definition), mode, providerId, ...sent];
    return createHash("sha256").update(JSON.stringify(seen)).digest("hex");
}
export function clientSettings(settings) {
    const values = Object.fromEntries(Object.keys(RULES)
        .filter((key) => key !== "version" && !isFileOnly(key) && getSetting(settings, key) !== undefined)
        .map((key) => [key, getSetting(settings, key)]));
    const providers = PROVIDER_IDS.map((id) => ({
        id,
        label: id === "custom"
            ? "Custom providers"
            : QUOTA_PROVIDER_CATALOG[id].label,
    }));
    const custom = settings.providers.custom
        .filter((definition) => !isMaintainedQuotaProviderTuning(definition))
        .map((definition) => ({
        id: definition.id,
        label: definition.label,
        enabled: definition.enabled !== false,
        request: describeQuotaProviderRequest(definition),
        fingerprint: customProviderFingerprint(definition),
    }));
    return { values, providers, custom };
}
