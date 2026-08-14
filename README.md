# OpenCode 中文插件整合包

<p align="center">OpenCode 本地中文插件整合包：额度、Token 用量、API 标价估算与工程工作流。</p>

<p align="center">
  <a href="#版本记录"><img alt="版本" src="https://img.shields.io/badge/版本-v1.0.1-blue?style=flat-square" /></a>
  <a href="https://opencode.ai/docs/"><img alt="OpenCode" src="https://img.shields.io/badge/OpenCode-%E2%89%A51.18.12-blue?style=flat-square" /></a>
  <a href="https://nodejs.org/"><img alt="Node.js" src="https://img.shields.io/badge/Node.js-%E2%89%A522.6-339933?style=flat-square" /></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" /></a>
</p>

---

## 简介

本包不重写 OpenCode，而是在若干开源项目基础上做 OpenCode 适配、中文化与本地整合。四个插件可独立使用：

| 插件 | 加载面 | 用途 | 独立说明 |
| --- | --- | --- | --- |
| `opencode-quota-zh` | Server + TUI | Provider 额度、历史 Token 统计、API 标价估算 | [README.zh.md](plugins/opencode-quota-zh/README.zh.md) |
| `opencode-enhanced-sidebar-zh` | TUI | 上下文、TPS、子代理与任务树费用 | [README.zh.md](plugins/opencode-enhanced-sidebar-zh/README.zh.md) |
| `opencode-matt-workshop` | Server | Drafter、Foreman、Tinker 与 Workflow Skill | [README.md](plugins/opencode-matt-workshop/README.md) |
| `gpt-reset-credits` | Server | ChatGPT 重置卡查询与确认兑换 | [README.md](plugins/gpt-reset-credits/README.md) |

## 上游项目（间接参考）

使用、修改或继续开发前，请直接阅读上游文档，本包只做衔接与适配：

| 上游项目 | 仓库 | 本包相关部分 |
| --- | --- | --- |
| OpenCode | <https://github.com/anomalyco/opencode> | 全部（插件加载、TUI、Provider、会话数据库） |
| opencode-quota | <https://github.com/slkiser/opencode-quota> | quota-zh 与增强侧边栏的额度、价格与估算逻辑 |
| OpenCode SubAgent Magazine | <https://github.com/Hotakus/opencode-subagent-magazine> | 增强侧边栏的子代理监控与 KV 持久化 |
| Matt Pocock Skills | <https://github.com/mattpocock/skills> | Workshop 的 Workflow Skill 来源 |
| models.dev | <https://models.dev/> | API 标价估算的公开价格目录 |

模型价格来自 models.dev 的公开 API 单价。估算金额不是 Provider 实际账单，也不是 ChatGPT 订阅余额。

## 快速开始

环境要求：

- OpenCode 1.18.12 或更高版本
- Node.js 22.6 或更高版本、npm
- Python 3.10 或更高版本（仅 `gpt-reset-credits` 需要）

Linux / macOS / WSL：

```bash
bash install.sh
```

Windows PowerShell：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

安装器默认不会覆盖已有 OpenCode 配置；已有配置请参考
[`docs/MERGE_EXISTING_CONFIG.md`](docs/MERGE_EXISTING_CONFIG.md)。

> [!IMPORTANT]
> 安装或更新后必须完全退出并重新启动 OpenCode；配置和插件不会热重载。

## 更新

1. 关闭 OpenCode。
2. 重新运行安装器（`install.sh` / `install.ps1`），默认保留已有配置。
3. 若检测到已有配置，按提示手工合并插件条目。
4. 重启 OpenCode。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `/quota` | 查看当前 Provider 额度 |
| `/quota_status` | 诊断认证、价格快照与未定价模型 |
| `/pricing_refresh` | 从 models.dev 刷新共享价格快照 |
| `/tokens_today` `/tokens_weekly` `/tokens_monthly` `/tokens_all` `/tokens_session` | 历史与当前会话 Token 用量 |
| `/gpt-reset-credits` | 查询 ChatGPT 重置卡；带“兑换”参数表示确认兑换 |
| `/setup-matt-pocock-skills` 等 | Workshop 将上游 Workflow Skill 注册为同名命令，见 [opencode-matt-workshop](plugins/opencode-matt-workshop/README.md) |

费用口径：

- Token 从 OpenCode 持久化会话读取，保留 input、output、reasoning、cache read、cache write 五类。
- 每条 assistant 消息按自身实际 `provider/model` 与当前价格快照估算，不受固定 Provider 白名单限制。
- 界面分别展示“本会话”“子代理”“任务树合计”。
- 价格快照更新后，历史金额按新价格重新计算。
- 无价格的模型保留 Token 并显示“未定价”，不把未知费用显示为 `$0`。
- 估算金额不是 Provider 实际账单，也不是 ChatGPT 订阅额度。

## 数据与安全

- OpenCode 配置：`~/.config/opencode/`
- 会话数据库（只读）：`${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db`
- 共享价格缓存：`~/.cache/opencode/opencode-quota/`
- OpenAI/Codex 凭证：`~/.local/share/opencode/auth.json` 或 `~/.codex/auth.json`

本包不包含、不提交 API key、OAuth token、cookie、会话数据库与账户数据；不要分享 auth 文件或未经检查的 `opencode debug config` 输出。

## 故障排查

1. 确认已完全退出并重新启动 OpenCode。
2. 运行 `/quota_status` 检查 Provider、价格快照来源与未定价模型。
3. Token 报告为空时，先启动 OpenCode 生成 `opencode.db`，再运行一个有模型用量的会话。
4. 常见症状与解决方案见 [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)。

## 文档

- [OpenAI/ChatGPT 订阅 Token 记账说明](docs/openai-subscription-token-accounting.md)
- [已有配置合并指南](docs/MERGE_EXISTING_CONFIG.md)
- [第三方来源与许可证](THIRD_PARTY_NOTICES.md)

## 卸载

从 `opencode.json(c)` 和 `tui.jsonc` 的插件列表删除本包条目，删除：

```text
~/.config/opencode/opencode-zh-bundle/
```

然后重启 OpenCode。卸载不会删除 OpenCode 的登录凭证或会话数据库。

## 许可证与声明

本包自身按 [MIT 许可证](LICENSE) 授权（Copyright © 2026 MinZhi624）；上游项目保留各自许可证，见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

本包不是 OpenCode 官方项目，也不隶属于 OpenCode、OpenAI 或任何上述上游项目与 Provider。

## 版本记录

### v2.0.0

- Matt Workshop 对齐 Matt Pocock Skills `v1.2.2` 的全部 25 个 promoted Skills，并将适配器恢复为可构建的 TypeScript 源码。
- 引入可重复同步、统一 Skill manifest、运行时发行白名单与 GitHub Actions 核心验收门槛。
- 移除旧 `/writing-great-skills` 命令；使用 `/writing-for-agents`。

### v1.0.1（2026-08-07）

- 统一 API 标价估算：quota-zh 与增强侧边栏共享同一价格快照与逐消息估算规则，界面分别展示“本会话”“子代理”“任务树合计”，“未定价”不再伪装成零费用。
- 新增 [OpenAI/ChatGPT 订阅 Token 记账说明](docs/openai-subscription-token-accounting.md)：订阅路径的历史 Token 条件稳定可读、剩余额度仅条件查询、订阅 USD 不可计算。
- 完善 `gpt-reset-credits` 重置卡查询与兑换的安全边界说明。
- 版本号统一升级到 1.0.1，移除 `release/` 发布产物目录（仓库即完整项目）。
- README 改版：参照上游 opencode-quota 的 README 结构重写，采用简洁、间接引用的方式组织文档。
