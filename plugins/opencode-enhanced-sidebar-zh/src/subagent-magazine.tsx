/** @jsxImportSource @opentui/solid */

import type { JSX } from "@opentui/solid"
import type {
  TuiPluginApi,
  TuiThemeCurrent,
} from "@opencode-ai/plugin/tui"
import type { SessionMetricsService } from "./metrics/session-metrics.ts"
import {
  applyCostInfo,
  entryCostText,
  shouldProcessSessionEnd,
  type CostInfo,
} from "./subagent-guards.ts"
import {
  createMemo,
  createSignal,
  createEffect,
  onMount,
  onCleanup,
  untrack,
  Show,
  For,
} from "solid-js"

// ===================================================================
// Types
// ===================================================================

type SubStatus = "running" | "done" | "error"

interface SubEntry {
  id: string
  title: string
  agent: string
  prompt: string
  error?: string
  tokens?: number
  /**
   * USD cost in display format (4 decimals). Legacy KV entries may carry an old
   * numeric value written by previous versions; it is only used as a
   * read-only display migration and is always overwritten by a fresh
   * calculation from the shared metrics service (`costComplete === true`).
   * Never sourced from OpenCode `session.cost` / `message.cost`.
   */
  cost?: number
  /** True when the stored `cost` came from our own partial (unpriced) estimate. */
  costPartial?: boolean
  /** False while a fresh calculation is incomplete (never displayed). */
  costComplete?: boolean
  status: SubStatus
  sessionId?: string
  startedAt: number
  endedAt?: number
  model?: string
  todoTotal?: number
  todoDone?: number
}

export interface SubAgentCostSummary {
  usd: number
  hasUsage: boolean
  partial: boolean
  complete: boolean
}

type Lang = "zh" | "en"
type SortOrder = "desc" | "asc"
type ScrollMode = "wheel" | "click"

/** OpenCode built-in tool names that spawn sub-agents or delegate tasks. */
const SUBAGENT_TOOLS = new Set(["task", "delegate", "call_omo_agent"])

// ===================================================================
// i18n
// ===================================================================

const I18N: Record<Lang, Record<string, string>> = {
  zh: {
    "panel.title": "子代理",
    "status.none": "暂无子代理",
    "agent.label": "代理",
    "status.label": "状态",
    "time.label": "耗时",
    "tokens.label": "上下文",
    "error.label": "错误",
    "model.label": "模型",
    "todo.label": "进度",
    "session.label": "会话 ID",
    "session.toast.copy": "可手动复制上方 ID",
    "open.label": "进入会话",
    "cost.label": "费用",
    "scroll.more": "更多",
    "scroll.top": "回顶",
    "scroll.bottom": "回底",
    "dismiss.label": "标记完成",
    "status.running": "运行中",
    "status.done": "已完成",
    "status.error": "错误",
    "order.desc": "降序（最新在前）",
    "order.asc": "升序（最早在前）",
    "scroll.wheel": "滚轮翻页",
    "scroll.click": "点击翻页",
    "ttl.label": "清理周期",
    "ttl.3d": "3 天",
    "ttl.7d": "7 天",
    "ttl.14d": "14 天",
    "ttl.30d": "30 天",
    "ttl.unlimited": "无期限",
    "ttl.toast": "清理周期已设为 {n} 天",
    "ttl.toast_unlimited": "清理周期已设为无期限",
    "clear.title": "确认清除",
    "clear.prompt": "确定清除当前会话所有子代理记录？此操作不可撤销。",
    "clear.prompt_running": "当前有 {n} 个运行中的子代理，清除后将不可恢复。确定继续？",
    "clear.done": "已清除 {n} 条子代理记录",
    "clear.empty": "当前会话无子代理记录",
  },
  en: {
    "panel.title": "SubAgent",
    "status.none": "No sub-agents yet",
    "agent.label": "agent",
    "status.label": "status",
    "time.label": "time",
    "tokens.label": "tokens",
    "error.label": "error",
    "model.label": "model",
    "todo.label": "todo",
    "session.label": "session ID",
    "session.toast.copy": "Copy the ID above manually",
    "open.label": "Open session",
    "cost.label": "cost",
    "scroll.more": "more",
    "scroll.top": "Top",
    "scroll.bottom": "Bottom",
    "dismiss.label": "dismiss",
    "status.running": "running",
    "status.done": "done",
    "status.error": "error",
    "order.desc": "Desc (newest first)",
    "order.asc": "Asc (oldest first)",
    "scroll.wheel": "Wheel Scroll",
    "scroll.click": "Click Scroll",
    "ttl.label": "TTL (Time to Live)",
    "ttl.3d": "3 days",
    "ttl.7d": "7 days",
    "ttl.14d": "14 days",
    "ttl.30d": "30 days",
    "ttl.unlimited": "Never",
    "ttl.toast": "TTL set to {n} days",
    "ttl.toast_unlimited": "TTL set to Never",
    "clear.title": "Confirm",
    "clear.prompt": "Clear all sub-agent records for this session? This cannot be undone.",
    "clear.prompt_running": "{n} sub-agent(s) are still running. Clearing will discard them permanently. Continue?",
    "clear.done": "Cleared {n} sub-agent record(s)",
    "clear.empty": "No sub-agent records in this session",
  },
}

// ===================================================================
// Helpers — visual width
// ===================================================================

function charColumns(c: string): number {
  const code = c.codePointAt(0) ?? 0
  if (code < 0x20) return 0
  if (code < 0x7f) return 1
  if (code < 0xa0) return 0
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
    return 2
  return 1
}

function visualWidth(s: string): number {
  let w = 0
  for (const c of s) w += charColumns(c)
  return w
}

function truncate(text: string, maxCols: number): string {
  if (visualWidth(text) <= maxCols) return text
  let cols = 0
  let i = 0
  for (const c of text) {
    const w = charColumns(c)
    if (cols + w > maxCols - 1) break
    cols += w
    i += c.length
  }
  return text.slice(0, i) + "\u2026"
}

function fmtDurationShort(ms: number, running: boolean): string {
  if (running && ms < 2000) return ""
  if (ms < 1000) return (ms / 1000).toFixed(2) + "s"
  if (ms < 60000) return (ms / 1000).toFixed(2) + "s"
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return `${m}m${s}s`
}

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1000000).toFixed(1)}M`
}

/** Entry line left prefix: icon + space + status dot + space */
const LEFT_PAD = 4
/** Detail row indent: two spaces */
const INDENT = 2

function safeErrorMsg(err: unknown): string {
  if (!err) return ""
  if (typeof err === "string") return err
  if (typeof err === "object") return String((err as any).message || (err as any).code || "")
  return ""
}

// ===================================================================
// Sidebar component
// ===================================================================

// 模块级缓存：各 session 的 entry 状态独立存储，不随当前视图切换而清除。
const globalEntryCache = new Map<string, Map<string, SubEntry>>()

// 模块级刷新信号：外部（如斜杠命令）触发清除后 +1，组件 scan 依赖它以重扫。
const [clearTick, setClearTick] = createSignal(0)

export function SubAgentPanel(props: {
  theme: TuiThemeCurrent
  api: TuiPluginApi
  lang: () => Lang
  maxEntries: () => number
  sortOrder: () => SortOrder
  scrollMode: () => ScrollMode
  sessionId: string
  /** Shared session metrics service: source of every sub-agent cost. */
  metrics: SessionMetricsService
  onCostSummary?: (summary: SubAgentCostSummary) => void
}): JSX.Element {
  const t = (key: string) => I18N[props.lang()][key] ?? key

  // ── session data (single-key, true deletion on cleanup) ──
  const SESSION_DATA_KEY = `${KV_PREFIX}.session_data`
  const ttlDaysRaw = parseInt(String(props.api.kv.get(`${KV_PREFIX}.ttl_days`, "3")), 10)
  const ttlDays = Number.isNaN(ttlDaysRaw) ? 3 : ttlDaysRaw
  const TTL_MS = ttlDays * 24 * 60 * 60 * 1000

  interface ChildRecord {
    scroll: number
    expanded: string
    entries: SubEntry[]
    clearedIds?: string[]
  }

  interface SessionRecord {
    ts: number
    entries: SubEntry[]
    scroll: number
    expanded: string
    children: Record<string, ChildRecord>
    clearedIds?: string[]
  }

  const loadSessionData = (): Record<string, SessionRecord> => {
    try {
      const raw = props.api.kv.get(SESSION_DATA_KEY, "{}")
      return JSON.parse(String(raw))
    } catch { return {} }
  }

  const saveSessionData = (data: Record<string, SessionRecord>) => {
    try { props.api.kv.set(SESSION_DATA_KEY, JSON.stringify(data)) } catch {}
  }

  /** 将任意 session ID 解析为父会话 ID + 是否子会话。
   *  通过 SDK session.get(sid).parentID 判断，无 parentID 即为主会话。 */
  const resolveParent = (sid: string): { parentSid: string; isChild: boolean } => {
    try {
      const session = props.api.state.session.get(sid)
      const parentID = (session as any)?.parentID as string | undefined
      if (parentID) return { parentSid: parentID, isChild: true }
    } catch {}
    return { parentSid: sid, isChild: false }
  }

  const loadEntries = (sid: string): Map<string, SubEntry> => {
    const m = new Map<string, SubEntry>()
    try {
      const { parentSid, isChild } = resolveParent(sid)
      const rec = loadSessionData()[parentSid]
      if (rec) {
        const source = isChild ? rec.children?.[sid]?.entries : rec.entries
        if (source) {
          for (const e of source) m.set(e.id, e)
        }
      }
    } catch {}
    return m
  }

  let persistTimer: ReturnType<typeof setTimeout> | undefined
  const persistEntries = (sid: string, entries: Map<string, SubEntry>) => {
    clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      try {
        const data = loadSessionData()
        const { parentSid, isChild } = resolveParent(sid)
        if (isChild) {
          if (!data[parentSid]) data[parentSid] = { ts: Date.now(), entries: [], scroll: 0, expanded: "", children: {} }
          if (!data[parentSid].children) data[parentSid].children = {}
          if (!data[parentSid].children[sid]) data[parentSid].children[sid] = { scroll: 0, expanded: "", entries: [] }
          data[parentSid].children[sid] = { ...data[parentSid].children[sid], entries: [...entries.values()] }
        } else {
          data[sid] = { ...data[sid], ts: Date.now(), entries: [...entries.values()], children: data[sid]?.children ?? {} }
        }
        saveSessionData(data)
      } catch {}
    }, 200)
  }

  const persistScroll = (sid: string, scroll: number) => {
    try {
      const data = loadSessionData()
      const { parentSid, isChild } = resolveParent(sid)
      if (isChild) {
        if (!data[parentSid]) data[parentSid] = { ts: Date.now(), entries: [], scroll: 0, expanded: "", children: {} }
        if (!data[parentSid].children) data[parentSid].children = {}
        if (!data[parentSid].children[sid]) data[parentSid].children[sid] = { scroll: 0, expanded: "", entries: [] }
        data[parentSid].children[sid] = { ...data[parentSid].children[sid], scroll }
      } else {
        data[sid] = { ...data[sid], ts: Date.now(), scroll, children: data[sid]?.children ?? {} }
      }
      saveSessionData(data)
    } catch {}
  }

  const persistExpanded = (sid: string, expanded: string) => {
    try {
      const data = loadSessionData()
      const { parentSid, isChild } = resolveParent(sid)
      if (isChild) {
        if (!data[parentSid]) data[parentSid] = { ts: Date.now(), entries: [], scroll: 0, expanded: "", children: {} }
        if (!data[parentSid].children) data[parentSid].children = {}
        if (!data[parentSid].children[sid]) data[parentSid].children[sid] = { scroll: 0, expanded: "", entries: [] }
        data[parentSid].children[sid] = { ...data[parentSid].children[sid], expanded }
      } else {
        data[sid] = { ...data[sid], ts: Date.now(), expanded, children: data[sid]?.children ?? {} }
      }
      saveSessionData(data)
    } catch {}
  }

  const cleanupOldSessions = () => {
    if (ttlDays <= 0) return  // 无期限，跳过清理
    try {
      const data = loadSessionData()
      const cutoff = Date.now() - TTL_MS
      let changed = false
      for (const sid of Object.keys(data)) {
        if (data[sid].ts < cutoff) {
          delete data[sid]
          changed = true
        }
      }
      if (changed) saveSessionData(data)
    } catch {}
  }

  cleanupOldSessions()

  const [entryMap, setEntryMapRaw] = createSignal(loadEntries(props.sessionId))

  // Wrapped setter — also persists to kv on every mutation
  const setEntryMap = (
    arg: Map<string, SubEntry> | ((prev: Map<string, SubEntry>) => Map<string, SubEntry>),
  ) => {
    setEntryMapRaw((prev) => {
      const next = typeof arg === "function" ? (arg as Function)(prev) : arg

      // entry 状态落定（done/error）时立即持久化到 KV，跳过常规 debounce，
      // 确保跨视图的状态一致性。
      let needsImmediateFlush = false
      for (const [id, entry] of next) {
        const prevEntry = prev.get(id)
        if (prevEntry?.status === "running" && (entry.status === "done" || entry.status === "error")) {
          needsImmediateFlush = true
          break
        }
      }

      if (needsImmediateFlush) {
        clearTimeout(persistTimer)
        try {
          const data = loadSessionData()
          const { parentSid, isChild } = resolveParent(props.sessionId)
          if (isChild) {
            if (!data[parentSid]) data[parentSid] = { ts: Date.now(), entries: [], scroll: 0, expanded: "", children: {} }
            if (!data[parentSid].children) data[parentSid].children = {}
            if (!data[parentSid].children[props.sessionId]) data[parentSid].children[props.sessionId] = { scroll: 0, expanded: "", entries: [] }
            data[parentSid].children[props.sessionId] = { ...data[parentSid].children[props.sessionId], entries: [...next.values()] }
          } else {
            data[props.sessionId] = { ...data[props.sessionId], ts: Date.now(), entries: [...next.values()], children: data[props.sessionId]?.children ?? {} }
          }
          saveSessionData(data)
        } catch {}
      } else {
        persistEntries(props.sessionId, next)
      }

      // 同步到模块级缓存，供其他视图读取当前 session 的最新状态
      globalEntryCache.set(props.sessionId, new Map(next))

      return next
    })
  }

  const [panelWidth, setPanelWidth] = createSignal(28)
  const [open, setOpen] = createSignal(
    (() => { try { return props.api.kv.get(`${KV_PREFIX}.open`, true) as boolean } catch { return true } })()
  )
  const [expanded, setExpanded] = createSignal<string | undefined>(
    (() => {
      try {
        const { parentSid, isChild } = resolveParent(props.sessionId)
        const rec = loadSessionData()[parentSid]
        if (rec) return isChild ? rec.children?.[props.sessionId]?.expanded || undefined : rec.expanded || undefined
      } catch {}
      return undefined
    })(),
  )
  const [hoveredOpen, setHoveredOpen] = createSignal<string | undefined>(undefined)
  const [hoveredDismiss, setHoveredDismiss] = createSignal<string | undefined>(undefined)
  const [hoveredTop, setHoveredTop] = createSignal(false)
  const [hoveredMoreAbove, setHoveredMoreAbove] = createSignal(false)
  const [hoveredMoreBelow, setHoveredMoreBelow] = createSignal(false)
  const [scrollOffset, setScrollOffset] = createSignal(
    (() => {
      try {
        const { parentSid, isChild } = resolveParent(props.sessionId)
        const rec = loadSessionData()[parentSid]
        return isChild ? rec?.children?.[props.sessionId]?.scroll ?? 0 : rec?.scroll ?? 0
      } catch { return 0 }
    })(),
  )
  const [now, setNow] = createSignal(Date.now())
  const [renderTick, setRenderTick] = createSignal(0)

  let boxEl: any
  let disposed = false

  /** Total context tokens for a sub-agent session.
   *  Matches opencode-visual-cache's "总计": last assistant message's input + cache.read. */
  const readSessionTokens = (sid: string): number | undefined => {
    if (!sid) return undefined
    try {
      const msgs = props.api.state.session.messages(sid)
      if (msgs) {
        for (let i = (msgs as any[]).length - 1; i >= 0; i--) {
          const m = (msgs as any[])[i]
          if (m.role !== "assistant") continue
          const t = m.tokens
          if (!t) continue
          const cache = t.cache as { read?: number; write?: number } | undefined
          const ctx = (Number(t.input) || 0) + (cache?.read ?? 0)
          if (ctx > 0) return ctx
        }
      }
      return undefined
    } catch {
      return undefined
    }
  }

  /** Self-calculated USD cost for a sub-agent session from the shared metrics
   *  service (paginated `client.session.messages()`, models.dev pricing).
   *  Never reads OpenCode `session.cost` / `message.cost`. */
  const readSessionCostFromMetrics = (sid: string): CostInfo | undefined => {
    if (!sid) return undefined
    try {
      const res = props.metrics.get(sid)
      if (!res) return undefined
      return { usd: res.usd, partial: res.partial, complete: res.complete, hasUsage: res.hasUsage }
    } catch {
      return undefined
    }
  }

  /** Request the shared service to recompute a sub-agent session cost. */
  const refreshSessionCost = (sid: string, delayMs?: number) => {
    if (!sid) return
    try { props.metrics.refresh(sid, delayMs !== undefined ? { delayMs } : undefined) } catch {}
  }

  // Cost aggregation is asynchronous. Subscribe every tracked child instead
  // of relying on the old fixed 400/1200ms backfill window. This also applies
  // late results to entries that have already transitioned to done, including
  // entries restored from KV on a later parent-session view.
  let metricUnsubscribers: Array<() => void> = []
  createEffect(() => {
    const trackedSessionIds = new Set(
      [...entryMap().values()]
        .map((entry) => entry.sessionId)
        .filter((sid): sid is string => Boolean(sid)),
    )
    for (const unsubscribe of metricUnsubscribers) unsubscribe()
    metricUnsubscribers = []
    for (const childSid of trackedSessionIds) {
      metricUnsubscribers.push(props.metrics.subscribe(childSid, () => {
        const costInfo = readSessionCostFromMetrics(childSid)
        if (!costInfo?.complete) return
        setEntryMap((prev) => {
          let changed = false
          const next = new Map(prev)
          for (const [id, entry] of next) {
            if (entry.sessionId !== childSid) continue
            const applied = applyCostInfo(entry, costInfo)
            if (
              applied.cost !== entry.cost ||
              applied.costPartial !== entry.costPartial ||
              applied.costComplete !== entry.costComplete
            ) {
              next.set(id, applied)
              changed = true
            }
          }
          return changed ? next : prev
        })
        bump()
      }))
    }
    onCleanup(() => {
      for (const unsubscribe of metricUnsubscribers) unsubscribe()
      metricUnsubscribers = []
    })
  })

  /** Last assistant message's modelID for a sub-agent session. */
  const readSessionModel = (sid: string): string | undefined => {
    if (!sid) return undefined
    try {
      const msgs = props.api.state.session.messages(sid)
      if (msgs) {
        for (let i = (msgs as any[]).length - 1; i >= 0; i--) {
          const m = (msgs as any[])[i]
          if (m.role === "assistant" && m.modelID) return String(m.modelID)
        }
      }
      return undefined
    } catch {
      return undefined
    }
  }

  /** Todo completion stats for a sub-agent session.
   *  `done` counts completed + cancelled items. */
  const readSessionTodo = (sid: string): { total: number; done: number } | undefined => {
    if (!sid) return undefined
    try {
      const todos = props.api.state.session.todo(sid)
      if (!todos || todos.length === 0) return undefined
      let done = 0
      for (const t of todos) {
        if (t.status === "completed" || t.status === "cancelled") done++
      }
      return { total: todos.length, done }
    } catch {
      return undefined
    }
  }

  // ── upsert ──
  const upsertEntry = (
    partial: Omit<SubEntry, "startedAt" | "endedAt"> & { startedAt?: number }
  ) => {
    setEntryMap((prev) => {
      const existing = prev.get(partial.id)
      const next = new Map(prev)
      const nowTs = Date.now()
      const e = partial.status
      const ended = e === "done" || e === "error"
      next.set(partial.id, {
        ...(existing ?? { startedAt: nowTs }),
        ...partial,
        startedAt: existing?.startedAt || partial.startedAt || nowTs,
        endedAt: ended ? (existing?.endedAt || nowTs) : undefined,
      })
      return next
    })
  }

  // ── event handlers ──
  const handlePartUpdated = (event: unknown) => {
    const e = event as Record<string, unknown>
    const props_ = e.properties as Record<string, unknown> | undefined
    const part = props_?.part as Record<string, unknown> | undefined
    if (!part) return

    // SubtaskPart
    if (part.type === "subtask") {
      const agent = String(part.agent ?? "?")
      const prompt = String(part.prompt ?? "")
      const desc = String(part.description ?? "")
      const title = desc || truncate(prompt.replace(/\n/g, " ").replace(/\s+/g, " ").trim(), 40)

      const id = `sub:${String(part.id ?? crypto.randomUUID())}`
      const subSid = part.sessionID !== undefined ? String(part.sessionID) : undefined
      const partModel = part.model as { modelID?: string } | undefined
      const modelId = partModel?.modelID ? String(partModel.modelID) : undefined
      upsertEntry({ id, title, agent, prompt, sessionId: subSid, status: "running", model: modelId })
    }

    // ToolPart
    if (part.type === "tool") {
      const tool = String(part.tool ?? "")
      if (!SUBAGENT_TOOLS.has(tool)) return
      const st = part.state as Record<string, unknown> | undefined
      const rawStatus = String(st?.status ?? "")

      // Only create entries for tool calls that actually entered execution.
      // "pending" / empty → state unknown yet, wait for next event
      if (rawStatus === "pending" || rawStatus === "") return

      // "error" → tool call failed, sub-agent never spawned.
      // Only update an existing entry (e.g. previously running → now error),
      // never create a new one.
      if (rawStatus === "error") {
        const id = `tool:${String(part.id ?? "")}`
        if (!part.id) return
        const existing = entryMap().get(id)
        if (existing) {
          upsertEntry({ id, title: existing.title, agent: existing.agent, prompt: existing.prompt, status: "error" })
        }
        return
      }

      // rawStatus is "running" or "completed" — tool entered execution, track it.
      const input = st?.input as Record<string, unknown> | undefined
      let status: SubStatus = "running"
      if (rawStatus === "completed") status = "done"
      // Background tasks: tool completion ≠ agent completion — keep running until session.idle
      // Only keep running if state metadata confirms a child session was spawned;
      // otherwise (failed spawn, invalid agent) mark as done so the entry isn't stuck forever.
      if ((input?.run_in_background === true || input?.background === true) && status === "done") {
        const stMetaCheck = st?.metadata as Record<string, unknown> | undefined
        const hasChild = stMetaCheck?.session_id !== undefined || stMetaCheck?.sessionId !== undefined
        if (hasChild) status = "running"
      }

      const agent = String((part as any).subagent_type ?? input?.subagent_type ?? input?.category ?? tool)
      const prompt = String(input?.prompt ?? (part as any).description ?? "")
      const desc = input?.description !== undefined ? String(input.description) : ""
      const title = desc || truncate(prompt.replace(/\n/g, " ").replace(/\s+/g, " ").trim(), 40)

      const id = `tool:${String(part.id ?? crypto.randomUUID())}`
      // Child session ID lives in state-level metadata (ToolStateCompleted.metadata),
      // injected by the tool executor.  ToolPart.sessionID is the parent session.
      const stMeta = st?.metadata as Record<string, unknown> | undefined
      const subSid = stMeta?.session_id !== undefined ? String(stMeta.session_id)
        : stMeta?.sessionId !== undefined ? String(stMeta.sessionId)
        : undefined
      upsertEntry({ id, title, agent, prompt, sessionId: subSid, status })
    }
  }

  const handleSessionEnd = (event: unknown, status: SubStatus) => {
    const e = event as Record<string, unknown>
    const props_ = e.properties as Record<string, unknown> | undefined
    const sid = String(props_?.sessionID ?? "")
    if (!sid) return

    // PARENT EXCLUSION: sub-agent entries belong to child sessions only.
    // A parent session idle/error must never write its sessionId/cost into a
    // child entry via the agent-name fallback below; the currently viewed
    // session itself ending also never updates entries.
    let isChildSession = false
    try {
      isChildSession = resolveParent(sid).isChild
    } catch {}
    if (!shouldProcessSessionEnd(sid, isChildSession, props.sessionId)) return

    // Ask the shared service to recompute this sub-agent session's cost
    // (final token rows may land right after the idle/error event).
    refreshSessionCost(sid)

    const sessionTokens = readSessionTokens(sid)
    const sessionCostInfo = readSessionCostFromMetrics(sid)
    const sessionModel = readSessionModel(sid)
    const sessionTodo = readSessionTodo(sid)
    // Apply the fresh self-calculated cost to an entry in place (no-op when the
    // metrics result is incomplete or missing).
    const applyCostInPlace = (entry: SubEntry) => {
      if (!sessionCostInfo) return
      const applied = applyCostInfo(entry, sessionCostInfo)
      entry.cost = applied.cost
      entry.costPartial = applied.costPartial
      entry.costComplete = applied.costComplete
    }
    let sessionAgent: string | undefined
    let errorMsg: string | undefined
    try {
      const s = props.api.state.session.get(sid)
      sessionAgent = s?.agent
      if (status === "error") {
        const evtErr = props_?.error as Record<string, unknown> | undefined
        errorMsg = safeErrorMsg(evtErr) || safeErrorMsg(props_?.message)
        if (!errorMsg) {
          const msgs = props.api.state.session.messages(sid)
          if (msgs) {
            for (let i = (msgs as any[]).length - 1; i >= 0; i--) {
              const m = (msgs as any[])[i]
              if (m.role === "assistant" && m.error) {
                errorMsg = safeErrorMsg(m.error)
                break
              }
            }
          }
        }
      }
    } catch {}

    // 在给定的 entries Map 中查找并更新匹配的子代理 entry。
    // 返回 true 表示找到并更新了，false 表示未找到。
    const tryMatchAndUpdate = (
      entriesMap: Map<string, SubEntry>,
      targetSid: string,
      targetStatus: SubStatus,
      nowTs: number,
    ): boolean => {
      // 精确匹配：sessionId 对得上 + 状态为 running
      for (const [, entry] of entriesMap) {
        if (entry.sessionId === targetSid && entry.status === "running") {
          entry.status = targetStatus
          entry.endedAt = nowTs
          entry.tokens = entry.tokens ?? sessionTokens
          applyCostInPlace(entry)
          entry.model = entry.model ?? sessionModel
          entry.todoTotal = entry.todoTotal ?? sessionTodo?.total
          entry.todoDone = entry.todoDone ?? sessionTodo?.done
          entry.error = errorMsg || entry.error
          return true
        }
      }
      // 回退：sessionId 未关联但 agent 名匹配 + 状态为 running
      if (sessionAgent) {
        const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "")
        const saNorm = normalize(sessionAgent)
        let best: { entry: SubEntry; gap: number } | null = null
        for (const [, entry] of entriesMap) {
          if (entry.status !== "running") continue
          const eaNorm = normalize(entry.agent)
          if (!eaNorm || !saNorm) continue
          if (!eaNorm.includes(saNorm) && !saNorm.includes(eaNorm)) continue
          const gap = nowTs - (entry.startedAt || 0)
          if (!best || gap > best.gap) best = { entry, gap }
        }
        if (!best) {
          for (const [, entry] of entriesMap) {
            if (entry.status !== "running") continue
            if (entry.sessionId) continue
            const gap = nowTs - (entry.startedAt || 0)
            if (!best || gap > best.gap) best = { entry, gap }
          }
        }
        if (best) {
          best.entry.status = targetStatus
          best.entry.endedAt = nowTs
          best.entry.tokens = best.entry.tokens ?? sessionTokens
          applyCostInPlace(best.entry)
          best.entry.model = best.entry.model ?? sessionModel
          best.entry.todoTotal = best.entry.todoTotal ?? sessionTodo?.total
          best.entry.todoDone = best.entry.todoDone ?? sessionTodo?.done
          best.entry.sessionId = targetSid
          best.entry.error = errorMsg || best.entry.error
          return true
        }
      }
      return false
    }

    setEntryMap((prev) => {
      let changed = false
      const next = new Map(prev)
      for (const [id, entry] of next) {
        if (entry.sessionId !== sid) continue
        if (entry.status !== "running" && entry.status !== "done") continue
        // Skip parent session idle — subagent entries belong to child sessions only
        if (sid === props.sessionId) continue
        // For "done" entries (sync tasks completed before session.idle), only backfill tokens/cost
        const alreadySettled = entry.status !== "running"
        const costApplied = applyCostInfo(entry, sessionCostInfo)
        next.set(id, {
          ...entry,
          ...(alreadySettled ? {} : { status, endedAt: Date.now() }),
          tokens: entry.tokens ?? sessionTokens,
          cost: costApplied.cost,
          costPartial: costApplied.costPartial,
          costComplete: costApplied.costComplete,
          model: entry.model ?? sessionModel,
          todoTotal: entry.todoTotal ?? sessionTodo?.total,
          todoDone: entry.todoDone ?? sessionTodo?.done,
          error: errorMsg || entry.error,
        })
        changed = true
      }
      if (!changed && sessionAgent) {
        const nowTs = Date.now()
        const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "")
        const saNorm = normalize(sessionAgent)
        let best: { id: string; gap: number } | null = null

        // Phase 1: try matching by agent name（agent 名有交集）
        for (const [id, entry] of next) {
          if (entry.status !== "running") continue
          const eaNorm = normalize(entry.agent)
          if (!eaNorm || !saNorm) continue
          if (!eaNorm.includes(saNorm) && !saNorm.includes(eaNorm)) continue
          const gap = nowTs - (entry.startedAt || 0)
          if (!best || gap > best.gap) best = { id, gap }
        }

        // Phase 2: if agent name has no overlap (e.g. category calls: agent="deep" vs sessionAgent="Sisyphus-Junior"),
        // fall back to time proximity for entries that have no sessionId yet
        if (!best) {
          for (const [id, entry] of next) {
            if (entry.status !== "running") continue
            if (entry.sessionId) continue
            const gap = nowTs - (entry.startedAt || 0)
            if (!best || gap > best.gap) best = { id, gap }
          }
        }

        if (best) {
          const entry = next.get(best.id)!
          const costApplied = applyCostInfo(entry, sessionCostInfo)
          next.set(best.id, {
            ...entry, status, endedAt: nowTs,
            tokens: sessionTokens || entry.tokens,
            cost: costApplied.cost,
            costPartial: costApplied.costPartial,
            costComplete: costApplied.costComplete,
            sessionId: sid,
            error: errorMsg || entry.error,
          })
          changed = true
        }
      }
      return changed ? next : prev
    })

    // 当子代理所属的父 session 与当前视图不同时，通过模块级缓存定位
    // 并更新父 session 的 entry 状态，随后写回 KV。
    try {
      const sessionObj = props.api.state.session.get(sid)
      const parentSid = sessionObj?.parentID
      if (parentSid && parentSid !== props.sessionId) {
        // 优先从模块级缓存获取父 session 的 entries，不受当前视图切换影响
        const parentCache = globalEntryCache.get(parentSid)
        const nowTs = Date.now()
        let found = false

        if (parentCache) {
          found = tryMatchAndUpdate(parentCache, sid, status, nowTs)
        }

        // 缓存未命中时回退到 KV 读取
        if (!found) {
          const data = loadSessionData()
          const rec = data[parentSid]
          if (rec?.entries) {
            const fallbackMap = new Map(rec.entries.map((e: SubEntry) => [e.id, e]))
            found = tryMatchAndUpdate(fallbackMap, sid, status, nowTs)
            if (found) {
              // 回退命中后写入 KV 并回填缓存
              data[parentSid] = { ...rec, ts: nowTs, entries: [...fallbackMap.values()] }
              saveSessionData(data)
              globalEntryCache.set(parentSid, fallbackMap)
            }
          }
        }

        // 将模块级缓存中的最新状态同步到 KV
        if (found && parentCache) {
          const data = loadSessionData()
          data[parentSid] = { ...data[parentSid], ts: nowTs, entries: [...parentCache.values()] }
          saveSessionData(data)
        }
      }
    } catch {}

    // Delayed backfill: re-read data after state sync catches up, to capture the final
    // token/cost values that may not have been available when session.idle fired.
    // Retried twice: the paginated cost aggregation is debounced + async, so the
    // first pass may still see the pre-computation state.
    const backfill = () => {
      if (disposed) return
      const finalTokens = readSessionTokens(sid)
      const finalCostInfo = readSessionCostFromMetrics(sid)
      const finalModel = readSessionModel(sid)
      const finalTodo = readSessionTodo(sid)
      setEntryMap((prev) => {
        let changed = false
        const next = new Map(prev)
        for (const [id, entry] of next) {
          if (entry.sessionId !== sid) continue
          const t = finalTokens ?? entry.tokens
          const costApplied = applyCostInfo(entry, finalCostInfo)
          const c = costApplied.cost
          const m = finalModel ?? entry.model
          const tt = finalTodo?.total ?? entry.todoTotal
          const td = finalTodo?.done ?? entry.todoDone
          if (t !== entry.tokens || c !== entry.cost || m !== entry.model ||
              costApplied.costPartial !== entry.costPartial ||
              costApplied.costComplete !== entry.costComplete ||
              tt !== entry.todoTotal || td !== entry.todoDone) {
            next.set(id, {
              ...entry, tokens: t,
              cost: costApplied.cost, costPartial: costApplied.costPartial, costComplete: costApplied.costComplete,
              model: m, todoTotal: tt, todoDone: td,
            })
            changed = true
          }
        }
        return changed ? next : prev
      })
      bump()
    }
    setTimeout(backfill, 400)
    setTimeout(backfill, 1200)
  }

  // ── bumpRenderTick: force re-render (visual-cache pattern) ──
  const bump = () => setRenderTick((v) => v + 1)

  onMount(() => {
    // Fast clock for smooth time display, separate from token polling
    const clock = setInterval(() => { setNow(Date.now()); bump() }, 100)
    // Token poll — runs every 500ms for running entries
    const tokenTimer = setInterval(() => {
      untrack(() => {
        setEntryMapRaw((prev) => {
          let changed = false
          const next = new Map(prev)
          for (const [id, entry] of next) {
            if (entry.status === "running" && entry.sessionId) {
              // Only read from child sessions, never the parent
              let isChild = false
              try {
                const s = props.api.state.session.get(entry.sessionId)
                isChild = s?.parentID === props.sessionId
              } catch {}
              if (!isChild) continue
              const total = readSessionTokens(entry.sessionId)
              const todo = readSessionTodo(entry.sessionId)
              const model = entry.model ?? readSessionModel(entry.sessionId)
              const costInfo = readSessionCostFromMetrics(entry.sessionId)
              const nextEntry: SubEntry = { ...entry }
              if (total !== undefined && total !== entry.tokens) { nextEntry.tokens = total; changed = true }
              if (todo !== undefined) {
                if (todo.total !== entry.todoTotal || todo.done !== entry.todoDone) {
                  nextEntry.todoTotal = todo.total; nextEntry.todoDone = todo.done; changed = true
                }
              }
              if (model && !entry.model) { nextEntry.model = model; changed = true }
              if (costInfo) {
                const costApplied = applyCostInfo(entry, costInfo)
                if (costApplied.cost !== entry.cost ||
                    costApplied.costPartial !== entry.costPartial ||
                    costApplied.costComplete !== entry.costComplete) {
                  nextEntry.cost = costApplied.cost
                  nextEntry.costPartial = costApplied.costPartial
                  nextEntry.costComplete = costApplied.costComplete
                  changed = true
                }
              }
              if (changed) next.set(id, nextEntry)
            }
          }
          return changed ? next : prev
        })
      })
      bump()
    }, 500)
    bump()

    const unsubPart = props.api.event.on("message.part.updated", (e) => {
      handlePartUpdated(e)
      bump()
    })
    const unsubMsg = props.api.event.on("message.updated", () => bump())
    const unsubIdle = props.api.event.on("session.idle", (e) => {
      handleSessionEnd(e, "done")
      bump()
    })
    const unsubError = props.api.event.on("session.error", (e) => {
      handleSessionEnd(e, "error")
      bump()
    })

    onCleanup(() => {
      disposed = true
      for (const unsubscribe of metricUnsubscribers) unsubscribe()
      metricUnsubscribers = []
      clearInterval(clock)
      clearInterval(tokenTimer)
      clearTimeout(persistTimer)
      unsubPart()
      unsubMsg()
      unsubIdle()
      unsubError()
    })
  })

  // ── session‑switch & initial‑load scan ──
  // On session change: load from kv (entries survive component unmount), then scan+merge.
  // On same session: only scan+merge (keep event‑driven running entries).
  let lastSid = props.sessionId
  let lastTick = 0
  createEffect(() => {
    const sid = props.sessionId
    const switched = sid !== lastSid
    lastSid = sid
    const tick = clearTick()    // 外部触发清除时 +1，effect 重跑
    const forceReload = tick !== lastTick && !switched
    lastTick = tick
    const t = setTimeout(() => {
      untrack(() => {
        if (switched) {
          const { parentSid, isChild } = resolveParent(sid)
          const data = loadSessionData()
          const saved = isChild
            ? data[parentSid]?.children?.[sid]?.scroll ?? 0
            : data[sid]?.scroll ?? 0
          setScrollOffset(saved)
          // 刷新父会话的访问时间 TTL，防止活跃会话的数据过期
          if (!isChild && data[sid]?.entries?.length) {
            data[sid].ts = Date.now()
            saveSessionData(data)
          }
        }
        // scan uses setEntryMapRaw — ephemeral data, not persisted to kv.
        // Only event-driven changes (handlePartUpdated, handleSessionEnd) persist.
        setEntryMapRaw((prev) => {
          // 优先从模块级缓存加载，KV 仅作缓存未命中时的回退
          const next = (switched || forceReload)
            ? new Map(globalEntryCache.get(sid) ?? loadEntries(sid))
            : new Map(prev)
          // 从 KV 加载当前会话的清除名单，扫描时跳过被手动清除的历史条目
          const { parentSid: scanPSid, isChild: scanChild } = resolveParent(sid)
          const scanRec = loadSessionData()[scanPSid]
          const clearedIds = new Set(scanChild ? scanRec?.children?.[sid]?.clearedIds : scanRec?.clearedIds)
          try {
            const msgs = props.api.state.session.messages(sid)
            if (msgs && (msgs as any[]).length) {
              for (const msg of msgs) {
                const parts = props.api.state.part(msg.id) ?? []
                for (const partRaw of parts) {
                  const part = partRaw as Record<string, unknown>

                  // Subtask entries are purely event-driven — never created by scan.
                  // (SubtaskPart exists from spawn, not completion, so we cannot infer status.)
                  if (part.type === "tool") {
                    const tool = String((part as any).tool ?? "")
                    if (!SUBAGENT_TOOLS.has(tool)) continue
                    const id = `tool:${String(part.id ?? "")}`
                    if (!part.id) continue

                    const st = (part as any).state as Record<string, unknown> | undefined
                    const rawStatus = String(st?.status ?? "")
                    const exists = next.get(id)

                    // 已手动清除的条目：scan 发现但不在内存 → 跳过重建
                    if (!exists && clearedIds.has(id)) continue

                    // Only create entries for tool calls that entered execution.
                    // "pending" / empty: skip new entries; allow heuristics for existing ones below.
                    if ((rawStatus === "pending" || rawStatus === "") && !exists) continue

                    // "error": only update existing, never create a new entry
                    if (rawStatus === "error") {
                      if (exists && exists.status === "running") {
                        next.set(id, { ...exists, status: "error", endedAt: Date.now() })
                      }
                      continue
                    }

                    let status: SubStatus = "running"
                    if (rawStatus === "completed") status = "done"
                    // Background tasks: tool completion ≠ agent completion — keep running until session.idle
                    // Only keep running if state metadata confirms a child session was spawned.
                    if (((st?.input as Record<string, unknown> | undefined)?.run_in_background === true || (st?.input as Record<string, unknown> | undefined)?.background === true) && status === "done") {
                      const scanStMeta = st?.metadata as Record<string, unknown> | undefined
                      const scanHasChild = scanStMeta?.session_id !== undefined || scanStMeta?.sessionId !== undefined
                      if (scanHasChild) status = "running"
                    }

                    // Already settled → skip
                    if (exists && exists.status !== "running") continue
                    // Running entry with no explicit status improvement from part:
                    // try message-level heuristics first, then time-based fallback.
                    if (exists && status === "running") {
                      if (!rawStatus) {
                        const msgTokens = (msg as any)?.tokens as Record<string, unknown> | undefined
                        if (msgTokens && (Number(msgTokens.input) > 0 || Number(msgTokens.output) > 0)) {
                          status = "done"  // LLM returned tokens → agent completed
                        } else if (Date.now() - exists.startedAt > 30 * 60 * 1000) {
                          status = "done"  // >30 min idle → assume completed
                        } else {
                          continue
                        }
                      } else {
                        continue
                      }
                    }

                    // If already tracked as running but tool state says completed/error → update
                    // If not tracked → add fresh

                    const input = st?.input as Record<string, unknown> | undefined
                    const agent = String((part as any).subagent_type ?? input?.subagent_type ?? tool)
                    const prompt = String(input?.prompt ?? (part as any).description ?? "")
                    const desc = input?.description !== undefined ? String(input.description) : ""
                    const title = desc || truncate(prompt.replace(/\n/g, " ").trim(), 40)

                    let tokens: number | undefined
                    const scanStMeta2 = st?.metadata as Record<string, unknown> | undefined
                    const scanSubSid = scanStMeta2?.session_id !== undefined ? String(scanStMeta2.session_id)
                      : scanStMeta2?.sessionId !== undefined ? String(scanStMeta2.sessionId)
                      : undefined
                    if (scanSubSid) tokens = readSessionTokens(scanSubSid)

                    const ended = status === "done"  // "error" handled above, never reaches here
                    next.set(id, {
                      id, title, agent, prompt,
                      // Preserve existing values (from handleSessionEnd / KV) — scan must not overwrite
                      tokens: exists?.tokens ?? tokens,
                      sessionId: exists?.sessionId ?? scanSubSid,
                      status,
                      startedAt: exists?.startedAt || Date.now(),
                      endedAt: ended ? (exists?.endedAt || Date.now()) : undefined,
                    })
                  }
                }
              }
            }
          } catch {}
          return next
        })
        // Reconcile: check running entries against live child session status.
        // Covers session.idle events missed while user was inside a child session.
        setEntryMapRaw((prev) => {
          let changed = false
          const next = new Map(prev)
          for (const [id, entry] of next) {
            if (entry.status !== "running" || !entry.sessionId) continue
            try {
              const st = props.api.state.session.status(entry.sessionId)
              if (!st || st.type !== "idle") continue
              const tokens = readSessionTokens(entry.sessionId)
              const costInfo = readSessionCostFromMetrics(entry.sessionId)
              const costApplied = applyCostInfo(entry, costInfo)
              next.set(id, {
                ...entry, status: "done" as SubStatus, endedAt: Date.now(),
                tokens: tokens ?? entry.tokens,
                cost: costApplied.cost,
                costPartial: costApplied.costPartial,
                costComplete: costApplied.costComplete,
              })
              changed = true
            } catch {}
          }
          return changed ? next : prev
        })
        // First display / session switch: ask the shared service to compute
        // costs for every tracked child session (idempotent, debounced and
        // in-flight-merged by the service, so no refresh loops).
        try {
          const childSids = new Set<string>()
          for (const [, entry] of entryMap()) {
            if (entry.sessionId) childSids.add(entry.sessionId)
          }
          for (const childSid of childSids) props.metrics.refresh(childSid)
        } catch {}
        bump()
      })
    }, 150)
    onCleanup(() => clearTimeout(t))
  })

  // ── palette ──
  const pal = createMemo(() => {
    const th = props.theme
    return {
      primary: th.primary,
      text: th.text,
      muted: th.textMuted,
      success: th.success,
      warning: th.warning,
      error: th.error,
      border: th.border,
    }
  })

  // ── derived signals ──
  // Stable list — only changes when entryMap changes
  const entryList = createMemo(() => {
    const entries = [...entryMap().values()]
    if (props.sortOrder() === "desc") {
      return entries.sort((a, b) => b.startedAt - a.startedAt)
    }
    return entries.sort((a, b) => a.startedAt - b.startedAt)
  })

  const max = props.maxEntries
  const clampedOffset = createMemo(() => {
    const total = entryList().length
    const m = max()
    if (total <= m) return 0
    return Math.min(scrollOffset(), total - m)
  })
  const visibleList = createMemo(() => entryList().slice(clampedOffset(), clampedOffset() + max()))
  const hiddenAbove = createMemo(() => clampedOffset())
  const hiddenBelow = createMemo(() => Math.max(0, entryList().length - clampedOffset() - max()))

  // Drop hover state when ↑ more disappears (hiddenAbove hits zero)
  createEffect(() => {
    if (hiddenAbove() === 0) setHoveredMoreAbove(false)
  })

  // Reset scroll on sort order change: jump to newest in view
  let sortInitialized = false
  createEffect(() => {
    props.sortOrder()
    if (!sortInitialized) { sortInitialized = true; return }
    const total = untrack(() => entryList().length)
    const m = untrack(() => max())
    const target = props.sortOrder() === "desc" ? 0 : Math.max(0, total - m)
    setScrollOffset(target)
    setTimeout(() => {
      try { persistScroll(props.sessionId, target) } catch {}
    }, 0)
  })

  // When new entries arrive while viewing the newest end, keep the view at newest
  let prevEntryCount = 0
  createEffect(() => {
    const total = entryList().length
    if (prevEntryCount === 0) { prevEntryCount = total; return }
    if (total === prevEntryCount) return

    const m = max()
    const wasAtNewest = props.sortOrder() === "desc"
      ? untrack(() => scrollOffset() === 0)
      : untrack(() => scrollOffset() >= prevEntryCount - m)

    prevEntryCount = total

    if (wasAtNewest) {
      const target = props.sortOrder() === "desc" ? 0 : Math.max(0, total - m)
      setScrollOffset(target)
      setTimeout(() => {
        try { persistScroll(props.sessionId, target) } catch {}
      }, 0)
    }
  })

  const entries = createMemo(() => {
    const nowVal = now()
    return entryList().map((e) => ({
      ...e,
      elapsed: (e.endedAt ?? nowVal) - e.startedAt,
    }))
  })

  const doneCount = createMemo(() => entryList().filter((e) => e.status === "done").length)
  const runningCount = createMemo(() => entryList().filter((e) => e.status === "running").length)
  const errCount = createMemo(() => entryList().filter((e) => e.status === "error").length)
  const anyEntry = () => entryList().length > 0

  const totalTokens = createMemo(() => {
    let sum = 0
    for (const e of entryList()) { if (e.tokens) sum += e.tokens }
    return sum
  })

  const totalCostUsd = createMemo(() => {
    let sum = 0
    for (const e of entryList()) {
      if (e.cost !== undefined && e.costComplete !== false) sum += e.cost
    }
    return sum
  })

  /** True when any displayed entry is a partial (unpriced) estimate. */
  const totalCostPartial = createMemo(() =>
    entryList().some((e) => e.cost !== undefined && e.costComplete !== false && e.costPartial === true),
  )

  createEffect(() => {
    const list = entryList()
    const withCost = list.filter((entry) => entry.cost !== undefined && entry.costComplete !== false)
    props.onCostSummary?.({
      usd: withCost.reduce((sum, entry) => sum + (entry.cost ?? 0), 0),
      hasUsage: withCost.length > 0,
      partial: withCost.some((entry) => entry.costPartial === true),
      complete: list.every((entry) => !entry.sessionId || entry.costComplete === true),
    })
  })

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = prev === id ? undefined : id
      try { persistExpanded(props.sessionId, next ?? "") } catch {}
      return next
    })
  }

  // ── expanded detail right-align ──
  const expandedMaxLabelW = createMemo(() => {
    const labels = [
      t("agent.label"), t("status.label"), t("time.label"), t("tokens.label"),
      t("error.label"), t("cost.label"), t("model.label"), t("todo.label"), t("session.label"),
    ]
    return Math.max(...labels.map(l => visualWidth(l + ": ")))
  })

  const expandedPad = (label: string) => Math.max(0, expandedMaxLabelW() - visualWidth(label + ": "))

  const expandedValAvail = () => Math.max(6, panelWidth() - INDENT - expandedMaxLabelW())

  // ── header parts for colored spans ──
  const summaryParts = createMemo(() => {
    if (!anyEntry()) return null
    const cost = totalCostUsd()
    const costPartial = totalCostPartial()
    return {
      done: `${doneCount()}`,
      running: runningCount() > 0 ? `${runningCount()}` : null,
      err: errCount() > 0 ? `${errCount()}` : null,
      duration: totalTokens() > 0 ? fmtTokens(totalTokens()) : "",
      costText: costPartial && cost === 0 ? "未定价" : cost > 0 || costPartial ? `$${cost.toFixed(2)}${costPartial ? "+" : ""}` : "",
    }
  })

  const valueCols = (label: string) =>
    Math.max(4, panelWidth() - INDENT - visualWidth(label + ": "))

  // ── render ──
  return (
    <box
      border={false}
      paddingTop={0} paddingBottom={0} paddingLeft={0} paddingRight={0}
      flexDirection="column" gap={0}
      ref={boxEl}
      onSizeChange={() => {
        const w = boxEl ? Math.max(20, boxEl.width ?? 0) : 28
        setPanelWidth((prev) => (prev === w ? prev : w))
      }}
    >
      <box
        flexDirection="row"
        gap={1}
        onMouseDown={() => {
          setOpen((o) => {
            const n = !o
            try { props.api.kv.set(`${KV_PREFIX}.open`, n) } catch {}
            return n
          })
          bump()
        }}
      >
        <text fg={pal().text}>{open() ? "▼" : "▶"}</text>
        <text fg={pal().text}><b>{t("panel.title")}</b></text>
        {anyEntry() ? (
          <text>
            <span style={{ fg: pal().success }}>✓{summaryParts()!.done}</span>
            {runningCount() > 0 ? <span style={{ fg: pal().warning }}> ●{summaryParts()!.running}</span> : ""}
            {errCount() > 0 ? <span style={{ fg: pal().error }}> ✕{summaryParts()!.err}</span> : ""}
            {summaryParts()!.duration ? <span style={{ fg: pal().muted }}> {summaryParts()!.duration}</span> : ""}
            {summaryParts()!.costText ? <span style={{ fg: pal().primary }}> {summaryParts()!.costText}</span> : ""}
          </text>
        ) : null}
      </box>

      {/* ── panel body ── */}
      <Show when={open()}>
        <Show
          when={anyEntry()}
          fallback={
            <text style={{ fg: pal().muted }}>
              {"  "}&gt; {t("status.none")}  {/* empty indent kept for visual balance */}
            </text>
          }
        >
          <box
            onMouseScroll={(e) => {
              if (props.scrollMode() === "click") return
              const total = entryList().length
              const m = max()
              if (total <= m) return
              const dir = e.button === 0 ? 1 : -1
              setScrollOffset((prev) => {
                const next = Math.max(0, Math.min(prev + dir, total - m))
                try { persistScroll(props.sessionId, next) } catch {}
                return next
              })
            }}
          >
            <Show when={hiddenAbove() > 0}>
              <text
                onMouseOver={() => setHoveredMoreAbove(true)}
                onMouseOut={() => setHoveredMoreAbove(false)}
                onMouseUp={() => {
                  const total = entryList().length
                  const m = max()
                  if (total <= m) return
                  const next = Math.max(0, scrollOffset() - m)
                  if (next === 0) {
                    setTimeout(() => {
                      setScrollOffset(next)
                      try { persistScroll(props.sessionId, next) } catch {}
                    }, 0)
                  } else {
                    setScrollOffset(next)
                    try { persistScroll(props.sessionId, next) } catch {}
                  }
                }}
              >
                <span style={{ fg: hoveredMoreAbove() ? pal().warning : pal().muted }}>
                  {"  "}&uarr; {hiddenAbove()} {t("scroll.more")}
                </span>
              </text>
            </Show>
            <For each={visibleList()}>
              {(entry) => {
              const isExpanded = () => expanded() === entry.id
              const isRunning = entry.status === "running"
              const isError = entry.status === "error"
              const elapsed = () => (entry.endedAt ?? now()) - entry.startedAt

              const statusDot = () => "\u25cf"
              const statusColor = () => {
                if (!isRunning) return isError ? pal().error : pal().success
                return pal().warning
              }

              const timeColor = () =>
                isRunning ? pal().warning : isError ? pal().error : pal().muted

              // Entry label: collapsed shows title only, expanded shows title only too
              const tokenText = () =>
                !isExpanded() && entry.tokens !== undefined && entry.tokens > 0
                  ? ` ${fmtTokens(entry.tokens!)}`
                  : ""
              const timeText = () =>
                !isExpanded() && (elapsed() >= 2000 || entry.endedAt !== undefined)
                  ? fmtDurationShort(elapsed(), isRunning)
                  : ""
              const suffixW = () => {
                let w = 0
                const t = timeText()
                if (t) w += 1 + visualWidth(t)
                const tk = tokenText()
                if (tk) w += visualWidth(tk)
                return w
              }
              const labelAvail = () => Math.max(6, panelWidth() - LEFT_PAD - suffixW())
              const labelText = () => {
                const max = labelAvail()
                const text = entry.title || entry.agent
                const truncated = truncate(text, max)
                const pad = Math.max(0, max - visualWidth(truncated))
                return truncated + " ".repeat(pad)
              }

              return (
                <>
                  {/* entry line — left-aligned */}
                  <text onMouseUp={() => toggleExpand(entry.id)}>
                    <span style={{ fg: pal().muted }}>
                      {isExpanded() ? "\u25bc" : "\u25b6"}
                    </span>
                    {" "}
                    <span style={{ fg: statusColor() }}>{statusDot()}</span>
                    {" "}
                    <span style={{ fg: pal().text }}>{labelText()}</span>
                    {timeText() ? (
                      <>
                        {" "}
                        <span style={{ fg: timeColor() }}>{timeText()}</span>
                      </>
                    ) : null}
                    {tokenText() ? (
                      <span style={{ fg: pal().muted }}>{tokenText()}</span>
                    ) : null}
                  </text>

                  {/* expanded detail — right-aligned values */}
                  <Show when={isExpanded()}>
                    <text>
                      {"  "}
                      <span style={{ fg: pal().primary }}>{t("agent.label")}: </span>
                      <span style={{ fg: pal().muted }}>{" ".repeat(expandedPad(t("agent.label")))}</span>
                      <span style={{ fg: pal().muted }}>{entry.agent}</span>
                    </text>
                    <text>
                      {"  "}
                      <span style={{ fg: pal().primary }}>{t("status.label")}: </span>
                      <span style={{ fg: pal().muted }}>{" ".repeat(expandedPad(t("status.label")))}</span>
                      <span style={{ fg: isRunning ? pal().warning : isError ? pal().error : pal().success }}>
                        {isRunning ? t("status.running") : isError ? t("status.error") : t("status.done")}
                      </span>
                    </text>
                    <Show when={elapsed() >= 2000 || entry.endedAt !== undefined}>
                      <text>
                        {"  "}
                        <span style={{ fg: pal().primary }}>{t("time.label")}: </span>
                        <span style={{ fg: pal().muted }}>{" ".repeat(expandedPad(t("time.label")))}</span>
                        <span style={{ fg: pal().muted }}>
                          {fmtDurationShort(elapsed(), isRunning)}
                        </span>
                      </text>
                    </Show>
                    <Show when={entry.tokens !== undefined}>
                      <text>
                        {"  "}
                        <span style={{ fg: pal().primary }}>{t("tokens.label")}: </span>
                        <span style={{ fg: pal().muted }}>{" ".repeat(expandedPad(t("tokens.label")))}</span>
                        <span style={{ fg: pal().muted }}>{fmtTokens(entry.tokens!)}</span>
                      </text>
                    </Show>
                    <Show when={entry.error}>
                      <text>
                        {"  "}
                        <span style={{ fg: pal().error }}>{t("error.label")}: </span>
                        <span style={{ fg: pal().muted }}>{" ".repeat(expandedPad(t("error.label")))}</span>
                        <span style={{ fg: pal().error }}>{truncate(String(entry.error), expandedValAvail())}</span>
                      </text>
                    </Show>
                    <Show when={entryCostText(entry) !== null}>
                      {(() => {
                        const costText = entryCostText(entry)!
                        return (
                          <text>
                            {"  "}
                            <span style={{ fg: pal().primary }}>{t("cost.label")}: </span>
                            <span style={{ fg: pal().muted }}>{" ".repeat(expandedPad(t("cost.label")))}</span>
                            <span style={{ fg: pal().muted }}>{costText}</span>
                          </text>
                        )
                      })()}
                    </Show>
                    <Show when={entry.model}>
                      <text>
                        {"  "}
                        <span style={{ fg: pal().primary }}>{t("model.label")}: </span>
                        <span style={{ fg: pal().muted }}>{" ".repeat(expandedPad(t("model.label")))}</span>
                        <span style={{ fg: pal().muted }}>{truncate(entry.model!, expandedValAvail())}</span>
                      </text>
                    </Show>
                    <Show when={entry.todoTotal !== undefined}>
                      <text>
                        {"  "}
                        <span style={{ fg: pal().primary }}>{t("todo.label")}: </span>
                        <span style={{ fg: pal().muted }}>{" ".repeat(expandedPad(t("todo.label")))}</span>
                        <span style={{ fg: pal().muted }}>{entry.todoDone}/{entry.todoTotal}</span>
                      </text>
                    </Show>
                    <Show when={entry.sessionId}>
                      <text
                        onMouseUp={() => {
                          if (entry.sessionId) {
                            props.api.ui.toast({
                              title: entry.title || entry.agent,
                              message: `${entry.sessionId}\n\n${t("session.toast.copy")}`,
                              duration: 8000,
                            })
                          }
                        }}
                      >
                        {"  "}
                        <span style={{ fg: pal().primary }}>{t("session.label")}: </span>
                        <span style={{ fg: pal().muted }}>{" ".repeat(expandedPad(t("session.label")))}</span>
                        <span style={{ fg: pal().muted }}>{truncate(entry.sessionId!, expandedValAvail() - visualWidth(" ⎘"))}</span>
                        <span style={{ fg: pal().warning }}> ⎘</span>
                      </text>
                    </Show>
                    {/* 进入会话 + 标记完成：同排左右两端，空间隔离防误触 */}
                    <Show when={entry.sessionId || isRunning}>
                      {(() => {
                        const dismissLabel = () => `- ${t("dismiss.label")}`
                        const openPrefix = () => "  \u2192 "
                        const openFull = () => entry.sessionId ? openPrefix() + t("open.label") : ""
                        const openW = () => entry.sessionId ? visualWidth(openFull()) : 0
                        const spacerW = () => Math.max(1, panelWidth() - openW() - visualWidth(dismissLabel()) - 2 /* indent */)
                        return (
                          <box flexDirection="row">
                            <Show when={entry.sessionId}
                              fallback={<text>{"  "}</text>}
                            >
                              <text
                                onMouseOver={() => setHoveredOpen(entry.id)}
                                onMouseOut={() => setHoveredOpen(undefined)}
                                onMouseUp={() => {
                                  if (entry.sessionId) {
                                    props.api.route.navigate("session", { sessionID: entry.sessionId })
                                  }
                                }}
                              >
                                <span style={{ fg: hoveredOpen() === entry.id ? pal().warning : pal().primary }}>{openPrefix()}</span>
                                <span style={{ fg: hoveredOpen() === entry.id ? pal().warning : pal().primary }}>{t("open.label")}</span>
                              </text>
                            </Show>
                            <Show when={isRunning}>
                              <>
                                <text style={{ fg: pal().muted }}>{" ".repeat(spacerW())}</text>
                                <text
                                  onMouseOver={() => setHoveredDismiss(entry.id)}
                                  onMouseOut={() => setHoveredDismiss(undefined)}
                                  onMouseUp={() => {
                                    upsertEntry({ id: entry.id, title: entry.title, agent: entry.agent, prompt: entry.prompt, status: "done" })
                                  }}
                                >
                                  <span style={{ fg: hoveredDismiss() === entry.id ? pal().warning : pal().muted }}>{dismissLabel()}</span>
                                </text>
                              </>
                            </Show>
                          </box>
                        )
                      })()}
                    </Show>
                  </Show>
                </>
              )
            }}
            </For>
            <Show when={hiddenBelow() > 0 || (props.sortOrder() === "desc" ? scrollOffset() > 0 : entryList().length > max() && clampedOffset() < entryList().length - max())}>
              {(() => {
                const showMore = hiddenBelow() > 0
                const showTop = props.sortOrder() === "desc"
                  ? scrollOffset() > 0
                  : entryList().length > max() && clampedOffset() < entryList().length - max()
                const left = showMore ? `  \u2193 ${hiddenBelow()} ${t("scroll.more")}` : "  "
                const right = props.sortOrder() === "desc"
                  ? `\u2191 ${t("scroll.top")}`
                  : `\u2193 ${t("scroll.bottom")}`
                const pad = showTop ? Math.max(1, panelWidth() - visualWidth(left) - visualWidth(right)) : 0
                return (
                  <box flexDirection="row">
                    <text
                      onMouseOver={() => showMore && setHoveredMoreBelow(true)}
                      onMouseOut={() => setHoveredMoreBelow(false)}
                      onMouseUp={() => {
                        if (!showMore) return
                        const total = entryList().length
                        const m = max()
                        if (total <= m) return
                        setScrollOffset((prev) => Math.min(total - m, prev + m))
                        try { persistScroll(props.sessionId, scrollOffset()) } catch {}
                        setHoveredMoreBelow(false)
                      }}
                    >
                      <span style={{ fg: showMore && hoveredMoreBelow() ? pal().warning : pal().muted }}>
                        {left}
                      </span>
                    </text>
                    {showTop ? (
                      <>
                        <text style={{ fg: pal().muted }}>{" ".repeat(pad)}</text>
                        <text
                          onMouseOver={() => setHoveredTop(true)}
                          onMouseOut={() => setHoveredTop(false)}
                          onMouseUp={() => {
                            const total = entryList().length
                            const m = max()
                            if (props.sortOrder() === "desc") {
                              setScrollOffset(0)
                            } else {
                              setScrollOffset(Math.max(0, total - m))
                            }
                            setHoveredTop(false)
                          }}
                        >
                          <span style={{ fg: hoveredTop() ? pal().warning : pal().muted }}>{right}</span>
                        </text>
                      </>
                    ) : null}
                  </box>
                )
              })()}
            </Show>
          </box>
        </Show>
      </Show>
    </box>
  )
}

// ===================================================================
// Plugin entry
// ===================================================================

export interface SharedSignals {
  lang: () => Lang
  maxEntries: () => number
  sortOrder: () => SortOrder
  scrollMode: () => ScrollMode
}

export const KV_PREFIX = "subagent_magazine"

export function createSubAgentSignals(api: TuiPluginApi): SharedSignals {
  const [lang] = createSignal<Lang>("zh")
  const [maxEntries] = createSignal(
    Math.max(1, Math.min(50, parseInt(String(api.kv.get(`${KV_PREFIX}.max_entries`, "10")), 10) || 10)),
  )
  const [sortOrder] = createSignal<SortOrder>(
    String(api.kv.get(`${KV_PREFIX}.order`, "desc")) === "asc" ? "asc" : "desc",
  )
  const [scrollMode] = createSignal<ScrollMode>(
    String(api.kv.get(`${KV_PREFIX}.scroll_mode`, "wheel")) === "click" ? "click" : "wheel",
  )

  return { lang, maxEntries, sortOrder, scrollMode }
}
