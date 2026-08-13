import { access, readFile } from "node:fs/promises"
import { constants } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const plugin = join(root, "plugins/opencode-matt-workshop")
const vendor = join(plugin, "vendor/mattpocock-skills")
const provenance = JSON.parse(await readFile(join(plugin, "upstream-provenance.json"), "utf8"))
const manifest = JSON.parse(await readFile(join(plugin, "skill-manifest.json"), "utf8"))
const upstream = JSON.parse(await readFile(join(vendor, ".claude-plugin/plugin.json"), "utf8"))
const errors = []

function check(condition, message) {
  if (!condition) errors.push(message)
}

check(manifest.upstream.version === provenance.version, "Manifest version differs from provenance.")
check(manifest.upstream.commit === provenance.commit, "Manifest commit differs from provenance.")
check(upstream.version === provenance.version, "Vendored version differs from provenance.")
check(upstream.skills.length === 25, "Vendored release must expose 25 promoted skills.")
check(manifest.skills.length === 25, "Manifest must contain 25 skills.")
check(new Set(manifest.skills.map((skill) => skill.name)).size === 25, "Manifest skill names must be unique.")
check(!("agentSkills" in manifest), "Manifest must not contain legacy agentSkills policy.")

const names = manifest.skills.map((skill) => skill.name)
for (const name of names) {
  try {
    await access(join(plugin, "skills", name, "SKILL.md"), constants.R_OK)
  } catch {
    errors.push(`Missing adapted skill: ${name}`)
  }
}

const commandsModule = await import(join(plugin, "dist/src/commands.js"))
const commands = commandsModule.buildWorkshopCommands()
const runtimeNames = names.map((name) => (name === "handoff" ? "matt-handoff" : name))
check(
  JSON.stringify(Object.keys(commands).sort()) === JSON.stringify(runtimeNames.sort()),
  "Commands must expose all 25 entries including matt-handoff.",
)
check(!commands["to-tickets"]?.template.includes("to-issues"), "/to-tickets must not resolve to to-issues.")

const optionsModule = await import(join(plugin, "dist/src/options.js"))
const emptyOptions = optionsModule.parseWorkshopOptions()
check(JSON.stringify(emptyOptions) === JSON.stringify({ agents: {} }), "Empty options must produce an empty agents map.")
for (const invalid of [
  { max_parallel_makers: 2 },
  { agents: { maker: { reasoningEffort: "high" } } },
  { agents: { maker: { steps: 0 } } },
  { agents: { unknown: {} } },
]) {
  let rejected = false
  try {
    optionsModule.parseWorkshopOptions(invalid)
  } catch (error) {
    rejected = error instanceof optionsModule.WorkshopOptionsError
  }
  check(rejected, `Invalid options were accepted: ${JSON.stringify(invalid)}`)
}

const agentsModule = await import(join(plugin, "dist/src/agents.js"))
const agents = agentsModule.buildWorkshopAgents(emptyOptions)
const expectedAgentNames = ["drafter", "tinker", "foreman", "maker", "inspector", "archivist", "surveyor"]
check(JSON.stringify(Object.keys(agents)) === JSON.stringify(expectedAgentNames), "Workshop must expose exactly seven ordered agents.")
for (const name of ["drafter", "tinker", "foreman"]) {
  check(agents[name]?.mode === "primary", `${name} must be primary.`)
  check(agents[name]?.steps === undefined, `${name} must not set default steps.`)
  check(agents[name]?.model === undefined, `${name} must not set a default model.`)
}
for (const [name, steps] of Object.entries({ maker: 40, inspector: 24, archivist: 20, surveyor: 32 })) {
  check(agents[name]?.mode === "subagent", `${name} must be a subagent.`)
  check(agents[name]?.steps === steps, `${name} must default to ${steps} steps.`)
  check(agents[name]?.model === undefined, `${name} must not set a default model.`)
}
check(agents.maker.hidden === true && agents.inspector.hidden === true, "Maker and Inspector must be hidden.")
check(agents.archivist.hidden !== true && agents.surveyor.hidden !== true, "Archivist and Surveyor must be visible.")
check(agents.tinker.permission.task === "deny", "Tinker must deny task delegation.")
check(agents.maker.permission.task === "deny", "Maker must deny nested delegation.")
check(agents.drafter.permission.task.maker === undefined, "Drafter must not delegate Maker.")
check(agents.foreman.permission.task.maker === "allow", "Foreman must delegate Maker.")

const fixedEnding = "规划已完成。请选择：继续与 Drafter 讨论；切换到 Tinker 进行单 Agent 实现；切换到 Foreman 进行可调度实现。若任务需要跨窗口持久化，请先运行 /to-spec，再运行 /to-tickets。"
check(agents.drafter.prompt.includes(fixedEnding), "Drafter prompt is missing the fixed manual-transition ending.")
for (const [name, steps] of Object.entries({ maker: 40, inspector: 24, archivist: 20, surveyor: 32 })) {
  check(agents[name].prompt.includes(`Hard ceiling: ${steps} steps.`), `${name} prompt is missing its hard ceiling.`)
  check(agents[name].prompt.includes("three consecutive iterations"), `${name} prompt is missing the no-progress stop.`)
}

const runtime = await import(join(plugin, "dist/src/index.js"))
check(typeof runtime.default === "function", "Runtime Distribution is missing the plugin entry.")
if (typeof runtime.default === "function") {
  const hooks = await runtime.default({})
  check(typeof hooks.config === "function", "Plugin must register a config hook.")
  check(!hooks.tool && !hooks.event, "Plugin must not register custom tools or events.")
  if (typeof hooks.config === "function") {
    const config = { agent: { builtin: { mode: "primary" } }, command: { existing: { template: "keep" } }, skills: { paths: ["keep"] } }
    await hooks.config(config)
    check(config.default_agent === "tinker", "Plugin must set Tinker as default agent.")
    check(config.agent.builtin?.mode === "primary", "Plugin must preserve existing agents.")
    check(Object.keys(config.agent).length === 8, "Config must contain existing plus seven Workshop agents.")
    check(config.command.existing?.template === "keep", "Plugin must preserve existing commands.")
    check(Object.keys(config.command).length === 26, "Config must contain existing plus 25 Workshop commands.")
    check(config.skills.paths.includes("keep"), "Plugin must preserve existing skill paths.")
  }
}

for (const name of names) {
  const content = await readFile(join(plugin, "skills", name, "SKILL.md"), "utf8")
  check(content.includes("## OpenCode Adapter"), `${name} is missing the OpenCode adapter header.`)
  check(!/Oh My OpenAgent|task\(category=|subagent_type=|workshop_/.test(content), `${name} contains legacy orchestration markers.`)
}
const handoff = await readFile(join(plugin, "skills", "handoff", "SKILL.md"), "utf8")
check(handoff.includes("name: matt-handoff"), "Matt handoff must retain its non-conflicting runtime name.")

if (errors.length) {
  console.error("Standalone Matt Workshop verification failed:")
  errors.forEach((error) => console.error(`- ${error}`))
  process.exitCode = 1
} else {
  console.log("Standalone Matt Workshop verification passed: 7 agents, 25 skills, native permissions, strict options, and no controlled runtime.")
}
