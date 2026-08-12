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
import type { QuotaProviderResult } from "./entries.js";
import {
  normalizePercentWindowRemaining,
  normalizeQuotaAlertMetricFacts,
} from "./quota-alert-metrics.js";
import type { QuotaToastConfig } from "./types.js";

export const QUOTA_SNAPSHOT_VERSION = 1 as const;

// =============================================================================
// Unified quota snapshot
// =============================================================================

/**
 * Observation quality of a provider or window. "fresh" is the only quality
 * eligible for relevance selection and future danger evaluation; missing,
 * failed, stale and synthetic data must never be mistaken for exhaustion.
 */
export type QuotaSnapshotObservationQuality =
  | "fresh"
  | "stale"
  | "missing"
  | "failed"
  | "synthetic";

/** Explicit metric type. Metric kinds are never converted into one another. */
export type QuotaSnapshotMetricType = "percent_remaining" | "balance" | "availability";

export type QuotaSnapshotAuthority = "provider_reported" | "locally_derived";

export interface QuotaSnapshotProviderObservation {
  providerId: string;
  quality: QuotaSnapshotObservationQuality;
  errors: ReadonlyArray<{ label: string; message: string }>;
}

export interface QuotaSnapshotWindow {
  metricType: QuotaSnapshotMetricType;
  providerId: string;
  providerLabel: string;
  /** Optional window label, e.g. "5h:" or the window name. */
  windowLabel?: string;
  /** ISO 4217 currency for balance metrics. */
  currency?: string;
  /** Percent remaining for percent_remaining metrics (always 0..100 semantics). */
  percentRemaining?: number;
  /** Structured balance amount in `currency` units for balance metrics. */
  amount?: number;
  /** Provider-reported availability for availability metrics. */
  status?: "available" | "unavailable" | "unknown";
  /** ISO reset time when the source reports one. */
  resetTimeIso?: string;
  quality: QuotaSnapshotObservationQuality;
  authority: QuotaSnapshotAuthority;
}

export type QuotaSnapshotIntegrity = "complete" | "partial" | "unknown";

export interface UnifiedQuotaSnapshot {
  version: typeof QUOTA_SNAPSHOT_VERSION;
  /**
   * "complete" when every monitored provider has fresh data, "partial" when
   * some do, "unknown" when none do (including the no-provider case).
   */
  integrity: QuotaSnapshotIntegrity;
  /** One observation per monitored provider; providers are never hidden. */
  providers: QuotaSnapshotProviderObservation[];
  windows: QuotaSnapshotWindow[];
}

// =============================================================================
// Passive surface payloads
// =============================================================================

export type StartupHintOverallState = "ok" | "partial" | "unknown" | "none";

export interface StartupHintMostRelevantItem {
  providerId: string;
  providerLabel: string;
  windowLabel?: string;
  percentRemaining: number;
  resetTimeIso?: string;
}

export interface StartupHintPayload {
  /**
   * "none" suppresses the hint entirely (no monitored provider, or the
   * startupHint surface is disabled in config).
   */
  state: StartupHintOverallState;
  /** Number of monitored providers in the snapshot. */
  providerCount: number;
  /** Providers whose observation is not fresh (failed/missing/stale/synthetic). */
  unknownCount: number;
  /** Lowest reliable remaining-percent window; undefined when none qualifies. */
  mostRelevant?: StartupHintMostRelevantItem;
}

// =============================================================================
// Alert plan + projection state
// =============================================================================

/**
 * Danger severity (Ticket 09). Warning represents a user-configured early
 * threshold while the Provider remains usable; critical represents 0% remaining
 * or explicit Provider-reported unavailability.
 */
export type QuotaDangerSeverity = "warning" | "critical";

/**
 * A pure danger-evaluation candidate from a fresh reliable observation. It is
 * not yet a notification: episode deduplication, merging and delivery arrive
 * with Tickets 11/12. Missing, failed, stale and synthetic observations never
 * produce candidates.
 */
export interface QuotaAlertPlanCandidate {
  providerId: string;
  providerLabel: string;
  metricType: QuotaSnapshotMetricType;
  severity: QuotaDangerSeverity;
  /** Quota window label for percent_remaining metrics. */
  windowLabel?: string;
  /** ISO 4217 currency for balance metrics. */
  currency?: string;
  /** Current percent remaining for percent_remaining metrics. */
  percentRemaining?: number;
  /** Current structured amount for balance metrics. */
  amount?: number;
  /** Explicit provider-reported unavailability for availability metrics. */
  status?: "unavailable";
  /** Effective percent-remaining danger threshold. */
  thresholdPercentRemaining?: number;
  /** Effective per-provider/per-currency balance danger threshold. */
  thresholdAmount?: number;
  /** ISO reset time when the source reports one. */
  resetTimeIso?: string;
}

/**
 * Typed alert plan. `notifications` stays empty until Tickets 11/12 implement
 * persistent alert episodes and delivery; `candidates` carries the pure
 * snapshot-level danger evaluation of the current refresh.
 */
export interface QuotaAlertPlan {
  version: 2;
  notifications: readonly [];
  candidates: readonly QuotaAlertPlanCandidate[];
}

/**
 * Projection state carried between evaluations. Tickets 11/12 will extend this
 * with persistent alert episodes; Ticket 09 only echoes the input unchanged.
 */
export interface QuotaProjectionState {
  version: 1;
  alertEpisodes: readonly [];
}

export const EMPTY_QUOTA_PROJECTION_STATE: QuotaProjectionState = {
  version: 1,
  alertEpisodes: [],
};

export interface QuotaSnapshotProjection {
  startupHint: StartupHintPayload;
  alertPlan: QuotaAlertPlan;
  nextState: QuotaProjectionState;
}

// =============================================================================
// Snapshot builder (pure projection of structured provider results)
// =============================================================================

export interface QuotaSnapshotBuildAvailabilityInput {
  providerId: string;
  ok: boolean;
  error?: boolean;
}

export interface QuotaSnapshotBuildResultInput {
  providerId: string;
  result: QuotaProviderResult;
}

function providerQuality(params: {
  available: boolean;
  result?: QuotaProviderResult;
}): QuotaSnapshotObservationQuality {
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

function snapshotIntegrity(
  providers: QuotaSnapshotProviderObservation[],
): QuotaSnapshotIntegrity {
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
export function buildUnifiedQuotaSnapshot(params: {
  monitoredProviderIds: string[];
  availability: QuotaSnapshotBuildAvailabilityInput[];
  results: QuotaSnapshotBuildResultInput[];
}): UnifiedQuotaSnapshot {
  const availabilityByProviderId = new Map(
    params.availability.map((item) => [item.providerId, item] as const),
  );
  const resultByProviderId = new Map(
    params.results.map((item) => [item.providerId, item.result] as const),
  );

  const providers: QuotaSnapshotProviderObservation[] = params.monitoredProviderIds.map(
    (providerId) => {
      const available = availabilityByProviderId.get(providerId)?.ok ?? false;
      const result = resultByProviderId.get(providerId);
      const quality = providerQuality({ available, result });
      const errors =
        quality === "failed" ? (result?.errors ?? []) : ([] as QuotaProviderResult["errors"]);
      return { providerId, quality, errors };
    },
  );

  const windows: QuotaSnapshotWindow[] = [];
  for (const provider of providers) {
    const result = resultByProviderId.get(provider.providerId);
    if (!result) continue;

    for (const entry of result.entries) {
      const isPercent = !("kind" in entry) || entry.kind === undefined || entry.kind === "percent";
      const percentRemaining = isPercent
        ? normalizePercentWindowRemaining(
            "percentRemaining" in entry ? entry.percentRemaining : undefined,
          )
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
      } else {
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

function selectMostRelevantWindow(snapshot: UnifiedQuotaSnapshot): StartupHintMostRelevantItem | undefined {
  let selected: StartupHintMostRelevantItem | undefined;
  for (const window of snapshot.windows) {
    if (window.metricType !== "percent_remaining") continue;
    if (window.quality !== "fresh") continue;
    if (typeof window.percentRemaining !== "number") continue;

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

function percentCandidate(
  window: QuotaSnapshotWindow,
  threshold: number,
): QuotaAlertPlanCandidate | null {
  if (typeof window.percentRemaining !== "number") return null;
  if (window.percentRemaining > threshold) return null;
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

function balanceCandidate(
  window: QuotaSnapshotWindow,
  threshold: number,
): QuotaAlertPlanCandidate | null {
  if (typeof window.amount !== "number") return null;
  if (window.amount > threshold) return null;
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
export function evaluateQuotaDangerMetrics(params: {
  alerts: Pick<
    QuotaToastConfig["alerts"],
    "enabled" | "percentRemainingThreshold" | "balanceThresholds"
  >;
  snapshot: UnifiedQuotaSnapshot;
}): QuotaAlertPlanCandidate[] {
  if (!params.alerts.enabled) {
    return [];
  }

  const candidates: QuotaAlertPlanCandidate[] = [];
  for (const window of params.snapshot.windows) {
    if (window.quality !== "fresh") continue;

    switch (window.metricType) {
      case "percent_remaining": {
        const candidate = percentCandidate(window, params.alerts.percentRemainingThreshold);
        if (candidate) candidates.push(candidate);
        break;
      }
      case "balance": {
        const threshold = window.currency
          ? params.alerts.balanceThresholds[window.providerId]?.[window.currency]
          : undefined;
        if (threshold === undefined) continue;
        const candidate = balanceCandidate(window, threshold);
        if (candidate) candidates.push(candidate);
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

export function buildQuotaAlertPlan(
  alerts: Pick<
    QuotaToastConfig["alerts"],
    "enabled" | "percentRemainingThreshold" | "balanceThresholds"
  >,
  snapshot: UnifiedQuotaSnapshot,
): QuotaAlertPlan {
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
export function projectQuotaSnapshot(params: {
  config: Pick<QuotaToastConfig, "startupHint" | "alerts">;
  snapshot: UnifiedQuotaSnapshot;
  now: Date;
  state: QuotaProjectionState;
}): QuotaSnapshotProjection {
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
  const freshCount = params.snapshot.providers.filter(
    (provider) => provider.quality === "fresh",
  ).length;
  const unknownCount = providerCount - freshCount;
  // Overall state derives from the provider observations themselves so an
  // inconsistent integrity marker can never flip the outcome.
  const state: StartupHintOverallState =
    freshCount === providerCount
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

function formatResetCountdown(
  resetTimeIso: string | undefined,
  now: Date,
): string | null {
  if (!resetTimeIso) return null;
  const resetMs = Date.parse(resetTimeIso);
  if (!Number.isFinite(resetMs)) return null;

  const minutes = Math.max(1, Math.ceil((resetMs - now.getTime()) / 60_000));
  if (minutes < 60) {
    return `${minutes} 分钟后重置`;
  }
  return `${Math.ceil(minutes / 60)} 小时后重置`;
}

function formatMostRelevantText(
  item: StartupHintMostRelevantItem | undefined,
  now: Date,
): string {
  if (!item) return "";
  const countdown = formatResetCountdown(item.resetTimeIso, now);
  const windowPart = item.windowLabel ? `（${item.windowLabel}` : "（";
  const suffix = countdown ? `，${countdown}）` : "）";
  return `最相关：${item.providerLabel} ${Math.round(item.percentRemaining)}% 剩余${windowPart}${suffix}`;
}

/**
 * Pure single-line startup hint text. Returns null when the hint must not be
 * rendered (no monitored provider or disabled surface).
 */
export function formatStartupHintText(
  payload: StartupHintPayload,
  now: Date,
): string | null {
  if (payload.state === "none") {
    return null;
  }

  if (payload.state === "unknown") {
    return "额度状态未知：暂无法获取 Provider 额度数据。输入 /quota 查看诊断详情。";
  }

  if (payload.state === "ok") {
    return (
      `额度：整体正常。${formatMostRelevantText(payload.mostRelevant, now)}` +
      `监控 ${payload.providerCount} 个 Provider。输入 /quota 查看详情。`
    );
  }

  return (
    `额度：部分可用。${formatMostRelevantText(payload.mostRelevant, now)}` +
    `监控 ${payload.providerCount} 个 Provider，其中 ${payload.unknownCount} 个状态未知。` +
    `输入 /quota 查看详情。`
  );
}
