// The single local bridge between the native v6 TUI and the local quota card.
// The native TUI setup (src/v6/tui/index.tsx) creates its SurfaceHost — the
// draft quota client and the settings editor's display — and publishes it here;
// the local TUI entry reads it from 03 on instead of building a second copy of
// the quota settings. This module is plain TypeScript: no JSX, and only a
// type-only import of the host shape.
//
// The bridge lives on globalThis under a Symbol.for key, because the plugin's
// modules can be loaded twice in one process: the server entry (dist/index.js)
// and the raw-TSX CLI entry (dist/tui-v2.tsx, which re-exports the native TUI
// plugin) each get their own module graph. Symbol.for makes both graphs share
// one host record, so a publish from either side is visible to the other.
import type { SurfaceHost } from "./v6/tui/sidebar.js"

const BRIDGE_KEY = Symbol.for("opencode-quota-zh.tui-host.v1")

type QuotaHostBridge = {
  /** The published host, or undefined before the first publish and after its cleanup. */
  host: SurfaceHost | undefined
  /**
   * The generation that owns `host`. Each publish gets its own token, so a
   * cleanup only clears the host it published: a newer publish keeps its host
   * even when an older cleanup runs later (remount or teardown order).
   */
  generation: object | undefined
  listeners: Set<() => void>
}

function bridgeState(): QuotaHostBridge {
  const scope = globalThis as typeof globalThis & {
    [key: symbol]: QuotaHostBridge | undefined
  }
  let state = scope[BRIDGE_KEY]
  if (!state) {
    state = { host: undefined, generation: undefined, listeners: new Set() }
    scope[BRIDGE_KEY] = state
  }
  return state
}

function notify(state: QuotaHostBridge): void {
  // Copy first: a listener may subscribe or unsubscribe while being notified.
  for (const listener of [...state.listeners]) listener()
}

/**
 * Publish the native TUI's host and notify the subscribers. The returned
 * function revokes this publish only: if a newer publish already replaced the
 * host, the revoke is a no-op and the newer host stays published.
 */
export function publishLocalQuotaHost(host: SurfaceHost): () => void {
  const state = bridgeState()
  const generation = {}
  state.host = host
  state.generation = generation
  notify(state)
  let revoked = false
  return () => {
    if (revoked) return
    revoked = true
    if (state.generation !== generation) return
    state.host = undefined
    state.generation = undefined
    notify(state)
  }
}

/** The published host, or undefined while none is published. */
export function readLocalQuotaHost(): SurfaceHost | undefined {
  return bridgeState().host
}

/**
 * Call `listener` after every publish and revoke. The returned function
 * unsubscribes; it is safe to call more than once.
 */
export function subscribeLocalQuotaHost(listener: () => void): () => void {
  const state = bridgeState()
  state.listeners.add(listener)
  return () => {
    state.listeners.delete(listener)
  }
}
