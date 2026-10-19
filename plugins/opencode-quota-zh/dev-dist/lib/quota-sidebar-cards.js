import { paceOf } from "../v6/core/pace.js";
import { DEFAULT_WORDS } from "../v6/view/format.js";
import { pickRow, visibleGroups, windowFor } from "../v6/view/select.js";
import { rowName } from "../v6/view/text.js";
import { sanitizeDisplayText } from "../v6/lib/display-sanitize.js";
/**
 * Status of the public quota snapshot interface.
 *
 * "ready" means the quota background ran and the cards carry the queried
 * data (possibly empty when no provider is configured); "disabled" is the
 * explicit unavailable state returned when the quota background is switched
 * off. Sidebar card visibility is a display preference and never gates this
 * interface, so it does not appear here.
 */
export const QUOTA_SNAPSHOT_STATUSES = ["ready", "disabled"];
/** Rendered instead of 0% when a percentage is missing or not finite. */
export const QUOTA_SIDEBAR_UNKNOWN_VALUE = "未知";
/** Yes/no words for status rows; a flag is a switch, never a percentage. */
const QUOTA_FLAG_WORDS = { on: "开启", off: "关闭" };
/**
 * Chinese phrases for the v6 error vocabulary. Only the code reaches the
 * screen: `QuotaError.detail` is diagnostic (the provider's own message) and
 * must never be rendered.
 */
const QUOTA_ERROR_PHRASES = {
    not_configured: "未配置",
    login_expired: "登录已过期",
    no_plan: "无可用套餐",
    rate_limited: "请求过于频繁",
    timeout: "请求超时",
    network: "网络异常",
    provider_error: "服务端错误",
    bad_response: "响应异常",
    no_data: "暂无数据",
    local_tool: "本地工具异常",
    internal: "内部错误",
};
const QUOTA_ERROR_FALLBACK = "加载失败";
function quotaErrorPhrase(code) {
    return QUOTA_ERROR_PHRASES[code] ?? QUOTA_ERROR_FALLBACK;
}
function localizeBalanceLabel(label) {
    return label.replace(/\bBalance\b:?/gi, "额度");
}
function displayLabel(text) {
    return localizeBalanceLabel(sanitizeDisplayText(text));
}
function cardId(providerId, account) {
    return `${providerId}::${account}`;
}
function isoFromMs(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms))
        return undefined;
    return new Date(ms).toISOString();
}
// Optional keys must be omitted rather than set to undefined: the V2 RPC
// response is validated as a strict JSON value, and `{ key: undefined }` is
// rejected by it.
function cardTimeOptionals(provider) {
    const optionals = {};
    const okAtIso = isoFromMs(provider.okAtMs);
    if (okAtIso !== undefined)
        optionals.okAtIso = okAtIso;
    const checkedAtIso = isoFromMs(provider.checkedAtMs);
    if (checkedAtIso !== undefined)
        optionals.checkedAtIso = checkedAtIso;
    return optionals;
}
function rowResetTimeIso(row) {
    if (typeof row.resetsAt !== "string" || row.resetsAt.length === 0)
        return undefined;
    return sanitizeDisplayText(row.resetsAt);
}
/** The window facts a percent row keeps for the even-use mark, when it has them. */
function paceOptionals(row) {
    const optionals = {};
    if (row.window !== undefined)
        optionals.window = row.window;
    if (typeof row.windowStartedAt === "string" && row.windowStartedAt.length > 0) {
        optionals.windowStartedAtIso = sanitizeDisplayText(row.windowStartedAt);
    }
    return optionals;
}
/** The row `paceOf` judges: a percent row carries its window facts with it. */
function paceRow(row) {
    return {
        id: row.id,
        providerId: "",
        label: row.label,
        type: "quota",
        method: "remote_api",
        authority: "provider_reported",
        prominence: "primary",
        percentRemaining: row.percentRemaining,
        ...(row.resetTimeIso !== undefined ? { resetsAt: row.resetTimeIso } : {}),
        ...(row.window !== undefined ? { window: row.window } : {}),
        ...(row.windowStartedAtIso !== undefined ? { windowStartedAt: row.windowStartedAtIso } : {}),
    };
}
/**
 * The percent even use would leave a percent row now (the ┃ mark), or
 * undefined when the row has no window to judge it by. A missing reset time
 * or window length means no mark — never a made-up one.
 */
export function evenUseLeft(row, nowMs) {
    return paceOf(paceRow(row), nowMs)?.evenLeft;
}
/** Format an exact amount; undefined when it is missing or not a finite decimal. */
function formatAmount(amount) {
    if (!amount)
        return undefined;
    const decimal = amount.decimal;
    if (typeof decimal !== "string" || decimal.trim().length === 0)
        return undefined;
    if (!Number.isFinite(Number(decimal)))
        return undefined;
    const unit = amount.unit;
    if (unit.kind === "currency")
        return `${decimal} ${unit.code}`;
    if (unit.kind === "count")
        return `${decimal} ${unit.unit}`;
    if (unit.kind === "custom")
        return `${unit.symbol}${decimal}`;
    return undefined;
}
function usageValue(row) {
    const used = formatAmount(row.used);
    const limit = formatAmount(row.limit);
    if (used !== undefined)
        return limit !== undefined ? `${used} / ${limit}` : used;
    const remaining = formatAmount(row.remaining);
    if (remaining !== undefined)
        return limit !== undefined ? `${remaining} / ${limit}` : remaining;
    const amount = formatAmount(row.amount);
    if (amount !== undefined)
        return amount;
    return QUOTA_SIDEBAR_UNKNOWN_VALUE;
}
function balanceValue(row) {
    return formatAmount(row.remaining) ?? formatAmount(row.amount) ?? QUOTA_SIDEBAR_UNKNOWN_VALUE;
}
function statusValue(row) {
    if (typeof row.text === "string" && row.text.length > 0)
        return sanitizeDisplayText(row.text);
    if (typeof row.flag === "boolean")
        return row.flag ? QUOTA_FLAG_WORDS.on : QUOTA_FLAG_WORDS.off;
    return QUOTA_SIDEBAR_UNKNOWN_VALUE;
}
function sidebarRow(row, id, index, name) {
    // `name` is the row's name on a surface: the user's rename when they made
    // one, else the name the words picked for it.
    const label = name !== undefined
        ? displayLabel(name)
        : displayLabel(typeof row.label === "string" ? row.label : "");
    const rowId = typeof row.id === "string" && row.id.length > 0 ? row.id : `row-${index}`;
    const rowKey = `${id}::${rowId}`;
    const optionals = {};
    const resetTimeIso = rowResetTimeIso(row);
    if (resetTimeIso !== undefined)
        optionals.resetTimeIso = resetTimeIso;
    if (row.type === "quota" || row.type === "budget") {
        // Missing or non-finite percentages must never surface as a zero quota.
        if (typeof row.percentRemaining === "number" && Number.isFinite(row.percentRemaining)) {
            return {
                id: rowKey,
                kind: "percent",
                label,
                percentRemaining: row.percentRemaining,
                ...optionals,
                ...paceOptionals(row),
            };
        }
        return { id: rowKey, kind: "value", label, value: QUOTA_SIDEBAR_UNKNOWN_VALUE, ...optionals };
    }
    if (row.type === "usage") {
        return { id: rowKey, kind: "value", label, value: usageValue(row), ...optionals };
    }
    if (row.type === "balance") {
        return { id: rowKey, kind: "value", label, value: balanceValue(row), ...optionals };
    }
    if (row.type === "status") {
        return { id: rowKey, kind: "value", label, value: statusValue(row), ...optionals };
    }
    return { id: rowKey, kind: "value", label, value: QUOTA_SIDEBAR_UNKNOWN_VALUE, ...optionals };
}
/**
 * Group one provider snapshot into per-account sidebar cards.
 *
 * Rows are grouped by account in first-appearance order; a provider may own
 * several accounts and each becomes its own card. A provider error lands on
 * the first account group, following the upstream convention: when the
 * provider also returned rows, that card keeps the last good data and shows
 * the error beside it; with no rows at all the card carries just the error.
 */
function providerCards(provider) {
    const providerLabel = displayLabel(typeof provider.label === "string" ? provider.label : "");
    const accounts = [];
    const rowsByAccount = new Map();
    for (const row of provider.rows) {
        const account = typeof row.account === "string" ? row.account : "";
        const bucket = rowsByAccount.get(account);
        if (bucket)
            bucket.push(row);
        else {
            rowsByAccount.set(account, [row]);
            accounts.push(account);
        }
    }
    const cards = [];
    for (const account of accounts) {
        const id = cardId(provider.providerId, account);
        const rows = (rowsByAccount.get(account) ?? []).map((row, index) => sidebarRow(row, id, index));
        cards.push({
            id,
            label: account.length > 0 ? `${providerLabel} · ${sanitizeDisplayText(account)}` : providerLabel,
            rows,
            refreshing: provider.refreshing === true,
            ...cardTimeOptionals(provider),
        });
    }
    if (provider.error) {
        const phrase = quotaErrorPhrase(provider.error.code);
        const target = cards[0] ??
            {
                id: cardId(provider.providerId, ""),
                label: providerLabel,
                rows: [],
                refreshing: provider.refreshing === true,
                ...cardTimeOptionals(provider),
            };
        target.error = target.error ? `${target.error}; ${phrase}` : phrase;
        if (cards.length === 0)
            cards.push(target);
    }
    return cards;
}
/**
 * Build the sidebar cards for a v6 quota snapshot.
 *
 * One card per provider and account, in provider registration order. Only
 * quota and budget rows become percentages; usage, balance and status rows
 * stay value rows, and anything unknown renders as the unknown marker rather
 * than a fabricated number.
 *
 * With the bridge host's `display`, the v6 selectors pick the cards instead:
 * `visibleGroups` applies the hidden rows, the row and provider order and the
 * words of the same snapshot, and `rowName` names each row, so the card
 * follows the settings without a second copy of them. `surface` says which
 * settings apply: the expanded panel reads "sidebar", the collapsed one
 * "collapsed", each with its own hidden rows and orders. Without a display
 * the snapshot's own order and rows stand, which is the no-bridge fallback.
 *
 * The collapsed surface keeps the local multi-row overview instead of the
 * native single row, so its window preference links through `pickRow` and
 * `windowFor`: the row the collapsed surface would show leads its group, and
 * the group's other rows follow. A window chosen on the Collapsed tab
 * therefore changes what the collapsed card leads with, without dropping the
 * rows the user asked to keep.
 */
export function buildV6QuotaSidebarCards(snapshot, display, surface = "sidebar") {
    if (display === undefined) {
        const cards = [];
        for (const provider of snapshot.providers) {
            cards.push(...providerCards(provider));
        }
        return cards;
    }
    const words = snapshot.words ?? DEFAULT_WORDS;
    const cards = [];
    for (const group of visibleGroups(snapshot, display, surface, words)) {
        // A group with neither rows nor an error has nothing to show: a provider
        // never checked, or one whose every row the settings hide. The
        // no-settings path drops the same groups.
        if (group.rows.length === 0 && group.error === undefined)
            continue;
        const provider = snapshot.providers.find((item) => item.providerId === group.providerId);
        const id = cardId(group.providerId, group.account ?? "");
        const rows = group.rows.map((item, index) => sidebarRow(item.row, id, index, rowName(item, group, words)));
        if (surface === "collapsed") {
            const picked = pickRow(group, windowFor(display.window, group.providerId));
            const at = picked === undefined ? -1 : group.rows.indexOf(picked);
            if (at > 0)
                rows.unshift(...rows.splice(at, 1));
        }
        const card = {
            id,
            label: sidebarGroupLabel(group),
            rows,
            refreshing: provider?.refreshing === true,
            ...(provider ? cardTimeOptionals(provider) : {}),
        };
        // The provider's last error lands on its first shown group, as upstream
        // puts it; the phrase stays Chinese and never carries the diagnostic.
        if (group.error !== undefined)
            card.error = quotaErrorPhrase(group.error.code);
        cards.push(card);
    }
    return cards;
}
/** A group's card label in the local form: "Provider · account", or "Provider". */
function sidebarGroupLabel(group) {
    const name = displayLabel(group.name);
    return group.account ? `${name} · ${sanitizeDisplayText(group.account)}` : name;
}
/**
 * Build the public quota snapshot response consumed by the sidebar card.
 *
 * The response status only distinguishes a running background ("ready", cards
 * may still be empty) from an explicitly disabled background ("disabled").
 * A v6 snapshot only exists once the background ran, so this conversion
 * always answers "ready"; the disabled short-circuit stays with the caller
 * that knows the background is switched off. Hiding the sidebar card must not
 * turn this into an empty or failing interface: card visibility is applied
 * where the card is rendered, never here, so independent commands keep
 * querying the same server-side data.
 */
export function buildV6QuotaSnapshotResponse(snapshot) {
    return {
        status: "ready",
        cards: buildV6QuotaSidebarCards(snapshot),
    };
}
