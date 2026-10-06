/**
 * OpenAI (ChatGPT) quota fetcher
 *
 * Uses OpenCode's auth.json native OpenCode OAuth entries and queries:
 * https://chatgpt.com/backend-api/wham/usage
 */

import { sanitizeCredentialErrorText } from "./display-sanitize.js";
import {
  HOST_CREDENTIAL_FAILURE_REASON,
  type HostOAuthCredentialResolution,
  isHostOAuthCredentialFailure,
} from "./entries.js";
import type {
  FixedWindowProjectionEvidence,
  QuotaProviderContext,
} from "./entries.js";
import { clampPercent } from "./format-utils.js";
import { fetchWithTimeout } from "./http.js";
import { readAuthFileCached } from "./opencode-auth.js";
import { deriveResolvedAuthIdentity, type ResolvedAuthIdentity } from "./resolved-auth-identity.js";
import type { AuthData, OpenAIOAuthData, QuotaError } from "./types.js";

interface OpenAIUsageResponse {
  plan_type: string;
  rate_limit: {
    limit_reached: boolean;
    primary_window?: unknown;
    secondary_window?: unknown;
  } | null;
  code_review_rate_limit?: {
    primary_window?: unknown;
  } | null;
  spend_control?: {
    individual_limit?: unknown;
  } | null;
  credits?: {
    has_credits: boolean;
    unlimited: boolean;
    balance: string | null;
  } | null;
}

interface JwtPayload {
  "https://api.openai.com/profile"?: {
    email?: string;
  };
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
  /**
   * OAuth scope claim. Issuers encode it either as a space-delimited string
   * or as an array of scope strings; both forms are accepted downstream.
   */
  scope?: string | string[];
}

function base64UrlDecode(input: string): string {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (base64.length % 4)) % 4;
  const padded = base64 + "=".repeat(padLen);
  return Buffer.from(padded, "base64").toString("utf8");
}

function parseJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(base64UrlDecode(parts[1])) as JwtPayload;
  } catch {
    return null;
  }
}

export function getEmailFromJwt(token: string): string | null {
  return parseJwt(token)?.["https://api.openai.com/profile"]?.email ?? null;
}

export function getAccountIdFromJwt(token: string): string | null {
  return parseJwt(token)?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? null;
}

/**
 * Scope marker of ChatGPT subscription-sharing tokens (the "Sign in with
 * ChatGPT" connection). Such tokens only authorize model calls; the usage
 * endpoint rejects them with 401 with or without an account header.
 */
const MODEL_ONLY_TOKEN_SCOPE = "chatgpt.tokens.use.direct";

function tokenScopes(token: string): string[] | null {
  const scope = parseJwt(token)?.scope;
  if (typeof scope === "string") {
    const scopes = scope.split(/[\s,]+/).filter(Boolean);
    return scopes.length > 0 ? scopes : null;
  }
  if (Array.isArray(scope)) {
    return scope.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  }
  return null;
}

/**
 * True when the access token can only call models and cannot read usage.
 *
 * Only an explicit subscription-sharing scope marks a token as model-only.
 * A token without any scope declaration stays eligible: the Codex CLI login
 * token carries no scope and is currently the only credential that can read
 * usage, so "no scope" must never be treated as "no capability".
 */
export function isModelOnlyOpenAIToken(accessToken: string): boolean {
  const scopes = tokenScopes(accessToken);
  if (!scopes) return false;
  return scopes.includes(MODEL_ONLY_TOKEN_SCOPE);
}

/** True when a locally known token expiry is already in the past. */
export function isOpenAITokenLocallyExpired(
  expiresAt: number | undefined,
  nowMs: number = Date.now(),
): boolean {
  return typeof expiresAt === "number" && expiresAt < nowMs;
}

type OpenAIWindowKind = "hourly" | "weekly" | "monthly";

type OpenAIWindowValue = {
  percentRemaining: number;
  resetTimeIso?: string;
  fixedWindow?: FixedWindowProjectionEvidence;
};

const WINDOW_KIND_BY_DURATION: Readonly<Record<number, OpenAIWindowKind>> = {
  18000: "hourly",
  604800: "weekly",
  2628000: "monthly",
};

function isoFromMilliseconds(milliseconds: number): string | undefined {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return undefined;

  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function resetIsoFromNowSeconds(seconds: unknown, observedAtMs: number): string | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return isoFromMilliseconds(observedAtMs + Math.round(seconds * 1000));
}

function resetIsoFromResetAt(resetAt: unknown): string | undefined {
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt) || resetAt <= 0) {
    return undefined;
  }
  return isoFromMilliseconds(Math.round(resetAt * 1000));
}

function parseWindowValue(window: unknown, observedAtMs: number): OpenAIWindowValue | null {
  if (!window || typeof window !== "object") return null;

  const value = window as Record<string, unknown>;
  if (typeof value.used_percent !== "number" || !Number.isFinite(value.used_percent)) {
    return null;
  }

  return {
    percentRemaining: clampPercent(100 - value.used_percent),
    resetTimeIso:
      resetIsoFromResetAt(value.reset_at) ??
      resetIsoFromNowSeconds(value.reset_after_seconds, observedAtMs),
  };
}

function parseRemainingWindowValue(
  window: unknown,
  observedAtMs: number,
): OpenAIWindowValue | null {
  if (!window || typeof window !== "object") return null;

  const value = window as Record<string, unknown>;
  if (typeof value.remaining_percent !== "number" || !Number.isFinite(value.remaining_percent)) {
    return null;
  }

  return {
    percentRemaining: clampPercent(value.remaining_percent),
    resetTimeIso:
      resetIsoFromResetAt(value.reset_at) ??
      resetIsoFromNowSeconds(value.reset_after_seconds, observedAtMs),
  };
}

function parseRateLimitWindow(
  window: unknown,
  observedAtMs: number,
): { kind: OpenAIWindowKind; value: OpenAIWindowValue } | null {
  if (!window || typeof window !== "object") return null;

  const raw = window as Record<string, unknown>;
  if (typeof raw.limit_window_seconds !== "number" || !Number.isFinite(raw.limit_window_seconds)) {
    return null;
  }

  const kind = WINDOW_KIND_BY_DURATION[raw.limit_window_seconds];
  if (!kind) return null;

  const value = parseWindowValue(window, observedAtMs);
  if (!value) return null;

  const endsAtMs = value.resetTimeIso ? Date.parse(value.resetTimeIso) : Number.NaN;
  const startedAtMs = endsAtMs - raw.limit_window_seconds * 1000;
  if (Number.isFinite(startedAtMs) && startedAtMs < observedAtMs && observedAtMs < endsAtMs) {
    value.fixedWindow = {
      kind: "fixed_window",
      startedAtIso: new Date(startedAtMs).toISOString(),
      observedAtIso: new Date(observedAtMs).toISOString(),
      endsAtIso: new Date(endsAtMs).toISOString(),
      fullReset: true,
    };
  }
  return { kind, value };
}

function derivePlanLabel(planType: string | undefined): string {
  const normalized = (planType ?? "").trim().toLowerCase();
  if (normalized === "team" || normalized === "business") return "OpenAI (Business)";
  if (normalized.includes("pro")) return "OpenAI (Pro)";
  if (normalized.includes("plus")) return "OpenAI (Plus)";
  if (planType) return `OpenAI (${planType})`;
  return "OpenAI";
}

const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS = 5_000;
export const OPENAI_AUTH_SOURCE_KEYS = ["openai", "codex", "chatgpt", "opencode"] as const;

export type OpenAIAuthSourceKey = (typeof OPENAI_AUTH_SOURCE_KEYS)[number];

/** Host-managed connection resolved through the OpenCode V2 integration API. */
export const OPENAI_INTEGRATION_SOURCE_KEY = "opencode-integration";

/** Codex CLI login file (`~/.codex/auth.json`). */
export const OPENAI_CODEX_AUTH_SOURCE_KEY = "codex-auth-json";

/** Where a resolved OpenAI credential came from. */
export type ResolvedOpenAIAuthSource =
  | OpenAIAuthSourceKey
  | typeof OPENAI_INTEGRATION_SOURCE_KEY
  | typeof OPENAI_CODEX_AUTH_SOURCE_KEY;

export type OpenAIResult =
  | {
      success: true;
      label: string;
      email?: string;
      windows: {
        hourly?: OpenAIWindowValue;
        weekly?: OpenAIWindowValue;
        monthly?: OpenAIWindowValue;
        codeReview?: OpenAIWindowValue;
      };
      credits?: {
        hasCredits: boolean;
        unlimited: boolean;
        balance: string | null;
      };
    }
  | (QuotaError & { status?: number })
  | null;

/** Credential for a single quota query attempt. */
export interface OpenAIQuotaCredential {
  access: string;
  refresh?: string;
  expires?: number;
  /** Account id sent as `ChatGPT-Account-Id`; falls back to the token claim. */
  accountId?: string;
  /** Display email; falls back to the token claim. */
  email?: string;
  /**
   * Reject locally when `expires` is in the past. Only set for credentials
   * this plugin cannot refresh (legacy auth.json entries): the host and the
   * Codex CLI both own token refresh, so their expiry is not authoritative.
   */
  rejectOnLocalExpiry?: boolean;
}

export type ResolvedOpenAIOAuth =
  | { state: "none" }
  | { state: "failed"; reason: string }
  | {
      state: "configured";
      sourceKey: ResolvedOpenAIAuthSource;
      accessToken: string;
      refreshToken?: string;
      expiresAt?: number;
      email?: string;
      accountId?: string;
    };

/**
 * Resolve the active OpenAI OAuth credential from the host (OpenCode V2
 * integration connection). The host owns token refresh, so the returned
 * credential is authoritative and must not be rejected on local expiry alone.
 *
 * A lookup failure is reported as `{ state: "failed" }` with one sanitized
 * line, never as `{ state: "none" }`: "no connection" and "the connection
 * could not be read" are different problems, and only the first one is
 * something the user can fix by logging in.
 */
export async function resolveOpenAIHostCredential(
  integration: QuotaProviderContext["client"]["integration"],
): Promise<ResolvedOpenAIOAuth> {
  if (!integration?.resolveOAuthCredential) return { state: "none" };

  let failure: string | undefined;
  for (const integrationID of ["openai", "chatgpt", "codex"]) {
    let resolved: HostOAuthCredentialResolution | null = null;
    try {
      resolved = await integration.resolveOAuthCredential(integrationID);
    } catch (error) {
      // Defensive: the integration contract reports a failed lookup as a value,
      // but a host error must still surface instead of ending the query.
      resolved = {
        failed: true,
        reason: sanitizeCredentialErrorText(
          error instanceof Error ? error.message : String(error),
        ),
      };
    }

    if (!resolved) continue;

    if (isHostOAuthCredentialFailure(resolved)) {
      failure ??= resolved.reason || HOST_CREDENTIAL_FAILURE_REASON;
      continue;
    }

    if (!resolved.access) continue;

    return {
      state: "configured",
      sourceKey: "opencode-integration",
      accessToken: resolved.access,
      refreshToken: resolved.refresh,
      expiresAt: resolved.expiresAt,
      email: getEmailFromJwt(resolved.access) ?? undefined,
      accountId: getAccountIdFromJwt(resolved.access) ?? undefined,
    };
  }

  return failure === undefined ? { state: "none" } : { state: "failed", reason: failure };
}

function getOpenAIOAuthEntry(
  auth: AuthData | null | undefined,
): { sourceKey: OpenAIAuthSourceKey; entry: OpenAIOAuthData; accessToken: string } | null {
  for (const sourceKey of OPENAI_AUTH_SOURCE_KEYS) {
    const entry = auth?.[sourceKey];
    if (!entry || entry.type !== "oauth") {
      continue;
    }

    const accessToken = typeof entry.access === "string" ? entry.access.trim() : "";
    if (accessToken) {
      return { sourceKey, entry, accessToken };
    }
  }

  return null;
}

export function resolveOpenAIOAuth(auth: AuthData | null | undefined): ResolvedOpenAIOAuth {
  const resolved = getOpenAIOAuthEntry(auth);
  if (!resolved) {
    return { state: "none" };
  }

  const email = getEmailFromJwt(resolved.accessToken) ?? undefined;
  const accountId =
    getAccountIdFromJwt(resolved.accessToken) ?? resolved.entry.accountId ?? undefined;

  return {
    state: "configured",
    sourceKey: resolved.sourceKey,
    accessToken: resolved.accessToken,
    refreshToken:
      typeof resolved.entry.refresh === "string" && resolved.entry.refresh.trim()
        ? resolved.entry.refresh
        : undefined,
    expiresAt: typeof resolved.entry.expires === "number" ? resolved.entry.expires : undefined,
    email,
    accountId,
  };
}

export function hasOpenAIOAuth(auth: AuthData | null | undefined): boolean {
  return resolveOpenAIOAuth(auth).state === "configured";
}

export async function resolveOpenAIAuthIdentity(params?: {
  maxAgeMs?: number;
  auth?: ResolvedOpenAIOAuth | null;
}): Promise<ResolvedAuthIdentity | null> {
  const resolved =
    params?.auth !== undefined
      ? params.auth
      : resolveOpenAIOAuth(
          await readAuthFileCached({
            maxAgeMs: Math.max(0, params?.maxAgeMs ?? DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS),
          }),
        );
  if (!resolved || resolved.state !== "configured") return null;

  if (resolved.accountId) {
    return deriveResolvedAuthIdentity({
      providerId: "openai",
      principal: { kind: "stable-id", value: resolved.accountId },
    });
  }
  const credential = resolved.refreshToken ?? resolved.accessToken;
  return deriveResolvedAuthIdentity({
    providerId: "openai",
    principal: { kind: "credential", value: credential },
  });
}

export async function hasOpenAIOAuthCached(params?: { maxAgeMs?: number }): Promise<boolean> {
  const auth = await readAuthFileCached({
    maxAgeMs: Math.max(0, params?.maxAgeMs ?? DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS),
  });
  return hasOpenAIOAuth(auth);
}

export async function queryOpenAIQuota(
  options: {
    requestTimeoutMs?: number;
    credential?: OpenAIQuotaCredential;
  } = {},
): Promise<OpenAIResult> {
  const credential = options.credential;
  let accessToken: string;
  let email: string | undefined;
  let accountId: string | undefined;
  let expiresAt: number | undefined;
  // Legacy auth.json credentials are rejected locally on expiry: the plugin
  // cannot refresh them. A caller-supplied credential comes from the host
  // (OpenCode V2) or the Codex CLI, which both own token refresh, so its
  // expiry is not authoritative here unless the caller opts in.
  let rejectOnLocalExpiry = true;

  if (credential) {
    accessToken = credential.access;
    email = credential.email ?? getEmailFromJwt(credential.access) ?? undefined;
    accountId = credential.accountId ?? getAccountIdFromJwt(credential.access) ?? undefined;
    expiresAt = credential.expires;
    rejectOnLocalExpiry = credential.rejectOnLocalExpiry === true;
  } else {
    const resolved = resolveOpenAIOAuth(
      await readAuthFileCached({ maxAgeMs: DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS }),
    );
    if (resolved.state !== "configured") return null;
    accessToken = resolved.accessToken;
    email = resolved.email;
    accountId = resolved.accountId;
    expiresAt = resolved.expiresAt;
  }

  if (rejectOnLocalExpiry && isOpenAITokenLocallyExpired(expiresAt)) {
    return { success: false, error: "登录令牌已过期" };
  }

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "OpenCode-Quota-Toast/1.0",
    };

    if (accountId) {
      headers["ChatGPT-Account-Id"] = accountId;
    }

    return await fetchWithTimeout(OPENAI_USAGE_URL, {
      request: { headers },
      timeoutMs: options.requestTimeoutMs,
      consume: async (resp) => {
        if (!resp.ok) {
          const reason = await readHttpErrorReason(resp);
          return {
            success: false,
            error: reason
              ? `OpenAI API error ${resp.status}: ${reason}`
              : `OpenAI API error ${resp.status}`,
            status: resp.status,
          };
        }

        const data = (await resp.json()) as OpenAIUsageResponse;
        const observedAtMs = Date.now();
        const primary = parseRateLimitWindow(data.rate_limit?.primary_window, observedAtMs);
        const secondary = parseRateLimitWindow(data.rate_limit?.secondary_window, observedAtMs);
        const individualLimit = parseRemainingWindowValue(
          data.spend_control?.individual_limit,
          observedAtMs,
        );
        const codeReview = parseWindowValue(
          data.code_review_rate_limit?.primary_window,
          observedAtMs,
        );
        const credits = data.credits ?? null;
        const windows: {
          hourly?: OpenAIWindowValue;
          weekly?: OpenAIWindowValue;
          monthly?: OpenAIWindowValue;
          codeReview?: OpenAIWindowValue;
        } = {};

        const conflictingKinds = new Set<OpenAIWindowKind>();
        for (const parsed of [primary, secondary]) {
          if (!parsed || conflictingKinds.has(parsed.kind)) continue;

          const existing = windows[parsed.kind];
          if (!existing) {
            windows[parsed.kind] = parsed.value;
          } else if (
            existing.percentRemaining !== parsed.value.percentRemaining ||
            existing.resetTimeIso !== parsed.value.resetTimeIso
          ) {
            delete windows[parsed.kind];
            conflictingKinds.add(parsed.kind);
          }
        }
        if (!windows.monthly && individualLimit) windows.monthly = individualLimit;
        if (codeReview) windows.codeReview = codeReview;

        if (Object.keys(windows).length === 0) {
          return { success: false, error: "接口未返回额度数据" };
        }

        return {
          success: true,
          label: derivePlanLabel(data.plan_type),
          email,
          windows,
          credits: credits
            ? {
                hasCredits: Boolean(credits.has_credits),
                unlimited: Boolean(credits.unlimited),
                balance: credits.balance ?? null,
              }
            : undefined,
        };
      },
    });
  } catch (err) {
    return {
      success: false,
      error: sanitizeCredentialErrorText(err instanceof Error ? err.message : String(err)),
    };
  }
}

/**
 * Short, sanitized reason from a non-2xx usage-endpoint response. Provider
 * error bodies can name the rejection cause; they can also echo request
 * data, so the text is redacted and capped before it reaches any surface.
 */
async function readHttpErrorReason(resp: Response): Promise<string> {
  try {
    const raw = (await resp.text()).slice(0, 1024);
    if (!raw.trim()) return "";

    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of ["detail", "message", "error"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) {
          return sanitizeCredentialErrorText(value, 60);
        }
      }
    }

    return sanitizeCredentialErrorText(raw, 60);
  } catch {
    return "";
  }
}
