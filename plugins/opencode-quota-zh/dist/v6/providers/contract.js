/**
 * The row contract providers return: per account, its rows (keyed like `five_hour`) and its
 * errors, plus debug details for /quota_status. `core/rows.ts` turns a result into v6 rows by
 * adding each row's id, provider and account.
 */
import { formatCredentialDisplayNames } from "../lib/opencode-auth.js";
/** A row key part from provider text: lower case, `_` for anything else ("Claude/GPT" → "claude_gpt"). */
export function keySlug(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "_")
        .replace(/^_+|_+$/gu, "");
}
/** The common windows: row key, default label and window. */
export const FIVE_HOUR = { key: "five_hour", label: "5h", window: "five_hour" };
export const WEEKLY = { key: "weekly", label: "每周", window: "week" };
export const MONTHLY = { key: "monthly", label: "每月", window: "month" };
export const DAILY = { key: "daily", label: "每日", window: "day" };
/** A remote, provider-reported quota row with the percent left: most providers' row. */
export function quotaRow(fields) {
    return {
        key: fields.key,
        label: fields.label,
        type: "quota",
        method: "remote_api",
        authority: "provider_reported",
        prominence: "primary",
        ...(fields.window ? { window: fields.window } : {}),
        percentRemaining: fields.percentRemaining,
        // An empty reset time means the provider gave none.
        ...(fields.resetsAt ? { resetsAt: fields.resetsAt } : {}),
        ...(fields.windowStartedAt ? { windowStartedAt: fields.windowStartedAt } : {}),
    };
}
/** A quota row for each window the provider reported, in the given order. */
export function windowRows(windows) {
    return windows.flatMap(({ slot, value }) => value
        ? [
            quotaRow({
                ...slot,
                percentRemaining: value.percentRemaining,
                resetsAt: value.resetTimeIso,
                windowStartedAt: value.fixedWindow?.startedAtIso,
            }),
        ]
        : []);
}
/** An account with one error and no rows. */
export function failedAccount(name, message) {
    return { name, rows: [], errors: [{ message }] };
}
/**
 * Fetches every OpenCode login of a provider at once and names each account the way OpenCode
 * lists the logins ("[Claude Work] (active)"). A login that gave nothing has no account but
 * still counts when unnamed logins are numbered.
 */
export async function fetchEachLogin(params) {
    const fetched = await Promise.all(params.logins.map((login) => params.fetchLogin(login)));
    const names = formatCredentialDisplayNames(params.providerName, params.logins.map(({ row }, index) => ({
        row,
        fallbackName: fetched[index]?.fallbackName ?? params.providerName,
        numberUnnamed: params.numberUnnamed?.(row) ?? false,
    })));
    return params.logins.flatMap(({ row }, index) => {
        const result = fetched[index];
        if (!result)
            return [];
        return [
            {
                name: names[index] ?? params.providerName,
                login: row.id,
                rows: result.rows,
                errors: result.errors,
            },
        ];
    });
}
/**
 * Fetches each stored key login of an API-key vendor (see `readKeyLogins`). A broken login is
 * an account with its error; `brokenFirst` lists those before the fetched ones.
 */
export async function fetchKeyLogins(params) {
    const accounts = await fetchEachLogin({
        providerName: params.providerName,
        logins: params.logins,
        async fetchLogin({ row, auth }) {
            if (auth.state === "invalid") {
                return { rows: [], errors: [{ message: auth.error }] };
            }
            return params.fetchLogin({ row, auth: auth });
        },
    });
    if (!params.brokenFirst)
        return accounts;
    const broken = new Set(params.logins.filter(({ auth }) => auth.state === "invalid").map(({ row }) => row.id));
    return [
        ...accounts.filter((account) => broken.has(account.login ?? "")),
        ...accounts.filter((account) => !broken.has(account.login ?? "")),
    ];
}
