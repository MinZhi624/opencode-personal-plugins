import type { Amount } from "../core/types.js";
import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import type { QuotaProviderContext } from "../lib/entries.js";
import type { GoogleCompanionPresence } from "../lib/google-companion-credentials.js";
import type {
  GoogleAuthPresence,
  GoogleAuthSourceKey,
  GoogleQuotaResult,
} from "../lib/google-oauth-quota.js";
import { type CredentialRow, readCredentialRows } from "../lib/opencode-auth.js";
import type { AuthData } from "../lib/types.js";
import {
  type AccountResult,
  failedAccount,
  fetchEachLogin,
  type ProviderFetchResult,
  type ProviderRow,
} from "./contract.js";
import { statusDetailsFromRecord } from "./result-helpers.js";

/** The parts in which the Google AGY and Gemini CLI providers differ. */
export type GoogleProviderFlavor<Bucket extends { accountEmail?: string }> = {
  name: "Google AGY" | "Gemini CLI";
  authKeys: readonly string[];
  inspectAuth: () => Promise<GoogleAuthPresence<GoogleAuthSourceKey>>;
  inspectCompanion: () => Promise<GoogleCompanionPresence>;
  query: (options: {
    requestTimeoutMs?: number;
    authData?: AuthData;
  }) => Promise<GoogleQuotaResult<Bucket>>;
  /** Error for a login OpenCode could not return; without it the login is queried. */
  failedLoginError?: (resolveError: string) => string;
  compareBuckets?: (left: Bucket, right: Bucket) => number;
  /** The row of one bucket, or none when the bucket gives no row key. */
  row: (bucket: Bucket) => ProviderRow | undefined;
  /**
   * The account of a bucket from the default login read (`accountLabel` is the short email):
   * its name and the login it counts as.
   */
  defaultAccount: (
    bucket: Bucket,
    accountLabel: string | undefined,
  ) => { name: string; login: string | undefined };
};

export async function isGoogleRuntimeAvailable(
  hasRuntime: () => Promise<boolean>,
): Promise<boolean> {
  try {
    return await hasRuntime();
  } catch {
    return false;
  }
}

/** A remaining count Google reported ("1200", "12.5") in `unit`; none for anything else. */
export function remainingCount(text: string | undefined, unit: string): Amount | undefined {
  const number = text?.trim();
  if (!number || !/^\d+(?:\.\d+)?$/u.test(number)) return undefined;
  const [integer = "0", fraction = ""] = number.split(".");
  const whole = integer.replace(/^0+(?=\d)/u, "");
  const decimals = fraction.replace(/0+$/u, "");
  return {
    decimal: decimals ? `${whole}.${decimals}` : whole,
    unit: { kind: "count", unit },
  };
}

function getGoogleAccountLocalPart(email: string): string {
  const [local = email] = email.split("@");
  return local || email;
}

function formatGoogleAccountLabel(email: string | undefined): string {
  if (!email) return "Unknown";
  return `${getGoogleAccountLocalPart(email).slice(0, 3)}…`;
}

/** Short account labels ("ali…"), extended or numbered where they would collide. */
function createGoogleAccountLabelMap(
  emails: readonly (string | undefined)[],
): ReadonlyMap<string, string> {
  const uniqueEmails = [...new Set(emails.filter((email): email is string => Boolean(email)))];
  const labels = new Map(uniqueEmails.map((email) => [email, formatGoogleAccountLabel(email)]));
  const emailsByLabel = new Map<string, string[]>();

  for (const email of uniqueEmails) {
    const label = labels.get(email)!;
    emailsByLabel.set(label, [...(emailsByLabel.get(label) ?? []), email]);
  }

  for (const collidingEmails of emailsByLabel.values()) {
    if (collidingEmails.length < 2) continue;

    const localParts = collidingEmails.map(getGoogleAccountLocalPart);
    const distinctLocalParts = [...new Set(localParts)];
    const maxLength = Math.max(...distinctLocalParts.map((local) => local.length));
    let prefixLength = distinctLocalParts.length === 1 ? maxLength : 4;
    while (
      prefixLength <= maxLength &&
      new Set(distinctLocalParts.map((local) => local.slice(0, prefixLength))).size <
        distinctLocalParts.length
    ) {
      prefixLength += 1;
    }

    const emailsByPrefix = new Map<string, string[]>();
    collidingEmails.forEach((email, index) => {
      const local = localParts[index]!;
      const prefix = local.slice(0, Math.min(prefixLength, local.length));
      emailsByPrefix.set(prefix, [...(emailsByPrefix.get(prefix) ?? []), email]);
    });
    for (const [prefix, matchingEmails] of emailsByPrefix) {
      matchingEmails.forEach((email, index) => {
        labels.set(email, `${prefix}…${matchingEmails.length > 1 ? ` ${index + 1}` : ""}`);
      });
    }
  }

  return labels;
}

function sortBuckets<Bucket extends { accountEmail?: string }>(
  flavor: GoogleProviderFlavor<Bucket>,
  buckets: Bucket[],
): Bucket[] {
  return flavor.compareBuckets ? [...buckets].sort(flavor.compareBuckets) : buckets;
}

function bucketRows<Bucket extends { accountEmail?: string }>(
  flavor: GoogleProviderFlavor<Bucket>,
  buckets: Bucket[],
): ProviderRow[] {
  return sortBuckets(flavor, buckets).flatMap((bucket) => {
    const row = flavor.row(bucket);
    return row ? [row] : [];
  });
}

/** One account per OpenCode login, named after the login. */
function fetchLoginRows<Bucket extends { accountEmail?: string }>(
  flavor: GoogleProviderFlavor<Bucket>,
  rows: CredentialRow[],
  requestTimeoutMs: number | undefined,
): Promise<AccountResult[]> {
  return fetchEachLogin({
    providerName: flavor.name,
    logins: rows.map((row) => ({ row })),
    async fetchLogin({ row }) {
      const result =
        row.resolveError !== undefined && flavor.failedLoginError
          ? { success: false as const, error: flavor.failedLoginError(row.resolveError) }
          : await flavor.query({
              requestTimeoutMs,
              authData: { [row.integrationId]: row.value } as AuthData,
            });
      if (!result) return null;
      if (!result.success) return { rows: [], errors: [{ message: result.error }] };
      return {
        rows: bucketRows(flavor, result.buckets),
        errors: (result.errors ?? []).map((error) => ({ message: error.error })),
      };
    },
  });
}

/** The default login read: one account per run of buckets of one account, then the errors. */
async function fetchDefaultLogin<Bucket extends { accountEmail?: string }>(
  flavor: GoogleProviderFlavor<Bucket>,
  requestTimeoutMs: number | undefined,
): Promise<{ attempted: boolean; accounts: AccountResult[] }> {
  const result = await flavor.query({ requestTimeoutMs });
  if (!result) return { attempted: false, accounts: [] };
  if (!result.success) {
    return { attempted: true, accounts: [failedAccount(flavor.name, result.error)] };
  }

  const buckets = sortBuckets(flavor, result.buckets);
  const accountErrors = result.errors ?? [];
  const labels = createGoogleAccountLabelMap([
    ...buckets.map((bucket) => bucket.accountEmail),
    ...accountErrors.map((error) => error.email),
  ]);
  const accounts: AccountResult[] = [];
  for (const bucket of buckets) {
    const row = flavor.row(bucket);
    if (!row) continue;
    const { name, login } = flavor.defaultAccount(
      bucket,
      bucket.accountEmail ? labels.get(bucket.accountEmail) : undefined,
    );
    const last = accounts.at(-1);
    if (last && last.name === name && last.login === login) {
      last.rows.push(row);
    } else {
      accounts.push({ name, ...(login ? { login } : {}), rows: [row], errors: [] });
    }
  }
  for (const error of accountErrors) {
    const label = labels.get(error.email) ?? formatGoogleAccountLabel(error.email);
    accounts.push(failedAccount(label, error.error));
  }
  return { attempted: true, accounts };
}

export async function fetchGoogleProviderQuota<Bucket extends { accountEmail?: string }>(
  flavor: GoogleProviderFlavor<Bucket>,
  ctx: QuotaProviderContext,
): Promise<ProviderFetchResult> {
  const [auth, companion] = await Promise.all([flavor.inspectAuth(), flavor.inspectCompanion()]);
  const debug = statusDetailsFromRecord({
    auth_state: auth.state,
    auth_source: auth.sourceKey ?? "(none)",
    account_count: String(auth.accountCount),
    valid_account_count: String(auth.validAccountCount),
    companion_package_state: companion.state,
    companion_package_path:
      companion.state === "missing" ? "(none)" : (companion.resolvedPath ?? "(none)"),
    auth_error: auth.state === "invalid" ? sanitizeDisplayText(auth.error) : undefined,
    companion_error:
      companion.state !== "present" ? sanitizeDisplayText(companion.error) : undefined,
  });

  const requestTimeoutMs = ctx.config?.requestTimeoutMsConfigured
    ? ctx.config.requestTimeoutMs
    : undefined;
  const rows = await readCredentialRows(flavor.authKeys, { methods: ["oauth"] });
  if (rows.length > 0) {
    return {
      attempted: true,
      accounts: await fetchLoginRows(flavor, rows, requestTimeoutMs),
      debug,
    };
  }
  return { ...(await fetchDefaultLogin(flavor, requestTimeoutMs)), debug };
}
