// 选择性安装：组清单单一事实来源。
// 组定义、插件清单、配置片段与组内规则都只在此文件维护；
// config/opencode.jsonc 与 config/cli.json 是全选组合的生成结果（参考样例），
// 修改片段后用 `node scripts/install-main.mjs --all --render config` 重新生成并核对。

export const GROUPS = [
  {
    id: "workshop",
    title: "工作流（Matt Workshop）",
    summary: "Drafter / Tinker / Foreman、四个 Worker、25 个 Workflow Skill、模型预设与网页编排台",
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
    "maker": { "mode": "subagent"},
    "inspector": { "mode": "subagent"},
    "archivist": { "mode": "subagent" },
    "surveyor": { "mode": "subagent" },
    "build": { "disabled": true },
    "plan": { "disabled": true },
    "general": { "disabled": true },
    "explore": { "disabled": true }
  }`,
    cliEntries: "",
  },
  {
    id: "sidebar",
    title: "侧栏（含额度后台 quota-zh）",
    summary: "额度／会话概览／用户节点／子代理／技能卡片、宿主与共享会话统计（/quota 命令也在此组）",
    requiresPython: false,
    // 固定最低 OpenCode 版本：侧栏的额度后台（v6 RPC）与会话统计的 sessionUsage 读法
    // 从 2.0.26 起可用，本地核对到 2.0.28。声明的是“最低可用版本”，
    // 不是随包的 SDK 版本（具体版本以根 package-lock.json 为准）。
    minOpenCode: ">=2.0.26",
    plugins: [
      "opencode-quota-zh",
      "opencode-sidebar-host-zh",
      "opencode-session-data",
      "opencode-quota-card-zh",
      "opencode-session-overview-zh",
      "opencode-user-timeline-zh",
      "opencode-subagent-card-zh",
      "opencode-skill-panel",
      "opencode-enhanced-sidebar-zh",
    ],
    opencodeEntries: `    "./opencode-zh-bundle/plugins/opencode-quota-zh"`,
    opencodeExtras: "",
    cliEntries: `    "./opencode-zh-bundle/plugins/opencode-quota-zh",
    "./opencode-zh-bundle/plugins/opencode-session-data",
    {
      "package": "./opencode-zh-bundle/plugins/opencode-sidebar-host-zh",
      "options": {
        "sidebarCards": {
          "order": ["sessionOverview", "timeline", "quota", "subagents", "skill"],
          "hidden": []
        }
      }
    },
    "./opencode-zh-bundle/plugins/opencode-quota-card-zh",
    "./opencode-zh-bundle/plugins/opencode-session-overview-zh",
    { "package": "./opencode-zh-bundle/plugins/opencode-user-timeline-zh", "options": { "visibleRows": 8, "scroll": true } },
    {
      "package": "./opencode-zh-bundle/plugins/opencode-subagent-card-zh",
      "options": {
        "subagentsSortOrder": "desc",
        "subagentsMaxEntries": 10,
        "subagentsTtlDays": 3
      }
    },
    { "package": "./opencode-zh-bundle/plugins/opencode-skill-panel", "options": { "skillPanelMaxUsed": 8, "skillPanelDefaultOpen": true } }`,
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
  if (entries.length) out += `\n${entries.join(",\n")}\n`
  out += `  ]\n}\n`
  return out
}
