# 项目任务追踪 Footer

OpenCode V2 Server + TUI 插件，兼容验收基线 2.0.18。读取本地 Matt tickets 或当前项目 GitHub 未结 issue，真正追加到 `sidebar.footer`，不参与内容卡片排序。

在 `opencode.jsonc`（server 入口）与 `cli.json`（TUI 入口）中各加载一次即可启用。插件独立可用：不依赖
Matt Workshop 角色、Workflow Skill 或侧栏宿主，也不要求 `sidebar` 组；正常 bundle 安装由 `workshop` 组
携带。运行与静态检查的结果须分别确认。

- `/task-settings`：当前项目来源选择、footer 显隐；配置不明确时请主动选择来源。
- `/task-list`：完整清单（含本地已处理），查看详情及依赖、标记或撤销。
- `/task-refresh`：手动刷新。启用期间也每 60 秒刷新；失败显示不可用或旧数据，不假装没有任务。

本地标记只影响侧栏投影，按项目与来源持久化、跨会话共享，参与依赖解锁；相关任务明确标注本地修正。**不会关闭 GitHub issue、修改文件、验收条件、标签或原始依赖，也不触发实际执行。** 完整列表可撤销，普通刷新不清除标记。

任务区顶部有分割线；单击标题可以整体收起或展开，按项目记住折叠偏好。条目与操作使用单击释放，不要求长按。状态同时保留符号与主题色：可开始用成功色，受阻用警告色，待确认用错误色，本地修正用主强调色。收起不停止刷新、不删除标记，也不隐藏原生 footer。

TUI 不读取本地项目文件或认证凭据，数据来自当前连接的 server。GitHub 读取需要 server 环境已有可用鉴权；安装本插件不会替用户登录。

尚未识别的状态、缺失或异常依赖显示待确认。验收勾选和 ready-for-agent 标签不代表完成；未结清单缺少某个 blocker 也不代表它已结。默认展示最多四条，不限制完整读取或存档数量。

隐藏 footer 不删除存档或停止数据能力；禁用插件会释放其请求、轮询与挂载。不要把静态类型检查通过当作 TUI、鉴权或跨窗口持久化验收通过。

## 本地格式（Matt tickets 约定，只读）

按本地 `to-tickets` Skill 模板的「一票一文件」约定，读取当前项目 `.scratch/<功能>/issues/<NN>-*.md` 下的全部功能目录；`.scratch/` 根目录的 spec 与地图索引不算 ticket，也无需先选功能或计划。

- **一票一文件、编号隔离**：编号取文件名开头数字，任务标识为 `<功能>/<编号>`（如 `task-tracking-footer/05`）；`Blocked by` 只在本功能内解析，不同功能的同号票互不影响。
- **标题与头部字段**：标题取文件内首个 Markdown 标题（展示时去掉编号前缀）；首个 `##` 小节或首个验收勾选之前的 `What to build`、`Blocked by`、`Status`、`Type`、`Spec`、`Priority` 等键值行即头部字段（大小写不敏感），其中只有 `Status`、`Type`、`Blocked by` 参与状态判断。
- **验收勾选**：文中任意 `- [ ]` / `- [x]` 行都是验收条件，保留原始勾选状态；只展示交付要求，不据此推断完成。
- **依赖**：`Blocked by: None — …` 表示无阻塞，否则按逗号或换行分段取每段开头的编号；同功能重复编号、引用不存在的编号、或提不出编号的引用都会显示待确认，不静默解锁。
- **状态语义**：Wayfinder 决策票（含 `Type:` 行）`Status: resolved` 为来源终结，`claimed` 为已认领、不作可开始候选；普通实现票（无 `Type:` 行）没有统一本地终结约定，来源侧永不判结，只有 `Status: ready-for-agent` 是可开始候选，其余只作可见的未结项。
- **普通任务如何收尾**：在 `/task-list` 用本地标记「已处理」归档——可撤销的侧栏投影修正，参与依赖解锁，但不改 Markdown、不伪造完成，来源文件仍是唯一事实。
- **来源识别**：仅当项目存在 `docs/agents/issue-tracker.md` 且写明 `Issue tracker: local markdown` 或 `Issue tracker: github` 时据此提示来源；git remote 或凭空出现的 `.scratch/` 不会静默选定，请在 `/task-settings` 显式选择。

## GitHub 读取（兼容普通 issue）

通过 `gh` CLI 只读当前仓库全部未结 issue（完整分页、排除 PR）。普通 issue 同样进入未结清单，但**没有标签不会默认可开始**：只有 `ready-for-agent` 标签，或 `wayfinder:research` / `prototype` / `grilling` / `task` 且无人认领（无 assignee）的 issue 才是可开始候选；`wayfinder:map` 不候选。阻塞优先读取平台原生依赖，不可用时回退正文 `## Blocked by` 小节或行内 `Blocked by: #n` 约定。引用的已结 blocker 按真实状态以已结项出现——不在未结清单不等于已完成。平台开闭状态是唯一来源终结事实，本地标记只影响侧栏显示。
