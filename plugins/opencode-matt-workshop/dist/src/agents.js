import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifest } from "./catalog.js";
import { archivistPrompt, drafterPrompt, foremanPrompt, inspectorPrompt, makerPrompt, surveyorPrompt, tinkerPrompt } from "./prompts.js";
const skills = (names) => Object.fromEntries([["*", "deny"], ...names.map((name) => [name, "allow"])]);
const sensitiveRead = (value) => ({ "*": "allow", "*.env": value, "*.env.*": value, "*.env.example": "allow" });
const supportTasks = { "*": "deny", inspector: "allow", archivist: "allow", surveyor: "allow" };
const codeBash = { "*": "allow", "*git *": "deny", "git *": "deny" };
const gitRead = { "*": "deny", "*git *": "deny", "git *": "deny", "git status*": "allow", "git diff*": "allow", "git log*": "allow", "git show*": "allow", "git rev-parse*": "allow" };
function drafterPermissions() { const temp = tmpdir(); return { read: sensitiveRead("ask"), glob: "allow", grep: "allow", list: "allow", edit: { "*": "deny", "*.md": "allow", "**/*.md": "allow", [join(temp, "*.md")]: "allow" }, bash: { ...gitRead, "gh *": "ask", "glab *": "ask" }, task: supportTasks, external_directory: { "*": "deny", [`${temp}/**`]: "allow" }, todowrite: "allow", question: "allow", webfetch: "allow", websearch: "allow", lsp: "allow", doom_loop: "deny", skill: skills(manifest.agentSkills.drafter) }; }
function foremanPermissions() { return { read: sensitiveRead("ask"), edit: "allow", glob: "allow", grep: "allow", list: "allow", bash: { ...codeBash, ...gitRead, "git add*": "allow", "git commit*": "allow" }, task: { ...supportTasks, maker: "allow" }, external_directory: "ask", todowrite: "allow", question: "allow", webfetch: "allow", websearch: "allow", lsp: "allow", doom_loop: "deny", skill: skills(manifest.agentSkills.foreman) }; }
function tinkerPermissions() { return { read: sensitiveRead("ask"), edit: "allow", glob: "allow", grep: "allow", list: "allow", bash: codeBash, task: supportTasks, external_directory: "ask", todowrite: "deny", question: "allow", webfetch: "allow", websearch: "allow", lsp: "allow", doom_loop: "deny", skill: "allow" }; }
function makerPermissions() { return { read: sensitiveRead("deny"), edit: "allow", glob: "allow", grep: "allow", list: "allow", bash: codeBash, task: "deny", external_directory: "deny", todowrite: "allow", question: "deny", webfetch: "deny", websearch: "deny", lsp: "allow", doom_loop: "deny", skill: skills(manifest.agentSkills.maker) }; }
const readOnly = { read: sensitiveRead("deny"), edit: "deny", glob: "allow", grep: "allow", list: "allow", bash: "deny", task: "deny", external_directory: "deny", todowrite: "deny", question: "deny", webfetch: "deny", websearch: "deny", lsp: "allow", doom_loop: "deny", skill: "deny" };
const archivist = { ...readOnly, edit: { "*": "deny", "*.md": "allow", "**/*.md": "allow" }, webfetch: "allow", websearch: "allow", lsp: "deny" };
const surveyor = { ...readOnly, external_directory: "allow", list: "allow" };
function runtime(config, value) { if (!value)
    return config; const { reasoningEffort, ...rest } = value; return { ...config, ...rest, ...(reasoningEffort ? { options: { ...config.options, reasoningEffort } } : {}) }; }
export function buildWorkshopAgents(options) {
    return {
        drafter: runtime({ description: "用 Matt 工作流做规划并维护领域语言。", mode: "primary", color: "#8B5CF6", prompt: drafterPrompt(), permission: drafterPermissions() }, options.agents.drafter),
        foreman: runtime({ description: "实施 Ready Work 并协调 Maker。", mode: "primary", color: "#F59E0B", prompt: foremanPrompt(options.max_parallel_makers), permission: foremanPermissions() }, options.agents.foreman),
        tinker: runtime({ description: "默认的低摩擦修改 Agent。", mode: "primary", color: "#10B981", prompt: tinkerPrompt(), permission: tinkerPermissions() }, options.agents.tinker),
        maker: runtime({ description: "实施一个有界切片。", mode: "subagent", hidden: true, color: "#F97316", prompt: makerPrompt(), permission: makerPermissions() }, options.agents.maker),
        inspector: runtime({ description: "独立审查一个维度。", mode: "subagent", hidden: true, color: "#EF4444", prompt: inspectorPrompt(), permission: readOnly }, options.agents.inspector),
        archivist: runtime({ description: "调研一手来源。", mode: "subagent", hidden: true, color: "#3B82F6", prompt: archivistPrompt(), permission: archivist }, options.agents.archivist),
        surveyor: runtime({ description: "只读映射本地与跨工作区代码。", mode: "subagent", hidden: true, color: "#06B6D4", prompt: surveyorPrompt(), permission: surveyor }, options.agents.surveyor),
    };
}
