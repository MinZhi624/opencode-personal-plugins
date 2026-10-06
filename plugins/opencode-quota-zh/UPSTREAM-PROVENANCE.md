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

## 本地补丁：OpenAI 凭据来源与令牌能力（2026-10-06）

上游核心的 Provider、额度计算、缓存与估算逻辑未改。以下差异仅限**凭据来源、令牌能力判断与错误呈现**，
同步上游时需保留；适用环境为 OpenCode v2.0.24，上游基线同上（`fa9e66b`）。

**原因**：OpenCode V2 的 `chatgpt-token-sharing` 登录（Sign in with ChatGPT）签发的访问令牌只授权模型调用
（scope 含 `chatgpt.tokens.use.direct`，audience 为 `api.openai.com`），对 ChatGPT 用量接口
（`chatgpt.com/backend-api/wham/usage`）返回 401 `rejected_by_access_enforcement`。宿主凭据优先的既有接法
会让额度查询一直命中这类令牌、永远 401；而真正能读额度的 Codex 登录令牌存放在 Codex CLI 的登录文件里，
上游与本 fork 都不读取该文件。

**改动模块**：

| 模块 | 改动 | 说明 |
| --- | --- | --- |
| Codex 凭据源读取器 | 新增 | 只读 Codex CLI 登录文件（`tokens.{access_token, refresh_token, account_id}` 形状），映射为统一已解析凭据结构；文件缺失或形状不符返回"无凭据"，不抛错 |
| OpenAI 凭据解析 / 额度查询 | 修改 | 新增令牌能力识别与候选凭据参数；非 2xx 返回 HTTP 状态＋脱敏原因 |
| OpenAI Provider 包装层 | 修改 | 实现候选链与降级：宿主连接 → OpenCode auth.json → Codex 登录；逐候选记录 trace，失败分类出中文单行文案 |
| 宿主凭据解析（插件入口） | 修改 | 解析失败不再静默吞掉，转为可见失败态（单行脱敏原因），进入诊断字段 |
| 错误脱敏工具 | 新增 | 单行、JWT 形态与长串令牌替换为 `[redacted]`、长度受限（对齐上游 `scrubCredentialErrorText` 语义） |

**令牌能力判据**（易错点，务必随上游同步保留）：

- JWT `scope` 声明含 `chatgpt.tokens.use.direct` → 判为"仅模型调用"令牌，额度查询跳过该候选，不发请求。
- `scope` 兼容**字符串**与**字符串数组**两种形态，按包含判定。
- **无 `scope` 声明的令牌判为可用**——Codex 登录令牌就没有 `scope`（仅 aud/profile/auth），却是唯一能读额度的凭据。
  若因"缺少 scope"而跳过，会误伤唯一可用候选。

**语义保持**：宿主凭据不做本地过期拒绝（宿主拥有刷新职责）；旧 auth.json 候选保留本地过期拒绝并报"令牌已过期"。
凭据只在服务端读取，令牌不进入 TUI、RPC 输出、日志与配置。

**已知行为变化**：Provider 列表里有 openai 但无任何 OAuth/Codex 登录的用户，以前静默无输出，现在显示一条
中文错误行（"无任何可用凭据"）；纯 API-key 用户不受影响（可用性判断仍为不可用，不触发查询）。

**验证方式**：无自动化测试（沿用维护决定）。以额度 RPC `snapshot` 的真实返回做安装验收（实测 OpenAI (Plus)
5h 62%、Weekly 54%，无错误）；结果缓存 TTL 为 300 秒且为磁盘持久化，重启服务不清缓存。
