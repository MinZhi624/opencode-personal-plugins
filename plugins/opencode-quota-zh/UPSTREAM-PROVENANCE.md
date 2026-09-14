# Upstream Provenance: opencode-quota current core

`opencode-quota-zh` 的核心源码同步自
[`slkiser/opencode-quota`](https://github.com/slkiser/opencode-quota)：

- 上游版本：`4.9.0`
- 固定提交：`fa9e66b53f8a5de1e0dc4c2ef623c83bef38c8b7`
- `git describe`：`v4.9.0-34-gfa9e66b`
- 同步日期：2026-09-14

## 边界

上游负责 Provider、认证、structured accounting、projection、缓存、state codec 与 runtime。
本地仅维护中文展示、卡片式侧边栏、启动提示、历史会话 Token 用量与 API 标价估算，以及
bundle 的构建、安装和 `opencode-quota-zh` 配置命名空间。

例行额度 toast 能力跟随上游保留，但中文版默认 `enableToast: false`；
`resetNotifications` 保留且默认关闭。独立的 `/quota_alerts`、`alerts.*`、
Quota Alert Episode 与危险阈值通知已经删除。

## 分发与验证

本仓库不引入上游 pnpm、测试、CI、发布、npm 自更新或 reference 工作流。`dist/` 由
`npm run build:quota-zh:runtime` 从 `src/` 生成，再由根级 `npm run stage:runtime` 纳入 bundle。
项目继续按维护决定由用户重启 OpenCode 后人工验证，不新增 smoke 或自动测试。
