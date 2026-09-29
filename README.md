# OpenCode 中文插件整合包

<p align="center">OpenCode 本地中文插件整合包：额度、Token 用量、API 标价估算与工程工作流。</p>

<p align="center">
  <a href="#版本记录"><img alt="版本" src="https://img.shields.io/badge/版本-v2.1.0-blue?style=flat-square" /></a>
  <a href="https://opencode.ai/v2/docs/"><img alt="OpenCode" src="https://img.shields.io/badge/OpenCode-2.0.18-blue?style=flat-square" /></a>
  <a href="https://nodejs.org/"><img alt="Node.js" src="https://img.shields.io/badge/Node.js-%E2%89%A522.6-339933?style=flat-square" /></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" /></a>
</p>

---

## 简介

本包不重写 OpenCode，而是在若干开源项目基础上做 OpenCode 适配、中文化与本地整合。侧栏功能由独立宿主、共享会话统计和四张可分别启停的卡片组成：

| 插件 | 加载面 | 用途 | 独立说明 |
| --- | --- | --- | --- |
| `opencode-quota-zh` | Server + TUI | Provider 额度后台和独立命令（关闭卡片后仍工作） | [README.zh.md](plugins/opencode-quota-zh/README.zh.md) |
| `opencode-sidebar-host-zh` / `opencode-session-data` | TUI | 排序／显隐宿主和独立共享会话统计 | [正式规格](docs/refeactor/SIDEBAR-PHASE2-SPEC.md) |
| `opencode-quota-card-zh` / `opencode-session-overview-zh` / `opencode-subagent-card-zh` / `opencode-skill-panel` | TUI | 可分别启停的额度、上下文、子代理、技能卡片 | [正式规格](docs/refeactor/SIDEBAR-PHASE2-SPEC.md) |
| `opencode-matt-workshop` | Server | Drafter、Foreman、Tinker 与 Workflow Skill | [README.md](plugins/opencode-matt-workshop/README.md) |
| `gpt-reset-credits` | Server | ChatGPT 重置卡查询与确认兑换 | [README.md](plugins/gpt-reset-credits/README.md) |

## 上游项目（间接参考）

使用、修改或继续开发前，请直接阅读上游文档，本包只做衔接与适配：

| 上游项目 | 仓库 | 本包相关部分 |
| --- | --- | --- |
| opencode-quota | <https://github.com/slkiser/opencode-quota> | quota-zh 与增强侧边栏的额度、价格与估算逻辑 |
| OpenCode SubAgent Magazine | <https://github.com/Hotakus/opencode-subagent-magazine> | 增强侧边栏的子代理监控与 KV 持久化 |
| opencode-enhanced-sidebar | <https://github.com/nt-cubic/opencode-enhanced-sidebar> | `opencode-enhanced-sidebar-zh` 的界面来源 |
| opencode-plugins（`opencode-quota-extended`） | <https://github.com/arandevcode/opencode-plugins> | `opencode-quota-zh` 的额度卡片与 CLI 部分 |
| Matt Pocock Skills | <https://github.com/mattpocock/skills> | Workshop 的 Workflow Skill 来源 |
| models.dev | <https://models.dev/> | API 标价估算的公开价格目录 |

模型价格来自 models.dev 的公开 API 单价。估算金额不是 Provider 实际账单，也不是 ChatGPT 订阅余额。

## 快速开始

环境要求：

- OpenCode 2.0.18（跨插件侧栏接合处按此版本验证；升级须重新验收）
- Node.js 22.6 或更高版本、npm
- Python 3.10 或更高版本（仅安装 `alone` 组的 `gpt-reset-credits` 时需要）

Linux / macOS / WSL：

```bash
bash install.sh                 # 交互式选择组件组（终端中预选上次安装的组合）
bash install.sh --all           # 安装全部组，跳过提问
bash install.sh --only workshop,sidebar
```

Windows PowerShell：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1                   # 或 .\install.ps1 --all / --only workshop,sidebar
```

### 安装组

| 组 | 内容 | 说明 |
| --- | --- | --- |
| `workshop` | `opencode-matt-workshop` | 工作流：Drafter / Foreman / Tinker 等 agent 与 Workflow Skill 命令 |
| `sidebar` | `opencode-quota-zh`、`opencode-sidebar-host-zh`、`opencode-session-data` 与四张卡片 | 侧栏与额度：`/quota` 命令、卡片和共享会话统计都在此组 |
| `alone` | `gpt-reset-credits` | 独立插件；需要 Python 3.10+ |

组之间无依赖，可任意组合；组内依赖插件（含隐藏共享库 `opencode-enhanced-sidebar-zh`）随组整体安装。
想要 `/quota` 命令需安装 `sidebar` 组。非交互环境（CI／重定向）请显式使用 `--all` 或 `--only` / `--without`，
不带参数会报错退出而不静默全装。

安装器默认不会覆盖已有 OpenCode 配置；按本次选择裁剪的合并片段生成在 bundle 的
`docs/MERGE-SELECTED.md`，通用合并方法见 [`docs/MERGE_EXISTING_CONFIG.md`](docs/MERGE_EXISTING_CONFIG.md)。
本包生成且之后未改过的配置会在下次安装时自动备份并更新。

> [!IMPORTANT]
> OpenCode v2 会重载受监视的配置与插件；未受监视的本地依赖变更后请重启服务。
> 升级自聚合侧栏时，必须在 `cli.json` 删除 `opencode-enhanced-sidebar-zh` 条目再加入新宿主和四张卡片；不能同时启用两套展示。安装器默认不修改已有配置。

新宿主的跨插件 JSX 注册通过同一 TUI 进程内的自有版本化接合处实现，并非 OpenCode 官方保证的跨插件 API。正式安装后的人工验收记录见 [`docs/refeactor/SIDEBAR-PHASE2-INSTALL-ACCEPTANCE.md`](docs/refeactor/SIDEBAR-PHASE2-INSTALL-ACCEPTANCE.md)；未勾选的项目不能视为通过。

## 更新

1. 关闭 OpenCode。
2. 重新运行安装器（`install.sh` / `install.ps1`）。交互模式预选上次安装的组件组；用 `--only` / `--without` 可增减组。
3. 已有配置默认保留，按提示用 `docs/MERGE-SELECTED.md` 的片段合并；本包生成且未改过的配置会自动备份并更新。
4. 减少组件组时，bundle 保留未选组的插件文件（已有配置不会指向缺失路径）；按 `docs/MERGE-SELECTED.md` 的清单删除配置条目后该组才真正停用。
5. 重启 OpenCode。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `/quota` | 查看当前 Provider 额度 |
| `/sidebar-cards` | 统一管理已注册卡片的顺序和显隐（不等于禁用插件） |
| `/quota_status` | 诊断认证、价格快照与未定价模型 |
| `Ctrl+P` → `额度设置面板` | 单独打开额度设置面板，切换侧栏部分错误静默；默认在有有效数据时隐藏同一 Provider 的接口错误，`/quota_status` 仍保留诊断信息 |
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
- OpenAI/Codex 凭证：优先由 v2 服务端 `integration.connection` 解析；旧 auth.json 仅兼容回退

本包不包含、不提交 API key、OAuth token、cookie、会话数据库与账户数据；不要分享 auth 文件或未经检查的 `opencode debug config` 输出。

## 故障排查

1. 确认 OpenCode 版本为 2.0.18，且使用 `cli.json` 而非旧 `tui.json(c)`。
2. 运行 `/quota_status` 检查 Provider、价格快照来源与未定价模型。
3. Token 报告为空时，先启动 OpenCode 生成 `opencode.db`，再运行一个有模型用量的会话。
4. 常见症状与解决方案见 [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)。

## 卸载

只想停用部分功能时，重跑安装器并去掉对应组，再按 bundle `docs/MERGE-SELECTED.md` 的清单删除配置条目。

完全卸载：从 `opencode.json(c)` 和 `cli.json` 的 `plugins` 列表删除本包条目，删除：

```text
~/.config/opencode/opencode-zh-bundle/
```

然后重启 OpenCode。卸载不会删除 OpenCode 的登录凭证或会话数据库。

## 许可证与声明

本包自身按 [MIT 许可证](LICENSE) 授权（Copyright © 2026 MinZhi624）；上游项目保留各自许可证，见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

本包不是 OpenCode 官方项目，也不隶属于 OpenCode、OpenAI 或任何上述上游项目与 Provider。
