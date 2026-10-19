import { cp, mkdir, readdir, rm } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const destination = join(root, "runtime-stage")
const copy = async (from, to = from, options = {}) => {
  const target = join(destination, to)
  await mkdir(dirname(target), { recursive: true })
  return cp(join(root, from), target, { recursive: true, force: true, ...options })
}

await rm(destination, { recursive: true, force: true })
await mkdir(destination, { recursive: true })
await Promise.all([
  copy("config"),
  copy("plugins/opencode-quota-zh/dist", "plugins/opencode-quota-zh/dist"),
  copy("plugins/opencode-quota-zh/package.json", "plugins/opencode-quota-zh/package.json"),
  copy("plugins/opencode-quota-zh/index.ts", "plugins/opencode-quota-zh/index.ts"),
  copy("plugins/opencode-quota-zh/tui.ts", "plugins/opencode-quota-zh/tui.ts"),
  copy("plugins/opencode-quota-zh/LICENSE", "plugins/opencode-quota-zh/LICENSE"),
  copy("plugins/opencode-quota-zh/README.zh.md", "plugins/opencode-quota-zh/README.zh.md"),
  copy("plugins/opencode-enhanced-sidebar-zh"),
  copy("plugins/opencode-session-data"),
  copy("plugins/opencode-sidebar-host-zh"),
  copy("plugins/opencode-session-overview-zh"),
  copy("plugins/opencode-subagent-card-zh"),
  copy("plugins/opencode-quota-card-zh"),
  copy("plugins/opencode-skill-panel"),
  copy("plugins/gpt-reset-credits"),
  copy("package.json"), copy("package-lock.json"), copy(".npmrc"), copy("README.md"), copy("LICENSE"), copy("THIRD_PARTY_NOTICES.md"), copy("install.sh"), copy("install.ps1"),
  copy("scripts/install-main.mjs", "scripts/install-main.mjs"),
  copy("scripts/install-groups.mjs", "scripts/install-groups.mjs"),
  copy("docs/MERGE_EXISTING_CONFIG.md", "docs/MERGE_EXISTING_CONFIG.md"), copy("docs/TROUBLESHOOTING.md", "docs/TROUBLESHOOTING.md"), copy("docs/sidebar-ui-manual-acceptance.md", "docs/sidebar-ui-manual-acceptance.md"),
])
await copy("plugins/opencode-matt-workshop/dist", "plugins/opencode-matt-workshop/dist")
await copy("plugins/opencode-matt-workshop/skills", "plugins/opencode-matt-workshop/skills")
await copy("plugins/opencode-matt-workshop/licenses", "plugins/opencode-matt-workshop/licenses")
await copy("plugins/opencode-matt-workshop/package.json", "plugins/opencode-matt-workshop/package.json")
await copy("plugins/opencode-matt-workshop/index.ts", "plugins/opencode-matt-workshop/index.ts")
await copy("plugins/opencode-matt-workshop/README.md", "plugins/opencode-matt-workshop/README.md")
await copy("plugins/opencode-matt-workshop/skill-manifest.json", "plugins/opencode-matt-workshop/skill-manifest.json")

async function list(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map(async (entry) => entry.isDirectory() ? list(join(directory, entry.name)) : [join(directory, entry.name)]))).flat()
}
const staged = (await list(destination)).map((path) => relative(destination, path).replaceAll("\\", "/"))
// matt-workshop 的源码资产只允许出现在源码仓库：vendor / src / 内部 docs / 本地技能源目录
// 一律不得进入运行包。local-skills 是手写本地技能（当前为 ask-matt）的唯一来源，
// 日常同步会优先读取它覆盖同名上游技能后生成 skills/，但 local-skills 本身不参与发行。
const forbidden = staged.filter((path) => /plugins\/opencode-matt-workshop\/(vendor|src|docs\/adr|docs\/implementation|local-skills)(\/|$)|(^|\/)\.agents(\/|$)|(^|\/)CONTEXT\.md$|sync-matt-skills|skill-policy|upstream-provenance/.test(path))
const quotaZhAllowed = /^plugins\/opencode-quota-zh\/(dist\/|index\.ts$|tui\.ts$|package\.json$|LICENSE$|README\.zh\.md$)/
for (const path of staged) {
  if (path.startsWith("plugins/opencode-quota-zh/") && !quotaZhAllowed.test(path)) {
    forbidden.push(`non-runtime quota-zh file staged: ${path}`)
  }
}
const scriptsAllowed = new Set(["scripts/install-main.mjs", "scripts/install-groups.mjs"])
for (const path of staged) {
  if (path.startsWith("scripts/") && !scriptsAllowed.has(path)) {
    forbidden.push(`non-runtime script staged: ${path}`)
  }
}
// 生产关键文件断言：这些是两条入口（Server：index.ts → dist/index.js；TUI：tui.ts → dist/tui-v2.tsx）
// 直接 import 的模块，以及运行包自身需要的环境声明。缺任何一条都意味着某个 copy 规则被删改，
// 运行时会以“模块缺失”在加载期失败，所以在这里就炸掉，而不是让 stage 假通过。
// 只断言入口直连的关键文件：v6 树的其余文件由 dist/ 整目录复制带入。
// 侧栏宿主控制窗口直接 import 的生产模块（control-window + ui/ 组件）同理纳入：
// 缺任何一个都会让控制窗口在加载期报“模块缺失”；新额度卡片 adapter 与 skill-options 同理。
const required = ["config/opencode.jsonc", "config/cli.json", "scripts/install-main.mjs", "scripts/install-groups.mjs", ".npmrc", "plugins/opencode-matt-workshop/index.ts", "plugins/opencode-matt-workshop/dist/src/index.js", "plugins/opencode-matt-workshop/skill-manifest.json", "plugins/opencode-matt-workshop/skills/ask-matt/SKILL.md", "plugins/opencode-matt-workshop/skills/wizard/template.sh", "plugins/opencode-matt-workshop/licenses/MATT-POCOCK-SKILLS-LICENSE", "plugins/opencode-quota-zh/index.ts", "plugins/opencode-quota-zh/tui.ts", "plugins/opencode-quota-zh/package.json", "plugins/opencode-quota-zh/dist/index.js", "plugins/opencode-quota-zh/dist/tui-v2.tsx", "plugins/opencode-quota-zh/dist/quota-rpc.js", "plugins/opencode-quota-zh/dist/lib/quota-sidebar-cards.js", "plugins/opencode-quota-zh/dist/local-tui-bridge.js", "plugins/opencode-quota-zh/dist/v6/plugin.js", "plugins/opencode-quota-zh/dist/v6/rpc.js", "plugins/opencode-quota-zh/dist/v6/lib/modelsdev-pricing.js", "plugins/opencode-quota-zh/dist/v6/data/modelsdev-pricing.min.json", "plugins/opencode-quota-zh/dist/v6/core/usage.js", "plugins/opencode-quota-zh/dist/v6/tui/index.js", "plugins/opencode-quota-zh/dist/v6/tui/index.tsx", "plugins/opencode-session-data/src/metrics/quota-usage-rpc.ts", "plugins/opencode-session-data/tui.ts", "plugins/opencode-sidebar-host-zh/tui.ts", "plugins/opencode-sidebar-host-zh/src/presentation.ts", "plugins/opencode-sidebar-host-zh/src/card-controls.ts", "plugins/opencode-sidebar-host-zh/src/plugin-options.ts", "plugins/opencode-sidebar-host-zh/src/control-window.tsx", "plugins/opencode-sidebar-host-zh/src/ui/types.ts", "plugins/opencode-sidebar-host-zh/src/ui/text.ts", "plugins/opencode-sidebar-host-zh/src/ui/appearance.ts", "plugins/opencode-sidebar-host-zh/src/ui/rail.tsx", "plugins/opencode-sidebar-host-zh/src/ui/option-row.tsx", "plugins/opencode-session-overview-zh/tui.ts", "plugins/opencode-subagent-card-zh/tui.ts", "plugins/opencode-quota-card-zh/tui.ts", "plugins/opencode-quota-card-zh/src/native-quota-card.tsx", "plugins/opencode-skill-panel/tui.ts", "plugins/opencode-skill-panel/src/tui-v2.tsx", "plugins/opencode-skill-panel/src/skill-tracker.ts", "plugins/opencode-skill-panel/src/skill-options.ts"]
required.push(
  "plugins/opencode-session-overview-zh/src/card-controls.ts",
  "plugins/opencode-subagent-card-zh/src/card-controls.ts",
  "plugins/opencode-skill-panel/src/card-controls.ts",
)
for (const path of required) if (!staged.includes(path)) forbidden.push(`missing required runtime file: ${path}`)
if (forbidden.length) throw new Error(`Runtime distribution isolation failed:\n${forbidden.join("\n")}`)
console.log(`Runtime staging passed (${staged.length} files): ${destination}`)
