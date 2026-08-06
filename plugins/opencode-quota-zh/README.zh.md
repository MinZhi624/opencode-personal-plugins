# opencode-quota-zh

基于 `@slkiser/opencode-quota` 的中文 Fork。

- 保留原插件的额度 Provider、额度获取和 token 统计能力
- 使用卡片式额度侧边栏布局
- 侧边栏、TUI 弹窗和主要统计文案已中文化
- Provider 官方名称和命令 ID 保持不变

## 保留的命令

```text
/quota
/quota_status
/tokens_today
/tokens_weekly
/tokens_monthly
/tokens_all
/tokens_session
```

## 本地使用

Server 入口是 `dist/index.js`，TUI 入口是 `dist/tui.tsx`。全局 OpenCode 配置通过这两个入口加载本 Fork。

原始 Provider 和额度逻辑来自 `@slkiser/opencode-quota`，许可证仍为 MIT。
