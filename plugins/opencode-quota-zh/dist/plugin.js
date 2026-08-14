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
import { createLoadConfigMeta } from "./lib/config.js";
import { findGitWorktreeRoot, getEffectiveConfigRoot } from "./lib/config-file-utils.js";
import { sanitizeDisplayText } from "./lib/display-sanitize.js";
import { maybeRefreshPricingSnapshot, setPricingSnapshotAutoRefresh, setPricingSnapshotSelection, } from "./lib/modelsdev-pricing.js";
import { reconcileDetectedProvidersInGlobalConfig } from "./lib/opencode-config-providers.js";
import { buildQuotaDialogCommandOutput, isQuotaDialogCommand, QUOTA_DIALOG_COMMANDS, } from "./lib/quota-dialog-commands.js";
import { resolveQuotaFormatStyle } from "./lib/quota-format-style.js";
import { collectQuotaRenderData } from "./lib/quota-render-data.js";
import { buildUnifiedQuotaSnapshot, evaluateQuotaDangerMetrics } from "./lib/quota-snapshot.js";
import { formatQuotaAlertNotificationText, pruneQuotaAlertEpisodes, readQuotaAlertEpisodes, transitionAlertEpisodes, writeQuotaAlertEpisodes, } from "./lib/quota-alert-episodes.js";
import { createQuotaRuntimeRequestContext, resolveQuotaRuntimeContext, } from "./lib/quota-runtime-context.js";
import { disposeQuotaTelemetryOwner } from "./lib/quota-telemetry.js";
import { DEFAULT_CONFIG } from "./lib/types.js";
import { getProviders } from "./providers/registry.js";
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
const DEFERRED_QUOTA_REFRESH_DELAYS_MS = [3_000, 15_000, 60_000, 300_000];
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
    // Keep init fast/non-blocking so TUI never hangs. We still want the first
    // toast trigger to work reliably, so we refresh config on-demand.
    let config = DEFAULT_CONFIG;
    let configLoaded = false;
    let configInFlight = null;
    let providerConfigReconcileQueue = Promise.resolve();
    let configMeta = createLoadConfigMeta();
    let runtimeProviders = getProviders();
    // Track last session token error for /quota_status diagnostics
    let lastSessionTokenError;
    const deferredQuotaRefreshes = new Map();
    function getDeferredQuotaRefreshDelayMs(attempts) {
        const index = Math.min(Math.max(0, attempts), DEFERRED_QUOTA_REFRESH_DELAYS_MS.length - 1);
        return DEFERRED_QUOTA_REFRESH_DELAYS_MS[index];
    }
    function clearDeferredQuotaRefresh(sessionID) {
        const state = deferredQuotaRefreshes.get(sessionID);
        if (state?.timer) {
            clearTimeout(state.timer);
        }
        deferredQuotaRefreshes.delete(sessionID);
    }
    function clearDeferredQuotaRefreshTimer(state) {
        if (!state.timer)
            return;
        clearTimeout(state.timer);
        state.timer = null;
    }
    function scheduleDeferredQuotaRefresh(params) {
        let state = deferredQuotaRefreshes.get(params.sessionID);
        if (!state) {
            state = {
                sessionID: params.sessionID,
                attempts: 0,
                reason: params.reason,
                queuedAtMs: Date.now(),
                timer: null,
            };
            deferredQuotaRefreshes.set(params.sessionID, state);
        }
        else {
            if (params.incrementAttempts) {
                state.attempts += 1;
            }
            state.reason = params.reason;
            clearDeferredQuotaRefreshTimer(state);
        }
        const delayMs = getDeferredQuotaRefreshDelayMs(state.attempts);
        state.timer = setTimeout(() => {
            void runDeferredQuotaRefresh(params.sessionID);
        }, delayMs);
        state.timer.unref?.();
        void log("Deferred quota refresh scheduled", {
            sessionID: params.sessionID,
            reason: params.reason,
            attempts: state.attempts,
            delayMs,
        });
    }
    async function runDeferredQuotaRefresh(sessionID) {
        const state = deferredQuotaRefreshes.get(sessionID);
        if (!state)
            return;
        // Ticket 12: the deferred queue retries the quota alert evaluation
        // (there are no routine quota toasts in the v2 model).
        await runQuotaAlertEvaluation({
            sessionID,
            trigger: "deferred.retry",
            deferredRetry: true,
        });
    }
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
    async function resolvePluginRuntimeContext(params = {}) {
        if (!configLoaded) {
            await refreshConfig();
        }
        return resolveQuotaRuntimeContext({
            client: typedClient,
            roots: getPluginRuntimeRootHints(),
            config,
            configMeta,
            providers: runtimeProviders,
            sessionID: params.sessionID,
            sessionMeta: params.sessionMeta,
            resolveSessionMeta: (sessionID) => getSessionModelMeta(sessionID),
            includeSessionMeta: params.includeSessionMeta,
        });
    }
    async function refreshConfig() {
        if (configInFlight)
            return configInFlight;
        configInFlight = (async () => {
            try {
                const runtime = await resolveQuotaRuntimeContext({
                    client: typedClient,
                    roots: getPluginRuntimeRootHints(),
                });
                configMeta = runtime.configMeta;
                config = runtime.config;
                runtimeProviders = runtime.providers;
                setPricingSnapshotAutoRefresh(config.pricingSnapshot.autoRefresh);
                setPricingSnapshotSelection(config.pricingSnapshot.source);
                configLoaded = true;
                onFirstConfigLoaded();
            }
            catch {
                // Leave configLoaded=false so we can retry on next trigger.
                config = DEFAULT_CONFIG;
                configMeta = createLoadConfigMeta();
                runtimeProviders = getProviders();
                setPricingSnapshotAutoRefresh(DEFAULT_CONFIG.pricingSnapshot.autoRefresh);
                setPricingSnapshotSelection(DEFAULT_CONFIG.pricingSnapshot.source);
            }
            finally {
                configInFlight = null;
            }
        })();
        return configInFlight;
    }
    async function kickPricingRefresh(params) {
        try {
            const refreshPromise = maybeRefreshPricingSnapshot({
                reason: params.reason,
                snapshotSelection: config.pricingSnapshot.source,
            });
            const guardedRefreshPromise = refreshPromise.catch(() => undefined);
            if (!params.maxWaitMs || params.maxWaitMs <= 0) {
                void guardedRefreshPromise;
                return;
            }
            await Promise.race([
                guardedRefreshPromise,
                new Promise((resolve) => {
                    setTimeout(resolve, params.maxWaitMs);
                }),
            ]);
        }
        catch (error) {
            await log("Pricing refresh failed", {
                reason: params.reason,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    // Deferred init: runs once after the first successful config load.
    // Avoids HTTP calls during plugin construction, which can interfere with
    // other plugins that are still being loaded (see #39).
    let initDone = false;
    function onFirstConfigLoaded() {
        if (initDone)
            return;
        initDone = true;
        if (config.enabled) {
            void kickPricingRefresh({ reason: "init" });
        }
        void typedClient.app
            .log({
            body: {
                service: "quota-toast",
                level: "info",
                message: "plugin initialized",
                extra: {
                    configLoaded,
                    configSource: configMeta.source,
                    configPaths: configMeta.paths,
                    enabledProviders: config.enabledProviders,
                    minIntervalMs: config.minIntervalMs,
                    googleModels: config.googleModels,
                    cursorPlan: config.cursorPlan,
                    cursorIncludedApiUsd: config.cursorIncludedApiUsd,
                    cursorBillingCycleStartDay: config.cursorBillingCycleStartDay,
                    pricingSnapshotSource: config.pricingSnapshot.source,
                    pricingSnapshotAutoRefresh: config.pricingSnapshot.autoRefresh,
                },
            },
        })
            .catch(() => { });
    }
    // If disabled in config, it'll be picked up on first trigger; we can't
    // reliably read config synchronously without risking TUI startup.
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
    function isProviderFetchFailureOnly(errors) {
        return (errors.length > 0 && errors.every((error) => error.message === "Failed to read quota data"));
    }
    /**
     * Deliver one quota alert notification through the TUI toast surface.
     * Returns whether the TUI accepted the delivery; the caller only persists
     * delivered-notification state (ADR 0001: a failed delivery must not
     * consume the episode's notification opportunity).
     */
    async function showAlertToast(notification) {
        const message = formatQuotaAlertNotificationText(notification);
        try {
            await typedClient.tui.showToast({
                body: {
                    message: sanitizeDisplayText(message),
                    variant: notification.severity === "critical" ? "error" : "warning",
                    duration: config.toastDurationMs,
                },
            });
            await log("Displayed quota alert toast", {
                episodeId: notification.episodeId,
                notifyCount: notification.notifyCount,
                severity: notification.severity,
            });
            return true;
        }
        catch (err) {
            await log("Failed to show quota alert toast", {
                episodeId: notification.episodeId,
                error: err instanceof Error ? err.message : String(err),
            });
            return false;
        }
    }
    // Serialize alert evaluations: every evaluation queues behind the previous
    // one, so two racing refresh points can never double-deliver the same first
    // notification (ADR 0001: one notification per alert period by default).
    let pendingAlertEvaluation = Promise.resolve();
    function runQuotaAlertEvaluation(params) {
        const queued = async () => {
            // A previous evaluation may have failed; the queue must not break.
            await pendingAlertEvaluation.catch(() => undefined);
            return evaluateAndDeliverQuotaAlerts(params);
        };
        pendingAlertEvaluation = queued();
        return pendingAlertEvaluation;
    }
    /**
     * Ticket 12: quota alert evaluation and delivery at an existing refresh
     * point (session idle, compaction, question-tool completion, deferred
     * retry).
     *
     * Fetches quota through the shared render pipeline (provider results are
     * cached at minIntervalMs, so this never adds provider requests beyond the
     * normal refresh cadence), builds the unified snapshot, runs the pure
     * episode state machine against persisted episodes, delivers approved
     * notifications through the TUI toast surface, and persists the next state
     * only for delivered notifications.
     */
    async function evaluateAndDeliverQuotaAlerts(params) {
        if (!configLoaded) {
            await refreshConfig();
        }
        if (!configLoaded || !config.enabled || !config.alerts.enabled) {
            // Alerts are off: nothing to evaluate, and any queued retry is moot.
            clearDeferredQuotaRefresh(params.sessionID);
            return;
        }
        // Subagent sessions produce their own refresh events; evaluating from
        // them would duplicate the primary session's evaluation.
        if (await isSubagentSession(params.sessionID)) {
            if (params.deferredRetry) {
                clearDeferredQuotaRefresh(params.sessionID);
            }
            return;
        }
        const runtime = await resolvePluginRuntimeContext({ sessionID: params.sessionID });
        const request = createQuotaRuntimeRequestContext(runtime);
        const result = await collectQuotaRenderData({
            client: runtime.client,
            resolveRuntimeProviderIds: runtime.resolveRuntimeProviderIds,
            config: runtime.config,
            configMeta: runtime.configMeta,
            request,
            surfaceExplicitProviderIssues: true,
            formatStyle: resolveQuotaFormatStyle(runtime.config.formatStyle),
            bypassProviderCache: params.deferredRetry === true,
            providers: runtime.providers,
        });
        const { selection, availability, active, attemptedAny } = result;
        const errors = result.data?.errors ?? [];
        // Mirrors the toast-path retry classification so temporary fetch
        // failures retry on the standard deferred backoff instead of silently
        // losing an alert window.
        const providerFetchFailureOnly = attemptedAny && isProviderFetchFailureOnly(errors);
        const retryableAvailabilityFailure = active.length === 0 && availability.some((item) => !item.ok && item.error === true);
        const retryableNoData = providerFetchFailureOnly ||
            (selection?.isAutoMode === true && active.length > 0 && errors.length === 0);
        const retryable = retryableAvailabilityFailure || retryableNoData;
        const retryReason = providerFetchFailureOnly
            ? "provider_fetch_failed"
            : retryableAvailabilityFailure
                ? "no_available_providers"
                : retryableNoData
                    ? "no_reportable_data"
                    : undefined;
        if (!retryable) {
            clearDeferredQuotaRefresh(params.sessionID);
        }
        else if (retryReason) {
            scheduleDeferredQuotaRefresh({
                sessionID: params.sessionID,
                reason: retryReason,
                incrementAttempts: params.deferredRetry === true,
            });
        }
        if (!selection) {
            return;
        }
        const snapshot = buildUnifiedQuotaSnapshot({
            monitoredProviderIds: selection.providers.map((provider) => provider.id),
            availability: availability.map((item) => ({
                providerId: item.provider.id,
                ok: item.ok,
                ...(item.error ? { error: true } : {}),
            })),
            results: active.map((provider, index) => ({
                providerId: provider.id,
                result: result.results?.[index] ?? { attempted: false, entries: [], errors: [] },
            })),
        });
        // Providers whose observation is not reliable must never resolve an open
        // episode: a failed query is not a recovery (ADR 0001).
        const unknownProviderIds = new Set(snapshot.providers
            .filter((provider) => provider.quality !== "fresh")
            .map((provider) => provider.providerId));
        const now = new Date();
        const transitions = transitionAlertEpisodes({
            episodes: await readQuotaAlertEpisodes(),
            candidates: evaluateQuotaDangerMetrics({ alerts: runtime.config.alerts, snapshot }),
            repeatAfterMinutes: runtime.config.alerts.repeatAfterMinutes,
            now,
            unknownProviderIds,
        });
        const nextEpisodes = [];
        for (const transition of transitions) {
            switch (transition.kind) {
                case "new": {
                    if (await showAlertToast(transition.notification)) {
                        nextEpisodes.push(transition.episode);
                    }
                    // Delivery failure: nothing is persisted for this candidate; the
                    // next refresh point retries the first notification.
                    break;
                }
                case "repeat": {
                    if (await showAlertToast(transition.notification)) {
                        nextEpisodes.push(transition.episode);
                    }
                    else {
                        // Keep the previous state so a failed delivery does not consume
                        // the episode's repeat opportunity (ADR 0001).
                        nextEpisodes.push(transition.previous);
                    }
                    break;
                }
                case "dangerous":
                case "resolved":
                case "unchanged":
                    nextEpisodes.push(transition.episode);
                    break;
            }
        }
        try {
            await writeQuotaAlertEpisodes(pruneQuotaAlertEpisodes(nextEpisodes, now), { now });
        }
        catch (error) {
            await log("Failed to persist quota alert episodes", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
        await log("Quota alert evaluation completed", {
            trigger: params.trigger,
            sessionID: params.sessionID,
            dangerousEpisodes: transitions.filter((transition) => transition.kind === "dangerous" || transition.kind === "unchanged").length,
            notified: transitions.filter((transition) => transition.kind === "new" || transition.kind === "repeat").length,
            resolved: transitions.filter((transition) => transition.kind === "resolved").length,
        });
    }
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
        // Event hook for session.idle and session.compacted.
        //
        // Ticket 07/12: the v2 model has no routine quota toast. Ordinary session
        // lifecycle events (idle, compaction) and question-tool completion never
        // produce a routine quota toast; normal quota is only shown through
        // passive surfaces (startup hint, sidebar, /quota, optional prompt bar).
        // These events are the existing quota refresh points where quota alerts
        // are evaluated and delivered. The old showQuotaToast path remains as
        // unreachable code until Ticket 13 removes the contract.
        event: async ({ event }) => {
            if (event.type !== "session.idle" && event.type !== "session.compacted") {
                return;
            }
            const sessionID = event.properties.sessionID;
            if (!sessionID)
                return;
            await runQuotaAlertEvaluation({ sessionID, trigger: event.type });
        },
        // Tool execute hook for question tool.
        "tool.execute.after": async (input, _output) => {
            if (input.tool !== "question")
                return;
            await runQuotaAlertEvaluation({ sessionID: input.sessionID, trigger: "question" });
        },
    };
};
