import { readFileSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { writeJsonAtomic } from "./atomic-json.js";
import { fetchWithTimeout } from "./http.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
const SOURCE_URL = "https://models.dev/api.json";
const UNITS = "USD per 1M tokens";
const DEFAULT_MODELSDEV_PROVIDERS = ["anthropic", "google", "moonshotai", "openai", "xai", "zai"];
/** The prices read from models.dev; a saved snapshot may also carry `reasoning`. */
const API_COST_KEYS = ["input", "output", "cache_read", "cache_write"];
const SNAPSHOT_COST_KEYS = [...API_COST_KEYS, "reasoning"];
const DEFAULT_REFRESH_MIN_ATTEMPT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_REFRESH_TIMEOUT_MS = 6_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const EMPTY_SNAPSHOT = {
    _meta: { source: "none", generatedAt: 0, providers: [], units: UNITS },
    providers: {},
};
const REFRESH_RESULTS = new Set([
    "success",
    "not_modified",
    "skipped_fresh",
    "skipped_throttled",
    "failed",
]);
let LOADED = null;
let SNAPSHOT_SELECTION = "auto";
let REFRESH_IN_FLIGHT = null;
let PROCESS_REFRESH_CHECKED = false;
let CONFIGURED_MAX_AGE_MS = DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS;
/** Told whenever the price list in use really changes; see `subscribePricingSnapshotChanges`. */
const SNAPSHOT_CHANGE_LISTENERS = new Set();
/** An object or an array (an array's entries are keyed by position). */
function asRecord(value) {
    return value && typeof value === "object" ? value : null;
}
/** Sorted by key, so a saved snapshot reads and diffs in a stable order. */
function sortByKey(record) {
    return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}
/** The finite prices among `keys`; null when there are none. */
function pickCosts(raw, keys) {
    const record = asRecord(raw);
    const picked = {};
    for (const key of keys) {
        const value = record?.[key];
        if (typeof value === "number" && Number.isFinite(value))
            picked[key] = value;
    }
    return Object.keys(picked).length > 0 ? picked : null;
}
function withProviders(meta, providers) {
    const sorted = sortByKey(providers);
    return { _meta: { ...meta, providers: Object.keys(sorted) }, providers: sorted };
}
/** A snapshot of the providers with at least one priced model. */
function makeSnapshot(meta, modelsByProvider, costOf) {
    const providers = {};
    for (const [providerId, modelsRaw] of modelsByProvider) {
        const models = {};
        for (const [modelId, model] of Object.entries(asRecord(modelsRaw) ?? {})) {
            const cost = costOf(model);
            if (cost)
                models[modelId] = cost;
        }
        if (Object.keys(models).length > 0)
            providers[providerId] = sortByKey(models);
    }
    return withProviders(meta, providers);
}
/** A saved snapshot (bundled or runtime); null when it has no valid date. */
function normalizeSnapshot(raw) {
    const meta = asRecord(asRecord(raw)?._meta);
    const providers = asRecord(asRecord(raw)?.providers);
    const generatedAt = Number(meta?.generatedAt);
    if (!meta || !providers || !Number.isFinite(generatedAt) || generatedAt <= 0)
        return null;
    return makeSnapshot({
        source: typeof meta.source === "string" && meta.source ? meta.source : SOURCE_URL,
        generatedAt: Math.trunc(generatedAt),
        units: typeof meta.units === "string" && meta.units ? meta.units : UNITS,
    }, Object.entries(providers), (model) => pickCosts(model, SNAPSHOT_COST_KEYS));
}
function buildSnapshotFromApi(apiRaw, providerIDs, generatedAt) {
    const api = asRecord(apiRaw) ?? {};
    return makeSnapshot({ source: SOURCE_URL, generatedAt, units: UNITS }, providerIDs.map((providerID) => [providerID, asRecord(api[providerID])?.models]), (model) => pickCosts(asRecord(model)?.cost, API_COST_KEYS));
}
/**
 * models.dev drops retired models from its list. Keep their last known price so
 * older usage still gets a cost. `current` wins, then `previous` in the order given.
 * Callers list the user's runtime snapshot before the bundled one: its prices come
 * from the user's own last download, while the bundled file's date only says when
 * the file was rewritten, not when a kept model's price was last seen.
 */
function keepRetiredModels(current, previous, providerIDs) {
    const providers = { ...current.providers };
    for (const providerID of providerIDs) {
        const models = { ...providers[providerID] };
        for (const snapshot of previous) {
            for (const [modelID, cost] of Object.entries(snapshot?.providers[providerID] ?? {})) {
                models[modelID] ??= cost;
            }
        }
        if (Object.keys(models).length > 0)
            providers[providerID] = sortByKey(models);
    }
    return withProviders(current._meta, providers);
}
function readSnapshotFile(path) {
    try {
        return normalizeSnapshot(JSON.parse(readFileSync(path, "utf-8")));
    }
    catch {
        return null;
    }
}
function loadBundledSnapshot(override) {
    const bundled = override
        ? normalizeSnapshot(override)
        : readSnapshotFile(new URL("../data/modelsdev-pricing.min.json", import.meta.url));
    return bundled ?? EMPTY_SNAPSHOT;
}
function loadRuntimeSnapshot(runtimeDirs) {
    return readSnapshotFile(getRuntimePricingSnapshotPath(runtimeDirs));
}
/** "bundled" pins the shipped file, "runtime" prefers the downloaded one, "auto" takes the newer. */
function chooseSnapshot(selection, runtimeDirs, bundledOverride) {
    const bundled = loadBundledSnapshot(bundledOverride);
    const runtime = selection === "bundled" ? null : loadRuntimeSnapshot(runtimeDirs);
    if (runtime &&
        (selection === "runtime" || runtime._meta.generatedAt >= bundled._meta.generatedAt)) {
        // A runtime snapshot saved by an older version may lack models that models.dev stopped
        // listing; the bundled file fills them until its next refresh.
        const snapshot = keepRetiredModels(runtime, [bundled], DEFAULT_MODELSDEV_PROVIDERS);
        return { snapshot, source: "runtime" };
    }
    return { snapshot: bundled, source: bundled === EMPTY_SNAPSHOT ? "empty" : "bundled" };
}
/**
 * Deep equality of two snapshots, order-independent: the whole `_meta` (source,
 * date, units, providers) and every price bucket. The date alone would miss a
 * same-day re-price; this sees any real difference in what the prices say.
 */
function snapshotsEqual(a, b) {
    if (a === b)
        return true;
    if (a._meta.source !== b._meta.source)
        return false;
    if (a._meta.generatedAt !== b._meta.generatedAt)
        return false;
    if (a._meta.units !== b._meta.units)
        return false;
    const aProviders = a._meta.providers;
    const bProviders = b._meta.providers;
    if (aProviders.length !== bProviders.length)
        return false;
    for (const provider of aProviders) {
        if (!bProviders.includes(provider))
            return false;
    }
    const aKeys = Object.keys(a.providers);
    const bKeys = Object.keys(b.providers);
    if (aKeys.length !== bKeys.length)
        return false;
    for (const key of aKeys) {
        const aModels = a.providers[key];
        const bModels = b.providers[key];
        if (!bModels)
            return false;
        const aModelKeys = Object.keys(aModels);
        const bModelKeys = Object.keys(bModels);
        if (aModelKeys.length !== bModelKeys.length)
            return false;
        for (const modelKey of aModelKeys) {
            const aCost = aModels[modelKey];
            const bCost = bModels[modelKey];
            if (!bCost)
                return false;
            for (const costKey of SNAPSHOT_COST_KEYS) {
                if (aCost[costKey] !== bCost[costKey])
                    return false;
            }
        }
    }
    return true;
}
/** Tells two effective price lists apart by what they say, not by which object holds them. */
function loadedEqual(a, b) {
    return a.source === b.source && snapshotsEqual(a.snapshot, b.snapshot);
}
/** Announces a real change of the price list in use; the first load says nothing. */
function notifyPricingSnapshotChange(selection) {
    if (SNAPSHOT_CHANGE_LISTENERS.size === 0)
        return;
    const info = {
        generatedAt: LOADED?.snapshot._meta.generatedAt ?? 0,
        selection,
    };
    // Copied first: a listener may unsubscribe (or subscribe) while being told.
    for (const listener of [...SNAPSHOT_CHANGE_LISTENERS]) {
        try {
            listener(info);
        }
        catch {
            // A listener that fails never breaks price loading or the download.
        }
    }
}
function reloadSnapshot(selection = SNAPSHOT_SELECTION, runtimeDirs, bundledOverride) {
    const next = chooseSnapshot(selection, runtimeDirs, bundledOverride);
    const current = LOADED;
    // The same effective prices keep the very same object: a report captures the
    // snapshot object by identity, so re-assigning an equal snapshot would drop a
    // live cache and fail a report still paginating its history. Only a real
    // change takes the new object, and then listeners hear about it.
    if (current && loadedEqual(current, next))
        return current;
    LOADED = next;
    if (current)
        notifyPricingSnapshotChange(selection);
    return LOADED;
}
function loaded() {
    return LOADED ?? reloadSnapshot();
}
function pricedProviders() {
    return loaded().snapshot.providers;
}
export function getRuntimePricingSnapshotPath(runtimeDirs) {
    const { cacheDir } = runtimeDirs ?? getOpencodeRuntimeDirs();
    return join(cacheDir, "opencode-quota", "modelsdev-pricing.runtime.min.json");
}
export function getRuntimePricingRefreshStatePath(runtimeDirs) {
    const { cacheDir } = runtimeDirs ?? getOpencodeRuntimeDirs();
    return join(cacheDir, "opencode-quota", "modelsdev-pricing.refresh-state.json");
}
export function getPricingRefreshPolicy() {
    return {
        enabled: true,
        maxAgeMs: CONFIGURED_MAX_AGE_MS,
        minAttemptIntervalMs: DEFAULT_REFRESH_MIN_ATTEMPT_INTERVAL_MS,
        timeoutMs: DEFAULT_REFRESH_TIMEOUT_MS,
    };
}
/** Days after which the snapshot counts as stale; not a positive number means the default. */
export function setPricingSnapshotAutoRefresh(days) {
    CONFIGURED_MAX_AGE_MS =
        Number.isFinite(days) && days > 0
            ? Math.floor(days * MS_PER_DAY)
            : DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS;
}
function normalizeRefreshState(raw) {
    const record = asRecord(raw);
    const updatedAt = Number(record?.updatedAt);
    if (!record || Number(record.version) !== 1 || !Number.isFinite(updatedAt) || updatedAt <= 0) {
        return null;
    }
    const state = { version: 1, updatedAt: Math.trunc(updatedAt) };
    for (const key of ["lastAttemptAt", "lastSuccessAt", "lastFailureAt"]) {
        const at = Number(record[key]);
        if (Number.isFinite(at) && at > 0)
            state[key] = Math.trunc(at);
    }
    if (typeof record.lastResult === "string" && REFRESH_RESULTS.has(record.lastResult)) {
        state.lastResult = record.lastResult;
    }
    for (const key of ["lastError", "etag", "lastModified"]) {
        const text = record[key];
        if (typeof text === "string" && text)
            state[key] = text;
    }
    return state;
}
export async function readPricingRefreshState(runtimeDirs) {
    try {
        const raw = await readFile(getRuntimePricingRefreshStatePath(runtimeDirs), "utf-8");
        return normalizeRefreshState(JSON.parse(raw));
    }
    catch {
        return null;
    }
}
async function fetchModelsDev(params) {
    const headers = new Headers();
    if (params.state.etag)
        headers.set("If-None-Match", params.state.etag);
    if (params.state.lastModified)
        headers.set("If-Modified-Since", params.state.lastModified);
    return await fetchWithTimeout(SOURCE_URL, {
        request: { headers },
        timeoutMs: params.timeoutMs,
        fetchFn: params.fetchFn,
        consume: async (response) => {
            const etag = response.headers.get("etag") ?? undefined;
            const lastModified = response.headers.get("last-modified") ?? undefined;
            if (response.status === 304)
                return { kind: "not_modified", etag, lastModified };
            if (!response.ok) {
                throw new Error(`拉取 ${SOURCE_URL} 失败：${response.status} ${response.statusText}`);
            }
            return { kind: "success", api: await response.json(), etag, lastModified };
        },
    });
}
function skipped(reason, state) {
    return { attempted: false, updated: false, reason, state };
}
/**
 * Downloads new models.dev prices when the snapshot is stale: once per process (unless
 * forced), at most every few hours across processes (the refresh state file remembers the
 * last attempt), one download at a time. A failure keeps the snapshot in use.
 */
export async function maybeRefreshPricingSnapshot(opts = {}) {
    REFRESH_IN_FLIGHT ??= refreshPricingSnapshot(opts).finally(() => {
        REFRESH_IN_FLIGHT = null;
    });
    return REFRESH_IN_FLIGHT;
}
async function refreshPricingSnapshot(opts) {
    const nowMs = opts.nowMs ?? Date.now();
    const policy = getPricingRefreshPolicy();
    const force = opts.force === true;
    const { runtimeDirs, bootstrapSnapshotOverride: bundledOverride } = opts;
    const selection = opts.snapshotSelection ?? SNAPSHOT_SELECTION;
    const previousState = (await readPricingRefreshState(runtimeDirs)) ?? {
        version: 1,
        updatedAt: nowMs,
    };
    const runtimeBefore = loadRuntimeSnapshot(runtimeDirs);
    const bundled = loadBundledSnapshot(bundledOverride);
    reloadSnapshot(selection, runtimeDirs, bundledOverride);
    if (selection === "bundled" && opts.allowRefreshWhenSelectionBundled !== true) {
        return skipped("selection_bundled", { ...previousState, updatedAt: nowMs });
    }
    if (!force && PROCESS_REFRESH_CHECKED) {
        return skipped("already_checked_this_process", previousState);
    }
    PROCESS_REFRESH_CHECKED = true;
    const maxAgeMs = opts.maxAgeMs ?? policy.maxAgeMs;
    if (!force && !getPricingSnapshotHealth({ nowMs, maxAgeMs }).stale) {
        return skipped("fresh", { ...previousState, updatedAt: nowMs, lastResult: "skipped_fresh" });
    }
    const minAttemptIntervalMs = opts.minAttemptIntervalMs ?? policy.minAttemptIntervalMs;
    const lastAttemptAt = previousState.lastAttemptAt;
    if (!force && lastAttemptAt && nowMs - lastAttemptAt < minAttemptIntervalMs) {
        return skipped("throttled", {
            ...previousState,
            updatedAt: nowMs,
            lastResult: "skipped_throttled",
        });
    }
    const attempting = {
        ...previousState,
        version: 1,
        updatedAt: nowMs,
        lastAttemptAt: nowMs,
    };
    const providerIDs = opts.providerAllowlist ?? DEFAULT_MODELSDEV_PROVIDERS;
    let next;
    try {
        const timeoutMs = opts.timeoutMs ?? policy.timeoutMs;
        const fetched = await fetchModelsDev({ timeoutMs, state: attempting, fetchFn: opts.fetchFn });
        let snapshot;
        if (fetched.kind === "not_modified") {
            // The same prices, confirmed now; also heals snapshots saved before retired models were kept.
            const base = runtimeBefore ?? loaded().snapshot;
            const confirmed = { _meta: { ...base._meta, generatedAt: nowMs }, providers: base.providers };
            snapshot = keepRetiredModels(confirmed, [bundled], providerIDs);
        }
        else {
            const fresh = buildSnapshotFromApi(fetched.api, providerIDs, nowMs);
            if (Object.keys(fresh.providers).length === 0) {
                throw new Error("models.dev 价格快照为空，拒绝保存");
            }
            snapshot = keepRetiredModels(fresh, [runtimeBefore, bundled], providerIDs);
        }
        await writeJsonAtomic(getRuntimePricingSnapshotPath(runtimeDirs), snapshot, {
            trailingNewline: true,
        });
        reloadSnapshot(selection, runtimeDirs, bundledOverride);
        next = {
            ...attempting,
            lastSuccessAt: nowMs,
            lastResult: fetched.kind,
            lastError: undefined,
            etag: fetched.etag ?? attempting.etag,
            lastModified: fetched.lastModified ?? attempting.lastModified,
        };
    }
    catch (error) {
        const lastError = error instanceof Error ? error.message : String(error);
        next = { ...attempting, lastFailureAt: nowMs, lastResult: "failed", lastError };
    }
    // Best effort: the snapshot in use and the result stay right without the state file.
    await writeJsonAtomic(getRuntimePricingRefreshStatePath(runtimeDirs), next, {
        trailingNewline: true,
    }).catch(() => { });
    return next.lastResult === "failed"
        ? { attempted: true, updated: false, error: next.lastError, state: next }
        : { attempted: true, updated: true, state: next };
}
export function setPricingSnapshotSelection(selection) {
    if (SNAPSHOT_SELECTION === selection)
        return;
    SNAPSHOT_SELECTION = selection;
    // Reload under the new selection instead of dropping the loaded snapshot: the
    // reload keeps the same object while the effective prices stay the same, and
    // the selection itself is a real change (every report labels it), so listeners
    // hear about it even when the price content is identical. With nothing loaded
    // yet the reload only performs the first load, which announces nothing.
    const previous = LOADED;
    const next = reloadSnapshot(selection);
    if (previous && next === previous)
        notifyPricingSnapshotChange(selection);
}
export function getPricingSnapshotSelection() {
    return SNAPSHOT_SELECTION;
}
/**
 * Hear about real changes of the price list in use: a new snapshot object (fresh
 * prices), another source or another selection. The first load of the process
 * announces nothing, so a caller that subscribes before it learns about the
 * first real change only. The returned function stops the subscription, and a
 * listener that throws never breaks price loading or the download.
 */
export function subscribePricingSnapshotChanges(listener) {
    SNAPSHOT_CHANGE_LISTENERS.add(listener);
    let stopped = false;
    return () => {
        if (stopped)
            return;
        stopped = true;
        SNAPSHOT_CHANGE_LISTENERS.delete(listener);
    };
}
export function getPricingSnapshotMeta() {
    return loaded().snapshot._meta;
}
export function getPricingSnapshotSource() {
    return loaded().source;
}
/**
 * The price list in use, exactly as the v6 report reads it: the same `loaded`
 * selection and retired-model merge, with no second cache, no download and no
 * credentials. `source` keeps an empty price list distinguishable from a real
 * one, so a caller never mistakes missing prices for zero prices.
 */
export function getPricingSnapshotForClients() {
    return {
        snapshot: loaded().snapshot,
        source: getPricingSnapshotSource(),
        selection: getPricingSnapshotSelection(),
    };
}
export function getPricingSnapshotHealth(opts) {
    const generatedAt = getPricingSnapshotMeta().generatedAt;
    const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS;
    const ageMs = Math.max(0, (opts?.nowMs ?? Date.now()) - generatedAt);
    return { generatedAt, ageMs, maxAgeMs, stale: ageMs > maxAgeMs };
}
export function hasProvider(providerId) {
    return !!pricedProviders()[providerId];
}
export function hasModel(providerId, modelId) {
    return !!pricedProviders()[providerId]?.[modelId];
}
export function listProviders() {
    return Object.keys(pricedProviders());
}
export function listModelsForProvider(providerId) {
    return Object.keys(pricedProviders()[providerId] ?? {});
}
export function listProvidersForModelId(modelId) {
    const providers = pricedProviders();
    return Object.keys(providers)
        .filter((providerId) => Object.hasOwn(providers[providerId] ?? {}, modelId))
        .sort((a, b) => a.localeCompare(b));
}
let BUNDLED_IDS = null;
/** The provider and model ids of the price list shipped in this package, never a downloaded one. */
function bundledIds() {
    if (!BUNDLED_IDS) {
        const { providers } = loadBundledSnapshot();
        BUNDLED_IDS = {
            providers: new Set(Object.keys(providers)),
            models: new Set(Object.values(providers).flatMap((models) => Object.keys(models))),
        };
    }
    return BUNDLED_IDS;
}
/** True when the shipped price list has this provider id. */
export function isBundledPricingProviderId(providerId) {
    return bundledIds().providers.has(providerId);
}
/** True when the shipped price list has this model id under any provider. */
export function isBundledPricingModelId(modelId) {
    return bundledIds().models.has(modelId);
}
export function lookupCost(providerId, modelId) {
    return pricedProviders()[providerId]?.[modelId] ?? null;
}
export function hasCost(providerId, modelId) {
    return lookupCost(providerId, modelId) != null;
}
export function __resetPricingSnapshotForTests() {
    LOADED = null;
    SNAPSHOT_SELECTION = "auto";
    CONFIGURED_MAX_AGE_MS = DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS;
    REFRESH_IN_FLIGHT = null;
    PROCESS_REFRESH_CHECKED = false;
}
