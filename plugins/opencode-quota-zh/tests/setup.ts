import { afterEach, beforeEach, vi } from "vitest";

/**
 * Offline baseline guard (Ticket 01): force-block real network egress for the
 * whole offline test baseline. Per-test mocks still override the guard:
 *  - `vi.stubGlobal("fetch", ...)` replaces the fetch stub for that test;
 *  - the node:http/https/net/tls/dns entry points stay blocked unless a test
 *    explicitly re-mocks them.
 * Any test that reaches a real network entry point without a mock fails fast
 * instead of leaking traffic.
 *
 * The guard covers the entry points used by the current src call paths.
 * Unguarded built-in network entries (e.g. node:http2, other node:net
 * constructors) are NOT on any current src call path; if a new code path
 * starts using one, block it here before adding the test.
 */
const OFFLINE_GUARD_MESSAGE =
  "offline test baseline: real network egress is blocked (stub fetch/http/https/net/tls/dns in the test instead)";

function offlineBlocker(): never {
  throw new Error(OFFLINE_GUARD_MESSAGE);
}

// Module-level mocks apply to every test file that loads this setup. The
// factories keep the untouched exports of each builtin so the rest of the
// module keeps working (e.g. node:net's isIP used by src/lib/quota-providers.ts).
vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    get: offlineBlocker,
    request: offlineBlocker,
  };
});
vi.mock("node:https", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:https")>();
  return {
    ...actual,
    get: offlineBlocker,
    request: offlineBlocker,
  };
});
vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    connect: offlineBlocker,
    createConnection: offlineBlocker,
  };
});
vi.mock("node:tls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:tls")>();
  return {
    ...actual,
    connect: offlineBlocker,
  };
});
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  return {
    ...actual,
    lookup: offlineBlocker,
    resolve: offlineBlocker,
    resolve4: offlineBlocker,
    resolve6: offlineBlocker,
    lookupService: offlineBlocker,
    promises: {
      ...actual.promises,
      lookup: offlineBlocker,
      resolve: offlineBlocker,
    },
  };
});

beforeEach(() => {
  // fetch is a global, so it cannot be vi.mock'ed. Stub it before every test:
  // a per-test `vi.stubGlobal("fetch", ...)` overrides the guard, and the
  // afterEach `vi.unstubAllGlobals()` cannot leave a later test with a live
  // fetch after this hook reinstalls it.
  vi.stubGlobal("fetch", offlineBlocker);
});

afterEach(async () => {
  try {
    const pricing = await import("../src/lib/modelsdev-pricing.js");
    pricing.__resetPricingSnapshotForTests();
  } catch {
    // best effort; tests that don't load pricing module should still clean up
  }

  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
