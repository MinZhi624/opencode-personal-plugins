# OpenCode v2 故障排查

## 版本或配置不兼容

本包固定支持 OpenCode 2.0.12。确认 opencode --version，并检查：

- 服务端配置为 ~/.config/opencode/opencode.json(c)，键名为 plugins。
- 终端配置为 ~/.config/opencode/cli.json，schema 为 https://opencode.ai/v2/cli.json。
- 不再使用 tui.json(c)。

## 找不到包或模块

在 bundle 根目录执行 npm ci --omit=dev --ignore-scripts --no-audit --no-fund。
四个插件共用根目录 node_modules，不要进入插件目录分别安装，也不要运行
npm audit fix --force。

## 侧边栏不显示或重复

确认 cli.json 只保留一份三个 v2 入口，并按额度、会话概览、子代理排序。旧 v1
入口与聚合入口必须删除。配置支持重载；若本地依赖未被监视，重启 OpenCode 服务。

## API 标价估算缺失

“未定价”表示某条实际模型缺少 models.dev 价格，不代表免费。分页失败或历史取数不完整
时，插件不会把部分数据显示为完整总额。OAuth 产生的原生费用为零也不改变 API 标价估算。

行内状态的口径：

- 「加载失败」= 首轮取数失败且没有任何已聚合用量，不是“本会话没有用量”；
- 「（不完整）」= 已显示金额但历史未取全，不能当作完整总额；
- 完全没有费用行 = 取数成功且会话没有带 Token 的 assistant 消息。

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

需要 Node.js 22.6+ 和 Python 3.10+。可用 OPENCODE_PYTHON 指向 Python 可执行文件；
不要在变量中附加参数。
