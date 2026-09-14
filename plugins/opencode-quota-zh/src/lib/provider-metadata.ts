import {
  type CanonicalQuotaProviderId,
  QUOTA_PROVIDER_REGISTRATION_SOURCE,
  type QuotaProviderAuthentication,
  type QuotaProviderAuthFallback,
  type QuotaProviderAutoSetup,
  type QuotaProviderQuotaSource,
  type QuotaProviderRegistrationSourceEntry,
} from "./provider-registration.js";

export type {
  CanonicalQuotaProviderId,
  QuotaProviderAuthentication,
  QuotaProviderAuthFallback,
  QuotaProviderAutoSetup,
  QuotaProviderQuotaSource,
} from "./provider-registration.js";

export interface QuotaProviderShape {
  id: CanonicalQuotaProviderId;
  lifecycle?: "deprecated";
  recommendedReplacementId?: CanonicalQuotaProviderId;
  autoSetup: QuotaProviderAutoSetup;
  authentication: QuotaProviderAuthentication;
  authFallbacks?: QuotaProviderAuthFallback[];
  quota: QuotaProviderQuotaSource;
  quickSetupAnchor?: string;
  notes?: string;
}

export interface QuotaProviderCatalogEntry {
  label: string;
  labelAliases: readonly string[];
  runtimeIds: readonly string[];
  synonyms: readonly string[];
  shape: QuotaProviderShape;
}

export type QuotaProviderRuntimeIds = Readonly<Record<CanonicalQuotaProviderId, readonly string[]>>;

const PROVIDER_REGISTRATION_BY_ID = new Map<
  CanonicalQuotaProviderId,
  QuotaProviderRegistrationSourceEntry
>(QUOTA_PROVIDER_REGISTRATION_SOURCE.map((registration) => [registration.id, registration]));

function catalogKeys(): CanonicalQuotaProviderId[] {
  return QUOTA_PROVIDER_REGISTRATION_SOURCE.map((registration) => registration.id);
}

function providerRegistration(id: CanonicalQuotaProviderId): QuotaProviderRegistrationSourceEntry {
  const registration = PROVIDER_REGISTRATION_BY_ID.get(id);
  if (!registration) {
    throw new Error(`Missing quota provider registration: ${id}`);
  }
  return registration;
}

function isCanonicalQuotaProviderId(value: string): value is CanonicalQuotaProviderId {
  return PROVIDER_REGISTRATION_BY_ID.has(value as CanonicalQuotaProviderId);
}

function buildProviderShape(
  id: CanonicalQuotaProviderId,
  source: QuotaProviderRegistrationSourceEntry,
): QuotaProviderShape {
  const { recommendedReplacementId, authFallbacks, ...shape } = source.shape;
  let replacementId: CanonicalQuotaProviderId | undefined;
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

function completeCatalogRecord<T>(
  entries: Array<readonly [CanonicalQuotaProviderId, T]>,
): Record<CanonicalQuotaProviderId, T> {
  const record: Partial<Record<CanonicalQuotaProviderId, T>> = {};
  for (const [id, value] of entries) record[id] = value;
  return record as Record<CanonicalQuotaProviderId, T>;
}

export const QUOTA_PROVIDER_CATALOG: Readonly<
  Record<CanonicalQuotaProviderId, QuotaProviderCatalogEntry>
> = completeCatalogRecord(
  catalogKeys().map((id) => {
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
    ] as const;
  }),
);

export const QUOTA_PROVIDER_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  catalogKeys().flatMap((id) => {
    const entry = QUOTA_PROVIDER_CATALOG[id];
    return [[id, entry.label], ...entry.labelAliases.map((alias) => [alias, entry.label])];
  }),
);

export const QUOTA_PROVIDER_ID_SYNONYMS: Readonly<Record<string, string>> = Object.fromEntries(
  catalogKeys().flatMap((id) =>
    QUOTA_PROVIDER_CATALOG[id].synonyms.map((synonym) => [synonym, id]),
  ),
);

export const QUOTA_PROVIDER_RUNTIME_IDS: QuotaProviderRuntimeIds = completeCatalogRecord(
  catalogKeys().map((id) => [id, QUOTA_PROVIDER_CATALOG[id].runtimeIds] as const),
);

export const QUOTA_PROVIDER_SHAPES: readonly QuotaProviderShape[] = catalogKeys().map(
  (id) => QUOTA_PROVIDER_CATALOG[id].shape,
);

const LIVE_LOCAL_USAGE_PROVIDER_ID_SET = new Set<string>(
  catalogKeys().filter((id) => {
    const source = providerRegistration(id);
    return "liveLocalUsage" in source && source.liveLocalUsage === true;
  }),
);

export function normalizeQuotaProviderId(id: string): string {
  const normalized = id.trim().toLowerCase();
  return QUOTA_PROVIDER_ID_SYNONYMS[normalized] ?? normalized;
}

export function getQuotaProviderShape(id: string): QuotaProviderShape | undefined {
  const normalized = normalizeQuotaProviderId(id);
  return isCanonicalQuotaProviderId(normalized)
    ? QUOTA_PROVIDER_CATALOG[normalized].shape
    : undefined;
}

export function getQuotaProviderDisplayLabel(id: string): string {
  const normalized = normalizeQuotaProviderId(id);
  return QUOTA_PROVIDER_LABELS[normalized] ?? id;
}

export function getQuotaProviderRuntimeIds(id: string): readonly string[] {
  const shape = getQuotaProviderShape(id);
  if (!shape) {
    return [];
  }

  return [...new Set(QUOTA_PROVIDER_RUNTIME_IDS[shape.id])];
}

export function getQuotaProviderIdsForRuntimeId(id: string): readonly CanonicalQuotaProviderId[] {
  const normalized = id.trim().toLowerCase();
  return catalogKeys().filter((providerId) =>
    QUOTA_PROVIDER_RUNTIME_IDS[providerId].includes(normalized),
  );
}

export function isLiveLocalUsageProviderId(id: string): boolean {
  return LIVE_LOCAL_USAGE_PROVIDER_ID_SET.has(normalizeQuotaProviderId(id));
}
