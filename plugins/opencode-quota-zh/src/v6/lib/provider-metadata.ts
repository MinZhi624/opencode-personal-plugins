import {
  type CanonicalQuotaProviderId,
  QUOTA_PROVIDER_REGISTRATION_SOURCE,
  type QuotaProviderRegistrationSourceEntry,
} from "./provider-registration.js";

export type { CanonicalQuotaProviderId } from "./provider-registration.js";

interface QuotaProviderCatalogEntry {
  label: string;
  labelAliases: readonly string[];
  runtimeIds: readonly string[];
  synonyms: readonly string[];
}

const REGISTRATIONS: readonly QuotaProviderRegistrationSourceEntry[] =
  QUOTA_PROVIDER_REGISTRATION_SOURCE;
const CANONICAL_IDS = new Set(REGISTRATIONS.map(({ id }) => id));

function isCanonicalQuotaProviderId(value: string): value is CanonicalQuotaProviderId {
  return CANONICAL_IDS.has(value);
}

function catalogEntry(source: QuotaProviderRegistrationSourceEntry): QuotaProviderCatalogEntry {
  return {
    label: source.label,
    labelAliases: [...(source.labelAliases ?? [])],
    runtimeIds: [...source.runtimeIds],
    synonyms: [...source.synonyms],
  };
}

/** Every provider in registration order. */
export const QUOTA_PROVIDER_CATALOG = Object.fromEntries(
  REGISTRATIONS.map((source) => [source.id, catalogEntry(source)]),
) as Readonly<Record<CanonicalQuotaProviderId, QuotaProviderCatalogEntry>>;

const CATALOG = Object.entries(QUOTA_PROVIDER_CATALOG) as Array<
  [CanonicalQuotaProviderId, QuotaProviderCatalogEntry]
>;

export const QUOTA_PROVIDER_RUNTIME_IDS = Object.fromEntries(
  CATALOG.map(([id, entry]) => [id, entry.runtimeIds]),
) as Readonly<Record<CanonicalQuotaProviderId, readonly string[]>>;

/**
 * The v6 row keys each provider may emit (`${providerId}.${key}` is the row id that hide,
 * rename and order settings use). `*` stands for one segment taken from provider data, such
 * as a model, a window family or a currency. Changing a key breaks users' settings.
 */
export const PROVIDER_ROW_KEYS: Readonly<Record<CanonicalQuotaProviderId, readonly string[]>> = {
  anthropic: ["five_hour", "weekly", "weekly_fable", "extra_usage"],
  copilot: ["allowance", "additional_budget"],
  // `status`: an OpenAI login without a ChatGPT plan ("unavailable for API key").
  openai: ["five_hour", "weekly", "monthly", "code_review", "status"],
  openrouter: ["key"],
  kilo: ["pass_credits", "balance"],
  cursor: ["api", "auto_composer"],
  "alibaba-coding-plan": ["five_hour", "weekly", "monthly"],
  "alibaba-token-plan": ["five_hour", "weekly"],
  synthetic: ["five_hour", "weekly"],
  chutes: ["daily"],
  "google-gemini-cli": ["pro", "flash", "flash_lite", "model.*"],
  "google-agy": [
    "gemini.weekly",
    "gemini.five_hour",
    "claude_gpt.weekly",
    "claude_gpt.five_hour",
    "*.weekly",
    "*.five_hour",
  ],
  zai: ["five_hour", "weekly", "mcp"],
  zhipu: ["five_hour", "weekly", "mcp"],
  nanogpt: ["daily", "monthly", "balance.usd", "balance.nano"],
  "minimax-coding-plan": ["five_hour", "weekly"],
  "minimax-china-coding-plan": ["five_hour", "weekly"],
  "kimi-code-plan-global": ["weekly", "limit.*"],
  "kimi-code-plan-cn": ["weekly", "limit.*"],
  deepseek: ["total_balance.*", "granted_balance.*", "topped_up_balance.*", "available"],
  xai: ["credits"],
  xiaomi: ["monthly_tokens", "total_balance", "cash_balance", "gift_balance"],
  "opencode-go": ["five_hour", "weekly", "monthly"],
  opencode: ["monthly", "balance", "auto_reload"],
  "ollama-cloud": ["session", "weekly", "monthly", "purchased"],
  "quota-providers": ["custom.*.*"],
};

/** Labels by provider id and by label alias. */
const LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  CATALOG.flatMap(([id, entry]) => [id, ...entry.labelAliases].map((name) => [name, entry.label])),
);

const SYNONYMS: Readonly<Record<string, string>> = Object.fromEntries(
  CATALOG.flatMap(([id, entry]) => entry.synonyms.map((synonym) => [synonym, id])),
);

const LIVE_LOCAL_USAGE_IDS = new Set(
  REGISTRATIONS.filter((s) => s.liveLocalUsage).map((s) => s.id),
);

/** Trimmed, lowercase, and a synonym ("claude") turned into its provider id ("anthropic"). */
export function normalizeQuotaProviderId(id: string): string {
  const normalized = id.trim().toLowerCase();
  return SYNONYMS[normalized] ?? normalized;
}

/** The provider id for an id or synonym ("claude" → "anthropic"); none for an unknown id. */
export function getCanonicalQuotaProviderId(id: string): CanonicalQuotaProviderId | undefined {
  const normalized = normalizeQuotaProviderId(id);
  return isCanonicalQuotaProviderId(normalized) ? normalized : undefined;
}

/** The provider's label; an unknown id is shown as given. */
export function getQuotaProviderDisplayLabel(id: string): string {
  return LABELS[normalizeQuotaProviderId(id)] ?? id;
}

/** The OpenCode provider ids that count as this provider (narrower than its synonyms). */
export function getQuotaProviderRuntimeIds(id: string): readonly string[] {
  const providerId = getCanonicalQuotaProviderId(id);
  return providerId ? [...new Set(QUOTA_PROVIDER_RUNTIME_IDS[providerId])] : [];
}

export function getQuotaProviderIdsForRuntimeId(id: string): readonly CanonicalQuotaProviderId[] {
  const normalized = id.trim().toLowerCase();
  return CATALOG.filter(([, entry]) => entry.runtimeIds.includes(normalized)).map(([id]) => id);
}

export function isLiveLocalUsageProviderId(id: string): boolean {
  return LIVE_LOCAL_USAGE_IDS.has(normalizeQuotaProviderId(id));
}
