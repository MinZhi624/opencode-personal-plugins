import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const plugin = join(root, "plugins/opencode-matt-workshop")
const vendor = join(plugin, "vendor/mattpocock-skills")
const source = join(root, "skills-1.2.2")
const output = join(plugin, "skills")
const manifestOutput = join(plugin, "skill-manifest.json")
const provenance = JSON.parse(await readFile(join(plugin, "upstream-provenance.json"), "utf8"))
const args = new Set(process.argv.slice(2))
const guardedCommands = {
  drafter: ["triage", "to-spec", "to-tickets", "wayfinder"],
  foreman: ["implement", "tdd", "diagnosing-bugs", "prototype", "resolving-merge-conflicts", "wizard"],
}

if (args.has("--vendor")) {
  await rm(vendor, { recursive: true, force: true })
  await cp(source, vendor, { recursive: true, dereference: false, force: true })
  if (args.has("--clean-source")) await rm(source, { recursive: true, force: true })
  console.log(`Vendored ${provenance.tag} at ${relative(root, vendor)}`)
  process.exit(0)
}

function parseFrontmatter(content, sourcePath) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/)
  if (!match) throw new Error(`Missing frontmatter: ${sourcePath}`)
  const values = Object.fromEntries(match[1].split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf(":")
    return [line.slice(0, separator), line.slice(separator + 1).trim().replace(/^"|"$/g, "")]
  }))
  return { values, body: content.slice(match[0].length) }
}

function adapterBody(name, body) {
  const roleGuidance = {
    implement: "In Tinker, implement without delegation; verify with the cheapest adequate checks and deliver, without the review workflow. In Foreman, own the main line and delegate only for stated leverage; run the final Standards and Spec axes as two parallel Inspector Worker Runs. In any other Primary Agent, stop and ask the user to select Tinker or Foreman.",
    tdd: "TDD is opt-in. Before writing a test, ask the user to select the seams and behaviors it will cover, even when `/tdd` was invoked directly. Do not let an agent choose that scope implicitly.",
    "code-review": "In Tinker, perform the Standards and Spec axes yourself. In Foreman, start two independent Inspector Worker Runs in parallel and aggregate their findings. Do not use unrelated generic subagents.",
    research: "Use Archivist for delegated external primary-source research. Tinker cannot delegate: it must ask the user to select Foreman or invoke visible Archivist directly.",
    "improve-codebase-architecture": "Use Surveyor for codebase mapping and Inspector for constrained design alternatives. Tinker cannot delegate and must ask the user to select Foreman or invoke a visible suitable Worker directly.",
  }[name]
  const adapter = [
    "## OpenCode Adapter",
    "",
    "References such as `/tdd` name Workflow Skills. Slash commands are the user-facing entries. Use only the current Workshop Primary Agent's native OpenCode capabilities and role boundaries. Never switch Primary Agents automatically.",
    ...(roleGuidance ? ["", roleGuidance] : []),
    "",
  ].join("\n")
  let result = body
  result = result.replaceAll("Agent tool", "OpenCode task tool")
  result = result.replaceAll("`/handoff`", "`/matt-handoff`")
  if (name === "research") {
    result = replaceAnchor(result, "Spin up a **background agent** to do the research, so you keep working while it reads.", "When the active role can delegate, start one Archivist Worker Run with the full research brief and target Markdown report path. Otherwise stop and ask the user to invoke visible Archivist or select Foreman.", name)
  }
  if (name === "code-review") {
    result = replaceAnchor(result, "Send a single message with two `Agent` tool calls. Use the `general-purpose` subagent for both.", "In Foreman, send one message containing two native task calls to Inspector, one for each review axis. In Tinker, execute both review axes yourself without task calls.", name)
  }
  if (name === "improve-codebase-architecture") {
    result = replaceAnchor(result, "Then use the OpenCode task tool with `subagent_type=Explore` to walk the codebase.", "When the active Primary Agent can delegate, use a Surveyor Worker Run to walk the codebase. In Tinker, stop and ask the user to select Foreman or invoke visible Surveyor directly.", name)
  }
  if (name === "setup-matt-pocock-skills") {
    result = replaceAnchor(result, "- If `CLAUDE.md` exists, edit it.\n- Else if `AGENTS.md` exists, edit it.", "- If `AGENTS.md` exists, edit it.\n- Else if `CLAUDE.md` exists, edit it.", name)
    result = replaceAnchor(result, "Never create `AGENTS.md` when `CLAUDE.md` already exists (or vice versa) — always edit the one that's already there.", "Never create a second instruction file when one already exists — OpenCode reads `AGENTS.md` before falling back to `CLAUDE.md`.", name)
  }
  if (name === "wayfinder") result = replaceAnchor(result, "capturing its findings on a throwaway `research/<name>` branch with a context pointer from the ticket.", "writing its findings to a unique Markdown path in the current worktree with a context pointer from the ticket. Do not create a branch.", name)
  if (name === "wizard") result = `Before creating or validating a wizard, verify that Bash is available. On Windows, require WSL or Git Bash; do not attempt a PowerShell rewrite.\n\n${result}`
  return `${adapter}${result}`
}

function replaceAnchor(content, anchor, replacement, name) {
  if (!content.includes(anchor)) throw new Error(`OpenCode overlay anchor changed in ${name}: ${anchor}`)
  return content.replace(anchor, replacement)
}

async function copySkill(sourceDir, destinationDir, name, implicitInvocation) {
  await rm(destinationDir, { recursive: true, force: true })
  await cp(sourceDir, destinationDir, { recursive: true, filter: (path) => !path.includes(`${join(sourceDir, "agents")}`) })
  const skillPath = join(sourceDir, "SKILL.md")
  const parsed = parseFrontmatter(await readFile(skillPath, "utf8"), skillPath)
  if (parsed.values.name !== name) throw new Error(`Manifest name mismatch for ${name}: ${parsed.values.name}`)
  const description = implicitInvocation ? parsed.values.description : `Use ONLY when the user explicitly invokes /${name}. ${parsed.values.description}`
  const runtimeName = name === "handoff" ? "matt-handoff" : name
  const content = `---\nname: ${runtimeName}\ndescription: ${JSON.stringify(description)}\n---\n\n${adapterBody(name, parsed.body)}`
  await writeFile(join(destinationDir, "SKILL.md"), content)
  if (name === "codebase-design") {
    const designPath = join(destinationDir, "DESIGN-IT-TWICE.md")
    const design = await readFile(designPath, "utf8")
    await writeFile(designPath, design.replace("Spawn 3+ sub-agents in parallel using the Agent tool.", "When the active Primary Agent can delegate, start 3+ Inspector Worker Runs in parallel. In Tinker, stop and ask the user to select Foreman."))
  }
}

async function generate(targetSkills, targetManifest) {
  const upstreamPackage = JSON.parse(await readFile(join(vendor, "package.json"), "utf8"))
  if (upstreamPackage.version !== provenance.version) throw new Error(`Vendored version must be ${provenance.version}, found ${upstreamPackage.version}`)
  const pluginManifest = JSON.parse(await readFile(join(vendor, ".claude-plugin/plugin.json"), "utf8"))
  const entries = pluginManifest.skills
  if (!Array.isArray(entries) || entries.length !== 25) throw new Error(`Expected 25 promoted skills, found ${entries?.length ?? "none"}`)
  await rm(targetSkills, { recursive: true, force: true })
  const skills = []
  for (const entry of entries) {
    const sourceDir = join(vendor, entry)
    const name = basename(entry)
    const parsed = parseFrontmatter(await readFile(join(sourceDir, "SKILL.md"), "utf8"), entry)
    const implicitInvocation = parsed.values["disable-model-invocation"] !== "true"
    const guardedBy = Object.entries(guardedCommands).find(([, names]) => names.includes(name))?.[0] ?? null
    await copySkill(sourceDir, join(targetSkills, name), name, implicitInvocation)
    skills.push({ name, implicitInvocation, command: true, guardedBy })
  }
  const manifest = { upstream: { version: provenance.version, tag: provenance.tag, commit: provenance.commit }, skills }
  await writeFile(targetManifest, `${JSON.stringify(manifest, null, 2)}\n`)
}

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return files(path)
    return [path]
  }))).flat()
}
async function equalTrees(left, right) {
  const leftFiles = await files(left)
  const rightFiles = await files(right)
  const leftRelative = leftFiles.map((path) => relative(left, path)).sort()
  const rightRelative = rightFiles.map((path) => relative(right, path)).sort()
  if (JSON.stringify(leftRelative) !== JSON.stringify(rightRelative)) return false
  for (const path of leftRelative) if (!Buffer.from(await readFile(join(left, path))).equals(Buffer.from(await readFile(join(right, path))))) return false
  return true
}

if (args.has("--check")) {
  const temp = await mkdtemp(join(tmpdir(), "matt-sync-"))
  try {
    await generate(join(temp, "skills"), join(temp, "skill-manifest.json"))
    if (!(await equalTrees(join(temp, "skills"), output))) throw new Error("Adapted skills drift from vendored snapshot; run npm run sync:matt-skills")
    if (!Buffer.from(await readFile(join(temp, "skill-manifest.json"))).equals(Buffer.from(await readFile(manifestOutput)))) throw new Error("Skill manifest drift; run npm run sync:matt-skills")
  } finally { await rm(temp, { recursive: true, force: true }) }
  console.log("Matt skill synchronization is reproducible.")
} else {
  await generate(output, manifestOutput)
  console.log(`Generated adapted Matt skills (${createHash("sha256").update(await readFile(manifestOutput)).digest("hex").slice(0, 12)}).`)
}
