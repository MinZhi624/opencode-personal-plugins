#!/usr/bin/env node
// 选择性安装主流程。install.sh / install.ps1 只做命令探测后转入本文件，
// 选择、环境检查、复制、npm ci、配置生成与写入决策全部在此共享实现。
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import readline from "node:readline/promises"
import { clearScreenDown, cursorTo, emitKeypressEvents, moveCursor } from "node:readline"
import { fileURLToPath } from "node:url"
import { GROUPS, GROUP_IDS, groupById, renderCli, renderMergeDoc, renderOpencode } from "./install-groups.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const CONFIG_HOME = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
const CONFIG_ROOT = join(CONFIG_HOME, "opencode")
const BUNDLE_DIR = join(CONFIG_ROOT, "opencode-zh-bundle")
const STATE_DIR = join(BUNDLE_DIR, "install-state")

class UserError extends Error {}
class UsageError extends UserError {}

function timestamp() {
  const pad = (n) => String(n).padStart(2, "0")
  const d = new Date()
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function usage() {
  console.log(`用法：bash install.sh [选项]（Windows：.\\install.ps1 [选项]）

  （无参数且在交互终端中运行）↑↓ 移动、空格勾选、Enter 确认、Esc 取消
  --all                安装全部组（跳过提问）
  --only <组,组>       只安装指定组
  --without <组,组>    安装除指定组外的全部组
  --replace-config     备份已有 opencode/cli 配置后写入本次生成模板
  --render <目录>      仅把按选择生成的配置模板导出到目录，不安装
  -h, --help           显示帮助

组件组：
${GROUPS.map((g) => `  ${g.id.padEnd(9)} ${g.title} — ${g.summary}`).join("\n")}

说明：组之间无依赖；依赖插件随组整体安装。已有配置默认保留，安装器只会打印需增删的条目。`)
}

function parseArgs(argv) {
  const opts = { only: null, without: null, all: false, replaceConfig: false, help: false, render: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const norm = arg.replace(/^--?/, "").toLowerCase()
    if (norm === "h" || norm === "help") opts.help = true
    else if (norm === "replace-config" || norm === "replaceconfig") opts.replaceConfig = true
    else if (norm === "all") opts.all = true
    else if (norm === "only" || norm === "without") {
      const value = argv[++i]
      if (!value) throw new UsageError(`参数 ${arg} 需要组列表，例如：${arg} workshop,sidebar`)
      const ids = value.split(/[,，\s]+/).filter(Boolean)
      for (const id of ids) if (!GROUP_IDS.includes(id)) throw new UsageError(`未知组件组：${id}（可选：${GROUP_IDS.join("、")}）`)
      opts[norm] = ids
    } else if (norm === "render") {
      opts.render = argv[++i]
      if (!opts.render) throw new UsageError("参数 --render 需要输出目录")
    } else {
      throw new UsageError(`未知参数：${arg}`)
    }
  }
  const picks = [opts.all, opts.only, opts.without].filter(Boolean).length
  if (picks > 1) throw new UsageError("--all、--only、--without 只能用一个。")
  return opts
}

function canonical(ids) {
  return GROUP_IDS.filter((id) => ids.includes(id))
}

async function pickGroupsByNumber(preselected) {
  const selected = new Set(preselected)
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (;;) {
      console.log("\n选择要安装的组件组（输入序号切换，回车确认，a=全选，n=全不选）：")
      GROUPS.forEach((g, i) => {
        console.log(`  ${selected.has(g.id) ? "[x]" : "[ ]"} ${i + 1}. ${g.id} — ${g.title}`)
        console.log(`        ${g.summary}`)
      })
      const answer = (await rl.question("> ")).trim().toLowerCase()
      if (answer === "") {
        if (!selected.size) {
          console.log("至少选择一组。")
          continue
        }
        break
      }
      if (answer === "a") {
        for (const g of GROUPS) selected.add(g.id)
        continue
      }
      if (answer === "n") {
        selected.clear()
        continue
      }
      let valid = true
      for (const token of answer.split(/[\s,，]+/).filter(Boolean)) {
        const index = Number(token)
        if (!Number.isInteger(index) || index < 1 || index > GROUPS.length) {
          valid = false
          break
        }
        const id = GROUPS[index - 1].id
        if (selected.has(id)) selected.delete(id)
        else selected.add(id)
      }
      if (!valid) console.log("输入无效，请输入组件组序号。")
    }
  } finally {
    rl.close()
  }
  return canonical([...selected])
}

async function pickGroupsByKeys(preselected) {
  const input = process.stdin
  const output = process.stdout
  const selected = new Set(preselected)
  const wasRaw = input.isRaw === true
  const wasPaused = input.isPaused()
  let index = 0
  let lines = 0

  // 每次从菜单顶行重绘；保留之前的终端输出，不清空整屏。
  function render() {
    cursorTo(output, 0)
    clearScreenDown(output)
    const frame = [
      "选择组件  ↑↓移动  空格勾选  Enter确认  Esc取消",
      "",
      ...GROUPS.map((group, i) =>
        `${i === index ? "❯" : " "} [${selected.has(group.id) ? "✓" : " "}] ${group.title}`,
      ),
      "",
      selected.size
        ? `已选择 ${selected.size} 组：${canonical([...selected]).join("、")}`
        : "至少选择一组，才能继续安装。",
    ]
    lines = frame.length
    output.write(`${frame.join("\n")}\n`)
    moveCursor(output, 0, -lines)
  }

  emitKeypressEvents(input)
  input.setRawMode(true)
  input.resume()
  try {
    render()
    const result = await new Promise((resolveSelection, rejectSelection) => {
      function onKeypress(_text, key) {
        if (!key) return
        if (key.name === "escape" || (key.ctrl && key.name === "c")) {
          input.off("keypress", onKeypress)
          rejectSelection(new UserError("已取消安装。"))
          return
        }
        if (key.name === "up") index = (index - 1 + GROUPS.length) % GROUPS.length
        else if (key.name === "down") index = (index + 1) % GROUPS.length
        else if (key.name === "space") {
          const id = GROUPS[index].id
          if (selected.has(id)) selected.delete(id)
          else selected.add(id)
        } else if (key.name === "return" || key.name === "enter") {
          if (selected.size) {
            input.off("keypress", onKeypress)
            resolveSelection(canonical([...selected]))
            return
          }
        } else return
        render()
      }
      input.on("keypress", onKeypress)
    })
    return result
  } finally {
    cursorTo(output, 0)
    clearScreenDown(output)
    input.setRawMode(wasRaw)
    if (wasPaused) input.pause()
  }
}

function pickGroups(preselected) {
  // dumb / 窄终端退回序号输入，不依赖 ANSI 光标控制。
  if (process.env.TERM === "dumb" || (process.stdout.columns || 0) < 60 || !process.stdin.setRawMode) {
    return pickGroupsByNumber(preselected)
  }
  return pickGroupsByKeys(preselected)
}

function checkNodeVersion() {
  const [major, minor] = process.versions.node.split(".").map(Number)
  if (major < 22 || (major === 22 && minor < 6)) {
    throw new UserError(`Node.js ${process.versions.node} 过旧；需要 22.6.0 或更高版本。`)
  }
}

function resolvePython() {
  const candidates = []
  if (process.env.OPENCODE_PYTHON) candidates.push({ cmd: process.env.OPENCODE_PYTHON, args: [] })
  else if (process.platform === "win32") candidates.push({ cmd: "py", args: ["-3"] }, { cmd: "python", args: [] })
  else candidates.push({ cmd: "python3", args: [] })

  for (const candidate of candidates) {
    const probe = spawnSync(candidate.cmd, [...candidate.args, "--version"], { encoding: "utf8" })
    if (probe.error && probe.error.code === "ENOENT") continue
    if (probe.error) continue
    return candidate
  }
  throw new UserError("找不到 Python。请安装 Python 3.10+，或把 OPENCODE_PYTHON 设为 Python 可执行文件路径。")
}

function checkPythonVersion(python) {
  const check = spawnSync(
    python.cmd,
    [...python.args, "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"],
    { encoding: "utf8" },
  )
  if (check.status === 1) throw new UserError("Python 版本过旧；gpt-reset-credits 需要 Python 3.10+。")
  if (check.status !== 0) throw new UserError(`Python 检查失败：${python.cmd}`)
}

function readState() {
  try {
    return JSON.parse(readFileSync(join(STATE_DIR, "selection.json"), "utf8"))
  } catch {
    return null
  }
}

function readPrevTemplate(name) {
  try {
    return readFileSync(join(STATE_DIR, `template-${name}`))
  } catch {
    return null
  }
}

function sameBytes(a, b) {
  return a !== null && b !== null && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0
}

function copyTree(from, to) {
  rmSync(to, { recursive: true, force: true })
  cpSync(from, to, { recursive: true, force: true })
}

function stageAndCopy(ids) {
  const stage = run(process.execPath, [join(ROOT, "scripts", "stage-runtime.mjs")], ROOT, false)
  if (stage !== 0) throw new UserError("运行时发行包构建失败。")

  const staged = join(ROOT, "runtime-stage")
  mkdirSync(BUNDLE_DIR, { recursive: true })
  for (const name of ["scripts", "config", "docs"]) copyTree(join(staged, name), join(BUNDLE_DIR, name))
  for (const name of ["package.json", "package-lock.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "install.sh", "install.ps1"]) {
    cpSync(join(staged, name), join(BUNDLE_DIR, name), { force: true })
  }
  // 并集保留：只覆盖本次选中组的插件目录，未选组的旧目录不动。
  for (const id of ids) {
    for (const plugin of groupById(id).plugins) copyTree(join(staged, "plugins", plugin), join(BUNDLE_DIR, "plugins", plugin))
  }
}

function run(cmd, args, cwd, shell = process.platform === "win32") {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", shell })
  return result.status ?? 1
}

function capture(cmd, args, shell = process.platform === "win32") {
  return (spawnSync(cmd, args, { encoding: "utf8", shell }).stdout || "").trim()
}

function installConfig({ label, template, preferred, candidates, prevTemplate, replaceConfig, stamp }) {
  const existing = candidates.filter((path) => existsSync(path))
  if (existing.length === 0) {
    writeFileSync(preferred, template)
    console.log(`已安装 ${label}：${preferred}`)
    return
  }
  if (existing.length === 1 && sameBytes(readFileSync(existing[0]), template)) {
    console.log(`${label} 已是本包模板：${existing[0]}`)
    return
  }
  if (existing.length === 1 && sameBytes(readFileSync(existing[0]), prevTemplate)) {
    for (const path of existing) {
      const backup = `${path}.bak.${stamp}`
      rmSync(backup, { force: true })
      renameSync(path, backup)
      console.log(`已备份：${backup}`)
    }
    writeFileSync(preferred, template)
    console.log(`已更新 ${label}（与上次安装模板一致）：${preferred}`)
    return
  }
  if (replaceConfig) {
    for (const path of existing) {
      const backup = `${path}.bak.${stamp}`
      rmSync(backup, { force: true })
      renameSync(path, backup)
      console.log(`已备份：${backup}`)
    }
    writeFileSync(preferred, template)
    console.log(`已替换 ${label}：${preferred}`)
    return
  }
  console.log(`保留已有 ${label}：${existing.join(", ")}`)
  return true
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    usage()
    return 0
  }

  const sourceFull = ROOT
  const bundleFull = resolve(BUNDLE_DIR)
  if (sourceFull !== bundleFull && sourceFull.startsWith(bundleFull + sep)) {
    throw new UserError(`不能从目标 bundle 的子目录运行安装器：${ROOT}`)
  }
  const updateMode = sourceFull === bundleFull

  if (opts.render) {
    const ids = opts.all ? GROUP_IDS : opts.only ? canonical(opts.only) : opts.without ? canonical(GROUP_IDS.filter((id) => !opts.without.includes(id))) : null
    if (!ids) throw new UserError("--render 需要搭配 --all / --only / --without。")
    if (!ids.length) throw new UserError("至少选择一组。")
    const out = resolve(opts.render)
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, "opencode.jsonc"), renderOpencode(ids))
    writeFileSync(join(out, "cli.json"), renderCli(ids))
    console.log(`已导出配置模板：${out}（${ids.join("、")}）`)
    return 0
  }

  let ids
  if (opts.all) ids = GROUP_IDS
  else if (opts.only) ids = canonical(opts.only)
  else if (opts.without) ids = canonical(GROUP_IDS.filter((id) => !opts.without.includes(id)))
  else if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new UserError("未指定选择且不在交互终端中。请使用 --all 或 --only / --without。")
  } else {
    const previous = readState()
    ids = await pickGroups(previous?.groups?.length ? canonical(previous.groups) : GROUP_IDS)
  }
  if (!ids.length) throw new UserError("至少选择一组。")

  const needsPython = ids.some((id) => groupById(id).requiresPython)
  checkNodeVersion()
  const python = needsPython ? resolvePython() : null
  if (python) checkPythonVersion(python)

  console.log(`OpenCode：${capture("opencode", ["--version"]) || "未知版本"}`)
  console.log(`Node.js：${process.version}`)
  if (python) console.log(`Python：${capture(python.cmd, [...python.args, "--version"], false) || "未知版本"}`)
  console.log(`本次安装组：${ids.join("、")}`)
  for (const id of ids) console.log(`  ${id}：${groupById(id).plugins.join("、")}`)

  const previous = readState()
  const removedIds = previous?.groups ? canonical(previous.groups).filter((id) => !ids.includes(id)) : []

  if (!updateMode) {
    console.log("构建并复制发行文件……")
    stageAndCopy(ids)
  }

  console.log("安装运行依赖（单一 node_modules）……")
  const npmStatus = run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], BUNDLE_DIR)
  if (npmStatus !== 0) throw new UserError("npm ci 失败。")

  const stamp = timestamp()
  const opencodeTemplate = renderOpencode(ids)
  const cliTemplate = renderCli(ids)
  mkdirSync(STATE_DIR, { recursive: true })
  mkdirSync(CONFIG_ROOT, { recursive: true })

  let needsMerge = installConfig({
    label: "OpenCode 配置",
    template: opencodeTemplate,
    preferred: join(CONFIG_ROOT, "opencode.jsonc"),
    candidates: [join(CONFIG_ROOT, "opencode.jsonc"), join(CONFIG_ROOT, "opencode.json")],
    prevTemplate: readPrevTemplate("opencode.jsonc"),
    replaceConfig: opts.replaceConfig,
    stamp,
  })
  needsMerge = installConfig({
    label: "CLI 配置",
    template: cliTemplate,
    preferred: join(CONFIG_ROOT, "cli.json"),
    candidates: [join(CONFIG_ROOT, "cli.json")],
    prevTemplate: readPrevTemplate("cli.json"),
    replaceConfig: opts.replaceConfig,
    stamp,
  }) || needsMerge

  writeFileSync(join(STATE_DIR, "template-opencode.jsonc"), opencodeTemplate)
  writeFileSync(join(STATE_DIR, "template-cli.json"), cliTemplate)
  writeFileSync(
    join(STATE_DIR, "selection.json"),
    `${JSON.stringify({ format: 1, groups: ids, installedAt: new Date().toISOString() }, null, 2)}\n`,
  )
  writeFileSync(
    join(BUNDLE_DIR, "docs", "MERGE-SELECTED.md"),
    renderMergeDoc({ ids, removedIds, timestamp: stamp }),
  )

  console.log("")
  console.log(`Bundle 已安装到：${BUNDLE_DIR}`)
  if (removedIds.length) {
    console.log(`本次减少了组：${removedIds.join("、")}。bundle 保留其插件文件，配置条目删除后才真正停用；`)
    console.log(`需删除的条目清单见：${join(BUNDLE_DIR, "docs", "MERGE-SELECTED.md")}`)
  }
  if (needsMerge) {
    console.log("检测到已有配置，尚未自动修改。请按以下文档合并插件条目：")
    console.log(`  ${join(BUNDLE_DIR, "docs", "MERGE-SELECTED.md")}`)
    console.log(`  ${join(BUNDLE_DIR, "docs", "MERGE_EXISTING_CONFIG.md")}`)
  } else {
    console.log("配置已就绪。")
  }
  console.log(needsMerge ? "插件文件安装完成；配置尚需手工合并。" : "安装完成！")
  console.log("配置就绪后请启动 OpenCode 进行人工验收；受监视的插件和配置支持 v2 重载。")
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    try {
      await rl.question("按 Enter 退出安装器……")
    } finally {
      rl.close()
    }
  }
  return 0
}

main().then(
  (code) => process.exit(code),
  (error) => {
    if (error instanceof UserError) console.error(error.message)
    else console.error(error)
    process.exit(error instanceof UsageError ? 2 : error instanceof UserError ? 1 : 2)
  },
)
