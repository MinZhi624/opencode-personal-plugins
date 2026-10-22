# 用户节点（opencode-user-timeline-zh）

OpenCode 2 TUI 侧栏卡片：列出当前会话的用户消息节点，支持滚轮浏览与点击跳转。
本插件基于 [`opencode-user-timeline`](https://github.com/huahai0202/opencode-user-timeline)
（MIT，commit `f1364dd`）移植，接入本套侧栏宿主。

## 行为

- 注册为宿主卡片 `timeline`，位置由 `cli.json` 的 `options.sidebarCards.order` 决定。
- 默认显示 **8 行**；在 `/sidebar-cards` 的「用户节点」页可改为 6 / 8 / 10 / 12 / 15 行，
  也可关闭滚轮浏览、退回只显示最新若干条。
- 标题行 `▼ 用户节点 (n)` 点击折叠/展开；折叠状态由插件自己的 storage 保存。
- 跨天会话显示日期标题，单日会话不额外占行；时间格式为 `HH:MM`。
- 最新节点用绿色 `●` 标记；选中的节点用主题强调色 `●` 标记。
- 点击节点复用宿主导航命令定位；目标尚未加载时先显示全屏遮罩，加载完成后再落位。
- 配色默认跟随主题；可在 `/sidebar-cards` 的颜色页对 `timeline` 做单卡覆盖。

## 显隐

本插件不再注册 `Alt+U` / `/nodes`，也不维护自己的显隐状态。使用：

- `/sidebar-cards`：统一管理排列与显隐；
- `/sidebar-host-show timeline`、`/sidebar-host-hide timeline`：直接命令。

## 配置

```json
{
  "package": "./opencode-zh-bundle/plugins/opencode-user-timeline-zh",
  "options": { "visibleRows": 8, "scroll": true }
}
```

`visibleRows` 合法范围为 3–20；`scroll: false` 时只显示最新若干条。保存入口在
`/sidebar-cards`，插件会保留 `cli.json` 中的其他插件条目、选项与注释。

## 已知限制

- 跳转依赖宿主运行时的分页与导航命令（`loadMore`、`session.messages_last_user`、
  `session.message.user.previous`）。这些不是公开跨插件 API；宿主升级后需重新验收。
- 超长会话首次打开会分页拉取完整历史；20 秒低频轮询只用于最终一致性兜底。
- 纯附件消息没有可定位文本，宿主会落在其上一条可定位消息。
