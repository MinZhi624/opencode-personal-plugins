const BRIDGE_KEY = Symbol.for("opencode-quota-zh.tui-host.v1");
function bridgeState() {
    const scope = globalThis;
    let state = scope[BRIDGE_KEY];
    if (!state) {
        state = { host: undefined, generation: undefined, listeners: new Set() };
        scope[BRIDGE_KEY] = state;
    }
    return state;
}
function notify(state) {
    // Copy first: a listener may subscribe or unsubscribe while being notified.
    for (const listener of [...state.listeners])
        listener();
}
/**
 * Publish the native TUI's host and notify the subscribers. The returned
 * function revokes this publish only: if a newer publish already replaced the
 * host, the revoke is a no-op and the newer host stays published.
 */
export function publishLocalQuotaHost(host) {
    const state = bridgeState();
    const generation = {};
    state.host = host;
    state.generation = generation;
    notify(state);
    let revoked = false;
    return () => {
        if (revoked)
            return;
        revoked = true;
        if (state.generation !== generation)
            return;
        state.host = undefined;
        state.generation = undefined;
        notify(state);
    };
}
/** The published host, or undefined while none is published. */
export function readLocalQuotaHost() {
    return bridgeState().host;
}
/**
 * Call `listener` after every publish and revoke. The returned function
 * unsubscribes; it is safe to call more than once.
 */
export function subscribeLocalQuotaHost(listener) {
    const state = bridgeState();
    state.listeners.add(listener);
    return () => {
        state.listeners.delete(listener);
    };
}
