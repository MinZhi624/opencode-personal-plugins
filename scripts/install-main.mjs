#!/usr/bin/env node
// 选择性安装主流程。install.sh / install.ps1 只做命令探测后转入本文件，
// 选择、版本提示、复制、npm ci、配置合并与写入决策全部在此共享实现。
import { spawn, spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { createRequire } from "node:module"
import readline from "node:readline/promises"
import { clearScreenDown, cursorTo, emitKeypressEvents, moveCursor } from "node:readline"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  GROUPS,
  GROUP_IDS,
  SIDEBAR_CARDS,
  SIDEBAR_CARD_IDS,
  groupById,
  renderCli,
  renderOpencode,
  resolveSelection,
  validateGroupDependencies,
} from "./install-groups.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const CONFIG_HOME = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
const CONFIG_ROOT = join(CONFIG_HOME, "opencode")
const BUNDLE_DIR = join(CONFIG_ROOT, "opencode-zh-bundle")
const STATE_DIR = join(BUNDLE_DIR, "install-state")
// jsonc-parser 与 @clack/prompts 都动态加载：
// 从没有 node_modules 的 bundle 目录首次运行时，安装器不能在模块加载期失败。
let jsonc = null
let clack = null

class UserError extends Error {}
class UsageError extends UserError {}

function ensureGroupDependencies(ids) {
  try {
    return validateGroupDependencies(ids)
  } catch (error) {
    throw new UserError(error instanceof Error ? error.message : String(error))
  }
}

function timestamp() {
  const pad = (n) => String(n).padStart(2, "0")
  const d = new Date()
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function usage() {
  console.log(`用法：bash install.sh [选项]（Windows：.\\install.ps1 [选项]）

  （无参数且在交互终端中运行）↑↓ 移动、空格勾选、Enter 确认、Esc/Ctrl+C 取消
  --all                安装全部组与全部侧栏卡片（跳过提问）
  --only <组,组>       只安装指定组
  --without <组,组>    安装除指定组外的全部组
  --cards <卡,卡>      指定侧栏卡片（会自动选中 sidebar）；默认全部，none 表示只装宿主
  --replace-config     备份已有 opencode/cli 配置后写入本次生成模板
  --render <目录>      仅把按选择生成的配置模板导出到目录，不安装
  -h, --help           显示帮助

组件组：
${GROUPS.map((g) => `  ${g.id.padEnd(9)} ${g.title} — ${g.summary}`).join("\n")}

侧栏卡片（选择 sidebar 组时）：
${SIDEBAR_CARDS.map((card) => `  ${card.id.padEnd(15)} ${card.title}`).join("\n")}

说明：除 ssh 依赖 workshop 外，其余组可任意组合；选中 sidebar 后宿主、额度后台
与共享会话统计一并安装，勾选上下文／子代理再自动补隐藏共享库。普通组件版本检查
只提示；SSH 组严格要求 OpenCode 2.0.31+。已有配置会自动合并：只补充缺失的插件
条目与键，保留你已有的设置和注释；写前备份为 .bak.<时间戳>。减少卡片或组时不会
自动删除已有配置条目。`)
}

function parseArgs(argv) {
  const opts = { only: null, without: null, cards: null, all: false, replaceConfig: false, help: false, render: null }
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
    } else if (norm === "cards" || norm === "card") {
      const value = argv[++i]
      if (!value) throw new UsageError(`参数 ${arg} 需要卡片列表，例如：${arg} timeline,skill；只装宿主用 ${arg} none`)
      const ids = value.split(/[,，\s]+/).filter(Boolean)
      if (ids.length === 1 && (ids[0].toLowerCase() === "none" || ids[0] === "无")) {
        opts.cards = []
      } else {
        for (const id of ids) {
          if (!SIDEBAR_CARD_IDS.includes(id)) throw new UsageError(`未知侧栏卡片：${id}（可选：${SIDEBAR_CARD_IDS.join("、")}）`)
        }
        opts.cards = ids
      }
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

function canonicalCards(ids) {
  return SIDEBAR_CARD_IDS.filter((id) => ids.includes(id))
}

async function loadClack() {
  try {
    clack = await import("@clack/prompts")
    return clack
  } catch {
    // 首次从没有 node_modules 的发行目录运行时，先补装一次交互依赖；
    // 失败则退回内置选择器，安装流程本身不受影响。
    console.log("准备安装界面依赖……")
    run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], ROOT)
    try {
      clack = await import("@clack/prompts")
    } catch {
      clack = null
    }
  }
  return clack
}

function info(message) {
  if (clack) clack.log.info(message)
  else console.log(message)
}

function warn(message) {
  if (clack) clack.log.warn(message)
  else console.warn(message)
}

const paint = (code, text) => (process.env.NO_COLOR ? text : `\x1b[${code}m${text}\x1b[0m`)
const palette = {
  cyan: "38;5;51",
  green: "38;5;114",
  gray: "38;5;245",
  white: "97",
  boldCyan: "1;38;5;51",
  boldMagenta: "1;38;5;213",
  boldYellow: "1;38;5;221",
}

// 仿 ACE27 的启动图：高亮白色 3D 块字 + 灰色阴影 + 旁边的小猫。
const WORDMARK_WIDE = [
  "███╗   ███╗██╗███╗   ██╗███████╗██╗  ██╗██╗ ██████╗ ██████╗ ██╗  ██╗",
  "████╗ ████║██║████╗  ██║╚══███╔╝██║  ██║██║██╔════╝ ╚════██╗██║  ██║",
  "██╔████╔██║██║██╔██╗ ██║  ███╔╝ ███████║██║███████╗  █████╔╝███████║",
  "██║╚██╔╝██║██║██║╚██╗██║ ███╔╝  ██╔══██║██║██╔═══██╗██╔═══╝ ╚════██║",
  "██║ ╚═╝ ██║██║██║ ╚████║███████╗██║  ██║██║╚██████╔╝███████╗     ██║",
  "╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝╚═╝ ╚═════╝ ╚══════╝     ╚═╝",
]
const WORDMARK_COMPACT = [
  "█   █ █       █████ █     █  ████ █████ █   █",
  "██ ██ █ ████      █ █     █ █         █ █   █",
  "█ █ █ █ █   █    █  ████  █ ████  █████ █████",
  "█   █ █ █   █   █   █   █ █ █   █ █         █",
  "█   █ █ █   █ █████ █   █ █  ███  █████     █",
]
const CAT_WIDE = ["｡     /\\_/\\", "( \\___( o.o )~", "/_/\\_)_/\\_)"]
const CAT_COMPACT = [" /\\_/\\", "( o.o )", " > ^ <"]
const SHADOW = /[╗╔╝╚║═]/g

function styleWordmark(line) {
  return line.replace(/█/g, paint(palette.white, "█")).replace(SHADOW, (ch) => paint(palette.gray, ch))
}

function printBanner(framed) {
  const bar = framed ? `${paint(palette.gray, "│")}  ` : "  "
  console.log(framed ? `${paint(palette.gray, "┌")}  ${paint(palette.boldCyan, "Min_Zhi整合包")}` : paint(palette.boldCyan, "✦ Min_Zhi整合包 ✦"))
  if (framed) console.log(paint(palette.gray, "│"))
  const columns = process.stdout.columns || 80
  const wide = 3 + 68 + 4 + 14 <= columns
  const art = wide ? WORDMARK_WIDE : WORDMARK_COMPACT
  const cat = wide ? CAT_WIDE : CAT_COMPACT
  const width = Math.max(...art.map((line) => line.length))
  art.forEach((line, i) => {
    const catLine = i < cat.length ? paint(palette.white, cat[i]) : ""
    console.log(`${bar}${styleWordmark(line.padEnd(width + 4))}${catLine}`)
  })
  console.log(framed ? paint(palette.gray, "│") : "")
}

function createSelection(preselected) {
  const state = { groups: new Set(preselected.groups), cards: new Set(preselected.cards) }
  if (state.cards.size) state.groups.add("sidebar")
  return state
}

function selectedIds(state) {
  return [
    ...GROUP_IDS.filter((id) => state.groups.has(id)),
    ...SIDEBAR_CARD_IDS.filter((id) => state.cards.has(id)),
  ]
}

// 选中卡片时展示基础依赖：额度后台、共享会话统计、宿主与隐藏共享库。
function dependencyLine(state) {
  if (!state.cards.size) return ""
  const selection = resolveSelection({ groups: ["sidebar"], cards: [...state.cards] })
  const cardPlugins = new Set(SIDEBAR_CARDS.map((card) => card.plugin))
  const dependencies = selection.plugins.filter((plugin) => !cardPlugins.has(plugin))
  return dependencies.length ? `自动包含依赖：${dependencies.join("、")}` : ""
}

const GROUP_LOOK = {
  workshop: { icon: "✦", label: "工作流", note: "Matt Workshop", color: "boldCyan" },
  sidebar: { icon: "▤", label: "侧栏", note: "含宿主依赖", color: "boldMagenta" },
  alone: { icon: "◇", label: "独立", note: "gpt-reset-credits", color: "boldYellow" },
  ssh: { icon: "⌁", label: "SSH", note: "依赖工作流", color: "boldCyan" },
}

function buildRows() {
  const rows = []
  for (const group of GROUPS) {
    const look = GROUP_LOOK[group.id]
    rows.push({
      id: group.id,
      kind: "group",
      depth: 0,
      label: look.label,
      icon: look.icon,
      note: look.note,
      color: look.color,
      title: group.title,
    })
    if (group.id === "sidebar") {
      SIDEBAR_CARDS.forEach((card, i) => {
        rows.push({
          id: card.id,
          kind: "card",
          depth: 1,
          title: card.title,
          lastInGroup: i === SIDEBAR_CARDS.length - 1,
        })
      })
    }
  }
  return rows
}

function rowText(row) {
  if (row.kind === "group") return `${row.icon} ${row.label}${row.note ? `（${row.note}）` : ""}`
  return row.title
}

function isRowSelected(state, row) {
  return row.kind === "card" ? state.cards.has(row.id) : state.groups.has(row.id)
}

function toggleRow(state, row) {
  if (row.kind === "card") {
    if (state.cards.has(row.id)) state.cards.delete(row.id)
    else {
      state.cards.add(row.id)
      state.groups.add("sidebar")
    }
    return
  }
  if (row.id !== "sidebar") {
    if (state.groups.has(row.id)) state.groups.delete(row.id)
    else state.groups.add(row.id)
    return
  }
  if (state.groups.has("sidebar")) {
    state.groups.delete("sidebar")
    state.cards.clear()
  } else {
    state.groups.add("sidebar")
  }
}

function selectionResult(state) {
  const cards = canonicalCards([...state.cards])
  const groups = canonical([...state.groups, ...(cards.length ? ["sidebar"] : [])])
  return { groups, cards }
}

async function pickSelectionByNumber(preselected) {
  const state = createSelection(preselected)
  const rows = buildRows()
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (;;) {
      console.log("\n选择要安装的组件（输入序号切换，回车确认，a=全选，n=全不选）：")
      rows.forEach((row, i) => {
        const indent = "  ".repeat(row.depth)
        console.log(`${indent}  ${isRowSelected(state, row) ? "[x]" : "[ ]"} ${i + 1}. ${rowText(row)}`)
      })
      const deps = dependencyLine(state)
      if (deps) console.log(deps)
      console.log(`已选择 ${selectedIds(state).length} 项`)
      const answer = (await rl.question("> ")).trim().toLowerCase()
      if (answer === "") {
        if (!state.groups.size) {
          console.log("至少选择一组。")
          continue
        }
        break
      }
      if (answer === "a") {
        for (const id of GROUP_IDS) state.groups.add(id)
        for (const id of SIDEBAR_CARD_IDS) state.cards.add(id)
        continue
      }
      if (answer === "n") {
        state.groups.clear()
        state.cards.clear()
        continue
      }
      let valid = true
      for (const token of answer.split(/[\s,，]+/).filter(Boolean)) {
        const index = Number(token)
        if (!Number.isInteger(index) || index < 1 || index > rows.length) {
          valid = false
          break
        }
        toggleRow(state, rows[index - 1])
      }
      if (!valid) console.log("输入无效，请输入序号。")
    }
  } finally {
    rl.close()
  }
  return selectionResult(state)
}

async function pickSelectionByKeys(preselected) {
  const input = process.stdin
  const output = process.stdout
  const state = createSelection(preselected)
  const wasRaw = input.isRaw === true
  const wasPaused = input.isPaused()
  const rows = buildRows()
  let index = 0
  let lines = 0
  const guide = paint(palette.gray, "│")

  function groupLabel(row) {
    const text = `${row.icon} ${row.label}`
    const label = isRowSelected(state, row) ? paint(palette[row.color], text) : paint(palette.gray, text)
    const note = row.note ? paint(palette.gray, `（${row.note}）`) : ""
    return `${label}${note}`
  }

  // 每次从菜单顶行重绘；保留之前的终端输出，不清空整屏。
  function render() {
    cursorTo(output, 0)
    clearScreenDown(output)
    const frame = [
      `${paint(palette.boldCyan, "◆  选择组件")}${paint(palette.gray, "（空格勾选 / Enter 确认）")}`,
      guide,
    ]
    rows.forEach((row, i) => {
      const active = i === index
      const selected = isRowSelected(state, row)
      const check = selected ? paint(palette.green, "✓") : paint(palette.gray, "·")
      if (row.kind === "group") {
        const cursor = active ? paint(palette.cyan, "❯") : " "
        frame.push(`${guide}  ${cursor} ${check} ${groupLabel(row)}`)
        if (row.id !== "sidebar") frame.push(guide)
        return
      }
      const cursor = active ? paint(palette.cyan, "❯") : paint(palette.gray, row.lastInGroup ? "└" : "├")
      const text = selected ? row.title : paint(palette.gray, row.title)
      frame.push(`${guide}    ${cursor} ${check} ${text}`)
      if (row.lastInGroup) frame.push(guide)
    })
    frame.push(`${guide}  ${paint(palette.gray, "↑↓ 移动 · 空格 勾选 · Enter 确认 · Esc 取消")}`)
    const ids = selectedIds(state)
    frame.push(`${guide}  ${paint(palette.gray, ids.length ? `已选 ${ids.length} 项` : "至少选择一组")}`)
    frame.push(guide)
    lines = frame.length
    output.write(`${frame.join("\n")}\n`)
    moveCursor(output, 0, -lines)
  }

  emitKeypressEvents(input)
  input.setRawMode(true)
  input.resume()
  try {
    render()
    return await new Promise((resolveSelection, rejectSelection) => {
      function onKeypress(_text, key) {
        if (!key) return
        if (key.name === "escape" || (key.ctrl && key.name === "c")) {
          input.off("keypress", onKeypress)
          rejectSelection(new UserError("已取消安装。"))
          return
        }
        if (key.name === "up") index = (index - 1 + rows.length) % rows.length
        else if (key.name === "down") index = (index + 1) % rows.length
        else if (key.name === "space") toggleRow(state, rows[index])
        else if (key.name === "return" || key.name === "enter") {
          if (state.groups.size) {
            input.off("keypress", onKeypress)
            resolveSelection(selectionResult(state))
            return
          }
        } else return
        render()
      }
      input.on("keypress", onKeypress)
    })
  } finally {
    cursorTo(output, 0)
    clearScreenDown(output)
    input.setRawMode(wasRaw)
    if (wasPaused) input.pause()
  }
}

function pickSelection(preselected) {
  // dumb / 窄终端退回序号输入，不依赖 ANSI 光标控制。
  if (process.env.TERM === "dumb" || (process.stdout.columns || 0) < 60 || !process.stdin.setRawMode) {
    return pickSelectionByNumber(preselected)
  }
  return pickSelectionByKeys(preselected)
}

function warnNodeVersion() {
  const [major, minor] = process.versions.node.split(".").map(Number)
  // 参考随附 @opentui/core 的 engines 声明。只提示，不阻塞安装：
  // 用户明确要求安装流程不再因版本下限直接退出。
  const ok =
    Number.isInteger(major) &&
    Number.isInteger(minor) &&
    (major > 26 || (major === 26 && minor >= 4))
  if (!ok) {
    warn(`提示：Node.js ${process.versions.node} 低于随附 OpenTUI 声明的 26.4.0；安装继续，运行异常时再升级。`)
  }
}

// 版本号比较只认 `X.Y.Z[-prerelease][+build]`，且两种后缀分成各自的捕获组：
// 只有 prerelease 参与“踩线即拒”的判断，build metadata 一律忽略
// （SemVer 规定 build 不参与优先级比较）。
function parseSemver(text) {
  const match = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?/.exec(String(text || ""))
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] !== undefined,
  }
}

function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  return a.patch - b.patch
}

// 组可在 install-groups.mjs 用 minOpenCode 声明建议最低版本（形如 ">=2.0.26"）。
// 安装器只提示、不阻塞：版本解析失败或低于建议值都继续安装。
function warnOpenCodeVersion(ids, versionText) {
  const demands = ids.map((id) => groupById(id)).filter((group) => group.minOpenCode)
  if (!demands.length) return
  const summary = demands.map((group) => `${group.id} 组建议 OpenCode ${group.minOpenCode}`).join("；")
  const version = parseSemver(versionText)
  if (!version) {
    warn(`提示：无法确认 OpenCode 版本（opencode --version 输出：${versionText ? `"${versionText}"` : "空"}）。${summary}。安装继续。`)
    return
  }
  for (const group of demands) {
    const minimum = parseSemver(group.minOpenCode)
    if (!minimum) continue
    const order = compareSemver(version, minimum)
    // SemVer：同号预发布低于正式版，所以 2.0.26-beta < 2.0.26。
    if (order < 0 || (order === 0 && version.prerelease)) {
      warn(`提示：OpenCode ${versionText} 低于建议版本；${summary}。安装继续。`)
      return
    }
  }
}

// SSH 使用 permission.assert；版本不足不能像普通组件一样继续安装。
function assertSshVersion(ids, versionText) {
  if (!ids.includes("ssh")) return
  const version = parseSemver(versionText)
  const minimum = parseSemver("2.0.31")
  if (!version) {
    throw new UserError(
      `无法确认 OpenCode 版本（opencode --version 输出：${versionText ? `"${versionText}"` : "空"}）；SSH 组需要 >=2.0.31。`,
    )
  }
  const order = compareSemver(version, minimum)
  if (order < 0 || (order === 0 && version.prerelease)) {
    throw new UserError(`OpenCode ${versionText} 过旧；SSH 组需要 >=2.0.31。`)
  }
}

function resolvePython() {
  const candidates = []
  if (process.env.OPENCODE_PYTHON) candidates.push({ cmd: process.env.OPENCODE_PYTHON, args: [] })
  else if (process.platform === "win32") candidates.push({ cmd: "py", args: ["-3"] }, { cmd: "python", args: [] })
  else candidates.push({ cmd: "python3", args: [] })

  for (const candidate of candidates) {
    const probe = spawnSync(candidate.cmd, [...candidate.args, "--version"], { encoding: "utf8" })
    if (probe.error) continue
    return candidate
  }
  warn("提示：找不到 Python；gpt-reset-credits 的查询/兑换会不可用。安装继续，需要时再安装 Python 3.10+。")
  return null
}

function warnPythonVersion(python) {
  const check = spawnSync(
    python.cmd,
    [...python.args, "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"],
    { encoding: "utf8" },
  )
  if (check.status === 1) {
    warn("提示：Python 低于 3.10；gpt-reset-credits 可能无法运行。安装继续。")
  } else if (check.status !== 0) {
    warn(`提示：Python 检查失败（${python.cmd}）；安装继续。`)
  }
}

function readState() {
  try {
    return JSON.parse(readFileSync(join(STATE_DIR, "selection.json"), "utf8"))
  } catch {
    return null
  }
}

function sameBytes(a, b) {
  return a !== null && b !== null && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function entryIdentity(entry) {
  if (typeof entry === "string") return `str:${entry}`
  if (isPlainObject(entry) && typeof entry.package === "string") return `pkg:${entry.package}`
  if (isPlainObject(entry) && typeof entry.action === "string") return `perm:${entry.action}:${entry.resource ?? "*"}`
  return `json:${JSON.stringify(entry)}`
}

function valueAt(text, path) {
  let value = jsonc.parse(text, undefined, { allowTrailingComma: true })
  for (const key of path) {
    if (value === null || typeof value !== "object") return undefined
    value = value[key]
  }
  return value
}

function applyMergeEdit(text, path, value) {
  const edits = jsonc.modify(text, path, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  })
  return jsonc.applyEdits(text, edits)
}

// 只补缺失项：已有键、已有插件条目（含其 options）和已有数组元素一律保留。
// 这样用户的模型预设、卡片顺序与自定义设置不会被安装器覆盖。
function mergeMissing(text, path, templateValue) {
  const existing = valueAt(text, path)
  if (existing === undefined) return applyMergeEdit(text, path, templateValue)
  if (isPlainObject(templateValue) && isPlainObject(existing)) {
    let next = text
    for (const [key, value] of Object.entries(templateValue)) {
      next = mergeMissing(next, [...path, key], value)
    }
    return next
  }
  if (Array.isArray(templateValue) && Array.isArray(existing)) {
    let next = text
    for (const item of templateValue) {
      const current = valueAt(next, path)
      if (!current.some((entry) => entryIdentity(entry) === entryIdentity(item))) {
        next = applyMergeEdit(next, [...path, -1], item)
      }
    }
    return next
  }
  return text
}

function mergeConfigText(text, templateText) {
  const template = JSON.parse(templateText)
  let merged = text
  for (const [key, value] of Object.entries(template)) {
    merged = mergeMissing(merged, [key], value)
  }
  return merged.endsWith("\n") ? merged : `${merged}\n`
}

function installConfig({ label, template, preferred, candidates, replaceConfig, stamp }) {
  const existing = candidates.filter((path) => existsSync(path))
  if (existing.length === 0) {
    writeFileSync(preferred, template)
    info(`已安装 ${label}：${preferred}`)
    return
  }
  if (existing.length > 1) {
    warn(`提示：同时存在 ${existing.join("、")}；合并到 ${preferred}。`)
  }
  const target = existsSync(preferred) ? preferred : existing[0]
  const current = readFileSync(target, "utf8")
  if (sameBytes(current, template)) {
    info(`${label} 已是本包模板：${target}`)
    return
  }
  if (replaceConfig) {
    const backup = `${target}.bak.${stamp}`
    cpSync(target, backup, { force: true })
    info(`已备份：${backup}`)
    writeFileSync(target, template)
    info(`已替换 ${label}：${target}`)
    return
  }
  let merged
  try {
    merged = mergeConfigText(current, template)
  } catch (error) {
    throw new UserError(`合并 ${label} 失败（${target}）：${error.message}`)
  }
  if (sameBytes(merged, current)) {
    info(`${label} 已包含本包条目：${target}`)
    return
  }
  const backup = `${target}.bak.${stamp}`
  cpSync(target, backup, { force: true })
  writeFileSync(target, merged)
  info(`已备份：${backup}`)
  info(`已合并 ${label}：${target}`)
}

function copyTree(from, to) {
  rmSync(to, { recursive: true, force: true })
  cpSync(from, to, { recursive: true, force: true })
}

function copyStaged(plugins) {
  const staged = join(ROOT, "runtime-stage")
  mkdirSync(BUNDLE_DIR, { recursive: true })
  for (const name of ["scripts", "config", "docs"]) copyTree(join(staged, name), join(BUNDLE_DIR, name))
  for (const name of ["package.json", "package-lock.json", ".npmrc", "README.md", "ssh_use.md", "ssh_usage.md", "ssh_first_time_setup.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "install.sh", "install.ps1"]) {
    cpSync(join(staged, name), join(BUNDLE_DIR, name), { force: true })
  }
  // 并集保留：只覆盖本次选中插件，未选插件与卡片的旧目录不动。
  for (const plugin of plugins) copyTree(join(staged, "plugins", plugin), join(BUNDLE_DIR, "plugins", plugin))
}

// 安装完成后从目标 bundle 实际加载 SSH parser/grammar，而不是只检查文件存在。
async function verifySshRuntime(groups) {
  if (!groups.includes("ssh")) return
  const parser = join(BUNDLE_DIR, "plugins", "opencode-ssh-workshop", "dist", "src", "shell-parser.js")
  try {
    const { scanBashCommand } = await import(pathToFileURL(resolve(parser)).href)
    const scan = await scanBashCommand("env git 'push' origin main")
    if (!scan.resources.includes("git push origin main")) {
      throw new Error("解析器没有产出预期的 git push 资源")
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new UserError(`SSH 运行时验证失败（安装未完成）：${detail}`)
  }
  console.log("SSH 运行时检查通过：目标布局可加载 Bash 解析器与 grammar")
}

function run(cmd, args, cwd, shell = process.platform === "win32") {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", shell })
  return result.status ?? 1
}

function capture(cmd, args, shell = process.platform === "win32") {
  return (spawnSync(cmd, args, { encoding: "utf8", shell }).stdout || "").trim()
}

// 异步 spawn 让 spinner 在命令运行期间继续动画；spawnSync 会阻塞事件循环。
function runCaptured(cmd, args, cwd, shell = process.platform === "win32") {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { cwd, shell })
    let output = ""
    child.stdout?.on("data", (chunk) => (output += chunk))
    child.stderr?.on("data", (chunk) => (output += chunk))
    child.on("error", (error) => resolveRun({ status: 1, output: `${output}${error.message}`.trim() }))
    child.on("close", (code) => resolveRun({ status: code ?? 1, output: output.trim() }))
  })
}

// 有 clack 时用 spinner 包住一步命令；失败时由调用方打印捕获的输出。
async function runStep(label, cmd, args, cwd, shell) {
  if (!clack || !process.stdout.isTTY) {
    console.log(`${label}……`)
    return { status: run(cmd, args, cwd, shell), output: "" }
  }
  const spin = clack.spinner()
  spin.start(label)
  const result = await runCaptured(cmd, args, cwd, shell)
  spin.stop(result.status === 0 ? `${label}完成` : `${label}失败`, result.status === 0 ? 0 : 1)
  return result
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
    if (!opts.all && !opts.only && !opts.without) throw new UserError("--render 需要搭配 --all / --only / --without。")
    let groups = opts.all
      ? GROUP_IDS
      : opts.only
        ? canonical(opts.only)
        : canonical(GROUP_IDS.filter((id) => !opts.without.includes(id)))
    if (opts.cards !== null && !groups.includes("sidebar")) groups = canonical([...groups, "sidebar"])
    if (!groups.length) throw new UserError("至少选择一组。")
    ensureGroupDependencies(groups)
    const cards = opts.cards !== null ? canonicalCards(opts.cards) : groups.includes("sidebar") ? SIDEBAR_CARD_IDS : []
    const selection = resolveSelection({ groups, cards })
    const out = resolve(opts.render)
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, "opencode.jsonc"), renderOpencode(selection))
    writeFileSync(join(out, "cli.json"), renderCli(selection))
    const cardNote = selection.groups.includes("sidebar") ? `；卡片 ${selection.cards.join("、") || "无"}` : ""
    console.log(`已导出配置模板：${out}（${selection.groups.join("、")}${cardNote}）`)
    return 0
  }

  const rich =
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    process.env.TERM !== "dumb" &&
    (process.stdout.columns || 0) >= 60
  if (rich) {
    await loadClack()
    printBanner(Boolean(clack))
  }

  const previous = readState()
  let groups
  let cards
  if (opts.all || opts.only || opts.without) {
    groups = opts.all
      ? GROUP_IDS
      : opts.only
        ? canonical(opts.only)
        : canonical(GROUP_IDS.filter((id) => !opts.without.includes(id)))
    if (opts.cards !== null && !groups.includes("sidebar")) groups = canonical([...groups, "sidebar"])
    cards = opts.cards !== null ? canonicalCards(opts.cards) : groups.includes("sidebar") ? SIDEBAR_CARD_IDS : []
  } else if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new UserError("未指定选择且不在交互终端中。请使用 --all 或 --only / --without（可配合 --cards）。")
  } else {
    const previousGroups = previous?.groups?.length ? canonical(previous.groups) : GROUP_IDS
    // 首次安装与旧版状态都按“全部卡片”预选；上次明确没装卡片时尊重上次选择。
    const previousCards = previous?.groups
      ? previous.groups.includes("sidebar")
        ? canonicalCards(previous.cards ?? SIDEBAR_CARD_IDS)
        : []
      : SIDEBAR_CARD_IDS
    const initialCards = opts.cards !== null ? canonicalCards(opts.cards) : previousCards
    const picked = await pickSelection({ groups: previousGroups, cards: initialCards })
    groups = picked.groups
    cards = picked.cards
    if (cards.length && !groups.includes("sidebar")) {
      groups = canonical([...groups, "sidebar"])
      if (clack) clack.log.info("已自动包含侧栏基础与依赖。")
    }
    if (opts.cards !== null) {
      cards = canonicalCards(opts.cards)
      if (cards.length && !groups.includes("sidebar")) groups = canonical([...groups, "sidebar"])
    }
  }
  if (!groups.length) throw new UserError("至少选择一组。")
  ensureGroupDependencies(groups)

  const selection = resolveSelection({ groups, cards })
  groups = selection.groups
  cards = selection.cards

  warnNodeVersion()
  const python = selection.requiresPython ? resolvePython() : null
  if (python) warnPythonVersion(python)

  const opencodeVersion = capture("opencode", ["--version"])
  info(`OpenCode：${opencodeVersion || "未知版本"}`)
  assertSshVersion(groups, opencodeVersion)
  warnOpenCodeVersion(groups, opencodeVersion)
  info(`Node.js：${process.version}`)
  if (python) info(`Python：${capture(python.cmd, [...python.args, "--version"], false) || "未知版本"}`)
  info(`本次安装组：${groups.join("、")}`)
  if (groups.includes("sidebar")) info(`侧栏卡片：${cards.length ? cards.join("、") : "无（仅侧栏基础）"}`)
  info(`插件：${selection.plugins.join("、")}`)

  const removedGroups = previous?.groups ? canonical(previous.groups).filter((id) => !groups.includes(id)) : []
  const previousCards = previous?.groups?.includes("sidebar") ? previous.cards ?? SIDEBAR_CARD_IDS : []
  const removedCards = groups.includes("sidebar") ? canonicalCards(previousCards).filter((id) => !cards.includes(id)) : []

  if (!updateMode) {
    const built = await runStep("构建发行文件", process.execPath, [join(ROOT, "scripts", "stage-runtime.mjs"), "--defer-runtime-check"], ROOT, false)
    if (built.status !== 0) {
      if (built.output) console.error(built.output)
      throw new UserError("运行时发行包构建失败。")
    }
    copyStaged(selection.plugins)
  }

  const npmStep = await runStep("安装运行依赖", "npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], BUNDLE_DIR)
  if (npmStep.status !== 0) {
    if (npmStep.output) console.error(npmStep.output)
    throw new UserError("npm ci 失败。")
  }
  await verifySshRuntime(groups)

  try {
    // 从目标 bundle 的 node_modules 加载，避免源码检出没有 node_modules 时失败。
    jsonc = createRequire(join(BUNDLE_DIR, "package.json"))("jsonc-parser")
  } catch (error) {
    throw new UserError(`无法加载配置合并依赖 jsonc-parser：${error.message}`)
  }

  const stamp = timestamp()
  const opencodeTemplate = renderOpencode(selection)
  const cliTemplate = renderCli(selection)
  mkdirSync(STATE_DIR, { recursive: true })
  mkdirSync(CONFIG_ROOT, { recursive: true })

  installConfig({
    label: "OpenCode 配置",
    template: opencodeTemplate,
    preferred: join(CONFIG_ROOT, "opencode.jsonc"),
    candidates: [join(CONFIG_ROOT, "opencode.jsonc"), join(CONFIG_ROOT, "opencode.json")],
    replaceConfig: opts.replaceConfig,
    stamp,
  })
  installConfig({
    label: "CLI 配置",
    template: cliTemplate,
    preferred: join(CONFIG_ROOT, "cli.json"),
    candidates: [join(CONFIG_ROOT, "cli.json")],
    replaceConfig: opts.replaceConfig,
    stamp,
  })

  writeFileSync(join(STATE_DIR, "template-opencode.jsonc"), opencodeTemplate)
  writeFileSync(join(STATE_DIR, "template-cli.json"), cliTemplate)
  writeFileSync(
    join(STATE_DIR, "selection.json"),
    `${JSON.stringify({ format: 2, groups, cards, installedAt: new Date().toISOString() }, null, 2)}\n`,
  )

  console.log("")
  if (clack) {
    clack.log.success(`Bundle 已安装到：${BUNDLE_DIR}`)
    if (removedGroups.length) {
      clack.log.warn(`本次减少了组：${removedGroups.join("、")}。bundle 保留其插件文件，已有配置条目未被改动。`)
      clack.log.info("如需停用这些组，请从 opencode.jsonc / cli.json 的 plugins 数组删除对应条目。")
    }
    if (removedCards.length) {
      clack.log.warn(`本次去掉了侧栏卡片：${removedCards.join("、")}。已有配置条目不会被自动删除。`)
      clack.log.info("如需彻底移除，请从 opencode.jsonc / cli.json 的 plugins 数组删除对应条目。")
    }
    if (groups.includes("sidebar")) {
      clack.log.info("侧栏顺序与显隐以宿主条目的 sidebarCards 为准；安装器只补缺失条目，不重写已有设置。")
    }
    clack.log.success("配置已就绪")
    clack.outro("安装完成！启动 OpenCode 后受监视的插件和配置支持 v2 重载。")
  } else {
    console.log(`Bundle 已安装到：${BUNDLE_DIR}`)
    if (removedGroups.length) {
      console.log(`本次减少了组：${removedGroups.join("、")}。bundle 保留其插件文件，已有配置条目未被改动；`)
      console.log("如需停用这些组，请从 opencode.jsonc / cli.json 的 plugins 数组删除对应条目。")
    }
    if (removedCards.length) {
      console.log(`本次去掉了侧栏卡片：${removedCards.join("、")}。已有配置条目不会被自动删除；`)
      console.log("如需彻底移除，请从 opencode.jsonc / cli.json 的 plugins 数组删除对应条目。")
    }
    if (groups.includes("sidebar")) {
      console.log("侧栏顺序与显隐以宿主条目的 sidebarCards 为准；安装器只补缺失条目，不重写已有设置。")
    }
    console.log("配置已就绪。")
    console.log("安装完成！")
    console.log("启动 OpenCode 后受监视的插件和配置支持 v2 重载。")
  }
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
