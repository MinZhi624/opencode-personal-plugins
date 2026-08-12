import { z } from "zod"
import { homedir } from "node:os"
import { resolve } from "node:path"

export const outcomeSchema = z.enum(["completed", "blocked", "partial", "failed"])
export type ResultOutcome = z.infer<typeof outcomeSchema>
export type RunStatus = "queued" | "starting" | "running" | "waiting_for_approval" | "stopping" | "result_ready" | "failed" | "cancelled"
export type AcceptanceStatus = "not_evaluated" | "accepted" | "rejected"

const budgets = z.object({
  turnWarning: z.number().int().positive().max(40).default(40),
  turnLimit: z.number().int().positive().max(60).default(60),
  wallWarningMinutes: z.number().positive().max(15).default(15),
  wallLimitMinutes: z.number().positive().max(20).default(20),
  noProgressMinutes: z.number().positive().max(5).default(5),
}).strict().default({ turnWarning: 40, turnLimit: 60, wallWarningMinutes: 15, wallLimitMinutes: 20, noProgressMinutes: 5 })

export const sliceSpecSchema = z.object({
  sliceId: z.string().min(1).max(100),
  ticketRef: z.string().min(1).max(200).optional(),
  objective: z.string().min(10).max(8_000),
  acceptanceConditions: z.array(z.string().min(3)).min(1).max(30),
  blockers: z.array(z.string().min(1)).max(30).default([]),
  writeSet: z.array(z.string().min(1)).min(1).max(100),
  verificationPlan: z.array(z.string().min(1)).min(1).max(30),
  testBudget: z.object({
    allowedTestPaths: z.array(z.string().min(1)).max(50),
    focusedCommands: z.array(z.string().min(1)).min(1).max(20),
    fullSuiteCommands: z.array(z.string().min(1)).max(5).default([]),
    maxNewTestFiles: z.number().int().nonnegative().max(20),
    maxNewTestCases: z.number().int().nonnegative().max(100),
    allowFullSuite: z.boolean().default(false),
  }).strict(),
  contextRefs: z.array(z.string().min(1)).max(100),
  integrationCheckpoint: z.string().regex(/^[0-9a-f]{7,64}$/).optional(),
  budgets,
}).strict().superRefine((value, context) => {
  if (value.budgets.turnWarning >= value.budgets.turnLimit) context.addIssue({ code: "custom", path: ["budgets", "turnWarning"], message: "turn warning must be below limit" })
  if (value.budgets.wallWarningMinutes >= value.budgets.wallLimitMinutes) context.addIssue({ code: "custom", path: ["budgets", "wallWarningMinutes"], message: "wall warning must be below limit" })
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 256 * 1024) context.addIssue({ code: "custom", message: "initial Slice context exceeds 256 KiB" })
  for (const [field, paths] of [["writeSet", value.writeSet], ["allowedTestPaths", value.testBudget.allowedTestPaths], ["contextRefs", value.contextRefs]] as const) {
    paths.forEach((path, index) => {
      if (path.startsWith("/") || path.split(/[\\/]/).includes("..")) context.addIssue({ code: "custom", path: [field, index], message: "path must stay relative to the Slice worktree" })
    })
  }
})

export const assignmentSpecSchema = z.object({
  assignmentId: z.string().min(1).max(100),
  role: z.enum(["inspector", "archivist", "surveyor"]),
  objective: z.string().min(10).max(8_000),
  evidenceExpectations: z.array(z.string().min(1)).min(1).max(30),
  contextRefs: z.array(z.string().min(1)).max(100),
  externalReadRoots: z.array(z.string().min(1)).max(20).default([]),
  budgets: z.object({
    turnWarning: z.number().int().positive().max(60).default(60),
    turnLimit: z.number().int().positive().max(90).default(90),
    wallWarningMinutes: z.number().positive().max(20).default(20),
    wallLimitMinutes: z.number().positive().max(30).default(30),
    noProgressMinutes: z.number().positive().max(10).default(10),
  }).strict().default({ turnWarning: 60, turnLimit: 90, wallWarningMinutes: 20, wallLimitMinutes: 30, noProgressMinutes: 10 }),
}).strict().superRefine((value, context) => {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 256 * 1024) context.addIssue({ code: "custom", message: "initial Assignment context exceeds 256 KiB" })
  for (const [index, root] of value.externalReadRoots.entries()) {
    const absolute = resolve(root)
    if (absolute === "/" || absolute === resolve(homedir())) context.addIssue({ code: "custom", path: ["externalReadRoots", index], message: "external read root is too broad" })
  }
})

export type SliceSpec = z.infer<typeof sliceSpecSchema>
export type AssignmentSpec = z.infer<typeof assignmentSpecSchema>

export type StructuredResult = {
  outcome: ResultOutcome
  summary: string
  changedPaths: string[]
  evidence: string[]
  unknowns: string[]
  risks: string[]
  nextStep: string
  newTestCases: number
}

export type TaskProgress = {
  phase: string
  turns: number
  turnLimit: number
  elapsedMs: number
  wallLimitMs: number
  lastProgressAt: number
  changedPaths: number
  focusedTestStatus?: string
  warning?: string
}

export type TaskSnapshot = {
  taskId: string
  kind: "slice" | "assignment"
  title: string
  role: "maker" | "inspector" | "archivist" | "surveyor"
  runStatus: RunStatus
  acceptanceStatus: AcceptanceStatus
  sessionId?: string
  directory: string
  progress: TaskProgress
  result?: StructuredResult
  terminalReason?: string
}
