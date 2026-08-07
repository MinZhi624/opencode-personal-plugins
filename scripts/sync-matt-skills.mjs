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
const policy = JSON.parse(await readFile(join(plugin, "skill-policy.json"), "utf8"))
const provenance = JSON.parse(await readFile(join(plugin, "upstream-provenance.json"), "utf8"))
const args = new Set(process.argv.slice(2))

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
  const adapter = [
    "## OpenCode Adapter",
    "",
    "References such as `/tdd` name Workflow Skills. Agents load those methods through OpenCode's skill tool; slash commands are the user-facing entries. Use OpenCode's task tool for delegated agents.",
    "",
  ].join("\n")
  let result = body
  result = result.replaceAll("Agent tool", "OpenCode task tool")
  result = result.replaceAll("subagent_type=Explore", "subagent_type=surveyor")
  result = result.replaceAll("`general-purpose` subagent", "`inspector` subagent")
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
  const content = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${adapterBody(name, parsed.body)}`
  await writeFile(join(destinationDir, "SKILL.md"), content)
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
    const guardedBy = Object.entries(policy.guardedCommands).find(([, names]) => names.includes(name))?.[0] ?? null
    await copySkill(sourceDir, join(targetSkills, name), name, implicitInvocation)
    skills.push({ name, implicitInvocation, command: true, guardedBy })
  }
  const manifest = { upstream: { version: provenance.version, tag: provenance.tag, commit: provenance.commit }, skills, agentSkills: policy.agentSkills }
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
