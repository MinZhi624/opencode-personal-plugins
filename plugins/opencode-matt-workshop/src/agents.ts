import { tmpdir } from "node:os"
import { join } from "node:path"
import { manifest } from "./catalog.js"
import { archivistPrompt, drafterPrompt, foremanPrompt, inspectorPrompt, makerPrompt, surveyorPrompt, tinkerPrompt } from "./prompts.js"

const skills = (names: string[]) => Object.fromEntries([["*", "deny"], ...names.map((name) => [name, "allow"])])
const sensitiveRead = (value: string) => ({ "*": "allow", "*.env": value, "*.env.*": value, "*.env.example": "allow" })
const supportTasks = { "*": "deny" }
const noBash = "deny"
const workerTools = { workshop_task_status: "allow", workshop_task_cancel: "allow", workshop_task_steer: "allow" }

function drafterPermissions() { const temp = tmpdir(); return { read: sensitiveRead("ask"), glob: "allow", grep: "allow", list: "allow", edit: { "*": "deny", "*.md": "allow", "**/*.md": "allow", [join(temp, "*.md")]: "allow" }, bash: noBash, task: supportTasks, workshop_submit_assignment: "allow", workshop_run_planning_command: "allow", ...workerTools, external_directory: { "*": "deny", [`${temp}/**`]: "allow" }, todowrite: "allow", question: "allow", webfetch: "allow", websearch: "allow", lsp: "allow", doom_loop: "deny", skill: skills(manifest.agentSkills.drafter) } }
function foremanPermissions() { return { read: sensitiveRead("ask"), edit: "deny", glob: "allow", grep: "allow", list: "allow", bash: noBash, task: supportTasks, workshop_submit_slice: "allow", workshop_submit_assignment: "allow", workshop_run_gate_command: "allow", workshop_accept_slice: "allow", workshop_integration_summary: "allow", workshop_finalize_integration: "allow", ...workerTools, external_directory: "ask", todowrite: "allow", question: "allow", webfetch: "allow", websearch: "allow", lsp: "allow", doom_loop: "deny", skill: skills(manifest.agentSkills.foreman) } }
function tinkerPermissions() { return { read: sensitiveRead("ask"), edit: "allow", glob: "allow", grep: "allow", list: "allow", bash: noBash, task: supportTasks, workshop_submit_assignment: "allow", workshop_run_workspace_command: "allow", ...workerTools, external_directory: "ask", todowrite: "deny", question: "allow", webfetch: "allow", websearch: "allow", lsp: "allow", doom_loop: "deny", skill: "allow" } }
function makerPermissions() { return { read: sensitiveRead("deny"), edit: "allow", glob: "allow", grep: "allow", list: "allow", bash: noBash, task: "deny", workshop_run_slice_command: "allow", workshop_submit_result: "allow", external_directory: "deny", todowrite: "allow", question: "deny", webfetch: "deny", websearch: "deny", lsp: "allow", doom_loop: "deny", skill: skills(manifest.agentSkills.maker) } }
const readOnly = { read: sensitiveRead("deny"), edit: "deny", glob: "allow", grep: "allow", list: "allow", bash: "deny", task: "deny", workshop_run_assignment_command: "allow", workshop_submit_result: "allow", external_directory: "deny", todowrite: "deny", question: "deny", webfetch: "deny", websearch: "deny", lsp: "allow", doom_loop: "deny", skill: "deny" }
const archivist = { ...readOnly, edit: { "*": "deny", "*.md": "allow", "**/*.md": "allow" }, webfetch: "allow", websearch: "allow", lsp: "deny" }
const surveyor = { ...readOnly, list: "allow" }
function runtime(config: Record<string, unknown>, value: Record<string, unknown> | undefined) { if (!value) return config; const { reasoningEffort, ...rest } = value; return { ...config, ...rest, ...(reasoningEffort ? { options: { ...(config.options as object), reasoningEffort } } : {}) } }
export function buildWorkshopAgents(options: any) { return {
  drafter: runtime({ description: "用 Matt 工作流做规划并维护领域语言。", mode: "primary", color: "#8B5CF6", prompt: drafterPrompt(), permission: drafterPermissions() }, options.agents.drafter),
  foreman: runtime({ description: "实施 Ready Work 并协调 Maker。", mode: "primary", color: "#F59E0B", prompt: foremanPrompt(options.max_parallel_makers), permission: foremanPermissions() }, options.agents.foreman),
  tinker: runtime({ description: "默认的低摩擦修改 Agent。", mode: "primary", color: "#10B981", prompt: tinkerPrompt(), permission: tinkerPermissions() }, options.agents.tinker),
  maker: runtime({ description: "实施一个有界切片。", mode: "subagent", hidden: true, color: "#F97316", prompt: makerPrompt(), permission: makerPermissions() }, options.agents.maker),
  inspector: runtime({ description: "独立审查一个维度。", mode: "subagent", hidden: true, color: "#EF4444", prompt: inspectorPrompt(), permission: readOnly }, options.agents.inspector),
  archivist: runtime({ description: "调研一手来源。", mode: "subagent", hidden: true, color: "#3B82F6", prompt: archivistPrompt(), permission: archivist }, options.agents.archivist),
  surveyor: runtime({ description: "只读映射本地与跨工作区代码。", mode: "subagent", hidden: true, color: "#06B6D4", prompt: surveyorPrompt(), permission: surveyor }, options.agents.surveyor),
} }
