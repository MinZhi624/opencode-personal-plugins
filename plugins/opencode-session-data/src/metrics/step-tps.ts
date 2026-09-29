/**
 * Real-time per-step TPS tracking from `message.part.updated` events.
 *
 * Facts this module relies on (see FOREMAN_HANDOFF / MiMo-Code study):
 * - `step-start` / `step-finish` parts carry NO persisted timestamps; only the
 *   live event boundary is valid (`event.properties.time`, or Date.now()).
 * - The two parts do NOT share an id; pairing is by (sessionID, messageID)
 *   FIFO: a finish pairs with the oldest unclosed start of the same message.
 * - Never fall back to assistant `time.created → time.completed` or to
 *   historical parts; without a fully observed start→finish pair the metric is
 *   unavailable.
 *
 * Defensive handling:
 * - duplicate start/finish part ids are ignored,
 * - finish without a pending start (missed start / out-of-order) is dropped,
 * - zero/negative duration steps are discarded,
 * - events from different sessions/messages never interfere,
 * - only the most recently completed valid step per session is retained.
 */

export type StepTpsResult = {
  /** tokens per second = (output + reasoning) / durationSeconds */
  tps: number
  /** event time of the step-finish (ms) */
  at: number
  /** step duration in seconds */
  durationSeconds: number
  /** output + reasoning tokens of the step */
  tokens: number
}

export type StreamingTpsResult = {
  tps: number
  startedAt: number
  estimatedTokens: number
}

export interface StepPartLike {
  id?: unknown
  sessionID?: unknown
  messageID?: unknown
  type?: unknown
  tokens?: {
    output?: unknown
    reasoning?: unknown
  } | null
}

type Listener = () => void

type PendingStep = {
  startedAt: number
  text: string
  reasoning: string
}

/** Max unclosed step-start entries kept per (sessionID, messageID) key. */
const MAX_PENDING_STARTS_PER_KEY = 64
/** Max tracked (sessionID, messageID) keys before eviction kicks in. */
const MAX_TRACKED_KEYS = 2048
/** Idle time after which a key's pending state is dropped (defensive bound). */
const KEY_IDLE_TTL_MS = 60 * 60 * 1000

export class StepTpsTracker {
  /** Per (sessionID,messageID): FIFO queue of unclosed step-start event times. */
  private readonly starts = new Map<string, PendingStep[]>()
  /** Last seen start part id per key (duplicate guard). */
  private readonly lastStartPartId = new Map<string, string>()
  /** Last seen finish part id per key (duplicate guard). */
  private readonly lastFinishPartId = new Map<string, string>()
  /** Last event time per key (for idle eviction). */
  private readonly lastEventAt = new Map<string, number>()
  /** Latest completed step per session. */
  private readonly latestBySession = new Map<string, StepTpsResult>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private nowFn: () => number

  constructor(nowFn: () => number = () => Date.now()) {
    this.nowFn = nowFn
  }

  /**
   * Bounded cleanup for unclosed starts: per-key FIFO cap and global key
   * eviction (idle TTL, then insertion order). Only affects leaked/unclosed
   * state — a fully observed start→finish pair is never touched by these
   * bounds in normal operation.
   */
  private enforceBounds(key: string, at: number): void {
    let queue = this.starts.get(key)
    if (queue) {
      // FIFO cap: drop the oldest leaked starts
      while (queue.length > MAX_PENDING_STARTS_PER_KEY) queue.shift()
    }
    if (this.starts.size <= MAX_TRACKED_KEYS) return
    // Global key cap: evict idle keys first, then the oldest insertion.
    const cutoff = at - KEY_IDLE_TTL_MS
    for (const [k, last] of this.lastEventAt) {
      if (this.starts.size <= MAX_TRACKED_KEYS) break
      if (last < cutoff) {
        this.starts.delete(k)
        this.lastStartPartId.delete(k)
        this.lastFinishPartId.delete(k)
        this.lastEventAt.delete(k)
      }
    }
    for (const k of this.starts.keys()) {
      if (this.starts.size <= MAX_TRACKED_KEYS) break
      this.starts.delete(k)
      this.lastStartPartId.delete(k)
      this.lastFinishPartId.delete(k)
      this.lastEventAt.delete(k)
    }
  }

  private notify(sessionID: string): void {
    this.listeners.get(sessionID)?.forEach((listener) => {
      try { listener() } catch { /* listener errors never propagate */ }
    })
  }

  /** Handle one `message.part.updated` event. Never throws. */
  handlePartUpdated(
    sessionID: string | undefined,
    part: StepPartLike | undefined,
    eventTime?: number,
  ): void {
    if (!sessionID || !part || typeof part !== "object") return
    const type = part.type
    if (type !== "step-start" && type !== "step-finish") return
    const messageID = typeof part.messageID === "string" ? part.messageID : undefined
    if (!messageID) return
    const partID = typeof part.id === "string" ? part.id : undefined
    const at = typeof eventTime === "number" && Number.isFinite(eventTime) ? eventTime : this.nowFn()
    const key = `${sessionID}\u0000${messageID}`
    this.lastEventAt.set(key, at)
    this.enforceBounds(key, at)

    if (type === "step-start") {
      if (partID && this.lastStartPartId.get(key) === partID) return // duplicate
      if (partID) this.lastStartPartId.set(key, partID)
      const queue = this.starts.get(key)
      if (queue) queue.push({ startedAt: at, text: "", reasoning: "" })
      else this.starts.set(key, [{ startedAt: at, text: "", reasoning: "" }])
      this.notify(sessionID)
      return
    }

    // step-finish
    if (partID && this.lastFinishPartId.get(key) === partID) return // duplicate
    if (partID) this.lastFinishPartId.set(key, partID)

    const queue = this.starts.get(key)
    if (!queue || queue.length === 0) return // start not observed (missed/out-of-order)
    const step = queue.shift()!
    if (queue.length === 0) this.starts.delete(key)

    const durationMs = at - step.startedAt
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      this.notify(sessionID)
      return
    }

    const tokensRaw = part.tokens
    const output = typeof tokensRaw?.output === "number" ? tokensRaw.output : 0
    const reasoning = typeof tokensRaw?.reasoning === "number" ? tokensRaw.reasoning : 0
    const tokens = output + reasoning
    if (!Number.isFinite(tokens) || tokens <= 0) {
      this.notify(sessionID)
      return
    }

    const durationSeconds = durationMs / 1000
    const result: StepTpsResult = {
      tps: tokens / durationSeconds,
      at,
      durationSeconds,
      tokens,
    }
    this.latestBySession.set(sessionID, result)
    this.notify(sessionID)
  }

  /** Add a streamed text/reasoning delta to the newest active step for a message. */
  handlePartDelta(
    sessionID: string | undefined,
    messageID: string | undefined,
    field: string | undefined,
    delta: string | undefined,
  ): void {
    if (!sessionID || !messageID || !delta) return
    if (field !== "text" && field !== "reasoning") return
    const queue = this.starts.get(`${sessionID}\u0000${messageID}`)
    const step = queue?.[queue.length - 1]
    if (!step) return
    if (field === "text") step.text += delta
    else step.reasoning += delta
    this.notify(sessionID)
  }

  /** Current streaming estimate from the newest active step in a session. */
  streaming(sessionID: string, now: number = this.nowFn()): StreamingTpsResult | undefined {
    let current: PendingStep | undefined
    for (const [key, queue] of this.starts) {
      if (!key.startsWith(`${sessionID}\u0000`)) continue
      const candidate = queue[queue.length - 1]
      if (candidate && (!current || candidate.startedAt > current.startedAt)) current = candidate
    }
    if (!current) return undefined
    const elapsedSeconds = (now - current.startedAt) / 1000
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0.5) return undefined
    const estimatedTokens = estimateStreamingTokens(current.text + current.reasoning)
    if (estimatedTokens <= 0) return undefined
    return { tps: estimatedTokens / elapsedSeconds, startedAt: current.startedAt, estimatedTokens }
  }

  hasStreamingStep(sessionID: string): boolean {
    for (const key of this.starts.keys()) {
      if (key.startsWith(`${sessionID}\u0000`)) return true
    }
    return false
  }

  /** Drop incomplete steps after a session becomes idle or errors. */
  abortSession(sessionID: string | undefined): void {
    if (!sessionID) return
    let changed = false
    for (const key of this.starts.keys()) {
      if (!key.startsWith(`${sessionID}\u0000`)) continue
      this.starts.delete(key)
      this.lastStartPartId.delete(key)
      this.lastFinishPartId.delete(key)
      this.lastEventAt.delete(key)
      changed = true
    }
    if (changed) this.notify(sessionID)
  }

  /** Most recently completed valid step for a session. */
  latest(sessionID: string): StepTpsResult | undefined {
    return this.latestBySession.get(sessionID)
  }

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
}

/**
 * Format TPS in MiMo style: positive rates below one are shown as <1,
 * all other rates are rounded to an integer.
 * Returns null when unavailable.
 */
export function formatTps(tps: number): string | null {
  if (!Number.isFinite(tps) || tps <= 0) return null
  return tps < 1 ? "<1" : String(Math.round(tps))
}

/**
 * Lightweight streaming estimate. CJK characters are approximately one token
 * each; all other characters use MiMo's four characters per token heuristic.
 */
export function estimateStreamingTokens(text: string): number {
  const cjk = text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g)?.length ?? 0
  const other = text.length - cjk
  return Math.max(0, cjk + Math.round(other / 4))
}
