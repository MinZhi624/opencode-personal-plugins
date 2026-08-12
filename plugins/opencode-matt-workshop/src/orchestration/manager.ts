import { resolve } from "node:path"
import { GitWorkspace } from "../git-workspace.js"
import { AssignmentSpec, assignmentSpecSchema, SliceSpec, sliceSpecSchema, StructuredResult, TaskSnapshot } from "./contracts.js"
import { FifoPool } from "./pool.js"

type Client = any
type RuntimeOptions = { maxParallelMakers: number; maxParallelSupport: number; supportRoleLimits?: { inspector: number; archivist: number; surveyor: number }; permissionTemplateVersion: string }
type GitAdapter = Pick<GitWorkspace, "createSlice" | "changedPaths" | "addedPaths" | "accept" | "summary" | "finalize">
type InternalTask = TaskSnapshot & { parentSessionId: string; spec: SliceSpec | AssignmentSpec; abort: AbortController; releaseSlot?: () => void; integration?: any; gateEvidence: Array<{ command: string; exitCode: number | null }>; activeSince?: number; activeElapsedMs: number; notified: boolean; approvalTimer?: ReturnType<typeof setTimeout> }

const supportRoleLimit = { inspector: 4, archivist: 2, surveyor: 2 }
const pathMatches = (path: string, pattern: string) => pattern.endsWith("/**") ? path === pattern.slice(0, -3) || path.startsWith(pattern.slice(0, -2)) : path === pattern || path.startsWith(`${pattern}/`)

export class OrchestrationManager {
  private readonly tasks = new Map<string, InternalTask>()
  private readonly sessionTasks = new Map<string, InternalTask>()
  private readonly makerPool: FifoPool
  private readonly supportPool: FifoPool
  private readonly rolePools: Record<string, FifoPool>
  private readonly acceptedSlices = new Set<string>()
  constructor(private readonly client: Client, private readonly options: RuntimeOptions, private readonly git: GitAdapter = new GitWorkspace()) {
    this.makerPool = new FifoPool(options.maxParallelMakers)
    this.supportPool = new FifoPool(options.maxParallelSupport)
    this.rolePools = Object.fromEntries(Object.entries(options.supportRoleLimits ?? supportRoleLimit).map(([role, limit]) => [role, new FifoPool(limit)]))
  }

  async submitSlice(raw: unknown, parentSessionId: string, directory: string) {
    const spec = sliceSpecSchema.parse(raw)
    const taskId = `slice:${parentSessionId}:${spec.sliceId}`
    if (this.tasks.has(taskId)) throw new Error(`Duplicate Slice identity: ${spec.sliceId}`)
    const unresolved = spec.blockers.filter((blocker) => !this.acceptedSlices.has(blocker))
    if (unresolved.length) throw new Error(`Unresolved Slice blockers: ${unresolved.join(", ")}`)
    for (const task of this.tasks.values()) if (task.kind === "slice" && !["failed", "cancelled"].includes(task.runStatus) && task.acceptanceStatus === "not_evaluated") {
      const other = (task.spec as SliceSpec).writeSet
      if (spec.writeSet.some((left) => other.some((right) => pathMatches(left, right) || pathMatches(right, left)))) throw new Error(`Write Set overlaps active Slice ${task.taskId}`)
    }
    const workspace = await this.git.createSlice(parentSessionId, spec.sliceId, directory, spec.integrationCheckpoint)
    const task = this.makeTask(taskId, "slice", "maker", spec.objective, workspace.directory, parentSessionId, spec)
    task.integration = workspace.integration
    this.tasks.set(task.taskId, task)
    void this.start(task, this.makerPool)
    return this.public(task)
  }

  async submitAssignment(raw: unknown, parentSessionId: string, directory: string) {
    const spec = assignmentSpecSchema.parse(raw)
    const taskId = `assignment:${parentSessionId}:${spec.assignmentId}`
    if (this.tasks.has(taskId)) throw new Error(`Duplicate Assignment identity: ${spec.assignmentId}`)
    const task = this.makeTask(taskId, "assignment", spec.role, spec.objective, directory, parentSessionId, spec)
    this.tasks.set(task.taskId, task)
    void this.startSupport(task)
    return this.public(task)
  }

  private makeTask(taskId: string, kind: "slice" | "assignment", role: InternalTask["role"], title: string, directory: string, parentSessionId: string, spec: SliceSpec | AssignmentSpec): InternalTask {
    const now = Date.now(), budgets = spec.budgets
    return { taskId, kind, role, title, directory, parentSessionId, spec, runStatus: "queued", acceptanceStatus: "not_evaluated", abort: new AbortController(), gateEvidence: [], activeElapsedMs: 0, notified: false, progress: { phase: "queued", turns: 0, turnLimit: budgets.turnLimit, elapsedMs: 0, wallLimitMs: budgets.wallLimitMinutes * 60_000, lastProgressAt: now, changedPaths: 0 } }
  }

  private async startSupport(task: InternalTask) {
    const rolePool = this.rolePools[task.role]
    await rolePool.acquire()
    await this.supportPool.acquire()
    task.releaseSlot = () => { rolePool.release(); this.supportPool.release() }
    await this.launch(task)
  }

  private async start(task: InternalTask, pool: FifoPool) { await pool.acquire(); task.releaseSlot = () => pool.release(); await this.launch(task) }
  private async launch(task: InternalTask) {
    if (task.runStatus === "cancelled") return this.release(task)
    task.runStatus = "starting"; task.progress.phase = "starting"
    try {
      const externalReadRoots = task.kind === "assignment" ? (task.spec as AssignmentSpec).externalReadRoots : []
      const permission = { question: "deny", task: "deny", bash: "deny", external_directory: Object.fromEntries([["*", "deny"], ...externalReadRoots.map((root) => [`${resolve(root)}/**`, "allow"])]) }
      const created = await this.client.session.create({ body: { parentID: task.parentSessionId, title: `${task.kind === "slice" ? "Slice" : "Assignment"}: ${task.taskId}`, permission } as Record<string, unknown>, query: { directory: task.directory } })
      if (!created.data?.id) throw new Error(`Failed to create Worker session: ${created.error ?? "missing session"}`)
      const session = await this.client.session.get({ path: { id: created.data.id }, query: { directory: task.directory } })
      if (session.data?.parentID !== task.parentSessionId || resolve(session.data?.directory ?? "") !== resolve(task.directory)) throw new Error("Worker session identity or directory mismatch")
      const sessionId = created.data.id as string
      task.sessionId = sessionId; this.sessionTasks.set(sessionId, task)
      task.runStatus = "running"; task.progress.phase = task.kind === "slice" ? "implementation" : "investigation"; task.progress.lastProgressAt = Date.now(); task.activeSince = Date.now()
      const prompt = JSON.stringify({ contract: task.spec, resultProtocol: "Call workshop_submit_result exactly once with a structured outcome. Do not claim Acceptance Status." }, null, 2)
      await this.client.session.promptAsync({ path: { id: sessionId }, query: { directory: task.directory }, body: { agent: task.role, system: `Workshop permission template ${this.options.permissionTemplateVersion}. Follow the structured contract.`, tools: { task: false, bash: false }, parts: [{ type: "text", text: prompt }] } })
      this.armLimits(task)
    } catch (error) { this.fail(task, error instanceof Error ? error.message : String(error)) }
  }

  private armLimits(task: InternalTask) {
    const budgets = task.spec.budgets
    const timer = setInterval(() => {
      if (["result_ready", "failed", "cancelled"].includes(task.runStatus)) return clearInterval(timer)
      if (task.runStatus !== "running") return
      task.progress.elapsedMs = task.activeElapsedMs + (task.activeSince ? Date.now() - task.activeSince : 0)
      if (task.progress.elapsedMs >= budgets.wallLimitMinutes * 60_000) this.stop(task, "wall_clock_budget_exceeded")
      else if (Date.now() - task.progress.lastProgressAt >= budgets.noProgressMinutes * 60_000) this.stop(task, "no_progress_budget_exceeded")
    }, 1_000)
  }

  handleEvent(event: any) {
    const sessionId = event.properties?.sessionID ?? event.properties?.info?.sessionID ?? event.properties?.part?.sessionID
    const task = sessionId ? this.sessionTasks.get(sessionId) : undefined
    if (!task) return
    if (["result_ready", "failed", "cancelled"].includes(task.runStatus)) return
    if (task.runStatus === "running" && event.type === "message.updated" && event.properties.info.role === "assistant" && event.properties.info.time?.completed) {
      if (event.properties.info.mode && event.properties.info.mode !== task.role) return this.fail(task, `Worker identity mismatch: ${event.properties.info.mode}`)
      task.progress.turns += 1
      if (task.progress.turns >= task.spec.budgets.turnLimit) this.stop(task, "turn_budget_exceeded")
      else if (task.progress.turns >= task.spec.budgets.turnWarning) task.progress.warning = "turn_budget_warning"
    }
    if (event.type === "session.diff" && event.properties.diff?.length) {
      task.progress.changedPaths = event.properties.diff.length
      task.progress.lastProgressAt = Date.now()
    }
    if (event.type === "session.error" || event.type === "session.deleted") this.fail(task, event.type)
  }

  async submitResult(sessionId: string, agent: string, result: StructuredResult) {
    const task = this.sessionTasks.get(sessionId)
    if (!task || task.role !== agent) throw new Error("Worker identity mismatch")
    if (!['running', 'stopping'].includes(task.runStatus)) throw new Error("Worker result has already reached a terminal state")
    if (task.kind === "slice") {
      const { changedPaths, violations } = await this.validateSliceChanges(task)
      if (violations.length) result = { ...result, outcome: "failed", risks: [...result.risks, ...violations] }
      result.changedPaths = changedPaths
      task.progress.changedPaths = changedPaths.length
    }
    task.result = result; task.runStatus = "result_ready"; task.progress.phase = "result_ready"; task.progress.lastProgressAt = Date.now(); this.release(task); if (task.sessionId) void this.client.session.abort({ path: { id: task.sessionId }, query: { directory: task.directory } }); void this.notify(task)
    return this.public(task)
  }

  progress(sessionId: string, phase: string, focusedTestStatus?: string) {
    const task = this.sessionTasks.get(sessionId)
    if (!task) throw new Error("No controlled task for this session")
    task.progress.phase = phase
    if (focusedTestStatus && focusedTestStatus !== task.progress.focusedTestStatus) {
      task.progress.focusedTestStatus = focusedTestStatus
      task.progress.lastProgressAt = Date.now()
    }
  }

  authorizeSliceCommand(sessionId: string, command: string) {
    const task = this.sessionTasks.get(sessionId)
    if (!task || task.kind !== "slice") throw new Error("No controlled Slice for this session")
    const budget = (task.spec as SliceSpec).testBudget
    const looksLikeTest = /(^|\s)(test|pytest|vitest|jest|ctest)(\s|:|$)|\b(cargo|go)\s+test\b|\b(npm|pnpm|yarn)\s+(run\s+)?[^\s]*test/i.test(command)
    const allowedTest = budget.focusedCommands.includes(command) || (budget.allowFullSuite && budget.fullSuiteCommands.includes(command))
    if (looksLikeTest && !allowedTest) throw new Error("Test command is outside the Slice Test Budget")
  }

  pauseForApproval(sessionId: string) {
    const task = this.sessionTasks.get(sessionId)
    if (!task) return
    if (task.activeSince) task.activeElapsedMs += Date.now() - task.activeSince
    task.activeSince = undefined
    task.runStatus = "waiting_for_approval"; task.progress.phase = "waiting_for_approval"; task.releaseSlot?.(); task.releaseSlot = undefined
    task.approvalTimer = setTimeout(() => {
      if (task.runStatus !== "waiting_for_approval") return
      task.result = { outcome: "blocked", summary: "Approval wait expired", changedPaths: [], evidence: [], unknowns: ["Required external side effect was not approved within 24 hours"], risks: [], nextStep: "Resubmit with an approved scope", newTestCases: 0 }
      task.runStatus = "result_ready"; task.terminalReason = "approval_wait_expired"; if (task.sessionId) void this.client.session.abort({ path: { id: task.sessionId }, query: { directory: task.directory } }); void this.notify(task)
    }, 24 * 60 * 60_000)
  }

  async resumeAfterApproval(sessionId: string) {
    const task = this.sessionTasks.get(sessionId)
    if (!task || task.runStatus !== "waiting_for_approval") return
    if (task.approvalTimer) clearTimeout(task.approvalTimer)
    task.approvalTimer = undefined
    if (task.kind === "slice") await this.acquireMakerSlot(task)
    else await this.acquireSupportSlot(task)
    task.runStatus = "running"; task.progress.phase = task.kind === "slice" ? "implementation" : "investigation"; task.progress.lastProgressAt = Date.now(); task.activeSince = Date.now()
  }

  async blockForDeniedApproval(sessionId: string) {
    const task = this.sessionTasks.get(sessionId)
    if (!task) return
    task.result = { outcome: "blocked", summary: "Required external side effect was not approved", changedPaths: [], evidence: [], unknowns: [], risks: [], nextStep: "Resubmit with an approved scope or remove the side effect", newTestCases: 0 }
    task.runStatus = "result_ready"; task.terminalReason = "approval_denied"; this.release(task)
    if (task.sessionId) await this.client.session.abort({ path: { id: task.sessionId }, query: { directory: task.directory } }).catch(() => undefined)
    void this.notify(task)
  }

  recordGate(taskId: string, command: string, exitCode: number | null) {
    const task = this.tasks.get(taskId)
    if (!task || task.kind !== "slice") throw new Error("Unknown Slice for Gate evidence")
    if (!(task.spec as SliceSpec).verificationPlan.includes(command)) throw new Error("Gate command is outside the Slice Verification Plan")
    task.gateEvidence.push({ command, exitCode })
  }
  commandDirectory(taskId: string) { return this.tasks.get(taskId)?.directory }
  integrationSummary(parentSessionId: string) { return this.git.summary(parentSessionId) }
  finalizeIntegration(parentSessionId: string) { return this.git.finalize(parentSessionId) }

  get(taskId: string) { const task = this.tasks.get(taskId); if (!task) throw new Error(`Unknown Task Handle: ${taskId}`); return this.public(task) }
  async cancel(taskId: string) { const task = this.tasks.get(taskId); if (!task) throw new Error(`Unknown Task Handle: ${taskId}`); task.runStatus = "cancelled"; task.abort.abort(); if (task.sessionId) await this.client.session.abort({ path: { id: task.sessionId }, query: { directory: task.directory } }).catch(() => undefined); this.release(task); return this.public(task) }
  async steer(taskId: string, clarification: string) { const task = this.tasks.get(taskId); if (!task?.sessionId || task.runStatus !== "running") throw new Error("Task is not steerable"); await this.client.session.promptAsync({ path: { id: task.sessionId }, query: { directory: task.directory }, body: { agent: task.role, tools: { task: false, bash: false }, parts: [{ type: "text", text: `Clarification only; do not expand the contract:\n${clarification}` }] } }); return this.public(task) }
  async accept(taskId: string) { const task = this.tasks.get(taskId); if (!task || task.kind !== "slice" || task.runStatus !== "result_ready" || task.result?.outcome !== "completed") throw new Error("Only a completed Slice Result can be accepted"); const spec = task.spec as SliceSpec; const successful = new Set(task.gateEvidence.filter((entry) => entry.exitCode === 0).map((entry) => entry.command)); if (task.gateEvidence.some((entry) => entry.exitCode !== 0) || spec.verificationPlan.some((command) => !successful.has(command))) throw new Error("Foreman must record every successful Verification Plan command before acceptance"); const validation = await this.validateSliceChanges(task); if (validation.violations.length) throw new Error(validation.violations.join("; ")); const accepted = await this.git.accept(task.directory, task.integration, spec.sliceId, spec.ticketRef); task.acceptanceStatus = "accepted"; this.acceptedSlices.add(spec.sliceId); return { ...this.public(task), ...accepted } }
  reject(taskId: string, reason: string) { const task = this.tasks.get(taskId); if (!task || task.kind !== "slice") throw new Error("Unknown Slice"); task.acceptanceStatus = "rejected"; task.terminalReason = reason; return this.public(task) }
  bySession(sessionId: string) { return this.sessionTasks.get(sessionId) }

  private stop(task: InternalTask, reason: string) { task.runStatus = "stopping"; task.terminalReason = reason; task.abort.abort(); if (task.sessionId) void this.client.session.abort({ path: { id: task.sessionId }, query: { directory: task.directory } }); this.fail(task, reason) }
  private fail(task: InternalTask, reason: string) { task.runStatus = "failed"; task.terminalReason = reason; task.progress.phase = "failed"; this.release(task); void this.notify(task) }
  private release(task: InternalTask) { task.releaseSlot?.(); task.releaseSlot = undefined; task.activeSince = undefined; if (task.approvalTimer) clearTimeout(task.approvalTimer); task.approvalTimer = undefined }
  private async acquireMakerSlot(task: InternalTask) { await this.makerPool.acquire(); task.releaseSlot = () => this.makerPool.release() }
  private async acquireSupportSlot(task: InternalTask) { const rolePool = this.rolePools[task.role]; await rolePool.acquire(); await this.supportPool.acquire(); task.releaseSlot = () => { rolePool.release(); this.supportPool.release() } }
  private async notify(task: InternalTask) {
    if (task.notified) return
    task.notified = true
    await this.client.session.promptAsync({ path: { id: task.parentSessionId }, body: { noReply: true, parts: [{ type: "text", text: `[Workshop Task Handle ${task.taskId}] ${task.runStatus}${task.result ? ` / ${task.result.outcome}` : ""}. Read workshop_task_status before Acceptance Gate.` }] } }).catch(() => { task.notified = false })
  }
  private async validateSliceChanges(task: InternalTask) {
    const spec = task.spec as SliceSpec
    const changedPaths = await this.git.changedPaths(task.directory)
    const addedPaths = await this.git.addedPaths(task.directory)
    const outside = changedPaths.filter((path) => !spec.writeSet.some((pattern) => pathMatches(path, pattern)))
    const testPath = (path: string) => /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[^.]+$/i.test(path)
    const changedTestFiles = changedPaths.filter(testPath)
    const addedTestFiles = addedPaths.filter(testPath)
    const violations = outside.length ? [`Write Set violation: ${outside.join(", ")}`] : []
    const disallowedTests = changedTestFiles.filter((path) => !spec.testBudget.allowedTestPaths.some((pattern) => pathMatches(path, pattern)))
    if (disallowedTests.length) violations.push(`Test path is outside the Test Budget: ${disallowedTests.join(", ")}`)
    if (addedTestFiles.length > spec.testBudget.maxNewTestFiles) violations.push(`Test Budget file limit exceeded: ${addedTestFiles.length} > ${spec.testBudget.maxNewTestFiles}`)
    if ((task.result?.newTestCases ?? 0) > spec.testBudget.maxNewTestCases) violations.push(`Test Budget case limit exceeded: ${task.result?.newTestCases} > ${spec.testBudget.maxNewTestCases}`)
    return { changedPaths, violations }
  }
  private public(task: InternalTask): TaskSnapshot { const { abort: _abort, releaseSlot: _release, spec: _spec, parentSessionId: _parent, integration: _integration, gateEvidence: _gate, activeSince: _active, activeElapsedMs: _elapsed, notified: _notified, approvalTimer: _approval, ...snapshot } = task; return structuredClone(snapshot) }
}
