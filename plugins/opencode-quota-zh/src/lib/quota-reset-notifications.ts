import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, open, readFile, rm, rmdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { writeJsonAtomic } from "./atomic-json.js";
import { isPercentEntry, type QuotaProviderResult, type QuotaToastEntry } from "./entries.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { getQuotaProviderDisplayLabel } from "./provider-metadata.js";
import { classifyQuotaWindowText, type QuotaWindowKind } from "./quota-entry-display.js";
import type { QuotaResetWindow } from "./types.js";

const STATE_VERSION = 2;
const MAX_TRANSITION_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_OBSERVATION_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const LOCK_RETRY_DELAY_MS = 20;
const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_AGE_MS = 30_000;
const LOCK_OWNER_FILE = "owner.json";
const LOCK_RECLAIM_FILE = "reclaim";

const WINDOW_KINDS: Readonly<Record<QuotaResetWindow, QuotaWindowKind>> = {
  fiveHour: "five_hour",
  hourly: "hour",
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

type ResetObservation = {
  resetAtMs: number;
  percentRemaining: number;
  observedAtMs: number;
  notifiedResetAtMs?: number;
};

type ResetNotificationState = {
  version: typeof STATE_VERSION;
  observations: Record<string, ResetObservation>;
};

type ResetCandidate = {
  current: ResetObservation;
  notice: QuotaResetNotice;
};

type StateLockOwner = {
  token: string;
  pid: number;
  createdAtMs: number;
};

export type QuotaResetProviderResult = {
  providerId: string;
  result: QuotaProviderResult;
};

export type QuotaResetNotice = {
  providerId: string;
  label: string;
  window: QuotaResetWindow;
  percentRemaining: number;
};

function getStatePath(): string {
  return join(
    getOpencodeRuntimeDirs().stateDir,
    "opencode-quota-zh",
    "quota-reset-notifications.json",
  );
}

function getWindow(entry: QuotaToastEntry): QuotaWindowKind | null {
  if (entry.semantic) {
    return entry.semantic.metric.kind === "window" ? entry.semantic.metric.window : null;
  }
  return classifyQuotaWindowText(entry.label ?? "") ?? classifyQuotaWindowText(entry.name);
}

function getConfiguredWindow(
  kind: QuotaWindowKind | null,
  configured: readonly QuotaResetWindow[],
): QuotaResetWindow | null {
  if (!kind) return null;
  return configured.find((window) => WINDOW_KINDS[window] === kind) ?? null;
}

function getIdentity(providerId: string, entry: QuotaToastEntry, window: QuotaResetWindow): string {
  const raw = [
    providerId,
    entry.accounting.sourceId ?? "single-source",
    window,
    entry.accounting.resultType,
  ].join("\u001f");
  return createHash("sha256").update(raw).digest("hex");
}

function isObservation(value: unknown): value is ResetObservation {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ResetObservation>;
  return (
    Number.isFinite(item.resetAtMs) &&
    Number.isFinite(item.percentRemaining) &&
    Number.isFinite(item.observedAtMs)
  );
}

async function readState(path: string): Promise<ResetNotificationState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ResetNotificationState>;
    if (parsed.version !== STATE_VERSION || !parsed.observations) throw new Error("invalid state");
    return {
      version: STATE_VERSION,
      observations: Object.fromEntries(
        Object.entries(parsed.observations).filter((entry) => isObservation(entry[1])),
      ),
    };
  } catch {
    return { version: STATE_VERSION, observations: {} };
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLockOwner(value: string): StateLockOwner | null {
  try {
    const owner = JSON.parse(value) as Partial<StateLockOwner>;
    if (
      typeof owner.token !== "string" ||
      !Number.isSafeInteger(owner.pid) ||
      (owner.pid ?? 0) <= 0 ||
      !Number.isFinite(owner.createdAtMs)
    ) {
      return null;
    }
    return owner as StateLockOwner;
  } catch {
    return null;
  }
}

async function readLockOwner(lockPath: string): Promise<StateLockOwner | null> {
  try {
    return parseLockOwner(await readFile(join(lockPath, LOCK_OWNER_FILE), "utf8"));
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return null;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isFileSystemError(error, "ESRCH");
  }
}

async function getReclaimStatus(
  lockPath: string,
): Promise<{ reclaimable: boolean; allowMissingOwner: boolean }> {
  const owner = await readLockOwner(lockPath);
  if (owner) return { reclaimable: !isProcessAlive(owner.pid), allowMissingOwner: false };

  try {
    const lock = await stat(lockPath);
    const stale = Date.now() - lock.mtimeMs > STALE_LOCK_AGE_MS;
    return { reclaimable: stale, allowMissingOwner: stale };
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      return { reclaimable: true, allowMissingOwner: true };
    }
    throw error;
  }
}

async function tryReclaimStateLock(lockPath: string, allowMissingOwner: boolean): Promise<boolean> {
  const reclaimPath = join(lockPath, LOCK_RECLAIM_FILE);
  try {
    const handle = await open(reclaimPath, "wx", 0o600);
    await handle.close();
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return true;
    if (!isFileSystemError(error, "EEXIST")) throw error;

    try {
      const reclaim = await stat(reclaimPath);
      if (Date.now() - reclaim.mtimeMs <= STALE_LOCK_AGE_MS) return false;
    } catch (statError) {
      if (isFileSystemError(statError, "ENOENT")) return false;
      throw statError;
    }

    const owner = await readLockOwner(lockPath);
    if (owner && isProcessAlive(owner.pid)) {
      await unlink(reclaimPath).catch(() => undefined);
      return false;
    }
    if (!owner && !allowMissingOwner) return false;
    await rm(lockPath, { recursive: true, force: true });
    return true;
  }

  const owner = await readLockOwner(lockPath);
  const reclaimable = owner ? !isProcessAlive(owner.pid) : allowMissingOwner;
  if (reclaimable) {
    await rm(lockPath, { recursive: true, force: true });
    return true;
  }

  await unlink(reclaimPath).catch((error: unknown) => {
    if (!isFileSystemError(error, "ENOENT")) throw error;
  });
  return false;
}

async function acquireStateLock(statePath: string): Promise<() => Promise<void>> {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const lockPath = `${statePath}.lock`;
  const token = randomUUID();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const owner = { token, pid: process.pid, createdAtMs: Date.now() } satisfies StateLockOwner;
      try {
        writeFileSync(join(lockPath, LOCK_OWNER_FILE), JSON.stringify(owner), {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        await rmdir(lockPath).catch(() => undefined);
        throw error;
      }

      return async () => {
        const currentOwner = await readLockOwner(lockPath);
        if (currentOwner?.token !== token) return;
        await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) throw error;
    }

    const status = await getReclaimStatus(lockPath);
    if (status.reclaimable && (await tryReclaimStateLock(lockPath, status.allowMissingOwner))) {
      continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out acquiring quota reset notification state lock: ${lockPath}`);
    }
    await delay(LOCK_RETRY_DELAY_MS);
  }
}

function didReset(previous: ResetObservation, current: ResetObservation, nowMs: number): boolean {
  const transitionAge = nowMs - previous.resetAtMs;
  return (
    previous.observedAtMs <= previous.resetAtMs &&
    transitionAge >= 0 &&
    transitionAge <= MAX_TRANSITION_AGE_MS &&
    current.resetAtMs > previous.resetAtMs &&
    current.resetAtMs > nowMs &&
    current.percentRemaining > previous.percentRemaining &&
    previous.percentRemaining < 100 &&
    previous.notifiedResetAtMs !== previous.resetAtMs
  );
}

function updateObservation(
  previous: ResetObservation | undefined,
  current: ResetObservation,
  nowMs: number,
): { observation: ResetObservation; notify: boolean } {
  if (!previous) return { observation: current, notify: false };
  if (current.resetAtMs < previous.resetAtMs || current.observedAtMs < previous.observedAtMs) {
    return { observation: previous, notify: false };
  }

  if (current.resetAtMs === previous.resetAtMs) {
    if (current.resetAtMs <= nowMs && previous.observedAtMs <= previous.resetAtMs) {
      return { observation: previous, notify: false };
    }
    return {
      observation: { ...current, notifiedResetAtMs: previous.notifiedResetAtMs },
      notify: false,
    };
  }

  if (nowMs < previous.resetAtMs) return { observation: previous, notify: false };

  const notify = didReset(previous, current, nowMs);
  return {
    observation: notify ? { ...current, notifiedResetAtMs: previous.resetAtMs } : current,
    notify,
  };
}

function collectCandidates(params: {
  providers: QuotaResetProviderResult[];
  windows: readonly QuotaResetWindow[];
  nowMs: number;
}): Map<string, ResetCandidate[]> {
  const candidates = new Map<string, ResetCandidate[]>();

  for (const provider of params.providers) {
    for (const entry of provider.result.entries) {
      if (!isPercentEntry(entry)) continue;
      if (entry.accounting.resultType !== "quota" && entry.accounting.resultType !== "rate_limit") {
        continue;
      }
      if (!entry.resetTimeIso) continue;

      const window = getConfiguredWindow(getWindow(entry), params.windows);
      if (!window) continue;
      const resetAtMs = Date.parse(entry.resetTimeIso);
      if (!Number.isFinite(resetAtMs)) continue;

      const key = getIdentity(provider.providerId, entry, window);
      const candidate: ResetCandidate = {
        current: {
          resetAtMs,
          percentRemaining: entry.percentRemaining,
          observedAtMs: params.nowMs,
        },
        notice: {
          providerId: provider.providerId,
          label: entry.group?.trim() || getQuotaProviderDisplayLabel(provider.providerId),
          window,
          percentRemaining: entry.percentRemaining,
        },
      };
      const matching = candidates.get(key);
      if (matching) matching.push(candidate);
      else candidates.set(key, [candidate]);
    }
  }

  return candidates;
}

export async function observeQuotaResetNotifications(params: {
  providers: QuotaResetProviderResult[];
  windows: readonly QuotaResetWindow[];
  nowMs?: number;
  statePath?: string;
}): Promise<QuotaResetNotice[]> {
  const nowMs = params.nowMs ?? Date.now();
  const statePath = params.statePath ?? getStatePath();
  const candidates = collectCandidates({
    providers: params.providers,
    windows: params.windows,
    nowMs,
  });
  const releaseLock = await acquireStateLock(statePath);

  try {
    const state = await readState(statePath);
    const observations = Object.fromEntries(
      Object.entries(state.observations).filter(
        ([, observation]) => nowMs - observation.observedAtMs <= MAX_OBSERVATION_AGE_MS,
      ),
    );
    const notices: QuotaResetNotice[] = [];

    for (const [key, matching] of candidates) {
      if (matching.length !== 1) {
        delete observations[key];
        continue;
      }
      const candidate = matching[0];
      if (!candidate) continue;
      const update = updateObservation(observations[key], candidate.current, nowMs);
      observations[key] = update.observation;
      if (update.notify) notices.push(candidate.notice);
    }

    await writeJsonAtomic(
      statePath,
      { version: STATE_VERSION, observations } satisfies ResetNotificationState,
      { trailingNewline: true, directoryMode: 0o700, fileMode: 0o600 },
    );
    return notices;
  } finally {
    await releaseLock();
  }
}

export function formatQuotaResetNotification(notices: readonly QuotaResetNotice[]): string | null {
  if (notices.length === 0) return null;
  const labels = [...new Set(notices.map((notice) => notice.label))];
  const shown = labels.slice(0, 3);
  const overflow = labels.length - shown.length;
  const providers = `${shown.join(", ")}${overflow > 0 ? ` and ${overflow} more` : ""}`;

  const [notice] = notices;
  if (notice && notices.length === 1) {
    const window = notice.window === "weekly" ? "Weekly" : "Quota";
    return `${window} quota reset: ${providers} is available again (${Math.round(notice.percentRemaining)}% remaining).`;
  }
  return `Quota reset: ${providers} are available again.`;
}
