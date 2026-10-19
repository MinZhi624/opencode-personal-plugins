import { getCanonicalQuotaProviderId } from "./provider-metadata.js";
import { QUOTA_PROVIDERS_AGGREGATE_ID } from "./quota-providers.js";
const METER_NAME = "@slkiser/opencode-quota";
const CONSUMED_METRIC_NAME = "opencode.quota.consumed";
const CACHE_AGE_METRIC_NAME = "opencode.quota.cache.age";
const TELEMETRY_STATE_KEY = Symbol.for("@slkiser/opencode-quota/quota-telemetry/v2");
function defaultApiLoader() {
    return import("@opentelemetry/api");
}
function getState() {
    const globalState = globalThis;
    const existing = globalState[TELEMETRY_STATE_KEY];
    if (existing)
        return existing;
    const state = {
        owners: new WeakMap(),
        ownersById: new Map(),
        nextOwnerId: 1,
        snapshots: new Map(),
        initialization: null,
        unavailable: false,
        registered: false,
        apiLoader: defaultApiLoader,
    };
    globalState[TELEMETRY_STATE_KEY] = state;
    return state;
}
function safeProviderAttribute(providerId) {
    if (providerId === QUOTA_PROVIDERS_AGGREGATE_ID ||
        providerId.startsWith(`${QUOTA_PROVIDERS_AGGREGATE_ID}:`)) {
        return "custom";
    }
    return getCanonicalQuotaProviderId(providerId) ?? "other";
}
function observationKey(attributes) {
    return [
        attributes["quota.provider"],
        attributes["quota.window"],
        attributes["quota.result_type"],
    ].join("\u0000");
}
function snapshotKey(ownerId, identity) {
    return `${ownerId}\u0000${identity}`;
}
function removeOwnerSnapshots(state, ownerId) {
    const prefix = `${ownerId}\u0000`;
    for (const key of state.snapshots.keys()) {
        if (key.startsWith(prefix))
            state.snapshots.delete(key);
    }
}
/** Keeps the highest value seen for `key`. */
function keepHighest(observations, key, observation) {
    const existing = observations.get(key);
    if (!existing || observation.value > existing.value)
        observations.set(key, observation);
}
function inKeyOrder(observations) {
    return [...observations.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, observation]) => observation);
}
function collectConsumedObservations(state) {
    const observations = new Map();
    for (const snapshot of state.snapshots.values()) {
        for (const observation of snapshot.consumed) {
            keepHighest(observations, observationKey(observation.attributes), observation);
        }
    }
    return inKeyOrder(observations);
}
function collectCacheAgeObservations(state, now) {
    const observations = new Map();
    for (const snapshot of state.snapshots.values()) {
        if (snapshot.cacheTimestamp === undefined)
            continue;
        const provider = safeProviderAttribute(snapshot.providerId);
        const value = Math.max(0, now - snapshot.cacheTimestamp) / 1000;
        keepHighest(observations, provider, { value, attributes: { "quota.provider": provider } });
    }
    return inKeyOrder(observations);
}
function emitObservations(result, observations) {
    for (const observation of observations) {
        try {
            result.observe(observation.value, observation.attributes);
        }
        catch {
            // One host observer failure must not suppress other safe series.
        }
    }
}
function registerInstruments(state, api) {
    const meter = api.metrics.getMeter(METER_NAME);
    const consumedGauge = meter.createObservableGauge(CONSUMED_METRIC_NAME, {
        description: "Normalized quota consumed, where 1 is 100% consumed",
        unit: "1",
    });
    const cacheAgeGauge = meter.createObservableGauge(CACHE_AGE_METRIC_NAME, {
        description: "Age of the normalized cached quota observation",
        unit: "s",
    });
    const observeConsumed = (result) => {
        try {
            emitObservations(result, collectConsumedObservations(state));
        }
        catch {
            // Telemetry callbacks must never affect the host or quota collection.
        }
    };
    const observeCacheAge = (result) => {
        try {
            emitObservations(result, collectCacheAgeObservations(state, Date.now()));
        }
        catch {
            // Telemetry callbacks must never affect the host or quota collection.
        }
    };
    consumedGauge.addCallback(observeConsumed);
    try {
        cacheAgeGauge.addCallback(observeCacheAge);
    }
    catch (error) {
        consumedGauge.removeCallback?.(observeConsumed);
        throw error;
    }
    state.consumedGauge = consumedGauge;
    state.cacheAgeGauge = cacheAgeGauge;
    state.observeConsumed = observeConsumed;
    state.observeCacheAge = observeCacheAge;
    state.registered = true;
}
function initializeTelemetry(state) {
    if (state.registered || state.unavailable || state.initialization)
        return;
    state.initialization = state
        .apiLoader()
        .then((api) => registerInstruments(state, api))
        .catch(() => {
        state.unavailable = true;
    });
}
export function configureQuotaTelemetry(params) {
    try {
        const state = getState();
        let owner = state.owners.get(params.owner);
        if (!owner) {
            owner = {
                id: state.nextOwnerId,
                generation: 0,
                enabled: false,
                identity: "",
            };
            state.nextOwnerId += 1;
            state.owners.set(params.owner, owner);
            state.ownersById.set(owner.id, owner);
        }
        if (owner.enabled !== params.enabled || owner.identity !== params.identity) {
            owner.enabled = params.enabled;
            owner.identity = params.identity;
            owner.generation += 1;
            removeOwnerSnapshots(state, owner.id);
        }
        if (!owner.enabled)
            return undefined;
        initializeTelemetry(state);
        return { ownerId: owner.id, generation: owner.generation };
    }
    catch {
        // OpenTelemetry is optional and must not affect normal plugin behavior.
        return undefined;
    }
}
export function disposeQuotaTelemetryOwner(ownerKey) {
    try {
        const state = getState();
        const owner = state.owners.get(ownerKey);
        if (!owner)
            return;
        removeOwnerSnapshots(state, owner.id);
        state.owners.delete(ownerKey);
        state.ownersById.delete(owner.id);
    }
    catch {
        // Plugin disposal must remain best-effort.
    }
}
function isCurrentToken(state, token) {
    if (!token)
        return false;
    const owner = state.ownersById.get(token.ownerId);
    return Boolean(owner?.enabled && owner.generation === token.generation);
}
/**
 * Publishes the percent rows of a quota snapshot as this owner's series, replacing what the
 * owner published before. Each provider reports how old its rows are (`okAtMs`).
 */
export function publishQuotaTelemetry(token, snapshot) {
    try {
        const state = getState();
        if (!isCurrentToken(state, token))
            return;
        removeOwnerSnapshots(state, token.ownerId);
        for (const provider of snapshot.providers) {
            const consumed = new Map();
            for (const row of provider.rows) {
                if (row.percentRemaining === undefined || !Number.isFinite(row.percentRemaining))
                    continue;
                const attributes = {
                    "quota.provider": safeProviderAttribute(provider.providerId),
                    "quota.window": row.window ?? "unknown",
                    "quota.result_type": row.type,
                };
                const observation = {
                    value: Math.min(1, Math.max(0, (100 - row.percentRemaining) / 100)),
                    attributes,
                };
                keepHighest(consumed, observationKey(attributes), observation);
            }
            if (consumed.size === 0)
                continue;
            state.snapshots.set(snapshotKey(token.ownerId, provider.providerId), {
                providerId: provider.providerId,
                ...(provider.okAtMs !== undefined ? { cacheTimestamp: provider.okAtMs } : {}),
                consumed: inKeyOrder(consumed),
            });
        }
    }
    catch {
        // Snapshot publication is deliberately best-effort and synchronous.
    }
}
export async function __flushQuotaTelemetryInitializationForTests() {
    await getState().initialization;
}
export function __setQuotaTelemetryApiLoaderForTests(loader) {
    const state = getState();
    state.apiLoader = loader;
    state.initialization = null;
    state.unavailable = false;
}
export function __resetQuotaTelemetryForTests() {
    const globalState = globalThis;
    const state = globalState[TELEMETRY_STATE_KEY];
    if (state?.consumedGauge && state.observeConsumed) {
        state.consumedGauge.removeCallback?.(state.observeConsumed);
    }
    if (state?.cacheAgeGauge && state.observeCacheAge) {
        state.cacheAgeGauge.removeCallback?.(state.observeCacheAge);
    }
    delete globalState[TELEMETRY_STATE_KEY];
}
