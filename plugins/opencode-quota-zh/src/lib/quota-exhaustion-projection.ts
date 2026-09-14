import type { FixedWindowProjectionEvidence, QuotaRunwayProjection } from "./entries.js";

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MINUTE_MS = 60_000;

function parseIsoTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_TIMESTAMP_RE.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function isFixedWindowProjectionEvidence(
  value: unknown,
  resetTimeIso?: string,
): value is FixedWindowProjectionEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  if (
    Object.keys(evidence).some(
      (key) => !["kind", "startedAtIso", "observedAtIso", "endsAtIso", "fullReset"].includes(key),
    ) ||
    evidence.kind !== "fixed_window" ||
    evidence.fullReset !== true
  ) {
    return false;
  }

  const startedAt = parseIsoTimestamp(evidence.startedAtIso);
  const observedAt = parseIsoTimestamp(evidence.observedAtIso);
  const endsAt = parseIsoTimestamp(evidence.endsAtIso);
  if (startedAt === null || observedAt === null || endsAt === null) return false;
  if (!(startedAt < observedAt && observedAt < endsAt)) return false;

  const resetAt = parseIsoTimestamp(resetTimeIso);
  if (resetAt === null || resetAt !== endsAt) return false;
  return true;
}

export function projectQuotaRunway(params: {
  percentRemaining: number;
  fixedWindow?: FixedWindowProjectionEvidence;
  resetTimeIso?: string;
  nowMs?: number;
}): QuotaRunwayProjection | null {
  const nowMs = params.nowMs ?? Date.now();
  if (!Number.isFinite(params.percentRemaining) || !Number.isFinite(nowMs)) return null;
  if (!isFixedWindowProjectionEvidence(params.fixedWindow, params.resetTimeIso)) return null;

  const startedAt = Date.parse(params.fixedWindow.startedAtIso);
  const observedAt = Date.parse(params.fixedWindow.observedAtIso);
  const endsAt = Date.parse(params.fixedWindow.endsAtIso);
  if (nowMs < observedAt || nowMs >= endsAt) return null;

  const remaining = params.percentRemaining;
  const used = 100 - remaining;
  if (used < 0) return null;
  if (used === 0) return { kind: "lasts_past_reset" };

  const elapsed = observedAt - startedAt;
  if (!(elapsed > 0)) return null;
  const rate = used / elapsed;
  if (!(rate > 0) || !Number.isFinite(rate)) return null;

  const runwayMs = remaining / rate;
  const projectedAt = observedAt + runwayMs;
  if (!Number.isFinite(projectedAt)) return null;
  if (projectedAt >= endsAt) return { kind: "lasts_past_reset" };

  return {
    kind: "before_reset",
    projectedAtIso: new Date(projectedAt).toISOString(),
  };
}

function formatRunwayDuration(milliseconds: number): string {
  const totalMinutes = Math.max(0, Math.ceil(milliseconds / MINUTE_MS));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}

export function formatQuotaRunway(
  projection: QuotaRunwayProjection | undefined,
  nowMs: number = Date.now(),
): string {
  if (!projection) return "";
  if (projection.kind === "lasts_past_reset") return "lasts past reset";

  const projectedAt = parseIsoTimestamp(projection.projectedAtIso);
  if (projectedAt === null || !Number.isFinite(nowMs)) return "";
  return `≈ ${formatRunwayDuration(projectedAt - nowMs)}`;
}

export function compareQuotaRunwayUrgency(
  left: QuotaRunwayProjection | undefined,
  right: QuotaRunwayProjection | undefined,
  nowMs: number = Date.now(),
): number {
  const urgency = (projection: QuotaRunwayProjection | undefined): [number, number] => {
    if (!projection) return [3, Number.POSITIVE_INFINITY];
    if (projection.kind === "lasts_past_reset") return [2, Number.POSITIVE_INFINITY];
    const projectedAt = parseIsoTimestamp(projection.projectedAtIso);
    if (projectedAt === null) return [3, Number.POSITIVE_INFINITY];
    if (projectedAt <= nowMs) return [0, projectedAt];
    return [1, projectedAt];
  };

  const [leftRank, leftAt] = urgency(left);
  const [rightRank, rightAt] = urgency(right);
  return leftRank - rightRank || leftAt - rightAt;
}
