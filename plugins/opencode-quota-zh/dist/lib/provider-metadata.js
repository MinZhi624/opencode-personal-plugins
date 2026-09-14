import { QUOTA_PROVIDER_REGISTRATION_SOURCE, } from "./provider-registration.js";
const PROVIDER_REGISTRATION_BY_ID = new Map(QUOTA_PROVIDER_REGISTRATION_SOURCE.map((registration) => [registration.id, registration]));
function catalogKeys() {
    return QUOTA_PROVIDER_REGISTRATION_SOURCE.map((registration) => registration.id);
}
function providerRegistration(id) {
    const registration = PROVIDER_REGISTRATION_BY_ID.get(id);
    if (!registration) {
        throw new Error(`Missing quota provider registration: ${id}`);
    }
    return registration;
}
function isCanonicalQuotaProviderId(value) {
    return PROVIDER_REGISTRATION_BY_ID.has(value);
}
function buildProviderShape(id, source) {
    const { recommendedReplacementId, authFallbacks, ...shape } = source.shape;
    let replacementId;
    if (recommendedReplacementId) {
        if (!isCanonicalQuotaProviderId(recommendedReplacementId)) {
            throw new Error(`Unknown quota provider replacement: ${recommendedReplacementId}`);
        }
        replacementId = recommendedReplacementId;
    }
    return {
        id,
        ...shape,
        ...(replacementId ? { recommendedReplacementId: replacementId } : {}),
        ...(authFallbacks ? { authFallbacks: [...authFallbacks] } : {}),
    };
}
function completeCatalogRecord(entries) {
    const record = {};
    for (const [id, value] of entries)
        record[id] = value;
    return record;
}
export const QUOTA_PROVIDER_CATALOG = completeCatalogRecord(catalogKeys().map((id) => {
    const source = providerRegistration(id);
    return [
        id,
        {
            label: source.label,
            labelAliases: [...(source.labelAliases ?? [])],
            runtimeIds: [...source.runtimeIds],
            synonyms: [...source.synonyms],
            shape: buildProviderShape(id, source),
        },
    ];
}));
export const QUOTA_PROVIDER_LABELS = Object.fromEntries(catalogKeys().flatMap((id) => {
    const entry = QUOTA_PROVIDER_CATALOG[id];
    return [[id, entry.label], ...entry.labelAliases.map((alias) => [alias, entry.label])];
}));
export const QUOTA_PROVIDER_ID_SYNONYMS = Object.fromEntries(catalogKeys().flatMap((id) => QUOTA_PROVIDER_CATALOG[id].synonyms.map((synonym) => [synonym, id])));
export const QUOTA_PROVIDER_RUNTIME_IDS = completeCatalogRecord(catalogKeys().map((id) => [id, QUOTA_PROVIDER_CATALOG[id].runtimeIds]));
export const QUOTA_PROVIDER_SHAPES = catalogKeys().map((id) => QUOTA_PROVIDER_CATALOG[id].shape);
const LIVE_LOCAL_USAGE_PROVIDER_ID_SET = new Set(catalogKeys().filter((id) => {
    const source = providerRegistration(id);
    return "liveLocalUsage" in source && source.liveLocalUsage === true;
}));
export function normalizeQuotaProviderId(id) {
    const normalized = id.trim().toLowerCase();
    return QUOTA_PROVIDER_ID_SYNONYMS[normalized] ?? normalized;
}
export function getQuotaProviderShape(id) {
    const normalized = normalizeQuotaProviderId(id);
    return isCanonicalQuotaProviderId(normalized)
        ? QUOTA_PROVIDER_CATALOG[normalized].shape
        : undefined;
}
export function getQuotaProviderDisplayLabel(id) {
    const normalized = normalizeQuotaProviderId(id);
    return QUOTA_PROVIDER_LABELS[normalized] ?? id;
}
export function getQuotaProviderRuntimeIds(id) {
    const shape = getQuotaProviderShape(id);
    if (!shape) {
        return [];
    }
    return [...new Set(QUOTA_PROVIDER_RUNTIME_IDS[shape.id])];
}
export function getQuotaProviderIdsForRuntimeId(id) {
    const normalized = id.trim().toLowerCase();
    return catalogKeys().filter((providerId) => QUOTA_PROVIDER_RUNTIME_IDS[providerId].includes(normalized));
}
export function isLiveLocalUsageProviderId(id) {
    return LIVE_LOCAL_USAGE_PROVIDER_ID_SET.has(normalizeQuotaProviderId(id));
}
