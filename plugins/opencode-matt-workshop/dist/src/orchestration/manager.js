import { resolve } from "node:path";
import { GitWorkspace } from "../git-workspace.js";
import { assignmentSpecSchema, sliceSpecSchema } from "./contracts.js";
import { FifoPool } from "./pool.js";
const supportRoleLimit = { inspector: 4, archivist: 2, surveyor: 2 };
const pathMatches = (path, pattern) => pattern.endsWith("/**") ? path === pattern.slice(0, -3) || path.startsWith(pattern.slice(0, -2)) : path === pattern || path.startsWith(`${pattern}/`);
export class OrchestrationManager {
    client;
    options;
    git;
    tasks = new Map();
    sessionTasks = new Map();
    makerPool;
    supportPool;
    rolePools;
    acceptedSlices = new Set();
    constructor(client, options, git = new GitWorkspace()) {
        this.client = client;
        this.options = options;
        this.git = git;
        this.makerPool = new FifoPool(options.maxParallelMakers);
        this.supportPool = new FifoPool(options.maxParallelSupport);
        this.rolePools = Object.fromEntries(Object.entries(options.supportRoleLimits ?? supportRoleLimit).map(([role, limit]) => [role, new FifoPool(limit)]));
    }
    async submitSlice(raw, parentSessionId, directory, parentAgent = "foreman") {
        const spec = sliceSpecSchema.parse(raw);
        const taskId = `slice:${parentSessionId}:${spec.sliceId}`;
        const existing = this.tasks.get(taskId);
        if (existing && !["failed", "cancelled"].includes(existing.runStatus))
            throw new Error(`Duplicate Slice identity: ${spec.sliceId}`);
        const unresolved = spec.blockers.filter((blocker) => !this.acceptedSlices.has(blocker));
        if (unresolved.length)
            throw new Error(`Unresolved Slice blockers: ${unresolved.join(", ")}`);
        for (const task of this.tasks.values())
            if (task.kind === "slice" && task.taskId !== taskId && !["failed", "cancelled"].includes(task.runStatus) && task.acceptanceStatus === "not_evaluated") {
                const other = task.spec.writeSet;
                if (spec.writeSet.some((left) => other.some((right) => pathMatches(left, right) || pathMatches(right, left))))
                    throw new Error(`Write Set overlaps active Slice ${task.taskId}`);
            }
        if (existing) {
            this.tasks.delete(taskId);
            if (existing.sessionId)
                this.sessionTasks.delete(existing.sessionId);
        }
        const workspace = existing?.directory ? { directory: existing.directory, integration: existing.integration } : await this.git.createSlice(parentSessionId, spec.sliceId, directory, spec.integrationCheckpoint);
        const task = this.makeTask(taskId, "slice", "maker", spec.objective, workspace.directory, parentSessionId, parentAgent, spec);
        task.integration = workspace.integration;
        this.tasks.set(task.taskId, task);
        void this.start(task, this.makerPool);
        return this.public(task);
    }
    async submitAssignment(raw, parentSessionId, directory, parentAgent) {
        const spec = assignmentSpecSchema.parse(raw);
        const taskId = `assignment:${parentSessionId}:${spec.assignmentId}`;
        if (this.tasks.has(taskId))
            throw new Error(`Duplicate Assignment identity: ${spec.assignmentId}`);
        const task = this.makeTask(taskId, "assignment", spec.role, spec.objective, directory, parentSessionId, parentAgent, spec);
        this.tasks.set(task.taskId, task);
        void this.startSupport(task);
        return this.public(task);
    }
    makeTask(taskId, kind, role, title, directory, parentSessionId, parentAgent, spec) {
        const now = Date.now(), budgets = spec.budgets;
        return { taskId, kind, role, title, directory, parentSessionId, parentAgent, spec, runStatus: "queued", acceptanceStatus: "not_evaluated", abort: new AbortController(), gateEvidence: [], activeElapsedMs: 0, notified: false, progress: { phase: "queued", turns: 0, turnLimit: budgets.turnLimit, elapsedMs: 0, wallLimitMs: budgets.wallLimitMinutes * 60_000, lastProgressAt: now, changedPaths: 0 } };
    }
    async startSupport(task) {
        const rolePool = this.rolePools[task.role];
        await rolePool.acquire();
        await this.supportPool.acquire();
        task.releaseSlot = () => { rolePool.release(); this.supportPool.release(); };
        await this.launch(task);
    }
    async start(task, pool) { await pool.acquire(); task.releaseSlot = () => pool.release(); await this.launch(task); }
    async launch(task) {
        if (task.runStatus === "cancelled")
            return this.release(task);
        task.runStatus = "starting";
        task.progress.phase = "starting";
        try {
            const externalReadRoots = task.kind === "assignment" ? task.spec.externalReadRoots : [];
            const permission = { question: "deny", task: "deny", bash: "deny", external_directory: Object.fromEntries([["*", "deny"], ...externalReadRoots.map((root) => [`${resolve(root)}/**`, "allow"])]) };
            const created = await this.createWorkerSession(task, permission);
            if (!created?.id)
                throw new Error("Failed to create Worker session");
            const session = await this.client.session.get({ path: { id: created.id }, query: { directory: task.directory } });
            if (session.data?.parentID !== task.parentSessionId || resolve(session.data?.directory ?? "") !== resolve(task.directory))
                throw new Error("Worker session identity or directory mismatch");
            const sessionId = created.id;
            task.sessionId = sessionId;
            this.sessionTasks.set(sessionId, task);
            task.runStatus = "running";
            task.progress.phase = task.kind === "slice" ? "implementation" : "investigation";
            task.progress.lastProgressAt = Date.now();
            task.activeSince = Date.now();
            const prompt = JSON.stringify({ contract: task.spec, resultProtocol: "Call workshop_submit_result exactly once with a structured outcome. Do not claim Acceptance Status." }, null, 2);
            await this.client.session.promptAsync({ path: { id: sessionId }, query: { directory: task.directory }, body: { agent: task.role, system: `Workshop permission template ${this.options.permissionTemplateVersion}. Follow the structured contract.`, tools: { task: false, bash: false }, parts: [{ type: "text", text: prompt }] } });
            this.armLimits(task);
        }
        catch (error) {
            this.fail(task, this.formatError(error));
        }
    }
    async createWorkerSession(task, permission) {
        const body = { parentID: task.parentSessionId, title: `${task.kind === "slice" ? "Slice" : "Assignment"}: ${task.taskId}` };
        try {
            const withPermission = await this.client.session.create({ body: { ...body, permission }, query: { directory: task.directory } });
            if (withPermission.data?.id)
                return withPermission.data;
            const error = this.formatError(withPermission.error);
            if (error.includes("permission"))
                throw new Error(`Worker session create rejected permission field: ${error}`);
        }
        catch (error) {
            const message = this.formatError(error);
            if (message.includes("permission")) {
                const fallback = await this.client.session.create({ body, query: { directory: task.directory } });
                if (fallback.data?.id)
                    return fallback.data;
                throw new Error(`Failed to create Worker session without permission: ${this.formatError(fallback.error ?? fallback.data)}`);
            }
            throw error;
        }
        const retried = await this.client.session.create({ body, query: { directory: task.directory } });
        if (retried.data?.id)
            return retried.data;
        throw new Error(`Failed to create Worker session: ${this.formatError(retried.error ?? retried.data)}`);
    }
    formatError(value) {
        if (value instanceof Error)
            return value.message;
        if (typeof value === "string")
            return value;
        try {
            return JSON.stringify(value);
        }
        catch {
            return String(value);
        }
    }
    armLimits(task) {
        const budgets = task.spec.budgets;
        const timer = setInterval(() => {
            if (["result_ready", "failed", "cancelled"].includes(task.runStatus))
                return clearInterval(timer);
            if (task.runStatus !== "running")
                return;
            task.progress.elapsedMs = task.activeElapsedMs + (task.activeSince ? Date.now() - task.activeSince : 0);
            if (task.progress.elapsedMs >= budgets.wallLimitMinutes * 60_000)
                this.stop(task, "wall_clock_budget_exceeded");
            else if (Date.now() - task.progress.lastProgressAt >= budgets.noProgressMinutes * 60_000)
                this.stop(task, "no_progress_budget_exceeded");
        }, 1_000);
    }
    handleEvent(event) {
        const sessionId = event.properties?.sessionID ?? event.properties?.info?.sessionID ?? event.properties?.part?.sessionID;
        const task = sessionId ? this.sessionTasks.get(sessionId) : undefined;
        if (!task)
            return;
        if (["result_ready", "failed", "cancelled"].includes(task.runStatus))
            return;
        if (task.runStatus === "running" && event.type === "message.updated" && event.properties.info.role === "assistant" && event.properties.info.time?.completed) {
            if (event.properties.info.mode && event.properties.info.mode !== task.role)
                return this.fail(task, `Worker identity mismatch: ${event.properties.info.mode}`);
            task.progress.turns += 1;
            if (task.progress.turns >= task.spec.budgets.turnLimit)
                this.stop(task, "turn_budget_exceeded");
            else if (task.progress.turns >= task.spec.budgets.turnWarning)
                task.progress.warning = "turn_budget_warning";
        }
        if (event.type === "session.diff" && event.properties.diff?.length) {
            task.progress.changedPaths = event.properties.diff.length;
            task.progress.lastProgressAt = Date.now();
        }
        if (event.type === "session.error" || event.type === "session.deleted")
            this.fail(task, event.type);
    }
    async submitResult(sessionId, agent, result) {
        const task = this.sessionTasks.get(sessionId);
        if (!task || task.role !== agent)
            throw new Error("Worker identity mismatch");
        if (!['running', 'stopping'].includes(task.runStatus))
            throw new Error("Worker result has already reached a terminal state");
        if (task.kind === "slice") {
            const { changedPaths, violations } = await this.validateSliceChanges(task);
            if (violations.length)
                result = { ...result, outcome: "failed", risks: [...result.risks, ...violations] };
            result.changedPaths = changedPaths;
            task.progress.changedPaths = changedPaths.length;
        }
        task.result = result;
        task.runStatus = "result_ready";
        task.progress.phase = "result_ready";
        task.progress.lastProgressAt = Date.now();
        this.release(task);
        if (task.sessionId)
            void this.client.session.abort({ path: { id: task.sessionId }, query: { directory: task.directory } });
        void this.notify(task);
        return this.public(task);
    }
    progress(sessionId, phase, focusedTestStatus) {
        const task = this.sessionTasks.get(sessionId);
        if (!task)
            throw new Error("No controlled task for this session");
        task.progress.phase = phase;
        if (focusedTestStatus && focusedTestStatus !== task.progress.focusedTestStatus) {
            task.progress.focusedTestStatus = focusedTestStatus;
            task.progress.lastProgressAt = Date.now();
        }
    }
    authorizeSliceCommand(sessionId, command) {
        const task = this.sessionTasks.get(sessionId);
        if (!task || task.kind !== "slice")
            throw new Error("No controlled Slice for this session");
        const budget = task.spec.testBudget;
        const looksLikeTest = /(^|\s)(test|pytest|vitest|jest|ctest)(\s|:|$)|\b(cargo|go)\s+test\b|\b(npm|pnpm|yarn)\s+(run\s+)?[^\s]*test/i.test(command);
        const allowedTest = budget.focusedCommands.includes(command) || (budget.allowFullSuite && budget.fullSuiteCommands.includes(command));
        if (looksLikeTest && !allowedTest)
            throw new Error("Test command is outside the Slice Test Budget");
    }
    pauseForApproval(sessionId) {
        const task = this.sessionTasks.get(sessionId);
        if (!task)
            return;
        if (task.activeSince)
            task.activeElapsedMs += Date.now() - task.activeSince;
        task.activeSince = undefined;
        task.runStatus = "waiting_for_approval";
        task.progress.phase = "waiting_for_approval";
        task.releaseSlot?.();
        task.releaseSlot = undefined;
        task.approvalTimer = setTimeout(() => {
            if (task.runStatus !== "waiting_for_approval")
                return;
            task.result = { outcome: "blocked", summary: "Approval wait expired", changedPaths: [], evidence: [], unknowns: ["Required external side effect was not approved within 24 hours"], risks: [], nextStep: "Resubmit with an approved scope", newTestCases: 0 };
            task.runStatus = "result_ready";
            task.terminalReason = "approval_wait_expired";
            if (task.sessionId)
                void this.client.session.abort({ path: { id: task.sessionId }, query: { directory: task.directory } });
            void this.notify(task);
        }, 24 * 60 * 60_000);
    }
    async resumeAfterApproval(sessionId) {
        const task = this.sessionTasks.get(sessionId);
        if (!task || task.runStatus !== "waiting_for_approval")
            return;
        if (task.approvalTimer)
            clearTimeout(task.approvalTimer);
        task.approvalTimer = undefined;
        if (task.kind === "slice")
            await this.acquireMakerSlot(task);
        else
            await this.acquireSupportSlot(task);
        task.runStatus = "running";
        task.progress.phase = task.kind === "slice" ? "implementation" : "investigation";
        task.progress.lastProgressAt = Date.now();
        task.activeSince = Date.now();
    }
    async blockForDeniedApproval(sessionId) {
        const task = this.sessionTasks.get(sessionId);
        if (!task)
            return;
        task.result = { outcome: "blocked", summary: "Required external side effect was not approved", changedPaths: [], evidence: [], unknowns: [], risks: [], nextStep: "Resubmit with an approved scope or remove the side effect", newTestCases: 0 };
        task.runStatus = "result_ready";
        task.terminalReason = "approval_denied";
        this.release(task);
        if (task.sessionId)
            await this.client.session.abort({ path: { id: task.sessionId }, query: { directory: task.directory } }).catch(() => undefined);
        void this.notify(task);
    }
    recordGate(taskId, command, exitCode) {
        const task = this.tasks.get(taskId);
        if (!task || task.kind !== "slice")
            throw new Error("Unknown Slice for Gate evidence");
        if (!task.spec.verificationPlan.includes(command))
            throw new Error("Gate command is outside the Slice Verification Plan");
        task.gateEvidence.push({ command, exitCode });
    }
    commandDirectory(taskId) { return this.tasks.get(taskId)?.directory; }
    integrationSummary(parentSessionId) { return this.git.summary(parentSessionId); }
    finalizeIntegration(parentSessionId) { return this.git.finalize(parentSessionId); }
    get(taskId) { const task = this.tasks.get(taskId); if (!task)
        throw new Error(`Unknown Task Handle: ${taskId}`); return this.public(task); }
    async cancel(taskId) { const task = this.tasks.get(taskId); if (!task)
        throw new Error(`Unknown Task Handle: ${taskId}`); task.runStatus = "cancelled"; task.abort.abort(); if (task.sessionId)
        await this.client.session.abort({ path: { id: task.sessionId }, query: { directory: task.directory } }).catch(() => undefined); this.release(task); return this.public(task); }
    async steer(taskId, clarification) { const task = this.tasks.get(taskId); if (!task?.sessionId || task.runStatus !== "running")
        throw new Error("Task is not steerable"); await this.client.session.promptAsync({ path: { id: task.sessionId }, query: { directory: task.directory }, body: { agent: task.role, tools: { task: false, bash: false }, parts: [{ type: "text", text: `Clarification only; do not expand the contract:\n${clarification}` }] } }); return this.public(task); }
    async accept(taskId) { const task = this.tasks.get(taskId); if (!task || task.kind !== "slice" || task.runStatus !== "result_ready" || task.result?.outcome !== "completed")
        throw new Error("Only a completed Slice Result can be accepted"); const spec = task.spec; const successful = new Set(task.gateEvidence.filter((entry) => entry.exitCode === 0).map((entry) => entry.command)); if (task.gateEvidence.some((entry) => entry.exitCode !== 0) || spec.verificationPlan.some((command) => !successful.has(command)))
        throw new Error("Foreman must record every successful Verification Plan command before acceptance"); const validation = await this.validateSliceChanges(task); if (validation.violations.length)
        throw new Error(validation.violations.join("; ")); const accepted = await this.git.accept(task.directory, task.integration, spec.sliceId, spec.ticketRef); task.acceptanceStatus = "accepted"; this.acceptedSlices.add(spec.sliceId); return { ...this.public(task), ...accepted }; }
    reject(taskId, reason) { const task = this.tasks.get(taskId); if (!task || task.kind !== "slice")
        throw new Error("Unknown Slice"); task.acceptanceStatus = "rejected"; task.terminalReason = reason; return this.public(task); }
    bySession(sessionId) { return this.sessionTasks.get(sessionId); }
    stop(task, reason) { task.runStatus = "stopping"; task.terminalReason = reason; task.abort.abort(); if (task.sessionId)
        void this.client.session.abort({ path: { id: task.sessionId }, query: { directory: task.directory } }); this.fail(task, reason); }
    fail(task, reason) { task.runStatus = "failed"; task.terminalReason = reason; task.progress.phase = "failed"; this.release(task); void this.notify(task); }
    release(task) { task.releaseSlot?.(); task.releaseSlot = undefined; task.activeSince = undefined; if (task.approvalTimer)
        clearTimeout(task.approvalTimer); task.approvalTimer = undefined; }
    async acquireMakerSlot(task) { await this.makerPool.acquire(); task.releaseSlot = () => this.makerPool.release(); }
    async acquireSupportSlot(task) { const rolePool = this.rolePools[task.role]; await rolePool.acquire(); await this.supportPool.acquire(); task.releaseSlot = () => { rolePool.release(); this.supportPool.release(); }; }
    async notify(task) {
        if (task.notified)
            return;
        task.notified = true;
        await this.client.session.promptAsync({ path: { id: task.parentSessionId }, body: { agent: task.parentAgent, noReply: true, parts: [{ type: "text", text: `[Workshop Task Handle ${task.taskId}] ${task.runStatus}${task.result ? ` / ${task.result.outcome}` : ""}. Read workshop_task_status before Acceptance Gate.` }] } }).catch(() => { task.notified = false; });
    }
    async validateSliceChanges(task) {
        const spec = task.spec;
        const changedPaths = await this.git.changedPaths(task.directory);
        const addedPaths = await this.git.addedPaths(task.directory);
        const outside = changedPaths.filter((path) => !spec.writeSet.some((pattern) => pathMatches(path, pattern)));
        const testPath = (path) => /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[^.]+$/i.test(path);
        const changedTestFiles = changedPaths.filter(testPath);
        const addedTestFiles = addedPaths.filter(testPath);
        const violations = outside.length ? [`Write Set violation: ${outside.join(", ")}`] : [];
        const disallowedTests = changedTestFiles.filter((path) => !spec.testBudget.allowedTestPaths.some((pattern) => pathMatches(path, pattern)));
        if (disallowedTests.length)
            violations.push(`Test path is outside the Test Budget: ${disallowedTests.join(", ")}`);
        if (addedTestFiles.length > spec.testBudget.maxNewTestFiles)
            violations.push(`Test Budget file limit exceeded: ${addedTestFiles.length} > ${spec.testBudget.maxNewTestFiles}`);
        if ((task.result?.newTestCases ?? 0) > spec.testBudget.maxNewTestCases)
            violations.push(`Test Budget case limit exceeded: ${task.result?.newTestCases} > ${spec.testBudget.maxNewTestCases}`);
        return { changedPaths, violations };
    }
    public(task) { const { abort: _abort, releaseSlot: _release, spec: _spec, parentSessionId: _parent, parentAgent: _parentAgent, integration: _integration, gateEvidence: _gate, activeSince: _active, activeElapsedMs: _elapsed, notified: _notified, approvalTimer: _approval, ...snapshot } = task; return structuredClone(snapshot); }
}
