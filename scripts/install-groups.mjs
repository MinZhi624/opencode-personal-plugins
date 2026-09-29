// 选择性安装：组清单单一事实来源。
// 组定义、插件清单、配置片段与组内规则都只在此文件维护；
// config/opencode.jsonc 与 config/cli.json 是全选组合的生成结果（参考样例），
// 修改片段后用 `node scripts/install-main.mjs --all --render config` 重新生成并核对。

export const GROUPS = [
  {
    id: "workshop",
    title: "工作流（Matt Workshop）",
    summary: "Drafter / Foreman / Tinker 等 agent 与 Workflow Skill 命令",
    requiresPython: false,
    plugins: ["opencode-matt-workshop"],
    opencodeEntries: `    {
      "package": "./opencode-zh-bundle/plugins/opencode-matt-workshop",
      "options": {
        "agents": {
          "drafter": { "model": "openai/gpt-5.6-sol", "variant": "high" },
          "tinker": { "model": "opencode-go/deepseek-v4-flash", "variant": "high" },
          "foreman": { "model": "openai/gpt-5.6-terra", "variant": "high" },
          "maker": { "model": "opencode-go/deepseek-v4-flash", "variant": "max" },
          "inspector": { "model": "opencode-go/mimo-v2.5" },
          "archivist": { "model": "openai/gpt-5.6-luna", "variant": "medium" },
          "surveyor": { "model": "opencode-go/mimo-v2.5" }
        }
      }
    }`,
    opencodeExtras: `  "default_agent": "tinker",
  "agents": {
    "drafter": { "mode": "primary" },
    "tinker": { "mode": "primary" },
    "foreman": { "mode": "primary" },
    "maker": { "mode": "subagent", "hidden": true },
    "inspector": { "mode": "subagent", "hidden": true },
    "archivist": { "mode": "subagent" },
    "surveyor": { "mode": "subagent" },
    "build": { "disabled": true },
    "plan": { "disabled": true },
    "general": { "disabled": true },
    "explore": { "disabled": true }
  }`,
    cliEntries: "",
    configNotes: [
      "opencode.jsonc：plugins 中的 opencode-matt-workshop 条目（含 options.agents）",
      "opencode.jsonc：default_agent 与 agents 块",
    ],
  },
  {
    id: "sidebar",
    title: "侧栏（含额度后台 quota-zh）",
    summary: "额度／会话概览／子代理／技能卡片、宿主与共享会话统计（/quota 命令也在此组）",
    requiresPython: false,
    plugins: [
      "opencode-quota-zh",
      "opencode-sidebar-host-zh",
      "opencode-session-data",
      "opencode-quota-card-zh",
      "opencode-session-overview-zh",
      "opencode-subagent-card-zh",
      "opencode-skill-panel",
      "opencode-enhanced-sidebar-zh",
    ],
    opencodeEntries: `    "./opencode-zh-bundle/plugins/opencode-quota-zh"`,
    opencodeExtras: "",
    cliEntries: `    "./opencode-zh-bundle/plugins/opencode-quota-zh",
    "./opencode-zh-bundle/plugins/opencode-session-data",
    "./opencode-zh-bundle/plugins/opencode-sidebar-host-zh",
    "./opencode-zh-bundle/plugins/opencode-quota-card-zh",
    "./opencode-zh-bundle/plugins/opencode-session-overview-zh",
    {
      "package": "./opencode-zh-bundle/plugins/opencode-subagent-card-zh",
      "options": {
        "subagentsSortOrder": "desc",
        "subagentsMaxEntries": 10,
        "subagentsTtlDays": 3
      }
    },
    { "package": "./opencode-zh-bundle/plugins/opencode-skill-panel", "options": { "skillPanelMaxUsed": 8, "skillPanelDefaultOpen": true } }`,
    configNotes: [
      "opencode.jsonc：plugins 中的 opencode-quota-zh 条目（Server 入口）",
      "cli.json：opencode-quota-zh、opencode-session-data、opencode-sidebar-host-zh、opencode-quota-card-zh、opencode-session-overview-zh、opencode-subagent-card-zh、opencode-skill-panel 七个条目",
    ],
  },
  {
    id: "alone",
    title: "独立（gpt-reset-credits）",
    summary: "ChatGPT 重置卡查询与确认兑换；需要 Python 3.10+",
    requiresPython: true,
    plugins: ["gpt-reset-credits"],
    opencodeEntries: `    "./opencode-zh-bundle/plugins/gpt-reset-credits"`,
    opencodeExtras: `  "permissions": [
    { "action": "gpt-reset-credits.query", "resource": "*", "effect": "allow" },
    { "action": "gpt-reset-credits.redeem", "resource": "*", "effect": "ask" }
  ]`,
    cliEntries: "",
    configNotes: [
      "opencode.jsonc：plugins 中的 gpt-reset-credits 条目",
      "opencode.jsonc：permissions 中的 gpt-reset-credits.query / redeem 两条",
    ],
  },
]

export const GROUP_IDS = GROUPS.map((group) => group.id)

export function groupById(id) {
  return GROUPS.find((group) => group.id === id)
}

// 生成顺序固定，保证全选组合与参考样例逐字节一致。
const OPENCODE_ENTRY_ORDER = ["sidebar", "alone", "workshop"]
const OPENCODE_EXTRAS_ORDER = ["workshop", "alone"]

export function renderOpencode(ids) {
  const selected = new Set(ids)
  const entries = OPENCODE_ENTRY_ORDER.filter((id) => selected.has(id)).map((id) => groupById(id).opencodeEntries)
  const extras = OPENCODE_EXTRAS_ORDER.filter((id) => selected.has(id)).map((id) => groupById(id).opencodeExtras).filter(Boolean)
  let out = `{\n  "$schema": "https://opencode.ai/config.json",\n  "plugins": [\n${entries.join(",\n")}\n  ]`
  for (const extra of extras) out += `,\n${extra}`
  return `${out}\n}\n`
}

export function renderCli(ids) {
  const entries = GROUPS.filter((group) => ids.includes(group.id) && group.cliEntries).map((group) => group.cliEntries)
  let out = `{\n  "$schema": "https://opencode.ai/v2/cli.json",\n  "plugins": [`
  if (entries.length) out += `\n${entries.join("\n")}\n`
  out += `  ]\n}\n`
  return out
}

export function renderMergeDoc({ ids, removedIds, timestamp }) {
  const selected = ids.map((id) => groupById(id))
  const removed = removedIds.map((id) => groupById(id))
  const opencodeEntries = OPENCODE_ENTRY_ORDER.filter((id) => ids.includes(id)).map((id) => groupById(id).opencodeEntries)
  const opencodeExtras = OPENCODE_EXTRAS_ORDER.filter((id) => ids.includes(id)).map((id) => groupById(id).opencodeExtras).filter(Boolean)
  const cliEntries = selected.map((group) => group.cliEntries).filter(Boolean)

  return `# 按本次安装选择生成的配置合并片段

- 生成时间：${timestamp}
- 本次选择：${ids.join("、") || "（无）"}
- 通用合并方法与注意事项见 [MERGE_EXISTING_CONFIG.md](./MERGE_EXISTING_CONFIG.md)。

安装器默认不修改已有 OpenCode 配置。请把下列片段合并到现有配置；未选组的条目不要添加。

## opencode.jsonc（服务端）

plugins 数组（按选择裁剪）：

\`\`\`jsonc
${opencodeEntries.join(",\n")}
\`\`\`
${opencodeExtras.length ? `
附加键：

\`\`\`jsonc
${opencodeExtras.join(",\n")}
\`\`\`
` : ""}
## cli.json（终端）

plugins 数组（按选择裁剪）：

\`\`\`jsonc
${cliEntries.join(",\n") || "（此选择无需 cli.json 条目）"}
\`\`\`

## 本次未选组需要删除的条目${removed.length ? "" : "（无）"}

${removed.length ? removed.flatMap((group) => group.configNotes.map((note) => `- ${note}`)).join("\n") : "本次没有相对上次安装减少的组。"}
`
}
