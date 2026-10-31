// 选择性安装：组与侧栏卡片清单的单一事实来源。
// 组定义、卡片定义、插件清单、配置片段与依赖规则都只在此文件维护；
// config/opencode.jsonc 与 config/cli.json 是全选组合的生成结果（参考样例），
// 修改片段后用 `node scripts/install-main.mjs --all --render config` 重新生成并核对。

/** SSH 组要并入同一个 `agents` 对象的七条声明（JSON 不能有两个 `agents` 键）。 */
const SSH_AGENT_DECLARATIONS = `    "ssh-drafter": { "mode": "primary" },
    "ssh-tinker": { "mode": "primary" },
    "ssh-foreman": { "mode": "primary" },
    "ssh-maker": { "mode": "subagent"},
    "ssh-inspector": { "mode": "subagent"},
    "ssh-archivist": { "mode": "subagent"},
    "ssh-surveyor": { "mode": "subagent" }`

/** workshop 组的附加键；选中 SSH 时把七条声明并入同一个 agents 对象。 */
function workshopExtras(sshDeclarations = "") {
  return `  "default_agent": "tinker",
  "agents": {
    "drafter": { "mode": "primary" },
    "tinker": { "mode": "primary" },
    "foreman": { "mode": "primary" },
    "maker": { "mode": "subagent"},
    "inspector": { "mode": "subagent"},
    "archivist": { "mode": "subagent" },
    "surveyor": { "mode": "subagent" }${sshDeclarations ? `,\n${sshDeclarations}` : ""},
    "build": { "disabled": true },
    "plan": { "disabled": true },
    "general": { "disabled": true },
    "explore": { "disabled": true }
  }`
}

// 侧栏基础：选中 sidebar 组时始终安装。额度后台与会话统计由所有卡片共用，
// 放在基础里，避免每张卡重复声明，也让 /quota 在只装基础时仍可用。
export const SIDEBAR_BASE_PLUGINS = ["opencode-quota-zh", "opencode-session-data", "opencode-sidebar-host-zh"]

// 卡片顺序即宿主 sidebarCards.order 的默认顺序。
// dependsOn 只写基础之外的额外插件，选中卡片时由 resolveSelection 自动并入。
export const SIDEBAR_CARDS = [
  {
    id: "sessionOverview",
    title: "上下文概览",
    summary: "上下文占用、缓存命中、TPS 与本会话／子代理花费",
    plugin: "opencode-session-overview-zh",
    dependsOn: ["opencode-enhanced-sidebar-zh"],
    cliEntry: `    "./opencode-zh-bundle/plugins/opencode-session-overview-zh"`,
  },
  {
    id: "timeline",
    title: "用户节点时间线",
    summary: "用户消息节点，滚轮浏览、点击定位",
    plugin: "opencode-user-timeline-zh",
    dependsOn: [],
    cliEntry: `    { "package": "./opencode-zh-bundle/plugins/opencode-user-timeline-zh", "options": { "visibleRows": 8, "scroll": true } }`,
  },
  {
    id: "quota",
    title: "额度卡片",
    summary: "Provider 额度、重置与刷新状态",
    plugin: "opencode-quota-card-zh",
    dependsOn: [],
    cliEntry: `    "./opencode-zh-bundle/plugins/opencode-quota-card-zh"`,
  },
  {
    id: "subagents",
    title: "子代理卡片",
    summary: "子代理排序、条数、Token 与花费",
    plugin: "opencode-subagent-card-zh",
    dependsOn: ["opencode-enhanced-sidebar-zh"],
    cliEntry: `    {
      "package": "./opencode-zh-bundle/plugins/opencode-subagent-card-zh",
      "options": {
        "subagentsSortOrder": "desc",
        "subagentsMaxEntries": 10,
        "subagentsTtlDays": 3
      }
    }`,
  },
  {
    id: "skill",
    title: "技能面板",
    summary: "已加载技能与调用次数",
    plugin: "opencode-skill-panel",
    dependsOn: [],
    cliEntry: `    { "package": "./opencode-zh-bundle/plugins/opencode-skill-panel", "options": { "skillPanelMaxUsed": 8, "skillPanelDefaultOpen": true } }`,
  },
]

export const SIDEBAR_CARD_IDS = SIDEBAR_CARDS.map((card) => card.id)

// 只被卡片拉入的依赖插件；cli/opencode 条目为空表示该插件没有对应条目。
const DEPENDENCY_ENTRIES = {
  "opencode-quota-zh": {
    opencode: `    "./opencode-zh-bundle/plugins/opencode-quota-zh"`,
    cli: `    "./opencode-zh-bundle/plugins/opencode-quota-zh"`,
  },
  "opencode-session-data": {
    opencode: "",
    cli: `    "./opencode-zh-bundle/plugins/opencode-session-data"`,
  },
  "opencode-enhanced-sidebar-zh": { opencode: "", cli: "" },
}

// 固定顺序用于复制与展示，保证同一选择得到稳定输出。
const PLUGIN_ORDER = [
  "opencode-quota-zh",
  "opencode-session-data",
  "opencode-sidebar-host-zh",
  "opencode-quota-card-zh",
  "opencode-session-overview-zh",
  "opencode-user-timeline-zh",
  "opencode-subagent-card-zh",
  "opencode-skill-panel",
  "opencode-enhanced-sidebar-zh",
  "opencode-matt-workshop",
  "opencode-ssh-workshop",
  "gpt-reset-credits",
]

// cli.json 的卡片条目顺序沿用参考样例，与 sidebarCards.order 解耦。
const SIDEBAR_CLI_ENTRY_ORDER = ["quota", "sessionOverview", "timeline", "subagents", "skill"]

// 配置生成顺序固定，保证全选组合与参考样例逐字节一致。
const OPENCODE_ENTRY_ORDER = ["sidebar", "alone", "workshop", "ssh"]
const OPENCODE_EXTRAS_ORDER = ["workshop", "alone"]

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
    opencodeExtras: workshopExtras(""),
    cliEntries: "",
  },
  {
    id: "sidebar",
    title: "侧栏（可细选卡片）",
    summary: "展开后勾选五张卡片；勾选任一张会自动带上宿主、额度后台与共享会话统计",
    requiresPython: false,
    // 固定最低 OpenCode 版本：侧栏的额度后台（v6 RPC）与会话统计的 sessionUsage 读法
    // 从 2.0.26 起可用，本地核对到 2.0.28。声明的是“最低可用版本”，
    // 不是随包的 SDK 版本（具体版本以根 package-lock.json 为准）。
    minOpenCode: ">=2.0.26",
    opencodeEntries: "",
    opencodeExtras: "",
    cliEntries: "",
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
  {
    id: "ssh",
    title: "SSH 远程（opencode-ssh-workshop）",
    summary: "七个 SSH 角色、设备档案与 /ssh-devices 界面；依赖 Workshop 组",
    requiresPython: false,
    minOpenCode: ">=2.0.31",
    dependsOn: ["workshop"],
    plugins: ["opencode-ssh-workshop"],
    opencodeEntries: `    "./opencode-zh-bundle/plugins/opencode-ssh-workshop"`,
    opencodeExtras: "",
    cliEntries: `    "./opencode-zh-bundle/plugins/opencode-ssh-workshop"`,
    configNotes: [
      "opencode.jsonc：plugins 中的 opencode-ssh-workshop 条目（Server 入口）",
      "opencode.jsonc：agents 块中的 ssh-drafter / ssh-tinker / ssh-foreman / ssh-maker / ssh-inspector / ssh-archivist / ssh-surveyor 七条",
      "cli.json：opencode-ssh-workshop 条目（TUI /ssh-devices 入口）",
    ],
  },
]

export const GROUP_IDS = GROUPS.map((group) => group.id)

export function groupById(id) {
  return GROUPS.find((group) => group.id === id)
}

/** 组依赖校验；SSH 的七个角色声明必须并入 workshop 的 agents 对象。 */
export function validateGroupDependencies(ids) {
  const selected = new Set(ids)
  for (const group of GROUPS) {
    if (!selected.has(group.id)) continue
    for (const dependency of group.dependsOn ?? []) {
      if (!selected.has(dependency)) {
        throw new Error(`组件组 ${group.id} 依赖 ${dependency}，请一并选择。`)
      }
    }
  }
  return ids
}

export function cardById(id) {
  return SIDEBAR_CARDS.find((card) => card.id === id)
}

function renderHostEntry(cardIds) {
  const order = SIDEBAR_CARDS.filter((card) => cardIds.includes(card.id)).map((card) => `"${card.id}"`)
  return `    {
      "package": "./opencode-zh-bundle/plugins/opencode-sidebar-host-zh",
      "options": {
        "sidebarCards": {
          "order": ${order.length ? `[${order.join(", ")}]` : "[]"},
          "hidden": []
        }
      }
    }`
}

/**
 * 把组与卡片选择展开成可安装的插件集合、配置条目和版本要求。
 * sidebar 未选中时 cards 一律忽略；卡片依赖自动并入，不要求调用方重复声明。
 */
export function resolveSelection({ groups, cards = [] }) {
  const groupSet = new Set(GROUPS.map((group) => group.id).filter((id) => groups.includes(id)))
  const selectedCards = groupSet.has("sidebar") ? SIDEBAR_CARD_IDS.filter((id) => cards.includes(id)) : []
  const plugins = new Set()

  for (const id of groupSet) {
    if (id === "sidebar") continue
    for (const plugin of groupById(id).plugins) plugins.add(plugin)
  }
  if (groupSet.has("sidebar")) {
    for (const plugin of SIDEBAR_BASE_PLUGINS) plugins.add(plugin)
    for (const id of selectedCards) {
      const card = cardById(id)
      plugins.add(card.plugin)
      for (const plugin of card.dependsOn) plugins.add(plugin)
    }
  }
  const orderedPlugins = [
    ...PLUGIN_ORDER.filter((plugin) => plugins.has(plugin)),
    ...[...plugins].filter((plugin) => !PLUGIN_ORDER.includes(plugin)),
  ]

  const opencodeEntries = []
  for (const id of OPENCODE_ENTRY_ORDER) {
    if (!groupSet.has(id)) continue
    if (id === "sidebar") {
      for (const plugin of orderedPlugins) {
        const entry = DEPENDENCY_ENTRIES[plugin]?.opencode
        if (entry) opencodeEntries.push(entry)
      }
    } else {
      opencodeEntries.push(groupById(id).opencodeEntries)
    }
  }

  const cliEntries = []
  if (groupSet.has("sidebar")) {
    for (const plugin of ["opencode-quota-zh", "opencode-session-data"]) {
      if (plugins.has(plugin)) cliEntries.push(DEPENDENCY_ENTRIES[plugin].cli)
    }
    cliEntries.push(renderHostEntry(selectedCards))
    for (const id of SIDEBAR_CLI_ENTRY_ORDER) {
      if (selectedCards.includes(id)) cliEntries.push(cardById(id).cliEntry)
    }
  }
  for (const group of GROUPS) {
    if (group.id !== "sidebar" && groupSet.has(group.id) && group.cliEntries) cliEntries.push(group.cliEntries)
  }

  const extras = []
  if (groupSet.has("workshop")) {
    extras.push(workshopExtras(groupSet.has("ssh") ? SSH_AGENT_DECLARATIONS : ""))
  }
  if (groupSet.has("alone")) extras.push(groupById("alone").opencodeExtras)

  return {
    groups: GROUPS.map((group) => group.id).filter((id) => groupSet.has(id)),
    cards: selectedCards,
    plugins: orderedPlugins,
    opencodeEntries,
    opencodeExtras: extras,
    cliEntries,
    requiresPython: GROUPS.some((group) => groupSet.has(group.id) && group.requiresPython),
    minOpenCode: GROUPS.filter((group) => groupSet.has(group.id) && group.minOpenCode).map((group) => ({
      group: group.id,
      version: group.minOpenCode,
    })),
  }
}

export function renderOpencode(selection) {
  const { opencodeEntries, opencodeExtras } = resolveSelection(selection)
  const body = opencodeEntries.length ? `\n${opencodeEntries.join(",\n")}\n  ` : ""
  let out = `{\n  "$schema": "https://opencode.ai/config.json",\n  "plugins": [${body}]`
  for (const extra of opencodeExtras) out += `,\n${extra}`
  return `${out}\n}\n`
}

export function renderCli(selection) {
  const { cliEntries } = resolveSelection(selection)
  let out = `{\n  "$schema": "https://opencode.ai/v2/cli.json",\n  "plugins": [`
  if (cliEntries.length) out += `\n${cliEntries.join(",\n")}\n`
  out += `  ]\n}\n`
  return out
}
