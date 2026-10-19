import { sanitizeSingleLineDisplaySnippet } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import { isRecord } from "./json-guards.js";

const MIMO_ORIGIN = "https://platform.xiaomimimo.com";
const MIMO_REQUEST_TIMEOUT_MS = 10_000;
const MIMO_RESPONSE_MAX_BYTES = 256 * 1024;
const MIMO_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

interface MimoMonthlyQuota {
  used: number;
  limit: number;
}

export interface MimoPlanDetail {
  planName: string | null;
  planCode: string | null;
  expired: boolean;
}

export interface MimoBalance {
  total: number | null;
  cash: number | null;
  gift: number | null;
  currency: string | null;
}

export type MimoEndpointResult<T> =
  | { state: "success"; data: T }
  | { state: "error"; error: string };

export interface MimoDashboardResult {
  usage: MimoEndpointResult<MimoMonthlyQuota>;
  detail: MimoEndpointResult<MimoPlanDetail>;
  balance: MimoEndpointResult<MimoBalance>;
}

type MimoRequestContext = { cookie: string; timeoutMs: number; timeZone: string };

function parseEnvelope(json: unknown): Record<string, unknown> {
  if (!isRecord(json) || json.code !== 0 || !isRecord(json.data)) {
    throw new Error("响应外层结构无效");
  }
  return json.data;
}

function parseNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Balances arrive as decimal strings ("50.00") or numbers; a missing or empty field is not reported. */
function parseOptionalBalance(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const amount = parseNonNegativeNumber(
    typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value.trim()) ? Number(value) : value,
  );
  if (amount === null) throw new Error("余额数据无效");
  return amount;
}

function nonBlankStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function parseMimoUsageResponse(json: unknown): MimoMonthlyQuota {
  const data = parseEnvelope(json);
  if (!isRecord(data.monthUsage) || !Array.isArray(data.monthUsage.items)) {
    throw new Error("缺少月度用量");
  }

  const item = data.monthUsage.items.find(
    (candidate) => isRecord(candidate) && candidate.name === "month_total_token",
  );
  if (!isRecord(item)) throw new Error("缺少月度额度");

  const used = parseNonNegativeNumber(item.used);
  const limit = parseNonNegativeNumber(item.limit);
  if (used === null || limit === null || limit <= 0) {
    throw new Error("月度额度无效");
  }

  return { used, limit };
}

function parseMimoDetailResponse(json: unknown): MimoPlanDetail {
  const data = parseEnvelope(json);
  if (typeof data.expired !== "boolean") throw new Error("套餐状态无效");

  return {
    planName: nonBlankStringOrNull(data.planName),
    planCode: nonBlankStringOrNull(data.planCode),
    expired: data.expired,
  };
}

function parseMimoBalanceResponse(json: unknown): MimoBalance {
  const data = parseEnvelope(json);
  return {
    total: parseOptionalBalance(data.balance),
    cash: parseOptionalBalance(data.cashBalance),
    gift: parseOptionalBalance(data.giftBalance),
    currency:
      typeof data.currency === "string" && /^[A-Za-z]{3}$/u.test(data.currency.trim())
        ? data.currency.trim().toUpperCase()
        : null,
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("响应为空");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MIMO_RESPONSE_MAX_BYTES) {
      throw new Error("响应过大");
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MIMO_RESPONSE_MAX_BYTES) {
        throw new Error("响应过大");
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Preserve the original read or size-limit error.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
}

function formatMimoDashboardTimeZone(timezoneOffsetMinutes?: number): string {
  const javascriptOffset = timezoneOffsetMinutes ?? new Date().getTimezoneOffset();
  const utcOffset = -javascriptOffset;
  const sign = utcOffset >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(utcOffset);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `UTC${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Redacts the whole cookie and each cookie value, since request errors can echo them. */
function sanitizeRequestError(error: unknown, cookie: string): string {
  const cookieValues = cookie
    .split(";")
    .map((part) => part.slice(part.indexOf("=") + 1).trim())
    .filter(Boolean);
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [cookie, ...cookieValues]) {
    message = message.split(secret).join("[redacted]");
  }
  return sanitizeSingleLineDisplaySnippet(message, 120) || "请求失败";
}

async function fetchMimoEndpoint<T>(
  name: "usage" | "detail" | "balance",
  path: string,
  parse: (json: unknown) => T,
  context: MimoRequestContext,
): Promise<MimoEndpointResult<T>> {
  const fail = (problem: string): MimoEndpointResult<T> => ({
    state: "error",
    error: `Xiaomi MiMo ${name}：${problem}`,
  });

  try {
    return await fetchWithTimeout(`${MIMO_ORIGIN}/api/v1${path}`, {
      request: {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          Cookie: context.cookie,
          Origin: MIMO_ORIGIN,
          Referer: `${MIMO_ORIGIN}/#/console/balance`,
          "User-Agent": MIMO_USER_AGENT,
          "x-timeZone": context.timeZone,
        },
      },
      timeoutMs: context.timeoutMs,
      consume: async (response, timeoutSignal): Promise<MimoEndpointResult<T>> => {
        if (response.status >= 300 && response.status < 400) return fail("请求需要登录");
        if (!response.ok) return fail(`请求失败（HTTP ${response.status}）`);

        let json: unknown;
        try {
          json = await readBoundedJson(response);
        } catch (error) {
          // Let a timeout reach the outer catch so it is reported as a timeout.
          if (timeoutSignal.aborted) throw error;
          return fail("响应解析失败");
        }

        try {
          return { state: "success", data: parse(json) };
        } catch {
          return fail("响应不符合预期结构");
        }
      },
    });
  } catch (error) {
    return fail(`请求失败：${sanitizeRequestError(error, context.cookie)}`);
  }
}

export async function queryMimoDashboard(
  cookie: string,
  options: { requestTimeoutMs?: number } = {},
): Promise<MimoDashboardResult> {
  const context: MimoRequestContext = {
    cookie,
    timeoutMs: options.requestTimeoutMs ?? MIMO_REQUEST_TIMEOUT_MS,
    timeZone: formatMimoDashboardTimeZone(),
  };
  const [usage, detail, balance] = await Promise.all([
    fetchMimoEndpoint("usage", "/tokenPlan/usage", parseMimoUsageResponse, context),
    fetchMimoEndpoint("detail", "/tokenPlan/detail", parseMimoDetailResponse, context),
    fetchMimoEndpoint("balance", "/balance", parseMimoBalanceResponse, context),
  ]);
  return { usage, detail, balance };
}
