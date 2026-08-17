# 合并到已有 OpenCode 配置

安装器发现已有 `opencode.json(c)` 或 `tui.json(c)` 时不会覆盖。先备份现有文件，再把条目并入原数组。不要创建第二个同名 `plugin` 键。

## Server 配置

在当前使用的 `~/.config/opencode/opencode.jsonc`（或 `.json`）中保留已有 notifier、provider、MCP 等设置，并把以下三项放入现有 `plugin` 数组（`experimental` 下除 `quotaToast` 外的其他键可保留；`experimental.quotaToast` 已在 v2 移除，见下方迁移说明）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "./opencode-zh-bundle/plugins/opencode-quota-zh/dist/index.js",
    "./opencode-zh-bundle/plugins/gpt-reset-credits/index.ts",
    "./opencode-zh-bundle/plugins/opencode-matt-workshop/dist/src/index.js"
  ]
}
```

### 额度插件主配置（opencode-quota-zh/config.jsonc）

v2 起，`opencode-quota-zh` 的主配置统一放在独立侧车文件 `opencode-quota-zh/config.jsonc`（与 `plugin` 数组并列，不需要放进 `opencode.jsonc`）：

- 全局：`~/.config/opencode/opencode-quota-zh/config.jsonc`
- 工作区：项目根的 `opencode-quota-zh/config.jsonc`（相同相对路径，覆盖全局）
- JSONC 优先；`config.json` 仍被接受，但两者并存时只读取 JSONC，建议删除旧的 `config.json`。

旧配置入口 `experimental.quotaToast` 与 `opencode-quota/quota-toast.json(c)` 不再作为配置来源，插件会明确报告迁移要求（见 `/quota_status` 与启动日志）。手工迁移时把仍需要的设置复制到新侧车文件：

- 删除旧字段 `enableToast`、`showOnIdle`、`showOnQuestion`、`showOnCompact`、`showOnBothFail`（v2 已移除，不再有任何效果）。
- 其余键名（`enabledProviders`、`formatStyle`、`tuiCommandDisplay`、`tuiSidebarPanel` 等）不变，直接复制。
- 例行额度弹窗已由「启动提示 + 额度告警」取代，新接口：

```jsonc
{
  "startupHint": {
    "enabled": true
  },
  "promptBar": {
    "enabled": false
  },
  "alerts": {
    "enabled": true,
    "percentRemainingThreshold": 0,
    "repeatAfterMinutes": null,
    "balanceThresholds": {
      "deepseek": {
        "CNY": 2,
        "USD": 0.5
      }
    }
  }
}
```

`percentRemainingThreshold` 与货币余额阈值均按「当前值 ≤ 阈值」触发；`repeatAfterMinutes: null` 表示每告警周期只提醒一次，非空值必须是至少 15 的整数分钟。`promptBar` 默认关闭，迁移时不要自动开启。初始化安装器会在新侧车文件不存在时自动从旧 `experimental.quotaToast` 播种，手工合并时才需要上述步骤。

Workshop 会保留 OpenCode 内置和已有 agents，新增七个 Workshop agents，并把 `tinker` 设为默认 Primary Agent。

可选角色覆盖使用 OpenCode 支持的 `[pluginPath, options]`：

```jsonc
[
  "./opencode-zh-bundle/plugins/opencode-matt-workshop/dist/src/index.js",
  {
    "agents": {
      "drafter": { "model": "openai/gpt-5.6-sol", "variant": "high" },
      "maker": { "model": "opencode-go/deepseek-v4-flash", "variant": "max", "steps": 40 }
    }
  }
]
```

每个角色只支持 `model`、`variant`、`temperature`、`steps`。不配置时继承当前 OpenCode 模型。完整推荐阵容见 `config/opencode.jsonc` 模板与 workshop README；`opencode-go/mimo-v2.5` 无 variant 档，配置时省略 `variant` 字段。

如果旧配置包含 `oh-my-openagent` 或 `oh-my-openagent@latest`，移除该条目；不要删除 notifier、quota、reset-card 或其它无关插件。

## TUI 配置

在当前 `~/.config/opencode/tui.jsonc` 中保留已有设置并加入：

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "./opencode-zh-bundle/plugins/opencode-quota-zh/dist/tui.tsx",
    "./opencode-zh-bundle/plugins/opencode-enhanced-sidebar-zh/src/tui.tsx"
  ]
}
```

删除 TUI 配置中的旧 `oh-my-openagent` 条目。若 `.jsonc` 和 `.json` 同时存在，OpenCode 优先读取 `.jsonc`；合并后只保留一个有效配置，避免重复插件。

## 删除旧路径

每个入口只保留 bundle 路径的一份。删除指向旧独立目录或旧绝对路径的 quota、sidebar、Workshop、reset-card 重复条目。

## 验证与重启

保存后必须彻底退出并重新启动 OpenCode，再执行：

```bash
opencode debug config
opencode debug agent tinker
opencode debug skill
```

不要分享未经检查的 `opencode debug config` 输出；其中可能包含私有 provider 配置。
