# opencode-quota-zh

基于 [`@slkiser/opencode-quota`](https://github.com/slkiser/opencode-quota) 的中文 Fork，负责额度查询、历史 Token 统计和 API 标价估算。

- 保留原插件的额度 Provider、额度获取和 token 统计能力
- 使用卡片式额度侧边栏布局
- 侧边栏、TUI 弹窗和主要统计文案已中文化
- Provider 官方名称和命令 ID 保持不变
- 模型价格从 `https://models.dev/api.json` 获取，运行时保留所有有数字价格的 provider/model
- quota 与增强侧边栏共享 `~/.cache/opencode/opencode-quota-zh/` 价格快照
- 例行额度 toast 能力保留但默认关闭；重置通知同样默认关闭

## 保留的命令

```text
/quota
/quota_status
/quota_announcements
/pricing_refresh
/tokens_today
/tokens_daily
/tokens_weekly
/tokens_monthly
/tokens_all
/tokens_session
/tokens_session_all
/tokens_between
```

`/pricing_refresh` 强制刷新模型价格。刷新失败时继续使用内置快照；可在
`/quota_status` 查看价格快照来源、时间、覆盖数量和未定价模型。

## Token 与费用口径

- 历史 Token 从 OpenCode SQLite 的 assistant message 读取，保留 input、output、reasoning、cache read 和 cache write。
- 费用是 API 标价估算，不是 Provider 实际账单，也不等于 ChatGPT 订阅额度。
- 每条消息按实际 `providerID/modelID` 计算；同一会话使用多个模型会分别计算后求和。
- 当前价格快照变化后，历史费用会重新计算。
- 没有价格的模型保留 Token，并标记为“未定价”，不会伪装成 `$0.00`。

## 数据与兼容

- OpenCode 数据库只读，不会写回或修改会话。
- 默认数据库为 `${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db`；自定义数据库路径需确保 OpenCode 与外部工具看到同一环境变量。
- `message.cost` 不是主要估算来源。OpenCode OAuth 场景的原生零费用不代表免费。
- 价格缓存只保留模型 ID 和价格字段，不保存消息正文或认证凭证。

## 本地使用

Server 入口是 `dist/index.js`，OpenCode v2 CLI 入口是 `dist/tui-v2.tsx`。分别由 `opencode.json(c)` 与 `cli.json` 加载。

主配置位于 `opencode-quota-zh/config.jsonc`。中文版默认 `enableToast: false`、
`resetNotifications.enabled: false`；独立危险阈值告警及 `/quota_alerts` 不再提供。

原始 Provider 和额度逻辑来自 `@slkiser/opencode-quota`，许可证仍为 MIT。

## 相关文档

- [OpenAI/ChatGPT 订阅 Token 记账说明](../../docs/openai-subscription-token-accounting.md)
- [整合包主 README](../../README.md)
