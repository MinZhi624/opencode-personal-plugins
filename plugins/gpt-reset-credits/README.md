# gpt-reset-credits

OpenCode Server 插件，用于查询当前 ChatGPT/Codex 账户可用的重置卡，并在用户确认后兑换指定重置卡。

## 命令

```text
/gpt-reset-credits
/gpt-reset-credits 兑换
/gpt-reset-credits 兑换第 2 张
```

- 不带“兑换”参数时只查询，不会兑换。
- 兑换前会重新查询并核对重置卡列表，避免用户确认过期目标。
- 兑换是不可逆操作，必须通过 OpenCode 原生权限确认。
- 只有工具返回 `redeem_success` 才表示兑换成功；其他状态会原样说明，不会自动重试。

## 认证与依赖

插件需要 ChatGPT/Codex OAuth access token，而不是普通 OpenAI API key。凭证按以下顺序读取：

1. `CODEX_AUTH_PATH`
2. `~/.codex/auth.json`
3. `${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json`

Linux/macOS 默认使用 `python3`，Windows 默认使用 `py -3`；可用 `OPENCODE_PYTHON` 指定 Python 命令。

插件不会展示 selection key 或 snapshot key，也不会把凭证写入项目文件。不要分享上述 auth 文件。

## 安全边界

- 查询工具权限为 allow。
- 兑换工具权限为 allow，但实际操作前额外请求 `gpt_reset_credits_redeem_confirm` 权限。
- 用户拒绝确认时立即停止。
- 该插件查询的是订阅重置卡，不负责会话 Token、API 费用或剩余额度统计。

## 相关文档

- [OpenAI/ChatGPT 订阅 Token 记账说明](../../docs/openai-subscription-token-accounting.md)
- [整合包主 README](../../README.md)
