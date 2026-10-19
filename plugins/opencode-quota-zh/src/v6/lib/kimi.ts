import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { clampPercent } from "./format-utils.js";
import { fetchWithTimeout } from "./http.js";
import { nonEmptyString } from "./json-guards.js";
import { getKimiQuotaEndpoint, type KimiQuotaEndpointId } from "./kimi-endpoints.js";
import type { KimiQuotaWindow, KimiResult } from "./types.js";

const USER_AGENT = "OpenCode-Quota-Toast/1.0";

function getFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function parseResetTimeIso(data: Record<string, unknown>): string | undefined {
  for (const key of ["reset_at", "resetAt", "reset_time", "resetTime"]) {
    const val = data[key];
    if (typeof val === "string" && val.trim().length > 0) {
      const ms = Date.parse(val);
      if (Number.isFinite(ms)) {
        return new Date(ms).toISOString();
      }
    }
  }

  for (const key of ["reset_in", "resetIn", "ttl"]) {
    const seconds = getFiniteNumber(data[key]);
    if (seconds !== undefined && seconds > 0) {
      return new Date(Date.now() + Math.round(seconds * 1000)).toISOString();
    }
  }

  const window = data.window;
  if (window !== null && typeof window === "object") {
    const w = window as Record<string, unknown>;
    const windowSeconds = getFiniteNumber(w.duration);
    if (windowSeconds !== undefined && windowSeconds > 0) {
      return new Date(Date.now() + Math.round(windowSeconds * 1000)).toISOString();
    }
  }

  return undefined;
}

function buildLimitLabel(
  item: Record<string, unknown>,
  detail: Record<string, unknown>,
  window: Record<string, unknown>,
  index: number,
): string {
  for (const key of ["name", "title", "scope"]) {
    const val = nonEmptyString(item[key] ?? detail[key]);
    if (val) return val;
  }

  const duration = getFiniteNumber(window.duration ?? item.duration ?? detail.duration);
  const timeUnit = String(window.timeUnit ?? item.timeUnit ?? detail.timeUnit ?? "");

  if (duration !== undefined && duration > 0) {
    if (timeUnit.includes("MINUTE")) {
      if (duration >= 60 && duration % 60 === 0) {
        return `${duration / 60}h limit`;
      }
      return `${duration}m limit`;
    }
    if (timeUnit.includes("HOUR")) {
      return `${duration}h limit`;
    }
    if (timeUnit.includes("DAY")) {
      return `${duration}d limit`;
    }
    return `${duration}s limit`;
  }

  return `Limit #${index + 1}`;
}

function toUsageWindow(
  data: Record<string, unknown>,
  defaultLabel: string,
): KimiQuotaWindow | null {
  const limit = getFiniteNumber(data.limit);
  let used = getFiniteNumber(data.used);

  if (used === undefined) {
    const remaining = getFiniteNumber(data.remaining);
    if (remaining !== undefined && limit !== undefined) {
      used = limit - remaining;
    }
  }

  if (used === undefined && limit === undefined) {
    return null;
  }

  const safeUsed = used ?? 0;
  const safeLimit = limit ?? 0;
  const percentRemaining =
    safeLimit > 0 ? clampPercent(((safeLimit - safeUsed) / safeLimit) * 100) : 0;

  return {
    label: nonEmptyString(data.name ?? data.title) ?? defaultLabel,
    used: safeUsed,
    limit: safeLimit,
    percentRemaining,
    resetTimeIso: parseResetTimeIso(data),
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The weekly `usage` row, then one row per `limits` item (each may sit under `data`). */
function parseKimiWindows(payload: Record<string, unknown>): KimiQuotaWindow[] {
  const data = asObject(payload.data);
  const usage = asObject(data?.usage ?? payload.usage);
  const limits = data?.limits ?? payload.limits;
  const windows: KimiQuotaWindow[] = [];

  const usageWindow = usage ? toUsageWindow(usage, "Weekly limit") : null;
  if (usageWindow) windows.push(usageWindow);

  if (Array.isArray(limits)) {
    for (const [index, item] of limits.entries()) {
      const itemMap = asObject(item);
      if (!itemMap) continue;
      const detail = asObject(itemMap.detail) ?? itemMap;
      const window = asObject(itemMap.window) ?? {};
      const limitWindow = toUsageWindow(detail, buildLimitLabel(itemMap, detail, window, index));
      if (limitWindow) windows.push(limitWindow);
    }
  }

  return windows;
}

export async function queryKimiQuota(options: {
  apiKey: string;
  endpoint: KimiQuotaEndpointId;
  label?: string;
  requestTimeoutMs?: number;
}): Promise<KimiResult> {
  const endpoint = getKimiQuotaEndpoint(options.endpoint);
  const label = options.label ?? endpoint.label;
  try {
    return await fetchWithTimeout(endpoint.quotaUrl, {
      request: {
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "User-Agent": USER_AGENT,
        },
      },
      timeoutMs: options.requestTimeoutMs,
      consume: async (resp): Promise<KimiResult> => {
        if (!resp.ok) {
          const text = await resp.text();
          return {
            success: false,
            error: `Kimi API 错误 ${resp.status}：${sanitizeDisplaySnippet(text, 120)}`,
          };
        }

        const payload = (await resp.json()) as Record<string, unknown>;
        // Read the keys first: a `null` body must fail with Object.keys' error.
        const topLevelKeys = Object.keys(payload);
        const windows = parseKimiWindows(payload);
        if (windows.length > 0) return { success: true, label, windows };

        const keys = topLevelKeys.length ? topLevelKeys.join(", ") : "（空）";
        return { success: false, error: `响应结构异常（keys: ${keys}）` };
      },
    });
  } catch (err) {
    return {
      success: false,
      error: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
    };
  }
}
