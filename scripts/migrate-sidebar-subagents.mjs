/** One-time OpenCode 2.0.18 local TUI-state migration. Never print stored prompts. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const root = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode", "latest", "tui")
const oldPath = join(root, "plugin.opencode-enhanced-sidebar-zh.subagent-magazine-v2.json")
const newPath = join(root, "plugin.opencode-subagent-card-zh.subagent-magazine-v2.json")
const args = process.argv.slice(2)
const apply = args.includes("--apply")
const index = args.indexOf("--check-session")
const sessionID = index >= 0 ? args[index + 1] : undefined
if (index >= 0 && (!sessionID || sessionID.startsWith("--"))) throw new Error("--check-session 需要会话 ID")
if (!existsSync(oldPath) || !existsSync(newPath)) throw new Error("旧／新 TUI 状态文件缺失；不写入，请先核对 OpenCode 版本与安装状态")

function read(path) {
  const value = JSON.parse(readFileSync(path, "utf8"))
  if (value?.version !== 2 || !value.byParent || typeof value.byParent !== "object" || Array.isArray(value.byParent)) {
    throw new Error("子代理存档格式不兼容；未写入")
  }
  for (const entries of Object.values(value.byParent)) {
    if (!Array.isArray(entries) || entries.some((entry) => !entry || typeof entry.id !== "string" || typeof entry.parentID !== "string")) {
      throw new Error("子代理条目格式不兼容；未写入")
    }
  }
  return value
}
const oldState = read(oldPath)
const newState = read(newPath)
const count = (state) => Object.values(state.byParent).reduce((sum, entries) => sum + entries.length, 0)
const oldCount = count(oldState)
const newCount = count(newState)

if (sessionID && !apply) {
  const from = oldState.byParent[sessionID]?.length ?? 0
  const to = newState.byParent[sessionID]?.length ?? 0
  console.log(`本会话旧记录 ${from}，新记录 ${to}（只输出计数）`)
  if (from > 0 && to === 0) process.exitCode = 1
} else if (!apply) {
  console.log(`旧存档 ${oldCount} 条，新存档 ${newCount} 条。运行 --apply 合并；不会删除旧存档。`)
} else {
  const merged = structuredClone(newState)
  merged.clearedByParent ??= {}
  for (const [parentID, entries] of Object.entries(oldState.byParent)) {
    const target = merged.byParent[parentID] ??= []
    const seen = new Set([...target.map((entry) => entry.id), ...(merged.clearedByParent[parentID] ?? [])])
    for (const entry of entries) if (!seen.has(entry.id)) {
      target.push(entry)
      seen.add(entry.id)
    }
  }
  for (const [parentID, ids] of Object.entries(oldState.clearedByParent ?? {})) {
    if (!Array.isArray(ids)) throw new Error("旧清理记录格式不兼容；未写入")
    const target = merged.clearedByParent[parentID] ??= []
    for (const id of ids) if (typeof id === "string" && !target.includes(id)) target.push(id)
  }
  const backupRoot = process.env.OPENCODE_SIDEBAR_MIGRATION_BACKUP_DIR || join(homedir(), ".config", "opencode", "backups")
  const directory = join(backupRoot, `subagent-state-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  copyFileSync(oldPath, join(directory, "old.json"))
  copyFileSync(newPath, join(directory, "new.json"))
  const temp = `${newPath}.migration-${process.pid}`
  try {
    writeFileSync(temp, `${JSON.stringify(merged)}\n`, { flag: "wx", mode: 0o600 })
    renameSync(temp, newPath)
  } catch (error) {
    throw new Error(`目标文件未完成写入；备份保留于 ${directory}`, { cause: error })
  }
  console.log(`已合并：旧 ${oldCount} 条，新原有 ${newCount} 条，现有 ${count(merged)} 条；备份：${directory}。请重启 TUI。`)
}
