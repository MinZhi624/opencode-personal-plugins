# 合并到已有 OpenCode v2 配置

侧栏模块化接合处目前仅按 OpenCode 2.0.18 的原型结果设计；正式安装版还需人工验收。安装器默认保留已有配置；合并前请自行备份。

> 按本次安装选择裁剪好的逐条片段见安装器生成的 `MERGE-SELECTED.md`（位于 bundle 的 `docs/` 下）；本文是通用方法与注意事项。

## 服务端：opencode.json(c)

把 config/opencode.jsonc 中的条目合并到现有配置：

- 使用复数键 plugins、agents、permissions，不要保留 v1 的 plugin、agent、permission。
- plugins 数组追加额度、重置卡和 Workshop 三个目录入口；2.0.12 的配置加载器不接受指向入口文件的路径。Workshop 使用 { package, options } 对象式选项。
- 七个 Workshop agent 的占位定义必须保留，插件会通过 v2 agent transform 填入 system、模型与权限。
- 权限动作使用 shell 与 subagent，不要使用 v1 的 bash 与 task。
- 重置卡查询可设为 allow，兑换必须保持 ask。

不要建立第二个同名键。Provider、MCP 和其它已有设置继续保留。

## 终端：cli.json

OpenCode v2 的终端配置只有全局 ~/.config/opencode/cli.json。保留 `opencode-quota-zh`（独立额度命令），
将原 `opencode-enhanced-sidebar-zh` 的单个聚合条目**删除并替换为**模板中的
`opencode-session-data`、`opencode-sidebar-host-zh`、`opencode-session-overview-zh`、
`opencode-subagent-card-zh`、`opencode-quota-card-zh`、`opencode-skill-panel` 六个条目。
不要同时加载聚合入口和四张新卡，否则会重复展示、重复统计监听。schema 为
https://opencode.ai/v2/cli.json。

旧聚合入口的 `subagentsSortOrder`、`subagentsMaxEntries`、`subagentsTtlDays` 选项移到子代理卡片；
`skillPanelMaxUsed`、`skillPanelDefaultOpen` 移到技能卡片。旧的 `sessionOverview`、`subagents`、
`skillPanel` 启用选项现在由**是否加载对应插件**表达；需要隐藏而不禁用时用 `/sidebar-cards` 菜单。
宿主与数据模块互不依赖；关闭额度卡片不影响 `opencode-quota-zh` 的命令及服务端 RPC。
若旧选项有 `false`，首次切换前可从 `plugins` 移除对应卡片，或在宿主选项中填入旧设置
`legacySettings: {"version":1,"order":["quota","sessionOverview","subagents","skill"],"hidden":[...旧隐藏项]}`；
旧插件的持久化空间可能按插件隔离，宿主读不到时不会宣称已迁移。切换后检查 `/sidebar-host-status` 的迁移状态，
逐项核对旧顺序、显隐、概览折叠及子代理记录，**不要在未核对时删除旧插件的存档或回退配置**。

若升级后子代理卡展开为空而旧聚合卡有记录，在关闭 TUI 前先备份状态；OpenCode 2.0.18 的本地安装可从仓库运行 `node scripts/migrate-sidebar-subagents.mjs` 仅查看脱敏计数，再运行 `node scripts/migrate-sidebar-subagents.mjs --apply` 将旧插件命名空间的子代理记录幂等合并到新卡片命名空间。脚本会先备份两个存档，绝不删除旧文件；执行后完全重启 TUI 验证。此脚本不迁移布局和折叠状态，不适用于未验证的其他版本／远程状态路径。

应加载插件包目录，由包的 exports["./tui"] 选择 CLI 入口；不要直接配置源码 TSX。
删除旧 tui.json(c) 中本包的 v1 入口，避免重复面板。

## v1 回退

oc-v2 不维护双入口。需要回退时：

1. 恢复安装前的 opencode.json(c) 与 tui.json(c) 备份；
2. 删除或移走 v2 的 cli.json 本包条目；
3. 切回仓库 master，按 master 的安装说明重新安装；
4. 不要把 v2 自有持久化记录复制回 v1。

配置与受监视插件可由 v2 重载；若改动了未受监视的本地依赖或运行产物，重启服务。
不要公开未经检查的配置诊断输出，其中可能含私有 Provider 信息。
