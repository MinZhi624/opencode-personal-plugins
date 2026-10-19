/**
 * Per-session cost aggregation backed by the v6 usage engine.
 *
 * Source of truth: the quota plugin's local `sessionUsage` RPC (see
 * ./quota-usage-rpc.ts). One request answers with a whole session-tree report
 * from the same engine, the same message-attribution rules and the same price
 * snapshot the v6 usage console uses: the requested session's own cost, the
 * tree total, and every session of the tree at a single data time point. This
 * module never re-prices messages itself — a second, look-alike algorithm next
 * to that engine is exactly what must not exist.
 *
 * What this module owns:
 * - the bounded `fetchUsage` seam a runtime host binds (see ../runtime.ts);
 * - per-session own results for the cards (`get`), pre-warmed for every
 *   session of a report's tree, plus the cached server report (own / tree /
 *   bySession / sessionIDs + metadata) the summary reads so every scope
 *   shares one report's time point and price snapshot;
 * - the lifecycle consumers already rely on: debounce, in-flight merging,
 *   version guards, subscribe/unsubscribe, pause/resume/dispose, and the
 *   pricing-change re-read (`refreshForPricingChange`);
 * - failure semantics: a failed read keeps the last complete result and marks
 *   it stale; with no previous result the session stays failed/unknown and is
 *   never presented as a complete zero.
 *
 * Pricing (04) stays bound per runtime host: the snapshot is synced from the
 * quota plugin's read-only pricing RPC before every run, so a price move shows
 * up as stale/revision, while the amounts themselves come from the server
 * report (the engine priced them with its own resolver).
 *
 * The message pagination helpers below are kept for hosts that read messages
 * for other metrics; the cost path does not use them.
 */

import { calculateUsdFromTokenBuckets } from "./token-cost.ts"
import {
  addTokenBuckets,
  emptyTokenBuckets,
  hasTokenUsage,
  type TokenBuckets,
} from "./token-buckets.ts"
import type { SessionUsageCost, SessionUsageReport } from "./quota-usage-rpc.ts"
import {
  ensureLoaded,
  getPricingRevision,
  lookupCost,
  maybeRefreshPricingSnapshot,
  resolvePricingKey,
  type PricingSnapshot,
} from "./pricing.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionCostResult = {
  /** Priced USD estimate for this session's own assistant messages. */
  usd: number
  /** True when the aggregation covers the full session without error/truncation. */
  complete: boolean
  /** True when at least one assistant message carried token usage. */
  hasUsage: boolean
  /** True when at least one token-carrying message could not be priced. */
  partial: boolean
  /** Complete five-bucket usage for this session's assistant messages. */
  tokens: TokenBuckets
  messageCount: number
  error?: string
}

export type NormalizedMessage = {
  id: string
  role: string | undefined
  providerID: string | undefined
  modelID: string | undefined
  tokens: TokenBuckets
  hasTokens: boolean
}

export type SessionMessagesPage = {
  messages: NormalizedMessage[]
  /** v2 cursor shape only: continue with this cursor on the next page. */
  nextCursor?: string
  /**
   * v1 shape only: true when the page was exactly full (>= requested limit)
   * and completeness could not be verified (unlimited verification request
   * failed). Such a result must NOT be treated as the full-session total.
   */
  truncated?: boolean
}

export type SessionMessagesPageFetcher = (params: {
  sessionID: string
  /** Requested page size; 0 requests the unlimited/full set (verified 1.18.12). */
  limit: number
  cursor?: string
}) => Promise<SessionMessagesPage>

/**
 * Bounded usage source: one session-tree report from the v6 engine, requested
 * per session. Returning null (or throwing) means "no answer"; the service
 * then keeps its last complete result instead of inventing numbers.
 */
export type SessionUsageReportFetcher = (
  sessionID: string,
) => Promise<SessionUsageReport | null>

export interface PricingAdapter {
  snapshot(): PricingSnapshot
  refresh(opts?: { force?: boolean }): Promise<unknown>
}

/**
 * A pricing sync that retained old prices (RPC failure or an empty report)
 * surfaces as `stale` on the refresh outcome; anything else (including
 * foreign adapters) is treated as a fresh sync.
 */
function isStalePricingOutcome(outcome: unknown): boolean {
  if (!outcome || typeof outcome !== "object") return false
  return (outcome as { stale?: unknown }).stale === true
}

export interface SessionMetricsServiceOptions {
  /**
   * The v6 usage engine behind the quota plugin's `sessionUsage` RPC. While
   * it is bound, EVERY cost/token number comes from that report. Without it
   * the service reports "unavailable" instead of falling back to a parallel
   * local aggregation next to the engine.
   */
  fetchUsage?: SessionUsageReportFetcher
  /**
   * Legacy message pagination, kept for hosts that read messages for other
   * metrics. The cost path never uses it.
   */
  fetchPage?: SessionMessagesPageFetcher
  pricing?: PricingAdapter
  debounceMs?: number
  pageSize?: number
  maxPages?: number
  nowMs?: () => number
}

// ---------------------------------------------------------------------------
// Message normalization (defensive against SDK v1/v2 shapes)
// ---------------------------------------------------------------------------

type RawTokens = {
  input?: unknown
  output?: unknown
  reasoning?: unknown
  cache?: { read?: unknown; write?: unknown }
}

export function normalizeMessage(raw: unknown): NormalizedMessage | null {
  if (!raw || typeof raw !== "object") return null
  const m = raw as Record<string, unknown>
  // v1 wrapper page shape: { info: Message, parts: Part[] }
  const infoRaw =
    m.info && typeof m.info === "object" ? (m.info as Record<string, unknown>) : m
  const id = typeof infoRaw.id === "string" ? infoRaw.id : undefined
  if (!id) return null
  const role = typeof infoRaw.role === "string" ? infoRaw.role
    : typeof infoRaw.type === "string" ? infoRaw.type
    : undefined
  // v2 projected shape: model: { providerID, id }; v1 shape: flat providerID/modelID
  const modelObj =
    infoRaw.model && typeof infoRaw.model === "object"
      ? (infoRaw.model as Record<string, unknown>)
      : null
  const providerID =
    typeof infoRaw.providerID === "string"
      ? infoRaw.providerID
      : modelObj && typeof modelObj.providerID === "string"
        ? modelObj.providerID
        : undefined
  const modelID =
    typeof infoRaw.modelID === "string"
      ? infoRaw.modelID
      : modelObj && typeof modelObj.id === "string"
        ? modelObj.id
        : undefined
  const tokensRaw =
    infoRaw.tokens && typeof infoRaw.tokens === "object"
      ? (infoRaw.tokens as RawTokens)
      : undefined
  const tokens = tokensRaw
    ? {
        input: typeof tokensRaw.input === "number" ? tokensRaw.input : 0,
        output: typeof tokensRaw.output === "number" ? tokensRaw.output : 0,
        reasoning: typeof tokensRaw.reasoning === "number" ? tokensRaw.reasoning : 0,
        cache_read:
          typeof tokensRaw.cache?.read === "number" ? tokensRaw.cache.read : 0,
        cache_write:
          typeof tokensRaw.cache?.write === "number" ? tokensRaw.cache.write : 0,
      }
    : emptyTokenBuckets()
  return { id, role, providerID, modelID, tokens, hasTokens: hasTokenUsage(tokens) }
}

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------

/** Client-like minimal surface used by the real page fetcher. */
export interface SessionMessagesClientLike {
  session: {
    messages(parameters: {
      sessionID: string
      limit?: number
      cursor?: string
    }): Promise<unknown>
  }
}

function normalizeList(items: unknown[]): NormalizedMessage[] {
  return items
    .map(normalizeMessage)
    .filter((m): m is NormalizedMessage => m !== null)
}

/** SDK `{ error, request, response }` failure envelope (throwOnError=false). */
function isErrorEnvelope(result: unknown): result is { error: unknown } {
  return (
    !!result &&
    typeof result === "object" &&
    "error" in result &&
    !!(result as Record<string, unknown>).error
  )
}

function describeEnvelopeError(error: unknown): string {
  try {
    const s = JSON.stringify(error)
    return s && s.length > 200 ? `${s.slice(0, 200)}…` : s ?? String(error)
  } catch {
    return String(error)
  }
}

/**
 * Real page fetcher against `api.client.session.messages()`.
 *
 * Verified runtime (opencode 1.18.12): the client forwards only
 * `{sessionID, limit}` (`before` → server BadRequest; `order`/`cursor` are
 * dropped) and returns the fields envelope `{data: Array<{info, parts}>}` on
 * success or `{error, ...}` on failure. The server returns the newest `limit`
 * messages ascending; `limit: 0` (or omitted) returns the entire session.
 *
 * - error envelopes THROW (the service turns that into an incomplete result),
 * - a full page (>= limit) is verified with an unlimited `limit: 0` request;
 *   if that yields more messages they replace the page, if it fails the page
 *   is marked `truncated` (never silently treated as the full total),
 * - the v2 cursor envelope `{data, cursor.next}` is still normalized for
 *   newer SDKs.
 */
export async function fetchSessionMessagesPage(
  client: SessionMessagesClientLike,
  params: { sessionID: string; limit: number; cursor?: string },
): Promise<SessionMessagesPage> {
  const result = (await client.session.messages({
    sessionID: params.sessionID,
    limit: params.limit,
    ...(params.cursor ? { cursor: params.cursor } : {}),
  })) as unknown

  if (isErrorEnvelope(result)) {
    throw new Error(`session messages request failed: ${describeEnvelopeError(result.error)}`)
  }
  const unwrapped =
    result && typeof result === "object"
      ? ((result as Record<string, unknown>).data as unknown)
      : undefined

  // v2 projected cursor shape: { data: SessionMessage[], cursor: { next? } }
  if (unwrapped && typeof unwrapped === "object" && Array.isArray((unwrapped as Record<string, unknown>).data)) {
    const page = unwrapped as Record<string, unknown>
    const cursorObj =
      page.cursor && typeof page.cursor === "object"
        ? (page.cursor as Record<string, unknown>)
        : null
    const nextCursor =
      cursorObj && typeof cursorObj.next === "string" && cursorObj.next
        ? cursorObj.next
        : undefined
    return { messages: normalizeList(page.data as unknown[]), nextCursor }
  }

  // v1 bare array of { info: Message, parts: Part[] } / raw Message objects
  if (Array.isArray(unwrapped)) {
    const messages = normalizeList(unwrapped)
    if (params.limit > 0 && unwrapped.length >= params.limit) {
      // Possible truncation: verify with an unlimited request (limit: 0).
      try {
        const verify = (await client.session.messages({
          sessionID: params.sessionID,
          limit: 0,
        })) as unknown
        if (!isErrorEnvelope(verify)) {
          const verifyData =
            verify && typeof verify === "object"
              ? ((verify as Record<string, unknown>).data as unknown)
              : undefined
          if (Array.isArray(verifyData) && verifyData.length > unwrapped.length) {
            return { messages: normalizeList(verifyData) }
          }
          // Session really has exactly `limit` messages → complete.
          return { messages }
        }
      } catch {
        // verification failed → keep the page but mark truncation
      }
      return { messages, truncated: true }
    }
    return { messages }
  }
  if (Array.isArray(result)) {
    return { messages: normalizeList(result as unknown[]) }
  }
  return { messages: [] }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export function aggregateSessionCost(
  messages: NormalizedMessage[],
  snapshot: PricingSnapshot,
): { usd: number; hasUsage: boolean; partial: boolean; tokens: TokenBuckets; messageCount: number } {
  let usd = 0
  let hasUsage = false
  let partial = false
  let messageCount = 0
  let totalTokens = emptyTokenBuckets()
  const resolutionCache = new Map<string, ReturnType<typeof resolvePricingKey>>()
  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    const tokens = msg.tokens
    if (!hasTokenUsage(tokens)) continue
    totalTokens = addTokenBuckets(totalTokens, tokens)
    hasUsage = true
    messageCount += 1
    const cacheKey = `${msg.providerID ?? ""}|||${msg.modelID ?? ""}`
    let mapping = resolutionCache.get(cacheKey)
    if (!mapping) {
      mapping = resolvePricingKey(snapshot, {
        providerID: msg.providerID,
        modelID: msg.modelID,
      })
      resolutionCache.set(cacheKey, mapping)
    }
    if (!mapping.ok) {
      partial = true
      continue
    }
    const cost = lookupCost(snapshot, mapping.key.provider, mapping.key.model)
    if (!cost) {
      partial = true
      continue
    }
    usd += calculateUsdFromTokenBuckets(cost, tokens)
  }
  return { usd, hasUsage, partial, tokens: totalTokens, messageCount }
}

// ---------------------------------------------------------------------------
// Usage report mapping (v6 engine → card result shape)
// ---------------------------------------------------------------------------

/**
 * Map one server Cost onto the client result shape. No repricing happens
 * here: the amounts were computed by the v6 engine with its own model/price
 * resolver, so the five token kinds, the unknown/partial marking and the
 * message count travel exactly as they were computed.
 */
export function sessionCostResultFromUsage(cost: SessionUsageCost): SessionCostResult {
  return {
    usd: cost.usd,
    complete: cost.complete,
    hasUsage: cost.hasUsage,
    partial: cost.partial,
    tokens: {
      input: cost.tokens.input,
      output: cost.tokens.output,
      reasoning: cost.tokens.reasoning,
      cache_read: cost.tokens.cache_read,
      cache_write: cost.tokens.cache_write,
    },
    messageCount: cost.messageCount,
    ...(cost.error ? { error: cost.error } : {}),
  }
}

/**
 * An answer that cannot be used: failed/unknown, never a fabricated zero or a
 * free total. The UI renders it as 加载失败, so a broken read can never be
 * mistaken for "this session has no usage".
 */
function unavailableUsageResult(reason: string): SessionCostResult {
  return {
    usd: 0,
    complete: false,
    hasUsage: false,
    partial: false,
    tokens: emptyTokenBuckets(),
    messageCount: 0,
    error: reason,
  }
}

// ---------------------------------------------------------------------------
// Report cache stamping (which answer is the newer one)
// ---------------------------------------------------------------------------

/**
 * Identity of one report's data point: `generatedAtMs` is the engine's data
 * time point, `pricingGeneration`/`pricingSelection` record the price
 * snapshot that priced it, and `token` is the local monotonic order of the
 * request that produced it.
 *
 * `pricingGeneration` is recorded identity, never a global clock: a rollback
 * inside one selection (bundled → older bundled, runtime → older runtime)
 * answers with a SMALLER generation while being the newer data, and
 * switching the selection back answers with another selection's numbering
 * altogether. Freshness is therefore the data time point first and the
 * request order second — never the generation number.
 */
type UsageReportStamp = {
  generatedAtMs: number
  pricingGeneration: number
  pricingSelection: SessionUsageReport["pricingSelection"]
  token: number
}

type UsageReportEntry = {
  report: SessionUsageReport
  stamp: UsageReportStamp
}

/** Stamp of one report's data point as produced by request `token`. */
function usageStampOf(report: SessionUsageReport, token: number): UsageReportStamp {
  return {
    generatedAtMs: report.generatedAtMs,
    pricingGeneration: report.pricingGeneration,
    pricingSelection: report.pricingSelection,
    token,
  }
}

/**
 * True when `candidate` is the newer data point and may replace `existing`.
 * Only the data time point and the request order are compared; the price
 * generation number is deliberately NOT, so a rollback inside one selection
 * or a switch back to an older selection is adopted as the newer data
 * instead of being mistaken for an older batch.
 */
function isNewerUsageStamp(candidate: UsageReportStamp, existing: UsageReportStamp): boolean {
  // 1. Data time point: an answer that read older data (a stale engine walk,
  //    an earlier round's late response) must never downgrade the cache,
  //    whatever prices it carries.
  if (candidate.generatedAtMs !== existing.generatedAtMs) {
    return candidate.generatedAtMs > existing.generatedAtMs
  }
  // 2. Same time point, different price selection: the identities differ, so
  //    they cannot be ordered by number — the later request wins.
  if (candidate.pricingSelection !== existing.pricingSelection) {
    return candidate.token > existing.token
  }
  // 3. Same time point and same selection: the later request is the newer
  //    delivery of that data point (a generation change inside one
  //    selection is not a clock either).
  return candidate.token >= existing.token
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

type Listener = () => void

/**
 * Target size of the bounded session caches ("wanted" sessions); the oldest
 * evictable entry is dropped once it is exceeded. Sessions with live
 * subscribers are never evicted, so actively displayed views add a soft
 * upper bound on top of this target (see `remember`).
 */
const MAX_TRACKED_SESSIONS = 64

export class SessionMetricsService {
  private readonly options: Required<Pick<SessionMetricsServiceOptions, "debounceMs" | "pageSize" | "maxPages">> &
    SessionMetricsServiceOptions
  /** The v6 usage engine behind the quota plugin's `sessionUsage` RPC. */
  private readonly fetchUsage: SessionUsageReportFetcher | undefined
  private results = new Map<string, SessionCostResult>()
  /**
   * Cached server usage reports, keyed by the session they were requested
   * for. Bounded and evicted exactly like `results` above, so the report a
   * summary reads can never outlive the cost it explains.
   */
  private usageReports = new Map<string, UsageReportEntry>()
  /**
   * Stamp of the priced own result cached per session. It shares the report
   * stamp, so a report and the own cost it explains are accepted or rejected
   * together, and an older root batch can never downgrade a fresher
   * single-session answer (own results are also pre-warmed from a report's
   * `bySession`, which has no report cache entry of its own).
   */
  private resultStamps = new Map<string, UsageReportStamp>()
  /**
   * Session pinned against cache eviction for the duration of one report
   * transaction (bySession pre-warm + own). A tree with more descendants
   * than the cache bound must not evict the very report it is writing.
   */
  private pinnedSession: string | undefined
  /** Monotonic token per usage request; orders same-time-point responses. */
  private usageRequestToken = 0
  private stale = new Set<string>()
  /** Pricing revision each cached result was computed with (invalidation). */
  private pricingRevisions = new Map<string, number>()
  private versions = new Map<string, number>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private pending = new Map<string, Promise<void>>()
  private wanted = new Map<string, number>()
  private listeners = new Map<string, Set<Listener>>()
  /** Sessions someone asked to refresh at least once (bounded, insertion order). */
  private tracked = new Set<string>()
  private disposed = false
  private paused = false

  constructor(options: SessionMetricsServiceOptions) {
    this.options = {
      debounceMs: options.debounceMs ?? 120,
      // The 1.18.12 server honors an explicit limit (min(limit, total)) and an
      // omitted/0 limit returns the whole session. 10000 keeps single-request
      // totals for realistic sessions; a full page triggers the limit:0
      // verification in the fetcher.
      pageSize: options.pageSize ?? 10000,
      maxPages: options.maxPages ?? 30,
      ...options,
    }
    this.fetchUsage = options.fetchUsage
  }

  /** Latest completed aggregation for a session (undefined if never computed). */
  get(sessionID: string): SessionCostResult | undefined {
    return this.results.get(sessionID)
  }

  /**
   * The cached server report for a session — the report obtained by
   * requesting THAT session, metadata (data time point, price generation and
   * selection) included. A report requested for an ancestor is never
   * substituted for it: the ancestor's `bySession` entry is another scope's
   * view, and letting a root batch cover the subtree would put two different
   * data time points behind one card. Undefined until that session itself
   * has been read successfully at least once.
   */
  getUsageReport(sessionID: string): SessionUsageReport | undefined {
    return this.usageReports.get(sessionID)?.report
  }

  /** A newer refresh failed while the last complete result was retained. */
  isStale(sessionID: string): boolean {
    return this.stale.has(sessionID)
  }

  /** Sessions that were refreshed at least once (desensitized diagnostics). */
  trackedSessions(): readonly string[] {
    return [...this.tracked]
  }

  /** Number of cached per-session results (desensitized diagnostics). */
  cachedSessions(): number {
    return this.results.size
  }

  /**
   * Drop pending debounced refreshes while keeping cached results and
   * subscriber lists. Used when the last consumer of the shared runtime left:
   * nobody is looking, so no pagination should run.
   */
  pause(): void {
    this.paused = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.wanted.clear()
    for (const id of this.pending.keys()) this.versions.set(id, (this.versions.get(id) ?? 0) + 1)
  }

  /**
   * Resume refreshing after `pause()`: re-request every tracked session so a
   * returning consumer does not stare at data that stopped updating.
   */
  resume(): void {
    if (this.disposed) return
    this.paused = false
    for (const sessionID of this.tracked) this.refresh(sessionID, { delayMs: 0 })
  }

  /** Register a listener invoked whenever the session's result changes. */
  subscribe(sessionID: string, listener: Listener): () => void {
    let set = this.listeners.get(sessionID)
    if (!set) {
      set = new Set()
      this.listeners.set(sessionID, set)
    }
    set.add(listener)
    return () => {
      set?.delete(listener)
      if (set && set.size === 0) this.listeners.delete(sessionID)
    }
  }

  /**
   * Request a refresh for a session. Debounced; merges in-flight runs; guarded
   * by a version counter so stale results never overwrite newer ones.
   */
  refresh(sessionID: string, opts?: { delayMs?: number; force?: boolean }): void {
    if (this.disposed || !sessionID) return
    this.track(sessionID)
    if (this.paused) return
    const version = (this.versions.get(sessionID) ?? 0) + 1
    this.versions.set(sessionID, version)
    const existingTimer = this.timers.get(sessionID)
    if (existingTimer) clearTimeout(existingTimer)
    const delayMs = opts?.delayMs ?? this.options.debounceMs
    const timer = setTimeout(() => {
      this.timers.delete(sessionID)
      void this.scheduleRun(sessionID, version, opts?.force === true)
    }, delayMs)
    this.timers.set(sessionID, timer)
  }

  /**
   * Re-read every known session after a pricing change: the cached amounts
   * were priced with the previous snapshot, so every known session is marked
   * stale and notified, then re-requested through the EXISTING debounced
   * path (`force` only re-reads the local pricing RPC cache — downloading
   * stays the quota plugin's exclusive job). No new timer or scheduler is
   * introduced; disposed/paused follow the existing guards.
   */
  refreshForPricingChange(): void {
    if (this.disposed || this.paused) return
    // Union of the session-keyed caches (each bounded on its own, so the
    // union is bounded by construction).
    const sessionIDs = new Set<string>([
      ...this.tracked,
      ...this.results.keys(),
      ...this.usageReports.keys(),
    ])
    for (const sessionID of sessionIDs) {
      this.stale.add(sessionID)
      this.notify(sessionID)
    }
    for (const sessionID of sessionIDs) {
      this.refresh(sessionID, { force: true, delayMs: 0 })
    }
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.listeners.clear()
    this.results.clear()
    this.usageReports.clear()
    this.resultStamps.clear()
    this.stale.clear()
    this.pricingRevisions.clear()
    this.versions.clear()
    this.wanted.clear()
    this.tracked.clear()
    this.pending.clear()
  }

  /** Remember a wanted session with a bounded, insertion-ordered set. */
  private track(sessionID: string): void {
    if (this.tracked.has(sessionID)) return
    if (this.tracked.size >= MAX_TRACKED_SESSIONS) {
      const oldest = this.tracked.values().next().value
      if (oldest !== undefined) this.tracked.delete(oldest)
    }
    this.tracked.add(sessionID)
  }

  /**
   * Bounded, insertion-ordered cache write: a re-write refreshes the entry's
   * position and the oldest entry is evicted once the bound is exceeded. All
   * session-keyed caches share one bound and are evicted TOGETHER, so a
   * report can never outlive the own result it explains (or the other way
   * round) and no scope ends up with a report and an own result from
   * different data points.
   *
   * Three keys are never evicted here: the one just written (it is the newest
   * entry anyway), the session pinned by an in-progress report transaction
   * (whose report/own are being committed right now), and any session with
   * live subscribers — a view currently displaying that session's report.
   * The bound is therefore the target for the INACTIVE cache; the active
   * views themselves form a soft upper bound on top of it. When the actively
   * displayed sessions alone exceed the target, nothing is evicted rather
   * than deleting a result the user is reading right now (the entry leaves
   * naturally on unmount, when its subscription goes away and a later cache
   * write reclaims the slot).
   */
  private remember<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key)
    map.set(key, value)
    if (map.size <= MAX_TRACKED_SESSIONS) return
    // Evict the OLDEST evictable entry, skipping the just-written key, the
    // pinned session and actively subscribed sessions. Scanning instead of
    // taking the first key keeps the bound exact for the inactive cache: if
    // every entry is protected the scan finds nothing to drop and the map
    // temporarily stays above the target — a deliberate trade that keeps a
    // displayed report on screen over enforcing the hard cap.
    for (const candidate of map.keys()) {
      if (candidate === key || candidate === this.pinnedSession) continue
      if ((this.listeners.get(candidate)?.size ?? 0) > 0) continue
      this.forgetCachedSession(candidate)
      return
    }
  }

  /** Drop every trace of one session from the bounded caches. */
  private forgetCachedSession(sessionID: string): void {
    this.results.delete(sessionID)
    this.usageReports.delete(sessionID)
    this.resultStamps.delete(sessionID)
    this.stale.delete(sessionID)
    this.pricingRevisions.delete(sessionID)
  }

  /** Notify a session's listeners; listener errors never propagate. */
  private notify(sessionID: string): void {
    this.listeners.get(sessionID)?.forEach((listener) => {
      try { listener() } catch { /* listener errors never propagate */ }
    })
  }

  /**
   * True when `stamp` is not newer than what is already cached for this
   * session. Both caches are consulted, because an own result may have been
   * pre-warmed by an ancestor's report (no report entry of its own) while a
   * report may have been cached by an earlier round.
   */
  private isStaleAnswer(sessionID: string, stamp: UsageReportStamp): boolean {
    const report = this.usageReports.get(sessionID)
    if (report && !isNewerUsageStamp(stamp, report.stamp)) return true
    const own = this.resultStamps.get(sessionID)
    if (own && !isNewerUsageStamp(stamp, own)) return true
    return false
  }

  /**
   * Cache one successful report under the session it was requested for.
   * Returns false when the answer is not the newer data point — an older
   * data time or an earlier round's late response — in which case NEITHER
   * cache may be touched, so the cached report, the own result it explains
   * and the stale flag all stay as they are.
   */
  private storeUsageReport(
    sessionID: string,
    report: SessionUsageReport,
    stamp: UsageReportStamp,
  ): boolean {
    if (this.disposed || !sessionID) return false
    if (this.isStaleAnswer(sessionID, stamp)) return false
    this.remember(this.usageReports, sessionID, { report, stamp })
    return true
  }

  /**
   * Cache one session's own priced result (its own messages, subagents left
   * out) — used to pre-warm the sessions of a report's `bySession`. Guarded
   * by the same stamp, so an older root batch never downgrades a fresher
   * single-session answer, and a single session's older answer never
   * downgrades what is cached. No report is registered here: a report only
   * ever exists for the session it was requested for.
   */
  private storeOwnResult(
    sessionID: string,
    result: SessionCostResult,
    stamp: UsageReportStamp,
    pricingRevision: number,
  ): void {
    if (this.disposed || !sessionID) return
    const existing = this.resultStamps.get(sessionID)
    if (existing && !isNewerUsageStamp(stamp, existing)) return
    this.remember(this.resultStamps, sessionID, stamp)
    this.remember(this.results, sessionID, result)
    this.pricingRevisions.set(sessionID, pricingRevision)
    if (result.complete) this.stale.delete(sessionID)
    this.notify(sessionID)
  }

  private scheduleRun(
    sessionID: string,
    version: number,
    force: boolean,
  ): Promise<void> {
    const existing = this.pending.get(sessionID)
    if (existing) {
      const wanted = this.wanted.get(sessionID) ?? version
      this.wanted.set(sessionID, Math.max(wanted, version))
      return existing
    }
    const run = this.doRun(sessionID, version, force).finally(() => {
      this.pending.delete(sessionID)
      if (this.disposed) return
      const next = this.wanted.get(sessionID)
      if (next !== undefined && next > version) {
        this.wanted.delete(sessionID)
        void this.scheduleRun(sessionID, next, false)
      }
    })
    this.pending.set(sessionID, run)
    return run
  }

  private async doRun(sessionID: string, version: number, force: boolean): Promise<void> {
    // Pricing revision paired with the snapshot used for this aggregation;
    // assigned right after the pricing sync below.
    let pricingRevision = 0
    /** Stamp of the report behind this round's numbers (set once it arrived). */
    let resultStamp: UsageReportStamp | undefined
    const storeResult = (result: SessionCostResult, computed: boolean): void => {
      if (this.disposed || this.paused || this.versions.get(sessionID) !== version) return
      // A pricing change invalidates the cached amounts: a freshly computed
      // result must land even when it is less complete than the previous one
      // (prices moved under it). Unexpected failures keep the old protection.
      const previousRevision = this.pricingRevisions.get(sessionID)
      const pricingChanged =
        computed && previousRevision !== undefined && previousRevision !== pricingRevision
      // Never overwrite the last COMPLETE result with a fresher incomplete one:
      // the UI keeps showing the most recent fully aggregated value.
      const existing = this.results.get(sessionID)
      if (existing?.complete && !result.complete && !pricingChanged) {
        this.stale.add(sessionID)
        this.notify(sessionID)
        return
      }
      if (result.complete) this.stale.delete(sessionID)
      this.remember(this.results, sessionID, result)
      if (computed) {
        this.pricingRevisions.set(sessionID, pricingRevision)
        // The own result and the report it came from share ONE stamp, so a
        // later batch judges both by the same data point.
        if (resultStamp) this.remember(this.resultStamps, sessionID, resultStamp)
      }
      this.notify(sessionID)
    }

    try {
      const pricing = this.options.pricing ?? defaultPricingAdapter
      // Sync pricing from the bound RPC source before EVERY aggregation:
      // price/meta/selection changes must invalidate cached amounts instead
      // of reusing prices synced once at init. `force` only re-reads the
      // local RPC cache — downloading stays the quota plugin's exclusive job.
      try {
        const outcome = await pricing.refresh({ force })
        if (isStalePricingOutcome(outcome)) this.stale.add(sessionID)
      } catch { /* keep the last snapshot */ }
      // The snapshot itself is the engine's job now: this side only needs the
      // revision the report will have been priced with.
      pricingRevision = getPricingRevision()

      const fetchUsage = this.fetchUsage
      if (!fetchUsage) {
        // No engine bound: stay unknown/failed instead of running a second,
        // look-alike aggregation next to the v6 usage engine.
        storeResult(unavailableUsageResult("用量引擎不可用"), false)
        return
      }
      if (this.disposed || this.paused || this.versions.get(sessionID) !== version) return
      // One monotonic token per request. The queue above already keeps two
      // rounds for one session from overlapping; the token additionally
      // orders responses that share a data time point, so a late answer of
      // an earlier round can never win the caches.
      const token = (this.usageRequestToken += 1)
      let report: SessionUsageReport | null
      try {
        report = await fetchUsage(sessionID)
      } catch {
        // Desensitized on purpose: server-side details stay server-side.
        storeResult(unavailableUsageResult("用量读取失败"), false)
        return
      }
      if (this.disposed || this.paused || this.versions.get(sessionID) !== version) return
      if (!report) {
        storeResult(unavailableUsageResult("用量报告不可用"), false)
        return
      }
      const stamp = usageStampOf(report, token)
      // The report lands only when it is the newer data point. An older
      // answer — a stale engine walk, an earlier round's late response —
      // touches NEITHER cache: the cached report stays, the own result it
      // explains is not overwritten and the stale flag is not cleared.
      if (!this.storeUsageReport(sessionID, report, stamp)) return
      resultStamp = stamp
      // One synchronous transaction: the report above, every bySession own
      // result, and this session's own. The requested session is PINNED
      // against eviction for its whole duration — a tree with more
      // descendants than the cache bound would otherwise evict the very
      // report being written (the root's older entry is usually the oldest
      // one), and the final own write cannot restore a report.
      this.pinnedSession = sessionID
      try {
        // Pre-warm every other session's own cost from this same report, so
        // a card for a session nobody requested directly still shows the
        // engine's number. `resultStamps` keeps an older batch from
        // downgrading a fresher single-session answer.
        for (const [childID, cost] of Object.entries(report.bySession)) {
          if (childID === sessionID) continue
          this.storeOwnResult(childID, sessionCostResultFromUsage(cost), stamp, pricingRevision)
        }
        storeResult(sessionCostResultFromUsage(report.own), true)
      } finally {
        this.pinnedSession = undefined
      }
    } catch (err) {
      // Defensive: a completely unexpected failure must never throw to the UI.
      storeResult({
        usd: 0,
        complete: false,
        hasUsage: false,
        partial: false,
        tokens: emptyTokenBuckets(),
        messageCount: 0,
        error: err instanceof Error ? err.message : String(err),
      }, false)
    }
  }
}

const defaultPricingAdapter: PricingAdapter = {
  snapshot(): PricingSnapshot {
    return ensureLoaded()
  },
  async refresh(opts?: { force?: boolean }): Promise<unknown> {
    return maybeRefreshPricingSnapshot({ force: opts?.force === true })
  },
}

/** Convenience: build the real page fetcher from a client-like object. */
export function createClientPageFetcher(
  client: SessionMessagesClientLike,
): SessionMessagesPageFetcher {
  return (params) => fetchSessionMessagesPage(client, params)
}
