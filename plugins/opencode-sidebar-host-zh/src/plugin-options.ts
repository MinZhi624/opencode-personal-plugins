/** Card-owned CLI options. Same conservative file rules and lock as the host writer. */
import { constants } from "node:fs"
import { access, lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises"
import { dirname, resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { applyEdits, modify, parse, parseTree, type Node, type ParseError } from "jsonc-parser"
import { cliConfigPath, inlineCliConfigActive } from "./cli-config.ts"

type Options = Record<string, unknown>
function record(value: unknown): value is Options { return typeof value === "object" && value !== null && !Array.isArray(value) }
function unique(node: Node) {
  if (node.type === "object") {
    const keys = new Set<string>()
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value as string
      if (keys.has(key)) throw new Error("cli.json 包含重复键，请先修复后再保存")
      keys.add(key)
    }
  }
  for (const child of node.children ?? []) unique(child)
}

export function createPluginOptionsConfig(packageName: string, directory: string, path = cliConfigPath()) {
  async function locate(text: string) {
    const errors: ParseError[] = []
    const tree = parseTree(text, errors, { allowTrailingComma: true })
    if (!tree || errors.length || tree.type !== "object") throw new Error("cli.json 格式无效，未修改文件")
    unique(tree)
    const config = parse(text, [], { allowTrailingComma: true }) as Options
    if (!Array.isArray(config.plugins)) throw new Error("cli.json 缺少插件列表")
    const indices: number[] = []
    for (const [index, entry] of config.plugins.entries()) {
      const name = record(entry) ? entry.package : entry
      if (typeof name !== "string") continue
      let matches = name === packageName || name.startsWith(`${packageName}@`)
      if (!matches && (name.startsWith(".") || name.startsWith("/") || name.startsWith("file:") || /^[a-zA-Z]:[\\/]/.test(name))) {
        try {
          const candidate = name.startsWith("file:") ? fileURLToPath(name) : resolve(dirname(path), name)
          const [a, b] = await Promise.all([realpath(candidate), realpath(directory)])
          matches = process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
        } catch { /* Missing paths are not guessed as the current plugin. */ }
      }
      if (matches) indices.push(index)
    }
    if (indices.length !== 1) throw new Error(`${packageName} 条目缺失或重复，无法安全保存展示选项`)
    const index = indices[0]!
    const entry: unknown = config.plugins[index]
    const options = record(entry) ? entry.options : undefined
    if (options !== undefined && !record(options)) throw new Error("插件 options 不是对象，无法安全保存")
    return { index, entry, options: (options ?? {}) as Options }
  }
  async function snapshot() {
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("cli.json 必须是普通文件；符号链接请手动编辑")
    const text = await readFile(path, "utf8")
    const stat = await lstat(path)
    if (before.ino !== stat.ino || before.dev !== stat.dev || before.mtimeMs !== stat.mtimeMs || before.size !== stat.size) throw new Error("读取时配置已变化，请重试")
    return { text, stat, located: await locate(text) }
  }
  async function read(): Promise<Options> {
    if (inlineCliConfigActive()) throw new Error("环境变量覆盖 CLI 设置，展示选项只读；请直接修改覆盖来源")
    return (await snapshot()).located.options
  }
  async function update(change: (current: Options) => Options): Promise<Options> {
    if (inlineCliConfigActive()) throw new Error("环境变量覆盖 CLI 设置，已拒绝文件写入")
    const lockPath = `${path}.sidebar-host.lock`
    const lock = await open(lockPath, "wx", 0o600)
    let temporary: string | undefined
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }))
      const current = await snapshot()
      if (!(current.stat.mode & 0o222)) throw new Error("cli.json 为只读文件")
      await access(path, constants.W_OK)
      await access(dirname(path), constants.W_OK)
      const patch = change(current.located.options)
      const indent = current.text.match(/^([\t ]+)"/m)?.[1] ?? "  "
      const formattingOptions = { insertSpaces: !indent.includes("\t"), tabSize: indent.includes("\t") ? 1 : indent.length, eol: current.text.includes("\r\n") ? "\r\n" : "\n" }
      const base = ["plugins", current.located.index]
      let text = current.text
      if (typeof current.located.entry === "string") text = applyEdits(text, modify(text, base, { package: current.located.entry, options: {} }, { formattingOptions }))
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined && !["string", "number", "boolean"].includes(typeof value)) throw new Error("展示选项仅支持简单值")
        text = applyEdits(text, modify(text, [...base, "options", key], value, { formattingOptions }))
      }
      const validated = await locate(text)
      if (!Object.entries(patch).every(([key, value]) => validated.options[key] === value)) throw new Error("生成配置校验失败，原文件未改动")
      temporary = join(dirname(path), `.cli.card-${randomUUID()}.tmp`)
      const file = await open(temporary, "wx", current.stat.mode & 0o7777)
      try { await file.chmod(current.stat.mode & 0o7777); await file.writeFile(text, "utf8"); await file.sync() } finally { await file.close() }
      const latest = await snapshot()
      if (latest.text !== current.text || latest.stat.ino !== current.stat.ino || latest.stat.dev !== current.stat.dev || latest.stat.mtimeMs !== current.stat.mtimeMs || latest.stat.mode !== current.stat.mode) throw new Error("配置被其他窗口或编辑器修改，请重读后重试")
      await rename(temporary, path)
      temporary = undefined
      const confirmed = await snapshot()
      if (confirmed.text !== text) throw new Error("写入后文件已变化，无法确认保存，请重新读取")
      return confirmed.located.options
    } finally {
      if (temporary) await unlink(temporary).catch(() => {})
      await lock.close().catch(() => {})
      await unlink(lockPath).catch(() => {})
    }
  }
  return { read, update }
}
