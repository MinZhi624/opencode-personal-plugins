# 合并到已有 OpenCode 配置

安装器发现已有 `opencode.json(c)` 或 `tui.json(c)` 时默认不会覆盖。先备份现有文件，再把下面条目并入原数组。

> 不要在同一个 JSON 对象里创建第二个同名 `plugin` 键。应把条目追加到现有数组中。

## 1. Server 配置

编辑：

```text
~/.config/opencode/opencode.json
```

或当前使用的 `opencode.jsonc`。

把以下三个条目加入现有 `plugin` 数组：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    // 保留已有插件，例如通知器：
    "@mohak34/opencode-notifier@latest",

    // 本整合包：
    "./opencode-zh-bundle/plugins/opencode-quota-zh/dist/index.js",
    "./opencode-zh-bundle/plugins/gpt-reset-credits/index.ts",
    [
      "./opencode-zh-bundle/plugins/opencode-matt-workshop/dist/src/index.js",
      {
        "replace_builtin_agents": true,
        "max_parallel_makers": 3
      }
    ]
  ],

  // 原有 provider、model、mcp、permission 等配置继续保留。
  "provider": {}
}
```

说明：

- `gpt-reset-credits` 会自动注册 `/gpt-reset-credits`、两个工具及其权限规则，无需手工添加权限。
- Workshop 会注册智能体、命令和 skills 路径，并把默认智能体设为 `tinker`。
- 如果不希望禁用内置智能体，将 `replace_builtin_agents` 改为 `false`。
- 不要复制发布者的私有模型 ID；默认继承朋友当前选择的模型最稳妥。

## 2. TUI 配置

编辑：

```text
~/.config/opencode/tui.json
```

或当前使用的 `tui.jsonc`。

把以下两个条目加入现有 `plugin` 数组：

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    // 保留已有 TUI 插件和设置。
    "./opencode-zh-bundle/plugins/opencode-quota-zh/dist/tui.tsx",
    "./opencode-zh-bundle/plugins/opencode-enhanced-sidebar-zh/src/tui.tsx"
  ]
}
```

`opencode-quota-zh` 内部 sidebar order 为 40，增强侧边栏为 60，最终通常先显示额度，再显示上下文和子代理。

## 3. 删除旧的重复条目

如果设备之前安装过这些插件，请删除指向旧位置的重复条目，例如：

```text
./opencode-quota-zh/dist/index.js
./opencode-quota-zh/dist/tui.tsx
file:///某个用户目录/opencode-enhanced-sidebar-zh/src/tui.tsx
./opencode-matt-workshop/dist/src/index.js
./gpt-reset-credits/index.ts
```

每个入口只保留 bundle 路径的一份，否则可能出现命令重复、侧边栏重复或插件 ID 冲突。

## 4. 验证

保存后彻底退出 OpenCode，再执行：

```bash
opencode debug config
opencode debug agent tinker
opencode debug skill
```

如果 `opencode debug config` 报配置语法错误，先恢复备份，再检查：

- 数组元素之间是否有逗号；
- JSON 文件是否误用了注释（有注释请使用 `.jsonc`）；
- 是否创建了两个 `plugin` 键；
- 相对路径是否仍以 `./opencode-zh-bundle/` 开头。
