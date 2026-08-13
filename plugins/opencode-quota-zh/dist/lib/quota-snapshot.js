/**
 * Ticket 07 + Ticket 09: unified quota snapshot projection seam.
 *
 * The principal pure seam of the v2 quota model. It consumes a unified quota
 * snapshot, validated configuration, an injected clock and the current
 * projection state, and returns passive-surface payloads (startup hint), an
 * alert plan, and the next state — without performing any I/O.
 *
 * Determinism contract: identical inputs (config, snapshot, now, state) always
 * produce identical outputs. The clock is always injected; this module never
 * calls Date.now(), reads files, touches the network, or runs timers.
 *
 * Ticket 09 adds typed danger evaluation: percent_remaining, balance and
 * availability are explicit metric kinds that are never converted into one
 * another; danger uses current value <= configured threshold with a default
 * percent threshold of 0; explicit provider unavailability forms a critical
 * alert-plan candidate. Missing, failed, stale and synthetic observations
 * neither trigger nor recover danger, and a missing percent window is never
 * synthesized into an alertable 0%. Episode persistence and delivery remain
 * Tickets 11/12; `alertPlan.notifications` stays empty here.
 */
import { getQuotaProviderDisplayLabel } from "./provider-metadata.js";
import { classifyQuotaWindowText } from "./quota-entry-display.js";
import { normalizePercentWindowRemaining, normalizeQuotaAlertMetricFacts, } from "./quota-alert-metrics.js";
export const QUOTA_SNAPSHOT_VERSION = 1;
export const EMPTY_QUOTA_PROJECTION_STATE = {
    version: 1,
    alertEpisodes: [],
};
function providerQuality(params) {
    if (!params.available) {
        return "failed";
    }
    if (!params.result) {
        return "missing";
    }
    if (params.result.entries.length > 0) {
        return "fresh";
    }
    if (params.result.errors.length > 0 || params.result.attempted) {
        return "failed";
    }
    return "missing";
}
function snapshotIntegrity(providers) {
    if (providers.length === 0) {
        return "unknown";
    }
    const freshCount = providers.filter((provider) => provider.quality === "fresh").length;
    if (freshCount === 0) {
        return "unknown";
    }
    return freshCount === providers.length ? "complete" : "partial";
}
/**
 * Builds the unified snapshot from structured provider availability and fetch
 * results. Pure: the inputs are already-fetched structured data; no I/O.
 */
export function buildUnifiedQuotaSnapshot(params) {
    const availabilityByProviderId = new Map(params.availability.map((item) => [item.providerId, item]));
    const resultByProviderId = new Map(params.results.map((item) => [item.providerId, item.result]));
    const providers = params.monitoredProviderIds.map((providerId) => {
        const available = availabilityByProviderId.get(providerId)?.ok ?? false;
        const result = resultByProviderId.get(providerId);
        const quality = providerQuality({ available, result });
        const errors = quality === "failed" ? (result?.errors ?? []) : [];
        return { providerId, quality, errors };
    });
    const windows = [];
    for (const provider of providers) {
        const result = resultByProviderId.get(provider.providerId);
        if (!result)
            continue;
        for (const entry of result.entries) {
            const isPercent = !("kind" in entry) || entry.kind === undefined || entry.kind === "percent";
            const percentRemaining = isPercent
                ? normalizePercentWindowRemaining("percentRemaining" in entry ? entry.percentRemaining : undefined)
                : undefined;
            if (percentRemaining !== undefined) {
                windows.push({
                    metricType: "percent_remaining",
                    providerId: provider.providerId,
                    providerLabel: getQuotaProviderDisplayLabel(provider.providerId),
                    windowLabel: entry.label ?? entry.name,
                    percentRemaining,
                    resetTimeIso: entry.resetTimeIso,
                    quality: provider.quality,
                    authority: entry.accounting.authority,
                });
            }
        }
        // Structured balance/availability facts travel in rawDetails (never
        // display text). A missing percent window or a malformed fact never
        // synthesizes an alertable 0% / unavailable observation.
        for (const metric of normalizeQuotaAlertMetricFacts(result.rawDetails)) {
            if (metric.kind === "balance") {
                windows.push({
                    metricType: "balance",
                    providerId: provider.providerId,
                    providerLabel: getQuotaProviderDisplayLabel(provider.providerId),
                    currency: metric.currency,
                    amount: metric.amount,
                    quality: provider.quality,
                    authority: "provider_reported",
                });
            }
            else {
                windows.push({
                    metricType: "availability",
                    providerId: provider.providerId,
                    providerLabel: getQuotaProviderDisplayLabel(provider.providerId),
                    status: metric.status,
                    quality: provider.quality,
                    authority: "provider_reported",
                });
            }
        }
    }
    return {
        version: QUOTA_SNAPSHOT_VERSION,
        integrity: snapshotIntegrity(providers),
        providers,
        windows,
    };
}
// =============================================================================
// Projection
// =============================================================================
function selectMostRelevantWindow(snapshot) {
    let selected;
    for (const window of snapshot.windows) {
        if (window.metricType !== "percent_remaining")
            continue;
        if (window.quality !== "fresh")
            continue;
        if (typeof window.percentRemaining !== "number")
            continue;
        if (!selected || window.percentRemaining < selected.percentRemaining) {
            selected = {
                providerId: window.providerId,
                providerLabel: window.providerLabel,
                ...(window.windowLabel ? { windowLabel: window.windowLabel } : {}),
                percentRemaining: window.percentRemaining,
                ...(window.resetTimeIso ? { resetTimeIso: window.resetTimeIso } : {}),
            };
        }
    }
    return selected;
}
// =============================================================================
// Pure snapshot-level danger evaluation (Ticket 09)
// =============================================================================
function percentCandidate(window, threshold) {
    if (typeof window.percentRemaining !== "number")
        return null;
    if (window.percentRemaining > threshold)
        return null;
    return {
        metricType: "percent_remaining",
        providerId: window.providerId,
        providerLabel: window.providerLabel,
        severity: window.percentRemaining <= 0 ? "critical" : "warning",
        ...(window.windowLabel ? { windowLabel: window.windowLabel } : {}),
        percentRemaining: window.percentRemaining,
        thresholdPercentRemaining: threshold,
        ...(window.resetTimeIso ? { resetTimeIso: window.resetTimeIso } : {}),
    };
}
function balanceCandidate(window, threshold) {
    if (typeof window.amount !== "number")
        return null;
    if (window.amount > threshold)
        return null;
    return {
        metricType: "balance",
        providerId: window.providerId,
        providerLabel: window.providerLabel,
        severity: window.amount <= 0 ? "critical" : "warning",
        ...(window.currency ? { currency: window.currency } : {}),
        amount: window.amount,
        thresholdAmount: threshold,
        ...(window.resetTimeIso ? { resetTimeIso: window.resetTimeIso } : {}),
    };
}
/**
 * Evaluates the unified snapshot against the validated alert configuration and
 * returns pure danger candidates. Only fresh observations participate:
 * missing, failed, stale and synthetic data neither triggers nor recovers
 * danger. Disabled alerts always produce no candidates.
 */
export function evaluateQuotaDangerMetrics(params) {
    if (!params.alerts.enabled) {
        return [];
    }
    const candidates = [];
    for (const window of params.snapshot.windows) {
        if (window.quality !== "fresh")
            continue;
        switch (window.metricType) {
            case "percent_remaining": {
                const candidate = percentCandidate(window, params.alerts.percentRemainingThreshold);
                if (candidate)
                    candidates.push(candidate);
                break;
            }
            case "balance": {
                const threshold = window.currency
                    ? params.alerts.balanceThresholds[window.providerId]?.[window.currency]
                    : undefined;
                if (threshold === undefined)
                    continue;
                const candidate = balanceCandidate(window, threshold);
                if (candidate)
                    candidates.push(candidate);
                break;
            }
            case "availability": {
                // Provider-reported unavailability is independently alertable even
                // when no monetary threshold is configured; unknown never alerts.
                if (window.status === "unavailable") {
                    candidates.push({
                        metricType: "availability",
                        providerId: window.providerId,
                        providerLabel: window.providerLabel,
                        severity: "critical",
                        status: "unavailable",
                        ...(window.resetTimeIso ? { resetTimeIso: window.resetTimeIso } : {}),
                    });
                }
                break;
            }
        }
    }
    return candidates;
}
export function buildQuotaAlertPlan(alerts, snapshot) {
    return {
        version: 2,
        notifications: [],
        candidates: evaluateQuotaDangerMetrics({ alerts, snapshot }),
    };
}
/**
 * The principal seam: validated config + unified snapshot + injected clock +
 * current state -> passive payloads, alert plan, next state. Pure and
 * deterministic; performs no I/O.
 */
export function projectQuotaSnapshot(params) {
    const alertPlan = buildQuotaAlertPlan(params.config.alerts, params.snapshot);
    if (!params.config.startupHint.enabled || params.snapshot.providers.length === 0) {
        return {
            startupHint: {
                state: "none",
                providerCount: 0,
                unknownCount: 0,
            },
            alertPlan,
            nextState: params.state,
        };
    }
    const providerCount = params.snapshot.providers.length;
    const freshCount = params.snapshot.providers.filter((provider) => provider.quality === "fresh").length;
    const unknownCount = providerCount - freshCount;
    // Overall state derives from the provider observations themselves so an
    // inconsistent integrity marker can never flip the outcome.
    const state = freshCount === providerCount
        ? "ok"
        : freshCount > 0
            ? "partial"
            : "unknown";
    return {
        startupHint: {
            state,
            providerCount,
            unknownCount,
            ...(state === "ok" || state === "partial"
                ? { mostRelevant: selectMostRelevantWindow(params.snapshot) }
                : {}),
        },
        alertPlan,
        nextState: params.state,
    };
}
// =============================================================================
// Startup hint text (pure Chinese single-line formatter)
// =============================================================================
/**
 * Chinese window-type segment for a classified window kind, mirroring the
 * /quota command's naming convention. Kinds without a segment (mcp,
 * code_review) are unclassifiable and omit the window segment entirely.
 */
const STARTUP_HINT_WINDOW_LABELS = {
    rpm: "RPM",
    five_hour: "5h",
    hour: "小时",
    week: "周",
    day: "天",
    month: "月",
    year: "年",
};
function formatResetCountdown(resetTimeIso, now) {
    if (!resetTimeIso)
        return null;
    const resetMs = Date.parse(resetTimeIso);
    if (!Number.isFinite(resetMs))
        return null;
    const minutes = Math.max(1, Math.ceil((resetMs - now.getTime()) / 60_000));
    if (minutes < 60) {
        return `${minutes} 分钟后重置`;
    }
    return `${Math.ceil(minutes / 60)} 小时后重置`;
}
/**
 * Pure single-line startup hint text. Renders only when a fresh percent window
 * was selected: `额度：<Provider> <窗口类型>额度剩余 <percent>%` plus an
 * optional hour/minutes countdown and /quota guidance. Returns null when the
 * surface is disabled, no monitored provider exists, or no fresh percentage
 * exists (missing/failed/stale/synthetic observations, balance-only data, or a
 * fresh window rounding to 0% — never inferred as exhaustion).
 */
export function formatStartupHintText(payload, now) {
    if (payload.state === "none" || !payload.mostRelevant) {
        return null;
    }
    const percent = Math.round(payload.mostRelevant.percentRemaining);
    if (percent <= 0)
        return null;
    const kind = classifyQuotaWindowText(payload.mostRelevant.windowLabel ?? "");
    const windowLabel = kind ? STARTUP_HINT_WINDOW_LABELS[kind] : null;
    const countdown = formatResetCountdown(payload.mostRelevant.resetTimeIso, now);
    const windowPart = windowLabel ? `${windowLabel}额度剩余 ` : "额度剩余 ";
    const countdownPart = countdown ? `，${countdown}` : "";
    return `额度：${payload.mostRelevant.providerLabel} ${windowPart}${percent}%${countdownPart}。输入 /quota 查看详情。`;
}
