/**
 * Pricing snapshot management and model/provider resolution.
 *
 * Ported from @slkiser/opencode-quota (dist/lib/modelsdev-pricing.js and
 * dist/lib/quota-stats.js resolution helpers), MIT.
 * See LICENSES/opencode-quota.LICENSE.
 *
 * Responsibilities:
 * - Consume the quota plugin's read-only `pricing` RPC as the single pricing
 *   authority (bound per runtime host via `bindPricingSource`). The quota
 *   plugin owns the models.dev download (`QuotaRpc.downloadPrices`) and the
 *   selected snapshot; this module never reads or writes pricing files and
 *   never performs network fetches.
 * - Retain the last authoritative snapshot when a sync fails and flag it
 *   stale; before the first successful sync the store stays in the
 *   loading/unknown state (never zero/free, never a local-disk impostor).
 * - Track a snapshot revision so consumers can invalidate cached amounts
 *   when price/meta/selection changes.
 * - Resolve OpenCode provider/model ids to a pricing key
 *   (provider aliases: openai/codex/chatgpt/copilot, GPT/Claude/Gemini/Grok/GLM
 *   model inference, -free / -thinking / version aliases, unique-model lookup).
 *
 * Never reads OpenCode `session.cost` / `message.cost`.
 */

import { Rpc } from "@opencode/plugin"
import { homedir } from "node:os"
import { z } from "zod"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CostBuckets = {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  reasoning?: number
}

export type PricingSnapshot = {
  _meta: {
    source: string
    generatedAt: number
    providers: string[]
    units: string
  }
  providers: Record<string, Record<string, CostBuckets>>
}

export type PricingKey = { provider: string; model: string }

export type PricingResolution =
  | { ok: true; key: PricingKey; method: string }
  | {
      ok: false
      unknown: {
        sourceProviderID: string
        sourceModelID: string
        reason: string
        mappedModel?: string
        mappedProvider?: string
        normalizedModelID?: string
        providerCandidates?: string[]
      }
    }

export type RefreshState = {
  version: 1
  updatedAt: number
  lastAttemptAt?: number
  lastSuccessAt?: number
  lastFailureAt?: number
  lastResult?: string
  lastError?: string
  etag?: string
  lastModified?: string
}

export type RefreshOutcome = {
  attempted: boolean
  updated: boolean
  reason?: string
  error?: string
  /** True when a failed sync retained the previous authoritative snapshot. */
  stale?: boolean
  state: RefreshState
}

/**
 * Legacy options kept for signature compatibility. None of them trigger a
 * fetch, a disk read or a disk write anymore — pricing sync is a read of the
 * bound RPC source only.
 */
export interface PricingStoreOptions {
  bundledSnapshotOverride?: unknown
  runtimeDirs?: RuntimeDirs
  fetchFn?: typeof fetch
  nowMs?: number
  maxAgeMs?: number
  minAttemptIntervalMs?: number
  timeoutMs?: number
  providerAllowlist?: string[]
  force?: boolean
}

export type RuntimeDirs = { cacheDir: string }

/** Report returned by the quota plugin's read-only pricing RPC. */
export type PricingSourceReport = {
  snapshot: PricingSnapshot
  source: "runtime" | "bundled" | "empty"
  selection: "auto" | "bundled" | "runtime"
}

/** Reader bound by a runtime host; see `bindPricingSource`. */
export type PricingSourceReader = () => Promise<PricingSourceReport | null>

// ---------------------------------------------------------------------------
// Portable RPC route (client-side caller only)
// ---------------------------------------------------------------------------

const pricingCostBucketsSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cache_read: z.number().optional(),
  cache_write: z.number().optional(),
  reasoning: z.number().optional(),
})

/**
 * Mirror of the quota plugin's `pricingChanged` event: the price list in use
 * changed for real (another snapshot object, source or selection), carrying
 * the same `generatedAt` and `selection` the `pricing` route answers with.
 * Declaring the schema here lets a runtime host `events.on("pricingChanged",
 * ...)` later and invalidate the costs it already displayed. This module only
 * declares the event: it listens to nothing and binds nothing.
 */
const pricingChangedSchema = z.object({
  generatedAt: z.number(),
  selection: z.enum(["auto", "bundled", "runtime"]),
})

/**
 * Portable mirror of the quota plugin's `pricing` RPC route. It uses the
 * same `id` ("opencode-quota-zh") and method name as the quota plugin's
 * `quotaRpc`, so `client.rpc(pricingSourceRpc).pricing({})` addresses the
 * quota plugin's handler without importing its (possibly unbuilt) dist.
 * The quota plugin stays the only writer of pricing data; this definition
 * exists purely as a typed read-only client caller.
 */
export const pricingSourceRpc = Rpc.define({
  id: "opencode-quota-zh",
  methods: {
    pricing: {
      input: z.object({}),
      output: z.object({
        snapshot: z.object({
          _meta: z.object({
            source: z.string(),
            generatedAt: z.number(),
            providers: z.array(z.string()),
            units: z.string(),
          }),
          providers: z.record(z.string(), z.record(z.string(), pricingCostBucketsSchema)),
        }),
        source: z.enum(["runtime", "bundled", "empty"]),
        selection: z.enum(["auto", "bundled", "runtime"]),
      }),
    },
  },
  events: {
    pricingChanged: { schema: pricingChangedSchema },
  },
})

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COST_KEYS = ["input", "output", "cache_read", "cache_write", "reasoning"] as const
// Namespace/filenames kept only so the path helpers below stay compatible
// for diagnostics; this module never reads or writes those files itself.
const RUNTIME_NAMESPACE = "opencode-quota-zh"
const RUNTIME_SNAPSHOT_FILENAME = "modelsdev-pricing.runtime.min.json"
const RUNTIME_REFRESH_STATE_FILENAME = "modelsdev-pricing.refresh-state.json"
const MS_PER_DAY = 24 * 60 * 60 * 1000
export const DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS = 3 * MS_PER_DAY

/**
 * Loading placeholder: no prices synced yet. Lookups against it resolve to
 * unknown (partial), never to zero/free; `_meta.source` advertises loading.
 */
const LOADING_SNAPSHOT: PricingSnapshot = {
  _meta: {
    source: "loading",
    generatedAt: 0,
    providers: [],
    units: "USD per 1M tokens",
  },
  providers: {},
}

// ---------------------------------------------------------------------------
// Snapshot loading / normalization
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null
}

function sortRecordByKeys<T>(obj: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const key of Object.keys(obj).sort((a, b) => a.localeCompare(b))) {
    out[key] = obj[key]
  }
  return out
}

export function normalizeSnapshot(raw: unknown): PricingSnapshot | null {
  const root = asRecord(raw)
  if (!root) return null
  const metaRaw = asRecord(root._meta)
  const providersRaw = asRecord(root.providers)
  if (!metaRaw || !providersRaw) return null
  const generatedAt = Number(metaRaw.generatedAt)
  if (!Number.isFinite(generatedAt) || generatedAt <= 0) return null

  const providers: Record<string, Record<string, CostBuckets>> = {}
  for (const providerId of Object.keys(providersRaw)) {
    const modelsRaw = asRecord(providersRaw[providerId])
    if (!modelsRaw) continue
    const models: Record<string, CostBuckets> = {}
    for (const modelId of Object.keys(modelsRaw)) {
      const modelRaw = asRecord(modelsRaw[modelId])
      if (!modelRaw) continue
      const buckets: CostBuckets = {}
      const input = modelRaw.input
      const output = modelRaw.output
      const cacheRead = modelRaw.cache_read
      const cacheWrite = modelRaw.cache_write
      const reasoning = modelRaw.reasoning
      if (typeof input === "number" && Number.isFinite(input)) buckets.input = input
      if (typeof output === "number" && Number.isFinite(output)) buckets.output = output
      if (typeof cacheRead === "number" && Number.isFinite(cacheRead)) buckets.cache_read = cacheRead
      if (typeof cacheWrite === "number" && Number.isFinite(cacheWrite)) buckets.cache_write = cacheWrite
      if (typeof reasoning === "number" && Number.isFinite(reasoning)) buckets.reasoning = reasoning
      if (Object.keys(buckets).length > 0) models[modelId] = buckets
    }
    if (Object.keys(models).length > 0) providers[providerId] = sortRecordByKeys(models)
  }

  return {
    _meta: {
      source: typeof metaRaw.source === "string" && metaRaw.source ? metaRaw.source : "models.dev",
      generatedAt: Math.trunc(generatedAt),
      providers: Object.keys(providers).sort((a, b) => a.localeCompare(b)),
      units:
        typeof metaRaw.units === "string" && metaRaw.units
          ? metaRaw.units
          : "USD per 1M tokens",
    },
    providers: sortRecordByKeys(providers),
  }
}

/** Resolve the bundled snapshot URL relative to this module (src/metrics → src/data). */
export function bundledSnapshotUrl(): URL {
  return new URL("../data/modelsdev-pricing.min.json", import.meta.url)
}

/**
 * Compatibility shim: the bundled snapshot is no longer read from local disk —
 * pricing authority comes from the bound RPC source only. An explicit
 * `override` (test injection) is still normalized; without one the loading
 * placeholder is returned so callers see unknown prices, never fabricated
 * or free ones.
 */
export function loadBundledSnapshotSync(
  override?: unknown,
  // Accepted for signature compatibility; local disk is never read.
  _readFileSyncFn?: (url: URL) => string,
): PricingSnapshot {
  if (override !== undefined) return normalizeSnapshot(override) ?? LOADING_SNAPSHOT
  return LOADING_SNAPSHOT
}

// ---------------------------------------------------------------------------
// Runtime dirs (path helpers only; no file access)
// ---------------------------------------------------------------------------

export function getOpencodeRuntimeDirs(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): RuntimeDirs {
  const cacheBase = env.XDG_CACHE_HOME?.trim() || join(home, ".cache")
  return { cacheDir: join(cacheBase, "opencode") }
}

export function getRuntimePricingSnapshotPath(runtimeDirs: RuntimeDirs): string {
  return join(runtimeDirs.cacheDir, RUNTIME_NAMESPACE, RUNTIME_SNAPSHOT_FILENAME)
}

export function getRuntimePricingRefreshStatePath(runtimeDirs: RuntimeDirs): string {
  return join(runtimeDirs.cacheDir, RUNTIME_NAMESPACE, RUNTIME_REFRESH_STATE_FILENAME)
}

/**
 * Compatibility shim: the shared runtime snapshot is consumed through the
 * quota plugin's pricing RPC, never read from disk here. Always null.
 */
export function loadRuntimeSnapshotSync(_runtimeDirs: RuntimeDirs): PricingSnapshot | null {
  return null
}

export function hasSnapshotData(snapshot: PricingSnapshot): boolean {
  return snapshot._meta.generatedAt > 0
}

// ---------------------------------------------------------------------------
// Store (RPC-backed, generation-safe binding)
// ---------------------------------------------------------------------------

interface PricingStoreInternal {
  snapshot: PricingSnapshot | null
  source: "bundled" | "runtime" | "empty"
  /** True when the retained snapshot predates a failed sync. */
  stale: boolean
  /** Bumped whenever the applied snapshot/source changes. */
  revision: number
  reader: PricingSourceReader | null
  /** Identity of the active binding; dispose only unbinds its own token. */
  readerToken: object | null
  refreshInFlight: Promise<RefreshOutcome> | null
}

let STORE: PricingStoreInternal | null = null

function getStore(): PricingStoreInternal {
  if (!STORE) {
    STORE = {
      snapshot: null,
      source: "empty",
      stale: false,
      revision: 0,
      reader: null,
      readerToken: null,
      refreshInFlight: null,
    }
  }
  return STORE
}

/**
 * Bind the RPC reader that provides pricing authority for this host.
 *
 * The reader must be read-only (the quota plugin's pricing RPC): downloads
 * stay `QuotaRpc.downloadPrices`' exclusive job. The returned disposer is
 * generation-safe — it only unbinds while its own binding is still active,
 * so a torn-down runtime never steals a newer host's binding (hot-reload
 * generations, several runtimes sharing this module).
 */
export function bindPricingSource(reader: PricingSourceReader): () => void {
  const store = getStore()
  const token = {}
  store.reader = reader
  store.readerToken = token
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    if (store.readerToken === token) {
      store.reader = null
      store.readerToken = null
    }
  }
}

/** Revision of the currently applied pricing snapshot (0 before first sync). */
export function getPricingRevision(): number {
  return getStore().revision
}

/**
 * Compatibility shim for the old disk-selection entry point: pricing now
 * comes exclusively from the bound RPC source. An explicit
 * `bundledSnapshotOverride` (test injection) is still honored as a bundled
 * fallback while no RPC snapshot has been synced; local disk is never read.
 */
export function applySnapshotSelection(opts: {
  runtimeDirs?: RuntimeDirs
  bundledSnapshotOverride?: unknown
} = {}): PricingSnapshot {
  return ensureLoaded(opts)
}

export function ensureLoaded(opts?: {
  bundledSnapshotOverride?: unknown
  runtimeDirs?: RuntimeDirs
}): PricingSnapshot {
  const store = getStore()
  if (store.snapshot) return store.snapshot
  if (opts?.bundledSnapshotOverride !== undefined) {
    const injected = normalizeSnapshot(opts.bundledSnapshotOverride)
    if (injected) {
      store.snapshot = injected
      store.source = "bundled"
      store.stale = false
      store.revision += 1
      return injected
    }
  }
  // No prices yet: loading/unknown — never zero/free.
  return LOADING_SNAPSHOT
}

export function getPricingSnapshotMeta(): PricingSnapshot["_meta"] {
  return ensureLoaded()._meta
}

export function getPricingSnapshotSource(): "bundled" | "runtime" | "empty" {
  return getStore().source
}

export function getPricingSnapshotHealth(opts?: {
  nowMs?: number
  maxAgeMs?: number
}): { generatedAt: number; ageMs: number; maxAgeMs: number; stale: boolean } {
  const store = getStore()
  const generatedAt = getPricingSnapshotMeta().generatedAt
  const nowMs = opts?.nowMs ?? Date.now()
  const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS
  const ageMs = Math.max(0, nowMs - generatedAt)
  // Stale = a retained snapshot that predates a failed sync, or aged out.
  // The never-synced loading state is NOT stale: it is unknown, not old.
  const stale = store.stale || (generatedAt > 0 && ageMs > maxAgeMs)
  return { generatedAt, ageMs, maxAgeMs, stale }
}

// ---------------------------------------------------------------------------
// Lookup helpers (snapshot-scoped)
// ---------------------------------------------------------------------------

export function hasProvider(snapshot: PricingSnapshot, providerId: string): boolean {
  return !!snapshot.providers[providerId]
}

export function hasModel(snapshot: PricingSnapshot, providerId: string, modelId: string): boolean {
  const p = snapshot.providers[providerId]
  if (!p) return false
  return !!p[modelId]
}

export function listProvidersForModelId(snapshot: PricingSnapshot, modelId: string): string[] {
  const providers: string[] = []
  for (const providerId of Object.keys(snapshot.providers)) {
    if (snapshot.providers[providerId]?.[modelId]) providers.push(providerId)
  }
  return providers.sort((a, b) => a.localeCompare(b))
}

export function lookupCost(
  snapshot: PricingSnapshot,
  providerId: string,
  modelId: string,
): CostBuckets | null {
  const p = snapshot.providers[providerId]
  if (!p) return null
  const c = p[modelId]
  if (!c) return null
  return c
}

// ---------------------------------------------------------------------------
// Model/provider resolution (ported from quota-stats.js)
// ---------------------------------------------------------------------------

export function normalizeModelId(raw: string): string {
  let s = raw.trim()
  if (s.toLowerCase().startsWith("antigravity-")) s = s.slice("antigravity-".length)
  s = s.replace(/(claude-[a-z-]+)-(\d+)\.(\d+)(?=$|[^0-9])/gi, "$1-$2-$3")
  s = s.replace(/\bglm-(\d+)\.(\d+)-free\b/i, "glm-$1.$2")
  if (s.toLowerCase() === "big-pickle") s = "glm-4.7"
  return s
}

function stripFreeSuffix(modelId: string): string | null {
  if (!modelId.toLowerCase().endsWith("-free")) return null
  const stripped = modelId.slice(0, -"-free".length)
  return stripped || null
}

function freeSuffixCandidates(modelId: string): string[] {
  const candidates = [modelId]
  const stripped = stripFreeSuffix(modelId)
  if (stripped) candidates.push(stripped)
  return candidates.filter((value, index, list) => list.indexOf(value) === index)
}

function pickBestModelForProvider(
  snapshot: PricingSnapshot,
  providerID: string,
  candidates: string[],
): string | null {
  for (const candidate of candidates) {
    if (lookupCost(snapshot, providerID, candidate)) return candidate
  }
  for (const candidate of candidates) {
    if (hasModel(snapshot, providerID, candidate)) return candidate
  }
  return null
}

function parseModelIdHint(rawModelId: string): { providerHint?: string; modelPart?: string } {
  if (!rawModelId || typeof rawModelId !== "string") return {}
  const trimmed = rawModelId.trim()
  if (!trimmed) return {}
  const lastSlash = trimmed.lastIndexOf("/")
  if (lastSlash === -1) return { modelPart: trimmed }
  if (lastSlash === trimmed.length - 1) return { providerHint: trimmed.slice(0, -1) }
  return { providerHint: trimmed.slice(0, lastSlash), modelPart: trimmed.slice(lastSlash + 1) }
}

const SOURCE_PROVIDER_ALIASES: Record<string, string> = {
  "github-copilot": "openai",
  "copilot-chat": "openai",
  chatgpt: "openai",
  codex: "openai",
  "zai-coding-plan": "zai",
  glm: "zai",
}

export function normalizeSourceProviderId(
  snapshot: PricingSnapshot,
  raw: string | undefined,
): string | undefined {
  if (!raw || typeof raw !== "string") return undefined
  const lowered = raw.trim().toLowerCase()
  if (!lowered || lowered === "unknown") return undefined
  const parts = lowered.split(/[/:]/g).filter(Boolean)
  const candidates = [lowered, ...parts].filter((v, i, arr) => arr.indexOf(v) === i)
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i]
    if (hasProvider(snapshot, candidate)) return candidate
    const alias = SOURCE_PROVIDER_ALIASES[candidate]
    if (alias && hasProvider(snapshot, alias)) return alias
  }
  const directAlias = SOURCE_PROVIDER_ALIASES[lowered]
  return directAlias ?? lowered
}

function inferOfficialProviderFromModelId(
  snapshot: PricingSnapshot,
  modelId: string,
): string | null {
  const providers = listProvidersForModelId(snapshot, modelId)
  if (providers.length === 1) return providers[0] ?? null
  const lower = modelId.toLowerCase()
  if (lower.startsWith("claude")) return "anthropic"
  if (lower.startsWith("gpt") || lower.startsWith("o")) return "openai"
  if (lower.startsWith("gemini")) return "google"
  if (lower.startsWith("kimi")) return "moonshotai"
  if (lower.startsWith("glm")) return "zai"
  if (lower.startsWith("grok")) return "xai"
  if (lower.includes("claude")) return "anthropic"
  if (lower.includes("gemini")) return "google"
  if (lower.includes("gpt")) return "openai"
  if (lower.includes("kimi")) return "moonshotai"
  if (lower.includes("glm")) return "zai"
  if (lower.includes("grok")) return "xai"
  return null
}

function anthropicPricingCandidates(model: string): string[] {
  if (model === "claude-opus-4-6") return [model, "claude-opus-4-5"]
  if (model === "claude-sonnet-4-6") return [model, "claude-sonnet-4-7", "claude-sonnet-4-5"]
  const match = model.match(/^(claude-[a-z]+-\d+)-(\d+)$/)
  if (match) {
    const [, prefix, minor] = match
    const minorNum = parseInt(minor, 10)
    if (minorNum > 0) return [model, `${prefix}-${minorNum - 1}`]
  }
  return [model]
}

function moonshotaiPricingCandidates(model: string): string[] {
  const candidates: string[] = []
  for (const freeCandidate of freeSuffixCandidates(model)) {
    candidates.push(freeCandidate)
    if (freeCandidate.includes(".")) candidates.push(freeCandidate.replace(/\./g, "-"))
  }
  return candidates.filter((value, index, list) => list.indexOf(value) === index)
}

export function resolveModelForProvider(
  snapshot: PricingSnapshot,
  providerID: string,
  normalizedModel: string,
): string | null {
  if (!hasProvider(snapshot, providerID)) return null
  const preferredDirect = pickBestModelForProvider(
    snapshot,
    providerID,
    freeSuffixCandidates(normalizedModel),
  )
  if (preferredDirect) return preferredDirect
  if (normalizedModel.toLowerCase().endsWith("-thinking")) {
    const withoutThinking = normalizedModel.slice(0, -"-thinking".length)
    if (hasModel(snapshot, providerID, withoutThinking)) return withoutThinking
  }
  if (providerID === "moonshotai" && normalizedModel === "kimi-k2") {
    if (hasModel(snapshot, "moonshotai", "kimi-k2-thinking")) return "kimi-k2-thinking"
  }
  if (providerID === "moonshotai") {
    const preferredMoonshot = pickBestModelForProvider(
      snapshot,
      "moonshotai",
      moonshotaiPricingCandidates(normalizedModel),
    )
    if (preferredMoonshot) return preferredMoonshot
  }
  if (providerID === "google") {
    if (normalizedModel === "gemini-3-pro" && hasModel(snapshot, "google", "gemini-3-pro-preview")) {
      return "gemini-3-pro-preview"
    }
    if (normalizedModel === "gemini-3-flash" && hasModel(snapshot, "google", "gemini-3-flash-preview")) {
      return "gemini-3-flash-preview"
    }
  }
  if (providerID === "anthropic") {
    for (const candidate of anthropicPricingCandidates(normalizedModel)) {
      if (hasModel(snapshot, "anthropic", candidate)) return candidate
    }
  }
  return null
}

export function resolvePricingKey(
  snapshot: PricingSnapshot,
  source: { providerID?: string; modelID?: string },
): PricingResolution {
  const srcProvider = source.providerID ?? "unknown"
  const srcModel = source.modelID ?? "unknown"
  if (!source.modelID || typeof source.modelID !== "string") {
    return {
      ok: false,
      unknown: { sourceProviderID: srcProvider, sourceModelID: srcModel, reason: "missing_model" },
    }
  }
  const parsed = parseModelIdHint(source.modelID)
  if (!parsed.modelPart) {
    return {
      ok: false,
      unknown: { sourceProviderID: srcProvider, sourceModelID: srcModel, reason: "missing_model" },
    }
  }
  const normalizedModel = normalizeModelId(parsed.modelPart)
  const sourceProviderHint = normalizeSourceProviderId(snapshot, source.providerID)
  const modelProviderHint = normalizeSourceProviderId(snapshot, parsed.providerHint)

  const tryProvider = (
    providerID: string | undefined,
    method: string,
    modelIDHint: string = normalizedModel,
  ): PricingResolution | null => {
    if (!providerID) return null
    const modelID = resolveModelForProvider(snapshot, providerID, modelIDHint)
    if (!modelID) return null
    return { ok: true, key: { provider: providerID, model: modelID }, method }
  }

  const fromSourceProvider = tryProvider(sourceProviderHint, "source_provider")
  if (fromSourceProvider) return fromSourceProvider
  const fromModelPrefix = tryProvider(modelProviderHint, "model_prefix")
  if (fromModelPrefix) return fromModelPrefix

  const modelCandidates = freeSuffixCandidates(normalizedModel)
  let ambiguousMatch: { model: string; providerCandidates: string[] } | null = null
  for (const candidateModel of modelCandidates) {
    const providerCandidates = listProvidersForModelId(snapshot, candidateModel)
    if (providerCandidates.length === 1) {
      return {
        ok: true,
        key: { provider: providerCandidates[0]!, model: candidateModel },
        method: "unique_model",
      }
    }
    if (providerCandidates.length > 1) {
      const inferredAmbiguousProvider = inferOfficialProviderFromModelId(snapshot, candidateModel)
      if (inferredAmbiguousProvider && providerCandidates.includes(inferredAmbiguousProvider)) {
        const inferredFromAmbiguous = tryProvider(inferredAmbiguousProvider, "alias_fallback", candidateModel)
        if (inferredFromAmbiguous) return inferredFromAmbiguous
      }
      if (!ambiguousMatch) {
        ambiguousMatch = {
          model: candidateModel,
          providerCandidates: [...providerCandidates].sort((a, b) => a.localeCompare(b)),
        }
      }
    }
  }
  if (ambiguousMatch) {
    return {
      ok: false,
      unknown: {
        sourceProviderID: srcProvider,
        sourceModelID: srcModel,
        mappedModel: ambiguousMatch.model,
        normalizedModelID: ambiguousMatch.model,
        providerCandidates: ambiguousMatch.providerCandidates,
        reason: "ambiguous_model",
      },
    }
  }

  let inferredMissing: { provider: string; model: string } | null = null
  for (const candidateModel of modelCandidates) {
    const inferredProvider = inferOfficialProviderFromModelId(snapshot, candidateModel)
    const inferred = tryProvider(inferredProvider ?? undefined, "alias_fallback", candidateModel)
    if (inferred) return inferred
    if (inferredProvider && !inferredMissing) {
      inferredMissing = { provider: inferredProvider, model: candidateModel }
    }
  }
  if (inferredMissing) {
    return {
      ok: false,
      unknown: {
        sourceProviderID: srcProvider,
        sourceModelID: srcModel,
        mappedProvider: inferredMissing.provider,
        mappedModel: inferredMissing.model,
        normalizedModelID: inferredMissing.model,
        reason: "missing_provider",
      },
    }
  }
  return {
    ok: false,
    unknown: {
      sourceProviderID: srcProvider,
      sourceModelID: srcModel,
      mappedModel: normalizedModel,
      normalizedModelID: normalizedModel,
      reason: "missing_provider",
    },
  }
}

// ---------------------------------------------------------------------------
// RPC sync (read-only cache; the quota plugin owns downloads)
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message) return message
  }
  return String(error)
}

function snapshotsEqual(a: PricingSnapshot | null, b: PricingSnapshot | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a._meta.generatedAt !== b._meta.generatedAt) return false
  if (a._meta.source !== b._meta.source) return false
  if (a._meta.units !== b._meta.units) return false
  const aProviders = a._meta.providers
  const bProviders = b._meta.providers
  if (aProviders.length !== bProviders.length) return false
  for (let i = 0; i < aProviders.length; i++) {
    if (aProviders[i] !== bProviders[i]) return false
  }
  const aKeys = Object.keys(a.providers)
  const bKeys = Object.keys(b.providers)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    const aModels = a.providers[key]
    const bModels = b.providers[key]
    if (!bModels) return false
    const aModelKeys = Object.keys(aModels)
    const bModelKeys = Object.keys(bModels)
    if (aModelKeys.length !== bModelKeys.length) return false
    for (const modelKey of aModelKeys) {
      const aCost = aModels[modelKey]
      const bCost = bModels[modelKey]
      if (!bCost) return false
      for (const costKey of COST_KEYS) {
        if (aCost[costKey] !== bCost[costKey]) return false
      }
    }
  }
  return true
}

/**
 * Apply a report from the bound RPC source:
 * - usable snapshot → becomes the authoritative snapshot; the revision
 *   bumps on any price/meta/source change so consumers recompute cached
 *   amounts instead of reusing init-time prices;
 * - report without usable prices while a snapshot is held → keep the old
 *   authority and flag it stale;
 * - nothing at all → stay in the loading/unknown state.
 */
function applyPricingReport(report: PricingSourceReport | null): {
  changed: boolean
  keptStale: boolean
} {
  const store = getStore()
  const normalized = report ? normalizeSnapshot(report.snapshot) : null
  if (normalized) {
    const changed =
      store.snapshot === null ||
      store.source !== report.source ||
      !snapshotsEqual(store.snapshot, normalized)
    store.snapshot = normalized
    store.source = report.source
    store.stale = false
    if (changed) store.revision += 1
    return { changed, keptStale: false }
  }
  if (store.snapshot) {
    store.stale = true
    return { changed: false, keptStale: true }
  }
  store.snapshot = null
  store.source = "empty"
  store.stale = false
  return { changed: false, keptStale: false }
}

/**
 * Sync pricing from the bound RPC source (read-only cache). Meant to run
 * before every cost refresh: it never fetches, never writes files and never
 * falls back to local disk. On failure the previous authoritative snapshot
 * is retained and flagged stale; before the first successful sync the store
 * stays in the loading/unknown state. `force` only re-reads the local RPC
 * cache — downloading stays the quota plugin's exclusive job.
 */
export async function maybeRefreshPricingSnapshot(
  opts: PricingStoreOptions = {},
): Promise<RefreshOutcome> {
  const store = getStore()
  if (store.refreshInFlight) return store.refreshInFlight
  const run = (async (): Promise<RefreshOutcome> => {
    const nowMs = opts.nowMs ?? Date.now()
    const state: RefreshState = { version: 1, updatedAt: nowMs }
    const reader = store.reader
    if (!reader) {
      // No RPC source bound in this host: never fabricate prices.
      return { attempted: false, updated: false, reason: "no_source", state }
    }
    try {
      const report = await reader()
      const applied = applyPricingReport(report)
      if (applied.keptStale) {
        return {
          attempted: true,
          updated: false,
          reason: "stale_kept",
          stale: true,
          state: {
            ...state,
            lastAttemptAt: nowMs,
            lastResult: "failed",
            lastError: "pricing report carried no snapshot",
          },
        }
      }
      return {
        attempted: true,
        updated: applied.changed,
        reason: applied.changed ? "synced" : "unchanged",
        state: { ...state, lastAttemptAt: nowMs, lastSuccessAt: nowMs, lastResult: "success" },
      }
    } catch (error) {
      // Retain the last authoritative snapshot and flag it stale.
      const retained = store.snapshot !== null
      if (retained) store.stale = true
      const errorMessage = describeError(error)
      return {
        attempted: true,
        updated: false,
        reason: "failed",
        error: errorMessage,
        ...(retained ? { stale: true } : {}),
        state: {
          ...state,
          lastAttemptAt: nowMs,
          lastFailureAt: nowMs,
          lastResult: "failed",
          lastError: errorMessage,
        },
      }
    }
  })()
  store.refreshInFlight = run
  const clearInFlight = () => {
    if (store.refreshInFlight === run) store.refreshInFlight = null
  }
  run.then(clearInFlight, clearInFlight)
  return run
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function __resetPricingForTests(): void {
  STORE = null
}
