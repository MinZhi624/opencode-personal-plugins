/**
 * Ticket 11: quota alert episode state machine + persistence + Chinese
 * formatting.
 *
 * An 额度告警周期 (quota alert episode) is the period during which one
 * Provider/account/quota-window stays in a dangerous state, from the first
 * reliable dangerous observation until the quota recovers or resets. By
 * default each episode is actively notified at most once; the user can
 * configure a low-frequency repeat (`alerts.repeatAfterMinutes`). Restarting
 * OpenCode never starts a new episode — only re-entering danger after
 * recovery does.
 *
 * Determinism contract: `transitionAlertEpisodes` is pure and deterministic —
 * identical inputs (episodes, candidates, repeatAfterMinutes, now) always
 * produce identical transitions. The clock is always injected; this module
 * never calls Date.now() and performs no I/O except the explicit
 * read/write helpers (which take an injectable path for tests).
 *
 * Delivery contract (ADR 0001): the caller persists the returned episode
 * state only after the TUI accepted the notification. A failed delivery must
 * not consume the episode's notification opportunity; "new" transitions are
 * simply not persisted (the next refresh point retries), and "repeat"
 * transitions fall back to the previous episode state.
 */

import { readFile } from "fs/promises";
import { join } from "path";

import { writeJsonAtomic } from "./atomic-json.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import type {
  QuotaAlertPlanCandidate,
  QuotaDangerSeverity,
  QuotaSnapshotMetricType,
} from "./quota-snapshot.js";

export const QUOTA_ALERT_EPISODES_STATE_VERSION = 1 as const;

/** How long a resolved episode stays visible in `/quota_alerts` before pruning. */
export const RESOLVED_EPISODE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Hard cap on persisted episodes; the oldest resolved episodes drop first. */
export const MAX_QUOTA_ALERT_EPISODES = 200;

// =============================================================================
// Types
// =============================================================================

/**
 * One persisted quota alert episode. `resolvedAtIso` is absent while the
 * episode is dangerous; it is set once the quota reliably recovers or resets.
 */
export interface QuotaAlertEpisode {
  episodeId: string;
  providerId: string;
  providerLabel: string;
  metricType: QuotaSnapshotMetricType;
  severity: QuotaDangerSeverity;
  /** Quota window label for percent_remaining episodes. */
  windowLabel?: string;
  /** ISO 4217 currency for balance episodes. */
  currency?: string;
  /** Provider-reported unavailability for availability episodes. */
  status?: "unavailable";
  firstTriggeredAtIso: string;
  lastNotifiedAtIso: string;
  lastObservedAtIso: string;
  notifyCount: number;
  resolvedAtIso?: string;
}

/**
 * A notification to deliver for an episode. Carries the current candidate
 * values plus the episode bookkeeping so the toast text and `/quota_alerts`
 * report stay self-contained.
 */
export interface QuotaAlertNotification {
  episodeId: string;
  providerId: string;
  providerLabel: string;
  metricType: QuotaSnapshotMetricType;
  severity: QuotaDangerSeverity;
  windowLabel?: string;
  currency?: string;
  percentRemaining?: number;
  amount?: number;
  status?: "unavailable";
  thresholdPercentRemaining?: number;
  thresholdAmount?: number;
  resetTimeIso?: string;
  firstTriggeredAtIso: string;
  notifyCount: number;
  atIso: string;
}

export interface QuotaAlertEpisodesStateFileV1 {
  version: typeof QUOTA_ALERT_EPISODES_STATE_VERSION;
  updatedAtIso: string;
  episodes: QuotaAlertEpisode[];
}

export type QuotaAlertEpisodeTransition =
  | {
      kind: "new";
      episode: QuotaAlertEpisode;
      notification: QuotaAlertNotification;
    }
  | {
      kind: "repeat";
      previous: QuotaAlertEpisode;
      episode: QuotaAlertEpisode;
      notification: QuotaAlertNotification;
    }
  | { kind: "dangerous"; episode: QuotaAlertEpisode }
  | { kind: "resolved"; episode: QuotaAlertEpisode }
  | { kind: "unchanged"; episode: QuotaAlertEpisode };

// =============================================================================
// Episode identity
// =============================================================================

/**
 * Deterministic episode identity for one Provider/account/window. The
 * window part differs by metric kind: the window label for percent windows,
 * the currency for balances, and the status for availability.
 */
export function buildQuotaAlertEpisodeId(params: {
  providerId: string;
  metricType: QuotaSnapshotMetricType;
  windowLabel?: string;
  currency?: string;
  status?: "unavailable";
}): string {
  const windowPart =
    params.metricType === "percent_remaining"
      ? (params.windowLabel ?? "")
      : params.metricType === "balance"
        ? (params.currency ?? "")
        : (params.status ?? "");
  return [params.providerId, params.metricType, windowPart].join("::");
}

function candidateToEpisodeId(candidate: QuotaAlertPlanCandidate): string {
  return buildQuotaAlertEpisodeId({
    providerId: candidate.providerId,
    metricType: candidate.metricType,
    ...(candidate.windowLabel ? { windowLabel: candidate.windowLabel } : {}),
    ...(candidate.currency ? { currency: candidate.currency } : {}),
    ...(candidate.status ? { status: candidate.status } : {}),
  });
}

// =============================================================================
// Pure state machine
// =============================================================================

function buildNotification(params: {
  candidate: QuotaAlertPlanCandidate;
  episode: QuotaAlertEpisode;
  atIso: string;
}): QuotaAlertNotification {
  const { candidate, episode } = params;
  return {
    episodeId: episode.episodeId,
    providerId: candidate.providerId,
    providerLabel: candidate.providerLabel,
    metricType: candidate.metricType,
    severity: candidate.severity,
    ...(candidate.windowLabel ? { windowLabel: candidate.windowLabel } : {}),
    ...(candidate.currency ? { currency: candidate.currency } : {}),
    ...(candidate.percentRemaining !== undefined
      ? { percentRemaining: candidate.percentRemaining }
      : {}),
    ...(candidate.amount !== undefined ? { amount: candidate.amount } : {}),
    ...(candidate.status ? { status: candidate.status } : {}),
    ...(candidate.thresholdPercentRemaining !== undefined
      ? { thresholdPercentRemaining: candidate.thresholdPercentRemaining }
      : {}),
    ...(candidate.thresholdAmount !== undefined
      ? { thresholdAmount: candidate.thresholdAmount }
      : {}),
    ...(candidate.resetTimeIso ? { resetTimeIso: candidate.resetTimeIso } : {}),
    firstTriggeredAtIso: episode.firstTriggeredAtIso,
    notifyCount: episode.notifyCount,
    atIso: params.atIso,
  };
}

function episodeFromCandidate(
  candidate: QuotaAlertPlanCandidate,
  nowIso: string,
): QuotaAlertEpisode {
  return {
    episodeId: candidateToEpisodeId(candidate),
    providerId: candidate.providerId,
    providerLabel: candidate.providerLabel,
    metricType: candidate.metricType,
    severity: candidate.severity,
    ...(candidate.windowLabel ? { windowLabel: candidate.windowLabel } : {}),
    ...(candidate.currency ? { currency: candidate.currency } : {}),
    ...(candidate.status ? { status: candidate.status } : {}),
    firstTriggeredAtIso: nowIso,
    lastNotifiedAtIso: nowIso,
    lastObservedAtIso: nowIso,
    notifyCount: 1,
  };
}

function lastNotifiedMs(episode: QuotaAlertEpisode): number {
  const parsed = Date.parse(episode.lastNotifiedAtIso);
  return Number.isFinite(parsed) ? parsed : Date.parse(episode.firstTriggeredAtIso);
}

/**
 * Transitions the persisted episodes against the current danger candidates.
 *
 * Rules:
 * - A candidate with no open episode creates one and emits a first
 *   notification ("new").
 * - An open episode still matched by its candidate stays dangerous; a repeat
 *   notification is emitted only when `repeatAfterMinutes` is configured and
 *   the repeat interval has elapsed ("repeat").
 * - An open episode with no matching candidate is resolved ("resolved"); a
 *   recovery never emits a notification.
 * - An open episode whose provider observation is not reliable (listed in
 *   `unknownProviderIds`) is held open ("dangerous") instead of resolved:
 *   missing, failed, stale and synthetic observations never produce
 *   candidates (enforced by the snapshot danger evaluation), and they must
 *   neither create nor recover an alert (ADR 0001 — a query failure is not a
 *   reliable recovery).
 * - Episodes not present in the input (already resolved, or new) are covered
 *   too: already-resolved episodes pass through as "unchanged" so retention
 *   pruning stays a separate concern.
 */
export function transitionAlertEpisodes(params: {
  episodes: readonly QuotaAlertEpisode[];
  candidates: readonly QuotaAlertPlanCandidate[];
  repeatAfterMinutes: number | null;
  now: Date;
  /**
   * Provider ids whose current observation is not reliable (missing, failed,
   * stale or synthetic). Open episodes for these providers are held open
   * rather than resolved.
   */
  unknownProviderIds?: ReadonlySet<string>;
}): QuotaAlertEpisodeTransition[] {
  const nowIso = params.now.toISOString();
  const nowMs = params.now.getTime();
  const repeatMs = params.repeatAfterMinutes === null ? null : params.repeatAfterMinutes * 60_000;
  const candidatesById = new Map<string, QuotaAlertPlanCandidate>();
  for (const candidate of params.candidates) {
    candidatesById.set(candidateToEpisodeId(candidate), candidate);
  }

  const transitions: QuotaAlertEpisodeTransition[] = [];
  for (const episode of params.episodes) {
    if (episode.resolvedAtIso !== undefined) {
      transitions.push({ kind: "unchanged", episode });
      continue;
    }
    const candidate = candidatesById.get(episode.episodeId);
    if (!candidate) {
      if (params.unknownProviderIds?.has(episode.providerId)) {
        // The provider observation is not reliable (missing/failed/stale/
        // synthetic): hold the episode open so a transient query failure is
        // never treated as a reliable recovery (ADR 0001).
        transitions.push({
          kind: "dangerous",
          episode: { ...episode, lastObservedAtIso: nowIso },
        });
        continue;
      }
      transitions.push({
        kind: "resolved",
        episode: { ...episode, resolvedAtIso: nowIso },
      });
      continue;
    }
    const isRepeatEligible =
      repeatMs !== null && nowMs - lastNotifiedMs(episode) >= repeatMs;
    if (isRepeatEligible) {
      const next: QuotaAlertEpisode = {
        ...episode,
        severity: candidate.severity,
        lastNotifiedAtIso: nowIso,
        lastObservedAtIso: nowIso,
        notifyCount: episode.notifyCount + 1,
      };
      transitions.push({
        kind: "repeat",
        previous: episode,
        episode: next,
        notification: buildNotification({ candidate, episode: next, atIso: nowIso }),
      });
    } else {
      transitions.push({
        kind: "dangerous",
        episode: {
          ...episode,
          severity: candidate.severity,
          lastObservedAtIso: nowIso,
        },
      });
    }
  }

  for (const candidate of params.candidates) {
    const episodeId = candidateToEpisodeId(candidate);
    // Only an open episode blocks a new episode: a resolved episode means the
    // quota recovered, so re-entering danger starts a fresh episode.
    if (
      params.episodes.some(
        (episode) => episode.resolvedAtIso === undefined && episode.episodeId === episodeId,
      )
    ) {
      continue;
    }
    const episode = episodeFromCandidate(candidate, nowIso);
    transitions.push({
      kind: "new",
      episode,
      notification: buildNotification({ candidate, episode, atIso: nowIso }),
    });
  }

  return transitions;
}

/**
 * Applies the resolved-episode retention window and the hard episode cap.
 * Active (dangerous) episodes always win; resolved episodes drop oldest
 * first when the cap is exceeded.
 */
export function pruneQuotaAlertEpisodes(
  episodes: readonly QuotaAlertEpisode[],
  now: Date,
): QuotaAlertEpisode[] {
  const cutoffMs = now.getTime() - RESOLVED_EPISODE_RETENTION_MS;
  const kept = episodes.filter(
    (episode) =>
      episode.resolvedAtIso === undefined || Date.parse(episode.resolvedAtIso) >= cutoffMs,
  );
  if (kept.length <= MAX_QUOTA_ALERT_EPISODES) {
    return kept;
  }

  const active = kept.filter((episode) => episode.resolvedAtIso === undefined);
  const resolved = kept.filter((episode) => episode.resolvedAtIso !== undefined);
  if (active.length >= MAX_QUOTA_ALERT_EPISODES) {
    return [...active]
      .sort((left, right) => right.lastObservedAtIso.localeCompare(left.lastObservedAtIso))
      .slice(0, MAX_QUOTA_ALERT_EPISODES);
  }

  const resolvedKept = [...resolved]
    .sort((left, right) =>
      (right.resolvedAtIso ?? "").localeCompare(left.resolvedAtIso ?? ""),
    )
    .slice(0, MAX_QUOTA_ALERT_EPISODES - active.length);
  return [...active, ...resolvedKept];
}

// =============================================================================
// Persistence
// =============================================================================

/**
 * Alert episodes live under the isolated `opencode-quota-zh` state namespace
 * (ADR 0002): `~/.local/state/opencode/opencode-quota-zh/quota-alert-episodes.json`
 * (or the XDG_STATE_HOME equivalent). The file holds only episode bookkeeping,
 * never credentials, quota values, or candidate payloads.
 */
export function getQuotaAlertEpisodesPath(): string {
  const { stateDir } = getOpencodeRuntimeDirs();
  return join(stateDir, "opencode-quota-zh", "quota-alert-episodes.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isQuotaSnapshotMetricType(value: unknown): value is QuotaSnapshotMetricType {
  return value === "percent_remaining" || value === "balance" || value === "availability";
}

function isQuotaDangerSeverity(value: unknown): value is QuotaDangerSeverity {
  return value === "warning" || value === "critical";
}

function isValidEpisode(value: unknown): value is QuotaAlertEpisode {
  if (!isRecord(value)) return false;
  if (
    typeof value.episodeId !== "string" ||
    typeof value.providerId !== "string" ||
    typeof value.providerLabel !== "string" ||
    !isQuotaSnapshotMetricType(value.metricType) ||
    !isQuotaDangerSeverity(value.severity) ||
    typeof value.firstTriggeredAtIso !== "string" ||
    typeof value.lastNotifiedAtIso !== "string" ||
    typeof value.lastObservedAtIso !== "string" ||
    typeof value.notifyCount !== "number" ||
    !Number.isInteger(value.notifyCount) ||
    value.notifyCount < 1
  ) {
    return false;
  }
  if (value.windowLabel !== undefined && typeof value.windowLabel !== "string") return false;
  if (value.currency !== undefined && typeof value.currency !== "string") return false;
  if (value.status !== undefined && value.status !== "unavailable") return false;
  if (value.resolvedAtIso !== undefined && typeof value.resolvedAtIso !== "string") return false;
  return true;
}

/**
 * Reads persisted episodes. A missing, malformed, or version-mismatched file
 * returns an empty list — alert state is best-effort and must never block the
 * plugin or fabricate danger.
 */
export async function readQuotaAlertEpisodes(path?: string): Promise<QuotaAlertEpisode[]> {
  const filePath = path ?? getQuotaAlertEpisodesPath();
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== QUOTA_ALERT_EPISODES_STATE_VERSION) {
      return [];
    }
    if (!Array.isArray(parsed.episodes)) {
      return [];
    }
    return parsed.episodes.filter(isValidEpisode);
  } catch {
    return [];
  }
}

/**
 * Persists episodes atomically. The caller is responsible for only persisting
 * delivered-notification state (ADR 0001); this helper never reorders or
 * infers anything.
 */
export async function writeQuotaAlertEpisodes(
  episodes: readonly QuotaAlertEpisode[],
  options: { path?: string; now?: Date } = {},
): Promise<void> {
  const state: QuotaAlertEpisodesStateFileV1 = {
    version: QUOTA_ALERT_EPISODES_STATE_VERSION,
    updatedAtIso: (options.now ?? new Date()).toISOString(),
    episodes: episodes.map((episode) => ({ ...episode })),
  };
  await writeJsonAtomic(options.path ?? getQuotaAlertEpisodesPath(), state);
}

// =============================================================================
// Chinese formatting
// =============================================================================

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  CNY: "¥",
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
};

function formatAmountValue(amount: number, currency?: string): string {
  const symbol = currency ? (CURRENCY_SYMBOLS[currency] ?? `${currency} `) : "";
  return `${symbol}${amount.toFixed(2)}`;
}

function formatClockTime(iso: string | undefined, now: Date): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  const pad = (value: number) => String(value).padStart(2, "0");
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? `${pad(date.getHours())}:${pad(date.getMinutes())}`
    : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
        date.getHours(),
      )}:${pad(date.getMinutes())}`;
}

/**
 * Single-line Chinese toast text for one quota alert notification.
 *
 * - percent: `额度告警：<Provider> <窗口>额度剩余 <percent>%`
 * - balance: `额度告警：<Provider> 余额 <amount>`
 * - availability: `额度告警：<Provider> 当前不可用`
 *
 * An explicit nonzero threshold is appended when one participated, and a
 * repeat notification carries its attempt count. Values are rendered from the
 * structured notification only — display text is never parsed.
 */
export function formatQuotaAlertNotificationText(notification: QuotaAlertNotification): string {
  const base =
    notification.metricType === "percent_remaining"
      ? `额度告警：${notification.providerLabel}${
          notification.windowLabel ? ` ${notification.windowLabel}` : ""
        } 额度剩余 ${Math.round(notification.percentRemaining ?? 0)}%`
      : notification.metricType === "balance"
        ? `额度告警：${notification.providerLabel} 余额 ${formatAmountValue(
            notification.amount ?? 0,
            notification.currency,
          )}`
        : `额度告警：${notification.providerLabel} 当前不可用`;

  const thresholdPart =
    notification.metricType === "percent_remaining" &&
    typeof notification.thresholdPercentRemaining === "number" &&
    notification.thresholdPercentRemaining > 0
      ? `（阈值 ${notification.thresholdPercentRemaining}%）`
      : notification.metricType === "balance" &&
          typeof notification.thresholdAmount === "number"
        ? `（阈值 ${formatAmountValue(notification.thresholdAmount, notification.currency)}）`
        : "";
  const repeatPart =
    notification.notifyCount > 1 ? `（第 ${notification.notifyCount} 次提醒）` : "";

  return `${base}${thresholdPart}${repeatPart}`;
}

/**
 * Chinese `/quota_alerts` report: dangerous episodes first, then episodes
 * resolved within the last 24 hours. An empty state produces a short
 * passive message.
 */
export function buildQuotaAlertsReport(params: {
  episodes: readonly QuotaAlertEpisode[];
  now: Date;
}): string {
  const active = params.episodes.filter((episode) => episode.resolvedAtIso === undefined);
  const resolvedWindowMs = 24 * 60 * 60 * 1000;
  const recovered = params.episodes.filter((episode) => {
    if (episode.resolvedAtIso === undefined) return false;
    const resolvedMs = Date.parse(episode.resolvedAtIso);
    return Number.isFinite(resolvedMs) && params.now.getTime() - resolvedMs <= resolvedWindowMs;
  });

  const metricText = (episode: QuotaAlertEpisode): string =>
    episode.metricType === "percent_remaining"
      ? `${episode.windowLabel ? `${episode.windowLabel} ` : ""}百分比额度`
      : episode.metricType === "balance"
        ? `${episode.currency ?? ""} 余额`
        : "可用状态";
  const severityText = (episode: QuotaAlertEpisode): string =>
    episode.severity === "critical" ? "严重" : "警告";

  if (active.length === 0 && recovered.length === 0) {
    return (
      "额度告警状态\n\n当前没有额度告警周期。额度进入危险状态时将在此显示，并在 TUI 中主动提醒。" +
      "\n\n运行 /quota_alerts reset 可清除历史告警状态。"
    );
  }

  const lines: string[] = [
    `额度告警状态（共 ${params.episodes.length} 个周期，其中 ${active.length} 个危险中）`,
  ];

  if (active.length > 0) {
    lines.push("", "危险中：");
    for (const episode of active) {
      const firstAt = formatClockTime(episode.firstTriggeredAtIso, params.now);
      const lastAt = formatClockTime(episode.lastNotifiedAtIso, params.now);
      lines.push(
        `- ${episode.providerLabel} · ${metricText(episode)} · ${severityText(episode)}` +
          ` · 首次触发 ${firstAt ?? episode.firstTriggeredAtIso}` +
          ` · 最近提醒 ${lastAt ?? episode.lastNotifiedAtIso}（第 ${episode.notifyCount} 次）`,
      );
    }
  }

  if (recovered.length > 0) {
    lines.push("", "已恢复（最近 24 小时）：");
    for (const episode of recovered) {
      const resolvedAt = formatClockTime(episode.resolvedAtIso, params.now);
      lines.push(
        `- ${episode.providerLabel} · ${metricText(episode)} · 已恢复 ${
          resolvedAt ?? episode.resolvedAtIso
        }`,
      );
    }
  }

  lines.push("", "运行 /quota_alerts reset 可清除全部告警状态。");
  return lines.join("\n");
}
