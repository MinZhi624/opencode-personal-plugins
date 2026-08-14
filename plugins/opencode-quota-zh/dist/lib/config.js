/**
 * Configuration loader for opencode-quota plugin.
 *
 * Precedence model:
 * - Global/user config provides defaults.
 * - Workspace config at the resolved config root overrides ordinary settings.
 * - SDK config is used only as a fallback when no file-backed config exists.
 */
import { existsSync } from "fs";
import { join } from "path";
import { getEffectiveConfigRoot } from "./config-file-utils.js";
import { isResetTimeDecimals } from "./format-utils.js";
import { buildOpenCodeConfigCandidates, readOpenCodeConfigCandidate, } from "./opencode-config-read.js";
import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";
import { getQuotaProviderShape, normalizeQuotaProviderId } from "./provider-metadata.js";
import { isQuotaFormatStyle, resolveQuotaFormatStyle } from "./quota-format-style.js";
import { cloneQuotaProviders, validateQuotaProviders } from "./quota-providers.js";
import { DEFAULT_CONFIG } from "./types.js";
/**
 * Canonical v2 config sidecar paths under the isolated `opencode-quota-zh`
 * namespace (ADR 0002). JSONC is preferred; JSON remains accepted.
 */
export const QUOTA_TOAST_CONFIG_RELATIVE_PATHS = [
    "opencode-quota-zh/config.jsonc",
    "opencode-quota-zh/config.json",
];
export const QUOTA_TOAST_CONFIG_RELATIVE_PATH = QUOTA_TOAST_CONFIG_RELATIVE_PATHS[1];
/**
 * Legacy upstream-namespace sidecar paths. They are no longer configuration
 * sources (ADR 0001/0002); their presence is reported as a migration
 * requirement by the diagnostics and never applied.
 */
export const LEGACY_QUOTA_TOAST_CONFIG_RELATIVE_PATHS = [
    "opencode-quota/quota-toast.jsonc",
    "opencode-quota/quota-toast.json",
];
export const QUOTA_TOAST_SETTING_SOURCE_KEYS = [
    "enabled",
    "tuiCommandDisplay",
    "formatStyle",
    "percentDisplayMode",
    "resetTimeDecimals",
    "minIntervalMs",
    "requestTimeoutMs",
    "debug",
    "enabledProviders",
    "quotaProviders",
    "anthropicBinaryPath",
    "googleModels",
    "cursorPlan",
    "cursorIncludedApiUsd",
    "cursorBillingCycleStartDay",
    "opencodeGoWindows",
    "opencodeMonthlyLimit",
    "pricingSnapshot.source",
    "pricingSnapshot.autoRefresh",
    "toastDurationMs",
    "onlyCurrentModel",
    "showSessionTokens",
    "sessionTokenScope",
    "tuiSidebarPanel.enabled",
    "tuiSidebarPanel.formatStyle",
    "tuiCompactStatus.enabled",
    "tuiCompactStatus.homeBottom",
    "tuiCompactStatus.sessionPrompt",
    "tuiCompactStatus.suppressWhenNativeProviderQuota",
    "tuiCompactStatus.maxWidth",
    "tuiCompactStatus.formatStyle",
    "tuiPromptBar.enabled",
    "startupHint.enabled",
    "promptBar.enabled",
    "alerts.enabled",
    "alerts.percentRemainingThreshold",
    "alerts.repeatAfterMinutes",
    "alerts.balanceThresholds",
    "maintainerAnnouncements.enabled",
    "maintainerAnnouncements.home",
    "layout.maxWidth",
    "layout.narrowAt",
    "layout.tinyAt",
    "export.enabled",
    "export.path",
    "telemetry.enabled",
];
export function createLoadConfigMeta() {
    return {
        source: "defaults",
        paths: [],
        globalConfigPaths: [],
        workspaceConfigPaths: [],
        settingSources: {},
        networkSettingSources: {},
        configIssues: [],
    };
}
const NETWORK_SETTING_SOURCE_KEYS = [
    "enabled",
    "enabledProviders",
    "quotaProviders",
    "minIntervalMs",
    "requestTimeoutMs",
    "pricingSnapshot.source",
    "pricingSnapshot.autoRefresh",
];
export function getQuotaToastConfigPath(configRootDir, format = "json") {
    return join(configRootDir, `opencode-quota-zh/config.${format}`);
}
export function resolveQuotaToastConfigPath(configRootDir) {
    return (QUOTA_TOAST_CONFIG_RELATIVE_PATHS.map((relativePath) => join(configRootDir, relativePath)).find((path) => existsSync(path)) ?? getQuotaToastConfigPath(configRootDir));
}
function hasOwnKey(value, key) {
    return Object.hasOwn(value, key);
}
function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
/**
 * Validates and normalizes a Google model ID
 */
function isValidGoogleModelId(id) {
    return typeof id === "string" && ["G3PRO", "G3FLASH", "CLAUDE", "G3IMAGE", "GPTOSS"].includes(id);
}
function isValidCursorQuotaPlan(plan) {
    return typeof plan === "string" && ["none", "pro", "pro-plus", "ultra"].includes(plan);
}
function isValidPricingSnapshotSource(source) {
    return typeof source === "string" && ["auto", "bundled", "runtime"].includes(source);
}
function isValidPricingSnapshotAutoRefresh(value) {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}
function isValidPercentDisplayMode(value) {
    return value === "remaining" || value === "used";
}
function isValidTuiCommandDisplay(value) {
    return value === "inline" || value === "dialog";
}
function isValidSessionTokenScope(value) {
    return value === "current" || value === "tree";
}
function isPositiveNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function isValidCursorBillingCycleStartDay(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 28;
}
const VALID_OPENCODE_GO_WINDOWS = ["rolling", "weekly", "monthly"];
function isValidOpenCodeGoWindows(value) {
    if (!Array.isArray(value))
        return false;
    if (value.length === 0)
        return false;
    return value.every((v) => typeof v === "string" &&
        VALID_OPENCODE_GO_WINDOWS.includes(v));
}
function normalizeOptionalString(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}
function getExplicitFormatStyle(config) {
    if (!config || !isQuotaFormatStyle(config.formatStyle)) {
        return undefined;
    }
    return resolveQuotaFormatStyle(config.formatStyle);
}
function getConfiguredFormatStyle(quotaToastConfig) {
    const formatStyle = getExplicitFormatStyle(quotaToastConfig);
    if (formatStyle) {
        return formatStyle;
    }
    const legacyFormatStyle = quotaToastConfig
        ?.toastStyle;
    if (isQuotaFormatStyle(legacyFormatStyle)) {
        return resolveQuotaFormatStyle(legacyFormatStyle);
    }
    return undefined;
}
/**
 * Remove duplicates from an array while preserving order
 */
function dedupe(list) {
    return [...new Set(list)];
}
function cloneDefaultConfig() {
    return cloneConfig(DEFAULT_CONFIG);
}
function cloneConfig(config) {
    return {
        ...config,
        enabledProviders: Array.isArray(config.enabledProviders)
            ? [...config.enabledProviders]
            : config.enabledProviders,
        quotaProviders: cloneQuotaProviders(config.quotaProviders),
        googleModels: [...config.googleModels],
        opencodeGoWindows: [...config.opencodeGoWindows],
        opencodeMonthlyLimit: config.opencodeMonthlyLimit,
        pricingSnapshot: { ...config.pricingSnapshot },
        tuiSidebarPanel: { ...config.tuiSidebarPanel },
        tuiCompactStatus: { ...config.tuiCompactStatus },
        tuiPromptBar: { ...config.tuiPromptBar },
        startupHint: { ...config.startupHint },
        promptBar: { ...config.promptBar },
        alerts: {
            ...config.alerts,
            balanceThresholds: cloneBalanceThresholds(config.alerts.balanceThresholds),
        },
        maintainerAnnouncements: { ...config.maintainerAnnouncements },
        layout: { ...config.layout },
        export: { ...config.export },
        telemetry: { ...config.telemetry },
    };
}
function cloneBalanceThresholds(balanceThresholds) {
    const cloned = {};
    for (const [providerId, thresholds] of Object.entries(balanceThresholds)) {
        cloned[providerId] = { ...thresholds };
    }
    return cloned;
}
function describeInvalidProviderValue(value) {
    return typeof value === "string" ? value : typeof value;
}
function normalizeEnabledProviders(value) {
    if (value === "auto") {
        return { value: "auto", issues: [] };
    }
    if (!Array.isArray(value)) {
        return {
            value: [],
            issues: ['expected "auto" or an array of provider ids'],
            invalidEmpty: true,
        };
    }
    if (value.length === 0) {
        return { value: [], issues: [] };
    }
    const validProviders = [];
    const invalidProviders = [];
    for (const provider of value) {
        if (typeof provider !== "string") {
            invalidProviders.push(describeInvalidProviderValue(provider));
            continue;
        }
        const normalized = normalizeQuotaProviderId(provider);
        if (normalized && getQuotaProviderShape(normalized)) {
            validProviders.push(normalized);
        }
        else {
            invalidProviders.push(provider);
        }
    }
    const issues = invalidProviders.length
        ? [`unknown provider id(s): ${dedupe(invalidProviders).join(", ")}`]
        : [];
    const normalizedProviders = dedupe(validProviders);
    return {
        value: normalizedProviders,
        issues,
        invalidEmpty: normalizedProviders.length === 0 && invalidProviders.length > 0,
    };
}
function normalizeGoogleModels(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const models = value.filter(isValidGoogleModelId);
    return models.length > 0 ? models : undefined;
}
function extractPricingSnapshotPatch(value) {
    if (!isPlainObject(value)) {
        return undefined;
    }
    const patch = {};
    if (hasOwnKey(value, "source") && isValidPricingSnapshotSource(value.source)) {
        patch.source = value.source;
    }
    if (hasOwnKey(value, "autoRefresh") && isValidPricingSnapshotAutoRefresh(value.autoRefresh)) {
        patch.autoRefresh = value.autoRefresh;
    }
    return Object.keys(patch).length > 0 ? patch : undefined;
}
function extractTuiSidebarPanelPatch(value) {
    if (!isPlainObject(value)) {
        return undefined;
    }
    const patch = {};
    if (hasOwnKey(value, "enabled") && typeof value.enabled === "boolean") {
        patch.enabled = value.enabled;
    }
    const sidebarFormatStyle = getExplicitFormatStyle(value);
    if (sidebarFormatStyle) {
        patch.formatStyle = sidebarFormatStyle;
    }
    return Object.keys(patch).length > 0 ? patch : undefined;
}
function extractTuiCompactStatusPatch(value) {
    if (!isPlainObject(value)) {
        return undefined;
    }
    const patch = {};
    if (hasOwnKey(value, "enabled") && typeof value.enabled === "boolean") {
        patch.enabled = value.enabled;
    }
    if (hasOwnKey(value, "homeBottom") && typeof value.homeBottom === "boolean") {
        patch.homeBottom = value.homeBottom;
    }
    if (hasOwnKey(value, "sessionPrompt") && typeof value.sessionPrompt === "boolean") {
        patch.sessionPrompt = value.sessionPrompt;
    }
    if (hasOwnKey(value, "suppressWhenNativeProviderQuota") &&
        typeof value.suppressWhenNativeProviderQuota === "boolean") {
        patch.suppressWhenNativeProviderQuota = value.suppressWhenNativeProviderQuota;
    }
    if (hasOwnKey(value, "maxWidth") && isPositiveNumber(value.maxWidth)) {
        patch.maxWidth = value.maxWidth;
    }
    const compactFormatStyle = getExplicitFormatStyle(value);
    if (compactFormatStyle) {
        patch.formatStyle = compactFormatStyle;
    }
    return Object.keys(patch).length > 0 ? patch : undefined;
}
function extractTuiPromptBarPatch(value) {
    if (!isPlainObject(value)) {
        return undefined;
    }
    const patch = {};
    if (hasOwnKey(value, "enabled") && typeof value.enabled === "boolean") {
        patch.enabled = value.enabled;
    }
    return Object.keys(patch).length > 0 ? patch : undefined;
}
function extractStartupHintPatch(value) {
    if (!isPlainObject(value)) {
        return { issues: [] };
    }
    const patch = {};
    const issues = [];
    if (hasOwnKey(value, "enabled")) {
        if (typeof value.enabled === "boolean") {
            patch.enabled = value.enabled;
        }
        else {
            issues.push({ key: "startupHint.enabled", message: "expected boolean" });
        }
    }
    return { ...(Object.keys(patch).length > 0 ? { value: patch } : {}), issues };
}
function extractPromptBarPatch(value) {
    if (!isPlainObject(value)) {
        return { issues: [] };
    }
    const patch = {};
    const issues = [];
    if (hasOwnKey(value, "enabled")) {
        if (typeof value.enabled === "boolean") {
            patch.enabled = value.enabled;
        }
        else {
            issues.push({ key: "promptBar.enabled", message: "expected boolean" });
        }
    }
    return { ...(Object.keys(patch).length > 0 ? { value: patch } : {}), issues };
}
const ISO_CURRENCY_PATTERN = /^[A-Z]{3}$/u;
function isValidBalanceThresholds(value) {
    if (!isPlainObject(value)) {
        return false;
    }
    for (const thresholds of Object.values(value)) {
        if (!isPlainObject(thresholds)) {
            return false;
        }
        for (const [currency, amount] of Object.entries(thresholds)) {
            if (!ISO_CURRENCY_PATTERN.test(currency)) {
                return false;
            }
            if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
                return false;
            }
        }
    }
    return true;
}
function isValidPercentRemainingThreshold(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}
function isValidRepeatAfterMinutes(value) {
    if (value === null) {
        return true;
    }
    return typeof value === "number" && Number.isInteger(value) && value >= 15;
}
function extractAlertsPatch(value) {
    if (!isPlainObject(value)) {
        return { issues: [] };
    }
    const patch = {};
    const issues = [];
    if (hasOwnKey(value, "enabled")) {
        if (typeof value.enabled === "boolean") {
            patch.enabled = value.enabled;
        }
        else {
            issues.push({ key: "alerts.enabled", message: "expected boolean" });
        }
    }
    if (hasOwnKey(value, "percentRemainingThreshold")) {
        if (isValidPercentRemainingThreshold(value.percentRemainingThreshold)) {
            patch.percentRemainingThreshold = value.percentRemainingThreshold;
        }
        else {
            issues.push({
                key: "alerts.percentRemainingThreshold",
                message: "expected a number between 0 and 100 (percent remaining)",
            });
        }
    }
    if (hasOwnKey(value, "repeatAfterMinutes")) {
        if (isValidRepeatAfterMinutes(value.repeatAfterMinutes)) {
            patch.repeatAfterMinutes = value.repeatAfterMinutes;
        }
        else {
            issues.push({
                key: "alerts.repeatAfterMinutes",
                message: "expected null or an integer of at least 15 minutes",
            });
        }
    }
    if (hasOwnKey(value, "balanceThresholds")) {
        if (isValidBalanceThresholds(value.balanceThresholds)) {
            patch.balanceThresholds = value.balanceThresholds;
        }
        else {
            issues.push({
                key: "alerts.balanceThresholds",
                message: "expected provider -> ISO currency -> positive number",
            });
        }
    }
    return { ...(Object.keys(patch).length > 0 ? { value: patch } : {}), issues };
}
function extractMaintainerAnnouncementsPatch(value) {
    if (!isPlainObject(value)) {
        return undefined;
    }
    const patch = {};
    if (hasOwnKey(value, "enabled") && typeof value.enabled === "boolean") {
        patch.enabled = value.enabled;
    }
    if (hasOwnKey(value, "home") && typeof value.home === "boolean") {
        patch.home = value.home;
    }
    return Object.keys(patch).length > 0 ? patch : undefined;
}
function extractLayoutPatch(value) {
    if (!isPlainObject(value)) {
        return undefined;
    }
    const patch = {};
    if (hasOwnKey(value, "maxWidth") && isPositiveNumber(value.maxWidth)) {
        patch.maxWidth = value.maxWidth;
    }
    if (hasOwnKey(value, "narrowAt") && isPositiveNumber(value.narrowAt)) {
        patch.narrowAt = value.narrowAt;
    }
    if (hasOwnKey(value, "tinyAt") && isPositiveNumber(value.tinyAt)) {
        patch.tinyAt = value.tinyAt;
    }
    return Object.keys(patch).length > 0 ? patch : undefined;
}
function extractExportConfigPatch(value) {
    if (!isPlainObject(value)) {
        return undefined;
    }
    const patch = {};
    if (hasOwnKey(value, "enabled") && typeof value.enabled === "boolean") {
        patch.enabled = value.enabled;
    }
    if (hasOwnKey(value, "path") && typeof value.path === "string") {
        patch.path = value.path;
    }
    return Object.keys(patch).length > 0 ? patch : undefined;
}
function extractTelemetryConfigPatch(value) {
    if (!isPlainObject(value)) {
        return undefined;
    }
    const patch = {};
    if (hasOwnKey(value, "enabled") && typeof value.enabled === "boolean") {
        patch.enabled = value.enabled;
    }
    return Object.keys(patch).length > 0 ? patch : undefined;
}
function extractValidatedQuotaToastPatch(quotaToastConfig, reportIssue) {
    const patch = {};
    if (hasOwnKey(quotaToastConfig, "enabled") && typeof quotaToastConfig.enabled === "boolean") {
        patch.enabled = quotaToastConfig.enabled;
    }
    if (hasOwnKey(quotaToastConfig, "enableToast")) {
        // Ticket 13: the legacy routine-toast field no longer has any effect; it
        // only reports a migration requirement.
        reportIssue?.("enableToast", 'removed in v2: routine quota toasts are disabled; migrate to "startupHint"/"promptBar"/"alerts"');
    }
    if (hasOwnKey(quotaToastConfig, "tuiCommandDisplay")) {
        if (isValidTuiCommandDisplay(quotaToastConfig.tuiCommandDisplay)) {
            patch.tuiCommandDisplay = quotaToastConfig.tuiCommandDisplay;
        }
        else {
            reportIssue?.("tuiCommandDisplay", 'expected "inline" or "dialog"');
        }
    }
    const formatStyle = getConfiguredFormatStyle(quotaToastConfig);
    if (formatStyle) {
        patch.formatStyle = formatStyle;
    }
    if (hasOwnKey(quotaToastConfig, "percentDisplayMode") &&
        isValidPercentDisplayMode(quotaToastConfig.percentDisplayMode)) {
        patch.percentDisplayMode = quotaToastConfig.percentDisplayMode;
    }
    if (hasOwnKey(quotaToastConfig, "resetTimeDecimals") &&
        isResetTimeDecimals(quotaToastConfig.resetTimeDecimals)) {
        patch.resetTimeDecimals = quotaToastConfig.resetTimeDecimals;
    }
    if (hasOwnKey(quotaToastConfig, "minIntervalMs") &&
        isPositiveNumber(quotaToastConfig.minIntervalMs)) {
        patch.minIntervalMs = quotaToastConfig.minIntervalMs;
    }
    if (hasOwnKey(quotaToastConfig, "requestTimeoutMs") &&
        isPositiveNumber(quotaToastConfig.requestTimeoutMs)) {
        patch.requestTimeoutMs = quotaToastConfig.requestTimeoutMs;
    }
    if (hasOwnKey(quotaToastConfig, "debug") && typeof quotaToastConfig.debug === "boolean") {
        patch.debug = quotaToastConfig.debug;
    }
    if (hasOwnKey(quotaToastConfig, "enabledProviders")) {
        const enabledProviders = normalizeEnabledProviders(quotaToastConfig.enabledProviders);
        for (const issue of enabledProviders.issues) {
            reportIssue?.("enabledProviders", issue);
        }
        if (enabledProviders.value !== undefined) {
            patch.enabledProviders = enabledProviders.value;
            if (enabledProviders.invalidEmpty) {
                patch.enabledProvidersInvalidEmpty = true;
            }
        }
    }
    if (hasOwnKey(quotaToastConfig, "anthropicBinaryPath")) {
        const anthropicBinaryPath = normalizeOptionalString(quotaToastConfig.anthropicBinaryPath);
        if (anthropicBinaryPath !== undefined) {
            patch.anthropicBinaryPath = anthropicBinaryPath;
        }
    }
    if (hasOwnKey(quotaToastConfig, "googleModels")) {
        const googleModels = normalizeGoogleModels(quotaToastConfig.googleModels);
        if (googleModels !== undefined) {
            patch.googleModels = googleModels;
        }
    }
    if (hasOwnKey(quotaToastConfig, "cursorPlan") &&
        isValidCursorQuotaPlan(quotaToastConfig.cursorPlan)) {
        patch.cursorPlan = quotaToastConfig.cursorPlan;
    }
    if (hasOwnKey(quotaToastConfig, "cursorIncludedApiUsd") &&
        isPositiveNumber(quotaToastConfig.cursorIncludedApiUsd)) {
        patch.cursorIncludedApiUsd = quotaToastConfig.cursorIncludedApiUsd;
    }
    if (hasOwnKey(quotaToastConfig, "cursorBillingCycleStartDay") &&
        isValidCursorBillingCycleStartDay(quotaToastConfig.cursorBillingCycleStartDay)) {
        patch.cursorBillingCycleStartDay = quotaToastConfig.cursorBillingCycleStartDay;
    }
    if (hasOwnKey(quotaToastConfig, "opencodeGoWindows") &&
        isValidOpenCodeGoWindows(quotaToastConfig.opencodeGoWindows)) {
        patch.opencodeGoWindows = quotaToastConfig.opencodeGoWindows;
    }
    if (hasOwnKey(quotaToastConfig, "opencodeMonthlyLimit") &&
        isPositiveNumber(quotaToastConfig.opencodeMonthlyLimit)) {
        patch.opencodeMonthlyLimit = quotaToastConfig.opencodeMonthlyLimit;
    }
    if (hasOwnKey(quotaToastConfig, "pricingSnapshot")) {
        const pricingSnapshot = extractPricingSnapshotPatch(quotaToastConfig.pricingSnapshot);
        if (pricingSnapshot) {
            patch.pricingSnapshot = pricingSnapshot;
        }
    }
    for (const key of ["showOnIdle", "showOnQuestion", "showOnCompact", "showOnBothFail"]) {
        if (hasOwnKey(quotaToastConfig, key)) {
            // Ticket 13: legacy lifecycle trigger fields no longer have any
            // effect; they only report a migration requirement.
            reportIssue?.(key, "removed in v2: lifecycle events no longer trigger a quota toast; migrate to passive surfaces (startup hint, sidebar, /quota)");
        }
    }
    if (hasOwnKey(quotaToastConfig, "toastDurationMs") &&
        isPositiveNumber(quotaToastConfig.toastDurationMs)) {
        patch.toastDurationMs = quotaToastConfig.toastDurationMs;
    }
    if (hasOwnKey(quotaToastConfig, "onlyCurrentModel") &&
        typeof quotaToastConfig.onlyCurrentModel === "boolean") {
        patch.onlyCurrentModel = quotaToastConfig.onlyCurrentModel;
    }
    if (hasOwnKey(quotaToastConfig, "showSessionTokens") &&
        typeof quotaToastConfig.showSessionTokens === "boolean") {
        patch.showSessionTokens = quotaToastConfig.showSessionTokens;
    }
    if (hasOwnKey(quotaToastConfig, "sessionTokenScope")) {
        if (isValidSessionTokenScope(quotaToastConfig.sessionTokenScope)) {
            patch.sessionTokenScope = quotaToastConfig.sessionTokenScope;
        }
        else {
            reportIssue?.("sessionTokenScope", 'expected "current" or "tree"');
        }
    }
    if (hasOwnKey(quotaToastConfig, "tuiSidebarPanel")) {
        const tuiSidebarPanel = extractTuiSidebarPanelPatch(quotaToastConfig.tuiSidebarPanel);
        if (tuiSidebarPanel) {
            patch.tuiSidebarPanel = tuiSidebarPanel;
        }
    }
    if (hasOwnKey(quotaToastConfig, "tuiPromptBar")) {
        // Legacy upstream v4.6.1 entrypoint: behavior is preserved through the
        // canonical promptBar section, but its presence is reported as a migration
        // requirement instead of being silently accepted.
        reportIssue?.("tuiPromptBar", 'legacy upstream section; use the canonical "promptBar" section');
        const tuiPromptBar = extractTuiPromptBarPatch(quotaToastConfig.tuiPromptBar);
        if (tuiPromptBar) {
            patch.tuiPromptBar = tuiPromptBar;
        }
    }
    if (hasOwnKey(quotaToastConfig, "startupHint")) {
        const startupHint = extractStartupHintPatch(quotaToastConfig.startupHint);
        for (const issue of startupHint.issues) {
            reportIssue?.(issue.key, issue.message);
        }
        if (startupHint.value) {
            patch.startupHint = startupHint.value;
        }
    }
    if (hasOwnKey(quotaToastConfig, "promptBar")) {
        const promptBar = extractPromptBarPatch(quotaToastConfig.promptBar);
        for (const issue of promptBar.issues) {
            reportIssue?.(issue.key, issue.message);
        }
        if (promptBar.value) {
            patch.promptBar = promptBar.value;
        }
    }
    if (hasOwnKey(quotaToastConfig, "alerts")) {
        const alerts = extractAlertsPatch(quotaToastConfig.alerts);
        for (const issue of alerts.issues) {
            reportIssue?.(issue.key, issue.message);
        }
        if (alerts.value) {
            patch.alerts = alerts.value;
        }
    }
    if (hasOwnKey(quotaToastConfig, "tuiCompactStatus")) {
        const tuiCompactStatus = extractTuiCompactStatusPatch(quotaToastConfig.tuiCompactStatus);
        if (tuiCompactStatus) {
            patch.tuiCompactStatus = tuiCompactStatus;
        }
    }
    if (hasOwnKey(quotaToastConfig, "maintainerAnnouncements")) {
        const maintainerAnnouncements = extractMaintainerAnnouncementsPatch(quotaToastConfig.maintainerAnnouncements);
        if (maintainerAnnouncements) {
            patch.maintainerAnnouncements = maintainerAnnouncements;
        }
    }
    if (hasOwnKey(quotaToastConfig, "layout")) {
        const layout = extractLayoutPatch(quotaToastConfig.layout);
        if (layout) {
            patch.layout = layout;
        }
    }
    if (hasOwnKey(quotaToastConfig, "export")) {
        const exportConfig = extractExportConfigPatch(quotaToastConfig.export);
        if (exportConfig) {
            patch.export = exportConfig;
        }
    }
    if (hasOwnKey(quotaToastConfig, "telemetry")) {
        const telemetry = extractTelemetryConfigPatch(quotaToastConfig.telemetry);
        if (telemetry) {
            patch.telemetry = telemetry;
        }
    }
    return patch;
}
function applySettingSource(settingSources, key, sourcePath) {
    settingSources[key] = sourcePath;
}
function applyValidatedQuotaToastPatch(config, patch, sourcePath, settingSources) {
    if (hasOwnKey(patch, "enabled")) {
        config.enabled = patch.enabled;
        applySettingSource(settingSources, "enabled", sourcePath);
    }
    if (hasOwnKey(patch, "tuiCommandDisplay")) {
        config.tuiCommandDisplay = patch.tuiCommandDisplay;
        applySettingSource(settingSources, "tuiCommandDisplay", sourcePath);
    }
    if (hasOwnKey(patch, "formatStyle")) {
        config.formatStyle = patch.formatStyle;
        applySettingSource(settingSources, "formatStyle", sourcePath);
    }
    if (hasOwnKey(patch, "percentDisplayMode")) {
        config.percentDisplayMode = patch.percentDisplayMode;
        applySettingSource(settingSources, "percentDisplayMode", sourcePath);
    }
    if (hasOwnKey(patch, "resetTimeDecimals")) {
        config.resetTimeDecimals = patch.resetTimeDecimals;
        applySettingSource(settingSources, "resetTimeDecimals", sourcePath);
    }
    if (hasOwnKey(patch, "minIntervalMs")) {
        config.minIntervalMs = patch.minIntervalMs;
        applySettingSource(settingSources, "minIntervalMs", sourcePath);
    }
    if (hasOwnKey(patch, "requestTimeoutMs")) {
        config.requestTimeoutMs = patch.requestTimeoutMs;
        applySettingSource(settingSources, "requestTimeoutMs", sourcePath);
    }
    if (hasOwnKey(patch, "debug")) {
        config.debug = patch.debug;
        applySettingSource(settingSources, "debug", sourcePath);
    }
    if (hasOwnKey(patch, "enabledProviders")) {
        if (!(patch.enabledProvidersInvalidEmpty && settingSources.enabledProviders)) {
            config.enabledProviders =
                patch.enabledProviders === "auto" ? "auto" : [...patch.enabledProviders];
            applySettingSource(settingSources, "enabledProviders", sourcePath);
        }
    }
    if (hasOwnKey(patch, "anthropicBinaryPath")) {
        config.anthropicBinaryPath = patch.anthropicBinaryPath;
        applySettingSource(settingSources, "anthropicBinaryPath", sourcePath);
    }
    if (hasOwnKey(patch, "googleModels")) {
        config.googleModels = [...patch.googleModels];
        applySettingSource(settingSources, "googleModels", sourcePath);
    }
    if (hasOwnKey(patch, "cursorPlan")) {
        config.cursorPlan = patch.cursorPlan;
        applySettingSource(settingSources, "cursorPlan", sourcePath);
    }
    if (hasOwnKey(patch, "cursorIncludedApiUsd")) {
        config.cursorIncludedApiUsd = patch.cursorIncludedApiUsd;
        applySettingSource(settingSources, "cursorIncludedApiUsd", sourcePath);
    }
    if (hasOwnKey(patch, "cursorBillingCycleStartDay")) {
        config.cursorBillingCycleStartDay = patch.cursorBillingCycleStartDay;
        applySettingSource(settingSources, "cursorBillingCycleStartDay", sourcePath);
    }
    if (hasOwnKey(patch, "opencodeGoWindows")) {
        config.opencodeGoWindows = [...patch.opencodeGoWindows];
        applySettingSource(settingSources, "opencodeGoWindows", sourcePath);
    }
    if (hasOwnKey(patch, "opencodeMonthlyLimit")) {
        config.opencodeMonthlyLimit = patch.opencodeMonthlyLimit;
        applySettingSource(settingSources, "opencodeMonthlyLimit", sourcePath);
    }
    if (patch.pricingSnapshot) {
        if (hasOwnKey(patch.pricingSnapshot, "source")) {
            config.pricingSnapshot.source = patch.pricingSnapshot.source;
            applySettingSource(settingSources, "pricingSnapshot.source", sourcePath);
        }
        if (hasOwnKey(patch.pricingSnapshot, "autoRefresh")) {
            config.pricingSnapshot.autoRefresh = patch.pricingSnapshot.autoRefresh;
            applySettingSource(settingSources, "pricingSnapshot.autoRefresh", sourcePath);
        }
    }
    if (hasOwnKey(patch, "toastDurationMs")) {
        config.toastDurationMs = patch.toastDurationMs;
        applySettingSource(settingSources, "toastDurationMs", sourcePath);
    }
    if (hasOwnKey(patch, "onlyCurrentModel")) {
        config.onlyCurrentModel = patch.onlyCurrentModel;
        applySettingSource(settingSources, "onlyCurrentModel", sourcePath);
    }
    if (hasOwnKey(patch, "showSessionTokens")) {
        config.showSessionTokens = patch.showSessionTokens;
        applySettingSource(settingSources, "showSessionTokens", sourcePath);
    }
    if (hasOwnKey(patch, "sessionTokenScope")) {
        config.sessionTokenScope = patch.sessionTokenScope;
        applySettingSource(settingSources, "sessionTokenScope", sourcePath);
    }
    if (patch.tuiSidebarPanel) {
        if (hasOwnKey(patch.tuiSidebarPanel, "enabled")) {
            config.tuiSidebarPanel.enabled = patch.tuiSidebarPanel.enabled;
            applySettingSource(settingSources, "tuiSidebarPanel.enabled", sourcePath);
        }
        if (hasOwnKey(patch.tuiSidebarPanel, "formatStyle")) {
            config.tuiSidebarPanel.formatStyle = patch.tuiSidebarPanel.formatStyle;
            applySettingSource(settingSources, "tuiSidebarPanel.formatStyle", sourcePath);
        }
    }
    if (patch.tuiCompactStatus) {
        if (hasOwnKey(patch.tuiCompactStatus, "enabled")) {
            config.tuiCompactStatus.enabled = patch.tuiCompactStatus.enabled;
            applySettingSource(settingSources, "tuiCompactStatus.enabled", sourcePath);
        }
        if (hasOwnKey(patch.tuiCompactStatus, "homeBottom")) {
            config.tuiCompactStatus.homeBottom = patch.tuiCompactStatus.homeBottom;
            applySettingSource(settingSources, "tuiCompactStatus.homeBottom", sourcePath);
        }
        if (hasOwnKey(patch.tuiCompactStatus, "sessionPrompt")) {
            config.tuiCompactStatus.sessionPrompt = patch.tuiCompactStatus.sessionPrompt;
            applySettingSource(settingSources, "tuiCompactStatus.sessionPrompt", sourcePath);
        }
        if (hasOwnKey(patch.tuiCompactStatus, "suppressWhenNativeProviderQuota")) {
            config.tuiCompactStatus.suppressWhenNativeProviderQuota =
                patch.tuiCompactStatus.suppressWhenNativeProviderQuota;
            applySettingSource(settingSources, "tuiCompactStatus.suppressWhenNativeProviderQuota", sourcePath);
        }
        if (hasOwnKey(patch.tuiCompactStatus, "maxWidth")) {
            config.tuiCompactStatus.maxWidth = patch.tuiCompactStatus.maxWidth;
            applySettingSource(settingSources, "tuiCompactStatus.maxWidth", sourcePath);
        }
        if (hasOwnKey(patch.tuiCompactStatus, "formatStyle")) {
            config.tuiCompactStatus.formatStyle = patch.tuiCompactStatus.formatStyle;
            applySettingSource(settingSources, "tuiCompactStatus.formatStyle", sourcePath);
        }
    }
    if (patch.tuiPromptBar) {
        if (hasOwnKey(patch.tuiPromptBar, "enabled")) {
            config.tuiPromptBar.enabled = patch.tuiPromptBar.enabled;
            // Mirror into the canonical section so the TUI prompt bar keeps one
            // effective value regardless of which entrypoint was used.
            config.promptBar.enabled = patch.tuiPromptBar.enabled;
            applySettingSource(settingSources, "tuiPromptBar.enabled", sourcePath);
        }
    }
    if (patch.startupHint) {
        if (hasOwnKey(patch.startupHint, "enabled")) {
            config.startupHint.enabled = patch.startupHint.enabled;
            applySettingSource(settingSources, "startupHint.enabled", sourcePath);
        }
    }
    // Canonical promptBar is applied after the legacy tuiPromptBar so that a
    // config containing both sections honors the canonical value.
    if (patch.promptBar) {
        if (hasOwnKey(patch.promptBar, "enabled")) {
            config.promptBar.enabled = patch.promptBar.enabled;
            config.tuiPromptBar.enabled = patch.promptBar.enabled;
            applySettingSource(settingSources, "promptBar.enabled", sourcePath);
        }
    }
    if (patch.alerts) {
        if (hasOwnKey(patch.alerts, "enabled")) {
            config.alerts.enabled = patch.alerts.enabled;
            applySettingSource(settingSources, "alerts.enabled", sourcePath);
        }
        if (hasOwnKey(patch.alerts, "percentRemainingThreshold")) {
            config.alerts.percentRemainingThreshold = patch.alerts.percentRemainingThreshold;
            applySettingSource(settingSources, "alerts.percentRemainingThreshold", sourcePath);
        }
        if (hasOwnKey(patch.alerts, "repeatAfterMinutes")) {
            config.alerts.repeatAfterMinutes = patch.alerts.repeatAfterMinutes;
            applySettingSource(settingSources, "alerts.repeatAfterMinutes", sourcePath);
        }
        if (hasOwnKey(patch.alerts, "balanceThresholds")) {
            config.alerts.balanceThresholds = cloneBalanceThresholds(patch.alerts.balanceThresholds);
            applySettingSource(settingSources, "alerts.balanceThresholds", sourcePath);
        }
    }
    if (patch.maintainerAnnouncements) {
        if (hasOwnKey(patch.maintainerAnnouncements, "enabled")) {
            config.maintainerAnnouncements.enabled = patch.maintainerAnnouncements.enabled;
            applySettingSource(settingSources, "maintainerAnnouncements.enabled", sourcePath);
        }
        if (hasOwnKey(patch.maintainerAnnouncements, "home")) {
            config.maintainerAnnouncements.home = patch.maintainerAnnouncements.home;
            applySettingSource(settingSources, "maintainerAnnouncements.home", sourcePath);
        }
    }
    if (patch.layout) {
        if (hasOwnKey(patch.layout, "maxWidth")) {
            config.layout.maxWidth = patch.layout.maxWidth;
            applySettingSource(settingSources, "layout.maxWidth", sourcePath);
        }
        if (hasOwnKey(patch.layout, "narrowAt")) {
            config.layout.narrowAt = patch.layout.narrowAt;
            applySettingSource(settingSources, "layout.narrowAt", sourcePath);
        }
        if (hasOwnKey(patch.layout, "tinyAt")) {
            config.layout.tinyAt = patch.layout.tinyAt;
            applySettingSource(settingSources, "layout.tinyAt", sourcePath);
        }
    }
    if (patch.export) {
        if (hasOwnKey(patch.export, "enabled")) {
            config.export.enabled = patch.export.enabled;
            applySettingSource(settingSources, "export.enabled", sourcePath);
        }
        if (hasOwnKey(patch.export, "path")) {
            config.export.path = patch.export.path;
            applySettingSource(settingSources, "export.path", sourcePath);
        }
    }
    if (patch.telemetry && hasOwnKey(patch.telemetry, "enabled")) {
        config.telemetry.enabled = patch.telemetry.enabled;
        applySettingSource(settingSources, "telemetry.enabled", sourcePath);
    }
}
function projectNetworkSettingSources(settingSources) {
    const projected = {};
    for (const key of NETWORK_SETTING_SOURCE_KEYS) {
        const source = settingSources[key];
        if (typeof source === "string" && source.length > 0) {
            projected[key] = source;
        }
    }
    return projected;
}
function buildConfigLayerCandidatesForRoot(dir, scope) {
    return [
        ...QUOTA_TOAST_CONFIG_RELATIVE_PATHS.map((relativePath) => ({
            path: join(dir, relativePath),
            rootDir: dir,
            scope,
            kind: "plugin",
        })),
        ...buildOpenCodeConfigCandidates({
            directories: [dir],
            formatOrder: ["json", "jsonc"],
        }).map((candidate) => ({
            path: candidate.path,
            rootDir: dir,
            scope,
            kind: "legacy",
        })),
    ];
}
function buildConfigLayerCandidates(configDirs, configRootDir) {
    const workspaceCandidates = buildConfigLayerCandidatesForRoot(configRootDir, "workspace");
    const globalCandidates = configDirs.flatMap((dir) => buildConfigLayerCandidatesForRoot(dir, "global"));
    const globalPaths = new Set(globalCandidates.map((candidate) => candidate.path));
    return [
        ...globalCandidates,
        ...workspaceCandidates.filter((candidate) => !globalPaths.has(candidate.path)),
    ];
}
function getConfigLayerSourceLabel(candidate) {
    const suffix = candidate.kind === "plugin"
        ? candidate.path.endsWith(".jsonc")
            ? QUOTA_TOAST_CONFIG_RELATIVE_PATHS[0]
            : QUOTA_TOAST_CONFIG_RELATIVE_PATHS[1]
        : "experimental.quotaToast";
    return `${candidate.path} (${suffix})`;
}
/**
 * Load plugin configuration from OpenCode config
 *
 * @param client - Optional OpenCode SDK client fallback
 * @returns Merged configuration with defaults
 */
export async function loadConfig(client, meta, options) {
    async function readJson(path) {
        const result = await readOpenCodeConfigCandidate({
            path,
            format: path.endsWith(".jsonc") ? "jsonc" : "json",
        });
        return result.state === "parsed" ? result.value : null;
    }
    async function loadFromFiles() {
        const configRootDir = options?.configRootDir ?? getEffectiveConfigRoot(options?.cwd ?? process.cwd());
        const { configDirs } = getOpencodeRuntimeDirCandidates();
        const config = cloneDefaultConfig();
        const usedPaths = [];
        const globalConfigPaths = [];
        const workspaceConfigPaths = [];
        const settingSources = {};
        const configIssues = [];
        const authoritativeSidecarRoots = new Set();
        // ADR 0002: legacy upstream-namespace sidecars are not configuration
        // sources anymore; their presence is reported as a migration requirement.
        for (const dir of new Set([configRootDir, ...configDirs])) {
            for (const relativePath of LEGACY_QUOTA_TOAST_CONFIG_RELATIVE_PATHS) {
                const legacyPath = join(dir, relativePath);
                if (!existsSync(legacyPath))
                    continue;
                configIssues.push({
                    path: `${legacyPath} (${relativePath})`,
                    key: "$legacy",
                    message: "removed in v2; migrate to the opencode-quota-zh/config.jsonc sidecar",
                });
            }
        }
        for (const candidate of buildConfigLayerCandidates(configDirs, configRootDir)) {
            const rootKey = `${candidate.scope}:${candidate.rootDir}`;
            if (candidate.kind === "legacy" && authoritativeSidecarRoots.has(rootKey)) {
                continue;
            }
            if (candidate.kind === "plugin" && authoritativeSidecarRoots.has(rootKey)) {
                continue;
            }
            if (!existsSync(candidate.path)) {
                continue;
            }
            const parsed = await readJson(candidate.path);
            if (!isPlainObject(parsed)) {
                if (candidate.kind === "plugin") {
                    const sourcePath = getConfigLayerSourceLabel(candidate);
                    usedPaths.push(sourcePath);
                    if (candidate.scope === "global") {
                        globalConfigPaths.push(sourcePath);
                    }
                    else {
                        workspaceConfigPaths.push(sourcePath);
                    }
                    configIssues.push({
                        path: sourcePath,
                        key: "$root",
                        message: "expected readable JSON object; this sidecar is not authoritative",
                    });
                }
                continue;
            }
            if (candidate.kind === "plugin") {
                authoritativeSidecarRoots.add(rootKey);
                if (candidate.path.endsWith(".jsonc") &&
                    existsSync(getQuotaToastConfigPath(candidate.rootDir, "json"))) {
                    configIssues.push({
                        path: getConfigLayerSourceLabel(candidate),
                        key: "$file",
                        message: "both quota-toast.jsonc and quota-toast.json exist; using quota-toast.jsonc",
                    });
                }
            }
            const extractedQuotaToast = candidate.kind === "plugin"
                ? parsed
                : isPlainObject(parsed.experimental)
                    ? parsed.experimental.quotaToast
                    : undefined;
            if (!isPlainObject(extractedQuotaToast)) {
                continue;
            }
            if (candidate.kind === "legacy") {
                // ADR 0001/0002: experimental.quotaToast is no longer a runtime
                // configuration source; its presence is reported as a migration
                // requirement and never applied.
                const sourcePath = getConfigLayerSourceLabel(candidate);
                usedPaths.push(sourcePath);
                if (candidate.scope === "global") {
                    globalConfigPaths.push(sourcePath);
                }
                else {
                    workspaceConfigPaths.push(sourcePath);
                }
                configIssues.push({
                    path: sourcePath,
                    key: "experimental.quotaToast",
                    message: "removed in v2; migrate to the opencode-quota-zh/config.jsonc sidecar",
                });
                continue;
            }
            const sourcePath = getConfigLayerSourceLabel(candidate);
            usedPaths.push(sourcePath);
            if (candidate.scope === "global") {
                globalConfigPaths.push(sourcePath);
            }
            else {
                workspaceConfigPaths.push(sourcePath);
            }
            applyValidatedQuotaToastPatch(config, extractValidatedQuotaToastPatch(extractedQuotaToast, (key, message) => {
                configIssues.push({ path: sourcePath, key, message });
            }), sourcePath, settingSources);
            if (hasOwnKey(extractedQuotaToast, "alibabaCodingPlanTier")) {
                configIssues.push({
                    path: sourcePath,
                    key: "alibabaCodingPlanTier",
                    message: 'removed in v4; tune Alibaba through "quotaProviders"',
                });
            }
            if (hasOwnKey(extractedQuotaToast, "customSources")) {
                configIssues.push({
                    path: sourcePath,
                    key: "customSources",
                    message: 'removed in v4; use the global-only "quotaProviders" property',
                });
            }
            if (hasOwnKey(extractedQuotaToast, "quotaProviders")) {
                if (candidate.scope === "global") {
                    const validation = validateQuotaProviders(extractedQuotaToast.quotaProviders);
                    for (const issue of validation.issues) {
                        configIssues.push({ path: sourcePath, key: issue.key, message: issue.message });
                    }
                    if (validation.value) {
                        config.quotaProviders = cloneQuotaProviders(validation.value);
                        applySettingSource(settingSources, "quotaProviders", sourcePath);
                    }
                }
                else {
                    configIssues.push({
                        path: sourcePath,
                        key: "quotaProviders",
                        message: "allowed only in global OpenCode or global opencode-quota config",
                    });
                }
            }
        }
        if (usedPaths.length === 0) {
            return {
                config: null,
                usedPaths: [],
                globalConfigPaths: [],
                workspaceConfigPaths: [],
                settingSources: {},
                networkSettingSources: {},
                configIssues: [],
            };
        }
        return {
            config,
            usedPaths,
            globalConfigPaths,
            workspaceConfigPaths,
            settingSources,
            networkSettingSources: projectNetworkSettingSources(settingSources),
            configIssues,
        };
    }
    const fileConfig = await loadFromFiles();
    if (fileConfig.config) {
        if (meta) {
            meta.source = "files";
            meta.paths = fileConfig.usedPaths;
            meta.globalConfigPaths = fileConfig.globalConfigPaths;
            meta.workspaceConfigPaths = fileConfig.workspaceConfigPaths;
            meta.settingSources = fileConfig.settingSources;
            meta.networkSettingSources = fileConfig.networkSettingSources;
            meta.configIssues = fileConfig.configIssues;
        }
        return fileConfig.config;
    }
    if (client) {
        try {
            const response = await client.config.get();
            // ADR 0001/0002: experimental.quotaToast is no longer a runtime
            // configuration source. Its presence is reported as a migration
            // requirement and never applied.
            const quotaToastConfig = response.data?.experimental?.quotaToast;
            if (isPlainObject(quotaToastConfig)) {
                if (meta) {
                    meta.source = "sdk";
                    meta.paths = ["client.config.get (experimental.quotaToast)"];
                    meta.globalConfigPaths = [];
                    meta.workspaceConfigPaths = [];
                    meta.settingSources = {};
                    meta.networkSettingSources = {};
                    meta.configIssues = [
                        {
                            path: "client.config.get",
                            key: "experimental.quotaToast",
                            message: "removed in v2; migrate to the opencode-quota-zh/config.jsonc sidecar",
                        },
                    ];
                }
                return cloneDefaultConfig();
            }
        }
        catch {
            // ignore; fall back to defaults below
        }
    }
    if (meta) {
        meta.source = "defaults";
        meta.paths = [];
        meta.globalConfigPaths = [];
        meta.workspaceConfigPaths = [];
        meta.settingSources = {};
        meta.networkSettingSources = {};
        meta.configIssues = [];
    }
    return cloneDefaultConfig();
}
