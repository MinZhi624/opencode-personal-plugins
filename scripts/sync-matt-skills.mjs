import { cp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const plugin = join(root, "plugins/opencode-matt-workshop")
const vendor = join(plugin, "vendor/mattpocock-skills")
const output = join(plugin, "skills")
const manifestOutput = join(plugin, "skill-manifest.json")
const localSkills = join(plugin, "local-skills")
const provenancePath = join(plugin, "upstream-provenance.json")
const provenance = JSON.parse(await readFile(provenancePath, "utf8"))
const args = process.argv.slice(2)

// 上游仓库里的会话操作命令，在 OpenCode 中不是技能，改成自然语言说明。
// gerund 形式单独给出：`/clear`ing 只替换动词本身，宾语留给原句。
const harnessCommands = {
  clear: { base: "clearing the context window", gerund: "clearing" },
  compact: { base: "compacting the context window", gerund: "compacting" },
}

const explicitIntentPrefix =
  "Use ONLY when the user explicitly requests this workflow in natural language or by name; a suggestion from another skill does not count. "

// 重流程门槛：即使上游允许隐式调用，也必须由用户显式意图触发。
// codebase-design 只是普通 reference，不在此列。
const heavyFlows = new Set(["tdd", "code-review", "improve-codebase-architecture", "to-spec", "to-tickets"])

function usage() {
  return [
    "Usage:",
    "  node scripts/sync-matt-skills.mjs                     从 vendor 快照生成 skills/ 与 skill-manifest.json（日常同步）",
    "  node scripts/sync-matt-skills.mjs --vendor            导入快照的别名；必须配 --source <dir>",
    "  node scripts/sync-matt-skills.mjs --source <dir>      先导入 <dir> 为 vendor 快照，再生成（升级用）",
    "  node scripts/sync-matt-skills.mjs --source <dir> --import-only   只导入 vendor 快照，不生成 skills/",
    "",
    "必须显式给出 --source 才会改动 vendor/；日常同步只读取 vendor/，不读任何外部快照目录。",
  ].join("\n")
}

function parseOptions(argv) {
  const options = { source: null, importOnly: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--source" || argument === "--vendor") {
      const next = argv[index + 1]
      if (argument === "--vendor" && next && !next.startsWith("--")) {
        // --vendor <dir> 兼容旧用法：视作 --source <dir>。
        options.source = next
        index += 1
        continue
      }
      if (argument === "--source") {
        if (!next || next.startsWith("--")) throw new Error("--source requires a directory path")
        options.source = next
        index += 1
        continue
      }
      throw new Error("--vendor is an import alias and requires --source <dir>")
    }
    if (argument === "--import-only") {
      options.importOnly = true
      continue
    }
    if (argument === "--help" || argument === "-h") {
      console.log(usage())
      process.exit(0)
    }
    throw new Error(`Unknown argument: ${argument}\n\n${usage()}`)
  }
  if (options.importOnly && !options.source) throw new Error("--import-only requires --source <dir>")
  return options
}

const options = parseOptions(args)

function parseFrontmatter(content, sourcePath) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  if (!match) throw new Error(`Missing frontmatter: ${sourcePath}`)
  const values = Object.fromEntries(
    match[1]
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf(":")
        return [line.slice(0, separator), line.slice(separator + 1).trim().replace(/^"|"$/g, "")]
      }),
  )
  return { values, body: content.slice(match[0].length) }
}

// 只改写"独立成词"的技能/命令引用：前必须紧跟空白/开括号/反引号等边界，后不能紧跟
// 词字符、-、_ 或 /。这样路径（/research/path）、URL（https://a/research）、
// 后缀（/tdd123）都原样保留；反引号包裹的完整 token 与裸 token 都是合法目标。
function rewriteReferences(content, knownSkills) {
  return content.replace(
    /(?<=^|[\s([{"'`>|*])(`?)\/(?!\/)([a-z][a-z-]*)\1(ing)?(?![a-z0-9_\-/])/g,
    (match, quote, name, gerund) => {
      const command = harnessCommands[name]
      if (command) return gerund ? command.gerund : command.base
      // 动名词形式只对会话命令保留（`/clear`ing），技能名不构成动名词。
      if (gerund || !knownSkills.has(name)) return match
      return quote ? `\`${name}\` skill` : `${name} skill`
    },
  )
}

// 锚点必须命中上游原文，缺失即抛错——静默失配会让补丁悄悄消失（本仓库既有约定）。
function replaceAnchor(content, anchor, replacement) {
  if (!content.includes(anchor)) throw new Error(`OpenCode overlay anchor changed in ${provenance.tag}: ${anchor}`)
  return content.replace(anchor, replacement)
}

const upstreamAnchors = {
  research: (body) =>
    replaceAnchor(
      body,
      "Spin up a **background agent** to do the research, so you keep working while it reads.",
      "Start one Archivist Worker Run with the full research brief and the target Markdown report path, and keep working while it reads.",
    ),
  wayfinder: (body) =>
    replaceAnchor(
      replaceAnchor(
        body,
        "capturing its findings on a throwaway `research/<name>` branch with a context pointer from the ticket.",
        "writing its findings to a unique Markdown path in the current worktree with a context pointer from the ticket. Do not create a branch.",
      ),
      "spin up a `/research` subagent",
      "start an Archivist Worker Run",
    ),
  "setup-matt-pocock-skills": (body) =>
    replaceAnchor(
      replaceAnchor(
        body,
        "- If `CLAUDE.md` exists, edit it.\n- Else if `AGENTS.md` exists, edit it.",
        "- If `AGENTS.md` exists, edit it.\n- Else if `CLAUDE.md` exists, edit it.",
      ),
      "Never create `AGENTS.md` when `CLAUDE.md` already exists (or vice versa) — always edit the one that's already there.",
      "Never create a second instruction file when one already exists — OpenCode reads `AGENTS.md` before falling back to `CLAUDE.md`.",
    ),
  wizard: (body) =>
    `Before creating or validating a wizard, verify that Bash is available. On Windows, require WSL or Git Bash; do not attempt a PowerShell rewrite.\n\n${body}`,
}

const adapterPreamble = [
  "## OpenCode Adapter",
  "",
  "Workflow references in this text name Workshop Workflow Skills by their exact ID. Describe what you need in natural language; the skill descriptions decide when a skill fires, and an exact ID is never required to start a flow. Load a skill with the native skill tool by ID — no Workshop slash commands are registered. Use only the current Workshop Primary Agent's native OpenCode capabilities and role boundaries. Never switch Primary Agents automatically.",
  "",
].join("\n")

function adaptUpstreamBody(name, body, knownSkills) {
  let result = body.replaceAll("Agent tool", "OpenCode task tool")
  // 锚点先跑：它们匹配的是上游原文；引用改写会把 `/research` 变成 `research` skill，
  // 之后再跑锚点就会静默失配。
  const anchor = upstreamAnchors[name]
  if (anchor) result = anchor(result)
  return rewriteReferences(result, knownSkills)
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await listFiles(path)))
    else files.push(path)
  }
  return files.sort()
}

async function isInside(child, ancestor) {
  const [realChild, realAncestor] = await Promise.all([realpath(child), realpath(ancestor)])
  const prefix = realAncestor.endsWith(sep) ? realAncestor : realAncestor + sep
  return realChild === realAncestor || realChild.startsWith(prefix)
}

// 确定性内容摘要：按相对 POSIX 路径排序。符号链接只记录目标字符串，绝不 readFile
// 穿透它，避免把快照外部文件的内容混进摘要。
async function snapshotDigest(directory) {
  const hash = createHash("sha256")
  const base = `${directory}/`
  for (const path of await listFiles(directory)) {
    const key = path.startsWith(base) ? path.slice(base.length) : relative(directory, path)
    const link = await readlink(path).catch(() => null)
    hash.update(`${key}\0`)
    hash.update(link === null ? createHash("sha256").update(await readFile(path)).digest("hex") : `link:${link}`)
    hash.update("\0")
  }
  return hash.digest("hex")
}

async function readLocalSkill(name) {
  const path = join(localSkills, name, "SKILL.md")
  const content = await readFile(path, "utf8").catch(() => null)
  if (content === null) return null
  const parsed = parseFrontmatter(content, path)
  if (parsed.values.name !== name) throw new Error(`Local skill name mismatch for ${name}: ${parsed.values.name}`)
  if (!parsed.values.description) throw new Error(`Local skill missing description: ${name}`)
  return parsed
}

async function copySkill(sourceDir, destinationDir, name, knownSkills, { description, explicitIntent }) {
  await rm(destinationDir, { recursive: true, force: true })
  // agents/ 是上游 harness 的界面元数据，不进入运行时。
  await cp(sourceDir, destinationDir, {
    recursive: true,
    filter: (path) => !path.includes(`${join(sourceDir, "agents")}`),
  })

  const upstream = parseFrontmatter(await readFile(join(sourceDir, "SKILL.md"), "utf8"), join(sourceDir, "SKILL.md"))
  if (upstream.values.name !== name) throw new Error(`Manifest name mismatch for ${name}: ${upstream.values.name}`)

  // local-skills/<name>/SKILL.md 是手写正文的唯一来源：整段原样采用（只套共享适配层），
  // 不套上游锚点补丁（那是为上游文本准备的）。
  const local = await readLocalSkill(name)
  const body = local ? local.body : upstream.body
  const adapted = local ? rewriteReferences(body, knownSkills) : adaptUpstreamBody(name, body, knownSkills)
  const finalDescription = explicitIntent ? `${explicitIntentPrefix}${description}` : description

  const runtimeName = name === "handoff" ? "matt-handoff" : name
  const content = `---\nname: ${runtimeName}\ndescription: ${JSON.stringify(finalDescription)}\nslash: false\n---\n\n${adapterPreamble}${adapted}`
  await writeFile(join(destinationDir, "SKILL.md"), content)

  // 附属资源与 SKILL.md 走同一套引用改写，避免残留已废弃的斜杠命令写法。
  for (const file of await listFiles(destinationDir)) {
    if (basename(file) === "SKILL.md" || !file.endsWith(".md")) continue
    await writeFile(file, rewriteReferences(await readFile(file, "utf8"), knownSkills))
  }
  return local ? "local" : "upstream"
}

// cp 用 verbatimSymlinks 原样保留链接目标；这里只做校验：任何解析后逃逸快照的链接
// （相对 .. 跳出、跨盘绝对路径）一律拒绝，而不是靠字符串前缀猜。
async function assertSelfContainedSnapshot(directory) {
  for (const path of await listFiles(directory)) {
    const target = await readlink(path).catch(() => null)
    if (target === null) continue
    if (!(await isInside(path, directory))) {
      throw new Error(`Vendor snapshot contains a link escaping the snapshot: ${relative(root, path)} -> ${target}`)
    }
  }
}

async function generate() {
  const pluginManifest = JSON.parse(await readFile(join(vendor, ".claude-plugin/plugin.json"), "utf8"))
  const upstreamPackage = JSON.parse(await readFile(join(vendor, "package.json"), "utf8"))
  for (const [label, version] of [
    ["package.json", upstreamPackage.version],
    [".claude-plugin/plugin.json", pluginManifest.version],
  ]) {
    if (version !== provenance.version) throw new Error(`Vendored ${label} must be ${provenance.version}, found ${version}`)
  }

  const digest = await snapshotDigest(vendor)
  if (provenance.snapshotDigest && provenance.snapshotDigest !== digest) {
    throw new Error(
      `Vendor snapshot digest drifted from upstream-provenance.json (expected ${provenance.snapshotDigest.slice(0, 16)}…, found ${digest.slice(0, 16)}…). ` +
        `Re-import the intended snapshot with --source <dir> instead of editing vendor/ by hand.`,
    )
  }

  const entries = pluginManifest.skills
  if (!Array.isArray(entries) || entries.length !== 25) throw new Error(`Expected 25 promoted skills, found ${entries?.length ?? "none"}`)
  const knownSkills = new Set(entries.map((entry) => basename(entry)))

  await rm(output, { recursive: true, force: true })
  const skills = []
  const localSources = []
  for (const entry of entries) {
    const sourceDir = join(vendor, entry)
    const name = basename(entry)
    const upstream = parseFrontmatter(await readFile(join(sourceDir, "SKILL.md"), "utf8"), entry)
    if (upstream.values.name !== name) throw new Error(`Manifest name mismatch for ${name}: ${upstream.values.name}`)
    // 本地正文优先：描述与显式意图门槛都取 local frontmatter。
    const local = await readLocalSkill(name)
    const upstreamExplicit = upstream.values["disable-model-invocation"] === "true"
    const localExplicit = local ? local.values["disable-model-invocation"] === "true" : false
    // autoinvoke=false 会把技能从模型可见列表里藏掉，自然语言请求就再也发现不了它。
    // 所有技能都保持可见，门槛由描述的显式意图前缀承担。
    const explicitIntent = heavyFlows.has(name) || upstreamExplicit || localExplicit
    const description = local?.values.description ?? upstream.values.description
    if (!description) throw new Error(`Missing skill description: ${name}`)
    const origin = await copySkill(sourceDir, join(output, name), name, knownSkills, { description, explicitIntent })
    if (origin === "local") localSources.push(name)
    skills.push({ name, implicitInvocation: true })
  }

  const manifest = { upstream: { version: provenance.version, tag: provenance.tag, commit: provenance.commit }, skills }
  await writeFile(manifestOutput, `${JSON.stringify(manifest, null, 2)}\n`)
  return { localSources }
}

async function importSnapshot(source) {
  // resolve 而非 join：允许仓库外的绝对路径（本地快照通常在仓库外）。
  const resolved = resolve(root, source)
  const sourcePackage = JSON.parse(await readFile(join(resolved, "package.json"), "utf8"))
  const sourceManifest = JSON.parse(await readFile(join(resolved, ".claude-plugin/plugin.json"), "utf8"))
  if (sourcePackage.version !== provenance.version || sourceManifest.version !== provenance.version) {
    throw new Error(
      `Source snapshot is ${sourcePackage.version}/${sourceManifest.version} but upstream-provenance.json records ${provenance.version}. ` +
        `Update upstream-provenance.json to the version you intend to import, then re-run with --source <dir>.`,
    )
  }

  // 拒绝会把源一起删掉的路径关系：相同、互为祖先/后代。
  for (const [label, other] of [
    ["the vendor directory", vendor],
    ["the plugin directory", plugin],
    ["the repository root", root],
  ]) {
    if ((await isInside(resolved, other)) || (await isInside(other, resolved))) {
      throw new Error(`Refusing to import: --source ${resolved} overlaps ${label} (${other}). Import would delete the source.`)
    }
  }

  const digest = await snapshotDigest(resolved)
  if (provenance.snapshotDigest && provenance.snapshotDigest !== digest) {
    throw new Error(
      `Source digest ${digest.slice(0, 16)}… does not match the recorded snapshotDigest ${provenance.snapshotDigest.slice(0, 16)}…. ` +
        `The existing provenance record is verified evidence for ${provenance.tag}; update upstream-provenance.json's source record ` +
        `deliberately before importing a different snapshot, or re-vendor the recorded snapshot.`,
    )
  }

  await rm(vendor, { recursive: true, force: true })
  // verbatimSymlinks：原样保留符号链接目标，避免 Node 把相对链接解析成绝对路径。
  await cp(resolved, vendor, { recursive: true, verbatimSymlinks: true, force: true })
  await assertSelfContainedSnapshot(vendor)
  // 只更新摘要；verified / tag / commit 等来源证据由人工维护，脚本不重新盖章。
  await writeFile(provenancePath, `${JSON.stringify({ ...provenance, snapshotDigest: digest }, null, 2)}\n`)
  console.log(`Vendored ${provenance.tag} at ${relative(root, vendor)} (digest ${digest.slice(0, 12)})`)
}

if (options.source) {
  await importSnapshot(options.source)
  if (options.importOnly) process.exit(0)
}

const { localSources } = await generate()
const manifestDigest = createHash("sha256").update(await readFile(manifestOutput)).digest("hex").slice(0, 12)
console.log(`Generated adapted Matt skills (${manifestDigest}); local bodies: ${localSources.join(", ") || "none"}.`)
