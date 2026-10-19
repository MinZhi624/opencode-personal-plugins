/**
 * DeepSeek balance fetcher.
 *
 * Queries: GET https://api.deepseek.com/user/balance
 * Auth: Bearer token in Authorization header.
 */

import { isCanonicalAccountingDecimal } from "./accounting-format.js";
import { API_KEY_VENDORS, resolveApiKey } from "./api-key-resolver.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import { isRecord, nonEmptyString } from "./json-guards.js";
import type { QuotaError } from "./types.js";

type DeepSeekCurrency = "CNY" | "USD";

interface DeepSeekBalanceInfo {
  currency: DeepSeekCurrency;
  totalBalance?: string;
  grantedBalance?: string;
  toppedUpBalance?: string;
}

interface DeepSeekBalanceParseIssue {
  currency: DeepSeekCurrency;
  field: "total_balance" | "granted_balance" | "topped_up_balance";
}

interface DeepSeekBalance {
  isAvailable: boolean | undefined;
  balanceInfos: DeepSeekBalanceInfo[];
  parseIssues: DeepSeekBalanceParseIssue[];
}

type DeepSeekResult = ({ success: true } & DeepSeekBalance) | QuotaError | null;

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const USER_AGENT = "OpenCode-Quota-Toast/1.0";
const MAX_PARSE_ISSUES = 6;

const BALANCE_FIELDS = [
  ["total_balance", "totalBalance"],
  ["granted_balance", "grantedBalance"],
  ["topped_up_balance", "toppedUpBalance"],
] as const;

function parseDeepSeekBalance(payload: unknown): DeepSeekBalance {
  if (!isRecord(payload)) {
    throw new Error("DeepSeek 余额响应结构异常");
  }

  const isAvailable = typeof payload.is_available === "boolean" ? payload.is_available : undefined;
  const balanceInfos: DeepSeekBalanceInfo[] = [];
  const parseIssues: DeepSeekBalanceParseIssue[] = [];
  const rawInfos = payload.balance_infos;

  if (Array.isArray(rawInfos)) {
    for (const info of rawInfos) {
      if (!isRecord(info)) continue;

      const rawCurrency = nonEmptyString(info.currency);
      if (!rawCurrency || !["CNY", "USD"].includes(rawCurrency.toUpperCase())) continue;
      const currency = rawCurrency.toUpperCase() as DeepSeekCurrency;
      const parsed: DeepSeekBalanceInfo = { currency };
      let hasBalance = false;
      for (const [sourceField, targetField] of BALANCE_FIELDS) {
        const rawValue = info[sourceField];
        if (typeof rawValue === "string" && isCanonicalAccountingDecimal(rawValue)) {
          parsed[targetField] = rawValue;
          hasBalance = true;
        } else if (rawValue !== undefined && parseIssues.length < MAX_PARSE_ISSUES) {
          parseIssues.push({ currency, field: sourceField });
        }
      }
      if (hasBalance) balanceInfos.push(parsed);
    }
  }

  return { isAvailable, balanceInfos, parseIssues };
}

/** The DeepSeek balance, or null when no API key is configured. */
export async function queryDeepSeekBalance(
  options: { requestTimeoutMs?: number } = {},
): Promise<DeepSeekResult> {
  const resolved = await resolveApiKey(API_KEY_VENDORS.deepseek);
  if (!resolved) return null;

  try {
    return await fetchWithTimeout(DEEPSEEK_BALANCE_URL, {
      request: {
        method: "GET",
        headers: {
          Authorization: `Bearer ${resolved.key}`,
          "User-Agent": USER_AGENT,
        },
      },
      timeoutMs: options.requestTimeoutMs,
      consume: async (response): Promise<DeepSeekResult> => {
        if (!response.ok) {
          const text = await response.text();
          return {
            success: false,
            error: `DeepSeek API error ${response.status}: ${sanitizeDisplaySnippet(text, 120)}`,
          };
        }

        return { success: true, ...parseDeepSeekBalance(await response.json()) };
      },
    });
  } catch (err) {
    return {
      success: false,
      error: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
    };
  }
}
