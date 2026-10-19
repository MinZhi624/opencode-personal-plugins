import { readGlobalProviderConfigString } from "./api-key-resolver.js";
import type {
  GoogleCompanionConfiguredCredentials,
  GoogleCompanionResolver,
} from "./google-companion-credentials.js";
import {
  getCachedAccessToken,
  makeAccountCacheKey,
  setCachedAccessToken,
} from "./google-token-cache.js";
import { fetchWithTimeout } from "./http.js";
import { nonEmptyString } from "./json-guards.js";
import { mapWithConcurrency } from "./map-with-concurrency.js";
import { readAuthFileCached } from "./opencode-auth.js";
import {
  composeResolvedAuthIdentities,
  deriveResolvedAuthIdentity,
  type ResolvedAuthIdentity,
} from "./resolved-auth-identity.js";
import type {
  AuthData,
  GeminiCliAuthSourceKey,
  GoogleAccountError,
  GoogleAgyAuthSourceKey,
  QuotaError,
} from "./types.js";

/**
 * The OAuth quota flow shared by Google AGY (Antigravity) and Gemini CLI:
 * OpenCode logins → accounts → access tokens → one quota request per account.
 * Each flavor brings its auth keys, endpoint, and response parsing.
 */

const AUTH_CACHE_MAX_AGE_MS = 5_000;
const TOKEN_REFRESH_URL = "https://oauth2.googleapis.com/token";
const TOKEN_TIMEOUT_MS = 8_000;
const TOKEN_EXPIRY_SKEW_MS = 2 * 60_000;
const QUOTA_TIMEOUT_MS = 6_000;
const ACCOUNTS_CONCURRENCY = 3;

export type GoogleAuthSourceKey = GoogleAgyAuthSourceKey | GeminiCliAuthSourceKey;

export type GoogleAccount<Key extends GoogleAuthSourceKey> = {
  sourceKey: Key;
  refreshToken: string;
  projectId: string;
  email?: string;
  accessToken?: string;
  expiresAt?: number;
};

export type GoogleAuthPresence<Key extends GoogleAuthSourceKey> =
  | { state: "missing"; sourceKey?: undefined; accountCount: 0; validAccountCount: 0 }
  | { state: "present"; sourceKey: Key; accountCount: number; validAccountCount: number }
  | {
      state: "invalid";
      sourceKey?: Key;
      accountCount: number;
      validAccountCount: number;
      error: string;
    };

export type GoogleQuotaResult<Bucket> =
  | { success: true; buckets: Bucket[]; errors?: GoogleAccountError[] }
  | QuotaError
  | null;

/** The logins and companion plugin of one flavor. */
type GoogleAuthFlavor<Key extends GoogleAuthSourceKey> = {
  providerId: "google-agy" | "google-gemini-cli";
  /** Name in messages, e.g. "Gemini CLI quota API error: 500". */
  name: "Google AGY" | "Gemini CLI";
  authKeys: readonly Key[];
  projectIdEnvVar: string;
  /** OpenCode config provider whose `projectId` setting applies. */
  projectIdConfigProvider: string;
  /** Gemini CLI keeps a login OpenCode could not return "present", so its error row shows. */
  failedLoginCountsAsPresent: boolean;
  companion: GoogleCompanionResolver;
};

export type GoogleQuotaFlavor<
  Key extends GoogleAuthSourceKey,
  Response,
  Bucket,
> = GoogleAuthFlavor<Key> & {
  /** Query error when the companion plugin is missing; defaults to the companion's message. */
  missingCompanionError?: string;
  quotaUrl: string;
  quotaHeaders: () => Record<string, string>;
  /** Buckets of one account's quota response; throwing marks the account as failed. */
  toBuckets: (response: Response, account: GoogleAccount<Key>, accountIndex: number) => Bucket[];
};

type AccessTokenResult = { accessToken: string } | { error: string };

function readGoogleAuth(flavor: { authKeys: readonly string[] }): Promise<AuthData | null> {
  return readAuthFileCached({ maxAgeMs: AUTH_CACHE_MAX_AGE_MS, integrationIds: flavor.authKeys });
}

export async function resolveGoogleConfiguredProjectId(flavor: {
  projectIdEnvVar: string;
  projectIdConfigProvider: string;
}): Promise<string | undefined> {
  return (
    nonEmptyString(process.env[flavor.projectIdEnvVar]) ??
    (await readGlobalProviderConfigString(flavor.projectIdConfigProvider, "projectId")) ??
    nonEmptyString(process.env.GOOGLE_CLOUD_PROJECT) ??
    nonEmptyString(process.env.GOOGLE_CLOUD_PROJECT_ID)
  );
}

/**
 * One account per usable OAuth login, in auth-key order. The refresh value may
 * be packed as `refreshToken|projectId|managedProjectId`. Logins that share a
 * refresh token and project are one account.
 */
export function resolveGoogleAccounts<Key extends GoogleAuthSourceKey>(
  flavor: { authKeys: readonly Key[] },
  auth: AuthData | null | undefined,
  configuredProjectId?: string,
): GoogleAccount<Key>[] {
  if (!auth) return [];

  const accounts: GoogleAccount<Key>[] = [];
  const seen = new Set<string>();
  for (const sourceKey of flavor.authKeys) {
    const entry = auth[sourceKey];
    // A login OpenCode could not return carries no usable token.
    if (entry?.type !== "oauth" || entry.resolveError !== undefined) continue;

    const [packedToken = "", packedProjectId, packedManagedProjectId] = (entry.refresh ?? "").split(
      "|",
    );
    const refreshToken = packedToken.trim();
    const projectId =
      nonEmptyString(entry.managedProjectId) ??
      nonEmptyString(entry.quotaProjectId) ??
      nonEmptyString(packedManagedProjectId) ??
      nonEmptyString(entry.projectId) ??
      nonEmptyString(entry.projectID) ??
      nonEmptyString(packedProjectId) ??
      nonEmptyString(configuredProjectId);
    if (!refreshToken || !projectId) continue;

    const key = `${refreshToken}\n${projectId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const email =
      nonEmptyString(entry.email) ??
      nonEmptyString(entry.accountEmail) ??
      nonEmptyString(entry.login);
    const accessToken = nonEmptyString(entry.access);
    accounts.push({
      sourceKey,
      refreshToken,
      projectId,
      ...(email ? { email } : {}),
      ...(accessToken ? { accessToken } : {}),
      ...(typeof entry.expires === "number" ? { expiresAt: entry.expires } : {}),
    });
  }
  return accounts;
}

export async function inspectGoogleAuthPresence<Key extends GoogleAuthSourceKey>(
  flavor: GoogleAuthFlavor<Key>,
): Promise<GoogleAuthPresence<Key>> {
  const [auth, configuredProjectId] = await Promise.all([
    readGoogleAuth(flavor),
    resolveGoogleConfiguredProjectId(flavor),
  ]);
  const oauthKeys = flavor.authKeys.filter((key) => auth?.[key]?.type === "oauth");
  if (oauthKeys.length === 0) {
    return { state: "missing", accountCount: 0, validAccountCount: 0 };
  }

  const accounts = resolveGoogleAccounts(flavor, auth, configuredProjectId);
  const failedLoginKey = flavor.failedLoginCountsAsPresent
    ? oauthKeys.find((key) => auth?.[key]?.resolveError !== undefined)
    : undefined;
  const presentSourceKey = accounts[0]?.sourceKey ?? failedLoginKey;
  if (!presentSourceKey) {
    return {
      state: "invalid",
      sourceKey: oauthKeys[0],
      accountCount: oauthKeys.length,
      validAccountCount: 0,
      error: `${flavor.name} OAuth auth is missing a refresh token or project id`,
    };
  }
  return {
    state: "present",
    sourceKey: presentSourceKey,
    accountCount: oauthKeys.length,
    validAccountCount: accounts.length,
  };
}

export async function hasGoogleQuotaRuntimeAvailable<Key extends GoogleAuthSourceKey>(
  flavor: GoogleAuthFlavor<Key>,
): Promise<boolean> {
  const [auth, companion] = await Promise.all([
    inspectGoogleAuthPresence(flavor),
    flavor.companion.inspect(),
  ]);
  return auth.state === "present" && companion.state === "present";
}

export async function resolveGoogleAuthIdentity<Key extends GoogleAuthSourceKey>(
  flavor: GoogleAuthFlavor<Key>,
): Promise<ResolvedAuthIdentity | null> {
  const [auth, configuredProjectId, credentials] = await Promise.all([
    readGoogleAuth(flavor),
    resolveGoogleConfiguredProjectId(flavor),
    flavor.companion.resolveCredentials(),
  ]);
  const accounts = resolveGoogleAccounts(flavor, auth, configuredProjectId);
  if (accounts.length === 0 || credentials.state !== "configured") return null;

  const identities = await Promise.all([
    ...accounts.map((account) =>
      deriveResolvedAuthIdentity({
        providerId: flavor.providerId,
        principal: { kind: "credential", value: account.refreshToken },
        qualifiers: [account.projectId],
      }),
    ),
    deriveResolvedAuthIdentity({
      providerId: `${flavor.providerId}:companion`,
      principal: { kind: "credential", value: credentials.clientSecret },
      qualifiers: [credentials.clientId],
    }),
  ]);
  if (identities.some((identity) => identity === null)) return null;

  return composeResolvedAuthIdentities({
    providerId: flavor.providerId,
    identities: identities as ResolvedAuthIdentity[],
  });
}

async function refreshAccessToken(
  refreshToken: string,
  credentials: GoogleCompanionConfiguredCredentials,
  timeoutMs: number | undefined,
): Promise<{ accessToken: string; expiresIn: number } | { error: string }> {
  try {
    return await fetchWithTimeout(TOKEN_REFRESH_URL, {
      request: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      },
      timeoutMs: timeoutMs ?? TOKEN_TIMEOUT_MS,
      consume: async (response, timeoutSignal) => {
        if (!response.ok) {
          try {
            const errorData = (await response.json()) as {
              error?: string;
              error_description?: string;
            };
            if (errorData.error === "invalid_grant") return { error: "Token 已被吊销" };
            return { error: errorData.error_description || `HTTP ${response.status}` };
          } catch (error) {
            if (timeoutSignal.aborted) throw error;
            return { error: `HTTP ${response.status}` };
          }
        }

        const data = (await response.json()) as { access_token: string; expires_in: number };
        return { accessToken: data.access_token, expiresIn: data.expires_in };
      },
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("timeout")) {
      return { error: "Token 刷新超时" };
    }
    return { error: "Token 刷新失败" };
  }
}

/** The process cache first, then the login's own unexpired token, then a refresh. */
async function getAccessToken(params: {
  account: GoogleAccount<GoogleAuthSourceKey>;
  credentials: GoogleCompanionConfiguredCredentials;
  timeoutMs: number | undefined;
  force: boolean;
}): Promise<AccessTokenResult> {
  const { account } = params;
  const key = makeAccountCacheKey({
    refreshToken: account.refreshToken,
    projectId: account.projectId,
  });

  if (!params.force) {
    const cached = await getCachedAccessToken({ key, skewMs: TOKEN_EXPIRY_SKEW_MS });
    if (cached) return { accessToken: cached.accessToken };
    if (
      account.accessToken &&
      typeof account.expiresAt === "number" &&
      account.expiresAt > Date.now() + TOKEN_EXPIRY_SKEW_MS
    ) {
      return { accessToken: account.accessToken };
    }
  }

  const refreshed = await refreshAccessToken(
    account.refreshToken,
    params.credentials,
    params.timeoutMs,
  );
  if ("error" in refreshed) return refreshed;

  await setCachedAccessToken({
    key,
    entry: {
      accessToken: refreshed.accessToken,
      expiresAt: Date.now() + Math.max(1, refreshed.expiresIn) * 1000,
    },
  });
  return { accessToken: refreshed.accessToken };
}

async function retrieveQuota<Response>(
  flavor: { name: string; quotaUrl: string; quotaHeaders: () => Record<string, string> },
  accessToken: string,
  projectId: string,
  timeoutMs: number | undefined,
): Promise<Response> {
  return await fetchWithTimeout(flavor.quotaUrl, {
    request: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        ...flavor.quotaHeaders(),
      },
      body: JSON.stringify({ project: projectId }),
    },
    timeoutMs: timeoutMs ?? QUOTA_TIMEOUT_MS,
    consume: async (response) => {
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error(`${flavor.name} quota auth error: ${response.status}`);
        }
        throw new Error(`${flavor.name} quota API error: ${response.status}`);
      }
      return (await response.json()) as Response;
    },
  });
}

/** Retries once with a fresh token when the quota API rejects the token. */
async function fetchAccountBuckets<Key extends GoogleAuthSourceKey, Response, Bucket>(params: {
  flavor: GoogleQuotaFlavor<Key, Response, Bucket>;
  account: GoogleAccount<Key>;
  accountIndex: number;
  credentials: GoogleCompanionConfiguredCredentials;
  timeoutMs: number | undefined;
}): Promise<{ buckets: Bucket[] } | { error: string }> {
  const { flavor, account, credentials, timeoutMs } = params;
  try {
    const token = await getAccessToken({ account, credentials, timeoutMs, force: false });
    if ("error" in token) return token;

    let response: Response;
    try {
      response = await retrieveQuota<Response>(
        flavor,
        token.accessToken,
        account.projectId,
        timeoutMs,
      );
    } catch (err) {
      if (!(err instanceof Error && err.message.includes("auth error"))) throw err;
      const retryToken = await getAccessToken({ account, credentials, timeoutMs, force: true });
      if ("error" in retryToken) return retryToken;
      response = await retrieveQuota<Response>(
        flavor,
        retryToken.accessToken,
        account.projectId,
        timeoutMs,
      );
    }

    return { buckets: flavor.toBuckets(response, account, params.accountIndex) };
  } catch (err) {
    if (err instanceof Error && err.message.includes("timeout")) return { error: "API timeout" };
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function queryGoogleQuota<Key extends GoogleAuthSourceKey, Response, Bucket>(
  flavor: GoogleQuotaFlavor<Key, Response, Bucket>,
  options: { requestTimeoutMs?: number; authData?: AuthData },
): Promise<GoogleQuotaResult<Bucket>> {
  const [auth, configuredProjectId] = await Promise.all([
    options.authData ?? readGoogleAuth(flavor),
    resolveGoogleConfiguredProjectId(flavor),
  ]);
  const accounts = resolveGoogleAccounts(flavor, auth, configuredProjectId);
  if (accounts.length === 0) return null;

  const credentials = await flavor.companion.resolveCredentials();
  if (credentials.state !== "configured") {
    const error =
      credentials.state === "missing"
        ? (flavor.missingCompanionError ?? credentials.error)
        : credentials.error;
    return { success: false, error };
  }

  const results = await mapWithConcurrency(
    accounts,
    ACCOUNTS_CONCURRENCY,
    async (account, accountIndex) => ({
      account,
      result: await fetchAccountBuckets({
        flavor,
        account,
        accountIndex,
        credentials,
        timeoutMs: options.requestTimeoutMs,
      }),
    }),
  );

  const buckets: Bucket[] = [];
  const errors: GoogleAccountError[] = [];
  for (const { account, result } of results) {
    if ("buckets" in result) {
      buckets.push(...result.buckets);
    } else if (result.error) {
      errors.push({ email: account.email || account.sourceKey, error: result.error });
    }
  }

  if (buckets.length === 0 && errors.length === 0) {
    return { success: false, error: `No ${flavor.name} quota data available` };
  }
  return { success: true, buckets, errors: errors.length > 0 ? errors : undefined };
}
