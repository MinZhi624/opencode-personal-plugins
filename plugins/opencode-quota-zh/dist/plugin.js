/**
 * OpenCode Quota Toast Plugin
 *
 * Shows a minimal quota status toast without LLM invocation.
 * Triggers on session.idle, session.compacted, and question tool completion.
 * Supports GitHub Copilot and Google (via opencode-antigravity-auth).
 */
import { isMainThread } from "node:worker_threads";
import { tool } from "@opencode-ai/plugin";
import { handled } from "./lib/command-handled.js";
import { shouldRegisterServerSlashCommands } from "./lib/command-surfaces.js";
import { findGitWorktreeRoot, getEffectiveConfigRoot } from "./lib/config-file-utils.js";
import { sanitizeDisplayText } from "./lib/display-sanitize.js";
import { reconcileDetectedProvidersInGlobalConfig } from "./lib/opencode-config-providers.js";
import { buildQuotaDialogCommandOutput, isQuotaDialogCommand, QUOTA_DIALOG_COMMANDS, } from "./lib/quota-dialog-commands.js";
import { disposeQuotaTelemetryOwner } from "./lib/quota-telemetry.js";
import { createQuotaToastRuntime } from "./lib/quota-toast-runtime.js";
function normalizeDefaultAgent(cfg) {
    if (!cfg?.default_agent || !cfg.agent || cfg.default_agent in cfg.agent)
        return;
    const stripped = (value) => value.replace(/[\u200B\u200C\u200D\uFEFF]/g, "");
    const target = stripped(cfg.default_agent);
    const matches = Object.keys(cfg.agent).filter((key) => stripped(key) === target);
    if (matches.length === 1) {
        cfg.default_agent = matches[0];
    }
}
// =============================================================================
// Plugin Implementation
// =============================================================================
/**
 * Main plugin export
 */
export const QuotaToastPlugin = async ({ client, directory }) => {
    const typedClient = client;
    let opencodeConfig = null;
    /**
     * Inject tool output directly into the session without triggering an LLM response.
     * This prevents models from summarizing/rewriting our carefully formatted reports.
     */
    async function injectRawOutput(sessionID, output, options = {}) {
        normalizeDefaultAgent(opencodeConfig);
        try {
            await typedClient.session.prompt({
                path: { id: sessionID },
                body: {
                    noReply: true,
                    // ignored=true keeps this out of future model context while still
                    // showing it to the user in the transcript.
                    parts: [{ type: "text", text: sanitizeDisplayText(output), ignored: true }],
                },
            });
        }
        catch (err) {
            // Log but don't fail by default - tool output can still be returned.
            await typedClient.app.log({
                body: {
                    service: "quota-toast",
                    level: "warn",
                    message: "Failed to inject raw output",
                    extra: { error: err instanceof Error ? err.message : String(err) },
                },
            });
            if (options.rethrow) {
                throw err;
            }
        }
    }
    let providerConfigReconcileQueue = Promise.resolve();
    // Track last session token error for /quota_status diagnostics
    let lastSessionTokenError;
    function getPluginRuntimeRootHints() {
        const cwd = directory || process.cwd();
        const workspaceRoot = findGitWorktreeRoot(cwd) ?? cwd;
        const configRoot = getEffectiveConfigRoot(workspaceRoot);
        return {
            workspaceRoot,
            configRoot,
            fallbackDirectory: cwd,
        };
    }
    function registerDeterministicSlashCommands(cfg) {
        cfg.command ??= {};
        for (const spec of QUOTA_DIALOG_COMMANDS) {
            cfg.command[spec.id] = {
                template: `/${spec.slashName}`,
                description: spec.description,
            };
        }
    }
    async function handleDeterministicSlashCommand(input) {
        const command = input.command;
        const result = await buildQuotaDialogCommandOutput({
            command,
            arguments: input.arguments,
            client: typedClient,
            roots: getPluginRuntimeRootHints(),
            sessionID: input.sessionID,
            resolveSessionMeta: (sessionID) => getSessionModelMeta(sessionID),
            lastSessionTokenError,
            setLastSessionTokenError: (error) => {
                lastSessionTokenError = error;
            },
            log,
        });
        if (result.state === "output") {
            await injectRawOutput(input.sessionID, result.output, { rethrow: true });
        }
        handled();
    }
    /**
     * Log a message (debug level)
     */
    async function log(message, extra) {
        try {
            await typedClient.app.log({
                body: {
                    service: "quota-toast",
                    level: "debug",
                    message,
                    extra,
                },
            });
        }
        catch {
            // Ignore logging errors
        }
    }
    async function reconcileDetectedProviderConfig(providerIds) {
        if (!directory || providerIds.length === 0)
            return;
        const reconcile = async () => {
            try {
                const result = await reconcileDetectedProvidersInGlobalConfig({
                    configRootDir: getPluginRuntimeRootHints().configRoot,
                    detectedProviderIds: providerIds,
                });
                if (result.changed) {
                    await log("Added detected providers to global OpenCode config", {
                        path: result.path,
                        format: result.format,
                        providers: result.addedProviderIds,
                    });
                }
            }
            catch (error) {
                try {
                    await typedClient.app.log({
                        body: {
                            service: "quota-toast",
                            level: "warn",
                            message: "Failed to add detected providers to global OpenCode config",
                            extra: { error: error instanceof Error ? error.message : String(error) },
                        },
                    });
                }
                catch {
                    // Automatic config repair is best-effort and must not break quota output.
                }
            }
        };
        providerConfigReconcileQueue = providerConfigReconcileQueue.then(reconcile, reconcile);
        await providerConfigReconcileQueue;
    }
    /**
     * Check if session is a subagent session
     */
    async function isSubagentSession(sessionID) {
        try {
            const response = await typedClient.session.get({ path: { id: sessionID } });
            // Subagent sessions have a parentID
            return !!response.data?.parentID;
        }
        catch {
            // If we can't determine, assume it's a primary session
            return false;
        }
    }
    /**
     * Get the current model metadata from the active session.
     *
     * Only uses session-scoped model lookup. Does NOT fall back to
     * client.config.get() because that returns the global/default model
     * which can be stale across sessions.
     */
    async function getSessionModelMeta(sessionID) {
        if (!sessionID)
            return {};
        try {
            const sessionResp = await typedClient.session.get({ path: { id: sessionID } });
            return {
                modelID: sessionResp.data?.model?.id,
                providerID: sessionResp.data?.model?.providerID,
            };
        }
        catch {
            return {};
        }
    }
    const quotaToastRuntime = createQuotaToastRuntime({
        client: typedClient,
        roots: getPluginRuntimeRootHints,
        resolveSessionMeta: (sessionID) => getSessionModelMeta(sessionID),
        isSubagentSession,
        reconcileDetectedProviders: reconcileDetectedProviderConfig,
        setSessionTokenError: (error) => {
            lastSessionTokenError = error;
        },
        showToast: (body) => typedClient.tui.showToast({ body }),
        log,
        onInitialized: (extra) => {
            void typedClient.app
                .log({
                body: {
                    service: "quota-toast",
                    level: "info",
                    message: "plugin initialized",
                    extra,
                },
            })
                .catch(() => { });
        },
    });
    // Return hook implementations
    return {
        dispose: async () => {
            disposeQuotaTelemetryOwner(typedClient);
        },
        config: async (input) => {
            const cfg = input;
            opencodeConfig = cfg;
            if (shouldRegisterServerSlashCommands({ isMainThread, argv: process.argv })) {
                registerDeterministicSlashCommands(cfg);
            }
            // Keep the config-time correction for #39. injectRawOutput repeats the
            // same correction after later config hooks have run to handle #169.
            normalizeDefaultAgent(cfg);
        },
        "command.execute.before": async (input) => {
            if (!isQuotaDialogCommand(input.command))
                return;
            await handleDeterministicSlashCommand(input);
        },
        tool: {
            quota_status: tool({
                description: "Diagnostics for toast + TUI + pricing + local storage (includes unknown pricing report).",
                args: {
                    refreshGoogleTokens: tool.schema
                        .boolean()
                        .optional()
                        .describe("If true, refresh Google Antigravity access tokens before reporting"),
                    skewMs: tool.schema
                        .number()
                        .int()
                        .min(0)
                        .optional()
                        .describe("Refresh tokens expiring within this window (ms). Default: 120000"),
                    force: tool.schema
                        .boolean()
                        .optional()
                        .describe("If true, refresh even if cached token looks valid"),
                },
                async execute(args, context) {
                    const result = await buildQuotaDialogCommandOutput({
                        command: "quota_status",
                        arguments: JSON.stringify({
                            refreshGoogleTokens: args.refreshGoogleTokens,
                            skewMs: args.skewMs,
                            force: args.force,
                        }),
                        client: typedClient,
                        roots: getPluginRuntimeRootHints(),
                        sessionID: context.sessionID,
                        resolveSessionMeta: (sessionID) => getSessionModelMeta(sessionID),
                        lastSessionTokenError,
                        log,
                        onDetectedProviderIds: reconcileDetectedProviderConfig,
                    });
                    if (result.state !== "output")
                        return "";
                    context.metadata({ title: "Quota Status" });
                    await injectRawOutput(context.sessionID, result.output);
                    return ""; // Empty return - output already injected with noReply
                },
            }),
        },
        // Event hook for session.idle and session.compacted
        event: async ({ event }) => {
            const sessionID = event.properties.sessionID;
            if (!sessionID)
                return;
            if (event.type !== "session.idle" && event.type !== "session.compacted") {
                return;
            }
            await quotaToastRuntime.handleTrigger({ sessionID, trigger: event.type });
        },
        // Tool execute hook for question tool
        "tool.execute.after": async (input, _output) => {
            if (input.tool !== "question")
                return;
            await quotaToastRuntime.handleTrigger({ sessionID: input.sessionID, trigger: "question" });
        },
    };
};
