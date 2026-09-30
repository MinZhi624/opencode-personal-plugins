/** 宿主内部的本机文件 Adapter：只编辑唯一宿主条目的排序／显隐。 */
import { constants } from "node:fs"
import { access, lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { applyEdits, modify, parse, parseTree, type Node, type ParseError } from "jsonc-parser"
import { parseSidebarCards, sameSidebarCards, type SidebarCardSettings } from "./host-settings.ts"

const HOST_PACKAGE = "opencode-sidebar-host-zh"
const HOST_DIRECTORY = fileURLToPath(new URL("../", import.meta.url))
const queues = new Map<string, Promise<unknown>>()

export interface CliCardConfigStatus {
  path: string
  readable: boolean
  writable: boolean
  reason: string
  hasSettings: boolean
  settings: SidebarCardSettings
  issues: string[]
}

export interface CliCardChange<T> {
  settings: SidebarCardSettings
  result: T
  save: boolean
}

export interface CliCardWrite<T> {
  status: CliCardConfigStatus
  result: T
  saved: boolean
}

export function cliConfigPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode", "cli.json")
}

export function inlineCliConfigActive(): boolean {
  // 保守降级：即便 inline 内容没有 sidebarCards，也不猜测合并后的插件归属。
  return process.env.OPENCODE_CLI_CONFIG_CONTENT !== undefined
}

function fail(message: string): never {
  throw new Error(message)
}

/** 不把原始文件、选项值或解析器错误文本输出到诊断。 */
function assertUniqueKeys(node: Node): void {
  if (node.type === "object") {
    const keys = new Set<string>()
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value as string
      if (keys.has(key)) fail("cli.json 包含重复键，无法安全定位设置；请先消除重复键")
      keys.add(key)
    }
  }
  for (const child of node.children ?? []) assertUniqueKeys(child)
}

function document(text: string): Record<string, unknown> {
  const errors: ParseError[] = []
  const root = parseTree(text, errors, { allowTrailingComma: true })
  if (!root || errors.length || root.type !== "object") fail("cli.json 不可解析为配置对象；请先修复格式")
  assertUniqueKeys(root)
  return parse(text, [], { allowTrailingComma: true }) as Record<string, unknown>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function hostEntry(packageName: unknown, path: string): Promise<boolean> {
  if (typeof packageName !== "string") return false
  if (packageName === HOST_PACKAGE || packageName.startsWith(`${HOST_PACKAGE}@`)) return true
  if (!packageName.startsWith(".") && !packageName.startsWith("/") && !packageName.startsWith("file:") &&
    !/^[a-zA-Z]:[\\/]/.test(packageName)) return false
  let directory: string
  try {
    directory = packageName.startsWith("file:") ? fileURLToPath(packageName) : resolve(dirname(path), packageName)
    const [target, host] = await Promise.all([realpath(directory), realpath(HOST_DIRECTORY)])
    return process.platform === "win32" ? target.toLowerCase() === host.toLowerCase() : target === host
  } catch {
    return false
  }
}

async function locate(text: string, path: string) {
  const config = document(text)
  if (!Array.isArray(config.plugins)) fail("cli.json 缺少 plugins 数组；请手动配置宿主")
  const matches: number[] = []
  for (let index = 0; index < config.plugins.length; index++) {
    const entry: unknown = config.plugins[index]
    if (await hostEntry(record(entry) ? entry.package : entry, path)) matches.push(index)
  }
  if (matches.length !== 1) fail(matches.length ? "宿主条目重复，已拒绝写入；请只保留一个宿主" : "无法唯一定位当前宿主条目；请使用宿主包目录的实际路径")
  const index = matches[0]!
  const entry: unknown = config.plugins[index]
  const options = record(entry) ? entry.options : undefined
  if (options !== undefined && !record(options)) fail("宿主 options 不是对象，已拒绝写入")
  const hasSettings = record(options) && Object.hasOwn(options, "sidebarCards")
  const parsed = parseSidebarCards(record(options) ? options.sidebarCards : undefined)
  return { index, entry, hasSettings, ...parsed }
}

async function snapshot(path: string) {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink()) fail("cli.json 必须是普通文件，符号链接或其他文件类型仅支持手动编辑")
  const text = await readFile(path, "utf8")
  const after = await lstat(path)
  if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs || before.size !== after.size) {
    fail("读取期间 cli.json 已变化；请重试")
  }
  return { text, stat: after, located: await locate(text, path) }
}

async function writable(path: string, mode: number): Promise<void> {
  if (inlineCliConfigActive()) fail("OPENCODE_CLI_CONFIG_CONTENT 已设置；文件写入已只读降级，请先移除环境变量覆盖")
  if ((mode & 0o222) === 0) fail("cli.json 为只读文件；请手动编辑或修改权限")
  await access(path, constants.W_OK)
  await access(dirname(path), constants.W_OK)
}

export function cliConfigError(error: unknown): string {
  const code = record(error) ? error.code : undefined
  if (code === "ENOENT") return "cli.json 或宿主目录不存在；请先完成安装并手动合并配置"
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "配置文件／目录不可写，或文件被占用；请手动编辑或释放占用后重试"
  if (code === "EEXIST") return "另一进程正在编辑侧栏配置；请稍后重试（异常退出遗留的锁须在关闭所有 TUI 后手动清理）"
  if (typeof code === "string") return `文件操作失败（${code}），已拒绝继续写入`
  return error instanceof Error ? error.message.slice(0, 240) : "配置操作失败，已拒绝写入"
}

export function createCliCardConfig(path = cliConfigPath()) {
  path = resolve(path)
  async function read(): Promise<CliCardConfigStatus> {
    try {
      const current = await snapshot(path)
      let reason = "可安全写入唯一宿主条目"
      let canWrite = true
      try { await writable(path, current.stat.mode) } catch (error) {
        reason = cliConfigError(error)
        canWrite = false
      }
      return { path, readable: true, writable: canWrite, reason, hasSettings: current.located.hasSettings, settings: current.located.settings, issues: current.located.issues }
    } catch (error) {
      return { path, readable: false, writable: false, reason: cliConfigError(error), hasSettings: false, settings: { order: [], hidden: [] }, issues: [] }
    }
  }

  async function commit<T>(change: (settings: SidebarCardSettings, hasSettings: boolean) => CliCardChange<T>): Promise<CliCardWrite<T>> {
    const lockPath = `${path}.sidebar-host.lock`
    const initial = await snapshot(path)
    await writable(path, initial.stat.mode)
    const lock = await open(lockPath, "wx", 0o600)
    let temporary: string | undefined
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }))
      const current = await snapshot(path)
      await writable(path, current.stat.mode)
      const next = change(current.located.settings, current.located.hasSettings)
      if (!next.save) {
        return { status: { path, readable: true, writable: true, reason: "顺序未变化，无需写入", hasSettings: current.located.hasSettings, settings: current.located.settings, issues: current.located.issues }, result: next.result, saved: false }
      }
      const parsed = parseSidebarCards(next.settings)
      if (parsed.issues.length || !sameSidebarCards(parsed.settings, next.settings)) fail("待写入的卡片设置无效，已拒绝写入")
      const indent = current.text.match(/^([\t ]+)"/m)?.[1] ?? "  "
      const formattingOptions = { insertSpaces: !indent.includes("\t"), tabSize: indent.includes("\t") ? 1 : indent.length, eol: current.text.includes("\r\n") ? "\r\n" : "\n" }
      let text = current.text
      const base = ["plugins", current.located.index]
      // 字符串条目先转对象，已有对象的其余 options 原样保留。
      if (typeof current.located.entry === "string") {
        text = applyEdits(text, modify(text, base, { package: current.located.entry, options: {} }, { formattingOptions }))
      }
      for (const field of ["order", "hidden"] as const) {
        text = applyEdits(text, modify(text, [...base, "options", "sidebarCards", field], next.settings[field], { formattingOptions }))
      }
      const validated = await locate(text, path)
      if (!validated.hasSettings || validated.issues.length || !sameSidebarCards(validated.settings, next.settings)) fail("生成的配置未通过校验，原文件不变")
      const temporaryPath = join(dirname(path), `.cli.sidebar-host-${randomUUID()}.tmp`)
      const file = await open(temporaryPath, "wx", current.stat.mode & 0o7777)
      temporary = temporaryPath
      try {
        await file.chmod(current.stat.mode & 0o7777)
        await file.writeFile(text, "utf8")
        await file.sync()
      } finally { await file.close() }
      const latest = await snapshot(path)
      if (latest.text !== current.text || latest.stat.ino !== current.stat.ino || latest.stat.dev !== current.stat.dev ||
        latest.stat.mtimeMs !== current.stat.mtimeMs || latest.stat.mode !== current.stat.mode) fail("cli.json 被其他程序修改，已中止；请重新操作")
      await writable(path, latest.stat.mode)
      // 不删除原文件作 Windows 回退：rename 失败则保留原文件并提示重试。
      await rename(temporary, path)
      temporary = undefined
      const confirmed = await snapshot(path)
      if (confirmed.text !== text || !sameSidebarCards(confirmed.located.settings, next.settings)) {
        fail("写入后的文件已变化，保存无法确认；请重新读取配置，不要覆盖其他程序的修改")
      }
      return { status: { path, readable: true, writable: true, reason: "已写入并重新读取确认", hasSettings: true, settings: confirmed.located.settings, issues: confirmed.located.issues }, result: next.result, saved: true }
    } finally {
      if (temporary) await unlink(temporary).catch(() => {})
      await lock.close().catch(() => {})
      await unlink(lockPath).catch(() => {})
    }
  }

  function update<T>(change: (settings: SidebarCardSettings, hasSettings: boolean) => CliCardChange<T>): Promise<CliCardWrite<T>> {
    const previous = queues.get(path) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(() => commit(change))
    queues.set(path, operation)
    void operation.finally(() => { if (queues.get(path) === operation) queues.delete(path) }).catch(() => {})
    return operation
  }
  return { path, read, update }
}
