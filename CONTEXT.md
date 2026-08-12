# Domain Context

## Glossary

### 会话 Token 用量（Session Token Usage）

一个 OpenCode 会话中 assistant 响应产生的 token 计数。分别保留 input、output、reasoning、cache read 和 cache write；它是本次改进的首要统计指标，不等同于 USD 费用。

### 历史会话用量（Historical Session Usage）

在用量查看工具启动前已经产生并由 OpenCode 持久保存的会话 Token 用量。统计完整性不应取决于查看工具何时开始运行。

### Token 用量导出（Token Usage Export）

供外部工具读取的、带格式版本号的历史会话用量快照。它必须保留各类 Token 计数和数据完整性状态；消费者无需在导出生成时保持运行。

### 会话费用估算（Session Cost Estimate）

依据会话 Token 用量和对应模型的公开 API 单价推导的 USD 金额。即使请求使用包月订阅或 OAuth 登录，也按同模型的 API 标价估算；它不表示账户实际扣费。模型价格未知时应显示“未定价”，不能把未知费用表达为零费用。

### API 标价估算（API List-Price Estimate）

将各类 Token 用量乘以对应模型公开 API 单价得到的可比成本指标。一个会话使用多个模型时，每条 assistant 消息按自身实际 `provider/model` 定价后求和，而不是统一套用父会话或启动配置的模型；价格覆盖不应受固定 provider 白名单限制。历史会话按当前生效的价格快照重新计算，因此快照更新后金额可以变化。它用于跨会话、子代理和模型比较，不受实际认证方式、订阅套餐或优惠影响，必须与“实际账单”明确区分。

### 任务树 API 标价估算（Task-Tree API List-Price Estimate）

根会话自身的 API 标价估算与其全部子代理后代会话估算之和。界面应分别展示“本会话”“子代理”和“任务树合计”，避免把父会话金额误解为整个任务的金额。不同请求中重复发送的上下文 Token 仍分别计入，因为它们各自产生模型用量。

### 未定价（Unpriced）

存在 Token 用量，但缺少足以计算 USD 费用的模型身份或价格。未定价不表示免费，也不影响 Token 用量本身有效。

### 启动提示（Startup Hint）

OpenCode 启动首页中以低干扰方式展示的简短信息。它不是自动弹窗，不抢占用户注意力，也不随每条会话消息重复出现。

### 被动额度展示（Passive Quota Display）

不打断当前操作的额度信息展示。默认包括启动提示、侧边栏和用户主动调用 `/quota` 得到的结果；用户可以显式开启会话输入框下方的 prompt bar 作为可选表面。被动额度展示不会产生额度告警。

### 额度告警（Quota Alert）

当额度进入需要用户立即处理的危险状态时才出现的主动通知。它不同于被动额度展示，不能由每次会话消息、工具完成或会话压缩例行触发。

### 额度告警周期（Quota Alert Episode）

同一 Provider、账户和额度窗口从安全状态进入危险状态，并持续到额度恢复或重置的一段时期。默认每个额度告警周期最多主动通知一次；用户可以显式配置低频重复提醒。重启 OpenCode 不会开启新的告警周期，恢复后再次进入危险状态才允许产生新告警。

### 额度告警指标（Quota Alert Metric）

用于判断是否进入危险状态的结构化 Provider 数据。百分比额度、货币余额和 Provider 明确报告的可用状态是不同类型的指标，不能相互换算；数据缺失、无法解析或查询失败不能被当作额度耗尽。百分比阈值可以全局配置，货币余额阈值按 Provider 和币种配置。

### Provider 账户余额（Provider Account Balance）

Provider 明确报告的、可用于后续请求的货币余额。不同币种分别判断，不能自动换算或求和；周期额度、消费预算、已发生花费和按金额计价的额度窗口不属于账户余额。
