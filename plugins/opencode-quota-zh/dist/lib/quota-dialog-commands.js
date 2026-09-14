import { formatYmd, parseOptionalJsonArgs, parseQuotaBetweenArgs, startOfLocalDayMs, startOfNextLocalDayMs, } from "./command-parsing.js";
import { isCursorProviderId } from "./cursor-pricing.js";
import { renderCommandHeading } from "./format-utils.js";
import { refreshGoogleTokensForAllAccounts } from "./google.js";
import { BUNDLED_MAINTAINER_ANNOUNCEMENTS, getMaintainerAnnouncementsSummary, } from "./maintainer-announcements.js";
import { getPricingSnapshotMeta, getPricingSnapshotSource, getRuntimePricingRefreshStatePath, getRuntimePricingSnapshotPath, maybeRefreshPricingSnapshot, setPricingSnapshotAutoRefresh, setPricingSnapshotSelection, } from "./modelsdev-pricing.js";
import { formatQuotaCommand } from "./quota-command-format.js";
import { ALL_WINDOWS_FORMAT_STYLE } from "./quota-format-style.js";
import { collectConcreteEnabledProviderIds, collectQuotaRenderData, collectQuotaStatusLiveProbes, matchesQuotaProviderCurrentSelection, } from "./quota-render-data.js";
import { createQuotaProviderRuntimeContext, createQuotaRuntimeRequestContext, resolveQuotaRuntimeContext, } from "./quota-runtime-context.js";
import { aggregateUsage, resolveSessionTree, SessionNotFoundError, } from "./quota-stats.js";
import { formatQuotaStatsReport } from "./quota-stats-format.js";
import { buildQuotaStatusReport } from "./quota-status.js";
import { inspectTuiConfig } from "./tui-config-diagnostics.js";
import { getPackageVersion } from "./version.js";
const TOKEN_REPORT_COMMANDS = [
    {
        id: "tokens_today",
        template: "/tokens_today",
        description: "今日会话 Token 用量与 API 标价估算（本地时区自然日）。",
        title: "会话 Token 用量（今日）(/tokens_today)",
        metadataTitle: "会话 Token 用量（今日）",
        kind: "today",
    },
    {
        id: "tokens_daily",
        template: "/tokens_daily",
        description: "过去 24 小时会话 Token 用量与 API 标价估算。",
        title: "会话 Token 用量（过去 24 小时）(/tokens_daily)",
        metadataTitle: "会话 Token 用量（过去 24 小时）",
        kind: "rolling",
        windowMs: 24 * 60 * 60 * 1000,
    },
    {
        id: "tokens_weekly",
        template: "/tokens_weekly",
        description: "过去 7 天会话 Token 用量与 API 标价估算。",
        title: "会话 Token 用量（过去 7 天）(/tokens_weekly)",
        metadataTitle: "会话 Token 用量（过去 7 天）",
        kind: "rolling",
        windowMs: 7 * 24 * 60 * 60 * 1000,
    },
    {
        id: "tokens_monthly",
        template: "/tokens_monthly",
        description: "过去 30 天会话 Token 用量与 API 标价估算。",
        title: "会话 Token 用量（过去 30 天）(/tokens_monthly)",
        metadataTitle: "会话 Token 用量（过去 30 天）",
        kind: "rolling",
        windowMs: 30 * 24 * 60 * 60 * 1000,
    },
    {
        id: "tokens_all",
        template: "/tokens_all",
        description: "全部本地 OpenCode 历史的会话 Token 用量与 API 标价估算。",
        title: "会话 Token 用量（全部历史）(/tokens_all)",
        metadataTitle: "会话 Token 用量（全部历史）",
        kind: "all",
        topModels: 12,
        topSessions: 12,
    },
    {
        id: "tokens_session",
        template: "/tokens_session",
        description: "仅统计当前会话的 Token 用量与 API 标价估算。",
        title: "会话 Token 用量（当前会话）(/tokens_session)",
        metadataTitle: "会话 Token 用量（当前会话）",
        kind: "session",
    },
    {
        id: "tokens_session_all",
        template: "/tokens_session_all",
        description: "统计当前会话及全部子代理会话的任务树 Token 用量与 API 标价估算。",
        title: "任务树 Token 用量（当前会话）(/tokens_session_all)",
        metadataTitle: "任务树 Token 用量（当前会话）",
        kind: "session_tree",
    },
    {
        id: "tokens_between",
        template: "/tokens_between",
        description: "统计两个 YYYY-MM-DD 日期之间的会话 Token 用量与 API 标价估算（本地时区，含首尾日期）。",
        titleForRange: (startYmd, endYmd) => {
            return `会话 Token 用量（${formatYmd(startYmd)} .. ${formatYmd(endYmd)}）(/tokens_between)`;
        },
        metadataTitle: "会话 Token 用量（日期范围）",
        kind: "between",
    },
];
// Token report model names are capped at the length of this reference model.
const TUI_TOKEN_REPORT_MODEL_NAME_WIDTH_REFERENCE = "gemini-3-pro-preview";
const TUI_TOKEN_REPORT_MODEL_MAX_WIDTH = TUI_TOKEN_REPORT_MODEL_NAME_WIDTH_REFERENCE.length;
const TOKEN_REPORT_COMMANDS_BY_ID = (() => {
    const map = new Map();
    for (const spec of TOKEN_REPORT_COMMANDS) {
        map.set(spec.id, spec);
    }
    return map;
})();
export const QUOTA_DIALOG_COMMANDS = [
    {
        id: "quota",
        slashName: "quota",
        title: "OpenCode 额度",
        description: "显示确定性的额度信息。",
        dialogSize: "xlarge",
        requiresSession: true,
    },
    {
        id: "quota_status",
        slashName: "quota_status",
        title: "OpenCode 额度状态",
        description: "检查额度、TUI、价格与本地存储状态。",
        dialogSize: "xlarge",
        requiresSession: true,
        acceptsArguments: true,
    },
    {
        id: "quota_announcements",
        slashName: "quota_announcements",
        title: "OpenCode 额度公告",
        description: "列出当前生效的维护者公告。",
        dialogSize: "xlarge",
        acceptsArguments: true,
    },
    {
        id: "pricing_refresh",
        slashName: "pricing_refresh",
        title: "刷新 API 标价",
        description: "从 models.dev 刷新本地运行时价格快照。",
        dialogSize: "xlarge",
        acceptsArguments: true,
    },
    ...TOKEN_REPORT_COMMANDS.map((spec) => ({
        id: spec.id,
        slashName: spec.id,
        title: spec.kind === "between" ? "OpenCode 会话 Token 报告" : spec.metadataTitle,
        description: spec.description,
        dialogSize: "xlarge",
        requiresSession: spec.kind === "session" || spec.kind === "session_tree",
        acceptsArguments: spec.kind === "between",
    })),
];
const QUOTA_DIALOG_COMMANDS_BY_ID = (() => {
    const map = new Map();
    for (const spec of QUOTA_DIALOG_COMMANDS) {
        map.set(spec.id, spec);
    }
    return map;
})();
export function isQuotaDialogCommand(command) {
    return QUOTA_DIALOG_COMMANDS_BY_ID.has(command);
}
function isTokenReportCommand(cmd) {
    return TOKEN_REPORT_COMMANDS_BY_ID.has(cmd);
}
function describeQuotaCommandCurrentSelection(params) {
    if (isCursorProviderId(params.currentProviderID)) {
        return `current provider: ${params.currentProviderID}`;
    }
    if (params.currentModel) {
        return `current model: ${params.currentModel}`;
    }
    return "current session";
}
function buildQuotaCommandUnavailableMessage(result) {
    const selection = result.selection;
    if (!selection) {
        return "Quota unavailable\n\nNo enabled quota providers are configured.\n\nRun /quota_status for diagnostics.";
    }
    if (selection.filteringByCurrentSelection && selection.filtered.length === 0) {
        const detail = describeQuotaCommandCurrentSelection({
            currentModel: selection.currentModel,
            currentProviderID: selection.currentProviderID,
        });
        return `Quota unavailable\n\nNo enabled quota providers matched the ${detail}.\n\nRun /quota_status for diagnostics.`;
    }
    const availableIds = result.availability
        .filter((item) => item.ok)
        .map((item) => item.provider.id);
    if (availableIds.length === 0) {
        const scopedDetail = selection.filteringByCurrentSelection
            ? ` for the ${describeQuotaCommandCurrentSelection({
                currentModel: selection.currentModel,
                currentProviderID: selection.currentProviderID,
            })}`
            : "";
        return (`Quota unavailable\n\nNo provider data available${scopedDetail}. ` +
            "Make sure you are logged in to a supported provider (Copilot, OpenAI, etc.).\n\n" +
            "Run /quota_status for diagnostics.");
    }
    return (`Quota unavailable\n\nNo provider data available for detected providers (${availableIds.join(", ")}). ` +
        "This may be a temporary API error.\n\n" +
        "Run /quota_status for diagnostics.");
}
async function fetchQuotaCommandData(params) {
    const { runtime } = params;
    const request = createQuotaRuntimeRequestContext(runtime);
    const quotaResult = await collectQuotaRenderData({
        client: runtime.client,
        resolveRuntimeProviderIds: runtime.resolveRuntimeProviderIds,
        config: runtime.config,
        configMeta: runtime.configMeta,
        request,
        surfaceExplicitProviderIssues: false,
        formatStyle: ALL_WINDOWS_FORMAT_STYLE,
        providers: runtime.providers,
    });
    if (runtime.config.showSessionTokens && request.sessionID) {
        params.setLastSessionTokenError?.(quotaResult.sessionTokenError);
    }
    return quotaResult;
}
async function kickPricingRefresh(params) {
    try {
        const refreshPromise = maybeRefreshPricingSnapshot({
            reason: params.reason,
            snapshotSelection: params.snapshotSelection,
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
        await params.log?.("Pricing refresh failed", {
            reason: params.reason,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
async function buildQuotaReport(params) {
    const result = await aggregateUsage({
        sinceMs: params.sinceMs,
        untilMs: params.untilMs,
        sessionID: params.filterSessionID,
        sessionIDs: params.filterSessionIDs,
    });
    return formatQuotaStatsReport({
        title: params.title,
        result,
        topModels: params.topModels,
        topSessions: params.topSessions,
        focusSessionID: params.sessionID,
        sessionOnly: params.sessionOnly,
        reportKind: params.reportKind,
        sessionTree: params.sessionTree,
        generatedAtMs: params.generatedAtMs,
        tableOptions: {
            compactHeaders: true,
            modelNameMaxWidth: TUI_TOKEN_REPORT_MODEL_MAX_WIDTH,
        },
    });
}
export function summarizeQuotaStatusLiveProbes(probes) {
    return probes.map((probe) => ({
        id: probe.providerId,
        ok: probe.result.attempted && probe.result.errors.length === 0,
    }));
}
export async function buildStatusReportData(params) {
    const runtimeConfig = params.runtime.config;
    if (!runtimeConfig.enabled) {
        return { output: null, payload: null, hasComparableProviderData: false };
    }
    await kickPricingRefresh({
        reason: "status",
        maxWaitMs: 750,
        snapshotSelection: runtimeConfig.pricingSnapshot.source,
        log: params.log,
    });
    const currentSession = params.runtime.session.sessionMeta ?? {};
    const currentModel = currentSession.modelID;
    const currentProviderID = currentSession.providerID;
    const sessionModelLookup = !params.sessionID
        ? "no_session"
        : currentModel
            ? "ok"
            : "not_found";
    const isAutoMode = runtimeConfig.enabledProviders === "auto";
    const providers = params.providerFilterId
        ? params.runtime.providers.filter((provider) => provider.id === params.providerFilterId)
        : params.runtime.providers;
    const providerContext = createQuotaProviderRuntimeContext(params.runtime);
    const availability = await Promise.all(providers.map(async (p) => {
        let ok = false;
        try {
            ok = await p.isAvailable(providerContext);
        }
        catch {
            ok = false;
        }
        return {
            id: p.id,
            enabled: isAutoMode ? ok : runtimeConfig.enabledProviders.includes(p.id),
            available: ok,
            matchesCurrentModel: currentModel || isCursorProviderId(currentProviderID)
                ? matchesQuotaProviderCurrentSelection({
                    provider: p,
                    currentModel,
                    currentProviderID,
                    enabledProviders: runtimeConfig.enabledProviders,
                    quotaProviders: runtimeConfig.quotaProviders,
                })
                : undefined,
        };
    }));
    if (isAutoMode) {
        await params.onDetectedProviderIds?.(availability.filter((item) => item.available).map((item) => item.id));
    }
    // Status diagnostics belong to provider results, including missing or disabled
    // providers. Provider fetch implementations must keep unconfigured cases local.
    const liveProbeProviders = providers;
    let providerLiveProbes = [];
    if (liveProbeProviders.length > 0) {
        try {
            providerLiveProbes = await collectQuotaStatusLiveProbes({
                client: params.runtime.client,
                resolveRuntimeProviderIds: params.runtime.resolveRuntimeProviderIds,
                config: runtimeConfig,
                configMeta: params.runtime.configMeta,
                request: createQuotaRuntimeRequestContext(params.runtime),
                providers: liveProbeProviders,
            });
        }
        catch (error) {
            await params.log?.("Failed to collect /quota_status live probes", {
                providers: liveProbeProviders.map((provider) => provider.id),
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    const refresh = params.refreshGoogleTokens
        ? await refreshGoogleTokensForAllAccounts({ skewMs: params.skewMs, force: params.force })
        : null;
    const tuiDiagnostics = await inspectTuiConfig({ roots: params.runtime.roots });
    const announcementProviderIds = availability
        .filter((item) => item.enabled && item.available)
        .map((item) => item.id);
    const maintainerAnnouncementsSummary = getMaintainerAnnouncementsSummary({
        enabledProviders: announcementProviderIds,
    });
    const output = await buildQuotaStatusReport({
        tuiDiagnostics,
        configSource: params.runtime.configMeta.source,
        configPaths: params.runtime.configMeta.paths,
        globalConfigPaths: params.runtime.configMeta.globalConfigPaths,
        workspaceConfigPaths: params.runtime.configMeta.workspaceConfigPaths,
        settingSources: params.runtime.configMeta.settingSources,
        configIssues: params.runtime.configMeta.configIssues,
        enabledProviders: runtimeConfig.enabledProviders,
        googleModels: runtimeConfig.googleModels,
        anthropicBinaryPath: runtimeConfig.anthropicBinaryPath,
        cursorPlan: runtimeConfig.cursorPlan,
        cursorIncludedApiUsd: runtimeConfig.cursorIncludedApiUsd,
        cursorBillingCycleStartDay: runtimeConfig.cursorBillingCycleStartDay,
        opencodeGoWindows: runtimeConfig.opencodeGoWindows,
        pricingSnapshotSource: runtimeConfig.pricingSnapshot.source,
        onlyCurrentModel: runtimeConfig.onlyCurrentModel,
        currentModel,
        sessionModelLookup,
        providerAvailability: availability,
        providerLiveProbes,
        quotaProviders: runtimeConfig.quotaProviders,
        googleRefresh: refresh
            ? {
                attempted: true,
                total: refresh.total,
                successCount: refresh.successCount,
                failures: refresh.failures,
            }
            : { attempted: false },
        sessionTokenError: params.lastSessionTokenError,
        maintainerAnnouncements: {
            config: runtimeConfig.maintainerAnnouncements,
            summary: maintainerAnnouncementsSummary,
        },
        generatedAtMs: params.generatedAtMs,
    });
    const version = (await getPackageVersion()) ?? "unknown";
    const pricingMeta = getPricingSnapshotMeta();
    const activePricingSource = getPricingSnapshotSource();
    const payload = {
        version,
        generatedAt: new Date(params.generatedAtMs).toISOString(),
        config: {
            configSource: params.runtime.configMeta.source,
            configPaths: params.runtime.configMeta.paths,
            globalConfigPaths: params.runtime.configMeta.globalConfigPaths,
            workspaceConfigPaths: params.runtime.configMeta.workspaceConfigPaths,
            enabledProviders: runtimeConfig.enabledProviders,
            onlyCurrentModel: runtimeConfig.onlyCurrentModel,
            pricingSnapshotSource: runtimeConfig.pricingSnapshot.source,
        },
        providers: availability,
        pricing: {
            selection: runtimeConfig.pricingSnapshot.source,
            activeSource: activePricingSource,
            snapshot: {
                source: pricingMeta.source,
                generatedAt: pricingMeta.generatedAt > 0 ? new Date(pricingMeta.generatedAt).toISOString() : null,
                units: pricingMeta.units,
            },
            snapshotPath: getRuntimePricingSnapshotPath(),
            refreshStatePath: getRuntimePricingRefreshStatePath(),
        },
        liveProbes: summarizeQuotaStatusLiveProbes(providerLiveProbes),
    };
    return {
        output,
        payload,
        hasComparableProviderData: providerLiveProbes.some((probe) => probe.result.entries.length > 0),
    };
}
async function buildStatusReport(params) {
    return (await buildStatusReportData(params)).output;
}
function formatIsoTimestamp(timestampMs) {
    return typeof timestampMs === "number" && Number.isFinite(timestampMs) && timestampMs > 0
        ? new Date(timestampMs).toISOString()
        : "(none)";
}
function buildPricingRefreshCommandOutput(params) {
    const meta = getPricingSnapshotMeta();
    const activeSource = getPricingSnapshotSource();
    const resultLabel = params.result.reason ??
        params.result.state.lastResult ??
        (params.result.updated ? "success" : "unknown");
    const lines = [
        renderCommandHeading({
            title: "Pricing Refresh (/pricing_refresh)",
            generatedAtMs: params.generatedAtMs,
        }),
        "",
        "refresh:",
        `- attempted: ${params.result.attempted ? "true" : "false"}`,
        `- result: ${resultLabel}`,
        `- runtime_snapshot_persisted: ${params.result.updated ? "true" : "false"}`,
    ];
    if (params.result.error) {
        lines.push(`- error: ${params.result.error}`);
    }
    lines.push("");
    lines.push("pricing_snapshot:");
    lines.push(`- selection: configured=${params.configuredSelection} active=${activeSource}`);
    lines.push(`- active_snapshot: source=${meta.source} generated_at=${formatIsoTimestamp(meta.generatedAt)} units=${meta.units}`);
    lines.push(`- runtime_paths: snapshot=${getRuntimePricingSnapshotPath()} refresh_state=${getRuntimePricingRefreshStatePath()}`);
    if (params.configuredSelection === "bundled" && params.result.updated) {
        lines.push("- selection_note: runtime snapshot refreshed locally, but active reports remain pinned to bundled pricing");
    }
    return lines.join("\n");
}
function buildTokenReportUnavailableOutput(params) {
    const lines = [
        renderCommandHeading({
            title: `Token report unavailable (${params.command})`,
            generatedAtMs: params.generatedAtMs,
        }),
        "",
        "session_lookup_error:",
        `- session_id: ${params.error.sessionID}`,
        `- error: ${params.error.message}`,
        `- checked_path: ${params.error.checkedPath}`,
    ];
    return lines.join("\n");
}
async function buildQuotaAnnouncementsCommandOutput(runtime) {
    let activeAnnouncements = [];
    if (runtime.config.enabled && runtime.config.maintainerAnnouncements.enabled) {
        const providerIds = await collectConcreteEnabledProviderIds({
            providers: runtime.providers,
            ctx: createQuotaProviderRuntimeContext(runtime),
            enabledProviders: runtime.config.enabledProviders,
        });
        const summary = getMaintainerAnnouncementsSummary({
            announcements: BUNDLED_MAINTAINER_ANNOUNCEMENTS,
            enabledProviders: providerIds,
        });
        activeAnnouncements = summary.activeAnnouncements;
    }
    const lines = ["Maintainer announcements", ""];
    if (activeAnnouncements.length === 0) {
        lines.push("No current announcements.");
        return lines.join("\n");
    }
    for (const evaluation of activeAnnouncements) {
        lines.push(`- ${evaluation.announcement.message}`);
        if (evaluation.announcement.url) {
            lines.push(`  ${evaluation.announcement.url}`);
        }
    }
    return lines.join("\n");
}
function outputResult(params) {
    const spec = QUOTA_DIALOG_COMMANDS_BY_ID.get(params.command);
    return {
        state: "output",
        command: params.command,
        title: spec.title,
        output: params.output,
        dialogSize: spec.dialogSize,
    };
}
async function buildTokenReportCommandOutput(params) {
    const spec = TOKEN_REPORT_COMMANDS_BY_ID.get(params.command);
    const sessionID = params.sessionID;
    const untilMs = params.generatedAtMs;
    await kickPricingRefresh({
        reason: "tokens",
        maxWaitMs: 750,
        snapshotSelection: params.runtime.config.pricingSnapshot.source,
        log: params.log,
    });
    if (!sessionID && (spec.kind === "session" || spec.kind === "session_tree")) {
        return buildTokenReportUnavailableOutput({
            command: spec.template,
            generatedAtMs: params.generatedAtMs,
            error: new SessionNotFoundError("(none)", "(none)"),
        });
    }
    try {
        if (spec.kind === "between") {
            const parsed = parseQuotaBetweenArgs(params.arguments);
            if (!parsed.ok) {
                return `Invalid arguments for /${spec.id}\n\n${parsed.error}\n\nExpected: /${spec.id} YYYY-MM-DD YYYY-MM-DD\nExample: /${spec.id} 2026-01-01 2026-01-15`;
            }
            const sinceMs = startOfLocalDayMs(parsed.startYmd);
            const rangeUntilMs = startOfNextLocalDayMs(parsed.endYmd);
            return await buildQuotaReport({
                title: spec.titleForRange(parsed.startYmd, parsed.endYmd),
                sinceMs,
                untilMs: rangeUntilMs,
                sessionID: sessionID ?? "",
                generatedAtMs: params.generatedAtMs,
            });
        }
        let sinceMs;
        let filterSessionID;
        let filterSessionIDs;
        let sessionOnly;
        let topModels;
        let topSessions;
        let reportKind;
        let sessionTree;
        switch (spec.kind) {
            case "rolling":
                sinceMs = untilMs - spec.windowMs;
                break;
            case "today": {
                const now = new Date(untilMs);
                const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                sinceMs = startOfDay.getTime();
                break;
            }
            case "session":
                filterSessionID = sessionID;
                sessionOnly = true;
                reportKind = "session";
                break;
            case "session_tree": {
                const nodes = await resolveSessionTree(sessionID);
                filterSessionIDs = nodes.map((node) => node.sessionID);
                reportKind = "session_tree";
                sessionTree = { rootSessionID: sessionID, nodes };
                break;
            }
            case "all":
                topModels = spec.topModels;
                topSessions = spec.topSessions;
                break;
        }
        return await buildQuotaReport({
            title: spec.title,
            sinceMs,
            untilMs: spec.kind === "rolling" || spec.kind === "today" ? untilMs : undefined,
            sessionID: sessionID ?? "",
            filterSessionID,
            filterSessionIDs,
            sessionOnly,
            reportKind,
            sessionTree,
            topModels,
            topSessions,
            generatedAtMs: params.generatedAtMs,
        });
    }
    catch (err) {
        if (err instanceof SessionNotFoundError) {
            return buildTokenReportUnavailableOutput({
                command: spec.template,
                generatedAtMs: params.generatedAtMs,
                error: err,
            });
        }
        throw err;
    }
}
export async function buildQuotaDialogCommandOutput(params) {
    const generatedAtMs = params.generatedAtMs ?? Date.now();
    const runtime = await resolveQuotaRuntimeContext({
        client: params.client,
        roots: params.roots,
        sessionID: params.sessionID,
        sessionMeta: params.sessionMeta,
        resolveSessionMeta: params.resolveSessionMeta,
        includeSessionMeta: (config) => config.onlyCurrentModel || params.command === "quota_status",
    });
    setPricingSnapshotAutoRefresh(runtime.config.pricingSnapshot.autoRefresh);
    setPricingSnapshotSelection(runtime.config.pricingSnapshot.source);
    if (!runtime.config.enabled && params.command !== "quota_announcements") {
        return { state: "noop", command: params.command, reason: "disabled" };
    }
    if (params.command === "quota") {
        const reportData = await fetchQuotaCommandData({
            runtime,
            setLastSessionTokenError: params.setLastSessionTokenError,
        });
        if (!reportData.data ||
            (reportData.selection?.filteringByCurrentSelection &&
                reportData.selection.filtered.length === 0)) {
            return outputResult({
                command: params.command,
                output: buildQuotaCommandUnavailableMessage(reportData),
            });
        }
        return outputResult({
            command: params.command,
            output: formatQuotaCommand({
                ...reportData.data,
                generatedAtMs,
                percentDisplayMode: runtime.config.percentDisplayMode,
                percentLabelStyle: runtime.config.percentLabelStyle,
                accountingDetail: runtime.config.accountingDetail,
                resetTimeSpaced: runtime.config.resetTimeSpaced,
            }),
        });
    }
    if (params.command === "quota_status") {
        const parsed = parseOptionalJsonArgs(params.arguments);
        if (!parsed.ok) {
            return outputResult({
                command: params.command,
                output: `Invalid arguments for /quota_status\n\n${parsed.error}\n\nExample:\n/quota_status {"refreshGoogleTokens": true}`,
            });
        }
        const output = await buildStatusReport({
            runtime,
            refreshGoogleTokens: parsed.value["refreshGoogleTokens"] === true,
            skewMs: typeof parsed.value["skewMs"] === "number" ? parsed.value["skewMs"] : undefined,
            force: parsed.value["force"] === true,
            sessionID: params.sessionID,
            generatedAtMs,
            lastSessionTokenError: params.lastSessionTokenError,
            log: params.log,
            onDetectedProviderIds: params.onDetectedProviderIds,
        });
        return output
            ? outputResult({ command: params.command, output })
            : { state: "noop", command: params.command, reason: "disabled" };
    }
    if (params.command === "quota_announcements") {
        if ((params.arguments ?? "").trim()) {
            return outputResult({
                command: params.command,
                output: "Invalid arguments for /quota_announcements\n\nThis command does not accept arguments.\n\nUsage: /quota_announcements",
            });
        }
        return outputResult({
            command: params.command,
            output: await buildQuotaAnnouncementsCommandOutput(runtime),
        });
    }
    if (params.command === "pricing_refresh") {
        if ((params.arguments ?? "").trim()) {
            return outputResult({
                command: params.command,
                output: "Invalid arguments for /pricing_refresh\n\nThis command does not accept arguments.\n\nUsage:\n/pricing_refresh",
            });
        }
        const result = await maybeRefreshPricingSnapshot({
            reason: "manual",
            force: true,
            snapshotSelection: runtime.config.pricingSnapshot.source,
            allowRefreshWhenSelectionBundled: true,
        });
        return outputResult({
            command: params.command,
            output: buildPricingRefreshCommandOutput({
                result,
                configuredSelection: runtime.config.pricingSnapshot.source,
                generatedAtMs,
            }),
        });
    }
    if (isTokenReportCommand(params.command)) {
        return outputResult({
            command: params.command,
            output: await buildTokenReportCommandOutput({
                command: params.command,
                arguments: params.arguments,
                sessionID: params.sessionID,
                generatedAtMs,
                runtime,
                log: params.log,
            }),
        });
    }
    return { state: "noop", command: params.command, reason: "disabled" };
}
