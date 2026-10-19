/**
 * The TUI's quota data: the server's last snapshot, kept in Solid signals so every surface
 * redraws when it changes. It asks the server over the quota RPC (`snapshot` when a surface
 * shows, `refresh` after a turn), applies every `changed` event, and asks again every minute
 * in case an event was missed. Nothing reaches OpenCode until a surface shows or a turn ends.
 *
 * Answers can arrive out of order. The newest snapshot (highest `revision`) wins; a snapshot
 * from another server (a new `serverId`: OpenCode restarted it) always wins, as its revisions
 * start over, and from then on the old server's answers are ignored. What a snapshot says
 * about one session comes from the latest call about it.
 */
import { createSignal } from "solid-js";
import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import { QuotaRpc, } from "../rpc.js";
const POLL_INTERVAL_MS = 60_000;
const RPC_TIMEOUT_MS = 60_000;
/**
 * Each call names the TUI's folder, so the server uses that folder's settings, and gives up
 * after a minute. The RPC client itself is made per call, never during setup.
 */
export function quotaCallOptions(host) {
    const location = host.location ?? host.data.location?.default();
    if (!location)
        throw new Error("OpenCode gave the TUI no location");
    return { location, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) };
}
/** RPC calls reject with a plain `{ type, message }` object, not an Error. */
export function rpcErrorMessage(error) {
    if (error instanceof Error)
        return error.message;
    if (typeof error === "object" && error !== null && "message" in error) {
        return String(error.message);
    }
    return String(error);
}
/** The toast for a failed call: its reason, cleaned for the terminal. */
export function errorToast(error, title = "OpenCode 额度") {
    const message = sanitizeDisplayText(rpcErrorMessage(error));
    return { variant: "error", title, message };
}
export function reportFailure(error) {
    // OpenCode answers rpc.unavailable when no server plugin registered the quota RPC here.
    const hint = typeof error === "object" &&
        error !== null &&
        "type" in error &&
        error.type === "rpc.unavailable"
        ? " (OpenCode Quota's server plugin is not loaded for this folder)"
        : "";
    console.warn(`[opencode-quota] failed to load quota: ${rpcErrorMessage(error)}${hint}`);
}
/**
 * @param onSnapshot called with every snapshot the client takes (from any call or event), so
 *   toasts can announce new reset notices.
 */
export function createQuotaClient(host, onSnapshot = () => { }) {
    const [latest, setLatest] = createSignal();
    const [sessions, setSessions] = createSignal({});
    const [homeLine, setHomeLine] = createSignal("");
    /** Sessions on screen, with how many surfaces show each. */
    const watched = new Map();
    /** Surfaces on screen without a session (the status line on Home). */
    let globalWatchers = 0;
    let homeWatchers = 0;
    let running = false;
    /** Numbers every call; a session's part is kept only from a later call than the last one. */
    let calls = 0;
    const sessionCalls = new Map();
    /** Servers this client moved away from; their answers are ignored. */
    const retiredServers = new Set();
    /** Bumped when the TUI stops: answers to calls made before then are dropped. */
    let mount = 0;
    /** Snapshot calls on their way, by session ("" for none), with their call numbers. */
    const loading = new Map();
    /** The `changed` subscription while running, made with the first snapshot call. */
    let events;
    const rpc = () => host.client.rpc(QuotaRpc);
    /** `call` numbers the request a session's part came from. */
    function apply(snapshot, session) {
        const { currentModelProviderIds, currentModelRowPrefixes, sessionTokens, ...shared } = snapshot;
        if (retiredServers.has(shared.serverId))
            return;
        // An answer that left before a newer snapshot arrived must not undo it.
        const current = latest();
        if (current && current.serverId !== shared.serverId)
            retiredServers.add(current.serverId);
        if (!current || current.serverId !== shared.serverId || current.revision < shared.revision) {
            setLatest(shared);
        }
        if (session && session.call > (sessionCalls.get(session.id) ?? 0)) {
            sessionCalls.set(session.id, session.call);
            setSessions((all) => ({
                ...all,
                [session.id]: {
                    ...(currentModelProviderIds ? { currentModelProviderIds } : {}),
                    ...(currentModelRowPrefixes ? { currentModelRowPrefixes } : {}),
                    ...(sessionTokens ? { sessionTokens } : {}),
                },
            }));
        }
        onSnapshot(snapshot);
    }
    function subscribe() {
        if (!running || events)
            return;
        events = new AbortController();
        const signal = events.signal;
        try {
            rpc().events.on("changed", (event) => {
                if (!signal.aborted)
                    apply(event.data.snapshot);
            }, { signal });
        }
        catch (error) {
            // The poll still updates every minute.
            reportFailure(error);
        }
    }
    function load(sessionID) {
        // The sidebar and the status line of one session ask together; one call answers both.
        const key = sessionID ?? "";
        if (loading.has(key))
            return;
        const call = ++calls;
        const at = mount;
        loading.set(key, call);
        subscribe();
        rpc()
            .snapshot(sessionID ? { sessionID } : {}, quotaCallOptions(host))
            .then((output) => {
            if (at === mount)
                apply(output.snapshot, sessionID ? { id: sessionID, call } : undefined);
        })
            .catch(reportFailure)
            .finally(() => {
            if (loading.get(key) === call)
                loading.delete(key);
        });
    }
    function loadHomeLine() {
        const at = mount;
        rpc()
            .notices({}, quotaCallOptions(host))
            .then((output) => {
            if (at === mount)
                setHomeLine(output.homeLine);
        })
            .catch(reportFailure);
    }
    function snapshot(sessionID) {
        const shared = latest();
        if (!shared)
            return undefined;
        const part = sessionID ? sessions()[sessionID] : undefined;
        return part ? { ...shared, ...part } : shared;
    }
    function poll() {
        if (globalWatchers > 0)
            load();
        for (const sessionID of watched.keys())
            load(sessionID);
        if (homeWatchers > 0)
            loadHomeLine();
    }
    return {
        snapshot,
        homeLine,
        watch(sessionID) {
            if (!sessionID) {
                globalWatchers += 1;
                load();
                return () => {
                    globalWatchers -= 1;
                };
            }
            watched.set(sessionID, (watched.get(sessionID) ?? 0) + 1);
            load(sessionID);
            return () => {
                const count = (watched.get(sessionID) ?? 1) - 1;
                if (count > 0)
                    watched.set(sessionID, count);
                else
                    watched.delete(sessionID);
            };
        },
        watchHome() {
            homeWatchers += 1;
            loadHomeLine();
            return () => {
                homeWatchers -= 1;
            };
        },
        async refresh(reason, sessionID) {
            try {
                const input = sessionID ? { reason, sessionID } : { reason };
                const call = ++calls;
                const at = mount;
                subscribe();
                const output = await rpc().refresh(input, quotaCallOptions(host));
                if (at !== mount)
                    return undefined;
                apply(output.snapshot, sessionID ? { id: sessionID, call } : undefined);
                return snapshot(sessionID);
            }
            catch (error) {
                reportFailure(error);
                return undefined;
            }
        },
        start() {
            running = true;
            // After a reconnect, the surfaces already on screen ask again at once.
            poll();
            const timer = setInterval(poll, POLL_INTERVAL_MS);
            let stopped = false;
            return () => {
                if (stopped)
                    return;
                stopped = true;
                running = false;
                mount += 1;
                loading.clear();
                events?.abort();
                events = undefined;
                clearInterval(timer);
            };
        },
    };
}
