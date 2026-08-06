# opencode-enhanced-sidebar-zh

中文 OpenCode 增强侧边栏，融合额度、上下文和子代理。

侧边栏顺序：

1. 上下文
2. 子代理

## 行为说明

### TPS（token/秒）

- 生成中的当前 step 在 0.5 秒后每秒显示一次实时估算，例如 `~42 t/s`；估算仅统计
  当前 step 开始后新增的 text/reasoning 内容，CJK 字符约按 1 token 估算，其它字符
  约按 4 字符估算。
- step 完成后原位替换为插件**完整实时观测**到的准确值：同一
  `(sessionID, messageID)` 内按 FIFO 配对 `step-start → step-finish` 事件，
  以 `step-finish.tokens.output + reasoning` 除以事件间隔秒数。
- step 部件没有持久时间戳；不使用 assistant 的 `time.created → time.completed`，
  也不对历史 step 或缺失起点/终点的 step 做推测回填。中断时保留上一条准确值。
- 采用 MiMo 风格的整数显示；低于 1 显示 `<1 t/s`。

### 花费（当前会话 / 子代理）

- “上下文”里的**花费**只统计当前展示的会话本身，不含其派生子代理会话；
  每个子代理条目在各自条目中独立展示相同算法计算的花费。
- 金额为估算值：五类 token（input / output / reasoning / cache_read /
  cache_write）乘以 models.dev 的 USD per 1M 单价。
  单价缺失时回退：`cache_read`/`cache_write` → `input`，`reasoning` → `output`。
- 不使用 OpenCode 自带的 `session.cost` / `message.cost`；生产代码从不读取
  这两个字段。
- 消息来源是 `api.client.session.messages()` 分页完整结果（按 id 去重），
  不会截断为 TUI 状态里最近的 100 条消息。
- 价格数据：数据源为 https://models.dev/api.json（USD / 1M tokens）；内置快照
  `src/data/modelsdev-pricing.min.json` 作为兜底，另以独立命名空间
  `opencode-enhanced-sidebar-zh/` 缓存运行时刷新结果（不依赖 quota 插件安装）；
  刷新失败或网络不可用时继续使用内置快照。
- 完整会话取数：`api.client.session.messages()` 一次请求整会话
  （opencode 1.18.12 实测：`before` 参数会被服务端拒绝，`order`/`cursor` 被
  丢弃，`limit` 省略或为 0 时返回全部消息）；若某页恰好取满且无法验证是否
  还有更多，结果会标记为不完整，绝不把截断当作总额展示。
- 金额后的 `+` 表示该会话存在**带 token 但无法定价**的消息：
  已知部分照常显示，例如 `$0.1234+`；全部无法定价且有用量时显示 `$0.0000+`。
- 完全没有 token 的会话不显示花费；分页失败时保持上次完整结果，不显示
  不完整的金额。

### 兼容与归属

- 子代理记录继续使用 `subagent_magazine` KV 前缀，迁移自
  `opencode-subagent-magazine` 的历史数据会自动保留；旧版本写入的纯数字
  成本仅作展示迁移，下一次成功计算后会被覆盖。SubAgent Magazine 的
  slash 指令和命令面板设置入口已移除，界面固定使用中文。
- 子代理监控代码来自 `opencode-subagent-magazine`，其 MIT 许可证见
  `LICENSES/opencode-subagent-magazine.LICENSE`。
- 成本计算与 models.dev 价格/别名解析逻辑移植自
  `@slkiser/opencode-quota`（MIT），见
  `LICENSES/opencode-quota.LICENSE`。
