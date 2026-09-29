# 独立侧栏宿主

OpenCode V2 TUI 插件，仅负责 `sidebar.content` 追加、注册、排序和显隐，不读取会话统计或 Provider 凭据。跨插件 JSX 注册是针对 OpenCode 2.0.18 验证的自有同进程接合处，并非官方跨插件 UI API；升级须复验。

第三方卡片在自己的 TUI 插件 `setup` 中导入 `opencode-sidebar-host-zh/card`（本地发行包可按相对路径导入 `../opencode-sidebar-host-zh/src/register-card.ts`），调用：

```ts
const registration = registerSidebarCard({
  id: "vendor.example", owner: "vendor-example-plugin", title: "示例",
  requiredSeam: 1,
  render: ({ sessionID }) => /* 卡片自身的 Solid JSX */ null,
})
return () => registration.dispose()
```

`render` 由卡片拥有，宿主只传 `sessionID`。缺少宿主时排队而不另行插槽；卸载卡片时 `dispose()` 撤回排队并撤销按所有者注册的记录。相同 ID 的不同 owner 和不兼容版本确定性拒绝，卡片渲染错误单卡隔离。`/sidebar-cards` 提供排序／显隐菜单，`/sidebar-host-status` 显示脱敏诊断。

首次迁移尝试读取旧 `sidebar-cards-zh-v1` 顺序／显隐；若 OpenCode 将不同插件的 CLI 存储隔离，可通过宿主插件选项 `legacySettings: {version: 1, order: ["quota", "sessionOverview", "subagents", "skill"], hidden: []}` 显式提供旧设置。不要把读不到旧存档视为已迁移；安装版须验收。回退时只保留旧聚合入口，不同时加载新卡片。
