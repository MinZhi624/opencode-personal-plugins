import { access, readFile, readdir } from "node:fs/promises"
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

if (manifest.upstream.version !== provenance.version || manifest.upstream.commit !== provenance.commit) errors.push("Generated manifest provenance differs from the pinned upstream provenance.")
if (upstream.version !== provenance.version || upstream.skills.length !== 25) errors.push("Vendored upstream release is not the expected 25-skill v1.2.2 source.")
if (manifest.skills.length !== 25 || new Set(manifest.skills.map((skill) => skill.name)).size !== 25) errors.push("Manifest must contain exactly 25 unique skills.")
const names = manifest.skills.map((skill) => skill.name)
for (const obsolete of ["to-issues", "writing-great-skills"]) if (names.includes(obsolete)) errors.push(`Obsolete runtime skill remains: ${obsolete}`)
const userOnly = manifest.skills.filter((skill) => !skill.implicitInvocation)
if (userOnly.length !== 14 || manifest.skills.length - userOnly.length !== 11) errors.push("Expected 14 user-only and 11 model-invocable skills.")
const guarded = Object.fromEntries(manifest.skills.filter((skill) => skill.guardedBy).map((skill) => [skill.name, skill.guardedBy]).sort(([left], [right]) => left.localeCompare(right)))
const expectedGuarded = { implement: "foreman", tdd: "foreman", "diagnosing-bugs": "foreman", prototype: "foreman", "resolving-merge-conflicts": "foreman", wizard: "foreman", triage: "drafter", "to-spec": "drafter", "to-tickets": "drafter", wayfinder: "drafter" }
const sortedExpectedGuarded = Object.fromEntries(Object.entries(expectedGuarded).sort(([left], [right]) => left.localeCompare(right)))
if (JSON.stringify(guarded) !== JSON.stringify(sortedExpectedGuarded)) errors.push("Guarded command bindings differ from the accepted policy.")
for (const name of names) {
  try { await access(join(plugin, "skills", name, "SKILL.md"), constants.R_OK) } catch { errors.push(`Missing adapted skill: ${name}`) }
}
for (const [agent, allowed] of Object.entries(manifest.agentSkills)) for (const name of allowed) if (!names.includes(name)) errors.push(`${agent} permits nonexistent skill: ${name}`)
const commands = await import(join(plugin, "dist/src/commands.js"))
const actualCommands = commands.buildWorkshopCommands()
if (JSON.stringify(Object.keys(actualCommands).sort()) !== JSON.stringify([...names].sort())) errors.push("Commands must exactly match manifest skill names.")
if (actualCommands["to-tickets"]?.template.includes("to-issues")) errors.push("/to-tickets still resolves to to-issues.")
const agents = await import(join(plugin, "dist/src/agents.js"))
const builtAgents = agents.buildWorkshopAgents({ max_parallel_makers: 2, agents: {} })
if (builtAgents.foreman.permission.task?.maker !== undefined) errors.push("Foreman must not bypass controlled Slice submission through generic task-to-Maker.")
if (builtAgents.foreman.permission.bash !== "deny" || builtAgents.maker.permission.bash !== "deny") errors.push("Foreman and Maker direct bash must be denied in favor of controlled command tools.")
if (builtAgents.foreman.permission.workshop_submit_slice !== "allow") errors.push("Foreman is missing controlled Slice submission permission.")
if (builtAgents.maker.permission.workshop_submit_result !== "allow") errors.push("Maker is missing structured Ticket Result permission.")
const runtime = await import(join(plugin, "dist/src/index.js"))
if (typeof runtime.default !== "function") errors.push("Workshop Runtime Distribution is missing the plugin entry.")

if (errors.length) {
  console.error("Matt Workshop verification failed:")
  errors.forEach((error) => console.error(`- ${error}`))
  process.exitCode = 1
} else {
  console.log("Matt Workshop verification passed: upstream, sync manifest, commands, and permissions are consistent.")
}
