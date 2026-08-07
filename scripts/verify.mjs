import { access, readFile } from "node:fs/promises"
import { constants } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

const requiredFiles = [
  "package.json",
  "plugins/opencode-quota-zh/dist/index.js",
  "plugins/opencode-quota-zh/dist/tui.tsx",
  "plugins/opencode-quota-zh/dist/data/modelsdev-pricing.min.json",
  "plugins/opencode-enhanced-sidebar-zh/src/tui.tsx",
  "plugins/opencode-enhanced-sidebar-zh/src/data/modelsdev-pricing.min.json",
  "plugins/opencode-matt-workshop/dist/src/index.js",
  "plugins/opencode-matt-workshop/skills/ask-matt/SKILL.md",
  "plugins/opencode-matt-workshop/skill-manifest.json",
  "plugins/gpt-reset-credits/index.ts",
  "plugins/gpt-reset-credits/reset_credits.py",
]

const errors = []

const [major, minor] = process.versions.node.split(".").map(Number)
if (major < 22 || (major === 22 && minor < 6)) {
  errors.push(`Node.js ${process.versions.node} 过旧；需要 22.6.0 或更高版本。`)
}

for (const relative of requiredFiles) {
  try {
    await access(join(root, relative), constants.R_OK)
  } catch {
    errors.push(`缺少运行文件：${relative}`)
  }
}

const runtimePackages = [
  "@clack/prompts",
  "@opencode-ai/plugin",
  "@opentelemetry/api",
  "@opentui/core",
  "@opentui/keymap",
  "@opentui/solid",
  "comment-json",
  "jsonc-parser",
  "solid-js",
  "xdg-basedir",
  "zod",
]

for (const name of runtimePackages) {
  try {
    import.meta.resolve(name)
  } catch {
    errors.push(`依赖未安装：${name}（请在 bundle 目录运行 npm ci --omit=dev --ignore-scripts）`)
  }
}

if (errors.length === 0) {
  try {
    const quota = await import(join(root, "plugins/opencode-quota-zh/dist/index.js"))
    const workshop = await import(join(root, "plugins/opencode-matt-workshop/dist/src/index.js"))
    if (!quota.default) errors.push("opencode-quota-zh 没有默认导出。")
    if (typeof workshop.default !== "function") errors.push("opencode-matt-workshop 默认导出无效。")
  } catch (error) {
    errors.push(`服务端插件导入失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

try {
  const gptSource = await readFile(join(root, "plugins/gpt-reset-credits/index.ts"), "utf8")
  if (!gptSource.includes("gpt_reset_credits_query") || !gptSource.includes("gpt_reset_credits_redeem")) {
    errors.push("gpt-reset-credits 工具定义不完整。")
  }
} catch {
  // The missing-file error has already been reported above.
}

if (errors.length > 0) {
  console.error("安装验证失败：")
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log("安装验证通过：运行文件、依赖和服务端插件入口均可用。")
  console.log("TUI 插件将在重启 OpenCode 后由 OpenCode 自身加载验证。")
}
