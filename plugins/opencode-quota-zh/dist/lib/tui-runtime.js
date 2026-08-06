import { resolveRuntimeContextRoots } from "./config-file-utils.js";
import { createQuotaProviderRuntimeContext, createQuotaRuntimeRequestContext, resolveQuotaRuntimeContext, } from "./quota-runtime-context.js";
import { collectConcreteEnabledProviderIds, collectQuotaRenderData } from "./quota-render-data.js";
import { resolveQuotaFormatStyle } from "./quota-format-style.js";
import { buildCompactQuotaStatusLine } from "./tui-compact-format.js";
import { hasNativeProviderQuotaClient } from "./tui-native-provider-quota.js";
import { buildSidebarQuotaPanelLines, TUI_SIDEBAR_MAX_WIDTH } from "./tui-sidebar-format.js";
import { formatMaintainerAnnouncementHomeCountLine, getMaintainerAnnouncementsSummary, } from "./maintainer-announcements.js";
import { resolveExportPath, buildQuotaExport, writeQuotaExport, createExportProviderContext, } from "./quota-export.js";
const COMPACT_UNAVAILABLE_TEXT = "Quota unavailable";
const tuiQuotaClients = new WeakMap();
export function getTuiRuntimeRootHints(api) {
    return {
        worktreeRoot: api.state.path.worktree,
        activeDirectory: api.state.path.directory,
        fallbackDirectory: process.cwd(),
    };
}
export function resolveWorkspaceDir(api) {
    return resolveRuntimeContextRoots(getTuiRuntimeRootHints(api)).workspaceRoot;
}
function makeTuiQuotaClient(api) {
    return {
        config: {
            providers: async () => {
                try {
                    if (api.client.config?.providers) {
                        const response = await api.client.config.providers();
                        return {
                            data: {
                                providers: response.data?.providers ?? [],
                            },
                        };
                    }
                }
                catch {
                    // Fall back to TUI state provider list below.
                }
                return {
                    data: {
                        providers: api.state.provider.map((provider) => ({ id: provider.id })),
                    },
                };
            },
            get: async () => {
                try {
                    if (api.client.config?.get) {
                        const response = await api.client.config.get();
                        return {
                            data: response?.data && typeof response.data === "object" ? response.data : {},
                        };
                    }
                }
                catch {
                    // Fall back to empty config below.
                }
                return { data: {} };
            },
        },
    };
}
export function createTuiQuotaClient(api) {
    const existing = tuiQuotaClients.get(api);
    if (existing)
        return existing;
    const client = makeTuiQuotaClient(api);
    tuiQuotaClients.set(api, client);
    return client;
}
export function normalizeTuiSessionID(sessionID) {
    if (typeof sessionID !== "string")
        return undefined;
    const trimmed = sessionID.trim();
    if (!trimmed)
        return undefined;
    let decoded = trimmed;
    try {
        decoded = decodeURIComponent(trimmed).trim();
    }
    catch {
        decoded = trimmed;
    }
    if (!decoded || decoded.includes("{") || decoded.includes("}"))
        return undefined;
    if (decoded === "sessionID" || decoded === "session_id" || decoded === "id")
        return undefined;
    return trimmed;
}
function extractSessionModelMeta(input) {
    if (!input || typeof input !== "object")
        return {};
    const item = input;
    const providerID = item.model?.providerID;
    const modelID = item.model?.id;
    return providerID || modelID ? { providerID, modelID } : {};
}
function extractMessageModelMeta(input) {
    if (!input || typeof input !== "object")
        return {};
    const item = input;
    if (item.role === "assistant") {
        return item.providerID || item.modelID
            ? { providerID: item.providerID, modelID: item.modelID }
            : {};
    }
    if (item.role === "user") {
        return item.model?.providerID || item.model?.modelID
            ? { providerID: item.model?.providerID, modelID: item.model?.modelID }
            : {};
    }
    return {};
}
function getMessageSessionModelMeta(api, sessionID) {
    const messages = api.state.session.messages(sessionID);
    for (let index = messages.length - 1; index >= 0; index--) {
        const meta = extractMessageModelMeta(messages[index]);
        if (meta.providerID || meta.modelID)
            return meta;
    }
    return {};
}
export async function getTuiSessionModelMeta(api, sessionID) {
    const safeSessionID = normalizeTuiSessionID(sessionID);
    if (!safeSessionID)
        return {};
    const stateSession = api.state.session;
    try {
        const stateMeta = extractSessionModelMeta(stateSession.get?.(safeSessionID));
        if (stateMeta.providerID || stateMeta.modelID)
            return stateMeta;
    }
    catch {
        // Fall back to the client lookup below.
    }
    try {
        const sessionGet = api.client.session?.get;
        const response = await sessionGet?.({ sessionID: safeSessionID });
        const meta = extractSessionModelMeta(response?.data);
        if (meta.providerID || meta.modelID)
            return meta;
    }
    catch {
        // Fall back to session message state below.
    }
    return getMessageSessionModelMeta(api, safeSessionID);
}
function isSessionSidebarEnabled(runtime) {
    return runtime.config.enabled && runtime.config.tuiSidebarPanel.enabled;
}
function isSessionCompactEnabled(runtime) {
    return (runtime.config.enabled &&
        runtime.config.tuiCompactStatus.enabled &&
        runtime.config.tuiCompactStatus.sessionPrompt);
}
function buildDisabledSessionQuotaSurfaces() {
    return {
        sidebar: { status: "disabled", lines: [] },
        compact: { status: "disabled" },
    };
}
function buildCompactStatusFromData(params) {
    if (!params.enabled)
        return { status: "disabled" };
    if (params.result.selection?.waitingForCurrentSelection) {
        return { status: "loading" };
    }
    const effectiveFormatStyle = params.formatStyle ?? resolveQuotaFormatStyle(params.runtime.config.formatStyle);
    const data = effectiveFormatStyle === "allWindows" && params.result.allWindowsData
        ? params.result.allWindowsData
        : effectiveFormatStyle === "singleWindow" && params.result.singleWindowData !== undefined
            ? params.result.singleWindowData
            : params.result.data;
    const text = data
        ? buildCompactQuotaStatusLine({
            data,
            percentDisplayMode: params.runtime.config.percentDisplayMode,
            maxWidth: params.maxWidth ?? params.runtime.config.tuiCompactStatus.maxWidth,
        })
        : "";
    return {
        status: "ready",
        text: text.trim() ? text : COMPACT_UNAVAILABLE_TEXT,
    };
}
function buildSidebarPanelFromData(params) {
    if (params.result.selection?.waitingForCurrentSelection) {
        return {
            status: "loading",
            lines: [],
        };
    }
    const hasExpandedDetail = params.formatStyle === "allWindows" && Boolean(params.result.allWindowsData);
    const compactData = params.result.singleWindowData ?? params.result.data;
    const primaryData = params.formatStyle === "allWindows" && params.result.allWindowsData
        ? compactData
        : params.formatStyle === "singleWindow" && params.result.singleWindowData !== undefined
            ? params.result.singleWindowData
            : params.result.data;
    const primaryFormatStyle = params.formatStyle === "allWindows" && params.result.allWindowsData
        ? "singleWindow"
        : params.formatStyle;
    const lines = primaryData
        ? hasExpandedDetail
            ? [
                buildCompactQuotaStatusLine({
                    data: primaryData,
                    percentDisplayMode: params.runtime.config.percentDisplayMode,
                    maxWidth: TUI_SIDEBAR_MAX_WIDTH,
                }),
            ].filter((line) => Boolean(line))
            : buildSidebarQuotaPanelLines({
                data: primaryData,
                config: { ...params.runtime.config, formatStyle: primaryFormatStyle },
            })
        : [];
    const expandedLines = params.result.allWindowsData
        ? (buildSidebarQuotaPanelLines({
            data: params.result.allWindowsData,
            config: { ...params.runtime.config, formatStyle: "allWindows" },
        }) ?? [])
        : [];
    const linesExpanded = expandedLines.length > 0 && expandedLines.join("\n") !== lines.join("\n")
        ? expandedLines
        : undefined;
    const providerCount = params.result.active.length;
    return {
        status: "ready",
        lines,
        ...(providerCount > 0 ? { providerCount } : {}),
        ...(linesExpanded ? { linesExpanded } : {}),
    };
}
async function collectTuiQuotaRenderData(params) {
    const formatStyle = resolveQuotaFormatStyle(params.runtime.config.formatStyle);
    const sidebarFormatStyle = params.runtime.config.tuiSidebarPanel.formatStyle
        ? resolveQuotaFormatStyle(params.runtime.config.tuiSidebarPanel.formatStyle)
        : formatStyle;
    const compactFormatStyle = params.runtime.config.tuiCompactStatus.formatStyle
        ? resolveQuotaFormatStyle(params.runtime.config.tuiCompactStatus.formatStyle)
        : formatStyle;
    const result = await collectQuotaRenderData({
        client: params.runtime.client,
        resolveRuntimeProviderIds: params.runtime.resolveRuntimeProviderIds,
        config: params.runtime.config,
        configMeta: params.runtime.configMeta,
        request: params.request,
        surfaceExplicitProviderIssues: true,
        formatStyle,
        providers: params.runtime.providers,
        includeAllWindowsData: true,
    });
    return { result, formatStyle, sidebarFormatStyle, compactFormatStyle };
}
export async function resolveTuiSurfaceRegistration(api) {
    const quotaClient = createTuiQuotaClient(api);
    const runtime = await resolveQuotaRuntimeContext({
        client: quotaClient,
        roots: getTuiRuntimeRootHints(api),
    });
    const compact = runtime.config.tuiCompactStatus;
    const hasNativeProviderQuota = hasNativeProviderQuotaClient(api.client);
    const suppressedByNativeProviderQuota = compact.suppressWhenNativeProviderQuota && hasNativeProviderQuota;
    const compactEnabled = runtime.config.enabled && compact.enabled && !suppressedByNativeProviderQuota;
    const announcementHomeBottom = runtime.config.enabled &&
        runtime.config.maintainerAnnouncements.enabled &&
        runtime.config.maintainerAnnouncements.home;
    const exportHomeBottom = runtime.config.enabled && runtime.config.export.enabled;
    const compactHomeBottom = compactEnabled && compact.homeBottom;
    return {
        commandDisplay: runtime.config.tuiCommandDisplay,
        sidebar: {
            enabled: runtime.config.enabled && runtime.config.tuiSidebarPanel.enabled,
        },
        compact: {
            enabled: compactEnabled,
            homeBottom: compactHomeBottom,
            sessionPrompt: compactEnabled && compact.sessionPrompt,
            hasNativeProviderQuota,
            suppressedByNativeProviderQuota,
        },
        announcements: {
            homeBottom: announcementHomeBottom,
        },
        homeBottom: compactHomeBottom || announcementHomeBottom || exportHomeBottom,
    };
}
export async function loadTuiSessionQuotaSurfaces(params) {
    const quotaClient = createTuiQuotaClient(params.api);
    const runtime = await resolveQuotaRuntimeContext({
        client: quotaClient,
        roots: getTuiRuntimeRootHints(params.api),
        sessionID: params.sessionID,
        resolveSessionMeta: (sessionID) => getTuiSessionModelMeta(params.api, sessionID),
        includeSessionMeta: (config) => config.onlyCurrentModel,
    });
    const sidebarEnabled = isSessionSidebarEnabled(runtime);
    const compactEnabled = isSessionCompactEnabled(runtime);
    if (!sidebarEnabled && !compactEnabled) {
        return buildDisabledSessionQuotaSurfaces();
    }
    const { result, sidebarFormatStyle, compactFormatStyle } = await collectTuiQuotaRenderData({
        runtime,
        request: createQuotaRuntimeRequestContext(runtime),
    });
    return {
        sidebar: sidebarEnabled
            ? buildSidebarPanelFromData({ runtime, result, formatStyle: sidebarFormatStyle })
            : { status: "disabled", lines: [] },
        compact: buildCompactStatusFromData({
            runtime,
            result,
            enabled: compactEnabled,
            formatStyle: compactFormatStyle,
        }),
    };
}
export async function loadTuiHomeBottomStatus(params) {
    const quotaClient = createTuiQuotaClient(params.api);
    const runtime = await resolveQuotaRuntimeContext({
        client: quotaClient,
        roots: getTuiRuntimeRootHints(params.api),
    });
    const announcementEnabled = runtime.config.enabled &&
        runtime.config.maintainerAnnouncements.enabled &&
        runtime.config.maintainerAnnouncements.home;
    const compactSuppressedByNativeProviderQuota = runtime.config.tuiCompactStatus.suppressWhenNativeProviderQuota &&
        hasNativeProviderQuotaClient(params.api.client);
    const compactEnabled = runtime.config.enabled &&
        runtime.config.tuiCompactStatus.enabled &&
        runtime.config.tuiCompactStatus.homeBottom &&
        !compactSuppressedByNativeProviderQuota;
    if (!announcementEnabled && !compactEnabled) {
        return { status: "disabled", compact: { status: "disabled" } };
    }
    let announcementText;
    if (announcementEnabled) {
        const providerIds = await collectConcreteEnabledProviderIds({
            providers: runtime.providers,
            ctx: createQuotaProviderRuntimeContext(runtime),
            enabledProviders: runtime.config.enabledProviders,
        });
        const summary = getMaintainerAnnouncementsSummary({
            nowMs: params.nowMs,
            enabledProviders: providerIds,
            announcements: params.announcements,
        });
        announcementText = formatMaintainerAnnouncementHomeCountLine(summary.activeCount) || undefined;
    }
    if (!compactEnabled) {
        return announcementText
            ? { status: "ready", announcementText, compact: { status: "disabled" } }
            : { status: "disabled", compact: { status: "disabled" } };
    }
    const homeRuntime = {
        ...runtime,
        config: {
            ...runtime.config,
            onlyCurrentModel: false,
            showSessionTokens: false,
        },
        session: {},
    };
    const { result, compactFormatStyle } = await collectTuiQuotaRenderData({
        runtime: homeRuntime,
        request: createQuotaRuntimeRequestContext(homeRuntime),
    });
    const compact = buildCompactStatusFromData({
        runtime: homeRuntime,
        result,
        enabled: true,
        formatStyle: compactFormatStyle,
    });
    return { status: "ready", announcementText, compact };
}
export async function loadTuiHomeCompactStatus(params) {
    const quotaClient = createTuiQuotaClient(params.api);
    const runtime = await resolveQuotaRuntimeContext({
        client: quotaClient,
        roots: getTuiRuntimeRootHints(params.api),
    });
    const compactSuppressedByNativeProviderQuota = runtime.config.tuiCompactStatus.suppressWhenNativeProviderQuota &&
        hasNativeProviderQuotaClient(params.api.client);
    if (!runtime.config.enabled ||
        !runtime.config.tuiCompactStatus.enabled ||
        !runtime.config.tuiCompactStatus.homeBottom ||
        compactSuppressedByNativeProviderQuota) {
        return { status: "disabled" };
    }
    const homeRuntime = {
        ...runtime,
        config: {
            ...runtime.config,
            onlyCurrentModel: false,
            showSessionTokens: false,
        },
        session: {},
    };
    const { result, compactFormatStyle } = await collectTuiQuotaRenderData({
        runtime: homeRuntime,
        request: createQuotaRuntimeRequestContext(homeRuntime),
    });
    return buildCompactStatusFromData({
        runtime: homeRuntime,
        result,
        enabled: true,
        formatStyle: compactFormatStyle,
    });
}
/**
 * Writes the quota export file if `config.export.enabled` is true.
 *
 * Called from the TUI home bottom status refresh loop. Errors propagate to
 * the caller; the call-site in `tui.tsx` is responsible for catching and
 * logging them so a failed write never affects rendering.
 */
export async function writeTuiQuotaExportIfEnabled(params) {
    const quotaClient = createTuiQuotaClient(params.api);
    const runtime = await resolveQuotaRuntimeContext({
        client: quotaClient,
        roots: getTuiRuntimeRootHints(params.api),
    });
    if (!runtime.config.enabled || !runtime.config.export.enabled) {
        return;
    }
    const resolvedPath = resolveExportPath(runtime.config.export.path);
    const ctx = createExportProviderContext(runtime);
    const exportData = await buildQuotaExport({
        providers: runtime.providers,
        ctx,
        ttlMs: runtime.config.minIntervalMs,
        fromCache: true,
    });
    await writeQuotaExport(exportData, resolvedPath);
}
//# sourceMappingURL=tui-runtime.js.map