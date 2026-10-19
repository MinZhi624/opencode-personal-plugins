/** All Settings tabs edit the server's settings.jsonc through the quota RPC. */
import { createSignal } from "solid-js";
import { isRecord } from "../lib/json-guards.js";
import { CHANGED_SINCE_REVIEW, clientSettings, defaultSettings, isRecordSetting, } from "../settings/schema.js";
/** The ids switched off; every other provider is checked when found. */
export const PROVIDERS_KEY = "providers.off";
export function foundProviderIds(snapshot) {
    return (snapshot?.providers ?? []).map(({ providerId }) => providerId === "quota-providers" ? "custom" : providerId);
}
export function isTicked(off, id) {
    return !off.includes(id);
}
export function withTick(off, id, on) {
    return on ? off.filter((other) => other !== id) : [...new Set([...off, id])];
}
/** Changes by dotted key as the JSON merge patch `saveSettings` takes. */
export function settingsPatch(changes) {
    const patch = {};
    for (const [key, value] of Object.entries(changes)) {
        const parts = key.split(".");
        let group = patch;
        for (const part of parts.slice(0, -1)) {
            group[part] ??= {};
            group = group[part];
        }
        group[parts[parts.length - 1]] = value;
    }
    return patch;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** One entry of `record` set to `value`, or removed when `value` is the saved one. */
function changed(record, key, value, saved) {
    const next = { ...record };
    if (same(value, saved))
        delete next[key];
    else
        next[key] = value;
    return next;
}
/** The saved server settings, and this window's changes and custom provider switches on top. */
export function createServerSettings(rpc) {
    const [saved, setSaved] = createSignal();
    const [changes, setChanges] = createSignal({});
    const [switches, setSwitches] = createSignal({});
    /** Custom providers the server would not switch on: their definition changed since shown. */
    const [changedIds, setChangedIds] = createSignal([]);
    const defaults = clientSettings(defaultSettings()).values;
    /** The definition shown when each custom switch was changed, kept across live updates. */
    const reviewedFingerprints = new Map();
    let received = 0;
    let reads = 0;
    let saving;
    let savingEdits;
    let savingSwitches;
    const savedValue = (key) => saved()?.values[key] ?? defaults[key];
    const savedCustom = (id) => saved()?.custom.find((entry) => entry.id === id);
    const value = (key) => {
        const patch = changes()[key];
        if (!Object.hasOwn(changes(), key))
            return savedValue(key);
        if (isRecordSetting(key) && isRecord(patch)) {
            const next = { ...savedValue(key) };
            for (const [id, item] of Object.entries(patch)) {
                if (item === null)
                    delete next[id];
                else
                    next[id] = item;
            }
            return next;
        }
        return patch === null ? defaults[key] : patch;
    };
    const draftValue = (key, next) => {
        if (!isRecordSetting(key) || !isRecord(next))
            return next === undefined ? null : next;
        const before = savedValue(key);
        return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(next)])]
            .filter((id) => !same(before[id], next[id]))
            .map((id) => [id, next[id] ?? null]));
    };
    const customOn = (id) => switches()[id] ?? savedCustom(id)?.enabled ?? false;
    const dirty = () => Object.keys(changes()).length + Object.keys(switches()).length > 0;
    async function readSaved() {
        const read = ++reads;
        const at = received;
        const next = await rpc.settings();
        if (read === reads && at === received)
            setSaved(next);
    }
    async function saveDraft() {
        const sentChanges = changes();
        const sentSwitches = switches();
        const customEnabled = Object.fromEntries(Object.entries(sentSwitches).map(([id, enabled]) => [
            id,
            {
                enabled,
                fingerprint: reviewedFingerprints.get(id) ?? savedCustom(id)?.fingerprint ?? "",
            },
        ]));
        savingEdits = new Map();
        savingSwitches = new Map();
        try {
            const result = await rpc.saveSettings({
                patch: settingsPatch(sentChanges),
                ...(Object.keys(customEnabled).length > 0 ? { customEnabled } : {}),
            });
            const changedSince = result.issues
                .filter((issue) => issue.message === CHANGED_SINCE_REVIEW)
                .map((issue) => issue.key.slice("providers.custom.".length));
            if (changedSince.length > 0) {
                await readSaved();
                setChangedIds(changedSince);
                for (const id of changedSince)
                    reviewedFingerprints.delete(id);
                setSwitches((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !changedSince.includes(id))));
            }
            if (!result.ok) {
                throw new Error(result.issues.map((issue) => `${issue.key}: ${issue.message}`).join("; "));
            }
            await readSaved();
            // Only edits made after Save started remain drafts, over the latest saved settings.
            const remaining = {};
            for (const [key, patch] of savingEdits) {
                if (isRecordSetting(key) && isRecord(patch)) {
                    const before = savedValue(key);
                    const entries = Object.entries(patch).filter(([id, item]) => !same(item === null ? undefined : item, before[id]));
                    if (entries.length > 0)
                        remaining[key] = Object.fromEntries(entries);
                }
                else if (!same(patch === null ? defaults[key] : patch, savedValue(key))) {
                    remaining[key] = patch;
                }
            }
            setChanges(remaining);
            setSwitches(Object.fromEntries([...savingSwitches].filter(([id, on]) => on !== (savedCustom(id)?.enabled ?? false))));
        }
        finally {
            savingEdits = undefined;
            savingSwitches = undefined;
        }
    }
    return {
        /** Undefined until the first server answer. */
        saved,
        receive(next) {
            received += 1;
            setSaved(next);
        },
        value,
        set(key, next) {
            if (savingEdits) {
                if (isRecordSetting(key) && isRecord(next)) {
                    const before = value(key);
                    const edits = Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(next)])]
                        .filter((id) => !same(before[id], next[id]))
                        .map((id) => [id, next[id] ?? null]));
                    savingEdits.set(key, { ...savingEdits.get(key), ...edits });
                }
                else {
                    savingEdits.set(key, next === undefined ? null : next);
                }
            }
            const patch = draftValue(key, next);
            const unchanged = same(next, savedValue(key)) ||
                (isRecordSetting(key) && isRecord(patch) && Object.keys(patch).length === 0);
            setChanges((current) => {
                const result = { ...current };
                if (unchanged)
                    delete result[key];
                else
                    result[key] = patch;
                return result;
            });
        },
        customOn,
        switchCustom(id, on) {
            reviewedFingerprints.set(id, savedCustom(id)?.fingerprint ?? "");
            savingSwitches?.set(id, on);
            setChangedIds((current) => current.filter((other) => other !== id));
            setSwitches((current) => changed(current, id, on, savedCustom(id)?.enabled));
        },
        changedSinceReview: (id) => changedIds().includes(id),
        dirty,
        /** The words this window changed, for the surfaces to show while you edit. */
        draftWords() {
            return Object.fromEntries(Object.entries(changes())
                .filter(([key]) => key.startsWith("words."))
                .map(([key, value]) => [
                key.slice("words.".length),
                value === null ? defaults[key] : value,
            ]));
        },
        async load() {
            await readSaved();
        },
        /**
         * Saves one setting straight away, apart from the window's draft (the Plugin tab's
         * switches), then reads the saved settings again. The error says why the server refused it.
         */
        async saveNow(key, next) {
            const result = await rpc.saveSettings({ patch: settingsPatch({ [key]: next }) });
            if (!result.ok) {
                throw new Error(result.issues.map((issue) => `${issue.key}: ${issue.message}`).join("; "));
            }
            await readSaved();
        },
        /**
         * Sends the changes and switches in one save; nothing is saved when the server refuses any
         * of them, and the error says why. A switch-on carries the fingerprint of the definition
         * shown: one that changed since is reloaded and marked, not switched on. A change made while
         * it saves (one back to the old value too) stays unsaved.
         */
        save() {
            if (saving)
                return saving;
            if (!dirty())
                return Promise.resolve();
            saving = saveDraft().finally(() => {
                saving = undefined;
            });
            return saving;
        },
        discard() {
            reviewedFingerprints.clear();
            savingEdits?.clear();
            savingSwitches?.clear();
            setChanges({});
            setSwitches({});
            setChangedIds([]);
        },
    };
}
