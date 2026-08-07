# OpenCode 与 ChatGPT/Codex 订阅用量记账（截至 2026-08-07）

## 结论（先看评级）

| 项目 | 评级 | 结论 |
|---|---|---|
| (a) 每次响应的 token：input/output/reasoning/cache | **条件稳定** | 通过 OpenAI OAuth/Codex 路径成功完成的 Responses 响应会被 OpenCode 解析、规范化并写入会话；但依赖 Codex 私有兼容端点返回与公开 Responses API 相同的 `response.completed.usage`，且当前 OpenCode 对 OpenAI 只得到 cached-read，不得到 cache-write。 |
| (b) 订阅剩余额度、5h/weekly limits | **不支持** | OpenCode 当前 OAuth 插件没有调用或持久化 ChatGPT/Codex usage dashboard/额度接口；它只能看到请求是否被服务端接受，不能从会话 token 反推出剩余额度。 |
| (c) USD 费用 | **不支持（订阅路径）** | OAuth 模型被插件显式标为 input/output/cache 全部 0；这不是“免费”的计费证明，而是没有 API 价格的占位。订阅消费应标为 **未定价**，不能显示为 USD 0。 |

这里的“稳定”只表示 OpenCode 自己的记录链路，不表示 OpenAI 订阅接口作出了长期的 usage-schema 保证。OpenAI 官方把 ChatGPT 登录和 API key 明确区分：ChatGPT 登录使用计划额度，API key 按 API 价格计费；见 [OpenAI Codex Authentication](https://developers.openai.com/codex/auth#sign-in-with-chatgpt) 与 [Pricing](https://developers.openai.com/codex/pricing#what-are-tokens-and-credits)。

## 本仓库插件的能力边界

本仓库在 OpenCode 核心之外又提供了两条读取路径，不能将它们混为一种“订阅 token 计算”：

* `opencode-quota-zh` 从 OpenCode 已持久化的 assistant message 中读取 `input`、`output`、`reasoning`、`cache.read`、`cache.write` 五类 token，再按会话聚合；见 [`token-buckets.js`](../plugins/opencode-quota-zh/dist/lib/token-buckets.js) 与 [`quota-stats.js`](../plugins/opencode-quota-zh/dist/lib/quota-stats.js)。它不会从 ChatGPT 订阅额度反推 token。
* `opencode-quota-zh` 另外调用 `https://chatgpt.com/backend-api/wham/usage` 读取 5h/weekly 等订阅窗口；见 [`openai.js`](../plugins/opencode-quota-zh/dist/lib/openai.js)。这是独立的额度查询，依赖非公共 dashboard 响应形状，稳定性低于本地历史 token 读取。
* `opencode-enhanced-sidebar-zh` 会把 `chatgpt`/`codex` provider 映射为 `openai`，再用 models.dev 的 API 单价估算 USD；见 [`pricing.ts`](../plugins/opencode-enhanced-sidebar-zh/src/metrics/pricing.ts)。这个金额不是 ChatGPT 订阅实际扣费，不能作为订阅账单。

因此，对本 bundle 的准确结论是：**已完成响应的历史 token 数量可条件稳定读取；订阅剩余额度只能条件查询；订阅实际 USD 花费不可计算。**

## 请求与认证路径

1. OpenCode 官方 provider 文档提供 `OpenAI -> ChatGPT Plus/Pro` 的 `/connect` OAuth 选项，同时也提供手工 API key；[Providers 文档的 OpenAI 段落](https://opencode.ai/docs/providers/#openai)。
2. 当前源码的 OAuth 插件向 `https://auth.openai.com/oauth/authorize` 请求 PKCE token，并从 JWT 提取 `chatgpt_account_id`；刷新走 `https://auth.openai.com/oauth/token`。源码：[plugin/openai/codex.ts](https://github.com/anomalyco/opencode/blob/03bff6500abd09fc469d59e5bd4143d3eb053a94/packages/opencode/src/plugin/openai/codex.ts#L12-L119)。
3. OAuth 请求移除 SDK 默认 Authorization，改用 `Bearer <access token>` 和 `ChatGPT-Account-Id`，并把 `/v1/responses` 或 `/chat/completions` 改写到 `https://chatgpt.com/backend-api/codex/responses`；源码：[codex.ts](https://github.com/anomalyco/opencode/blob/03bff6500abd09fc469d59e5bd4143d3eb053a94/packages/opencode/src/plugin/openai/codex.ts#L228-L286)。因此这不是普通 `api.openai.com/v1` API-key 计费请求。
4. OpenAI 一方文档确认 ChatGPT 登录是“subscription access”，API key 是“usage-based access”；API key 走标准 API pricing，ChatGPT 登录则遵循 ChatGPT workspace 权限。[OpenAI Authentication](https://developers.openai.com/codex/auth#openai-authentication)。

## (a) 每响应 token：字段来源、规范化、持久化

### 来源与规范化

公开 Responses schema 的 usage 是：`input_tokens`（含 cached 子集）、`input_tokens_details.cached_tokens`、`output_tokens`（含 reasoning 子集）、`output_tokens_details.reasoning_tokens`、`total_tokens`。OpenCode 的 native OpenAI Responses adapter严格按这些字段读取，并计算 `nonCachedInputTokens = input - cached`；源码：[openai-responses.ts](https://github.com/anomalyco/opencode/blob/03bff6500abd09fc469d59e5bd4143d3eb053a94/packages/llm/src/protocols/openai-responses.ts#L137-L151) 和 [mapUsage](https://github.com/anomalyco/opencode/blob/03bff6500abd09fc469d59e5bd4143d3eb053a94/packages/llm/src/protocols/openai-responses.ts#L353-L371)。OpenAI 官方 Responses 文档也明确展示 `output_tokens_details.reasoning_tokens`，并说明 reasoning token 可在 response usage object 中查看；[Reasoning models](https://developers.openai.com/api/docs/guides/reasoning#how-reasoning-works)。

OpenCode 的统一 `Usage` 保留：

* `inputTokens`、`outputTokens`、`totalTokens`（inclusive totals）；
* `nonCachedInputTokens`、`cacheReadInputTokens`、`cacheWriteInputTokens`；
* `reasoningTokens`；
* 未规范化的原始 provider usage（`providerMetadata`）。

规范定义及其“reasoning 是 output 子集、cache read/write 是 input breakdown”的约束见 [llm/schema/events.ts](https://github.com/anomalyco/opencode/blob/03bff6500abd09fc469d59e5bd4143d3eb053a94/packages/llm/src/schema/events.ts#L6-L55)。

### 会话持久化

Responses 的完成事件携带 usage 后，session processor 调用 `Session.getUsage`，把规范化 token 写入 assistant message，并写入 `step-finish` part；源码：[processor.ts](https://github.com/anomalyco/opencode/blob/03bff6500abd09fc469d59e5bd4143d3eb053a94/packages/opencode/src/session/processor.ts#L338-L373)。会话读取随后从数据库 hydrate message/parts；源码：[message-v2.ts](https://github.com/anomalyco/opencode/blob/03bff6500abd09fc469d59e5bd4143d3eb053a94/packages/opencode/src/session/message-v2.ts#L46-L77)。所以，**只要服务端实际发出终止事件中的 usage，重启后仍可读取**，不是仅存在内存 UI。

### 重要缺口与条件

* 当前 OpenAI Responses wire schema只有 `cached_tokens`，没有 cache-write 字段；因此 OAuth/Codex Responses 的 `cacheReadInputTokens` 可记录，但 `cacheWriteInputTokens` 通常缺失，不应补成 0 后解释为“没有写缓存”。源码 schema：[openai-responses.ts](https://github.com/anomalyco/opencode/blob/03bff6500abd09fc469d59e5bd4143d3eb053a94/packages/llm/src/protocols/openai-responses.ts#L135-L145)。
* OpenAI 官方说 reasoning token **不可见为原始 reasoning 内容**，但数量在 usage 中可见；因此“reasoning 数量完整”不等于“reasoning 文本完整”。[Reasoning models](https://developers.openai.com/api/docs/guides/reasoning#how-reasoning-works)。
* OAuth endpoint 是 `chatgpt.com/backend-api/codex/responses`，而非 OpenAI 公共 API；OpenCode 源码没有为该订阅 endpoint 单独验证 usage contract。因此对 OAuth 的评级是条件稳定，而非无条件稳定。源码路径与 endpoint：[codex.ts](https://github.com/anomalyco/opencode/blob/03bff6500abd09fc469d59e5bd4143d3eb053a94/packages/opencode/src/plugin/openai/codex.ts#L15-L17)。
* 流式传输默认 HTTP SSE；实验性 WebSocket 失败会回退 HTTP，且 transport README 明确描述了 retry/fallback；[OpenAI WebSocket README](https://github.com/anomalyco/opencode/blob/03bff6500abd09fc469d59e5bd4143d3eb053a94/packages/opencode/src/plugin/openai/README.md#flow)。验证时应先关闭 `OPENCODE_EXPERIMENTAL_WEBSOCKETS`，避免把 transport 回归误判成 usage 回归。

## (b) 订阅额度与 5h/weekly limits 不是 token usage

OpenAI 官方 pricing 页面说明：本地消息与云聊天共享滚动 **5 小时窗口**，可能另有 weekly limits；当前额度应在 `chatgpt.com/codex/settings/usage` 查看，Codex CLI 可用 `/status` 查看。[Pricing：limits 与 dashboard](https://developers.openai.com/codex/pricing#where-can-i-see-my-current-usage-limits)。页面还说明额度受模型、context、reasoning、tool use、retrieval、caching 影响，消息数不能可靠转换成 token 数。[Pricing：usage limits](https://developers.openai.com/codex/pricing#what-are-the-usage-limits-for-my-plan)。

OpenCode 的 OpenAI 插件源码只有 OAuth authorize/refresh、请求 header、endpoint rewrite 和模型过滤；没有 usage-dashboard URL、5h bucket、weekly bucket 或剩余额度字段。[codex.ts](https://github.com/anomalyco/opencode/blob/03bff6500abd09fc469d59e5bd4143d3eb053a94/packages/opencode/src/plugin/openai/codex.ts#L195-L339)。结论是：会话里的 token 是“本次响应服务器报告的消耗”，不是“账户剩余额度”；两者不能互换，也不能由 token 计数可靠推导。

## (c) USD 费用

OAuth 模型加载时把 `cost.input`, `cost.output`, `cost.cache.read`, `cost.cache.write` 全部设置为 0；[codex.ts](https://github.com/anomalyco/opencode/blob/03bff6500abd09fc469d59e5bd4143d3eb053a94/packages/opencode/src/plugin/openai/codex.ts#L184-L194)。这会让通用费用计算得到 0，但它表达的是“没有适用的模型价格”，不是订阅消费免费、也不是 API 账单为零。OpenAI 官方把 API key 费用定义为标准 API pricing，同时把订阅额度定义为 credits/limits；[Authentication](https://developers.openai.com/codex/auth#sign-in-with-an-api-key) 与 [Pricing](https://developers.openai.com/codex/pricing#what-are-tokens-and-credits)。因此本报告建议 UI/导出使用 `unpriced` 状态：token 有效，USD 未定价。

## OpenCode 原生 `message.cost`：不是 provider 账单字段

### 它从哪里来

对普通 OpenCode provider，`message.cost` 主要是 **OpenCode 事后计算的估算值**，不是 provider 在响应中直接返回的美元账单。流程是：

1. `ModelsDev` 服务默认从 `https://models.opencode.ai/api.json` 读取模型目录（可用 `OPENCODE_MODELS_URL` 或 `OPENCODE_MODELS_PATH` 覆盖），写入 `~/.cache/opencode/models.json`，有 5 分钟本地新鲜度判断并后台刷新；[models-dev.ts](https://github.com/anomalyco/opencode/blob/03bff6500abd09fc469d59e5bd4143d3eb053a94/packages/core/src/models-dev.ts#L111-L190)。因此官方源码使用的是 OpenCode 的 models.dev 服务镜像/目录，而不是每次从 provider response 发现价格。
2. 目录的 model `cost` 结构包含 `input`、`output`、`cache_read`、`cache_write`，还可有按 context size 的 `tiers` 和 `context_over_200k`；[models-dev.ts](https://github.com/anomalyco/opencode/blob/03bff6500abd09fc469d59e5bd4143d3eb053a94/packages/core/src/models-dev.ts#L22-L58)。provider 层把这些 USD/1M-token 数值映射成 `cost.input/output/cache.read/cache.write`，并保留 tier；[provider.ts](https://github.com/anomalyco/opencode/blob/03bff6500abd09fc469d59e5bd4143d3eb053a94/packages/opencode/src/provider/provider.ts#L424-L467)。
3. 配置/插件可以合并或覆盖 provider/model 信息；目录是初始 catalog，provider 初始化随后 merge 配置和插件模型；[provider.ts](https://github.com/anomalyco/opencode/blob/03bff6500abd09fc469d59e5bd4143d3eb053a94/packages/opencode/src/provider/provider.ts#L560-L626)。所以“模型价格从哪里来”的优先事实是：**默认来自 models.dev；若用户配置或插件对 model cost 做了覆盖，运行时 model cost 以合并后的值为准**。provider 的普通响应 metadata 不是价格目录。

### 费用公式与字段处理

`Session.getUsage` 先清洗非有限数/负数，然后把 inclusive `inputTokens` 减去 cache read/write，形成非缓存 input；把 inclusive `outputTokens` 减去 reasoning，形成 visible output；reasoning 单独保存。它按当前 input context 选择最大匹配的 context tier（或 >200K 特殊价格），再计算：

```text
USD = nonCached_input × input_rate / 1,000,000
    + visible_output × output_rate / 1,000,000
    + cache_read × cache_read_rate / 1,000,000
    + cache_write × cache_write_rate / 1,000,000
    + reasoning × output_rate / 1,000,000
```

官方源码中的实现、tier 选择、Decimal 计算和“reasoning 暂按 output rate”的 TODO 见 [session.ts `getUsage`](https://github.com/anomalyco/opencode/blob/03bff6500abd09fc469d59e5bd4143d3eb053a94/packages/opencode/src/session/session.ts#L246-L317)。这说明 reasoning **不是再次从 provider 账单读取**，而是按 output 价格加回到成本；在该公式中 `output` 已减 reasoning，所以不会重复计入 reasoning。cache read/write 也使用各自费率，而不是把 cached input 再计入普通 input。

有一个明确例外：GitHub Copilot provider 若 raw chunk 给出 `copilot_usage.total_nano_aiu`，OpenCode 直接把该 provider-authoritative 数值转换成 cost；[session.ts](https://github.com/anomalyco/opencode/blob/03bff6500abd09fc469d59e5bd4143d3eb053a94/packages/opencode/src/session/session.ts#L297-L307) 与 raw-chunk 提取代码 [ai-sdk.ts](https://github.com/anomalyco/opencode/blob/03bff6500abd09fc469d59e5bd4143d3eb053a94/packages/opencode/src/session/llm/ai-sdk.ts#L20-L42)。这不能推广到 OpenAI/Codex OAuth：Codex OAuth 插件把 model cost 明确置为 0，且没有同类 provider-authoritative USD 字段；[codex.ts](https://github.com/anomalyco/opencode/blob/03bff6500abd09fc469d59e5bd4143d3eb053a94/packages/opencode/src/plugin/openai/codex.ts#L184-L194)。

### `message.cost` 如何持久化

processor 收到 `step-finish` 时调用 `Session.getUsage`，把返回的 `usage.cost` 累加到 assistant `message.cost`，并把同一 step 的 cost/tokens 写进 `step-finish` part；[processor.ts](https://github.com/anomalyco/opencode/blob/03bff6500abd09fc469d59e5bd4143d3eb053a94/packages/opencode/src/session/processor.ts#L338-L373)。数据库的 message data 保留该 assistant 字段；session 汇总也有独立 `cost` 与 token 列，SQLite schema 明确是 `real` cost 和五类 token 列；[session/sql.ts](https://github.com/anomalyco/opencode/blob/03bff6500abd09fc469d59e5bd4143d3eb053a94/packages/core/src/session/sql.ts#L10-L62)。因此 `message.cost` 是 OpenCode 计算/特殊 provider 覆盖后的本地记录，不应称为“provider 返回的实际账单”。

### 比 quota-zh 的六 provider pricing allowlist 覆盖更多吗？

**是，原生 OpenCode 的目录覆盖面更宽。** 本仓库 quota-zh 的 models.dev pricing 快照默认 allowlist 是六个 provider：`anthropic`, `google`, `moonshotai`, `openai`, `xai`, `zai`；见本仓库 `plugins/opencode-quota-zh/dist/lib/modelsdev-pricing.js` 第 7–15 行（本地源码对照，非 OpenCode 官方仓库）。quota-zh 还注册了许多 quota provider，但“额度 provider 注册表”不等于“models.dev 价格 allowlist”；见本仓库 `plugins/opencode-quota-zh/dist/providers/registry.js` 第 31–60 行。

OpenCode 原生 `ModelsDev` schema 是任意 provider ID 到 provider/model map，并未把价格限制为这六个；[models-dev.ts 的 Provider schema](https://github.com/anomalyco/opencode/blob/03bff6500abd09fc469d59e5bd4143d3eb053a94/packages/core/src/models-dev.ts#L61-L76)。因此原生价格可覆盖 models.dev 当前目录中的其它 provider（例如 Bedrock、OpenRouter、GitHub Copilot、Groq 等），但**具体某模型是否有价格仍取决于目录快照**；目录存在不等于每个模型都有非零价格。

### OpenAI/Codex OAuth 为什么是 0

这是有意的“无 API price”语义，而不是 token usage 为零：OAuth 模型的插件 transform 保留模型但将四个价格桶全部设为 0；因此 `Session.getUsage` 的乘法自然得到 0。OpenAI 官方把 ChatGPT 登录归为 subscription access、API key 归为 usage-based access；[Codex Authentication](https://developers.openai.com/codex/auth#openai-authentication)。订阅 credits/5h limits 不是 OpenAI API 的 USD price table，不能套 API 单价伪造费用；报告层应把“有 token、cost=0 因无价格”提升为 `unpriced`，而不是 `$0`。

### quota-zh 用正数 `message.cost` fallback 是否安全？

**作为整条消息的一次性展示 fallback：有条件安全；作为 token 估算的补充项：不安全。** 原因如下：

* 原生 message cost 没有 provenance 字段，消费者无法仅凭正数判断它是 models.dev 乘法结果、Copilot provider-authoritative 数值，还是未来某 provider 的其它语义。
* 若 token 价格缺失，直接把正数 `message.cost` 当作这条消息的唯一 cost，可避免把同一消息再按另一份 models.dev snapshot 计算一次；但只能在该消息确实有 usage、cost 是有限非负数、并且不再把同一 token buckets 加入估算总和时采用。
* 不应做 `estimated_from_tokens + message.cost`，也不应在 message cost 已被采用后再把 session cost/parent cost 叠加；这会重复计入。跨模型/价格快照更新时，OpenCode 的 message cost 还是历史写入值，而 quota-zh 自己的重算可能使用新快照，两者也可能自然不一致。
* 对 OpenAI/Codex OAuth，正数 fallback 通常不存在（插件 cost 为 0）；0 不能作为“provider 免费”的 fallback。应输出 `unpriced`，并保留 token。
* 最稳妥的策略是三态：`priced_estimate`（quota-zh 自己有唯一匹配价格且只算一次）、`native_cost_fallback`（无价格、正数 native message cost、只采用一次）、`unpriced`（有 token 但 native cost 非正或缺失）。同时记录 `source`，否则无法审计是否同源重复。

因此，quota-zh 的六 provider allowlist 不能通过“看到正数 message.cost”安全扩展成通用价格表；正数只能是**逐消息的保守 fallback**，不能成为另一套 token×price 估算的输入。

## 最小可复现验证

以下验证只检查本地记录链路，不绕过 OpenAI 登录或探测私有接口：

1. 安装包含该 commit 之后 OpenAI Codex OAuth 插件的 OpenCode 版本；运行 `opencode --version`，备份 `~/.local/share/opencode/auth.json` 和会话数据。
2. 暂时关闭实验 WebSocket：`unset OPENCODE_EXPERIMENTAL_WEBSOCKETS`。执行 `/connect`，选择 **OpenAI → ChatGPT Pro/Plus (browser)**，完成浏览器登录；OpenCode 官方文档确认该选项存在。[Providers](https://opencode.ai/docs/providers/#openai)。
3. 选择 OAuth 可见的 OpenAI 模型，发送一条短请求，再发送一条需要 reasoning 的请求；让第二条完成，不要在最终响应前中断。
4. 通过 OpenCode 会话查看接口/导出（或直接检查该会话 SQLite/JSON 的 assistant message 与 `step-finish` part），确认存在 `tokens.input`、`tokens.output`、`tokens.reasoning`（字段名/展示形式以所装版本 schema 为准），以及 `step-finish` 的 usage/cost。重新启动 OpenCode 后再读同一会话，验证持久化。
5. 对同一 prompt 连续请求两次，记录是否出现 `cacheReadInputTokens`；不要把缺少 `cacheWriteInputTokens` 当作 0。若服务端返回没有 usage，记录为“该响应未记账”，不要用本地 tokenizer 猜测。
6. 独立打开 [ChatGPT Codex usage dashboard](https://chatgpt.com/codex/settings/usage) 或在官方 Codex CLI 使用 `/status`，比较账户剩余 5h/weekly 状态。预期 OpenCode 会话本身不会显示该剩余额度；这一步也不能用 OpenCode token 总数反推剩余额度。
7. 检查费用：OAuth 模型的 model cost 是 0，但报告应显示 `USD: unpriced`；只有切换到 API key 并使用有价格的 API model，才适合验证 USD 计算。API key 与订阅不要混用同一 auth 条目。

## 版本/证据边界

本报告以 OpenCode `dev` 当前快照 commit `03bff6500abd09fc469d59e5bd4143d3eb053a94` 的官方源码和截至日期可访问的 OpenAI 官方 Codex 文档为依据；固定源码链接均指向该 commit。OpenAI Codex backend endpoint 属于 ChatGPT/Codex 产品路径，官方公开文档确认认证、额度和 API/订阅计费的区别，但没有在本次可访问的一手文档中承诺该私有 endpoint 对第三方客户端永久提供完整 usage 字段。因此“条件稳定”是有意保守的评级；若 OpenAI 改变 endpoint、OAuth entitlement、usage 字段或模型白名单，必须重新执行上述验证。
