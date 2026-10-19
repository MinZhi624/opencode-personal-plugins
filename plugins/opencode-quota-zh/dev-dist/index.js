/**
 * OpenCode Quota Plugin
 *
 * Shows quota status in OpenCode without LLM invocation.
 *
 * The server entry runs the fixed upstream v6 quota backend and adds the
 * local RPCs on top of it: the structured quota snapshot the Chinese sidebar
 * card renders, the v6 price list in use, one session tree's usage read
 * straight out of the v6 usage report, and the announcement when the price
 * list in use really changes. Providers, authentication,
 * multi-account state, caching, settings, commands, hooks and reports stay
 * upstream's; this file only adapts v6 answers for the local card.
 *
 * @packageDocumentation
 */
import { Plugin } from "@opencode/plugin";
import { buildV6QuotaSnapshotResponse } from "./lib/quota-sidebar-cards.js";
import { quotaRpc } from "./quota-rpc.js";
import { sessionUsageReport } from "./v6/core/usage.js";
import { getPricingSnapshotForClients, subscribePricingSnapshotChanges, } from "./v6/lib/modelsdev-pricing.js";
import { QuotaToastPlugin } from "./v6/plugin.js";
import { QuotaRpc } from "./v6/rpc.js";
// The upstream v6 backend is the only quota implementation here: its setup
// registers its own RPC, agent tools, slash commands, session hooks, settings
// watch and credential binding, and returns the teardown for all of them. It
// runs under the stable local plugin id, so the bundle keeps one server
// plugin while every quota behavior stays upstream's.
export default Plugin.define({
    id: "opencode-quota-zh",
    async setup(context) {
        const upstreamTeardown = await QuotaToastPlugin.setup(context);
        const releaseUpstream = async () => {
            // The upstream setup always answers with its teardown; the guard only
            // satisfies the Plugin.Cleanup | void type.
            if (typeof upstreamTeardown === "function")
                await upstreamTeardown();
        };
        try {
            // Registered after the upstream setup, so the v6 route it calls is in
            // place before any local call can arrive. Upstream keeps publishing its
            // own `changed` events on its own RPC channel; the local quota RPC adds
            // one event of its own, `pricingChanged`, announced here whenever the
            // price list in use really changes, so a consumer can drop the costs it
            // already displayed instead of waiting for its next poll.
            const registration = await context.rpc.register(quotaRpc, {
                snapshot: async (input) => {
                    // The v6 backend answers with its structured snapshot; this layer
                    // only converts it into sidebar cards. A failed query propagates as
                    // an RPC error, so the card shows a failure instead of invented
                    // data, and credentials never cross the boundary.
                    const { snapshot } = await context.rpc(QuotaRpc).snapshot({
                        ...(input.sessionID !== undefined ? { sessionID: input.sessionID } : {}),
                    });
                    return buildV6QuotaSnapshotResponse(snapshot);
                },
                pricing: async () => {
                    // The v6 price list already in use: the same loaded snapshot the
                    // report costs with, so no second cache, no download and no
                    // credentials cross this boundary. An empty list stays visible as
                    // `source: "empty"` instead of being disguised as zero prices.
                    return getPricingSnapshotForClients();
                },
                sessionUsage: async (input) => {
                    // The one cached v6 session report, read exactly as it stands: own,
                    // tree and every session share its numbers, its price snapshot
                    // labels and its time point, so the sidebar tree cannot drift from
                    // the v6 session usage. A failed report propagates as an RPC error
                    // instead of a complete-looking zero, and the lifecycle, the
                    // snapshot and the pricing routes stay untouched here.
                    return sessionUsageReport(input.sessionID);
                },
            });
            // Subscribed once the local registration exists, so every announcement
            // rides this registration's own channel: a fresh download, another
            // source or another selection reaches a consumer as `pricingChanged`,
            // with the same `generatedAt` and `selection` the `pricing` route
            // answers with. The first load of the process announces nothing.
            const stopPricingSubscription = subscribePricingSnapshotChanges((info) => {
                // Fire-and-forget: the announcement must never hold up price loading
                // or the download, and a failed emit leaves one fixed line behind —
                // the original error is not logged.
                void registration.events.emit("pricingChanged", info).catch(() => {
                    console.warn("[opencode-quota] pricingChanged event failed");
                });
            });
            return async () => {
                // Stop hearing about price changes before the route that carries them
                // goes away: no announcement may outlive its registration. The stop
                // itself cannot fail, and it runs either way so the local route and
                // the upstream backend are always released.
                try {
                    stopPricingSubscription();
                }
                finally {
                    // Drop the local route first, then release the upstream backend: its
                    // teardown closes the settings watch, the store subscription and the
                    // snapshot publisher, and unbinds the credential source.
                    try {
                        await registration.dispose();
                    }
                    finally {
                        // A failed local teardown must not keep the upstream backend
                        // running: the release happens either way.
                        await releaseUpstream();
                    }
                }
            };
        }
        catch (error) {
            // The upstream backend is already running at this point; a failed local
            // registration must not leave it active without a teardown.
            try {
                await releaseUpstream();
            }
            catch (cleanupError) {
                // The registration failure stays the reported one; a teardown failure
                // on this path rides along in the aggregate instead of replacing it,
                // and nothing is logged unsanitized here.
                throw new AggregateError([error, cleanupError], "opencode-quota-zh setup failed");
            }
            throw error;
        }
    },
});
