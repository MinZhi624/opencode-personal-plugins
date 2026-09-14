/**
 * DeepSeek balance fetcher.
 *
 * Queries: GET https://api.deepseek.com/user/balance
 * Auth: Bearer token in Authorization header.
 */

import { isCanonicalAccountingDecimal } from "./accounting-format.js";
import { resolveDeepSeekApiKey } from "./deepseek-auth.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import type { QuotaError } from "./types.js";

export type DeepSeekCurrency = "CNY" | "USD";
export type DeepSeekBalanceField = "total_balance" | "granted_balance" | "topped_up_balance";

export interface DeepSeekBalanceInfo {
  currency: DeepSeekCurrency;
  totalBalance?: string;
  grantedBalance?: string;
  toppedUpBalance?: string;
}

export interface DeepSeekBalanceParseIssue {
  currency: DeepSeekCurrency;
  field: DeepSeekBalanceField;
}

export interface DeepSeekBalanceResult {
  isAvailable: boolean | undefined;
  balanceInfos: DeepSeekBalanceInfo[];
  parseIssues: DeepSeekBalanceParseIssue[];
}

export type DeepSeekResult =
  | {
      success: true;
      isAvailable: boolean | undefined;
      balanceInfos: DeepSeekBalanceInfo[];
      parseIssues: DeepSeekBalanceParseIssue[];
    }
  | QuotaError
  | null;

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const USER_AGENT = "OpenCode-Quota-Toast/1.0";
const MAX_PARSE_ISSUES = 6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseDeepSeekBalanceDecimal(value: unknown): string | undefined {
  return typeof value === "string" && isCanonicalAccountingDecimal(value) ? value : undefined;
}

function parseDeepSeekBalance(payload: unknown): DeepSeekBalanceResult {
  if (!isRecord(payload)) {
    throw new Error("DeepSeek balance response returned an unexpected response shape");
  }

  const isAvailable = typeof payload.is_available === "boolean" ? payload.is_available : undefined;
  const balanceInfos: DeepSeekBalanceInfo[] = [];
  const parseIssues: DeepSeekBalanceParseIssue[] = [];
  const rawInfos = payload.balance_infos;

  if (Array.isArray(rawInfos)) {
    for (const info of rawInfos) {
      if (!isRecord(info)) continue;

      const rawCurrency = getNonEmptyString(info.currency);
      if (!rawCurrency || !["CNY", "USD"].includes(rawCurrency.toUpperCase())) continue;
      const currency = rawCurrency.toUpperCase() as DeepSeekCurrency;
      const parsed: DeepSeekBalanceInfo = { currency };
      const fields = [
        ["total_balance", "totalBalance"],
        ["granted_balance", "grantedBalance"],
        ["topped_up_balance", "toppedUpBalance"],
      ] as const;

      for (const [sourceField, targetField] of fields) {
        const rawValue = info[sourceField];
        const decimal = parseDeepSeekBalanceDecimal(rawValue);
        if (decimal !== undefined) {
          parsed[targetField] = decimal;
        } else if (rawValue !== undefined && parseIssues.length < MAX_PARSE_ISSUES) {
          parseIssues.push({ currency, field: sourceField });
        }
      }

      if (
        parsed.totalBalance !== undefined ||
        parsed.grantedBalance !== undefined ||
        parsed.toppedUpBalance !== undefined
      ) {
        balanceInfos.push(parsed);
      }
    }
  }

  return { isAvailable, balanceInfos, parseIssues };
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
    isAvailable: result.data.isAvailable,
    balanceInfos: result.data.balanceInfos,
    parseIssues: result.data.parseIssues,
  };
}

export {
  type DeepSeekKeySource,
  getDeepSeekKeyDiagnostics,
  hasDeepSeekApiKey as hasDeepSeekApiKeyConfigured,
} from "./deepseek-auth.js";
