/**
 * OpenCode Quota Plugin
 *
 * Shows quota status in OpenCode without LLM invocation.
 *
 * @packageDocumentation
 */
import { Plugin } from "@opencode/plugin";
import { sanitizeCredentialErrorText } from "./lib/display-sanitize.js";
import { HOST_CREDENTIAL_FAILURE_REASON, } from "./lib/entries.js";
import { buildQuotaDialogCommandOutput } from "./lib/quota-dialog-commands.js";
import { buildQuotaSnapshotResponse } from "./lib/quota-sidebar-cards.js";
import { collectQuotaRenderData } from "./lib/quota-render-data.js";
import { createQuotaRuntimeRequestContext, resolveQuotaRuntimeContext, } from "./lib/quota-runtime-context.js";
import { quotaRpc } from "./quota-rpc.js";
// The upstream core only needs provider enumeration and the active config;
// both are available from the V2 server context domains.
//
// A resolution that cannot be completed is reported as a visible failure
// carrying one sanitized line, so the quota credential chain can show why the
// preferred credential source produced nothing. Throwing here would abort the
// whole quota query instead.
async function resolveHostOAuthCredential(context, integrationID) {
    try {
        const connection = await context.integration.connection.active(integrationID);
        if (!connection)
            return null;
        const value = await context.integration.connection.resolve(connection);
        if (!value || value.type !== "oauth" || !value.access)
            return null;
        return {
            access: value.access,
            ...(value.refresh ? { refresh: value.refresh } : {}),
            ...(typeof value.expires === "number" ? { expiresAt: value.expires } : {}),
        };
    }
    catch (error) {
        const reason = sanitizeCredentialErrorText(error instanceof Error ? error.message : String(error));
        return {
            failed: true,
            reason: reason || HOST_CREDENTIAL_FAILURE_REASON,
        };
    }
}
function createQuotaCoreClient(context) {
    return {
        config: {
            providers: async () => {
                const response = await context.provider.list();
                return { data: { providers: response.data.map((provider) => ({ id: provider.id })) } };
            },
            get: async () => ({ data: {} }),
        },
        // OpenCode V2 keeps saved credentials in the host database and owns OAuth
        // token refresh. Expose the active connection so providers can prefer it
        // over legacy auth.json entries; a lookup that cannot be completed
        // answers with a sanitized failure instead of throwing.
        integration: {
            resolveOAuthCredential: (integrationID) => resolveHostOAuthCredential(context, integrationID),
        },
    };
}
async function loadRuntime(context, sessionID) {
    return await resolveQuotaRuntimeContext({
        client: createQuotaCoreClient(context),
        roots: {
            activeDirectory: context.location.directory,
            fallbackDirectory: context.location.directory,
        },
        sessionID,
        resolveSessionMeta: async (id) => {
            const session = await context.session.get({ sessionID: id });
            const model = session?.model;
            return model ? { modelID: model.id, providerID: model.providerID } : {};
        },
        includeSessionMeta: (config) => config.onlyCurrentModel,
    });
}
// Quota computation runs on the server through the shared upstream core; the
// TUI receives structured sidebar cards and only renders them.
export default Plugin.define({
    id: "opencode-quota-zh",
    async setup(context) {
        await context.rpc.register(quotaRpc, {
            async snapshot(input) {
                const runtime = await loadRuntime(context, input.sessionID);
                // The snapshot is the public quota data interface: it is gated only by
                // the quota background toggle, never by sidebar card visibility, so
                // hiding the card does not stop independent commands or queries.
                const result = runtime.config.enabled
                    ? await collectQuotaRenderData({
                        client: runtime.client,
                        resolveRuntimeProviderIds: runtime.resolveRuntimeProviderIds,
                        config: runtime.config,
                        configMeta: runtime.configMeta,
                        request: createQuotaRuntimeRequestContext(runtime),
                        surfaceExplicitProviderIssues: true,
                        formatStyle: "allWindows",
                        providers: runtime.providers,
                        includeAllWindowsData: true,
                    })
                    : null;
                const suppressPartialErrors = input.suppressPartialErrorsOverride ?? runtime.config.tuiSidebarPanel.suppressPartialErrors;
                const partialProviderErrors = suppressPartialErrors && result
                    ? result.providerResults.flatMap(({ result: providerResult }) => providerResult.entries.length > 0 ? providerResult.errors : [])
                    : [];
                return buildQuotaSnapshotResponse({
                    enabled: runtime.config.enabled,
                    data: result ? (result.allWindowsData ?? result.data) : null,
                    suppressPartialErrors,
                    partialProviderErrors,
                });
            },
            async settings() {
                const runtime = await loadRuntime(context);
                return {
                    suppressPartialErrors: runtime.config.tuiSidebarPanel.suppressPartialErrors,
                };
            },
            async command(input) {
                // Commands run against the connected server's location, config and
                // storage. Credentials never cross the RPC boundary to the TUI.
                return buildQuotaDialogCommandOutput({
                    command: input.command,
                    arguments: input.arguments,
                    sessionID: input.sessionID,
                    client: createQuotaCoreClient(context),
                    roots: {
                        activeDirectory: context.location.directory,
                        fallbackDirectory: context.location.directory,
                    },
                    resolveSessionMeta: async (id) => {
                        const session = await context.session.get({ sessionID: id });
                        const model = session?.model;
                        return model ? { modelID: model.id, providerID: model.providerID } : {};
                    },
                });
            },
        });
    },
});
// Re-export types for consumers (types are erased at runtime, so safe to export)
export { QUOTA_PROVIDER_MODES, QUOTA_PROVIDER_REMOTE_FORMATS, QUOTA_PROVIDER_WINDOW_TYPES, validateQuotaProviders, } from "./lib/quota-providers.js";
