# OpenCode 中文插件整合包

<p align="center">OpenCode 本地中文插件整合包：额度、Token 用量、API 标价估算与工程工作流。</p>

<p align="center">
  <a href="#版本记录"><img alt="版本" src="https://img.shields.io/badge/版本-v1.0.0-blue?style=flat-square" /></a>
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
| `opencode-sidebar-host-zh` / `opencode-session-data` | TUI | 排序／显隐宿主和独立共享会话统计 | [README.md](plugins/opencode-sidebar-host-zh/README.md) |
| `opencode-quota-card-zh` / `opencode-session-overview-zh` / `opencode-subagent-card-zh` / `opencode-skill-panel` | TUI | 可分别启停的额度、上下文、子代理、技能卡片 | [README.md](plugins/opencode-quota-card-zh/README.md) |
| `opencode-matt-workshop` | Server | Drafter、Foreman、Tinker 与 Workflow Skill | [README.md](plugins/opencode-matt-workshop/README.md) |
| `gpt-reset-credits` | Server | ChatGPT 重置卡查询与确认兑换 | [README.md](plugins/gpt-reset-credits/README.md) |

## 核心设计原则

侧栏、额度与工作流三部分共享同一组取舍，改动前先对照：

- **上游核心少改。** Provider 支持、额度查询、缓存与核心计算沿用上游；不为中文样式、卡片位置或显示开关深入修改上游核心。必要的 OpenCode v2 兼容补丁集中管理并记录原因和适用版本。
- **适配层隔离上游变化。** 上游结果先转换为本地稳定的数据契约，卡片不直接依赖上游内部文件；上游接口变化优先在适配层解决。
- **凭据留在服务端。** 需要凭据的额度查询在服务端完成，TUI 只消费结构化非敏感数据，不取得 access/refresh token。
- **一份数据，多处展示。** 共享统计模块只负责数据与计算（消息读取、Token、价格、会话关系、TPS），不负责卡片布局；关掉一张卡片不影响其他卡片消费同一结果。
- **宿主只管排列。** 宿主用 `append: "sidebar.content"` 追加到原生侧栏，只管理本套新增卡片的顺序与显隐，不接管 Provider 查询和业务计算。
- **三种操作互相独立。** 隐藏卡片（显示偏好）、禁用卡片插件（撤销注册并清理）、停用额度后台（停止数据能力）不是同一件事，不互相暗中控制。
- **估算不是账单。** Token 费用是按 models.dev 公开单价的估算，不等于 Provider 实际账单，也不等于 ChatGPT 订阅额度；无价格的模型显示“未定价”，不伪装成 `$0`。
- **手动控制优先于自动判断。** Workshop 的角色切换、TDD、验证范围都由用户显式选择，插件不自动切档、不默认扩张任务。

各插件的详细边界见上文表格中的独立说明；本包的取舍记录以代码注释和上述原则为准。

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
bash install.sh                 # ↑↓ 移动、空格勾选、Enter 确认（预选上次安装的组合）
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
交互终端安装结束后会显示结果并等待按 Enter 退出；非交互安装不会等待。

安装器默认不会覆盖已有 OpenCode 配置；按本次选择裁剪的合并片段生成在 bundle 的
`docs/MERGE-SELECTED.md`，通用合并方法见 [`docs/MERGE_EXISTING_CONFIG.md`](docs/MERGE_EXISTING_CONFIG.md)。
本包生成且之后未改过的配置会在下次安装时自动备份并更新。

> [!IMPORTANT]
> OpenCode v2 会重载受监视的配置与插件；未受监视的本地依赖变更后请重启服务。
> 升级自聚合侧栏时，必须在 `cli.json` 删除 `opencode-enhanced-sidebar-zh` 条目再加入新宿主和四张卡片；不能同时启用两套展示。安装器默认不修改已有配置。

新宿主的跨插件 JSX 注册通过同一 TUI 进程内的自有版本化接合处实现，并非 OpenCode 官方保证的跨插件 API；仅按 OpenCode 2.0.18 验证，升级须重新验收。接合处契约与迁移注意见 [`opencode-sidebar-host-zh`](plugins/opencode-sidebar-host-zh/README.md) 与 [`opencode-quota-card-zh`](plugins/opencode-quota-card-zh/README.md)。

侧栏排列以全局 `cli.json` 中唯一宿主条目的 `options.sidebarCards` 为准：`order` 为稳定卡片 ID 数组（如 `sessionOverview`、`quota`、`subagents`、`skill`），`hidden` 为隐藏 ID 数组。`/sidebar-cards` 写回同一文件；失败时只读降级，不另存排序。菜单改过的文件属于用户自定义，重装默认保留，不会重置顺序。旧 storage 仅可显式导入，不能覆盖已有文件设置。第三方接入见 [对接指南](plugins/opencode-sidebar-host-zh/INTEGRATION.md)，不提供任意插件自动适配。

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
| `/sidebar-cards` | 统一管理卡片顺序／显隐，保存到 cli.json（不等于禁用插件） |
| `/sidebar-host-import` `/sidebar-host-status` | 显式导入旧设置／查看文件配置与注册诊断 |
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

## 版本记录

当前版本 **1.0.0**，与 `package.json` 及各插件 `package.json` 的 `version` 字段一致；root README 徽章随该版本号更新。

- 公开文档只覆盖用法与核心设计原则；内部设计、原型与验收记录不随安装包分发。
- OpenCode 兼容基线为 2.0.18；升级 OpenCode 后须按上文重新验收自有接合处。

## 许可证与声明

本包自身按 [MIT 许可证](LICENSE) 授权（Copyright © 2026 MinZhi624）；上游项目保留各自许可证，见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

本包不是 OpenCode 官方项目，也不隶属于 OpenCode、OpenAI 或任何上述上游项目与 Provider。
