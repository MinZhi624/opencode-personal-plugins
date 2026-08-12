import { describe, expect, it, vi } from "vitest"
import { CommandRunner } from "../src/command-runner.js"
import { sliceSpecSchema } from "../src/orchestration/contracts.js"
import { OrchestrationManager } from "../src/orchestration/manager.js"

const spec = (overrides: Record<string, unknown> = {}) => ({
  sliceId: "ticket-01",
  objective: "Implement one observable Workshop behavior",
  acceptanceConditions: ["The controlled behavior is observable"],
  blockers: [],
  writeSet: ["src/**", "tests/**"],
  verificationPlan: ["npm test -- focused"],
  testBudget: { allowedTestPaths: ["tests/**"], focusedCommands: ["npm test -- focused"], fullSuiteCommands: [], maxNewTestFiles: 1, maxNewTestCases: 3, allowFullSuite: false },
  contextRefs: ["src/index.ts"],
  integrationCheckpoint: "1234567",
  budgets: {},
  ...overrides,
})

function harness() {
  const sessions = new Map<string, any>()
  const client = {
    session: {
      create: vi.fn(async ({ body, query }: any) => { const value = { id: `ses_${sessions.size + 1}`, parentID: body.parentID, directory: query.directory }; sessions.set(value.id, value); return { data: value } }),
      get: vi.fn(async ({ path }: any) => ({ data: sessions.get(path.id) })),
      promptAsync: vi.fn(async () => ({ data: true })),
      abort: vi.fn(async () => ({ data: true })),
    },
  }
  const git = {
    createSlice: vi.fn(async (_parent: string, id: string) => ({ directory: `/tmp/${id}`, integration: { directory: "/tmp/integration" } })),
    changedPaths: vi.fn(async () => ["src/index.ts"]),
    addedPaths: vi.fn(async () => []),
    accept: vi.fn(async () => ({ commit: "abcdef1", integrationCheckpoint: "abcdef2" })),
    summary: vi.fn(async () => ({ integrationBranch: "workshop/integration", originalBranch: "main" })),
    finalize: vi.fn(async () => ({ branch: "main", commit: "abcdef3" })),
  }
  return { client, git, manager: new OrchestrationManager(client, { maxParallelMakers: 2, maxParallelSupport: 6, permissionTemplateVersion: "3" }, git as any) }
}

describe("controlled Workshop orchestration seam", () => {
  it("rejects an incomplete SliceSpec before creating a Worker", async () => {
    const { manager, client } = harness()
    await expect(manager.submitSlice({ sliceId: "tickets-02-06", objective: "Implement five tickets" }, "parent", "/repo")).rejects.toThrow()
    expect(client.session.create).not.toHaveBeenCalled()
  })

  it("creates one fresh Maker session without generic task or bash tools", async () => {
    const { manager, client } = harness()
    const handle = await manager.submitSlice(spec(), "parent", "/repo")
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledOnce())
    expect(handle.taskId).toBe("slice:parent:ticket-01")
    const prompt = client.session.promptAsync.mock.calls[0][0]
    expect(prompt.query.directory).toBe("/tmp/ticket-01")
    expect(prompt.body.agent).toBe("maker")
    expect(prompt.body.tools).toEqual({ task: false, bash: false })
    expect(JSON.stringify(prompt)).not.toContain("summary.diffs")
  })

  it("rejects overlapping active Write Sets", async () => {
    const { manager } = harness()
    await manager.submitSlice(spec(), "parent", "/repo")
    await expect(manager.submitSlice(spec({ sliceId: "ticket-02", writeSet: ["src/index.ts"] }), "parent", "/repo")).rejects.toThrow(/overlaps/)
  })

  it("rejects unresolved Slice blockers", async () => {
    const { manager } = harness()
    await expect(manager.submitSlice(spec({ blockers: ["ticket-00"] }), "parent", "/repo")).rejects.toThrow(/Unresolved Slice blockers/)
  })

  it("keeps Maker completion separate from Foreman acceptance", async () => {
    const { manager, client, git } = harness()
    await manager.submitSlice(spec(), "parent", "/repo")
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledOnce())
    const ready = await manager.submitResult("ses_1", "maker", { outcome: "completed", summary: "done", changedPaths: [], evidence: ["focused green"], unknowns: [], risks: [], nextStep: "gate", newTestCases: 0 })
    expect(ready.runStatus).toBe("result_ready")
    expect(ready.acceptanceStatus).toBe("not_evaluated")
    manager.recordGate("slice:parent:ticket-01", "npm test -- focused", 0)
    const accepted = await manager.accept("slice:parent:ticket-01")
    expect(accepted.acceptanceStatus).toBe("accepted")
    expect(git.accept).toHaveBeenCalledOnce()
    expect(client.session.promptAsync).toHaveBeenCalledTimes(2)
    expect(client.session.promptAsync.mock.calls[1][0].body.agent).toBe("foreman")
  })

  it("refuses acceptance without successful Foreman Gate evidence", async () => {
    const { manager, client } = harness()
    await manager.submitSlice(spec(), "parent", "/repo")
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledOnce())
    await manager.submitResult("ses_1", "maker", { outcome: "completed", summary: "done", changedPaths: [], evidence: [], unknowns: [], risks: [], nextStep: "gate", newTestCases: 0 })
    await expect(manager.accept("slice:parent:ticket-01")).rejects.toThrow(/Verification Plan/)
  })

  it("prevents Maker commands outside the declared Test Budget", async () => {
    const { manager, client } = harness()
    await manager.submitSlice(spec(), "parent", "/repo")
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledOnce())
    expect(() => manager.authorizeSliceCommand("ses_1", "npm run test:full-suite")).toThrow(/Test Budget/)
    expect(() => manager.authorizeSliceCommand("ses_1", "npm test -- focused")).not.toThrow()
  })

  it("fails a result that escapes its Write Set", async () => {
    const { manager, client, git } = harness()
    git.changedPaths.mockResolvedValueOnce(["README.md"])
    await manager.submitSlice(spec(), "parent", "/repo")
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledOnce())
    const ready = await manager.submitResult("ses_1", "maker", { outcome: "completed", summary: "done", changedPaths: [], evidence: [], unknowns: [], risks: [], nextStep: "gate", newTestCases: 0 })
    expect(ready.result?.outcome).toBe("failed")
    expect(ready.result?.risks[0]).toMatch(/Write Set violation/)
  })

  it("allows re-submission after a failed Slice by reusing the worktree", async () => {
    const { manager, client, git } = harness()
    await manager.submitSlice(spec(), "parent", "/repo")
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledOnce())
    await manager.cancel("slice:parent:ticket-01")
    expect(manager.get("slice:parent:ticket-01").runStatus).toBe("cancelled")
    const retried = await manager.submitSlice(spec({ sliceId: "ticket-01" }), "parent", "/repo")
    expect(retried.taskId).toBe("slice:parent:ticket-01")
    expect(git.createSlice).toHaveBeenCalledTimes(1)
  })

  it("resolves a missing integration checkpoint from the Integration Branch", async () => {
    const { manager, client } = harness()
    const incomplete = spec()
    delete incomplete.integrationCheckpoint
    const handle = await manager.submitSlice(incomplete, "parent", "/repo")
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledOnce())
    expect(handle.taskId).toBe("slice:parent:ticket-01")
  })
})

describe("controlled command policy", () => {
  const runner = new CommandRunner()
  it("allows unknown project commands", () => expect(runner.classify("colcon test --packages-select demo")).toBe("allow"))
  it("asks before ROS host interaction", () => expect(runner.classify("ros2 launch demo bringup.launch.py")).toBe("ask"))
  it("denies destructive Git history changes", () => expect(runner.classify("git reset --hard HEAD~1")).toBe("deny"))
  it("blocks direct large SQLite investigation in the first release", () => expect(runner.classify("sqlite3 opencode.db 'select * from message'")).toBe("deny"))
})

describe("SliceSpec budgets", () => {
  it("rejects initial context larger than 256 KiB", () => {
    expect(() => sliceSpecSchema.parse(spec({ objective: "x".repeat(300_000) }))).toThrow()
  })
  it("rejects paths that escape the Slice worktree", () => {
    expect(() => sliceSpecSchema.parse(spec({ writeSet: ["../outside.ts"] }))).toThrow(/relative/)
  })
})
