/**
 * xAI SuperGrok: the shared credits meter of each OpenCode xAI sign-in. A sign-in OpenCode could
 * not return shows as its own error.
 */

import { classifyWindow } from "../core/windows.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderMatchContext,
} from "../lib/entries.js";
import { credentialRowAuthEntry, readCredentialRows } from "../lib/opencode-auth.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import type { AuthData } from "../lib/types.js";
import {
  DEFAULT_XAI_AUTH_CACHE_MAX_AGE_MS,
  hasXaiOAuthCached,
  periodKindLabel,
  queryXaiQuota,
  resolveXaiOAuth,
  type XaiWindowValue,
} from "../lib/xai.js";
import {
  failedAccount,
  fetchEachLogin,
  type ProviderFetchResult,
  type ProviderRow,
  quotaRow,
} from "./contract.js";

/** The credits row, labelled with its period ("Weekly"), with when the period started. */
function creditsRow(window: XaiWindowValue): ProviderRow {
  const period = periodKindLabel(window.kind);
  return quotaRow({
    key: "credits",
    label: period,
    window: classifyWindow(period),
    percentRemaining: window.percentRemaining,
    resetsAt: window.resetTimeIso,
    windowStartedAt: window.fixedWindow?.startedAtIso,
  });
}

export const xaiProvider: QuotaProvider = {
  id: "xai",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "xai",
      fallbackOnError: false,
    });
    return hasXaiOAuthCached({
      maxAgeMs: providerAvailable ? 0 : DEFAULT_XAI_AUTH_CACHE_MAX_AGE_MS,
    });
  },

  matchesCurrentModel(model: string, context?: QuotaProviderMatchContext): boolean {
    if (context?.currentProviderID) {
      return context.currentProviderID.trim().toLowerCase() === "xai";
    }
    return modelProviderMatchesRuntimeId(model, "xai");
  },

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const requestTimeoutMs = ctx.config?.requestTimeoutMs;
    // A failed login stays in the list so it shows as its own error.
    const logins = (await readCredentialRows(["xai"], { methods: ["oauth"] })).flatMap((row) => {
      const auth = resolveXaiOAuth({ xai: credentialRowAuthEntry(row) } as AuthData);
      return auth.state === "none" ? [] : [{ row, auth }];
    });

    if (logins.length === 0) {
      const result = await queryXaiQuota({ requestTimeoutMs });
      if (!result) return { attempted: false, accounts: [], debug: [] };
      if (!result.success) {
        return { attempted: true, accounts: [failedAccount("xAI", result.error)], debug: [] };
      }
      return {
        attempted: true,
        accounts: [{ name: result.label, rows: [creditsRow(result.window)], errors: [] }],
        debug: [],
      };
    }

    const accounts = await fetchEachLogin({
      providerName: "xAI",
      logins,
      async fetchLogin({ auth }) {
        const result = await queryXaiQuota({ requestTimeoutMs, auth });
        if (!result) return null;
        if (!result.success) return { rows: [], errors: [{ message: result.error }] };
        return {
          rows: [creditsRow(result.window)],
          errors: [],
          fallbackName: result.label,
        };
      },
    });
    return { attempted: true, accounts, debug: [] };
  },
};
