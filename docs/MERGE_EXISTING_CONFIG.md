# 合并到已有 OpenCode v2 配置

本分支只支持 OpenCode 2.0.12。安装器默认保留已有配置；合并前请自行备份。

## 服务端：opencode.json(c)

把 config/opencode.jsonc 中的条目合并到现有配置：

- 使用复数键 plugins、agents、permissions，不要保留 v1 的 plugin、agent、permission。
- plugins 数组追加额度、重置卡和 Workshop 三个目录入口；2.0.12 的配置加载器不接受指向入口文件的路径。Workshop 使用 { package, options } 对象式选项。
- 七个 Workshop agent 的占位定义必须保留，插件会通过 v2 agent transform 填入 system、模型与权限。
- 权限动作使用 shell 与 subagent，不要使用 v1 的 bash 与 task。
- 重置卡查询可设为 allow，兑换必须保持 ask。

不要建立第二个同名键。Provider、MCP 和其它已有设置继续保留。

## 终端：cli.json

OpenCode v2 的终端配置只有全局 ~/.config/opencode/cli.json。把模板中的额度包与增强侧栏包
追加到 plugins；增强侧栏按“会话概览 → 子代理”顺序注册，并可通过 options 分别关闭。schema 必须是
https://opencode.ai/v2/cli.json。

2.0.12 应加载插件包目录，由包的 exports["./tui"] 选择 CLI 入口；不要直接配置源码 TSX。
删除旧 tui.json(c) 中本包的 v1 入口，避免重复面板。

## v1 回退

oc-v2 不维护双入口。需要回退时：

1. 恢复安装前的 opencode.json(c) 与 tui.json(c) 备份；
2. 删除或移走 v2 的 cli.json 本包条目；
3. 切回仓库 master，按 master 的安装说明重新安装；
4. 不要把 v2 自有持久化记录复制回 v1。

配置与受监视插件可由 v2 重载；若改动了未受监视的本地依赖或运行产物，重启服务。
不要公开未经检查的配置诊断输出，其中可能含私有 Provider 信息。
