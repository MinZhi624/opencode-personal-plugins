# OpenCode 中文插件整合包

<p align="center">OpenCode 本地中文插件整合包：额度、Token 用量、API 标价估算与工程工作流。</p>

<p align="center">
  <a href="#版本记录"><img alt="版本" src="https://img.shields.io/badge/版本-v1.0.0-blue?style=flat-square" /></a>
  <a href="https://opencode.ai/v2/docs/"><img alt="OpenCode" src="https://img.shields.io/badge/OpenCode-2.0.18-blue?style=flat-square" /></a>
  <a href="https://nodejs.org/"><img alt="Node.js" src="https://img.shields.io/badge/Node.js-%E2%89%A526.4-339933?style=flat-square" /></a>
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
- **手动控制优先于自动判断。** Workshop 的角色切换、委派范围、TDD、验证范围都由用户显式选择，插件不自动切档、不默认扩张任务、不默认重审查。

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

- Node.js 26.4 或更高版本、npm
- Python 3.10 或更高版本（仅安装 `alone` 组的 `gpt-reset-credits` 时需要）
- OpenCode：跨插件侧栏接合处按 **2.0.18** 验证；额度后端 `opencode-quota-zh` 固定上游 v6，要求 OpenCode **2.0.26+** 与 SDK `@opencode/plugin` **2.0.31**（以更高者为准并须人工验收）
- Node 基线取 26.4+：随附 OpenTUI `0.5.17` 自身声明 `node >=26.4.0`，bundle 基线与之对齐，不再保留低版本 Node 的 engine 告警风险

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
| `workshop` | `opencode-matt-workshop` | 工作流：Drafter / Tinker / Foreman、四个 Worker、25 个 Workflow Skill |
| `sidebar` | `opencode-quota-zh`、`opencode-sidebar-host-zh`、`opencode-session-data` 与四张卡片 | 侧栏与额度：`/quota` 命令、卡片和共享会话统计都在此组 |
| `alone` | `gpt-reset-credits` | 独立插件；需要 Python 3.10+ |

组之间无依赖，可任意组合；组内依赖插件（含隐藏共享库 `opencode-enhanced-sidebar-zh`）随组整体安装。
想要 `/quota` 命令需安装 `sidebar` 组。
非交互环境（CI／重定向）请显式使用 `--all` 或 `--only` / `--without`，
不带参数会报错退出而不静默全装。
交互终端安装结束后会显示结果并等待按 Enter 退出；非交互安装不会等待。

安装器默认不会覆盖已有 OpenCode 配置；按本次选择裁剪的合并片段生成在 bundle 的
`docs/MERGE-SELECTED.md`，通用合并方法见 [`docs/MERGE_EXISTING_CONFIG.md`](docs/MERGE_EXISTING_CONFIG.md)。
本包生成且之后未改过的配置会在下次安装时自动备份并更新。

> [!IMPORTANT]
> OpenCode v2 会重载受监视的配置与插件；未受监视的本地依赖变更后请重启服务。
> 升级自聚合侧栏时，必须在 `cli.json` 删除 `opencode-enhanced-sidebar-zh` 条目再加入新宿主和四张卡片；不能同时启用两套展示。安装器默认不修改已有配置。

新宿主的跨插件 JSX 注册通过同一 TUI 进程内的自有版本化接合处实现，并非 OpenCode 官方保证的跨插件 API；仅按 OpenCode 2.0.18 验证，升级须重新验收。接合处契约与迁移注意见 [`opencode-sidebar-host-zh`](plugins/opencode-sidebar-host-zh/README.md) 与 [`opencode-quota-card-zh`](plugins/opencode-quota-card-zh/README.md)。

侧栏排列以全局 `cli.json` 中唯一宿主条目的 `options.sidebarCards` 为准：`order` 为稳定卡片 ID 数组（如 `sessionOverview`、`quota`、`subagents`、`skill`），`hidden` 为隐藏 ID 数组。统一窗口与直接命令写回同一文件；失败时只读降级并给出手动片段，不另存排序。改过的文件属于用户自定义，重装默认保留，不会重置顺序。旧 storage 仅可显式导入，不能覆盖已有文件设置。第三方接入见 [对接指南](plugins/opencode-sidebar-host-zh/INTEGRATION.md)，不提供任意插件自动适配。

### 统一展示控制窗口

`/sidebar-cards` 是本套卡片的统一入口：排列、显隐、整体进度条样式、单卡覆盖，以及四张卡片各自适用的展示选项都在同一窗口按页管理；窗口与卡片统一主题、标题、间距与中文对齐，但各卡片保留适合自身内容的布局。编辑即时预览，显式保存才持久化；放弃恢复对应页已保存状态；有未保存修改时关闭或切页会要求保存／放弃／继续编辑，不静默丢失。保存失败保留草稿并明确报错，成功以重新读取文件后的结果为准。宿主偏好与侧栏形状偏好写入上述宿主条目，技能私有选项写入技能条目，均保留其他插件条目与注释，检测到外部修改时提示冲突、不静默覆盖；上下文展开状态、子代理排序／条数／保留期限继续由各自插件的会话存储拥有，统一窗口只经各所有者已有的读写能力保存，不建立第二份存储。

`/sidebar-host-show|hide|up|down <卡片ID>` 等直接命令保持即时保存语义，与窗口草稿是两套交互。本包不承诺跨窗口热同步：其他窗口未同步时重启其 TUI，或重新打开 `/sidebar-cards` 重新读取。

进度条形状可选 `blocks`、`shades`、`line`、`squares`、`dots`、`none`（`none` 只去掉图形，数值仍显示）。优先级为明确的单卡覆盖 > 明确的整体样式 > 卡片原有设置或默认形状，界面标明继承来源；首次使用不批量重写旧配置。该样式只作用于本套侧栏，不改变 `/quota` 报表、状态栏、Home footer 或通知；额度条仍表示剩余比例，上下文条仍表示已用比例，子代理和技能没有虚构进度。

侧栏额度是 Quota 原生展示经本地 Adapter 接入宿主的唯一一份（稳定身份 `quota`），遵循宿主顺序与显隐，采用原生行布局，不再以旧固定 20 格、多行结构和已用／剩余双百分比为准；原生数据、重置、刷新与错误状态按原规则呈现，未知不显示为零。额度设置仍由 `~/.config/opencode/opencode-quota/settings.jsonc` 单一所有者管理，`/quota`、`/quota_settings` 等原生入口保留；隐藏卡片、禁用卡片插件、停用额度后台是三种互相独立的操作。使用与人工验收交接见 [侧栏统一展示控制：使用说明与人工验收](docs/sidebar-ui-manual-acceptance.md)。

## 更新

1. 关闭 OpenCode。
2. 重新运行安装器（`install.sh` / `install.ps1`）。交互模式预选上次安装的组件组；用 `--only` / `--without` 可增减组。
3. 已有配置默认保留，按提示用 `docs/MERGE-SELECTED.md` 的片段合并；本包生成且未改过的配置会自动备份并更新。
4. 减少组件组时，bundle 保留未选组的插件文件（已有配置不会指向缺失路径）；按 `docs/MERGE-SELECTED.md` 的清单删除配置条目后该组才真正停用。
5. 重启 OpenCode。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `/quota` | 查看当前 Provider 额度（v6 统一窗口的额度视图） |
| `/quota_usage` | 用量视图；可带范围 today、24h、7d、30d、90d、all、session、between YYYY-MM-DD YYYY-MM-DD |
| `/quota_settings` | v6 设置页：进度条样式、参考线、倒计时格式、额度行名称／显隐／顺序、Provider 顺序；草稿可预览、保存或放弃 |
| `/quota_status` | 诊断认证、Provider、价格快照来源与未定价模型、维护公告；价格刷新入口在用量页 |
| `/sidebar-cards` | 统一展示控制窗口：排列／显隐、整体进度条样式与单卡覆盖、各卡片展示选项；按页草稿、显式保存（不等于禁用插件） |
| `/sidebar-host-show` `hide` `up` `down` `<卡片ID>` | 直接命令：即时保存顺序／显隐，与统一窗口的按页草稿是两套语义 |
| `/sidebar-host-import` `/sidebar-host-status` | 显式导入旧设置／查看文件配置与注册诊断 |
| `/tokens_today` `/tokens_weekly` `/tokens_monthly` `/tokens_all` `/tokens_session` | 上游遗留别名，默认不列出，映射到 `/quota_usage` 对应范围；可在 `/quota_status` 开启 |
| `/gpt-reset-credits` | 查询 ChatGPT 重置卡；带“兑换”参数表示确认兑换 |

`/quota_settings` 的形状设置作用于 Quota 各展示位置；本套侧栏专属的整体进度条样式与单卡覆盖只在 `/sidebar-cards` 调整，两者互不改写。

Workshop（`workshop` 组）把上游 Matt Pocock Skills `v1.2.3` 的 25 个 Promoted Skills 适配为 OpenCode Skill：普通技能按需由模型发现，user-only 技能不向模型主动展示，并开放用户侧原生技能菜单入口；不注册自定义命令执行器。TDD、独立完整 review、多方案设计、spec / tickets 等重量级工作流按约定只在明确要求时启动。这是提示词层面的行为约定，不是硬权限；隐藏发现也不禁止已知 ID 的加载。角色说明见 [opencode-matt-workshop](plugins/opencode-matt-workshop/README.md)。

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
- 模型价格快照：由额度服务端统一选择与刷新，侧栏统计经 RPC 镜像；价格缓存只保留模型 ID 与价格字段，不保存消息正文或凭证
- 额度凭证：`opencode-quota-zh` 仅由上游 v6 服务端处理（v2 `integration.connection`），不再读取 Codex CLI 登录文件回退；`gpt-reset-credits` 的重置卡查询仍保留其 `CODEX_AUTH_PATH` 兼容回退

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

- 公开文档只覆盖用法与核心设计原则；内部设计与讨论记录不随安装包分发，安装后可用的文档见 bundle 的 `docs/`。
- OpenCode 兼容基线为 2.0.18；升级 OpenCode 后须按上文重新验收自有接合处。

## 许可证与声明

本包自身按 [MIT 许可证](LICENSE) 授权（Copyright © 2026 MinZhi624）；上游项目保留各自许可证，见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

本包不是 OpenCode 官方项目，也不隶属于 OpenCode、OpenAI 或任何上述上游项目与 Provider。
