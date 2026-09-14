# ADR 0003：采用当前上游额度核心与中文薄适配层

## 状态

已接受；取代 ADR 0001 中“删除上游例行 toast 能力并新增独立危险告警体系”的决定。

## 决策

- Provider、认证、structured accounting、projection、缓存、state codec 与 runtime 跟随固定的上游源码核心。
- 中文版只维护中文展示、卡片式侧边栏、启动提示、历史会话 Token 用量与 API 标价估算，以及 bundle 安装边界。
- 保留上游例行额度 toast 能力，但中文版默认 `enableToast: false`，由用户显式开启。
- 保留上游重置通知，默认 `resetNotifications.enabled: false`。
- 删除 `/quota_alerts`、`alerts.*`、Quota Alert Episode、危险阈值通知及其状态文件。
- OpenCode Go 只使用当前上游认证和 API 获取方式，不恢复 HTML/cookie 抓取。
- 配置和私有状态使用 `opencode-quota-zh` 命名空间；官方原版与中文版不支持同时启用。
- 不采用上游 npm 自更新、pnpm、测试、CI 或 reference 工作流；继续由 bundle 安装器分发。

## 后果

核心行为可按单个固定提交追踪上游，本地长期分叉缩小。中文显示和 API 标价估算仍是明确的
本地适配 seam；API 标价估算不是实际账单，无法定价时必须显示“未定价”，不得显示 `$0`。
