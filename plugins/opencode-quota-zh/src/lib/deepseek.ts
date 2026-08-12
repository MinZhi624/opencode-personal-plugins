/**
 * DeepSeek balance fetcher.
 *
 * Queries: GET https://api.deepseek.com/user/balance
 * Auth: Bearer token in Authorization header.
 */

import {
  type DeepSeekKeySource,
  hasDeepSeekApiKey,
  resolveDeepSeekApiKey,
} from "./deepseek-auth.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import type { QuotaError } from "./types.js";

export type DeepSeekCurrency = "CNY" | "USD";

/**
 * Tri-state availability of the DeepSeek account. A missing `is_available`
 * field stays "unknown" and must never be treated as explicit unavailability.
 */
export type DeepSeekAvailability = "available" | "unavailable" | "unknown";

export interface DeepSeekBalanceInfo {
  currency: DeepSeekCurrency;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
  /**
   * Structured numeric total balance in `currency` units for alert
   * evaluation; null when the source string was missing or malformed so a
   * broken response can never look like a zero balance.
   */
  totalBalanceAmount: number | null;
}

export interface DeepSeekBalanceResult {
  availability: DeepSeekAvailability;
  balanceInfos: DeepSeekBalanceInfo[];
}

export type DeepSeekResult =
  | {
      success: true;
      availability: DeepSeekAvailability;
      balanceInfos: DeepSeekBalanceInfo[];
    }
  | QuotaError
  | null;

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const USER_AGENT = "OpenCode-Quota-Toast/1.0";

const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: "\u00A5", // ¥
  USD: "$",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

const DEEPSEEK_DECIMAL_BALANCE_RE = /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/u;

interface NormalizedDeepSeekBalance {
  /** Display string (normalized "0.00" fallback keeps existing display behavior). */
  display: string;
  /** Structured numeric value; null when the source string was invalid. */
  amount: number | null;
}

function normalizeDeepSeekBalance(value: unknown): NormalizedDeepSeekBalance {
  const raw = getNonEmptyString(value);
  if (!raw || raw.length > 64 || !DEEPSEEK_DECIMAL_BALANCE_RE.test(raw)) {
    return { display: "0.00", amount: null };
  }
  const amount = Number(raw);
  return { display: raw, amount: Number.isFinite(amount) ? amount : null };
}

function parseDeepSeekAvailability(value: unknown): DeepSeekAvailability {
  if (typeof value === "boolean") {
    return value ? "available" : "unavailable";
  }
  return "unknown";
}

function parseDeepSeekBalance(payload: unknown): DeepSeekBalanceResult {
  if (!isRecord(payload)) {
    throw new Error("DeepSeek balance response returned an unexpected response shape");
  }

  const availability = parseDeepSeekAvailability(payload.is_available);

  const balanceInfos: DeepSeekBalanceInfo[] = [];
  const rawInfos = payload.balance_infos;

  if (Array.isArray(rawInfos)) {
    for (const info of rawInfos) {
      if (!isRecord(info)) continue;

      const currency = getNonEmptyString(info.currency);
      if (!currency || !["CNY", "USD"].includes(currency.toUpperCase())) continue;

      const totalBalance = normalizeDeepSeekBalance(info.total_balance);
      balanceInfos.push({
        currency: currency.toUpperCase() as DeepSeekCurrency,
        totalBalance: totalBalance.display,
        grantedBalance: normalizeDeepSeekBalance(info.granted_balance).display,
        toppedUpBalance: normalizeDeepSeekBalance(info.topped_up_balance).display,
        totalBalanceAmount: totalBalance.amount,
      });
    }
  }

  return { availability, balanceInfos };
}

async function fetchDeepSeekBalance(
  apiKey: string,
  requestTimeoutMs?: number,
): Promise<{ success: true; data: DeepSeekBalanceResult } | { success: false; message: string }> {
  try {
    return await fetchWithTimeout(DEEPSEEK_BALANCE_URL, {
      request: {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "User-Agent": USER_AGENT,
        },
      },
      timeoutMs: requestTimeoutMs,
      consume: async (response) => {
        if (!response.ok) {
          const text = await response.text();
          return {
            success: false as const,
            message: `DeepSeek API error ${response.status}: ${sanitizeDisplaySnippet(text, 120)}`,
          };
        }

        return {
          success: true as const,
          data: parseDeepSeekBalance(await response.json()),
        };
      },
    });
  } catch (err) {
    return {
      success: false,
      message: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
    };
  }
}

/**
 * Format a balance value with the appropriate currency symbol.
 */
export function formatDeepSeekBalanceValue(balance: {
  currency: DeepSeekCurrency;
  totalBalance: string;
}): string {
  const symbol = CURRENCY_SYMBOLS[balance.currency] ?? balance.currency;
  return `${symbol}${balance.totalBalance}`;
}

/**
 * Query DeepSeek balance from the API.
 *
 * @returns A typed result with success/error state, or null if no API key is configured.
 */
export async function queryDeepSeekBalance(
  options: { requestTimeoutMs?: number } = {},
): Promise<DeepSeekResult> {
  const resolved = await resolveDeepSeekApiKey();
  if (!resolved) return null;

  const result = await fetchDeepSeekBalance(resolved.key, options.requestTimeoutMs);

  if (!result.success) {
    return { success: false, error: result.message };
  }

  return {
    success: true,
    availability: result.data.availability,
    balanceInfos: result.data.balanceInfos,
  };
}

export {
  type DeepSeekKeySource,
  getDeepSeekKeyDiagnostics,
  hasDeepSeekApiKey as hasDeepSeekApiKeyConfigured,
} from "./deepseek-auth.js";
