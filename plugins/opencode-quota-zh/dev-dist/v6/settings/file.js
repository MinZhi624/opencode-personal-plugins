/**
 * The server settings file, `<config>/opencode-quota/settings.jsonc` (global only). Load it
 * (defaults for what is missing or wrong), save a patch into it (comments kept), watch it for
 * edits, and convert the v5 settings into it once.
 */
import { unwatchFile, watch, watchFile } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { applyEdits, createScanner, findNodeAtLocation, modify, parseTree, printParseErrorCode, } from "jsonc-parser";
import { configWriteTargetsEqual, NEW_CONFIG_DIRECTORY_MODE, NEW_CONFIG_FILE_MODE, resolveConfigWriteTarget, writeResolvedConfigText, } from "../lib/config-write-target.js";
import { LockLostError, withFileLock } from "../lib/file-lock.js";
import { getOpencodeRuntimeDirs } from "../lib/opencode-runtime-paths.js";
import { findUnreadV5Files, planV5Conversion } from "./convert.js";
import { CHANGED_SINCE_REVIEW, checkSetting, customProviderFingerprint, DOTTED_KEY, DUPLICATE_KEY, defaultSettings, diffSettings, flattenSettings, isFileOnly, isRecordSetting, isSettingsGroup, NODE_WALKER, PLAIN_WALKER, settingsFrom, } from "./schema.js";
export function settingsPath() {
    return join(getOpencodeRuntimeDirs().configDir, "opencode-quota", "settings.jsonc");
}
const NEW_FILE_HEADER = [
    "OpenCode Quota settings, by section. Every key is optional; a missing one uses its default.",
    "Edit it by hand or ask your agent; OpenCode Quota keeps your comments when it saves.",
];
const errorCode = (error) => error && typeof error === "object" && "code" in error ? String(error.code) : "";
const errorMessage = (error) => (error instanceof Error ? error.message : String(error));
const lineOf = (text, offset) => text.slice(0, offset).split("\n").length;
/** The settings a file text sets; what does not parse or check takes its default. */
function readSettingsText(text) {
    const errors = [];
    const root = parseTree(text, errors, { allowTrailingComma: true });
    const issues = errors.map((error) => ({
        key: "$file",
        message: `syntax error on line ${lineOf(text, error.offset)}: ${printParseErrorCode(error.error)}`,
    }));
    if (root?.type !== "object") {
        issues.push({ key: "$file", message: "expected one JSON object; using the defaults" });
        return { settings: defaultSettings(), issues, fromFile: [] };
    }
    const flat = flattenSettings(NODE_WALKER, root);
    const read = settingsFrom(flat.assignments);
    return { ...read, issues: [...issues, ...flat.issues, ...read.issues] };
}
/**
 * The settings now. Without settings.jsonc: the v5 settings converted in memory when there are
 * any (this never writes; `convertV5` does), else the defaults.
 */
export async function loadSettings(options = {}) {
    const path = settingsPath();
    const { configDir } = getOpencodeRuntimeDirs();
    let read;
    try {
        read = readSettingsText(await readFile(path, "utf8"));
    }
    catch (error) {
        const reason = errorCode(error) || errorMessage(error);
        const issue = { key: "$file", message: `cannot read it (${reason}); using the defaults` };
        if (reason !== "ENOENT")
            read = { settings: defaultSettings(), issues: [issue], fromFile: [] };
    }
    if (read) {
        const notRead = await findUnreadV5Files(configDir, { includeGlobal: true, ...options });
        return { path, exists: true, ...read, notRead };
    }
    const conversion = await planV5Conversion(configDir);
    const notRead = await findUnreadV5Files(configDir, { includeGlobal: false, ...options });
    if (!conversion) {
        return { path, exists: false, settings: defaultSettings(), issues: [], fromFile: [], notRead };
    }
    const { settings, fromFile } = conversion;
    return { path, exists: false, settings, issues: [], fromFile, conversion, notRead };
}
/** Where the comma after `offset` ends; comments and spaces before it are skipped. */
function commaEnd(text, offset) {
    const scanner = createScanner(text, true);
    scanner.setPosition(offset);
    scanner.scan();
    return scanner.getTokenOffset() + scanner.getTokenLength();
}
/**
 * The text without one list entry, the comments before it and the comma beside it; what
 * follows keeps its place. (jsonc-parser's own removal cuts the wrong characters around a
 * list's last entry.)
 */
function removeListEntry(text, path) {
    const index = path.at(-1);
    const root = parseTree(text, [], { allowTrailingComma: true });
    const list = root && findNodeAtLocation(root, path.slice(0, -1));
    const entries = list?.type === "array" ? (list.children ?? []) : [];
    const entry = typeof index === "number" ? entries[index] : undefined;
    if (!list || !entry || typeof index !== "number")
        throw new Error("no such list entry");
    const entryEnd = entry.offset + entry.length;
    if (entries.length === 1) {
        return text.slice(0, list.offset + 1) + text.slice(list.offset + list.length - 1);
    }
    const previous = entries[index - 1];
    if (index === entries.length - 1) {
        return text.slice(0, previous.offset + previous.length) + text.slice(entryEnd);
    }
    const start = previous ? commaEnd(text, previous.offset + previous.length) : list.offset + 1;
    return text.slice(0, start) + text.slice(commaEnd(text, entryEnd));
}
/** `value: undefined` removes the key (or list entry), so it takes its default. */
function applySettingsEdits(text, edits) {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    let updated = text;
    for (const edit of edits) {
        try {
            if (edit.value === undefined && typeof edit.path.at(-1) === "number") {
                updated = removeListEntry(updated, edit.path);
                continue;
            }
            const changes = modify(updated, edit.path, edit.value, {
                formattingOptions: { insertSpaces: true, tabSize: 2, eol },
            });
            updated = applyEdits(updated, changes);
        }
        catch (error) {
            throw new Error(`cannot set ${edit.path.join(".")} (${errorMessage(error)}); fix the file first`);
        }
    }
    return updated;
}
function newFileText(header = NEW_FILE_HEADER, values = {}) {
    const start = `${header.map((line) => `// ${line}`).join("\n")}\n${JSON.stringify(defaultSettings(), null, 2)}\n`;
    const edits = Object.entries(values)
        .filter(([key]) => key !== "version")
        .map(([key, value]) => ({ path: key.split("."), value }));
    return applySettingsEdits(start, edits);
}
function convertedFileText(conversion) {
    const date = new Date().toISOString().slice(0, 10);
    return newFileText([
        `OpenCode Quota server settings, converted on ${date} from:`,
        ...conversion.sources.map((source) => `  ${source}`),
        ...conversion.notes,
        "The old file was left in place; OpenCode Quota no longer reads it.",
        "All quota settings are in this file, by section.",
    ], conversion.values);
}
/**
 * Checks a patch and turns it into file edits; null resets a key or a whole group. File-only
 * keys (and groups holding one) need `allowFileOnly`.
 */
function planEdits(patch, allowFileOnly) {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
        return { edits: [], issues: [{ key: "$patch", message: "expected an object of settings" }] };
    }
    const flat = flattenSettings(PLAIN_WALKER, patch);
    const issues = [...flat.issues];
    const edits = [];
    for (const { key, value } of flat.assignments) {
        if (!allowFileOnly && isFileOnly(key)) {
            issues.push({ key, message: "file-only; edit settings.jsonc by hand or ask your agent" });
        }
        else if (value === null) {
            edits.push({ path: key.split("."), value: undefined });
        }
        else if (isSettingsGroup(key)) {
            issues.push({ key, message: "expected an object, or null to reset the whole group" });
        }
        else if (isRecordSetting(key) &&
            value &&
            typeof value === "object" &&
            !Array.isArray(value)) {
            for (const [id, item] of Object.entries(value)) {
                const checked = item === null ? { issues: [] } : checkSetting(key, { [id]: item });
                issues.push(...checked.issues);
                if (checked.issues.length === 0)
                    edits.push({ path: [...key.split("."), id], value: item === null ? undefined : item });
            }
        }
        else {
            const checked = checkSetting(key, value);
            if (checked.issues.length > 0)
                issues.push(...checked.issues);
            else
                edits.push({ path: key.split("."), value });
        }
    }
    return { edits, issues };
}
const LOCK_WAIT_MS = 2_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The text of the file a save writes; undefined while it does not exist. */
async function readTarget(target) {
    try {
        return await readFile(target.writePath, "utf8");
    }
    catch (error) {
        if (errorCode(error) === "ENOENT")
            return undefined;
        throw error;
    }
}
/**
 * Runs `work` on the file a save writes (a symlink's real target, else settings.jsonc) and its
 * text, holding the lock next to it (`withFileLock`), so saves and the conversion never
 * interleave. `work` calls the fence right before each write commits: it checks
 * that the lock is still ours and that the file still holds the text `work` got, since a hand
 * edit takes no lock. Either way the work runs again on a new read. A hand edit between that
 * check and the rename that commits is still lost: a window of microseconds. After
 * LOCK_WAIT_MS without the lock this fails as busy.
 */
async function withSettingsLock(work) {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
        const target = await resolveConfigWriteTarget(settingsPath());
        const lock = `${target.writePath}.lock`;
        const busyMessage = `the settings file is busy: another save holds ${lock}; try again`;
        const done = await withFileLock(lock, async (lockFence) => {
            // Another save created the file, or a link moved, while we waited: lock it again.
            const now = await resolveConfigWriteTarget(target.configuredPath);
            if (!configWriteTargetsEqual(target, now))
                return undefined;
            const text = await readTarget(target);
            const fence = async () => {
                await lockFence();
                if ((await readTarget(target)) !== text) {
                    throw new LockLostError(`${target.configuredPath} changed while saving; trying again`);
                }
            };
            return { value: await work(target, text, fence) };
        }, { waitMs: Math.max(0, deadline - Date.now()), busyMessage });
        if (done)
            return done.value;
        if (Date.now() > deadline)
            throw new Error(busyMessage);
        await sleep(20);
    }
}
/**
 * Edits that set only the `enabled` field of the custom providers named in `switches`, so each
 * entry keeps everything else and its comments. Nothing while the list has a problem, and
 * nothing when a provider to switch on is no longer the definition the user reviewed.
 */
function planSwitches(read, switches) {
    if (Object.keys(switches).length === 0)
        return { edits: [], issues: [] };
    const key = "providers.custom";
    if (read.issues.some((issue) => issue.key.startsWith(key))) {
        return { edits: [], issues: [{ key, message: "has a problem; fix settings.jsonc first" }] };
    }
    const definitions = read.settings.providers.custom;
    const edits = [];
    const issues = [];
    for (const [id, { enabled, fingerprint }] of Object.entries(switches)) {
        const at = definitions.findIndex((definition) => definition.id === id);
        const definition = definitions[at];
        if (!definition)
            issues.push({ key, message: "a provider to switch is not in the file" });
        else if (enabled && customProviderFingerprint(definition) !== fingerprint) {
            issues.push({ key: `${key}.${id}`, message: CHANGED_SINCE_REVIEW });
        }
        else
            edits.push({ path: ["providers", "custom", at, "enabled"], value: enabled });
    }
    return { edits, issues };
}
/**
 * Merges a patch into settings.jsonc (JSON merge patch: objects merge, null resets). One unknown
 * key or bad value and nothing is saved. Comments stay; a symlink keeps its link; the file is 0600.
 * `customEnabled` switches custom providers on or off by id; only the quota window's own switch
 * sends it (the agent tools never call this).
 */
export async function saveSettings(patch, options = {}) {
    return editWithLock((base, read) => {
        const planned = planEdits(patch, options.allowFileOnly === true);
        const switched = planSwitches(read, options.customEnabled ?? {});
        const issues = [...planned.issues, ...switched.issues];
        if (issues.length > 0)
            return { issues };
        return { text: applySettingsEdits(base, [...planned.edits, ...switched.edits]) };
    });
}
/**
 * Like `saveSettings` (without switches), with the patch built from the settings it saves over:
 * read, `edit`, check and write all hold the lock, so an edit made from the current value never
 * loses a concurrent one. `edit` returns undefined to change nothing.
 */
export async function editSettings(edit, options = {}) {
    return editWithLock((base, read) => {
        const patch = edit(structuredClone(read.settings));
        if (patch === undefined)
            return undefined;
        const planned = planEdits(patch, options.allowFileOnly === true);
        if (planned.issues.length > 0)
            return { issues: planned.issues };
        return { text: applySettingsEdits(base, planned.edits) };
    });
}
/**
 * Like `editSettings`, for a change a patch cannot make, such as one entry of a list (the other
 * entries keep their comments). `edit` gets the settings and the problems read under the lock,
 * and returns JSONC edits; file-only keys are allowed. Nothing is saved when the result has a
 * problem the file did not have.
 */
export async function editSettingsFile(edit) {
    return editWithLock((base, read) => {
        const edits = edit(structuredClone(read.settings), read.issues);
        if (edits === undefined)
            return undefined;
        const text = applySettingsEdits(base, edits);
        const known = new Set(read.issues.map((issue) => `${issue.key}\n${issue.message}`));
        const added = readSettingsText(text).issues.filter((issue) => !known.has(`${issue.key}\n${issue.message}`));
        return added.length > 0 ? { issues: added } : { text };
    });
}
async function editWithLock(plan) {
    const path = settingsPath();
    try {
        return await withSettingsLock((target, text, fence) => editLocked(target, text, fence, plan));
    }
    catch (error) {
        return failedSave(`could not save ${path}: ${errorMessage(error)}`);
    }
}
function failedSave(message) {
    return { ok: false, issues: [{ key: "$file", message }], diff: [] };
}
async function editLocked(target, original, fence, plan) {
    const path = target.configuredPath;
    // A syntax error, a version this plugin does not write, or a key set twice or with a dot (an
    // edit would change another one).
    const blocking = readSettingsText(original ?? "{}").issues.find((issue) => issue.key === "$file" ||
        issue.key === "version" ||
        issue.message === DUPLICATE_KEY ||
        issue.message.startsWith(DOTTED_KEY));
    if (blocking) {
        const where = blocking.key === "$file" ? "" : `${blocking.key}: `;
        const problem = `${where}${blocking.message.split(";")[0]}`;
        return failedSave(`${path}: ${problem}; fix it first, nothing was saved`);
    }
    // Without settings.jsonc the v5 settings are converted first; what could not be is reported.
    const { configDir } = getOpencodeRuntimeDirs();
    const conversion = original === undefined ? await planV5Conversion(configDir) : undefined;
    const base = original ?? (conversion?.sources.length ? convertedFileText(conversion) : newFileText());
    const read = readSettingsText(base);
    const planned = plan(base, read);
    if (planned === undefined)
        return { ok: true, issues: [], diff: [] };
    if ("issues" in planned)
        return { ok: false, issues: planned.issues, diff: [] };
    const updated = planned.text;
    const diff = diffSettings(read.settings, readSettingsText(updated).settings);
    const issues = (conversion?.notes ?? []).map((message) => ({ key: "$conversion", message }));
    if (updated === original)
        return { ok: true, issues, diff };
    // Link changes take no lock: write only over the file read (the fence checks its text).
    if (!configWriteTargetsEqual(target, await resolveConfigWriteTarget(path))) {
        return failedSave(`${path} changed while saving; nothing was saved, try again`);
    }
    await writeResolvedConfigText(target, updated, fence);
    await chmod(target.writePath, NEW_CONFIG_FILE_MODE);
    return { ok: true, issues, diff };
}
/**
 * Writes the v5 global settings into a missing settings.jsonc once (undefined: nothing to do).
 * While an old file does not parse (maybe mid-edit) or the folder is read-only, nothing is
 * written: the result says why, and `loadSettings` keeps converting in memory.
 */
export async function convertV5() {
    const path = settingsPath();
    if (await lstat(path).catch(() => undefined))
        return undefined;
    const { configDir } = getOpencodeRuntimeDirs();
    const conversion = await planV5Conversion(configDir);
    if (!conversion)
        return undefined;
    const malformed = "an old settings file does not parse; converted in memory until it is fixed";
    if (conversion.malformed)
        return { ...conversion, notWrittenReason: malformed };
    try {
        return await withSettingsLock(async (target, current, fence) => {
            // Another OpenCode process converted first, or the file was made while this one waited.
            if (target.terminalExisted || current !== undefined)
                return undefined;
            await writeResolvedConfigText(target, convertedFileText(conversion), fence);
            await chmod(target.writePath, NEW_CONFIG_FILE_MODE);
            return { ...conversion, written: true };
        });
    }
    catch (error) {
        return { ...conversion, notWrittenReason: `could not write ${path}: ${errorMessage(error)}` };
    }
}
const POLL_INTERVAL_MS = 2_000;
/**
 * Calls `onChange` once per change of settings.jsonc (v5 files are not watched), debounced, also
 * for an atomic replace. A folder watch reacts at once; a stat poll catches what it misses (busy
 * FSEvents, network drives, a symlink's target). Only changes after this resolves count.
 */
export async function watchSettings(onChange, options = {}) {
    const path = settingsPath();
    const debounceMs = options.debounceMs ?? 200;
    let closed = false;
    let timer;
    let lastSeen = "";
    let queue = Promise.resolve();
    // Only settings.jsonc (or its target, when a link points into this folder), never a v5 file.
    const names = new Set([basename(path), basename(await realpath(path).catch(() => path))]);
    const reload = (notify) => {
        queue = queue
            .then(async () => {
            if (closed)
                return;
            const loaded = await loadSettings({ projectDir: options.projectDir });
            const { exists, settings, issues, fromFile, conversion } = loaded;
            const seen = JSON.stringify([exists, settings, issues, fromFile, conversion]);
            if (seen === lastSeen)
                return;
            lastSeen = seen;
            if (notify && !closed)
                onChange(loaded);
        })
            .catch(() => { }); // A failed read is retried on the next change.
        return queue;
    };
    const schedule = () => {
        if (closed)
            return;
        clearTimeout(timer);
        timer = setTimeout(() => void reload(true), debounceMs);
    };
    // A poll also reports a missing file once, and an access time change; neither is an edit.
    const onStat = (now, before) => {
        if (now.mtimeMs !== before.mtimeMs || now.ino !== before.ino)
            schedule();
    };
    // In a read-only config folder, watch what exists.
    await mkdir(dirname(path), { recursive: true, mode: NEW_CONFIG_DIRECTORY_MODE }).catch(() => { });
    let folderWatch;
    try {
        folderWatch = watch(dirname(path), { persistent: false }, (_, name) => {
            if (!name || names.has(name))
                schedule();
        });
        folderWatch.on("error", () => { });
    }
    catch {
        // A missing or unreadable folder: the stat poll still sees the file appear.
    }
    watchFile(path, { interval: POLL_INTERVAL_MS, persistent: false }, onStat);
    await reload(false);
    return {
        close() {
            closed = true;
            clearTimeout(timer);
            folderWatch?.close();
            unwatchFile(path, onStat);
        },
    };
}
