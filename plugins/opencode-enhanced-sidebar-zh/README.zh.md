# opencode-enhanced-sidebar-zh

中文 OpenCode 增强侧边栏，融合上下文、TPS、子代理和 API 标价估算。
运行时提供两个可独立启停的 TUI 插件：

- `opencode-session-overview-zh`：上下文、缓存命中、TPS，以及本会话、子代理、任务树三行花费。
- `opencode-subagent-magazine-zh`：子代理监控；展开条目内含该子代理的 Token 用量与费用。

旧的 `opencode-enhanced-sidebar-zh` 聚合入口仅用于兼容已有配置。

参考来源：[`opencode-subagent-magazine`](https://github.com/Hotakus/opencode-subagent-magazine)、[`opencode-quota`](https://github.com/slkiser/opencode-quota)、[`models.dev`](https://models.dev/)。本项目对这些能力做了 OpenCode 适配、中文化和费用口径统一。

侧边栏顺序：

1. 上下文
2. 子代理

在 OpenCode 的 Plugins 面板中可分别开关额度、会话概览和子代理。迁移旧配置时，
OpenCode v2 请在 `cli.json` 中分别加载 `src/tui-v2-session-overview.tsx` 与
`src/tui-v2-subagent-magazine.tsx`；两个面板可独立开关。

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

### 花费（本会话 / 子代理 / 任务树）

三行花费都放在「上下文」面板内，依次为：

- “花费（本会话）”只统计当前展示会话自身，不含派生子代理。
- “花费（子代理）”统计当前会话已跟踪的后代子代理。
- “花费（任务树合计）”是本会话与全部已跟踪子代理的合计。
- 任一参与汇总的会话还没取数完成时，对应行整行隐藏，绝不把部分求和当作总额。
- 子代理汇总使用颜色区分：`✓` 已完成、`●` 运行中、`✕` 失败。
- 金额为估算值：五类 token（input / output / reasoning / cache_read /
  cache_write）乘以 models.dev 的 USD per 1M 单价。
  单价缺失时回退：`cache_read`/`cache_write` → `input`，`reasoning` → `output`。
- 首选使用 Token × 当前 API 单价重新计算；不把 OpenCode OAuth 的原生零费用当作免费。
- 消息来源是 `client.message.list()` 按 cursor 分页的完整结果（按 id 去重），
  不会截断为 TUI 状态里最近的 100 条消息。
- 价格数据：数据源为 https://models.dev/api.json（USD / 1M tokens）；内置快照
  `src/data/modelsdev-pricing.min.json` 作为兜底，并与 quota-zh 共享
  `opencode-quota/` 运行时快照，确保两个界面使用同一价格目录；刷新失败或网络不可用时继续使用内置快照。
- 完整会话取数（opencode 2.0.x 契约）：每页 `limit` 上限 200，仅首屏带
  `order: "asc"`，后续页只传 `cursor`（`cursor` 与 `order` 同传会被服务端
  拒绝），全程带 `type: "assistant"` 过滤；超过 100 页即标记不完整，
  绝不把截断当作总额展示。
- 金额后的 `+` 表示该会话存在**带 token 但无法定价**的消息：
  已知部分照常显示，例如 `$0.1234+`；全部无法定价且有用量时显示 `未定价`。
- 完全没有 token 的会话不显示花费；首屏取数失败且没有任何已聚合用量时显示
  “加载失败”（不是“没有用量”）；已显示金额但后续分页失败或截断时追加
  “（不完整）”。分页失败不会覆盖上一次完整结果。

### 子代理操作与 Token 用量

- 子代理条目中的“Token 用量”统计该子代理完整会话内全部 assistant 响应的
  input、output、reasoning、cache read 和 cache write，与“费用”使用同一份完整数据。
- “取消任务”会向仍在运行的子会话发送真实取消请求，并依次显示“取消中”和“已取消”；
  “标记完成”只清理面板中的僵尸状态，不会终止实际任务。
- 点击子代理会话 ID 会直接复制；系统剪贴板不可用时，弹窗仍会显示完整 ID 供手动复制。

### 子代理设置（排序、数量、保留、清空）

- 设置不在侧边栏里，侧边栏只管显示。改设置去两个地方，和 V2 文档一致：
- `cli.json` 插件选项：`subagentsSortOrder`（`desc` 新的在上 / `asc` 旧的在上）、`subagentsMaxEntries`（1-50，默认 10 条）、`subagentsTtlDays`（3/7/14/30/0，0 表示不限，默认 3 天，和上游一致）。
- 命令面板（Ctrl+P）和斜杠：`/subagent-sort`（选择框）、`/subagent-max`（输入 1-50）、`/subagent-ttl`（选择 3/7/14/30/不限）、`/subagent-clear-running`（标记完成）、`/subagent-clear`（确认框）。
- 优先级：命令改的存档 > `cli.json` 选项 > 默认值。
- 保留天数只删已结束的，正在跑的永远保留；清空本会话用确认框，替代原来输入“清空”两个字的方式。
- 点开某一条能单独标记完成或删除这条，删了的不再冒出来（和上游单条清除一致）。

### 刷新与排障

- 修改插件或配置后必须完全退出并重新启动 OpenCode。
- 上下文使用率在每轮 assistant 完成后刷新（生成过程中保持上一轮准确值）；切换会话时立即刷新。
- 执行 `/pricing_refresh` 后，quota-zh 与本侧边栏共享新的价格快照。
- 如果某个模型仍显示“未定价”，执行 `/quota_status` 检查实际的 provider/model ID 和未定价列表。
- 如果子代理费用迟迟不出现，切回父会话等待其最终消息落库；完成结果会通过订阅回填，不依赖固定短延迟。

### 兼容与归属

- 子代理记录继续使用 `subagent_magazine` KV 前缀，迁移自
  `opencode-subagent-magazine` 的历史数据会自动保留；旧版本写入的纯数字
  成本仅作展示迁移，下一次成功计算后会被覆盖。SubAgent Magazine 的
  slash 指令和命令面板设置入口已移除，界面固定使用中文。
- 子代理取消与剪贴板能力选择性同步自 `opencode-subagent-magazine` v1.5.3；
  设置（排序、显示数量、保留期限、清空记录）已按中文面板重新实现，默认 10 条、新的在上、保留 3 天，
  未引入其多语言、边框和滚动模式，也未采用其原生费用口径。
- 子代理监控代码来自 `opencode-subagent-magazine`，其 MIT 许可证见
  `LICENSES/opencode-subagent-magazine.LICENSE`。
- 成本计算与 models.dev 价格/别名解析逻辑移植自
  `@slkiser/opencode-quota`（MIT），见
  `LICENSES/opencode-quota.LICENSE`。

## 相关文档

- [OpenAI/ChatGPT 订阅 Token 记账说明](../../docs/openai-subscription-token-accounting.md)
- [整合包主 README](../../README.md)
