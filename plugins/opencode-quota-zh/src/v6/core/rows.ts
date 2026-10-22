/**
 * Provider results as v6 rows. Every provider returns the row contract (`ProviderFetchResult`,
 * see `providers/contract.ts`); each row gets its id (`${providerId}.${key}`), its provider and
 * its account's account text.
 */

import { sanitizeSingleLineDisplaySnippet } from "../lib/display-sanitize.js";
import { QUOTA_PROVIDERS_AGGREGATE_ID } from "../lib/quota-providers.js";
import type { ProviderFetchResult } from "../providers/contract.js";
import { classifyError, errorKind } from "./errors.js";
import { publicDebugValue } from "./redact.js";
import type { ProviderFetch } from "./store.js";
import type { DebugDetail, QuotaRow } from "./types.js";
import { validateRows } from "./validate.js";

const DEBUG_VALUE_MAX_LENGTH = 300;

/** Brand words at the start of a provider's groups; what follows names the account or plan. */
const GROUP_BRANDS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["Claude"],
  copilot: ["Copilot"],
  openai: ["OpenAI"],
  openrouter: ["OpenRouter"],
  kilo: ["Kilo Gateway"],
  cursor: ["Cursor"],
  "alibaba-coding-plan": ["Alibaba Coding Plan"],
  "alibaba-token-plan": ["Alibaba Personal Token Plan"],
  synthetic: ["Synthetic"],
  chutes: ["Chutes"],
  "google-gemini-cli": ["Gemini CLI"],
  "google-agy": ["Google AGY", "AGY"],
  zai: ["Z.ai"],
  zhipu: ["Zhipu"],
  nanogpt: ["NanoGPT"],
  "minimax-coding-plan": ["MiniMax Token Plan"],
  "minimax-china-coding-plan": ["MiniMax Token Plan (CN)", "MiniMax Token Plan"],
  "kimi-code-plan-global": ["Kimi Code"],
  "kimi-code-plan-cn": ["Kimi Code (CN)", "Kimi Code"],
  deepseek: ["DeepSeek"],
  xai: ["xAI"],
  xiaomi: ["Xiaomi MiMo"],
  "opencode-go": ["OpenCode Go"],
  opencode: ["OpenCode Zen"],
  "ollama-cloud": ["Ollama Cloud"],
};

/**
 * The inside of one or more adjacent parentheses groups, joined by " · ".
 * "（Codex CLI 登录）" → "Codex CLI 登录"; "(Plus)（Codex CLI 登录）" → "Plus · Codex CLI 登录".
 */
function unwrapGroups(text: string): string | undefined {
  const inside: string[] = [];
  let rest = text.trim();
  const group = /^[（(]\s*([^（()）]*?)\s*[）)]\s*/u;
  while (rest) {
    const match = group.exec(rest);
    if (!match) return undefined;
    const value = (match[1] ?? "").trim();
    if (value) inside.push(value);
    rest = rest.slice(match[0].length);
  }
  return inside.length > 0 ? inside.join(" · ") : undefined;
}

/** "(Pro)" → "Pro", ": Standard [code]" → "Standard". */
function unwrap(text: string): string {
  let result = text.trim().replace(/^:\s*/u, "");
  const grouped = unwrapGroups(result);
  if (grouped !== undefined) result = grouped;
  else {
    const parens = /^\((.*)\)$/u.exec(result);
    if (parens) result = parens[1] ?? "";
  }
  const withoutCode = result.replace(/\s*\[[^\]]*\]$/u, "").trim();
  return withoutCode || result.trim();
}

function stripBrand(providerId: string, text: string): string {
  const brand = (GROUP_BRANDS[providerId] ?? []).find(
    (name) => text === name || text.startsWith(`${name} `) || text.startsWith(`${name}:`),
  );
  return brand ? text.slice(brand.length) : text;
}

/**
 * The account or plan in a legacy group: "OpenAI (Pro)" → "Pro", "[Claude Work] (active)" →
 * "Work", "[OpenAI Work] (Business)" → "Work (Business)". "(active)" is dropped: it moves
 * when the user switches logins, and the account must stay the same.
 */
export function accountFromGroup(
  providerId: string,
  group: string | undefined,
): string | undefined {
  if (!group) return undefined;
  const text = group.replace(/\s*\(active\)/gu, "").trim();
  if (providerId === QUOTA_PROVIDERS_AGGREGATE_ID) return text || undefined;
  const bracket = /^\[([^\]]*)\]\s*(.*)$/u.exec(text);
  const alias = unwrap(stripBrand(providerId, bracket ? (bracket[1] ?? "") : text));
  const category = bracket ? (bracket[2] ?? "").trim() : "";
  const account = alias && category ? `${alias} ${category}` : alias || unwrap(category);
  return account || undefined;
}

/** A candidate row and the login it came from ("" when the provider has one login). */
type Candidate = { row: Record<string, unknown>; login: string };

/**
 * Drops a row repeated for one login (same id and account). Logins that share an account text
 * keep it here; the store tells them apart, as it also sees logins that failed this time.
 */
function dropRepeatedRows(candidates: readonly Candidate[], debug: DebugDetail[]): Candidate[] {
  const seen = new Set<string>();
  return candidates.filter(({ row, login }) => {
    const slot = `${String(row.id)}\u001f${String(row.account ?? "")}\u001f${login}`;
    if (!seen.has(slot)) {
      seen.add(slot);
      return true;
    }
    debug.push({ key: "dropped_row", value: `${String(row.id)}: 重复的行` });
    return false;
  });
}

/**
 * Debug details are kept for /quota_status, as a public issue may show them (see
 * `publicDetail`): hidden before they are cut, so a cut never leaves part of a hidden value.
 * A key is a name the adapter or this file chose, so it is only cleaned and shortened.
 */
function detail(key: string, value: string): DebugDetail {
  return {
    key: sanitizeSingleLineDisplaySnippet(key, 64),
    value: publicDebugValue(key, value, DEBUG_VALUE_MAX_LENGTH),
  };
}

/**
 * A provider result as v6 rows, the error to show and the debug details. Each row is checked on
 * its own, so it keeps its login. `rowLogins` holds the logins as the provider gave them; the
 * provider source keys them before the store gets them.
 */
export function rowsFromProviderResult(
  providerId: string,
  result: ProviderFetchResult,
  nowMs: number = Date.now(),
): ProviderFetch {
  const debug = result.debug.map((item) => detail(item.key, item.value));
  const candidates: Candidate[] = result.accounts.flatMap((account) => {
    const accountText = accountFromGroup(providerId, account.name);
    return account.rows.map(({ key, ...fields }) => ({
      row: {
        ...fields,
        id: `${providerId}.${key}`,
        providerId,
        ...(accountText ? { account: accountText } : {}),
      },
      login: account.login ?? "",
    }));
  });
  const rows: QuotaRow[] = [];
  const rowLogins: string[] = [];
  for (const { row, login } of dropRepeatedRows(candidates, debug)) {
    const checked = validateRows(providerId, [row]);
    debug.push(...checked.dropped);
    for (const clean of checked.rows) {
      rows.push(clean);
      rowLogins.push(login);
    }
  }
  const logins = rowLogins.some(Boolean) ? { rowLogins } : {};

  const errors = result.accounts.flatMap((account) =>
    account.errors.map((error) => ({ account: account.name, message: error.message })),
  );
  for (const error of errors) {
    debug.push(detail("error", `${error.account}: ${error.message}`));
    // Read from the message alone, so a number or word in the account name is never its kind.
    debug.push(detail("error_kind", errorKind(classifyError(error.message, nowMs))));
  }
  const [firstError] = errors;
  if (firstError) {
    return { rows, ...logins, error: classifyError(firstError.message, nowMs), debug };
  }
  if (!result.attempted && rows.length === 0) {
    return { rows: [], error: { code: "not_configured" }, debug };
  }
  return { rows, ...logins, debug };
}
