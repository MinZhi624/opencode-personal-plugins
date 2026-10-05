/**
 * Task tracker — read-only source adapters.
 *
 * Two adapters translate the two Matt-supported trackers into the shared,
 * non-sensitive `Snapshot` vocabulary declared in `./model.ts`:
 *
 * - **local**  — reads the current project's `.scratch/<feature>/issues/NN-*.md`
 *   Matt tickets (spec / map index files are never treated as tickets).
 * - **github** — reads the current repository's open issues read-only through the
 *   `gh` CLI, with full pagination, PR-exclusion, and native-first blocking
 *   with a body-convention fallback.
 *
 * Everything here is strictly read-only: no file is written, no issue is
 * created/edited/closed, and no credential is ever emitted to a caller. All
 * failures surface as a `TaskSourceError` carrying a pre-sanitised message, so
 * nothing that leaks `gh` stderr (which may carry tokens or paths) crosses the
 * boundary. The server's working directory is the source authority; a caller
 * never supplies a directory.
 */

import { spawn } from "node:child_process"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import type { Dirent } from "node:fs"
import type { Snapshot, Source, Task } from "./model.ts"

/** A safe, caller-facing failure. `safeMessage` never contains credentials or raw stderr. */
export class TaskSourceError extends Error {
  readonly safeMessage: string
  constructor(safeMessage: string) {
    super(safeMessage)
    this.name = "TaskSourceError"
    this.safeMessage = safeMessage
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TaskSourceError("读取已取消")
}

/** Resolve `candidate`'s real path and ensure it does not escape `rootReal` via symlink. */
async function realpathWithin(rootReal: string, candidate: string): Promise<string | null> {
  try {
    const real = await fsp.realpath(candidate)
    if (real === rootReal || real.startsWith(rootReal + path.sep)) return real
    return null
  } catch {
    return null
  }
}

async function resolveRootReal(root: string): Promise<string> {
  try {
    return await fsp.realpath(root)
  } catch {
    throw new TaskSourceError("无法访问项目目录")
  }
}

// ---------------------------------------------------------------------------
// Small shared parsers
// ---------------------------------------------------------------------------

/** Extract acceptance checkboxes, preserving the original check marker. Never used to infer completion. */
function checkboxCriteria(text: string | undefined): string[] {
  if (!text) return []
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*-\s*\[([ xX])\]\s*(.*)$/.exec(line)
    if (m) {
      const mark = m[1].toLowerCase() === "x" ? "x" : " "
      const label = m[2].trim()
      out.push(`[${mark}] ${label}`)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Local Markdown adapter (Matt `.scratch/` convention)
// ---------------------------------------------------------------------------

type ParsedTicket = {
  filenameNum: string
  title: string
  status: string // normalised lowercase; "" when the file has no Status line
  wayfinderType: boolean // a `Type:` line is present => Wayfinder decision ticket
  blockersRaw: string[] // referenced ticket numbers, as written
  unresolvableBlockerRef: boolean // a non-"None" Blocked-by value that yields no number
  criteria: string[]
}

function stripStars(s: string): string {
  return s.replace(/\*/g, "")
}

/** Extract leading ticket numbers from a "Blocked by" value; `None — …` yields none. */
function extractBlockerRefs(value: string): { refs: string[]; unresolvable: boolean } {
  const refs: string[] = []
  for (const seg of value.split(/[,\n]/)) {
    const lead = /^\s*(\d+)/.exec(seg)
    if (lead) refs.push(lead[1])
  }
  const hadContent = value.trim().length > 0
  const saidNone = /^\s*none\b/i.test(value.trim())
  const unresolvable = hadContent && !saidNone && refs.length === 0
  return { refs, unresolvable }
}

function parseTicket(content: string, filenameNum: string): ParsedTicket {
  const lines = content.split(/\r?\n/)

  let title = ""
  for (const line of lines) {
    const h = /^\s*#{1,6}\s+(.*\S)\s*$/.exec(line)
    if (h) {
      title = h[1]
      break
    }
  }
  // Drop a leading "<NN> — "/"<NN>: " number prefix from the display title.
  title = title.replace(/^\s*\d+\s*[-–—:]\s*/, "").trim() || title

  let status = ""
  let wayfinderType = false
  let blockersValue = ""
  let hasBlockersLine = false

  for (const line of lines) {
    if (/^\s*##\s/.test(line)) break // entered a section body; header block is over
    if (/^\s*-\s*\[[ xX]\]/.test(line)) break // acceptance criteria begin
    const norm = stripStars(line).trim()
    const km = /^(What to build|Blocked by|Status|Type|Spec|Priority)\s*:\s*(.*)$/i.exec(norm)
    if (!km) continue
    const key = km[1].toLowerCase()
    const value = km[2].trim()
    switch (key) {
      case "status":
        status = value.toLowerCase()
        break
      case "type":
        if (value) wayfinderType = true
        break
      case "blocked by":
        // Support both "**Blocked by:**" (to-tickets) and "Blocked by:" (wayfinder).
        blockersValue = value
        hasBlockersLine = true
        break
      default:
        break
    }
  }

  const { refs, unresolvable } = hasBlockersLine
    ? extractBlockerRefs(blockersValue)
    : { refs: [], unresolvable: false }

  return {
    filenameNum,
    title,
    status,
    wayfinderType,
    blockersRaw: refs,
    unresolvableBlockerRef: unresolvable,
    criteria: checkboxCriteria(content),
  }
}

function localSemantics(parsed: ParsedTicket): { terminal: boolean; eligible: boolean; sourceState: string } {
  const status = parsed.status
  if (parsed.wayfinderType) {
    const resolved = status === "resolved"
    const claimed = status === "claimed"
    return {
      terminal: resolved,
      eligible: !resolved && !claimed,
      sourceState: status || "open",
    }
  }
  // Implementation tickets carry no unified local terminal convention; the entry
  // stays un-terminal until a local mark corrects the sidebar view.
  return {
    terminal: false,
    eligible: status === "ready-for-agent",
    sourceState: status || "unspecified",
  }
}

/** The local source key: the `.scratch` root of the current project. */
export function localSourceKey(root: string): string {
  return path.join(root, ".scratch")
}

export async function readLocalSnapshot(
  root: string,
  projectKey: string,
  signal?: AbortSignal,
): Promise<Snapshot> {
  const syncedAt = Date.now()
  const sourceKey = localSourceKey(root)
  const rootReal = await resolveRootReal(root)
  const scratchReal = await realpathWithin(rootReal, sourceKey)
  if (!scratchReal) {
    // No local tracker directory (or it escapes the project): a successful, empty read.
    return { projectKey, source: "local", sourceKey, tasks: [], complete: true, syncedAt }
  }

  const tasks: Task[] = []
  let complete = true

  let featureEntries: Dirent[]
  try {
    featureEntries = await fsp.readdir(scratchReal, { withFileTypes: true })
  } catch {
    throw new TaskSourceError("读取本地任务目录失败")
  }

  for (const entry of featureEntries) {
    throwIfAborted(signal)
    if (!entry.isDirectory()) continue // specs / map index files and strays are not features
    const feature = entry.name
    const issuesDirReal = await realpathWithin(rootReal, path.join(scratchReal, feature, "issues"))
    if (!issuesDirReal) continue // no issues/ dir, or it points outside the project

    let files: Dirent[]
    try {
      files = await fsp.readdir(issuesDirReal, { withFileTypes: true })
    } catch {
      complete = false
      continue
    }

    const ticketFiles = files.filter(
      (f) => f.isFile() && /\.md$/i.test(f.name) && /^\s*\d/.test(f.name),
    )
    if (ticketFiles.length === 0) continue

    // Detect duplicate numbers (numeric equality) => ambiguous dependency resolution.
    const numericCount = new Map<number, number>()
    for (const f of ticketFiles) {
      const n = Number((/^\s*(\d+)/.exec(f.name) as RegExpExecArray)[1])
      numericCount.set(n, (numericCount.get(n) ?? 0) + 1)
    }
    const duplicateNumber = [...numericCount.values()].some((c) => c > 1)

    // Map number -> id for intra-feature blocker resolution.
    const numToId = new Map<number, string>()
    for (const f of ticketFiles) {
      const num = (/^\s*(\d+)/.exec(f.name) as RegExpExecArray)[1]
      const value = Number(num)
      if (!numToId.has(value)) numToId.set(value, `${feature}/${num}`)
    }

    for (const f of ticketFiles) {
      throwIfAborted(signal)
      const abs = path.join(issuesDirReal, f.name)
      const fileReal = await realpathWithin(rootReal, abs)
      if (!fileReal) continue // symlinked out of the project tree: skip, never follow

      let content: string
      try {
        content = await fsp.readFile(fileReal, "utf8")
      } catch {
        complete = false
        continue
      }

      const filenameNum = (/^\s*(\d+)/.exec(f.name) as RegExpExecArray)[1]
      const parsed = parseTicket(content, filenameNum)
      const id = `${feature}/${filenameNum}`

      const blockers: string[] = []
      const unresolvedRefs: string[] = []
      for (const ref of parsed.blockersRaw) {
        const targetId = numToId.get(Number(ref))
        if (targetId) {
          if (!blockers.includes(targetId)) blockers.push(targetId)
        } else {
          unresolvedRefs.push(ref)
        }
      }

      let problem: string | undefined
      if (duplicateNumber) problem = "功能内存在重复编号，依赖不可靠"
      else if (parsed.unresolvableBlockerRef) problem = "阻塞引用无法解析"
      else if (unresolvedRefs.length) problem = `引用了不存在的阻塞项 ${unresolvedRefs.join("、")}`

      const { terminal, eligible, sourceState } = localSemantics(parsed)
      tasks.push({
        id,
        title: parsed.title || id,
        sourceState,
        terminal,
        eligible,
        blockers,
        criteria: parsed.criteria,
        ...(problem ? { problem } : {}),
      })
    }
  }

  return { projectKey, source: "local", sourceKey, tasks, complete, syncedAt }
}

// ---------------------------------------------------------------------------
// Reliable Matt tracker-source inference (docs only; never git-remote / defaults)
// ---------------------------------------------------------------------------

/**
 * Infer the tracker source ONLY from Matt's `docs/agents/issue-tracker.md`.
 * A git remote, a stray `.scratch/` directory, or any default is NOT a reliable
 * configuration signal and must never silently pick a source. Anything other
 * than an exact Matt local-markdown / GitHub header is returned as `undefined`.
 */
export async function inferMattSource(root: string, signal?: AbortSignal): Promise<Source | undefined> {
  throwIfAborted(signal)
  const file = path.join(root, "docs", "agents", "issue-tracker.md")
  const rootReal = await resolveRootReal(root)
  const fileReal = await realpathWithin(rootReal, file)
  if (!fileReal) return undefined
  let text: string
  try {
    text = await fsp.readFile(fileReal, "utf8")
  } catch {
    return undefined
  }
  const m = /^\s*#{1,6}\s*Issue\s*tracker\s*:\s*(.+?)\s*$/im.exec(text)
  if (!m) return undefined
  const value = m[1].toLowerCase()
  if (/^github\b/.test(value)) return "github"
  if (/^local\b/.test(value) && /markdown/.test(value)) return "local"
  return undefined
}

// ---------------------------------------------------------------------------
// GitHub adapter (read-only via `gh`)
// ---------------------------------------------------------------------------

type GhIssue = {
  number: number
  title: string
  body: string
  state: "open" | "closed"
  labels: string[]
  claimed: boolean
}

type Blocker = { number: number; state: "open" | "closed" | null; title?: string }

const GH_PER_CALL_TIMEOUT_MS = 12000
const GH_LIST_TIMEOUT_MS = 18000

/** Classify a `gh` failure into a FIXED safe message. Raw stderr is never echoed. */
function classifyGhError(stderr: string): string {
  const s = (stderr || "").toLowerCase()
  if (/(401|403|not logged|authentication|bad credentials|saml|forbidden|permission|insufficient)/.test(s)) {
    return "GitHub 未鉴权或权限不足"
  }
  if (/(rate limit|secondary rate|abuse)/.test(s)) {
    return "GitHub 触发限流，请稍后重试"
  }
  if (/(could not resolve host|connection|network|timed out|timeout|enotfound|econnrefused|proxy|tls)/.test(s)) {
    return "GitHub 网络暂时不可用"
  }
  if (/(could not determine|not a git|no git|no remote|repository not found|\b404\b|not found|cannot find)/.test(s)) {
    return "无法确定或访问 GitHub 仓库"
  }
  return "读取 GitHub 仓库失败"
}

async function runGh(
  args: string[],
  opts: { cwd: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (opts.signal?.aborted) throw new TaskSourceError("读取已取消")
  const timeoutMs = opts.timeoutMs ?? GH_PER_CALL_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    // Spawn the executable directly (no shell): keeps `?`/`&` in URLs literal and
    // avoids shell-metacharacter breakage. gh.exe resolves via PATH on Windows.
    const child = spawn("gh", args, { cwd: opts.cwd })
    let out = ""
    let err = ""
    let exitCode = -1
    let settled = false
    const kill = () => {
      try {
        child.kill("SIGKILL")
      } catch {
        /* ignore */
      }
    }
    const timer = setTimeout(() => {
      kill()
      finish(new TaskSourceError("读取 GitHub 仓库超时"))
    }, timeoutMs)
    const onAbort = () => {
      kill()
      finish(new TaskSourceError("读取已取消"))
    }
    function finish(error?: TaskSourceError): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener("abort", onAbort)
      if (error) reject(error)
      else resolve({ code: exitCode, stdout: out, stderr: err })
    }
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8")
      if (out.length > 50_000_000) kill() // guard against runaway output
    })
    child.stderr?.on("data", (c: Buffer) => {
      if (err.length < 200_000) err += c.toString("utf8")
    })
    child.on("error", (e) => {
      const msg = /ENOENT/i.test(String(e)) ? "找不到 GitHub CLI（gh）" : "启动 GitHub CLI 失败"
      finish(new TaskSourceError(msg))
    })
    child.on("close", (code) => {
      exitCode = code ?? -1
      finish()
    })
    opts.signal?.addEventListener("abort", onAbort, { once: true })
  })
}

async function ghJson<T>(args: string[], opts: { cwd: string; signal?: AbortSignal; timeoutMs?: number }): Promise<T> {
  const { code, stdout, stderr } = await runGh(args, opts)
  if (code !== 0) throw new TaskSourceError(classifyGhError(stderr))
  try {
    return JSON.parse(stdout.trim() || "null") as T
  } catch {
    throw new TaskSourceError("解析 GitHub 响应失败")
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

function normalizeIssue(raw: Record<string, unknown>): GhIssue {
  const labels = Array.isArray(raw.labels)
    ? raw.labels
        .map((l) => (typeof l === "string" ? l : (l as { name?: string })?.name))
        .filter((n): n is string => typeof n === "string")
    : []
  const assignees = Array.isArray(raw.assignees) ? raw.assignees.length : 0
  return {
    number: Number(raw.number),
    title: typeof raw.title === "string" ? raw.title : "",
    body: typeof raw.body === "string" ? raw.body : "",
    state: raw.state === "closed" ? "closed" : "open",
    labels,
    claimed: assignees > 0,
  }
}

/** A Wayfinder map index or a plain/spec request is not a confirmed startable leaf. */
function ghEligible(issue: GhIssue): boolean {
  const isMap = issue.labels.includes("wayfinder:map")
  const isWayfinder = issue.labels.some((l) => /^wayfinder:(research|prototype|grilling|task)$/i.test(l))
  if (isMap) return false
  if (isWayfinder) return !issue.claimed
  if (issue.labels.includes("ready-for-agent")) return true
  return false
}

/** Extract `#n` references from a "Blocked by" section or inline "Blocked by:" line. */
function bodyBlockedNumbers(body: string | undefined): number[] {
  if (!body) return []
  const nums = new Set<number>()
  let inSection = false
  for (const line of body.split(/\r?\n/)) {
    const heading = /^\s*#{1,6}\s*(.*)$/.exec(line)
    if (heading) {
      inSection = /blocked\s*by/i.test(heading[1])
      continue
    }
    if (/^\s*blocked\s+by\s*:/i.test(line)) {
      for (const m of line.matchAll(/#(\d+)/g)) nums.add(Number(m[1]))
      continue
    }
    if (inSection) {
      for (const m of line.matchAll(/#(\d+)/g)) nums.add(Number(m[1]))
    }
  }
  return [...nums]
}

/** Native blockers via the dependencies endpoint; `null` => feature unavailable, fall back to body. */
async function nativeBlockers(
  slug: string,
  issue: GhIssue,
  cwd: string,
  signal?: AbortSignal,
): Promise<Blocker[] | null> {
  const res = await runGh(["api", `repos/${slug}/issues/${issue.number}/dependencies/blocked_by`], {
    cwd,
    signal,
    timeoutMs: GH_PER_CALL_TIMEOUT_MS,
  })
  if (res.code !== 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(res.stdout.trim() || "[]")
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const out: Blocker[] = []
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue
    const num = Number((raw as { number?: unknown }).number)
    if (!Number.isFinite(num)) continue
    const state = (raw as { state?: unknown }).state === "closed" ? "closed" : "open"
    const title = typeof (raw as { title?: unknown }).title === "string" ? (raw as { title: string }).title : undefined
    out.push({ number: num, state, title })
  }
  return out
}

/** Fetch a referenced issue's real state/title. Returns `undefined` when unreadable (=> unknown dep). */
async function fetchIssueState(
  slug: string,
  number: number,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ state: "open" | "closed"; title: string } | undefined> {
  const res = await runGh(["api", `repos/${slug}/issues/${number}`], { cwd, signal, timeoutMs: GH_PER_CALL_TIMEOUT_MS })
  if (res.code !== 0) return undefined
  let parsed: { state?: unknown; title?: unknown }
  try {
    parsed = JSON.parse(res.stdout.trim() || "{}")
  } catch {
    return undefined
  }
  return {
    state: parsed.state === "closed" ? "closed" : "open",
    title: typeof parsed.title === "string" ? parsed.title : `#${number}`,
  }
}

export async function readGithubSnapshot(
  cwd: string,
  projectKey: string,
  signal?: AbortSignal,
): Promise<Snapshot> {
  const syncedAt = Date.now()

  // 1. Determine the repo from the server's working tree (the source authority).
  const repo = await ghJson<{ nameWithOwner?: string }>(["repo", "view", "--json", "nameWithOwner"], {
    cwd,
    signal,
    timeoutMs: GH_PER_CALL_TIMEOUT_MS,
  })
  const slug = repo?.nameWithOwner
  if (!slug) throw new TaskSourceError("无法确定 GitHub 仓库")
  const sourceKey = slug

  // 2. List ALL open issues with full pagination; PRs share the endpoint, so drop them.
  const listed = await ghJson<unknown>(["api", `repos/${slug}/issues?state=open&per_page=100`, "--paginate", "--slurp"], {
    cwd,
    signal,
    timeoutMs: GH_LIST_TIMEOUT_MS,
  })
  const issues: GhIssue[] = []
  if (Array.isArray(listed)) {
    for (const page of listed) {
      if (!Array.isArray(page)) continue
      for (const raw of page) {
        if (!raw || typeof raw !== "object") continue
        if ("pull_request" in (raw as object)) continue // PR, not an issue
        issues.push(normalizeIssue(raw as Record<string, unknown>))
      }
    }
  }
  const openByNumber = new Map<number, GhIssue>()
  for (const it of issues) openByNumber.set(it.number, it)

  // 3. Per open issue: native blockers first; fall back to the body convention only
  //    when native dependencies are unavailable. Body never overrides native.
  const blockersByIssue = new Map<number, Blocker[]>()
  const declaredUnknown = new Set<number>() // referenced numbers we must resolve
  await mapLimit(issues, 5, async (it) => {
    const native = await nativeBlockers(slug, it, cwd, signal)
    let blockers: Blocker[]
    if (native) {
      blockers = native
    } else {
      const nums = bodyBlockedNumbers(it.body)
      blockers = nums.map((n) =>
        openByNumber.has(n)
          ? { number: n, state: "open" as const, title: openByNumber.get(n)!.title }
          : { number: n, state: null },
      )
    }
    blockersByIssue.set(it.number, blockers)
    for (const b of blockers) if (!openByNumber.has(b.number) && b.state === null) declaredUnknown.add(b.number)
  })

  // 4. Resolve the real state of referenced blockers that are not in the open set
  //    (closed blockers included) — never treat "absent from the open list" as done.
  const resolved = new Map<number, { state: "open" | "closed"; title: string }>()
  await mapLimit([...declaredUnknown], 5, async (n) => {
    const info = await fetchIssueState(slug, n, cwd, signal)
    if (info) resolved.set(n, info)
  })

  // 5. Assemble tasks: all open issues + any referenced closed/open blockers that
  //    were not already in the open list (so dependency lookup resolves them).
  const tasks: Task[] = []
  const added = new Set<number>()

  for (const it of issues) {
    const blockers: string[] = []
    let unresolved = 0
    for (const b of blockersByIssue.get(it.number) ?? []) {
      const id = `#${b.number}`
      if (!blockers.includes(id)) blockers.push(id)
      if (!openByNumber.has(b.number)) {
        const known = b.state ?? resolved.get(b.number)?.state
        if (known === undefined) unresolved++
      }
    }
    tasks.push({
      id: `#${it.number}`,
      title: it.title || `#${it.number}`,
      sourceState: it.state,
      terminal: false,
      eligible: ghEligible(it),
      blockers,
      criteria: checkboxCriteria(it.body),
      ...(unresolved > 0 ? { problem: `无法读取依赖的状态` } : {}),
    })
    added.add(it.number)
  }

  // Add referenced blockers that are not open issues in our list.
  for (const it of issues) {
    for (const b of blockersByIssue.get(it.number) ?? []) {
      if (added.has(b.number) || openByNumber.has(b.number)) continue
      const info = resolved.get(b.number)
      if (!info) continue // unresolved => stays a "needs confirmation" missing dep
      added.add(b.number)
      tasks.push({
        id: `#${b.number}`,
        title: info.title || `#${b.number}`,
        sourceState: info.state,
        terminal: info.state === "closed",
        eligible: false,
        blockers: [],
        criteria: [],
      })
    }
  }

  // The open-issue list was fully paginated by `gh --paginate`; completeness holds.
  return { projectKey, source: "github", sourceKey, tasks, complete: true, syncedAt }
}
