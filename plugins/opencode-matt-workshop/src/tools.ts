import { tool, type PluginInput } from "@opencode-ai/plugin"
import { z } from "zod"
import { CommandRunner, RESOURCE_LIMITS } from "./command-runner.js"
import { outcomeSchema } from "./orchestration/contracts.js"
import { OrchestrationManager } from "./orchestration/manager.js"

const parseJson = (value: string, label: string) => { try { return JSON.parse(value) } catch { throw new Error(`${label} must be valid JSON`) } }
const render = (value: unknown) => JSON.stringify(value, null, 2)
const testBudget = z.object({ allowedTestPaths: z.array(z.string()), focusedCommands: z.array(z.string()).min(1), fullSuiteCommands: z.array(z.string()).default([]), maxNewTestFiles: z.number().int().nonnegative(), maxNewTestCases: z.number().int().nonnegative(), allowFullSuite: z.boolean().default(false) })
const sliceBudgets = z.object({ turnWarning: z.number().int().positive().max(40).default(40), turnLimit: z.number().int().positive().max(60).default(60), wallWarningMinutes: z.number().positive().max(15).default(15), wallLimitMinutes: z.number().positive().max(20).default(20), noProgressMinutes: z.number().positive().max(5).default(5) }).default({ turnWarning: 40, turnLimit: 60, wallWarningMinutes: 15, wallLimitMinutes: 20, noProgressMinutes: 5 })

export function buildWorkshopTools(input: PluginInput, manager: OrchestrationManager) {
  const runner = new CommandRunner()
  const command = (name: string, role: "primary" | "maker" | "support", gate = false) => tool({
    description: `Run a ${name} command through Workshop reliability controls. Unknown project commands are allowed; dangerous commands are denied and external side effects require approval.`,
    args: { command: z.string().min(1), phase: z.string().min(1).default(name), focused_test_status: z.string().optional(), task_id: z.string().optional() },
    async execute(args, context) {
      const controlled = manager.bySession(context.sessionID)
      if (role === "maker" && controlled?.role !== "maker") throw new Error("This command tool requires a controlled Maker session")
      if (role === "support" && (!controlled || controlled.role === "maker")) throw new Error("This command tool requires a controlled Support Worker session")
      if (role === "maker") manager.authorizeSliceCommand(context.sessionID, args.command)
      if (gate && !args.task_id) throw new Error("Acceptance Gate command requires task_id")
      const classification = runner.classify(args.command)
      if (classification === "deny") throw new Error("Command denied by Workshop reliability policy")
      if (classification === "ask") {
        if (controlled) manager.pauseForApproval(context.sessionID)
        try {
          await context.ask({ permission: "workshop_external_side_effect", patterns: [args.command], always: [], metadata: { scope: controlled?.taskId ?? context.sessionID } })
          if (controlled) await manager.resumeAfterApproval(context.sessionID)
        } catch (error) {
          if (controlled) await manager.blockForDeniedApproval(context.sessionID)
          throw error
        }
      }
      if (controlled) manager.progress(context.sessionID, args.phase, args.focused_test_status)
      const limits = role === "primary" ? RESOURCE_LIMITS.primary : RESOURCE_LIMITS[controlled?.role ?? "maker"]
      const directory = gate ? manager.commandDirectory(args.task_id!) : controlled?.directory
      if (gate && !directory) throw new Error("Unknown Slice for Acceptance Gate command")
      const result = await runner.run(args.command, directory ?? context.directory, limits, context.abort)
      if (gate) manager.recordGate(args.task_id!, args.command, result.exitCode)
      return { title: `${name}: ${args.phase}`, output: render(result), metadata: { exitCode: result.exitCode, timedOut: result.timedOut } }
    },
  })

  return {
    workshop_submit_slice: tool({
      description: "Submit exactly one structured Delegable Slice. Returns a Task Handle immediately after admission.",
      args: { sliceId: z.string().min(1), ticketRef: z.string().optional(), objective: z.string().min(10), acceptanceConditions: z.array(z.string()).min(1), blockers: z.array(z.string()).default([]), writeSet: z.array(z.string()).min(1), verificationPlan: z.array(z.string()).min(1), testBudget, contextRefs: z.array(z.string()).default([]), integrationCheckpoint: z.string().optional(), budgets: sliceBudgets },
      execute: async (args, context) => { if (context.agent !== "foreman") throw new Error("Only Foreman can submit a Delegable Slice"); return render(await manager.submitSlice(args, context.sessionID, context.directory, context.agent)) },
    }),
    workshop_submit_slice_json: tool({ description: "Compatibility entry for an existing JSON SliceSpec. Prefer workshop_submit_slice.", args: { slice_spec_json: z.string().min(2) }, execute: async (args, context) => { if (context.agent !== "foreman") throw new Error("Only Foreman can submit a Delegable Slice"); return render(await manager.submitSlice(parseJson(args.slice_spec_json, "SliceSpec"), context.sessionID, context.directory, context.agent)) } }),
    workshop_submit_assignment: tool({
      description: "Submit one structured Inspector, Archivist, or Surveyor Assignment. Returns a Task Handle.",
      args: { assignment_spec_json: z.string().min(2) },
      execute: async (args, context) => render(await manager.submitAssignment(parseJson(args.assignment_spec_json, "AssignmentSpec"), context.sessionID, context.directory, context.agent)),
    }),
    workshop_task_status: tool({ description: "Read one controlled Task Handle.", args: { task_id: z.string().min(1) }, execute: async (args) => render(manager.get(args.task_id)) }),
    workshop_task_cancel: tool({ description: "Cancel one controlled Task Handle and its Worker session.", args: { task_id: z.string().min(1) }, execute: async (args) => render(await manager.cancel(args.task_id)) }),
    workshop_task_steer: tool({ description: "Clarify a running assignment without expanding its contract or budget.", args: { task_id: z.string().min(1), clarification: z.string().min(1).max(4_000) }, execute: async (args) => render(await manager.steer(args.task_id, args.clarification)) }),
    workshop_submit_result: tool({
      description: "Return the controlled Worker's structured result. Maker completion is not Foreman acceptance.",
      args: { outcome: outcomeSchema, summary: z.string().min(1), evidence: z.array(z.string()), unknowns: z.array(z.string()), risks: z.array(z.string()), next_step: z.string().min(1), new_test_cases: z.number().int().nonnegative() },
      execute: async (args, context) => render(await manager.submitResult(context.sessionID, context.agent, { outcome: args.outcome, summary: args.summary, changedPaths: [], evidence: args.evidence, unknowns: args.unknowns, risks: args.risks, nextStep: args.next_step, newTestCases: args.new_test_cases })),
    }),
    workshop_accept_slice: tool({ description: "After Foreman personally runs the Slice Gate, accept a completed Ticket Result and create/integrate its checkpoint.", args: { task_id: z.string().min(1) }, execute: async (args, context) => { if (context.agent !== "foreman") throw new Error("Only Foreman can accept a Slice"); return render(await manager.accept(args.task_id)) } }),
    workshop_integration_summary: tool({ description: "Show the Integration Summary before final merge.", args: {}, execute: async (_args, context) => { if (context.agent !== "foreman") throw new Error("Only Foreman owns integration"); return render(await manager.integrationSummary(context.sessionID)) } }),
    workshop_finalize_integration: tool({ description: "After Final Gate, ask the user once and merge the Integration Branch. Never pushes or rewrites history.", args: {}, execute: async (_args, context) => { if (context.agent !== "foreman") throw new Error("Only Foreman owns integration"); const summary = await manager.integrationSummary(context.sessionID); await context.ask({ permission: "workshop_final_integration", patterns: [summary.integrationBranch, summary.originalBranch], always: [], metadata: summary }); return render(await manager.finalizeIntegration(context.sessionID)) } }),
    workshop_run_slice_command: command("Slice", "maker"),
    workshop_run_assignment_command: command("Assignment", "support"),
    workshop_run_gate_command: command("Acceptance Gate", "primary", true),
    workshop_run_workspace_command: command("Quick Change", "primary"),
    workshop_run_planning_command: command("Planning", "primary"),
  }
}
