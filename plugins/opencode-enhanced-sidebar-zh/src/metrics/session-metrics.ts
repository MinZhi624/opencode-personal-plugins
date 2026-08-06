/**
 * Per-session cost aggregation backed by the client API.
 *
 * Source of truth: `api.client.session.messages()`. `api.state.session.messages()`
 * (the TUI's ~100 message window) is NEVER used as the cost total.
 *
 * Runtime facts verified against opencode 1.18.12 (probe plugin + live server):
 * - the client only forwards `{sessionID, limit}`; `before` is REJECTED by the
 *   server (BadRequest) and `order`/`cursor` are silently dropped,
 * - the response envelope is `{data: Array<{info, parts}>, request, response}`
 *   on success and `{error, request, response}` on failure,
 * - the server returns the newest `limit` messages in ascending order, and an
 *   omitted or `0` limit returns the ENTIRE session (verified up to 12150
 *   messages).
 *
 * Strategy:
 * - primary request uses an explicit large page (default 10000);
 * - when the page is exactly full (possible truncation) a verification request
 *   with `limit: 0` (unlimited) is issued: if it yields more messages they are
 *   used and the result stays complete; if it fails the result is marked
 *   incomplete instead of silently reporting a truncated total;
 * - the v2 cursor envelope `{data, cursor.next}` is handled defensively for
 *   newer SDKs, walking pages up to `maxPages` and marking truncation;
 * - per-session debounce, in-flight merging, and version guards so a stale
 *   async result can never overwrite a newer one;
 * - fetch failures never throw: they produce an incomplete result that never
 *   overwrites the last complete one, and the UI may choose not to render it.
 */

import { calculateUsdFromTokenBuckets } from "./token-cost.ts"
import { emptyTokenBuckets, hasTokenUsage, type TokenBuckets } from "./token-buckets.ts"
import {
  ensureLoaded,
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

export interface PricingAdapter {
  snapshot(): PricingSnapshot
  refresh(opts?: { force?: boolean }): Promise<unknown>
}

export interface SessionMetricsServiceOptions {
  fetchPage: SessionMessagesPageFetcher
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
): { usd: number; hasUsage: boolean; partial: boolean; messageCount: number } {
  let usd = 0
  let hasUsage = false
  let partial = false
  let messageCount = 0
  const resolutionCache = new Map<string, ReturnType<typeof resolvePricingKey>>()
  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    const tokens = msg.tokens
    if (!hasTokenUsage(tokens)) continue
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
  return { usd, hasUsage, partial, messageCount }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

type Listener = () => void

export class SessionMetricsService {
  private readonly options: Required<Pick<SessionMetricsServiceOptions, "debounceMs" | "pageSize" | "maxPages">> &
    SessionMetricsServiceOptions
  private results = new Map<string, SessionCostResult>()
  private versions = new Map<string, number>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private pending = new Map<string, Promise<void>>()
  private wanted = new Map<string, number>()
  private listeners = new Map<string, Set<Listener>>()
  private disposed = false

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
  }

  /** Latest completed aggregation for a session (undefined if never computed). */
  get(sessionID: string): SessionCostResult | undefined {
    return this.results.get(sessionID)
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

  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.listeners.clear()
    this.results.clear()
    this.versions.clear()
    this.wanted.clear()
    this.pending.clear()
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
    const storeResult = (result: SessionCostResult): void => {
      // Never overwrite the last COMPLETE result with a fresher incomplete one:
      // the UI keeps showing the most recent fully aggregated value.
      const existing = this.results.get(sessionID)
      if (existing?.complete && !result.complete) return
      // Only store when this run is still the latest requested version.
      if (this.versions.get(sessionID) !== version) return
      this.results.set(sessionID, result)
      this.listeners.get(sessionID)?.forEach((listener) => {
        try { listener() } catch { /* listener errors never propagate */ }
      })
    }

    try {
      const pricing = this.options.pricing ?? defaultPricingAdapter
      if (force) {
        try { await pricing.refresh({ force: true }) } catch { /* keep snapshot */ }
      }
      const snapshot = pricing.snapshot()
      const seen = new Set<string>()
      const collected: NormalizedMessage[] = []
      let cursor: string | undefined
      let pageCount = 0
      let error: string | undefined
      let truncated = false
      while (true) {
        try {
          const page = await this.options.fetchPage({
            sessionID,
            limit: this.options.pageSize,
            cursor,
          })
          for (const msg of page.messages) {
            if (seen.has(msg.id)) continue
            seen.add(msg.id)
            collected.push(msg)
          }
          if (page.nextCursor) {
            pageCount += 1
            if (pageCount >= this.options.maxPages) {
              // more pages exist but the walk is capped → NOT the full total
              truncated = true
              break
            }
            cursor = page.nextCursor
            continue
          }
          if (page.truncated === true) truncated = true
          break
        } catch (err) {
          error = err instanceof Error ? err.message : String(err)
          break
        }
      }
      const aggregate = aggregateSessionCost(collected, snapshot)
      const result: SessionCostResult = {
        usd: aggregate.usd,
        complete: error === undefined && !truncated,
        hasUsage: aggregate.hasUsage,
        partial: aggregate.partial,
        messageCount: aggregate.messageCount,
        ...(error ? { error } : truncated ? { error: "truncated" } : {}),
      }
      storeResult(result)
    } catch (err) {
      // Defensive: a completely unexpected failure must never throw to the UI.
      storeResult({
        usd: 0,
        complete: false,
        hasUsage: false,
        partial: false,
        messageCount: 0,
        error: err instanceof Error ? err.message : String(err),
      })
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
