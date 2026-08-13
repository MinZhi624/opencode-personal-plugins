# 合并到已有 OpenCode 配置

安装器发现已有 `opencode.json(c)` 或 `tui.json(c)` 时不会覆盖。先备份现有文件，再把条目并入原数组。不要创建第二个同名 `plugin` 键。

## Server 配置

在当前使用的 `~/.config/opencode/opencode.jsonc`（或 `.json`）中保留已有 notifier、provider、experimental、MCP 等设置，并把以下三项放入现有 `plugin` 数组：

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

每个角色只支持 `model`、`variant`、`temperature`、`steps`。不配置时继承当前 OpenCode 模型。

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
