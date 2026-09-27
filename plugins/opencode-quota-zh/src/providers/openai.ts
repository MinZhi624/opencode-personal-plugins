/**
 * OpenAI (Plus/Pro) provider wrapper.
 */

import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import {
  DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS,
  hasOpenAIOAuthCached,
  queryOpenAIQuota,
  resolveOpenAIOAuth,
  resolveOpenAIHostCredential,
} from "../lib/openai.js";
import { readAuthFileCached } from "../lib/opencode-auth.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import {
  attemptedResult,
  groupedPercentWindowEntries,
  mapNullableProviderResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

export const openaiProvider: QuotaProvider = {
  id: "openai",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    // Best-effort: if provider lookup errors, preserve current permissive fallback.
    const availableByProviderId = await isCanonicalProviderAvailable({
      ctx,
      providerId: "openai",
      fallbackOnError: true,
    });

    if (availableByProviderId) {
      return true;
    }

    if (await resolveOpenAIHostCredential(ctx.client.integration)) {
      return true;
    }

    return hasOpenAIOAuthCached({ maxAgeMs: DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS });
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["openai", "chatgpt", "codex"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    // OpenCode V2 stores credentials in the host database and owns token
    // refresh; prefer that connection and fall back to legacy auth.json only
    // when no host credential is available.
    const hostAuth = await resolveOpenAIHostCredential(ctx.client.integration);
    const auth = hostAuth ?? resolveOpenAIOAuth(await readAuthFileCached({ maxAgeMs: 5_000 }));
    const result = await queryOpenAIQuota({
      requestTimeoutMs: ctx.config?.requestTimeoutMs,
      ...(hostAuth
        ? {
            credential: {
              access: hostAuth.accessToken,
              ...(hostAuth.refreshToken ? { refresh: hostAuth.refreshToken } : {}),
              ...(hostAuth.expiresAt ? { expires: hostAuth.expiresAt } : {}),
            },
          }
        : {}),
    });
    const providerResult = mapNullableProviderResult(result, {
      errorLabel: "OpenAI",
      onSuccess: (result) =>
        attemptedResult(
          groupedPercentWindowEntries({
            group: result.label,
            accounting: {
              resultType: "rate_limit",
              acquisitionMethod: "remote_api",
              ownership: "maintained",
              authority: "provider_reported",
            },
            windows: [
              { window: result.windows.hourly, suffix: "5h", label: "5h:" },
              { window: result.windows.weekly, suffix: "Weekly", label: "Weekly:" },
              { window: result.windows.monthly, suffix: "Monthly", label: "Monthly:" },
              { window: result.windows.codeReview, suffix: "Code Review", label: "Code Review:" },
            ],
          }),
          [],
          {
            singleWindowDisplayName: result.label,
          },
        ),
    });
    const configured = auth.state === "configured";
    const expiresAt = configured ? auth.expiresAt : undefined;
    return withStatusDetails(
      providerResult,
      statusDetailsFromRecord({
        auth_configured: configured ? "true" : "false",
        auth_source: configured ? auth.sourceKey : "(none)",
        token_status: !configured
          ? "(none)"
          : hostAuth
            ? "host_managed"
            : expiresAt && expiresAt < Date.now()
              ? "expired"
              : "valid",
        token_expires_at: expiresAt ? new Date(expiresAt).toISOString() : "(none)",
      }),
    );
  },
};
