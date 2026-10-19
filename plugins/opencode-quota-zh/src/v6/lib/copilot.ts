/**
 * GitHub Copilot accounting fetcher.
 *
 * Current usage is read from GitHub's public AI Credit billing reports.
 * Legacy premium-request reports are available only when explicitly selected
 * for an eligible Copilot Pro or Pro+ annual plan.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  sanitizeDisplaySnippet,
  sanitizeDisplayText,
  sanitizeSingleLineDisplaySnippet,
} from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import { finiteNumber } from "./json-guards.js";
import { readAuthFile } from "./opencode-auth.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { deriveResolvedAuthIdentity, type ResolvedAuthIdentity } from "./resolved-auth-identity.js";
import type {
  AuthData,
  CopilotAuthData,
  CopilotBillingModel,
  CopilotBudgetResult,
  CopilotEnterpriseUsageResult,
  CopilotOrganizationUsageResult,
  CopilotPlanResult,
  CopilotQuotaConfig,
  CopilotQuotaResult,
  CopilotResult,
  CopilotTier,
  QuotaError,
} from "./types.js";

const GITHUB_API_BASE_URL = "https://api.github.com";
const COPILOT_QUOTA_CONFIG_FILENAME = "copilot-quota-token.json";

/** Integration ids that can hold the Copilot OAuth login, in precedence order. */
export const COPILOT_AUTH_KEYS = [
  "github-copilot",
  "copilot",
  "copilot-chat",
  "github-copilot-chat",
] as const;

const VALID_TIERS: readonly CopilotTier[] = [
  "free",
  "student",
  "pro",
  "pro+",
  "max",
  "business",
  "enterprise",
];

const LEGACY_PREMIUM_REQUEST_TOTALS: Partial<Record<CopilotTier, number>> = {
  pro: 300,
  "pro+": 1500,
};

type CopilotAuthKeyName = (typeof COPILOT_AUTH_KEYS)[number];
type CopilotPatTokenKind = "github_pat" | "ghp" | "ghu" | "ghs" | "other";

interface BillingPeriodQuery {
  year: number;
  month: number;
}

interface UserBillingTarget {
  scope: "user";
  username?: string;
  billingPeriod: BillingPeriodQuery;
}

interface OrganizationBillingTarget {
  scope: "organization";
  organization: string;
  username?: string;
  billingPeriod: BillingPeriodQuery;
}

interface EnterpriseBillingTarget {
  scope: "enterprise";
  enterprise: string;
  organization?: string;
  username?: string;
  billingPeriod: BillingPeriodQuery;
}

type ManagedBillingTarget = OrganizationBillingTarget | EnterpriseBillingTarget;
type CopilotBillingTarget = UserBillingTarget | ManagedBillingTarget;
type CopilotRequestTarget = (UserBillingTarget & { username: string }) | ManagedBillingTarget;

interface CopilotPatReadResult {
  state: "absent" | "invalid" | "valid";
  checkedPaths: string[];
  selectedPath?: string;
  config?: CopilotQuotaConfig;
  error?: string;
  tokenKind?: CopilotPatTokenKind;
}

export interface CopilotQuotaAuthDiagnostics {
  pat: CopilotPatReadResult;
  oauth: {
    configured: boolean;
    keyName: CopilotAuthKeyName | null;
    hasRefreshToken: boolean;
    hasAccessToken: boolean;
    hasEnterpriseUrl: boolean;
  };
  deployment: "github.com" | "ghe.com" | "invalid" | "none";
  apiHost: string | null;
  enterpriseHostSource: "pat" | "oauth" | "none";
  enterpriseHostError?: string;
  effectiveSource: "pat" | "oauth" | "none";
  override: "pat_overrides_oauth" | "none";
  quotaApi:
    | "github_ai_credit_api"
    | "github_legacy_premium_request_api"
    | "copilot_internal_user"
    | "none";
  billingMode: "user_quota" | "organization_usage" | "enterprise_usage" | "none";
  billingScope: CopilotBillingTarget["scope"] | "none";
  billingApiAccessLikely: boolean;
  remainingTotalsState:
    | "available"
    | "value_only_without_denominator"
    | "not_available_from_org_usage"
    | "not_available_from_enterprise_usage"
    | "reported_by_copilot_internal_user"
    | "unavailable";
  queryPeriod?: BillingPeriodQuery;
  usernameFilter?: string;
  tokenCompatibilityError?: string;
  billingModel?: CopilotBillingModel;
  budgetApi: "organization_budgets" | "enterprise_budgets" | "not_available";
  oauthAccountingState:
    | "available_via_copilot_internal_user"
    | "invalid_enterprise_host"
    | "not_configured";
}

interface BillingUsageItem {
  product?: string;
  sku?: string;
  unitType?: string;
  unit_type?: string;
  grossQuantity?: number;
  gross_quantity?: number;
  discountQuantity?: number;
  discount_quantity?: number;
  netQuantity?: number;
  net_quantity?: number;
  netAmount?: number;
  net_amount?: number;
}

interface BillingUsageResponse {
  timePeriod?: { year: number; month?: number };
  time_period?: { year: number; month?: number };
  usageItems?: BillingUsageItem[];
  usage_items?: BillingUsageItem[];
}

interface BillingBudget {
  budget_type?: string;
  budget_product_sku?: string;
  budget_product_skus?: string[];
  budget_scope?: string;
  budget_entity_name?: string;
  budget_amount?: number;
  user?: string;
}

interface BillingBudgetsResponse {
  budgets?: BillingBudget[];
  has_next_page?: boolean;
}

interface CopilotInternalUserResponse {
  copilot_plan?: string;
  quota_reset_date_utc?: string;
  quota_reset_date?: string;
  token_based_billing?: boolean;
  quota_snapshots?: {
    premium_interactions?: {
      entitlement?: number;
      remaining?: number;
      quota_remaining?: number;
      percent_remaining?: number;
      credits_used?: number;
      unlimited?: boolean;
    };
  };
}

interface AiCreditTotals {
  used: number;
  includedUsed: number;
  billedUsed: number;
  billedAmountUsd?: number;
  authority: "provider_reported" | "locally_derived";
}

/** More specific budgets win when several apply to the same target. */
const BUDGET_SCOPE_SPECIFICITY: Readonly<Record<string, number>> = {
  user: 5,
  multi_user_cost_center: 4,
  multi_user_customer: 3,
  organization: 2,
  enterprise: 1,
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toQuotaError(message: string): QuotaError {
  return { success: false, error: message };
}

function validateEnterpriseHost(value: unknown): { host?: string; error?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== "string" || !value.trim()) {
    return { error: "enterpriseUrl must be a non-empty string when provided" };
  }

  const raw = value.trim();
  const invalid = {
    error:
      "enterpriseUrl 必须是主机名，或以 .ghe.com 结尾的纯主机 HTTPS URL（不含 api. 前缀、端口、路径、查询串、片段或用户信息）",
  };
  if (!/^[\x21-\x7e]+$/.test(raw) || raw.includes("*")) return invalid;

  let host: string;
  if (raw.includes("://")) {
    const authority = raw.slice(raw.indexOf("//") + 2).split(/[/?#]/u, 1)[0] ?? "";
    if (authority.includes(":")) return invalid;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return invalid;
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return invalid;
    }
    host = url.hostname.toLowerCase();
  } else {
    if (/[/:@?#]/.test(raw)) return invalid;
    host = raw.toLowerCase();
  }

  if (host.length > 253 || host.startsWith("api.") || !host.endsWith(".ghe.com")) {
    return invalid;
  }
  const labels = host.split(".");
  if (
    labels.some(
      (label) =>
        label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    return invalid;
  }
  return { host };
}

function getApiBaseUrl(enterpriseHost?: string): string {
  return enterpriseHost ? `https://api.${enterpriseHost}` : GITHUB_API_BASE_URL;
}

function classifyPatTokenKind(token: string): CopilotPatTokenKind {
  if (token.startsWith("github_pat_")) return "github_pat";
  if (token.startsWith("ghp_")) return "ghp";
  if (token.startsWith("ghu_")) return "ghu";
  if (token.startsWith("ghs_")) return "ghs";
  return "other";
}

function computePercentRemainingFromUsed(used: number, total: number): number | undefined {
  if (!Number.isFinite(used) || used < 0 || !Number.isFinite(total) || total <= 0) {
    return undefined;
  }
  return Math.max(0, Math.min(100, Math.floor(((total - used) * 100) / total)));
}

/** Why this tier/billing model cannot be combined with the configured scope, if it cannot. */
function getPatScopeError(config: CopilotQuotaConfig): string | undefined {
  const hasManagedScope = Boolean(config.organization || config.enterprise);
  if (config.billingModel === "legacy_premium_requests") {
    if (config.tier !== "pro" && config.tier !== "pro+") {
      return "旧版 premium-request 计费只适用于 Copilot Pro 或 Pro+ 订阅者中、在 2026 年 6 月 1 日后仍留在旧版计费的年付套餐。";
    }
    if (hasManagedScope) {
      return "旧版 premium-request 计费仅限个人。请从 copilot-quota-token.json 移除 organization 和 enterprise。";
    }
  }
  if (config.tier === "business") {
    return !config.organization || config.enterprise
      ? 'Copilot Business AI Credit 用量要求 copilot-quota-token.json 里配置 "organization"，且不接受 "enterprise"。'
      : undefined;
  }
  if (config.tier === "enterprise") {
    return hasManagedScope
      ? undefined
      : 'Copilot Enterprise AI Credit 用量要求 copilot-quota-token.json 里配置 "enterprise" 或 "organization"。';
  }
  return hasManagedScope
    ? `Copilot ${config.tier} AI Credit 用量按个人计。请从 copilot-quota-token.json 移除 organization 和 enterprise。`
    : undefined;
}

/** Billing target of a config that already passed `getPatScopeError`. */
function resolvePatBillingTarget(config: CopilotQuotaConfig): CopilotBillingTarget {
  const now = new Date();
  const billingPeriod = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  const { username, organization, enterprise } = config;
  if (enterprise) {
    return { scope: "enterprise", enterprise, organization, username, billingPeriod };
  }
  if (organization) return { scope: "organization", organization, username, billingPeriod };
  return { scope: "user", username, billingPeriod };
}

function validatePatTargetCompatibility(
  target: CopilotBillingTarget,
  tokenKind?: CopilotPatTokenKind,
): string | null {
  if (target.scope === "user" && tokenKind === "ghs") {
    return (
      "GitHub's personal AI Credit report supports GitHub App user access tokens, " +
      "but not GitHub App installation access tokens. Use a GitHub App user token, fine-grained PAT with Plan (read), or supported classic credential."
    );
  }
  if (
    target.scope === "enterprise" &&
    (tokenKind === "github_pat" || tokenKind === "ghu" || tokenKind === "ghs")
  ) {
    return (
      "GitHub 的企业计费报表不支持 fine-grained PAT 或 GitHub App access token。" +
      "请使用企业管理员或计费管理员持有的 classic PAT。"
    );
  }
  return null;
}

function validateQuotaConfig(raw: unknown): { config: CopilotQuotaConfig } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "配置必须是 JSON 对象" };

  const obj = raw as Record<string, unknown>;
  const token = typeof obj.token === "string" ? obj.token.trim() : "";
  const tier = typeof obj.tier === "string" ? obj.tier.trim().toLowerCase() : "";
  const billingModel =
    obj.billingModel === undefined
      ? "ai_credits"
      : typeof obj.billingModel === "string"
        ? obj.billingModel.trim()
        : "";

  if (!token) return { error: "缺少必填字符串字段：token" };
  if (!VALID_TIERS.includes(tier as CopilotTier)) {
    return {
      error: "tier 无效；可选：free、student、pro、pro+、max、business、enterprise",
    };
  }
  if (billingModel !== "ai_credits" && billingModel !== "legacy_premium_requests") {
    return { error: "billingModel 无效；可选 ai_credits 或 legacy_premium_requests" };
  }

  const enterpriseHost = validateEnterpriseHost(obj.enterpriseUrl);
  if (enterpriseHost.error) return { error: enterpriseHost.error };

  const optional: Partial<Record<"username" | "organization" | "enterprise", string>> = {};
  for (const key of ["username", "organization", "enterprise"] as const) {
    const value = obj[key];
    if (value == null) continue;
    if (typeof value !== "string" || !value.trim()) {
      return { error: `${key} must be a non-empty string when provided` };
    }
    optional[key] = value.trim();
  }

  const config: CopilotQuotaConfig = {
    token,
    tier: tier as CopilotTier,
    billingModel,
    username: optional.username,
    organization: optional.organization,
    enterprise: optional.enterprise,
    enterpriseUrl: enterpriseHost.host,
  };
  const scopeError = getPatScopeError(config);
  return scopeError ? { error: scopeError } : { config };
}

function readQuotaConfigWithMeta(): CopilotPatReadResult {
  const path = join(getOpencodeRuntimeDirs().configDir, COPILOT_QUOTA_CONFIG_FILENAME);
  const checkedPaths = [path];
  if (!existsSync(path)) return { state: "absent", checkedPaths };

  try {
    const validated = validateQuotaConfig(JSON.parse(readFileSync(path, "utf-8")) as unknown);
    if ("error" in validated) {
      return { state: "invalid", checkedPaths, selectedPath: path, error: validated.error };
    }
    return {
      state: "valid",
      checkedPaths,
      selectedPath: path,
      config: validated.config,
      tokenKind: classifyPatTokenKind(validated.config.token),
    };
  } catch (error) {
    return { state: "invalid", checkedPaths, selectedPath: path, error: errorText(error) };
  }
}

function getCopilotOAuthToken(auth: CopilotAuthData | null): string | null {
  return auth?.access?.trim() || auth?.refresh?.trim() || null;
}

function selectCopilotAuth(authData: AuthData | null): {
  auth: CopilotAuthData | null;
  keyName: CopilotAuthKeyName | null;
} {
  for (const keyName of COPILOT_AUTH_KEYS) {
    const auth = authData?.[keyName];
    if (!auth || auth.type !== "oauth") continue;
    // A login OpenCode could not return still counts, so it shows as an error.
    if (!getCopilotOAuthToken(auth) && auth.resolveError === undefined) continue;
    return { auth, keyName };
  }
  return { auth: null, keyName: null };
}

export function getCopilotQuotaAuthDiagnostics(
  authData: AuthData | null,
): CopilotQuotaAuthDiagnostics {
  const pat = readQuotaConfigWithMeta();
  const { auth, keyName } = selectCopilotAuth(authData);
  const oauthEnterpriseHost = validateEnterpriseHost(auth?.enterpriseUrl);
  const target = pat.config ? resolvePatBillingTarget(pat.config) : null;
  const compatibilityError = target ? validatePatTargetCompatibility(target, pat.tokenKind) : null;
  // Any PAT config, even an invalid one, is authoritative over OAuth.
  const patBlocksOAuth = pat.state !== "absent";
  const effectiveSource = patBlocksOAuth ? "pat" : auth ? "oauth" : "none";
  const effectiveEnterpriseHost =
    effectiveSource === "pat"
      ? pat.config?.enterpriseUrl
      : effectiveSource === "oauth"
        ? oauthEnterpriseHost.host
        : undefined;
  const enterpriseHostError =
    effectiveSource === "pat" && pat.error?.startsWith("enterpriseUrl")
      ? pat.error
      : effectiveSource === "oauth"
        ? oauthEnterpriseHost.error
        : undefined;
  const deployment =
    effectiveSource === "none"
      ? "none"
      : enterpriseHostError
        ? "invalid"
        : effectiveEnterpriseHost
          ? "ghe.com"
          : effectiveSource === "pat" && pat.state !== "valid"
            ? "none"
            : "github.com";
  const billingModel = pat.config?.billingModel ?? "ai_credits";
  const oauthAvailable = effectiveSource === "oauth" && !oauthEnterpriseHost.error;
  const billingScope = target?.scope ?? (oauthAvailable ? "user" : "none");

  return {
    pat,
    oauth: {
      configured: Boolean(auth),
      keyName,
      hasRefreshToken: Boolean(auth?.refresh?.trim()),
      hasAccessToken: Boolean(auth?.access?.trim()),
      hasEnterpriseUrl: auth?.enterpriseUrl !== undefined,
    },
    deployment,
    apiHost:
      deployment === "github.com" || deployment === "ghe.com"
        ? new URL(getApiBaseUrl(effectiveEnterpriseHost)).hostname
        : null,
    enterpriseHostSource: effectiveEnterpriseHost ? effectiveSource : "none",
    enterpriseHostError,
    effectiveSource,
    override: patBlocksOAuth && auth ? "pat_overrides_oauth" : "none",
    quotaApi: target
      ? billingModel === "legacy_premium_requests"
        ? "github_legacy_premium_request_api"
        : "github_ai_credit_api"
      : oauthAvailable
        ? "copilot_internal_user"
        : "none",
    billingMode:
      billingScope === "organization"
        ? "organization_usage"
        : billingScope === "enterprise"
          ? "enterprise_usage"
          : billingScope === "user"
            ? "user_quota"
            : "none",
    billingScope,
    billingApiAccessLikely: oauthAvailable || (target !== null && !compatibilityError),
    remainingTotalsState: oauthAvailable
      ? "reported_by_copilot_internal_user"
      : billingScope === "organization"
        ? "not_available_from_org_usage"
        : billingScope === "enterprise"
          ? "not_available_from_enterprise_usage"
          : billingScope === "none"
            ? "unavailable"
            : billingModel === "legacy_premium_requests"
              ? "available"
              : "value_only_without_denominator",
    queryPeriod: target?.billingPeriod,
    usernameFilter: pat.config?.username,
    tokenCompatibilityError: compatibilityError ?? undefined,
    billingModel,
    budgetApi:
      billingScope === "organization"
        ? "organization_budgets"
        : billingScope === "enterprise"
          ? "enterprise_budgets"
          : "not_available",
    oauthAccountingState: !auth
      ? "not_configured"
      : oauthEnterpriseHost.error
        ? "invalid_enterprise_host"
        : "available_via_copilot_internal_user",
  };
}

function redactSecret(text: string, secret: string): string {
  const redacted = sanitizeDisplayText(text).replaceAll(secret, "[redacted]");
  const sanitizedSecret = sanitizeDisplayText(secret);
  return sanitizedSecret ? redacted.replaceAll(sanitizedSecret, "[redacted]") : redacted;
}

async function readGitHubErrorMessage(response: Response, token: string): Promise<string> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const message = typeof parsed.message === "string" ? parsed.message : null;
    const documentationUrl =
      typeof parsed.documentation_url === "string" ? parsed.documentation_url : null;
    if (message && documentationUrl) return redactSecret(`${message} (${documentationUrl})`, token);
    if (message) return redactSecret(message, token);
  } catch {
    // Fall through to a bounded plain-text snippet.
  }
  return sanitizeDisplaySnippet(redactSecret(text, token), 160);
}

/** GET a GitHub JSON endpoint; failures become errors that never contain `token`. */
async function fetchGitHubJson<T>(params: {
  url: string;
  apiName: "GitHub API" | "GitHub Copilot API";
  headers: Record<string, string>;
  token: string;
  requestTimeoutMs?: number;
}): Promise<T> {
  const { apiName, token } = params;
  return await fetchWithTimeout(params.url, {
    request: { headers: params.headers },
    timeoutMs: params.requestTimeoutMs,
    consume: async (response) => {
      if (!response.ok) {
        const message = await readGitHubErrorMessage(response, token);
        const rateLimit =
          apiName === "GitHub API" &&
          response.status === 403 &&
          response.headers.get("x-ratelimit-remaining") === "0"
            ? "（GitHub API 速率额度已耗尽）"
            : "";
        throw new Error(`${apiName} 错误 ${response.status}：${message}${rateLimit}`);
      }
      try {
        return (await response.json()) as T;
      } catch {
        throw new Error(`${apiName} 返回的 JSON 格式错误`);
      }
    },
  });
}

async function fetchGitHubRestJson<T>(
  url: string,
  token: string,
  requestTimeoutMs?: number,
): Promise<T> {
  return await fetchGitHubJson<T>({
    url,
    apiName: "GitHub API",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "opencode-quota/copilot-billing",
    },
    token,
    requestTimeoutMs,
  });
}

async function resolveGitHubUsername(
  apiBaseUrl: string,
  token: string,
  requestTimeoutMs?: number,
): Promise<string> {
  const viewer = await fetchGitHubRestJson<{ login?: string }>(
    `${apiBaseUrl}/user`,
    token,
    requestTimeoutMs,
  );
  const login = viewer.login?.trim();
  if (!login) throw new Error("GitHub /user 响应缺少 login 字段");
  return login;
}

function billingSettingsUrl(apiBaseUrl: string, target: CopilotRequestTarget): string {
  if (target.scope === "enterprise") {
    return `${apiBaseUrl}/enterprises/${encodeURIComponent(target.enterprise)}/settings/billing`;
  }
  if (target.scope === "organization") {
    return `${apiBaseUrl}/organizations/${encodeURIComponent(target.organization)}/settings/billing`;
  }
  return `${apiBaseUrl}/users/${encodeURIComponent(target.username)}/settings/billing`;
}

async function fetchBillingUsage(params: {
  apiBaseUrl: string;
  token: string;
  target: CopilotBillingTarget;
  billingModel: CopilotBillingModel;
  requestTimeoutMs?: number;
}): Promise<{ response: BillingUsageResponse; target: CopilotRequestTarget }> {
  const { apiBaseUrl, token, requestTimeoutMs } = params;
  const target: CopilotRequestTarget =
    params.target.scope === "user"
      ? {
          ...params.target,
          username:
            params.target.username ??
            (await resolveGitHubUsername(apiBaseUrl, token, requestTimeoutMs)),
        }
      : params.target;

  const query = new URLSearchParams({
    year: String(target.billingPeriod.year),
    month: String(target.billingPeriod.month),
  });
  if (target.scope !== "user" && target.username) query.set("user", target.username);
  if (target.scope === "enterprise" && target.organization) {
    query.set("organization", target.organization);
  }
  const report =
    params.billingModel === "legacy_premium_requests" ? "premium_request" : "ai_credit";
  const url = `${billingSettingsUrl(apiBaseUrl, target)}/${report}/usage?${query}`;
  return {
    response: await fetchGitHubRestJson<BillingUsageResponse>(url, token, requestTimeoutMs),
    target,
  };
}

function getUsageItems(response: BillingUsageResponse): BillingUsageItem[] {
  if (Array.isArray(response.usageItems)) return response.usageItems;
  if (Array.isArray(response.usage_items)) return response.usage_items;
  throw new Error("GitHub 计费响应缺少 usageItems 数组");
}

function usageItemText(item: BillingUsageItem): string {
  return [item.product, item.sku, item.unitType, item.unit_type]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function isAiCreditItem(item: BillingUsageItem): boolean {
  const text = usageItemText(item);
  return text.includes("copilot") && (text.includes("ai credit") || text.includes("ai-credit"));
}

function quantitiesDiffer(left: number, right: number): boolean {
  return (
    Math.abs(left - right) > Number.EPSILON * 16 * Math.max(1, Math.abs(left), Math.abs(right))
  );
}

function hasInconsistentQuantities(gross?: number, discount?: number, net?: number): boolean {
  if (gross === undefined) return false;
  if (discount !== undefined && net !== undefined) {
    return quantitiesDiffer(gross, discount + net);
  }
  // With one part missing, only a part larger than gross is a contradiction.
  const part = discount ?? net;
  return part !== undefined && part > gross && quantitiesDiffer(gross, part);
}

function parseAiCreditTotals(response: BillingUsageResponse): AiCreditTotals {
  const items = getUsageItems(response);
  const matches = items.filter(isAiCreditItem);
  if (matches.length === 0 && items.length > 0) {
    throw new Error("GitHub 计费响应缺少 Copilot AI Credit 用量条目");
  }

  const totals: AiCreditTotals = {
    used: 0,
    includedUsed: 0,
    billedUsed: 0,
    billedAmountUsd: undefined,
    authority: "provider_reported",
  };
  for (const item of matches) {
    const gross = finiteNumber(item.grossQuantity ?? item.gross_quantity);
    const discount = finiteNumber(item.discountQuantity ?? item.discount_quantity);
    const net = finiteNumber(item.netQuantity ?? item.net_quantity);
    const quantities = [gross, discount, net].filter(
      (value): value is number => value !== undefined,
    );
    if (quantities.length === 0) {
      throw new Error("GitHub Copilot AI Credit 用量条目缺少数量字段");
    }
    if (quantities.some((value) => value < 0)) {
      throw new Error("GitHub Copilot AI Credit 用量条目出现负数量");
    }
    if (hasInconsistentQuantities(gross, discount, net)) {
      throw new Error("GitHub Copilot AI Credit 用量条目数量前后不一致");
    }

    // gross = included (discount) + billed (net); fill in whichever part is missing.
    const included =
      discount ?? (gross !== undefined && net !== undefined ? Math.max(0, gross - net) : 0);
    const billed = net ?? Math.max(0, (gross ?? 0) - included);
    totals.used += gross ?? included + billed;
    totals.includedUsed += included;
    totals.billedUsed += billed;
    if (quantities.length < 3) totals.authority = "locally_derived";

    const netAmount = finiteNumber(item.netAmount ?? item.net_amount);
    if (netAmount !== undefined) {
      if (netAmount < 0) {
        throw new Error("GitHub Copilot AI Credit 用量条目出现负的净额");
      }
      totals.billedAmountUsd = (totals.billedAmountUsd ?? 0) + netAmount;
    }
  }
  return totals;
}

function parseLegacyPremiumRequestUsage(response: BillingUsageResponse): number {
  const items = getUsageItems(response);
  const matches = items.filter((item) => usageItemText(item).includes("premium request"));
  if (matches.length === 0 && items.length > 0) {
    throw new Error("GitHub 计费响应缺少 premium-request 用量条目");
  }

  return matches.reduce((sum, item) => {
    const gross = finiteNumber(item.grossQuantity ?? item.gross_quantity);
    const net = finiteNumber(item.netQuantity ?? item.net_quantity);
    if (gross === undefined && net === undefined) {
      throw new Error("GitHub premium-request 用量条目缺少数量字段");
    }
    return sum + Math.max(0, gross ?? net ?? 0);
  }, 0);
}

function isAiCreditBudget(budget: BillingBudget): boolean {
  const skus = [
    budget.budget_product_sku,
    ...(Array.isArray(budget.budget_product_skus) ? budget.budget_product_skus : []),
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  return budget.budget_type === "BundlePricing" && skus.includes("ai_credits");
}

function budgetMatchesTarget(budget: BillingBudget, target: ManagedBillingTarget): boolean {
  const scope = budget.budget_scope;
  const entity = budget.budget_entity_name?.toLowerCase();
  const user = (budget.user ?? budget.budget_entity_name)?.toLowerCase();

  if (target.username) {
    if (scope === "user") return !user || user === target.username.toLowerCase();
    if (scope === "multi_user_customer") return true;
    if (scope === "multi_user_cost_center" && target.scope === "enterprise") return true;
  }
  if (target.scope === "organization") return scope === "organization";
  if (target.organization && scope === "organization") {
    return !entity || entity === target.organization.toLowerCase();
  }
  return scope === "enterprise";
}

async function fetchApplicableBudget(params: {
  apiBaseUrl: string;
  token: string;
  target: ManagedBillingTarget;
  spentUsd?: number;
  requestTimeoutMs?: number;
}): Promise<CopilotBudgetResult | undefined> {
  const budgets: BillingBudget[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const query = new URLSearchParams({ page: String(page), per_page: "100" });
    if (params.target.username) query.set("user", params.target.username);
    const response = await fetchGitHubRestJson<BillingBudgetsResponse>(
      `${billingSettingsUrl(params.apiBaseUrl, params.target)}/budgets?${query}`,
      params.token,
      params.requestTimeoutMs,
    );
    if (!Array.isArray(response.budgets)) {
      throw new Error("GitHub 预算响应缺少 budgets 数组");
    }
    budgets.push(...response.budgets);
    if (!response.has_next_page) break;
    if (page === 100) throw new Error("GitHub 预算响应超过 100 页");
  }

  const selected = budgets
    .filter(
      (budget) =>
        isAiCreditBudget(budget) &&
        budgetMatchesTarget(budget, params.target) &&
        typeof budget.budget_amount === "number" &&
        Number.isFinite(budget.budget_amount) &&
        budget.budget_amount >= 0,
    )
    .sort(
      (a, b) =>
        (BUDGET_SCOPE_SPECIFICITY[b.budget_scope ?? ""] ?? 0) -
        (BUDGET_SCOPE_SPECIFICITY[a.budget_scope ?? ""] ?? 0),
    )[0];
  if (!selected || selected.budget_amount === undefined) return undefined;

  const percentRemaining =
    params.spentUsd === undefined
      ? undefined
      : computePercentRemainingFromUsed(params.spentUsd, selected.budget_amount);
  return {
    amountUsd: selected.budget_amount,
    spentUsd: params.spentUsd,
    scope: selected.budget_scope ?? "unknown",
    percentRemaining,
    authority: percentRemaining === undefined ? "provider_reported" : "locally_derived",
  };
}

async function toAiCreditResult(params: {
  apiBaseUrl: string;
  response: BillingUsageResponse;
  target: CopilotRequestTarget;
  token: string;
  requestTimeoutMs?: number;
}): Promise<CopilotQuotaResult | CopilotOrganizationUsageResult | CopilotEnterpriseUsageResult> {
  const { target } = params;
  const totals = parseAiCreditTotals(params.response);
  const responsePeriod = params.response.timePeriod ?? params.response.time_period;
  const period = {
    year:
      typeof responsePeriod?.year === "number" ? responsePeriod.year : target.billingPeriod.year,
    month:
      typeof responsePeriod?.month === "number" ? responsePeriod.month : target.billingPeriod.month,
  };
  if (target.scope === "user") {
    return { success: true, mode: "user_quota", unit: "ai_credits", period, ...totals };
  }

  // The budget is optional context: its failure becomes a warning, not a failed usage read.
  let budget: CopilotBudgetResult | undefined;
  let warnings: string[] | undefined;
  try {
    budget = await fetchApplicableBudget({
      apiBaseUrl: params.apiBaseUrl,
      token: params.token,
      target,
      spentUsd: totals.billedAmountUsd,
      requestTimeoutMs: params.requestTimeoutMs,
    });
  } catch (error) {
    warnings = [`AI Credit 用量已读取，但预算报表失败：${errorText(error)}`];
  }

  const usage = { period, unit: "ai_credits" as const, ...totals, budget, warnings };
  if (target.scope === "organization") {
    return {
      success: true,
      mode: "organization_usage",
      organization: target.organization,
      username: target.username,
      ...usage,
    };
  }
  return {
    success: true,
    mode: "enterprise_usage",
    enterprise: target.enterprise,
    organization: target.organization,
    username: target.username,
    ...usage,
  };
}

function toLegacyResult(
  response: BillingUsageResponse,
  config: CopilotQuotaConfig,
): CopilotQuotaResult {
  const used = parseLegacyPremiumRequestUsage(response);
  const total = LEGACY_PREMIUM_REQUEST_TOTALS[config.tier];
  const now = new Date();
  return {
    success: true,
    mode: "user_quota",
    unit: "premium_requests",
    used,
    authority: "locally_derived",
    total,
    percentRemaining: total ? computePercentRemainingFromUsed(used, total) : undefined,
    plan: config.tier,
    // Approximate: the start of the next UTC month.
    resetTimeIso: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
  };
}

function normalizeResetTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function parseCopilotInternalUser(
  response: CopilotInternalUserResponse,
): CopilotQuotaResult | CopilotPlanResult {
  const plan =
    typeof response.copilot_plan === "string"
      ? sanitizeSingleLineDisplaySnippet(response.copilot_plan, 64) || undefined
      : undefined;
  const resetTimeIso = normalizeResetTime(
    response.quota_reset_date_utc ?? response.quota_reset_date,
  );
  const snapshot = response.quota_snapshots?.premium_interactions;
  if (snapshot?.unlimited === true) {
    return {
      success: true,
      mode: "user_quota",
      unit: "premium_interactions",
      used: 0,
      authority: "provider_reported",
      unlimited: true,
      plan,
      resetTimeIso,
    };
  }

  const entitlement = finiteNumber(snapshot?.entitlement);
  const remaining = finiteNumber(snapshot?.quota_remaining ?? snapshot?.remaining);
  const reportedPercent = finiteNumber(snapshot?.percent_remaining);
  const validReportedPercent =
    reportedPercent !== undefined && reportedPercent >= 0 && reportedPercent <= 100
      ? reportedPercent
      : undefined;
  const tokenBasedBilling = response.token_based_billing === true;

  if (entitlement !== undefined && entitlement > 0 && remaining !== undefined) {
    if (remaining >= 0 && remaining <= entitlement) {
      return {
        success: true,
        mode: "user_quota",
        unit: "premium_interactions",
        used: entitlement - remaining,
        authority: "locally_derived",
        total: entitlement,
        // An invalid reported percentage is dropped, not replaced by a derived one.
        percentRemaining:
          validReportedPercent ??
          (snapshot?.percent_remaining === undefined
            ? Math.min(100, Math.max(0, (remaining / entitlement) * 100))
            : undefined),
        plan,
        resetTimeIso,
      };
    }
    // Token-based billing reports a negative remaining once usage goes over the
    // entitlement, alongside a provider-reported clamp in [0, 100].
    if (tokenBasedBilling && remaining < 0 && validReportedPercent !== undefined) {
      const creditsUsed = finiteNumber(snapshot?.credits_used);
      const hasCreditsUsed = creditsUsed !== undefined && creditsUsed >= 0;
      return {
        success: true,
        mode: "user_quota",
        unit: hasCreditsUsed ? "ai_credits" : "premium_interactions",
        used: hasCreditsUsed ? creditsUsed : entitlement - remaining,
        authority: hasCreditsUsed ? "provider_reported" : "locally_derived",
        total: entitlement,
        percentRemaining: validReportedPercent,
        plan,
        resetTimeIso,
      };
    }
  }
  // Token-based billing without usable numbers (e.g. an all-zero placeholder) is plan-only.
  if (tokenBasedBilling) {
    return { success: true, mode: "user_plan", authority: "provider_reported", plan, resetTimeIso };
  }
  throw new Error("GitHub Copilot 用户响应缺少可用的额度快照");
}

async function queryCopilotOAuthQuota(
  authData: AuthData | undefined,
  requestTimeoutMs?: number,
): Promise<CopilotResult> {
  const { auth } = selectCopilotAuth(
    authData ?? (await readAuthFile({ integrationIds: COPILOT_AUTH_KEYS })),
  );
  if (auth?.resolveError !== undefined) {
    return toQuotaError(
      `Copilot 登录读取失败：${auth.resolveError}。请运行 \`opencode auth login github-copilot\`。`,
    );
  }
  const token = getCopilotOAuthToken(auth);
  if (!auth || !token) return null;

  const enterpriseHost = validateEnterpriseHost(auth.enterpriseUrl);
  if (enterpriseHost.error) {
    return toQuotaError(`OpenCode Copilot enterpriseUrl 无效：${enterpriseHost.error}`);
  }
  try {
    const response = await fetchGitHubJson<CopilotInternalUserResponse>({
      url: `${getApiBaseUrl(enterpriseHost.host)}/copilot_internal/user`,
      apiName: "GitHub Copilot API",
      headers: {
        Accept: "application/json",
        Authorization: `token ${token}`,
        "Editor-Version": "vscode/1.96.2",
        "Editor-Plugin-Version": "copilot-chat/0.26.7",
        "User-Agent": "GitHubCopilotChat/0.26.7",
        "X-GitHub-Api-Version": "2025-04-01",
      },
      token,
      requestTimeoutMs,
    });
    if (!response || typeof response !== "object") {
      throw new Error("GitHub Copilot API 返回的 JSON 格式错误");
    }
    return parseCopilotInternalUser(response);
  } catch (error) {
    return toQuotaError(errorText(error));
  }
}

/**
 * Query GitHub Copilot accounting.
 *
 * A trusted local PAT config remains authoritative. When it is absent, the
 * OpenCode-managed Copilot OAuth token can query the per-user internal quota endpoint.
 */
export async function queryCopilotQuota(
  options: { requestTimeoutMs?: number; authData?: AuthData } = {},
): Promise<CopilotResult> {
  const pat = readQuotaConfigWithMeta();
  if (pat.state === "invalid") {
    return toQuotaError(`copilot-quota-token.json 无效：${pat.error}（${pat.selectedPath}）`);
  }
  if (!pat.config) return await queryCopilotOAuthQuota(options.authData, options.requestTimeoutMs);

  const config = pat.config;
  const billingTarget = resolvePatBillingTarget(config);
  const compatibilityError = validatePatTargetCompatibility(billingTarget, pat.tokenKind);
  if (compatibilityError) return toQuotaError(compatibilityError);

  try {
    const billingModel = config.billingModel ?? "ai_credits";
    const apiBaseUrl = getApiBaseUrl(config.enterpriseUrl);
    const { response, target } = await fetchBillingUsage({
      apiBaseUrl,
      token: config.token,
      target: billingTarget,
      billingModel,
      requestTimeoutMs: options.requestTimeoutMs,
    });
    return billingModel === "legacy_premium_requests"
      ? toLegacyResult(response, config)
      : await toAiCreditResult({
          apiBaseUrl,
          response,
          target,
          token: config.token,
          requestTimeoutMs: options.requestTimeoutMs,
        });
  } catch (error) {
    return toQuotaError(errorText(error));
  }
}

export async function resolveCopilotAuthIdentity(): Promise<ResolvedAuthIdentity | null> {
  const pat = readQuotaConfigWithMeta();
  if (pat.state === "invalid") return null;

  if (pat.config) {
    const target = resolvePatBillingTarget(pat.config);
    if (validatePatTargetCompatibility(target, pat.tokenKind)) return null;

    const { year, month } = target.billingPeriod;
    return deriveResolvedAuthIdentity({
      providerId: "copilot:pat",
      principal: { kind: "credential", value: pat.config.token },
      qualifiers: [
        `api=${getApiBaseUrl(pat.config.enterpriseUrl)}`,
        `billingModel=${pat.config.billingModel ?? "ai_credits"}`,
        `tier=${pat.config.tier}`,
        `scope=${target.scope}`,
        `username=${target.username ?? ""}`,
        `organization=${"organization" in target ? target.organization : ""}`,
        `enterprise=${"enterprise" in target ? target.enterprise : ""}`,
        `period=${year}-${String(month).padStart(2, "0")}`,
      ],
    });
  }

  const { auth } = selectCopilotAuth(await readAuthFile({ integrationIds: COPILOT_AUTH_KEYS }));
  const token = getCopilotOAuthToken(auth);
  if (!auth || !token) return null;

  const enterpriseHost = validateEnterpriseHost(auth.enterpriseUrl);
  if (enterpriseHost.error) return null;
  return deriveResolvedAuthIdentity({
    providerId: "copilot:oauth",
    principal: { kind: "credential", value: token },
    qualifiers: [`api=${getApiBaseUrl(enterpriseHost.host)}`],
  });
}

export async function hasCopilotQuotaRuntimeAvailable(): Promise<boolean> {
  const diagnostics = getCopilotQuotaAuthDiagnostics(
    await readAuthFile({ integrationIds: COPILOT_AUTH_KEYS }),
  );
  return diagnostics.billingApiAccessLikely;
}
