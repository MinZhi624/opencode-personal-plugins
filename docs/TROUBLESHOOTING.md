# OpenCode v2 故障排查

## 配置条目指向未安装的组件组

选择性安装减少组件组后，若配置里仍有该组条目，插件会继续加载（bundle 保留未选组的文件）；
若手动删过 bundle 里的插件目录而配置条目还在，OpenCode 会报找不到插件路径。
按 bundle `docs/MERGE-SELECTED.md` 的"未选组需要删除的条目"清单删除对应条目，或重跑安装器
并用 `--replace-config` 写入按当前选择生成的模板（会先备份）。

## 版本或配置不兼容

本包跨插件侧栏接合处按 OpenCode 2.0.18 验证；额度后端 `opencode-quota-zh` 固定上游 v6，要求 OpenCode 2.0.26+ 与 SDK `@opencode/plugin` 2.0.31。确认 `opencode --version`，并检查：

- 服务端配置为 ~/.config/opencode/opencode.json(c)，键名为 plugins。
- 终端配置为 ~/.config/opencode/cli.json，schema 为 https://opencode.ai/v2/cli.json。
- 不再使用 tui.json(c)。

## 找不到包或模块

在 bundle 根目录执行 npm ci --omit=dev --ignore-scripts --no-audit --no-fund。
全部插件共用根目录 node_modules，不要进入插件目录分别安装，也不要运行
npm audit fix --force。

## 侧边栏不显示或重复

确认 cli.json 中本包各插件条目没有重复注册（同一插件只出现一次），旧 v1
入口与聚合入口必须删除。配置支持重载；若本地依赖未被监视，重启 OpenCode 服务。

## 侧栏排序／隐藏未生效，或统一窗口／直接命令无法保存

运行 `/sidebar-host-status` 查看配置来源、文件路径、实际顺序和可写状态。排序／显隐只读取宿主 `options.sidebarCards.order/hidden`；卡片必须已注册，填目录名或未适配插件名不会自动产生卡片。隐藏／未加载项占位，旧 storage 不再覆盖文件。

确认全局 `cli.json` 只有一个宿主条目，路径确实指向当前加载的宿主包目录，JSON 格式可解析且没有重复键；文件和父目录须可写。符号链接、`OPENCODE_CLI_CONFIG_CONTENT` 覆盖、文件占用或写入冲突会拒写，不回退存档。按失败对话框只合并宿主参数；其他窗口未同步时重启 TUI，或打开 `/sidebar-cards` 重新读取。

异常退出若遗留 `cli.json.sidebar-host.lock`，先关闭全部 TUI、确认无写入进程，再手动删除锁文件后重试，不要删除配置文件。首次导入旧排序必须通过 `/sidebar-host-import` 预览确认；已有 `sidebarCards` 时不覆盖，读不到旧存档不代表已迁移。重装默认保留窗口或命令修改过的配置。

两种保存语义不要混：`/sidebar-cards` 统一窗口按设置页草稿，编辑只预览，显式保存才持久化，放弃恢复该页已保存状态；`/sidebar-host-show|hide|up|down <卡片ID>` 等直接命令即时保存。窗口保存前会重读检测外部修改，发现冲突只提示、不静默覆盖。归属上，宿主偏好与技能私有选项走 `cli.json` 文件安全写入，上下文展开状态、子代理排序与条数继续由各自插件的会话存储（SDK storage）拥有；保存失败时草稿保留、错误明确，不会谎报成功。

## 统一窗口改动不生效或与其他窗口不同步

本包不承诺跨窗口热同步。统一窗口保存成功后，其他已打开的窗口可能仍显示旧值：重启其 TUI，或重新打开 `/sidebar-cards` 重新读取。直接编辑 `cli.json` 后同理，依赖 CLI 重载；未同步时重启 TUI。

若怀疑保存未持久化：关闭窗口时不选保存即为放弃，只恢复该页已保存状态，不会写入文件；重开窗口看到的应是上一次显式保存的结果。

## 侧栏进度条样式不符合预期

侧栏专属的整体进度条样式与单卡覆盖只在 `/sidebar-cards` 调整，作用范围仅限本套侧栏；`/quota_settings` 里的形状设置作用于 Quota 各展示位置（报表、状态栏、Home footer、通知等），两者互不改写，改了其中一处不会联动另一处。

生效形状按优先级取：明确的卡片样式覆盖 > 明确的整体进度条样式 > 卡片原有设置或默认形状；窗口界面会标明当前继承来源。没有新增样式配置时沿用卡片原设置或默认值，首次打开窗口不会批量重写旧配置。选择 `none` 只去掉图形，数值仍显示；额度条始终表示剩余比例，上下文条始终表示已用比例，子代理和技能没有进度条。

## 额度卡片不显示或怀疑有份额度

侧栏额度是 Quota 原生展示经本地 Adapter 接入宿主的唯一一份（稳定身份 `quota`），不恢复旧定制卡片，也不保留旁路独立挂载。看不到额度时：先用 `/sidebar-host-status` 确认 `quota` 在 `order` 且不在 `hidden`；再确认 `cli.json` 中额度相关插件条目没有重复注册（同一插件只出现一次），旧 v1 入口与聚合入口已删除。`/quota` 能打开说明后台与命令正常，问题在宿主排列或卡片注册。

隐藏额度卡片不停止后台，也不影响 `/quota` 等独立命令；停用后台是独立操作，届时卡片显示“额度后台未启用”。查询失败、暂无数据等状态按原生规则呈现，不会显示为 0%。

## API 标价估算缺失

“未定价”表示某条实际模型缺少 models.dev 价格，不代表免费。分页失败或历史取数不完整
时，插件不会把部分数据显示为完整总额。OAuth 产生的原生费用为零也不改变 API 标价估算。

行内状态的口径：

- 「加载失败」= 首轮取数失败且没有任何已聚合用量，不是“本会话没有用量”；
- 「（不完整）」= 已显示金额但历史未取全，不能当作完整总额；
- 完全没有费用行 = 取数成功且会话没有带 Token 的 assistant 消息。

## 额度查询异常（v6）

- 额度命令统一到 v6 窗口：`/quota`（额度）、`/quota_usage`（用量）、`/quota_status`（诊断）、`/quota_settings`（设置）。价格刷新入口在用量页，维护公告在插件页；旧的 `/pricing_refresh`、`/quota_announcements`、`/quota_alerts` 不再提供。
- 查询失败不显示为 0% 或免费；保留旧数据时会标注刷新失败与上次成功时间，不把旧额度当成刚查询的结果。未定价模型保留 Token 并标记“未定价”。
- 配置权威为 `~/.config/opencode/opencode-quota/settings.jsonc`（遵循 XDG）。旧 `opencode-quota-zh/config.jsonc`、`config.json` 自动迁移（追加、不覆盖、保留旧文件）；v6 不支持 project 级设置，旧 project 文件需手工合并。
- 多账号、active 标记与“不支持额度查询”状态由上游 v6 判定；Codex CLI 登录文件回退已移除，此前仅靠该回退恢复的额度升级后可能不可用，需在 OpenCode 中重新连接。

## 子代理费用或状态缺失

任务树只按 OpenCode v2 提供的父子会话关系与 execution/tool 事件归并。若事件没有提供
子会话 ID，条目仍可显示，但会话跳转、真实取消与子会话费用会隐藏。取消失败不会伪装成
已取消。

## 重置卡找不到凭证

先用 /connect 连接 OpenAI/ChatGPT。插件优先通过 v2 服务端 integration.connection
解析当前活动 OAuth 凭证，只把 access token 传给同一次 Python helper 进程；不会把 token
返回给 TUI。CODEX_AUTH_PATH 与旧 auth.json 仅作兼容回退。

兑换前会重新查询并比对快照。拒绝权限、快照变化、uncertain 或任何失败都不会自动重试。

## Windows

需要 Node.js 26.4+（随附 OpenTUI 声明 node >=26.4.0）和 Python 3.10+。可用 OPENCODE_PYTHON 指向 Python 可执行文件；
不要在变量中附加参数。
