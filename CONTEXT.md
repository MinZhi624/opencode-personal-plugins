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
