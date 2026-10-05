/**
 * Task tracker — domain model and pure sidebar projection.
 *
 * This module is intentionally free of I/O and of any wire/RPC concerns: it
 * owns the shared snapshot vocabulary and the deterministic computation that
 * turns a source snapshot (facts) plus the caller's local processed marks
 * (display corrections) into the sidebar effective state. `sources.ts` builds
 * `Snapshot` values, `rpc.ts` carries them over the wire, and the TUI renders
 * what this projection returns.
 *
 * Invariants enforced here (see TASK-TRACKING-FOOTER-SPEC.md §4):
 * - `terminal` is a source fact; only `terminal` moves a ticket out of the
 *   pending view on the source side. Local marks never falsify `terminal`.
 * - A task is only ever `ready` when the source semantics allow starting
 *   (`eligible`) AND every identifiable blocker is satisfied (source-terminal
 *   or locally processed) AND no dependency is unresolved (missing / cycle).
 * - "Absent from the list" is never treated as "done": a blocker id that is not
 *   present in the snapshot is an unknown dependency, not a satisfied one.
 * - Acceptance criteria are documented data only; they never drive state.
 */

export type Source = "local" | "github"

/** A single task/issue record translated to a non-sensitive, source-neutral shape. */
export type Task = {
  /** Stable identity within the source; MUST encode feature/repo ownership + ticket identity. */
  id: string
  title: string
  /** The source's real, unmodified state string (e.g. `ready-for-agent`, `open`, `closed`, `claimed`, `resolved`). */
  sourceState: string
  /** True only when the source records a definitive terminal state (closed / resolved). */
  terminal: boolean
  /** True when the source semantics permit this ticket to become a start candidate once blockers resolve. */
  eligible: boolean
  /** Ids of the tasks that block this one (native blockers preferred; body convention as fallback). */
  blockers: string[]
  /** Acceptance criteria as originally written (checkbox marker preserved); never used to infer completion. */
  criteria: string[]
  /** Set when this record's state/dependencies could not be reliably resolved; forces "needs confirmation". */
  problem?: string
}

/** A source read: facts only, plus read metadata. No local marks live here. */
export type Snapshot = {
  /** Stable project identity namespace for durable local-mark isolation. */
  projectKey: string
  source: Source
  /** Identifies the complete repo (owner/repo) or the local source root. */
  sourceKey: string
  tasks: Task[]
  /** False when the read is known to be partial (e.g. incomplete pagination); a partial count is never a total. */
  complete: boolean
  /** Epoch ms of this successful read. */
  syncedAt: number
  /** The reliably-identified Matt tracker source (advisory). Undefined unless a Matt config match is certain. */
  suggestedSource?: Source
}

/** The sidebar effective state derived from facts + local marks. */
export type ViewState = "ready" | "blocked" | "unknown" | "processed" | "closed"

export type ViewTask = Task & {
  state: ViewState
  /** True when this result is (or was reached by) a local mark rather than a source fact. */
  local: boolean
}

/**
 * Durable local-mark key.
 *
 * Connection isolation is applied by the TUI periphery (which storage key /
 * namespace it reads and writes); the key itself composes the stable project
 * namespace, the source identity, and the task id so identical ticket numbers
 * from different projects, sources or feature directories never collide.
 *
 * The composite is emitted as a single JSON array string: unambiguous and
 * collision-free regardless of `/`, `#`, `:` or other separators in the parts.
 */
export function markKey(snapshot: Snapshot, id: string): string {
  return JSON.stringify([snapshot.projectKey, snapshot.sourceKey, id])
}

/**
 * Build the open-blocker subgraph used for cycle detection.
 *
 * An edge `t -> b` exists only when `b` still genuinely blocks `t`: `b` exists
 * in the snapshot, is not source-terminal, and has not been locally processed.
 * Edges that are satisfied by a terminal fact or a local mark are removed, so a
 * local mark legitimately "opens up" part of the graph.
 *
 * A task is *cycle-tainted* when the open-blocker cone reachable from it still
 * contains a directed cycle — i.e. its readiness hinges on a dependency loop
 * that no source fact or current mark resolves. Those tasks are "needs
 * confirmation", never silently unlocked.
 */
function cycleTainted(
  tasks: readonly Task[],
  openEdges: ReadonlyMap<string, readonly string[]>,
): ReadonlySet<string> {
  // Tarjan strongly-connected components over the open-edge digraph.
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const cyclic = new Set<string>()
  let counter = 0

  // Iterative Tarjan to stay safe on deep graphs.
  const ids = tasks.map((t) => t.id)
  const frame: Array<{ node: string; edges: readonly string[]; i: number }> = []
  const starteds = new Set<string>()

  for (const root of ids) {
    if (starteds.has(root)) continue
    frame.push({ node: root, edges: openEdges.get(root) ?? [], i: 0 })
    starteds.add(root)
    index.set(root, counter)
    low.set(root, counter)
    counter++
    stack.push(root)
    onStack.add(root)

    while (frame.length > 0) {
      const top = frame[frame.length - 1]
      if (top.i < top.edges.length) {
        const next = top.edges[top.i++]
        if (!starteds.has(next)) {
          starteds.add(next)
          index.set(next, counter)
          low.set(next, counter)
          counter++
          stack.push(next)
          onStack.add(next)
          frame.push({ node: next, edges: openEdges.get(next) ?? [], i: 0 })
        } else if (onStack.has(next)) {
          low.set(top.node, Math.min(low.get(top.node)!, index.get(next)!))
        }
      } else {
        if (low.get(top.node) === index.get(top.node)) {
          // Pop the SCC.
          const comp: string[] = []
          let popped: string
          do {
            popped = stack.pop()!
            onStack.delete(popped)
            comp.push(popped)
          } while (popped !== top.node)
          const hasSelfLoop = (openEdges.get(comp[0]) ?? []).includes(comp[0])
          if (comp.length > 1 || hasSelfLoop) for (const n of comp) cyclic.add(n)
        }
        frame.pop()
        const parent = frame[frame.length - 1]
        if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(top.node)!))
      }
    }
  }

  if (cyclic.size === 0) return new Set()

  // Taint every task that can reach a cyclic node through open edges (including
  // the cyclic nodes themselves). Reverse BFS from the cyclic set.
  const reverse = new Map<string, string[]>()
  for (const [from, tos] of openEdges) {
    for (const to of tos) {
      if (!to) continue
      const arr = reverse.get(to) ?? []
      arr.push(from)
      reverse.set(to, arr)
    }
  }
  const tainted = new Set<string>(cyclic)
  const work = [...cyclic]
  while (work.length > 0) {
    const node = work.pop()!
    for (const pred of reverse.get(node) ?? []) {
      if (!tainted.has(pred)) {
        tainted.add(pred)
        work.push(pred)
      }
    }
  }
  return tainted
}

type BlockerDisposition = "source" | "local" | "open" | "missing"

/**
 * Compute the sidebar effective view for every task in the snapshot.
 *
 * Precedence (first match wins):
 *   terminal           -> closed   (source fact; local marks do not apply)
 *   locally processed  -> processed
 *   source-declared
 *     problem set      -> unknown
 *   source semantics
 *     not eligible     -> unknown   (claimed / plain request / spec / map: visible, never a start candidate)
 *   dependencies
 *     blocker missing  -> unknown   (absent != done; cannot confirm)
 *     in a dep cycle   -> unknown
 *     a blocker open   -> blocked
 *   otherwise          -> ready     (local=true iff unlocked only via a local mark on a blocker)
 */
export function projectTasks(snapshot: Snapshot, marks: Record<string, boolean>): ViewTask[] {
  const byId = new Map<string, Task>()
  for (const task of snapshot.tasks) byId.set(task.id, task)

  const isMarked = (id: string): boolean => marks[markKey(snapshot, id)] === true

  // Classify each task's blockers and build the open-edge graph once.
  const openEdges = new Map<string, string[]>()
  const dispositions = new Map<string, BlockerDisposition[]>()
  const viaLocal = new Map<string, boolean>()

  for (const task of snapshot.tasks) {
    const disp: BlockerDisposition[] = []
    const open: string[] = []
    let anyLocal = false
    for (const blockerId of task.blockers) {
      const blocker = byId.get(blockerId)
      if (!blocker) {
        disp.push("missing")
        continue
      }
      if (blocker.terminal) {
        disp.push("source")
      } else if (isMarked(blockerId)) {
        disp.push("local")
        anyLocal = true
      } else {
        disp.push("open")
        open.push(blockerId)
      }
    }
    dispositions.set(task.id, disp)
    openEdges.set(task.id, open)
    viaLocal.set(task.id, anyLocal)
  }

  const tainted = cycleTainted(snapshot.tasks, openEdges)

  return snapshot.tasks.map((task): ViewTask => {
    const base = { ...task }
    if (task.terminal) {
      return { ...base, state: "closed", local: false }
    }
    if (isMarked(task.id)) {
      return { ...base, state: "processed", local: true }
    }
    if (task.problem) {
      return { ...base, state: "unknown", local: false }
    }
    if (!task.eligible) {
      return { ...base, state: "unknown", local: false }
    }
    const disp = dispositions.get(task.id) ?? []
    if (disp.includes("missing")) {
      return { ...base, state: "unknown", local: false }
    }
    if (tainted.has(task.id)) {
      return { ...base, state: "unknown", local: false }
    }
    if (disp.includes("open")) {
      return { ...base, state: "blocked", local: false }
    }
    return { ...base, state: "ready", local: viaLocal.get(task.id) === true }
  })
}
