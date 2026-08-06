/**
 * models.dev pricing snapshot management and model/provider resolution.
 *
 * Ported from @slkiser/opencode-quota (dist/lib/modelsdev-pricing.js and
 * dist/lib/quota-stats.js resolution helpers), MIT.
 * See LICENSES/opencode-quota.LICENSE.
 *
 * Responsibilities:
 * - Load the bundled fallback snapshot (src/data/modelsdev-pricing.min.json).
 * - Optionally overlay a runtime snapshot cached under the plugin's own
 *   namespace `opencode-enhanced-sidebar-zh/` (independent of the quota plugin).
 * - Refresh models.dev pricing in the background with timeout, throttle,
 *   staleness policy, atomic writes and safe fallback to the bundled snapshot.
 * - Resolve OpenCode provider/model ids to a pricing key
 *   (provider aliases: openai/codex/chatgpt/copilot, GPT/Claude/Gemini/Grok/GLM
 *   model inference, -free / -thinking / version aliases, unique-model lookup).
 *
 * Never reads OpenCode `session.cost` / `message.cost`.
 */

import { readFileSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

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
  state: RefreshState
}

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_URL = "https://models.dev/api.json"
const DEFAULT_MODELSDEV_PROVIDERS = [
  "anthropic",
  "google",
  "moonshotai",
  "openai",
  "xai",
  "zai",
]
const COST_KEYS = ["input", "output", "cache_read", "cache_write"] as const
const RUNTIME_NAMESPACE = "opencode-enhanced-sidebar-zh"
const RUNTIME_SNAPSHOT_FILENAME = "modelsdev-pricing.runtime.min.json"
const RUNTIME_REFRESH_STATE_FILENAME = "modelsdev-pricing.refresh-state.json"
const DEFAULT_REFRESH_MIN_ATTEMPT_INTERVAL_MS = 6 * 60 * 60 * 1000
const DEFAULT_REFRESH_TIMEOUT_MS = 6_000
const MS_PER_DAY = 24 * 60 * 60 * 1000
export const DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS = 3 * MS_PER_DAY

const EMPTY_SNAPSHOT: PricingSnapshot = {
  _meta: {
    source: "none",
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
      source: typeof metaRaw.source === "string" && metaRaw.source ? metaRaw.source : SOURCE_URL,
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

export function loadBundledSnapshotSync(
  override?: unknown,
  readFileSyncFn: (url: URL) => string = (url) => readFileSync(url, "utf-8"),
): PricingSnapshot {
  if (override) {
    return normalizeSnapshot(override) ?? EMPTY_SNAPSHOT
  }
  try {
    const raw = readFileSyncFn(bundledSnapshotUrl())
    return normalizeSnapshot(JSON.parse(raw)) ?? EMPTY_SNAPSHOT
  } catch {
    return EMPTY_SNAPSHOT
  }
}

// ---------------------------------------------------------------------------
// Runtime dirs (env based; independent of the quota plugin)
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

export function loadRuntimeSnapshotSync(runtimeDirs: RuntimeDirs): PricingSnapshot | null {
  try {
    const raw = readFileSync(getRuntimePricingSnapshotPath(runtimeDirs), "utf-8")
    return normalizeSnapshot(JSON.parse(raw))
  } catch {
    return null
  }
}

export function hasSnapshotData(snapshot: PricingSnapshot): boolean {
  return snapshot._meta.generatedAt > 0
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface PricingStoreInternal {
  snapshot: PricingSnapshot | null
  source: "bundled" | "runtime" | "empty"
  refreshInFlight: Promise<RefreshOutcome> | null
  refreshChecked: boolean
}

let STORE: PricingStoreInternal | null = null

function getStore(): PricingStoreInternal {
  if (!STORE) STORE = { snapshot: null, source: "bundled", refreshInFlight: null, refreshChecked: false }
  return STORE
}

export function applySnapshotSelection(opts: {
  runtimeDirs?: RuntimeDirs
  bundledSnapshotOverride?: unknown
}): PricingSnapshot {
  const bundled = loadBundledSnapshotSync(opts.bundledSnapshotOverride)
  const runtime = opts.runtimeDirs ? loadRuntimeSnapshotSync(opts.runtimeDirs) : null
  let snapshot: PricingSnapshot
  let source: "bundled" | "runtime" | "empty"
  if (runtime && runtime._meta.generatedAt >= bundled._meta.generatedAt) {
    snapshot = runtime
    source = "runtime"
  } else if (hasSnapshotData(bundled)) {
    snapshot = bundled
    source = "bundled"
  } else {
    snapshot = EMPTY_SNAPSHOT
    source = "empty"
  }
  const store = getStore()
  store.snapshot = snapshot
  store.source = source
  return snapshot
}

export function ensureLoaded(opts?: { bundledSnapshotOverride?: unknown; runtimeDirs?: RuntimeDirs }): PricingSnapshot {
  const store = getStore()
  if (store.snapshot) return store.snapshot
  return applySnapshotSelection(opts ?? {})
}

export function getPricingSnapshotMeta(): PricingSnapshot["_meta"] {
  return ensureLoaded()._meta
}

export function getPricingSnapshotSource(): "bundled" | "runtime" | "empty" {
  ensureLoaded()
  return getStore().source
}

export function getPricingSnapshotHealth(opts?: {
  nowMs?: number
  maxAgeMs?: number
}): { generatedAt: number; ageMs: number; maxAgeMs: number; stale: boolean } {
  const generatedAt = getPricingSnapshotMeta().generatedAt
  const nowMs = opts?.nowMs ?? Date.now()
  const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS
  const ageMs = Math.max(0, nowMs - generatedAt)
  return { generatedAt, ageMs, maxAgeMs, stale: ageMs > maxAgeMs }
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
// Runtime refresh
// ---------------------------------------------------------------------------

function normalizeRefreshState(raw: unknown): RefreshState | null {
  const obj = asRecord(raw)
  if (!obj) return null
  const version = Number(obj.version)
  const updatedAt = Number(obj.updatedAt)
  if (version !== 1 || !Number.isFinite(updatedAt) || updatedAt <= 0) return null
  const out: RefreshState = { version: 1, updatedAt: Math.trunc(updatedAt) }
  const lastAttemptAt = Number(obj.lastAttemptAt)
  const lastSuccessAt = Number(obj.lastSuccessAt)
  const lastFailureAt = Number(obj.lastFailureAt)
  if (Number.isFinite(lastAttemptAt) && lastAttemptAt > 0) out.lastAttemptAt = Math.trunc(lastAttemptAt)
  if (Number.isFinite(lastSuccessAt) && lastSuccessAt > 0) out.lastSuccessAt = Math.trunc(lastSuccessAt)
  if (Number.isFinite(lastFailureAt) && lastFailureAt > 0) out.lastFailureAt = Math.trunc(lastFailureAt)
  if (typeof obj.lastResult === "string") {
    const allowed = new Set([
      "success",
      "not_modified",
      "skipped_fresh",
      "skipped_throttled",
      "failed",
    ])
    if (allowed.has(obj.lastResult)) out.lastResult = obj.lastResult
  }
  if (typeof obj.lastError === "string" && obj.lastError) out.lastError = obj.lastError
  if (typeof obj.etag === "string" && obj.etag) out.etag = obj.etag
  if (typeof obj.lastModified === "string" && obj.lastModified) out.lastModified = obj.lastModified
  return out
}

async function readRefreshState(path: string): Promise<RefreshState | null> {
  try {
    const raw = await readFile(path, "utf-8")
    return normalizeRefreshState(JSON.parse(raw))
  } catch {
    return null
  }
}

function pickCostBuckets(rawCost: unknown): CostBuckets | null {
  const obj = asRecord(rawCost)
  if (!obj) return null
  const picked: CostBuckets = {}
  for (const key of COST_KEYS) {
    const value = obj[key]
    if (typeof value === "number" && Number.isFinite(value)) {
      ;(picked as Record<string, number>)[key] = value
    }
  }
  return Object.keys(picked).length > 0 ? picked : null
}

function buildSnapshotFromApi(
  apiRaw: unknown,
  providerIDs: string[],
  generatedAt: number,
): PricingSnapshot {
  const api = asRecord(apiRaw) ?? {}
  const providers: Record<string, Record<string, CostBuckets>> = {}
  for (const providerID of providerIDs) {
    const providerNode = asRecord(api[providerID])
    const models = asRecord(providerNode?.models)
    if (!models) continue
    const pricedModels: Record<string, CostBuckets> = {}
    for (const modelID of Object.keys(models)) {
      const modelNode = asRecord(models[modelID])
      const cost = pickCostBuckets(modelNode?.cost)
      if (cost) pricedModels[modelID] = cost
    }
    if (Object.keys(pricedModels).length > 0) {
      providers[providerID] = sortRecordByKeys(pricedModels)
    }
  }
  return {
    _meta: {
      generatedAt,
      providers: Object.keys(providers).sort((a, b) => a.localeCompare(b)),
      source: SOURCE_URL,
      units: "USD per 1M tokens",
    },
    providers: sortRecordByKeys(providers),
  }
}

function countPricedModels(snapshot: PricingSnapshot): number {
  let total = 0
  for (const models of Object.values(snapshot.providers)) {
    total += Object.keys(models).length
  }
  return total
}

export async function fetchWithTimeout(
  url: string,
  options: {
    timeoutMs: number
    request?: RequestInit
    fetchFn?: typeof fetch
    consume: (response: Response) => Promise<unknown>
  },
): Promise<unknown> {
  const timeoutMs = options.timeoutMs
  const controller = new AbortController()
  let timedOut = false
  const timeoutErrorMessage = `Request timeout after ${Math.round(timeoutMs / 1000)}s`
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(new Error(timeoutErrorMessage))
    }, timeoutMs)
  })
  try {
    const transaction = (async () => {
      const fetchFn = options.fetchFn ?? globalThis.fetch
      const response = await fetchFn(url, {
        ...options.request,
        signal: controller.signal,
      })
      return await options.consume(response)
    })()
    return await Promise.race([transaction, timeout])
  } catch (err) {
    if (timedOut) throw new Error(timeoutErrorMessage)
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
}

async function writeTextAtomic(path: string, content: string): Promise<void> {
  const dir = dirname(path)
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  await mkdir(dir, { recursive: true })
  try {
    await writeFile(tmp, content, "utf-8")
  } catch (writeError) {
    try { await rm(tmp, { force: true }) } catch { /* best effort */ }
    throw writeError
  }
  try {
    await rename(tmp, path)
  } catch (renameError) {
    const code =
      renameError && typeof renameError === "object" && "code" in renameError
        ? String((renameError as NodeJS.ErrnoException).code)
        : ""
    const shouldRetryAsReplace = code === "EPERM" || code === "EEXIST" || code === "EACCES" || code === "ENOTEMPTY"
    if (!shouldRetryAsReplace) {
      try { await rm(tmp, { force: true }) } catch { /* best effort */ }
      throw renameError
    }
    try { await rm(path, { force: true }) } catch { /* best effort */ }
    try {
      await rename(tmp, path)
    } catch (replaceError) {
      try { await rm(tmp, { force: true }) } catch { /* best effort */ }
      throw replaceError
    }
  }
}

export async function maybeRefreshPricingSnapshot(
  opts: PricingStoreOptions = {},
): Promise<RefreshOutcome> {
  const store = getStore()
  if (store.refreshInFlight) return store.refreshInFlight
  store.refreshInFlight = (async () => {
    const nowMs = opts.nowMs ?? Date.now()
    const maxAgeMs = opts.maxAgeMs ?? DEFAULT_PRICING_SNAPSHOT_MAX_AGE_MS
    const minAttemptIntervalMs = opts.minAttemptIntervalMs ?? DEFAULT_REFRESH_MIN_ATTEMPT_INTERVAL_MS
    const timeoutMs = opts.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS
    const runtimeDirs = opts.runtimeDirs ?? getOpencodeRuntimeDirs()
    const snapshotPath = getRuntimePricingSnapshotPath(runtimeDirs)
    const statePath = getRuntimePricingRefreshStatePath(runtimeDirs)
    const force = opts.force === true
    const previousState = (await readRefreshState(statePath)) ?? {
      version: 1 as const,
      updatedAt: nowMs,
    }
    const runtimeSnapshotBeforeRefresh = loadRuntimeSnapshotSync(runtimeDirs)
    applySnapshotSelection({ runtimeDirs, bundledSnapshotOverride: opts.bundledSnapshotOverride })

    if (!force && store.refreshChecked) {
      return {
        attempted: false,
        updated: false,
        reason: "already_checked_this_process",
        state: previousState,
      }
    }
    store.refreshChecked = true

    const health = getPricingSnapshotHealth({ nowMs, maxAgeMs })
    if (!force && !health.stale) {
      return {
        attempted: false,
        updated: false,
        reason: "fresh",
        state: { ...previousState, updatedAt: nowMs, lastResult: "skipped_fresh" },
      }
    }
    if (
      !force &&
      previousState.lastAttemptAt &&
      nowMs - previousState.lastAttemptAt < minAttemptIntervalMs
    ) {
      return {
        attempted: false,
        updated: false,
        reason: "throttled",
        state: { ...previousState, updatedAt: nowMs, lastResult: "skipped_throttled" },
      }
    }

    const attemptingState: RefreshState = {
      ...previousState,
      version: 1,
      updatedAt: nowMs,
      lastAttemptAt: nowMs,
    }
    try {
      const headers = new Headers()
      if (attemptingState.etag) headers.set("If-None-Match", attemptingState.etag)
      if (attemptingState.lastModified) headers.set("If-Modified-Since", attemptingState.lastModified)
      const fetchResult = (await fetchWithTimeout(SOURCE_URL, {
        timeoutMs,
        request: { headers },
        fetchFn: opts.fetchFn,
        consume: async (response) => {
          const responseMetadata = {
            etag: response.headers.get("etag") ?? undefined,
            lastModified: response.headers.get("last-modified") ?? undefined,
          }
          if (response.status === 304) return { kind: "not_modified", ...responseMetadata }
          if (!response.ok) {
            throw new Error(`Failed to fetch ${SOURCE_URL}: ${response.status} ${response.statusText}`)
          }
          return { kind: "success", api: await response.json(), ...responseMetadata }
        },
      })) as
        | { kind: "not_modified"; etag?: string; lastModified?: string }
        | { kind: "success"; api: unknown; etag?: string; lastModified?: string }

      if (fetchResult.kind === "not_modified") {
        const baseSnapshot = runtimeSnapshotBeforeRefresh ?? ensureLoaded()
        const refreshedSnapshot: PricingSnapshot = {
          _meta: { ...baseSnapshot._meta, generatedAt: nowMs },
          providers: baseSnapshot.providers,
        }
        await writeTextAtomic(snapshotPath, JSON.stringify(refreshedSnapshot) + "\n")
        applySnapshotSelection({ runtimeDirs, bundledSnapshotOverride: opts.bundledSnapshotOverride })
        const nextState: RefreshState = {
          ...attemptingState,
          updatedAt: nowMs,
          lastSuccessAt: nowMs,
          lastResult: "not_modified",
          lastError: undefined,
          etag: fetchResult.etag ?? attemptingState.etag,
          lastModified: fetchResult.lastModified ?? attemptingState.lastModified,
        }
        try { await writeTextAtomic(statePath, JSON.stringify(nextState) + "\n") } catch { /* best effort */ }
        return { attempted: true, updated: true, state: nextState }
      }

      const snapshot = buildSnapshotFromApi(
        fetchResult.api,
        opts.providerAllowlist ?? DEFAULT_MODELSDEV_PROVIDERS,
        nowMs,
      )
      if (countPricedModels(snapshot) === 0) {
        throw new Error("Refusing to persist empty pricing snapshot from models.dev")
      }
      await writeTextAtomic(snapshotPath, JSON.stringify(snapshot) + "\n")
      applySnapshotSelection({ runtimeDirs, bundledSnapshotOverride: opts.bundledSnapshotOverride })
      const nextState: RefreshState = {
        ...attemptingState,
        updatedAt: nowMs,
        lastSuccessAt: nowMs,
        lastResult: "success",
        lastError: undefined,
        etag: fetchResult.etag ?? attemptingState.etag,
        lastModified: fetchResult.lastModified ?? attemptingState.lastModified,
      }
      try { await writeTextAtomic(statePath, JSON.stringify(nextState) + "\n") } catch { /* best effort */ }
      return { attempted: true, updated: true, state: nextState }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const nextState: RefreshState = {
        ...attemptingState,
        updatedAt: nowMs,
        lastFailureAt: nowMs,
        lastResult: "failed",
        lastError: errorMessage,
      }
      try { await writeTextAtomic(statePath, JSON.stringify(nextState) + "\n") } catch { /* best effort */ }
      return { attempted: true, updated: false, error: errorMessage, state: nextState }
    }
  })().finally(() => {
    store.refreshInFlight = null
  })
  return store.refreshInFlight
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function __resetPricingForTests(): void {
  STORE = null
}
