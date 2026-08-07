import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const destination = process.argv.includes("--check") ? await mkdtemp(join(tmpdir(), "opencode-runtime-")) : join(root, "runtime-stage")
const copy = async (from, to = from, options = {}) => {
  const target = join(destination, to)
  await mkdir(dirname(target), { recursive: true })
  return cp(join(root, from), target, { recursive: true, force: true, ...options })
}

await rm(destination, { recursive: true, force: true })
await mkdir(destination, { recursive: true })
await Promise.all([
  copy("config"),
  copy("plugins/opencode-quota-zh"),
  copy("plugins/opencode-enhanced-sidebar-zh"),
  copy("plugins/gpt-reset-credits"),
  copy("package.json"), copy("package-lock.json"), copy("README.md"), copy("LICENSE"), copy("THIRD_PARTY_NOTICES.md"), copy("install.sh"), copy("install.ps1"), copy("scripts/verify.mjs", "scripts/verify.mjs"),
  copy("docs/MERGE_EXISTING_CONFIG.md", "docs/MERGE_EXISTING_CONFIG.md"), copy("docs/TROUBLESHOOTING.md", "docs/TROUBLESHOOTING.md"),
])
await copy("plugins/opencode-matt-workshop/dist", "plugins/opencode-matt-workshop/dist")
await copy("plugins/opencode-matt-workshop/skills", "plugins/opencode-matt-workshop/skills")
await copy("plugins/opencode-matt-workshop/licenses", "plugins/opencode-matt-workshop/licenses")
await copy("plugins/opencode-matt-workshop/package.json", "plugins/opencode-matt-workshop/package.json")
await copy("plugins/opencode-matt-workshop/README.md", "plugins/opencode-matt-workshop/README.md")
await copy("plugins/opencode-matt-workshop/skill-manifest.json", "plugins/opencode-matt-workshop/skill-manifest.json")

async function list(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map(async (entry) => entry.isDirectory() ? list(join(directory, entry.name)) : [join(directory, entry.name)]))).flat()
}
const staged = (await list(destination)).map((path) => relative(destination, path).replaceAll("\\", "/"))
const forbidden = staged.filter((path) => /plugins\/opencode-matt-workshop\/(vendor|src|docs\/adr|docs\/implementation)(\/|$)|(^|\/)\.agents(\/|$)|(^|\/)CONTEXT\.md$|sync-matt-skills|verify-matt-workshop|skill-policy|upstream-provenance/.test(path))
const required = ["plugins/opencode-matt-workshop/dist/src/index.js", "plugins/opencode-matt-workshop/skill-manifest.json", "plugins/opencode-matt-workshop/skills/ask-matt/SKILL.md", "plugins/opencode-matt-workshop/skills/wizard/template.sh", "plugins/opencode-matt-workshop/licenses/MATT-POCOCK-SKILLS-LICENSE"]
for (const path of required) if (!staged.includes(path)) forbidden.push(`missing required runtime file: ${path}`)
if (forbidden.length) throw new Error(`Runtime distribution isolation failed:\n${forbidden.join("\n")}`)
console.log(`Runtime staging passed (${staged.length} files): ${destination}`)
if (process.argv.includes("--check")) await rm(destination, { recursive: true, force: true })
