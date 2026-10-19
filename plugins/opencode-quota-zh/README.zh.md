# opencode-quota-zh

基于 [`@slkiser/opencode-quota`](https://github.com/slkiser/opencode-quota) **v6** 的中文 Fork，负责额度查询、历史 Token 统计和 API 标价估算。后端固定在上游 `v6.0.0-beta.1`（提交 `358f58c3ffa3c9cf8efa6374ca37f7f8d298346a`）；Provider、认证、多账号、缓存、设置、命令与报表均来自上游 v6，本地只做中文展示与侧栏接合。

- 额度后端基于上游 v6/auth；本地恢复 Codex CLI 登录文件只读兼容，结果单独标为「Codex CLI 登录」，不冒充宿主当前账号。旧 OpenCode `auth.json` 候选链未恢复。
- 侧栏保留卡片式额度布局：可折叠标题、Provider／账号分组、多行结构、20 格剩余额度条、「已用 / 剩余」双百分比、中文重置倒计时＋括号内绝对重置时间
- 侧栏、详细控制台页面、提示与错误已中文化；Provider 官方名称、模型 ID 与命令 ID 保持不变
- 模型价格由额度服务端统一选择与刷新；侧栏统计经客户端 RPC 镜像同一份价格快照，价格变化以 `pricingChanged` 事件唤醒，不在客户端自行下载
- 例行额度 toast 默认关闭；其余通知、重试与状态行默认值遵循上游（重置通知默认关、等待额度重置重试默认开、状态行默认开）

## 运行环境

- OpenCode：`2.0.26+`（上游 v6 tag 声明的最低版本）；随包 SDK 与 OpenTUI 的确切版本以根 `package-lock.json` 为准，最低版本声明不等于已完成运行验收
- Node.js：`>=26.4.0`（开发、构建及 npm 安装环境；与 OpenTUI core 的 Node engine 要求一致）
- OpenCode 宿主运行时需另外满足所加载依赖的运行要求；安装阶段满足 engines、peer 不等于真实 TUI 行为已经验收

> [!IMPORTANT]
> 运行验收尚未完成。以上为源码与构建层面的口径，尚未经过真实 OpenCode 会话的人工验收，不得视为通过；构建与类型检查只属于交付准备，不等于运行验收。

## 命令

详细查看通过 v6 的统一窗口：在 TUI 输入斜杠命令或按 **Ctrl+P** 选择，打开用量／额度／插件／设置页面。不注册第二套上游原生额度侧栏。

```text
/quota            # 额度视图
/quota_usage      # 用量视图；可带范围 today | 24h | 7d | 30d | 90d | all | session | between YYYY-MM-DD YYYY-MM-DD
/quota_status     # 诊断：Provider、认证、价格快照来源与未定价模型、维护公告
/quota_settings   # 设置页：进度条样式、参考线、倒计时格式、额度行名称／显隐／顺序、Provider 顺序等
```

- 旧的 `/tokens_*` 命令作为上游遗留别名保留：`/tokens_today`、`/tokens_daily`、`/tokens_weekly`、`/tokens_monthly`、`/tokens_all`、`/tokens_session`、`/tokens_session_all`、`/tokens_between`，分别映射到 `/quota_usage` 的对应范围；默认不列出，需在 `/quota_status` 中开启旧命令名。
- 价格刷新入口已并入**用量页**；维护公告并入**插件页**。不再单独提供 `/pricing_refresh` 与 `/quota_announcements`，旧的 `/quota_alerts` 独立危险阈值告警也不再提供。

## 侧栏展示与设置联动

- 侧栏只注册本地额度卡片，不显示第二套上游原生额度侧栏；详细用量统一到 v6 的 window／status／toast。
- 进度条样式、均匀使用参考线、倒计时格式、额度行名称／显隐／顺序及 Provider 顺序跟随 v6 设置联动；切换倒计时格式不顺带移除本地绝对重置时间。
- 本地卡片的「已用 / 剩余」双百分比是明确保留的展示例外，不因上游单百分比文案而被替换；上游原生窗口自身仍遵循其文案设置。
- 折叠窗口在本地概述中选取首个窗口。
- 设置支持草稿预览、保存与放弃；整张卡片之间的排序／显隐由侧栏宿主负责，不被额度内部设置覆盖。
- 参考线使用 v6 的窗口与节奏信息，缺少必要信息时不画伪参考线；默认开启与否遵循上游默认值。

## Token 与费用口径

- 历史 Token 从 OpenCode SQLite 的 assistant message 读取，保留 input、output、reasoning、cache read 和 cache write。
- 统计与 v6 报表为同一服务端实现，包含 fork 去重、compaction 与所有后代会话；保留「本会话自身／子代理／任务树合计（root）」三种范围，分别对应正确的作用域。
- 只有在同一逻辑会话树、同一日期范围／时区、同一价格快照与同一数据时点下，侧栏与 v6 报表才能直接核对；仅显示舍入或明确不同的展示分类可以有表达差异。
- 费用是 API 标价估算，不是 Provider 实际账单，也不等于 ChatGPT 订阅额度；OpenCode OAuth 场景的原生零费用不代表免费。
- 每条消息按实际 `providerID/modelID` 计算；同一会话使用多个模型会分别计算后求和。价格快照变化后，历史费用重新计算。
- 没有价格的模型保留 Token，并标记为“未定价”，不会伪装成 `$0.00`。
- 服务端保留约 30 秒原生缓存；查询失败不会被显示为 0% 或免费；保留旧数据时可识别刷新失败与上次成功时间，不把旧额度当成刚查询的结果。

## 数据与配置

- OpenCode 数据库只读，不会写回或修改会话。默认数据库为 `${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db`。
- 配置权威为 `~/.config/opencode/opencode-quota/settings.jsonc`（遵循 XDG，可被 `XDG_CONFIG_HOME` 改变）。
- 旧 `opencode-quota-zh/config.jsonc`、`config.json` 由迁移逻辑追加进入 v6 转换器：同 root 下中文优先、否则走上游 v5 路径；无目标才写入，不覆盖已有新文件，旧文件保留。
- v6 原生不支持 project 级设置；旧 project 文件仅在 `/quota_status` 给出诊断提示，需手工合并，不会偷偷写入全局配置。
- 价格缓存只保留模型 ID 和价格字段，不保存消息正文或认证凭证；凭据留在服务端，不进入 TUI、公开 RPC、配置示例或诊断输出。

## 本地使用

Server 入口是 `dist/index.js`，OpenCode v2 CLI 入口是 `dist/tui-v2.tsx`，分别由 `opencode.json(c)` 与 `cli.json` 加载。

自动额度 toast 默认关闭（`enableToast: false`），用户可主动开启。重置通知默认关闭；等待额度重置的重试默认开启（可能长时间等待，属执行影响而非单纯展示变化）；状态行默认开启，并按本地额度卡片的实际可见性补位，卡片可见时不重复显示。手动操作的结果 toast 不受自动 toast 默认值影响。

原始 Provider 和额度逻辑来自 `@slkiser/opencode-quota`，许可证仍为 MIT。

## 验收状态

本插件的运行验收尚未完成。用户人工验收清单见仓库内 `.scratch/quota-v6-adaptation/spec.md`，未勾选项不代表通过；本包遵循维护决定，不引入 TDD、smoke、自动化 test 或测试基础设施，也不据构建通过宣称已验证。

## 相关文档

- [整合包主 README](../../README.md)
- [上游溯源](UPSTREAM-PROVENANCE.md)
- 上游参考：<https://github.com/slkiser/opencode-quota/tree/v6.0.0-beta.1>
