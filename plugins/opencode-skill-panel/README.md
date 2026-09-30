# opencode-skill-panel

侧栏"技能"面板：在 OpenCode V2 TUI 侧栏中，以可伸缩卡片
（与"额度/上下文"相同的 `▼/▶` 点击折叠交互）显示**当前会话已加载/调用的 skill**。

```
▼ 技能
▸ research
▸ learning ×2

▶ 技能（已加载 2）
```

## 功能

- **只显示已加载的 skill**：扫描本会话 assistant 消息中的 `skill` 工具调用，
  按最近使用排序，重复调用显示次数（`×N`）；不展示全量可用清单。
- **可伸缩**：点击标题行在 `▼`（展开）/ `▶`（折叠）间切换，折叠时标题旁显示
  `（已加载 N）` 计数。
- **实时刷新**：监听 `session.step.ended` / `session.execution.*` 事件自动更新，
  切换会话时自动重扫。
- **位置可配置**：以卡片 ID `skill` 注册到独立侧栏宿主，由宿主的
  `options.sidebarCards.order/hidden` 控制位置和显隐；不再直出 `sidebar.footer`。
  需要同时加载 `opencode-sidebar-host-zh`，宿主缺席时排队，不自绘重复侧栏。

## 配置

`~/.config/opencode/cli.json`：

```json
{
  "plugins": [
    {
      "package": "./opencode-zh-bundle/plugins/opencode-sidebar-host-zh",
      "options": { "sidebarCards": { "order": ["skill"], "hidden": [] } }
    },
    {
      "package": "./opencode-zh-bundle/plugins/opencode-skill-panel",
      "options": {
        "skillPanelMaxUsed": 8,
        "skillPanelDefaultOpen": true
      }
    }
  ]
}
```

| 选项 | 默认 | 说明 |
|---|---|---|
| `skillPanelMaxUsed` | `8` | 最多显示条数，超出显示 `…还有 N 个` |
| `skillPanelDefaultOpen` | `true` | 初始是否展开（点击标题随时切换） |

## 兼容性

- OpenCode V2（在 2.0.11 / 2.0.12 的消息分页与事件契约下编写，契约同
  `opencode-enhanced-sidebar-zh` 的 `v2-runtime.ts` 注释所述）。
- 纯 TUI 插件（仅 `tui.ts` 入口），由 `cli.json` 加载；依赖
  `@opentui/solid`、`solid-js`、`@opencode/plugin`（bundle 根 node_modules 提供）。

## 已知限制

- 识别两种加载形态：`skill` 工具调用（assistant `content[]` 里 `name: "skill"`）
  和 `@` 提及/自动注入（用户消息 `skills` 字段）。基于 OpenCode 2.0.18 真实
  API 响应验证。
- 消息扫描上限 10 页 × 200 条（超长会话只扫最近部分）。
