/**
 * The server's quota store. It keeps the last known rows of every provider (in memory and in
 * one snapshot file), refreshes them in the background, and tells subscribers when they change.
 *
 * - `snapshot()` answers at once from what is known; when a provider is due it starts a
 *   background refresh.
 * - Refreshes are single-flight per provider and keep a minimum interval (30 s after a turn,
 *   none for a manual or retry refresh); failures back off from 1 to 15 minutes, or until the
 *   provider's own retry time.
 * - Every snapshot, refresh, login-change and settings-change pass is one operation: it reads
 *   the providers and who each one is signed in as once, and keeps both to its end. A login or
 *   settings change starts a new generation: an operation of an older one stores nothing and
 *   tells subscribers nothing, and a snapshot or refresh it was answering answers with the
 *   providers and rows of the new one.
 * - Rows and reset notices belong to an identity (account plus provider settings). Those of
 *   another identity are never shown; those whose identity can't be saved stay in memory and
 *   go on a login change.
 * - Rows also carry their login. A failed refresh keeps the last good rows and records the
 *   error; when one of several logins fails, that login keeps its last rows. Logins that share
 *   an account name are numbered here ("Pro", "Pro 2"), by login, so the numbers stay put;
 *   numbers skip names other rows already have.
 * - When a quota window resets between two checks, a reset notice is recorded once.
 * - A fetch may bring how to write its provider's part of the export file. The store writes it
 *   from the check's rows as shown (numbered like the snapshot) and the error it records, and
 *   keeps the last check's part in memory only, never in the file.
 * - Subscribers hear of every change: a fetch, the rows read from the file at the start, and a
 *   change in which providers are on.
 * - Reads from OpenCode and provider fetches have time limits, so `dispose` always ends.
 */
import { createHash, randomUUID } from "node:crypto";
import { classifyError } from "./errors.js";
import { joinNotices, readSavedState, rowSlot, writeSavedState, } from "./persist.js";
import { WINDOWS } from "./windows.js";
const TURN_MIN_INTERVAL_MS = 30_000;
const BACKOFF_FIRST_MS = 60_000;
const BACKOFF_MAX_MS = 15 * 60_000;
/** A reset notice stays in snapshots this long; each TUI shows it once. */
const RESET_NOTICE_KEEP_MS = 60 * 60_000;
/** A window that reset longer ago than this when we noticed gets no notice. */
const RESET_NOTICE_MAX_LATENESS_MS = 24 * 60 * 60_000;
/** Reading the providers or a login from OpenCode. */
const READ_TIMEOUT_MS = 15_000;
/** One provider fetch; the TUI waits up to 60 s for an RPC answer. */
const FETCH_TIMEOUT_MS = 60_000;
function hashText(text, length) {
    return createHash("sha256").update(text).digest("hex").slice(0, length);
}
function resolvedKey(providerId, identity) {
    const hash = hashText(identity.key, 32);
    return {
        key: `${providerId}|${identity.persist ? hash : `memory-${hash}`}`,
        persist: identity.persist,
    };
}
/** `promise`, or a rejection with `message` once `ms` have passed. */
function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function backoffMs(failures) {
    return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** (failures - 1));
}
function isDue(entry, reason, minIntervalMs, nowMs) {
    if (reason === "manual" || reason === "retry")
        return true;
    if (entry?.checkedAtMs === undefined || entry.checkedAtMs > nowMs)
        return true;
    // The one exception to the configured minimum: a model turn just used quota, so it may
    // refresh 30 s after the last check even when `minIntervalMs` is longer.
    let waitMs = reason === "turn" ? Math.min(minIntervalMs, TURN_MIN_INTERVAL_MS) : minIntervalMs;
    if (entry.failures > 0)
        waitMs = Math.max(waitMs, backoffMs(entry.failures));
    if (nowMs - entry.checkedAtMs < waitMs)
        return false;
    return entry.error?.retryAtMs === undefined || nowMs >= entry.error.retryAtMs;
}
/** Each fetched row with its login, shortened to a hash of the keyed id it arrives as. */
function loginRows(result) {
    return result.rows.map((row, index) => {
        const login = result.rowLogins?.[index] ?? "";
        return { login: login ? hashText(login, 16) : "", row };
    });
}
/**
 * The rows as shown. Logins that share an account name (or have none) are told apart: each
 * login after the first (by login key) gets " 2", " 3"... on all its rows ("Account 2" without
 * a name), skipping names that rows already have or got. Numbering by login keeps a login's
 * number while another login fails.
 */
function shownRows(rows) {
    const loginsByAccount = new Map();
    for (const { login, row } of rows) {
        const logins = loginsByAccount.get(row.account ?? "") ?? [];
        if (!logins.includes(login))
            logins.push(login);
        loginsByAccount.set(row.account ?? "", logins);
    }
    const taken = new Set(loginsByAccount.keys());
    /** The shown account per `${account}\u001f${login}`. */
    const shown = new Map();
    for (const [account, logins] of [...loginsByAccount].sort(([a], [b]) => (a < b ? -1 : 1))) {
        let number = 1;
        for (const login of logins.sort().slice(1)) {
            let name;
            do {
                number += 1;
                name = account ? `${account} ${number}` : `Account ${number}`;
            } while (taken.has(name));
            taken.add(name);
            shown.set(`${account}\u001f${login}`, name);
        }
    }
    return rows.map(({ login, row }) => {
        const account = shown.get(`${row.account ?? ""}\u001f${login}`);
        return account === undefined ? row : { ...row, account };
    });
}
/** Rows by slot (id, account, login); a slot that appears twice can't be matched. */
function rowsBySlot(rows) {
    const bySlot = new Map();
    for (const row of rows) {
        const slot = rowSlot(row);
        bySlot.set(slot, bySlot.has(slot) ? null : row);
    }
    return bySlot;
}
/**
 * True when `before` (its reset time first seen at `observedAtMs`, before that time) has reset
 * by now: the reset time passed less than a day ago and the new row has a later reset and more
 * left.
 */
function didReset(before, after, observedAtMs, nowMs) {
    const resetMs = Date.parse(before.resetsAt ?? "");
    const nextResetMs = Date.parse(after.resetsAt ?? "");
    if (!Number.isFinite(resetMs) || !Number.isFinite(nextResetMs))
        return false;
    if (before.percentRemaining === undefined || after.percentRemaining === undefined)
        return false;
    const lateMs = nowMs - resetMs;
    return (observedAtMs <= resetMs &&
        lateMs >= 0 &&
        lateMs <= RESET_NOTICE_MAX_LATENESS_MS &&
        nextResetMs > resetMs &&
        nextResetMs > nowMs &&
        after.percentRemaining > before.percentRemaining &&
        before.percentRemaining < 100);
}
/**
 * Reset notices for `rows` (the new rows of `previous`'s entry), with their shown accounts.
 * A notice's id names its row's slot (id, account, login), so each login's reset is one notice.
 */
function findResets(previous, rows, nowMs) {
    const before = rowsBySlot(previous.rows);
    const after = rowsBySlot(rows);
    const shown = shownRows(rows);
    const notices = [];
    rows.forEach((current, index) => {
        const slot = rowSlot(current);
        const old = before.get(slot)?.row;
        const { row } = current;
        if (!old || after.get(slot) === null)
            return;
        if (row.type !== "quota" || !row.window || !WINDOWS[row.window].resets)
            return;
        const observedAtMs = previous.resetSeenAtMs[slot] ?? previous.okAtMs;
        if (observedAtMs === undefined || !didReset(old, row, observedAtMs, nowMs))
            return;
        const account = shown[index]?.account;
        notices.push({
            id: `${row.id}|${row.account ?? ""}|${current.login}|${old.resetsAt}`,
            rowId: row.id,
            providerId: row.providerId,
            ...(account === undefined ? {} : { account }),
            label: row.label,
            window: row.window,
            percentRemaining: row.percentRemaining,
            atMs: nowMs,
        });
    });
    return notices;
}
/**
 * When each row's reset time was first seen. A provider that repeats a reset time already past
 * keeps the earlier observation, so the refill it reports later still counts as a reset.
 */
function resetSeenTimes(previous, rows, nowMs) {
    const before = rowsBySlot(previous?.rows ?? []);
    const seen = {};
    for (const current of rows) {
        if (!current.row.resetsAt)
            continue;
        const slot = rowSlot(current);
        const earlier = previous?.resetSeenAtMs[slot];
        const sameReset = before.get(slot)?.row.resetsAt === current.row.resetsAt;
        seen[slot] = earlier !== undefined && sameReset ? earlier : nowMs;
    }
    return seen;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export function createQuotaStore(deps) {
    const now = deps.now ?? Date.now;
    const log = deps.log ?? ((message) => console.warn(`[opencode-quota] ${message}`));
    const timeouts = deps.timeouts ?? { readMs: READ_TIMEOUT_MS, fetchMs: FETCH_TIMEOUT_MS };
    const entries = new Map();
    const inFlight = new Map();
    /** Running fetches per provider (an old one may still run after a login change). */
    const fetching = new Map();
    const listeners = new Set();
    /** Running operations and background refreshes; `dispose` waits for them. */
    const tasks = new Set();
    /** Bumped on every login change; operations of an older generation are stale. */
    let generation = 0;
    let disposed = false;
    let loaded;
    let writing;
    let writeAgain = false;
    /** Names this store in its snapshots, so a TUI can tell a restarted server apart. */
    const serverId = randomUUID();
    /** The last snapshot's revision; each next snapshot gets one more. */
    let revision = 0;
    /** The provider ids subscribers last heard of; undefined until the first snapshot. */
    let heardProviders;
    function track(promise) {
        tasks.add(promise);
        promise
            .finally(() => {
            tasks.delete(promise);
        })
            .catch(() => { });
        return promise;
    }
    /** Runs one operation as a tracked task, from before its first read; none after dispose. */
    function start(work) {
        if (disposed)
            return Promise.reject(new Error("the quota store is disposed"));
        return track(work());
    }
    function isCurrent(operation) {
        return operation.generation === generation;
    }
    function adopt(saved) {
        for (const [key, entry] of saved.entries) {
            const ours = entries.get(key);
            if (!ours || (ours.checkedAtMs ?? 0) < (entry.checkedAtMs ?? 0)) {
                entries.set(key, { ...entry, persist: true });
            }
            else {
                ours.notices = joinNotices(ours.notices, entry.notices);
            }
        }
    }
    function load() {
        loaded ??= deps.file ? readSavedState(deps.file).then(adopt) : Promise.resolve();
        return loaded;
    }
    async function writeFile(file) {
        const saved = new Map();
        for (const [key, { persist: keep, exportPart: _memoryOnly, ...entry }] of entries) {
            if (keep)
                saved.set(key, entry);
        }
        try {
            const options = { nowMs: now(), noticeMaxAgeMs: RESET_NOTICE_KEEP_MS };
            adopt(await writeSavedState(file, { entries: saved }, options));
        }
        catch (error) {
            log(`could not save the quota snapshot: ${errorMessage(error)}`);
        }
    }
    /** Writes the file soon; writes asked for while one runs are joined into one more write. */
    function persist() {
        const file = deps.file;
        if (!file)
            return;
        if (writing) {
            writeAgain = true;
            return;
        }
        writing = writeFile(file).finally(() => {
            writing = undefined;
            if (writeAgain) {
                writeAgain = false;
                persist();
            }
        });
    }
    async function flush() {
        while (writing)
            await writing;
    }
    /** Who `provider` is signed in as now; unknown (memory only) when that can't be read. */
    async function resolveKey(provider) {
        try {
            const message = `reading the ${provider.id} login timed out`;
            return resolvedKey(provider.id, await withTimeout(provider.identity(), timeouts.readMs, message));
        }
        catch {
            return resolvedKey(provider.id, { key: "unknown", persist: false });
        }
    }
    /** Starts an operation: loads the file once, reads the providers and who each one is. */
    async function prepare() {
        const startedIn = generation;
        await load();
        const message = "reading the quota providers timed out";
        const source = await withTimeout(deps.source(), timeouts.readMs, message);
        const keys = new Map();
        await Promise.all(source.providers.map(async (provider) => {
            keys.set(provider.id, await resolveKey(provider));
        }));
        const operation = { generation: startedIn, source, keys };
        // The rows read from the file, or a provider turned on or off, are news to subscribers.
        if (providerIdsOf(operation) !== heardProviders)
            emit(operation);
        return operation;
    }
    /** The snapshot an operation sees; a stale one shows no rows (whose they are is unknown). */
    function buildSnapshot(operation, model) {
        const nowMs = now();
        const current = isCurrent(operation);
        const resetNotices = [];
        const providers = operation.source.providers.map((provider) => {
            const key = current ? operation.keys.get(provider.id)?.key : undefined;
            const entry = key === undefined ? undefined : entries.get(key);
            for (const notice of entry?.notices ?? []) {
                if (nowMs - notice.atMs <= RESET_NOTICE_KEEP_MS)
                    resetNotices.push(notice);
            }
            return {
                providerId: provider.id,
                label: provider.label,
                rows: shownRows(entry?.rows ?? []),
                ...(entry?.okAtMs === undefined ? {} : { okAtMs: entry.okAtMs }),
                ...(entry?.checkedAtMs === undefined ? {} : { checkedAtMs: entry.checkedAtMs }),
                ...(entry?.error === undefined ? {} : { error: entry.error }),
                refreshing: fetching.has(provider.id),
                debug: entry?.debug ?? [],
                ...(entry?.exportPart === undefined ? {} : { exportPart: entry.exportPart }),
            };
        });
        revision += 1;
        const snapshot = {
            version: 6,
            providers,
            resetNotices,
            generatedAtMs: nowMs,
            serverId,
            revision,
        };
        const { providerIdsForModel, rowPrefixesForModel } = operation.source;
        if (model && (model.id || model.providerID) && providerIdsForModel) {
            const shown = new Set(providers.map((provider) => provider.providerId));
            snapshot.currentModelProviderIds = providerIdsForModel(model).filter((id) => shown.has(id));
            if (rowPrefixesForModel)
                snapshot.currentModelRowPrefixes = rowPrefixesForModel(model);
        }
        return snapshot;
    }
    function providerIdsOf(operation) {
        return JSON.stringify(operation.source.providers.map((provider) => provider.id));
    }
    function emit(operation) {
        if (listeners.size === 0 || !isCurrent(operation))
            return;
        heardProviders = providerIdsOf(operation);
        const snapshot = buildSnapshot(operation);
        for (const listener of listeners) {
            try {
                listener(snapshot);
            }
            catch (error) {
                log(`a quota snapshot subscriber failed: ${errorMessage(error)}`);
            }
        }
    }
    function record(provider, where, result) {
        const nowMs = now();
        const previous = entries.get(where.key);
        const fresh = loginRows(result);
        const gotRows = fresh.length > 0;
        const error = result.error ?? (gotRows ? undefined : { code: "no_data" });
        // With an error, the logins that did not answer keep their last rows.
        const answered = new Set(fresh.map((row) => row.login));
        const kept = gotRows && result.error
            ? (previous?.rows ?? []).filter((row) => !answered.has(row.login))
            : [];
        const rows = gotRows ? [...fresh, ...kept] : (previous?.rows ?? []);
        const found = gotRows && previous ? findResets(previous, rows, nowMs) : [];
        const notices = joinNotices((previous?.notices ?? []).filter((notice) => nowMs - notice.atMs <= RESET_NOTICE_KEEP_MS), found);
        const okAtMs = gotRows ? nowMs : previous?.okAtMs;
        // The check's own rows, numbered among the kept ones as the snapshot numbers them.
        const exportPart = result.buildExportPart?.({
            rows: shownRows(rows).slice(0, fresh.length),
            ...(error === undefined ? {} : { error }),
            checkedAtMs: nowMs,
        });
        entries.set(where.key, {
            providerId: provider.id,
            persist: where.persist,
            rows,
            ...(okAtMs === undefined ? {} : { okAtMs }),
            checkedAtMs: nowMs,
            ...(error === undefined ? {} : { error }),
            // Any error backs off, also when only one of several logins failed.
            failures: error === undefined ? 0 : (previous?.failures ?? 0) + 1,
            debug: result.debug,
            ...(exportPart === undefined ? {} : { exportPart }),
            notices,
            resetSeenAtMs: gotRows
                ? resetSeenTimes(previous, rows, nowMs)
                : (previous?.resetSeenAtMs ?? {}),
        });
        persist();
    }
    async function fetchProvider(provider) {
        fetching.set(provider.id, (fetching.get(provider.id) ?? 0) + 1);
        try {
            const message = `Request timeout after ${Math.round(timeouts.fetchMs / 1000)}s`;
            return await withTimeout(provider.fetch(), timeouts.fetchMs, message);
        }
        catch (error) {
            return { rows: [], error: classifyError(errorMessage(error), now()), debug: [] };
        }
        finally {
            const left = (fetching.get(provider.id) ?? 1) - 1;
            if (left > 0)
                fetching.set(provider.id, left);
            else
                fetching.delete(provider.id);
        }
    }
    async function refreshProviderNow(operation, provider, reason) {
        const where = operation.keys.get(provider.id);
        if (!where)
            return;
        const minIntervalMs = provider.minIntervalMs ?? operation.source.minIntervalMs;
        if (!isDue(entries.get(where.key), reason, minIntervalMs, now()))
            return;
        const result = await fetchProvider(provider);
        // A fetch is stored only under the account it read. A login change (new generation) or
        // another account now (same generation) drops its answer.
        if (!isCurrent(operation))
            return;
        const after = await resolveKey(provider);
        if (!isCurrent(operation))
            return;
        if (after.key !== where.key) {
            operation.keys.set(provider.id, after);
            return;
        }
        record(provider, where, result);
        emit(operation);
    }
    function refreshProvider(operation, provider, reason) {
        // A stale operation never joins or starts a refresh: one of the new generation would join
        // its run, which fetches nothing.
        if (disposed || !isCurrent(operation))
            return Promise.resolve();
        const running = inFlight.get(provider.id);
        if (running)
            return running;
        const run = refreshProviderNow(operation, provider, reason).finally(() => {
            if (inFlight.get(provider.id) === run)
                inFlight.delete(provider.id);
        });
        inFlight.set(provider.id, run);
        return run;
    }
    async function runRefresh(operation, options) {
        const providers = options.providerIds
            ? operation.source.providers.filter((provider) => options.providerIds?.includes(provider.id))
            : operation.source.providers;
        await Promise.all(providers.map((provider) => refreshProvider(operation, provider, options.reason)));
    }
    /** An operation of the current generation: a login or settings change meanwhile reads again. */
    async function prepareCurrent() {
        for (;;) {
            const operation = await prepare();
            if (isCurrent(operation))
                return operation;
        }
    }
    /**
     * Starts a new generation: running operations store and tell nothing more, and a new pass
     * reads the providers and logins, tells subscribers, then refreshes for `reason`.
     */
    function supersede(reason, failure) {
        generation += 1;
        inFlight.clear();
        // Subscribers see the new providers and rows (or none) before any fetch, then fresh ones.
        start(async () => {
            const operation = await prepare();
            emit(operation);
            await runRefresh(operation, { reason });
        }).catch((error) => {
            log(`${failure}: ${errorMessage(error)}`);
        });
    }
    return {
        snapshot(options = {}) {
            return start(async () => {
                const operation = await prepareCurrent();
                if (options.refresh !== false) {
                    track(runRefresh(operation, { reason: "poll" })).catch((error) => {
                        log(`background quota refresh failed: ${errorMessage(error)}`);
                    });
                }
                return buildSnapshot(operation, options.model);
            });
        },
        refresh(options) {
            return start(async () => {
                const operation = await prepareCurrent();
                await runRefresh(operation, options);
                await flush();
                // A login or settings change dropped what this pass fetched: the answer shows the
                // providers and rows of now, and the new pass's rows follow as events.
                const answering = isCurrent(operation) ? operation : await prepareCurrent();
                return buildSnapshot(answering, options.model);
            });
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        invalidateIdentity() {
            if (disposed)
                return;
            for (const [key, entry] of entries) {
                if (!entry.persist)
                    entries.delete(key);
            }
            supersede("poll", "quota refresh after a login change failed");
        },
        settingsChanged({ recheck }) {
            if (disposed)
                return;
            if (!recheck) {
                supersede("poll", "quota refresh after a settings change failed");
                return;
            }
            for (const entry of entries.values())
                entry.failures = 0;
            // A manual refresh waits for no interval: every provider is checked again now.
            supersede("manual", "quota recheck after a settings change failed");
        },
        async dispose() {
            disposed = true;
            listeners.clear();
            while (tasks.size > 0)
                await Promise.allSettled([...tasks]);
            await flush();
        },
    };
}
