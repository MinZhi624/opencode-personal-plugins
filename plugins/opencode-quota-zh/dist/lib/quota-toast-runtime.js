import { getProviders } from "../providers/registry.js";
import { DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS, isAlibabaModelId, resolveAlibabaCodingPlanAuthCached, } from "./alibaba-auth.js";
import { getOrFetchWithCacheControl } from "./cache.js";
import { createLoadConfigMeta } from "./config.js";
import { isCursorModelId, isCursorProviderId } from "./cursor-pricing.js";
import { sanitizeDisplayText } from "./display-sanitize.js";
import { formatQuotaRows } from "./format.js";
import { formatQuotaModeHeading } from "./format-utils.js";
import { BUNDLED_MAINTAINER_ANNOUNCEMENTS, formatMaintainerAnnouncementHomeCountLine, getMaintainerAnnouncementsSummary, } from "./maintainer-announcements.js";
import { maybeRefreshPricingSnapshot, setPricingSnapshotAutoRefresh, setPricingSnapshotSelection, } from "./modelsdev-pricing.js";
import { resolveQuotaFormatStyle } from "./quota-format-style.js";
import { customQuotaProviderDefinitions, QUOTA_PROVIDERS_AGGREGATE_ID } from "./quota-providers.js";
import { collectQuotaRenderData, } from "./quota-render-data.js";
import { formatQuotaResetNotification, observeQuotaResetNotifications, } from "./quota-reset-notifications.js";
import { createQuotaRuntimeRequestContext, resolveQuotaRuntimeContext, } from "./quota-runtime-context.js";
import { isQwenCodeModelId, resolveQwenLocalPlanCached } from "./qwen-auth.js";
import { inspectTuiConfig } from "./tui-config-diagnostics.js";
import { DEFAULT_CONFIG } from "./types.js";
const DEFERRED_QUOTA_REFRESH_DELAYS_MS = [3_000, 15_000, 60_000, 300_000];
export function createQuotaToastRuntime(dependencies) {
    let config = DEFAULT_CONFIG;
    let configLoaded = false;
    let configInFlight = null;
    let configMeta = createLoadConfigMeta();
    let runtimeProviders = getProviders();
    let initDone = false;
    const deferredQuotaRefreshes = new Map();
    const detectedProviderIdsByToastCacheKey = new Map();
    const maintainerAnnouncementToastFallback = {
        pending: true,
        inFlight: false,
    };
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
                inFlight: false,
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
        void dependencies.log("Deferred quota refresh scheduled", {
            sessionID: params.sessionID,
            reason: params.reason,
            attempts: state.attempts,
            delayMs,
        });
    }
    async function runDeferredQuotaRefresh(sessionID) {
        const state = deferredQuotaRefreshes.get(sessionID);
        if (!state || state.inFlight)
            return;
        await handleTriggerInternal({
            sessionID,
            trigger: "deferred.retry",
            deferredRetry: true,
        });
    }
    function isProviderEnabled(providerId) {
        return config.enabledProviders === "auto" || config.enabledProviders.includes(providerId);
    }
    async function shouldBypassToastCacheForLiveLocalUsage(params) {
        if (isProviderEnabled(QUOTA_PROVIDERS_AGGREGATE_ID) &&
            customQuotaProviderDefinitions(config.quotaProviders).some((definition) => definition.mode === "local-estimate")) {
            return true;
        }
        const currentSession = params.sessionMeta ?? (await dependencies.resolveSessionMeta(params.sessionID));
        const currentModel = currentSession.modelID;
        if (currentSession.providerID === "qwen-code" || isQwenCodeModelId(currentModel)) {
            const plan = await resolveQwenLocalPlanCached();
            return plan.state === "qwen_free" && isProviderEnabled("qwen-code");
        }
        if (currentSession.providerID === "alibaba-coding-plan" ||
            currentSession.providerID === "alibaba" ||
            isAlibabaModelId(currentModel)) {
            const plan = await resolveAlibabaCodingPlanAuthCached({
                maxAgeMs: DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
                fallbackTier: "lite",
            });
            return plan.state === "configured" && isProviderEnabled("alibaba-coding-plan");
        }
        if (isCursorProviderId(currentSession.providerID) || isCursorModelId(currentModel)) {
            return isProviderEnabled("cursor");
        }
        return false;
    }
    function buildToastCacheKey(params) {
        const formatStyle = resolveQuotaFormatStyle(config.formatStyle);
        const enabledProviders = config.enabledProviders === "auto" ? "auto" : config.enabledProviders.join(",");
        const googleModels = config.googleModels.join(",");
        const currentModel = config.onlyCurrentModel && params.sessionID ? (params.sessionMeta?.modelID ?? "") : "";
        const currentProviderID = config.onlyCurrentModel && params.sessionID ? (params.sessionMeta?.providerID ?? "") : "";
        const renderIdentity = JSON.stringify({
            accountingDetail: config.accountingDetail,
            quotaProjection: config.quotaProjection,
            percentLabelStyle: config.percentLabelStyle,
            resetTimeDecimals: config.resetTimeDecimals,
            resetTimeSpaced: config.resetTimeSpaced,
            sessionTokenScope: config.sessionTokenScope,
            opencodeGoWindows: config.opencodeGoWindows,
            opencodeMonthlyLimit: config.opencodeMonthlyLimit,
            quotaProviders: config.quotaProviders,
        });
        const rootIdentity = JSON.stringify(dependencies.roots());
        return [
            `sessionID=${params.sessionID}`,
            `enabledProviders=${enabledProviders}`,
            `formatStyle=${formatStyle}`,
            `percentDisplayMode=${config.percentDisplayMode}`,
            `layout=${JSON.stringify(config.layout)}`,
            `showSessionTokens=${config.showSessionTokens ? "yes" : "no"}`,
            `onlyCurrentModel=${config.onlyCurrentModel ? "yes" : "no"}`,
            `currentModel=${currentModel}`,
            `currentProviderID=${currentProviderID}`,
            `anthropicBinaryPath=${config.anthropicBinaryPath}`,
            `googleModels=${googleModels}`,
            `cursorPlan=${config.cursorPlan}`,
            `cursorIncludedApiUsd=${config.cursorIncludedApiUsd ?? ""}`,
            `cursorBillingCycleStartDay=${config.cursorBillingCycleStartDay ?? ""}`,
            `renderIdentity=${renderIdentity}`,
            `rootIdentity=${rootIdentity}`,
        ].join("|");
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
            await dependencies.log("Pricing refresh failed", {
                reason: params.reason,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    function onFirstConfigLoaded() {
        if (initDone)
            return;
        initDone = true;
        if (config.enabled) {
            void kickPricingRefresh({ reason: "init" });
        }
        dependencies.onInitialized({
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
            showOnIdle: config.showOnIdle,
            showOnQuestion: config.showOnQuestion,
            showOnCompact: config.showOnCompact,
            showOnBothFail: config.showOnBothFail,
        });
    }
    async function refreshConfig() {
        if (configInFlight)
            return configInFlight;
        configInFlight = (async () => {
            try {
                const runtime = await resolveQuotaRuntimeContext({
                    client: dependencies.client,
                    roots: dependencies.roots(),
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
    async function resolvePluginRuntimeContext(params) {
        return resolveQuotaRuntimeContext({
            client: dependencies.client,
            roots: dependencies.roots(),
            config,
            configMeta,
            providers: runtimeProviders,
            sessionID: params.sessionID,
            sessionMeta: params.sessionMeta,
            resolveSessionMeta: dependencies.resolveSessionMeta,
            includeSessionMeta: (runtimeConfig) => runtimeConfig.onlyCurrentModel,
        });
    }
    function emptyCollectionResult(params) {
        return {
            message: params.message,
            cacheRenderedMessage: false,
            retryable: params.retryable,
            retryReason: params.retryReason,
            hasQuotaRows: false,
            detectedProviderIds: [],
            freshProviderResults: [],
            shouldReconcileDetectedProviders: false,
        };
    }
    async function fetchQuotaMessageResult(params) {
        if (!configLoaded) {
            await refreshConfig();
        }
        if (!configLoaded) {
            return emptyCollectionResult({
                message: config.debug
                    ? formatQuotaToastDebugInfo({
                        trigger: params.trigger,
                        reason: "config load failed",
                        config,
                        configMeta,
                    })
                    : null,
                retryable: true,
                retryReason: "config_load_failed",
            });
        }
        if (!config.enabled) {
            return emptyCollectionResult({
                message: config.debug
                    ? formatQuotaToastDebugInfo({
                        trigger: params.trigger,
                        reason: "disabled",
                        config,
                        configMeta,
                    })
                    : null,
                retryable: false,
            });
        }
        if (config.enabledProviders !== "auto" && config.enabledProviders.length === 0) {
            return emptyCollectionResult({
                message: config.debug
                    ? formatQuotaToastDebugInfo({
                        trigger: params.trigger,
                        reason: "enabledProviders empty",
                        config,
                        configMeta,
                    })
                    : null,
                retryable: false,
            });
        }
        const runtime = await resolvePluginRuntimeContext({
            sessionID: params.sessionID,
            sessionMeta: params.sessionMeta,
        });
        const collection = await collectQuotaToastMessage({
            trigger: params.trigger,
            runtime,
            bypassProviderCache: params.bypassProviderCache,
        });
        if (collection.shouldReconcileDetectedProviders) {
            await dependencies.reconcileDetectedProviders(collection.detectedProviderIds);
        }
        if (runtime.config.showSessionTokens) {
            dependencies.setSessionTokenError(collection.sessionTokenError);
        }
        return collection;
    }
    async function reconcileDeferredQuotaRefresh(params) {
        const existing = deferredQuotaRefreshes.get(params.sessionID);
        if (!params.result.retryable) {
            if (existing) {
                clearDeferredQuotaRefresh(params.sessionID);
                await dependencies.log("Deferred quota refresh cleared", {
                    sessionID: params.sessionID,
                    trigger: params.trigger,
                    reason: params.result.hasQuotaRows ? "quota_rows_available" : "not_retryable",
                });
            }
            return;
        }
        if (!params.result.retryReason)
            return;
        scheduleDeferredQuotaRefresh({
            sessionID: params.sessionID,
            reason: params.result.retryReason,
            incrementAttempts: params.consumedDeferredRetry,
        });
    }
    function isTriggerEnabled(trigger) {
        if (trigger === "session.idle")
            return config.showOnIdle;
        if (trigger === "session.compacted")
            return config.showOnCompact;
        if (trigger === "question")
            return config.showOnQuestion;
        return trigger === "deferred.retry";
    }
    function triggerMaintainerAnnouncementToastFallback(trigger, detectedProviderIds, runtimeConfig) {
        if (!maintainerAnnouncementToastFallback.pending ||
            maintainerAnnouncementToastFallback.inFlight) {
            return;
        }
        if (!runtimeConfig.enabled || !runtimeConfig.enableToast) {
            maintainerAnnouncementToastFallback.pending = false;
            return;
        }
        if (!runtimeConfig.maintainerAnnouncements.enabled ||
            !runtimeConfig.maintainerAnnouncements.home) {
            maintainerAnnouncementToastFallback.pending = false;
            return;
        }
        maintainerAnnouncementToastFallback.inFlight = true;
        void (async () => {
            try {
                const summary = getMaintainerAnnouncementsSummary({
                    announcements: BUNDLED_MAINTAINER_ANNOUNCEMENTS,
                    enabledProviders: detectedProviderIds,
                });
                if (summary.activeCount <= 0) {
                    if (summary.futureCount <= 0) {
                        maintainerAnnouncementToastFallback.pending = false;
                    }
                    return;
                }
                const tuiDiagnostics = await inspectTuiConfig({ roots: dependencies.roots() });
                if (tuiDiagnostics.quotaPluginConfigured) {
                    maintainerAnnouncementToastFallback.pending = false;
                    return;
                }
                const message = formatMaintainerAnnouncementHomeCountLine(summary.activeCount);
                if (!message)
                    return;
                await dependencies.showToast({
                    message: sanitizeDisplayText(message),
                    variant: "info",
                    duration: runtimeConfig.toastDurationMs,
                });
                maintainerAnnouncementToastFallback.pending = false;
                await dependencies.log("Displayed maintainer announcement fallback toast", { trigger });
            }
            catch (error) {
                await dependencies.log("Failed to show maintainer announcement fallback toast", {
                    trigger,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            finally {
                maintainerAnnouncementToastFallback.inFlight = false;
            }
        })();
    }
    async function emitQuotaToastPlan(params) {
        const { config: runtimeConfig, message, detectedProviderIds, freshProviderResults, } = params.plan;
        let resetNotification;
        if (runtimeConfig.enableToast &&
            runtimeConfig.resetNotifications.enabled &&
            freshProviderResults.length > 0) {
            try {
                const notices = await observeQuotaResetNotifications({
                    providers: freshProviderResults,
                    windows: runtimeConfig.resetNotifications.windows,
                });
                resetNotification = formatQuotaResetNotification(notices) ?? undefined;
            }
            catch (error) {
                await dependencies.log("Failed to observe quota reset transitions", {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        if (params.plan.deferredRetryResult) {
            await dependencies.log("Deferred quota refresh did not produce reportable data", {
                sessionID: params.sessionID,
                trigger: params.trigger,
                retryable: params.plan.deferredRetryResult.retryable,
                retryReason: params.plan.deferredRetryResult.retryReason,
            });
            return;
        }
        if (!message) {
            await dependencies.log("No quota message to display", { trigger: params.trigger });
            return;
        }
        if (!runtimeConfig.enableToast) {
            await dependencies.log("Toast disabled (enableToast=false)", { trigger: params.trigger });
            return;
        }
        try {
            await dependencies.showToast({
                ...(runtimeConfig.percentLabelStyle === "bare"
                    ? { title: formatQuotaModeHeading(runtimeConfig.percentDisplayMode) }
                    : {}),
                message: sanitizeDisplayText(message),
                variant: "info",
                duration: runtimeConfig.toastDurationMs,
            });
            triggerMaintainerAnnouncementToastFallback(params.trigger, detectedProviderIds, runtimeConfig);
            await dependencies.log("Displayed quota toast", { message, trigger: params.trigger });
            if (resetNotification) {
                await dependencies.showToast({
                    title: "Quota available",
                    message: sanitizeDisplayText(resetNotification),
                    variant: "success",
                    duration: runtimeConfig.toastDurationMs,
                });
                await dependencies.log("Displayed quota reset notification", {
                    message: resetNotification,
                    trigger: params.trigger,
                });
            }
        }
        catch (error) {
            await dependencies.log("Failed to show toast", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    async function prepareTrigger(params) {
        if (!configLoaded) {
            await refreshConfig();
        }
        if (!config.enabled) {
            clearDeferredQuotaRefresh(params.sessionID);
            return null;
        }
        if (!isTriggerEnabled(params.trigger))
            return null;
        const pendingDeferred = deferredQuotaRefreshes.get(params.sessionID);
        const consumedDeferredRetry = params.deferredRetry === true || Boolean(pendingDeferred);
        if (pendingDeferred) {
            if (pendingDeferred.inFlight && !params.deferredRetry) {
                await dependencies.log("Skipping duplicate deferred quota refresh", {
                    sessionID: params.sessionID,
                    trigger: params.trigger,
                });
                return null;
            }
            pendingDeferred.inFlight = true;
            clearDeferredQuotaRefreshTimer(pendingDeferred);
        }
        let planPrepared = false;
        let completed = false;
        const complete = () => {
            if (completed)
                return;
            completed = true;
            const state = deferredQuotaRefreshes.get(params.sessionID);
            if (state && state === pendingDeferred) {
                state.inFlight = false;
            }
        };
        try {
            if (await dependencies.isSubagentSession(params.sessionID)) {
                if (consumedDeferredRetry) {
                    clearDeferredQuotaRefresh(params.sessionID);
                }
                await dependencies.log("Skipping toast for subagent session", {
                    sessionID: params.sessionID,
                    trigger: params.trigger,
                });
                return null;
            }
            const sessionMeta = await dependencies.resolveSessionMeta(params.sessionID);
            const bypassForLiveLocalUsage = await shouldBypassToastCacheForLiveLocalUsage({
                sessionID: params.sessionID,
                sessionMeta,
            });
            const bypassMessageCache = config.debug || consumedDeferredRetry || bypassForLiveLocalUsage;
            const bypassProviderCache = consumedDeferredRetry || bypassForLiveLocalUsage;
            const toastCacheKey = buildToastCacheKey({
                sessionID: params.sessionID,
                sessionMeta,
            });
            let fetchResult;
            const fetchForToast = () => fetchQuotaMessageResult({
                trigger: params.trigger,
                sessionID: params.sessionID,
                sessionMeta,
                bypassProviderCache,
            });
            const message = bypassMessageCache
                ? await (async () => {
                    fetchResult = await fetchForToast();
                    return fetchResult.message;
                })()
                : await (async () => {
                    const fetched = {};
                    const cachedMessage = await getOrFetchWithCacheControl(toastCacheKey, async () => {
                        const result = await fetchForToast();
                        fetched.result = result;
                        return {
                            message: result.message,
                            cache: Boolean(result.message && result.cacheRenderedMessage && result.hasQuotaRows),
                        };
                    }, config.minIntervalMs);
                    fetchResult = fetched.result;
                    return cachedMessage;
                })();
            if (fetchResult) {
                detectedProviderIdsByToastCacheKey.set(toastCacheKey, [...fetchResult.detectedProviderIds]);
                await reconcileDeferredQuotaRefresh({
                    sessionID: params.sessionID,
                    result: fetchResult,
                    consumedDeferredRetry,
                    trigger: params.trigger,
                });
            }
            planPrepared = true;
            return {
                config,
                message,
                detectedProviderIds: fetchResult?.detectedProviderIds ??
                    detectedProviderIdsByToastCacheKey.get(toastCacheKey) ??
                    [],
                freshProviderResults: fetchResult?.freshProviderResults ?? [],
                complete,
                deferredRetryResult: params.deferredRetry && fetchResult && !fetchResult.hasQuotaRows
                    ? {
                        retryable: fetchResult.retryable,
                        retryReason: fetchResult.retryReason,
                    }
                    : undefined,
            };
        }
        finally {
            if (!planPrepared)
                complete();
        }
    }
    async function handleTriggerInternal(params) {
        const plan = await prepareTrigger(params);
        if (!plan)
            return;
        try {
            await emitQuotaToastPlan({ ...params, plan });
        }
        finally {
            plan.complete();
        }
    }
    async function handleTrigger(params) {
        await handleTriggerInternal(params);
    }
    return { handleTrigger };
}
export function formatQuotaToastDebugInfo(params) {
    const availability = params.availability
        ? params.availability.map((item) => `${item.id}=${item.ok ? "ok" : "no"}`).join(" ")
        : "unknown";
    const providers = params.config.enabledProviders === "auto"
        ? "(auto)"
        : params.config.enabledProviders.length > 0
            ? params.config.enabledProviders.join(",")
            : "(none)";
    const modelPart = params.currentModel ? ` model=${params.currentModel}` : "";
    const paths = params.configMeta.paths.length > 0 ? params.configMeta.paths.join(" | ") : "(none)";
    return [
        "Quota Toast Debug (opencode-quota)",
        `trigger=${params.trigger} reason=${params.reason}`,
        `configSource=${params.configMeta.source} paths=${paths}`,
        `enabled=${params.config.enabled} providers=${providers}${modelPart}`,
        `available=${availability}`,
    ].join("\n");
}
function hasRetryableProviderError(errors) {
    return errors.some((error) => error.retryable === true);
}
export async function collectQuotaToastMessage(params) {
    const runtimeConfig = params.runtime.config;
    const quotaResult = await collectQuotaRenderData({
        client: params.runtime.client,
        resolveRuntimeProviderIds: params.runtime.resolveRuntimeProviderIds,
        config: runtimeConfig,
        configMeta: params.runtime.configMeta,
        request: createQuotaRuntimeRequestContext(params.runtime),
        surfaceExplicitProviderIssues: true,
        formatStyle: resolveQuotaFormatStyle(runtimeConfig.formatStyle),
        bypassProviderCache: params.bypassProviderCache,
        providers: params.runtime.providers,
    });
    const { selection, availability, active, providerResults, attemptedAny, hasExplicitProviderIssues, data, } = quotaResult;
    const detectedProviderIds = active.map((provider) => provider.id);
    const collectionMetadata = {
        detectedProviderIds,
        freshProviderResults: providerResults,
        sessionTokenError: quotaResult.sessionTokenError,
        shouldReconcileDetectedProviders: selection?.isAutoMode === true,
    };
    const currentModel = selection?.currentModel;
    const errors = data?.errors ?? [];
    const hasProviderQuotaRows = Boolean(data?.entries.length);
    const hasQuotaRows = Boolean(hasProviderQuotaRows || data?.sessionTokens);
    const hasRetryableFetchFailure = attemptedAny && hasRetryableProviderError(errors);
    const retryableAvailabilityFailure = active.length === 0 && availability.some((item) => !item.ok && item.error === true);
    if (active.length === 0 && !(hasExplicitProviderIssues && errors.length > 0)) {
        const message = runtimeConfig.debug
            ? formatQuotaToastDebugInfo({
                trigger: params.trigger,
                reason: "no enabled providers available",
                config: runtimeConfig,
                configMeta: params.runtime.configMeta,
                currentModel,
                availability: availability.map((item) => ({
                    id: item.provider.id,
                    ok: item.ok,
                })),
            })
            : null;
        const retryableNoProviders = selection?.isAutoMode === true || retryableAvailabilityFailure;
        return {
            message,
            cacheRenderedMessage: false,
            retryable: retryableNoProviders,
            retryReason: retryableNoProviders ? "no_available_providers" : undefined,
            hasQuotaRows: false,
            ...collectionMetadata,
        };
    }
    if (hasQuotaRows) {
        const formatted = formatQuotaRows({
            version: "1.0.0",
            layout: runtimeConfig.layout,
            entries: data?.entries ?? [],
            errors: data?.errors ?? [],
            style: resolveQuotaFormatStyle(runtimeConfig.formatStyle),
            percentDisplayMode: runtimeConfig.percentDisplayMode,
            percentLabelStyle: runtimeConfig.percentLabelStyle,
            accountingDetail: runtimeConfig.accountingDetail,
            resetTimeDecimals: runtimeConfig.resetTimeDecimals,
            resetTimeSpaced: runtimeConfig.resetTimeSpaced,
            sessionTokens: data?.sessionTokens,
        });
        const retryableMaskedProviderFailure = !hasProviderQuotaRows && hasRetryableFetchFailure;
        if (!runtimeConfig.debug) {
            return {
                message: formatted,
                cacheRenderedMessage: true,
                retryable: retryableMaskedProviderFailure,
                retryReason: retryableMaskedProviderFailure ? "provider_fetch_failed" : undefined,
                hasQuotaRows: true,
                ...collectionMetadata,
            };
        }
        const debugFooter = `\n\n[debug] src=${params.runtime.configMeta.source} providers=${runtimeConfig.enabledProviders === "auto" ? "(auto)" : runtimeConfig.enabledProviders.join(",") || "(none)"} avail=${availability
            .map((item) => `${item.provider.id}:${item.ok ? "ok" : "no"}`)
            .join(" ")}`;
        return {
            message: formatted + debugFooter,
            cacheRenderedMessage: false,
            retryable: retryableMaskedProviderFailure,
            retryReason: retryableMaskedProviderFailure ? "provider_fetch_failed" : undefined,
            hasQuotaRows: true,
            ...collectionMetadata,
        };
    }
    if ((runtimeConfig.showOnBothFail && attemptedAny && errors.length > 0) ||
        hasExplicitProviderIssues) {
        const errorLines = errors.map((error) => `${error.label}: ${error.message}`).join("\n");
        const retryableFetchFailure = hasRetryableFetchFailure;
        const retryableFailure = retryableFetchFailure || retryableAvailabilityFailure;
        const retryReason = retryableFetchFailure
            ? "provider_fetch_failed"
            : retryableAvailabilityFailure
                ? "no_available_providers"
                : undefined;
        const message = !runtimeConfig.debug
            ? errorLines || "Quota unavailable"
            : (errorLines || "Quota unavailable") +
                "\n\n" +
                formatQuotaToastDebugInfo({
                    trigger: params.trigger,
                    reason: hasExplicitProviderIssues
                        ? "providers missing/unavailable"
                        : "all providers failed",
                    config: runtimeConfig,
                    configMeta: params.runtime.configMeta,
                    currentModel,
                    availability: availability.map((item) => ({
                        id: item.provider.id,
                        ok: item.ok,
                    })),
                });
        return {
            message,
            cacheRenderedMessage: false,
            retryable: retryableFailure,
            retryReason,
            hasQuotaRows: false,
            ...collectionMetadata,
        };
    }
    const retryableNoData = hasRetryableFetchFailure ||
        (selection?.isAutoMode === true && active.length > 0 && errors.length === 0);
    return {
        message: runtimeConfig.debug
            ? formatQuotaToastDebugInfo({
                trigger: params.trigger,
                reason: "no entries",
                config: runtimeConfig,
                configMeta: params.runtime.configMeta,
                currentModel,
                availability: availability.map((item) => ({
                    id: item.provider.id,
                    ok: item.ok,
                })),
            })
            : null,
        cacheRenderedMessage: false,
        retryable: retryableNoData,
        retryReason: hasRetryableFetchFailure
            ? "provider_fetch_failed"
            : retryableNoData
                ? "no_reportable_data"
                : undefined,
        hasQuotaRows: false,
        ...collectionMetadata,
    };
}
