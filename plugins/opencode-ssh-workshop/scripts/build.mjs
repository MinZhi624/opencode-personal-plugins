/**
 * 构建 `opencode-ssh-workshop`：tsc 产出 dist，随后把 Bash grammar 复制进 dist。
 *
 * grammar 是二进制资源，tsc 不会搬运；漏掉它，运行期只会在第一次执行远端命令时
 * 才以「解析器初始化失败」暴露，因此这里显式复制并在末尾断言它存在。
 *
 * 用法：node plugins/opencode-ssh-workshop/scripts/build.mjs
 */
import { copyFile, mkdir, readFile, rm } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const bundleRoot = resolve(pluginRoot, "..", "..")
const grammarSource = join(pluginRoot, "grammar", "tree-sitter-bash.wasm")
const grammarTarget = join(pluginRoot, "dist", "grammar", "tree-sitter-bash.wasm")

// Windows 上裸 tsc 是 tsc.cmd，需要经 cmd.exe 让 PATHEXT 生效。
const tsc = join(bundleRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc")
const result = spawnSync(tsc, ["--project", join(pluginRoot, "tsconfig.json")], {
  cwd: bundleRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

// tsc does not remove obsolete outputs. Never ship the replaced authorization path.
await rm(join(pluginRoot, "dist", "src", "shell-split.js"), { force: true })

await mkdir(dirname(grammarTarget), { recursive: true })
await copyFile(grammarSource, grammarTarget)
for (const file of ["README.md", "LICENSE"]) {
  await copyFile(join(pluginRoot, "grammar", file), join(dirname(grammarTarget), file))
}

const digest = createHash("sha256").update(await readFile(grammarTarget)).digest("hex")
if (digest !== "8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a") {
  throw new Error("Bash grammar SHA-256 does not match pinned tree-sitter-bash@0.25.1")
}
const { scanBashCommand } = await import(pathToFileURL(join(pluginRoot, "dist", "src", "shell-parser.js")).href)
const scan = await scanBashCommand("git 'status'")
if (scan.resources.length !== 1 || scan.resources[0] !== "git status") throw new Error("Bash parser runtime check failed")

const { stat } = await import("node:fs/promises")
const size = (await stat(grammarTarget)).size
if (size === 0) throw new Error(`Bash grammar 复制失败：${grammarTarget}`)
console.log(`opencode-ssh-workshop 构建完成（含 Bash grammar，${size} 字节）`)
