# opencode-ssh-workshop

用于在本机 OpenCode 里通过 SSH 操作远端 Linux 主机。设计目标是 OpenCode 与模型调用
留在本机，项目文件读写和命令执行落在远端；远端不需要安装 OpenCode。
命令授权专项已在隔离 OpenCode 2.0.31 上完成下述原生权限与记录传输层验证；
真实 SSH 只读传输和小文件写入／上传下载曾通过，TUI 交互尚未验收。这里记录的是
源码与隔离环境状态，不等于当前活动 bundle 已部署。

这是对 [`PedroKlein/opencode-ssh-session`](https://github.com/PedroKlein/opencode-ssh-session)
v0.3.0 的 V2 兼容扩展。上游是 V1 插件，不能直接在 V2 加载（见
[V2 迁移说明](https://opencode.ai/v2/docs/build/plugins/migrate-v1)），因此本插件在新增代码里
适配 V2 与 Node 进程接口，并补上七个 SSH 角色与设备档案。原仓库快照保留在
`vendor/opencode-ssh-session/`，来源见 `upstream-provenance.json`。

## 交付说明（当前状态）

**状态：角色隔离、当前目录标记和断连失败语义通过源码级检查；本地198个案例、隔离2.0.31原生155个案例通过。
仍有已确认的保存审批匹配限制；这不是整套 SSH 插件的真实远端／TUI 验收。**

本轮处理安装依赖顺序、运行时权限门槛、连接身份、grep 退出持久 shell、当前目录标记
和断连失败语义，并增加 SSH 角色隔离。连接初始目录与真实当前目录的边界仍未完整验收；
严格的“每个终端独立选设备”也未实现，见下方限制。

### 本轮修复

1. **干净环境安装**：安装器先暂存文件，等目标 bundle 的 `npm ci` 完成后再从目标布局
   加载 Bash 解析器与 grammar 校验。暂存脚本支持显式延迟检查，安装器不会跳过最终验证。
   已用一个不含 `node_modules` 的临时源码副本完成 `workshop,ssh` 安装。
2. **运行时门槛**：`ssh` 组要求 OpenCode `>=2.0.31`；插件 `setup` 还会检查
   `ctx.permission.assert`，缺失时拒绝加载。2.0.28 选择 SSH 会在安装阶段被拒绝，
   但 `workshop` 单独安装仍可在 2.0.28 完成。
3. **连接身份**：连接复用现在比较目标、附加 `ssh` 参数（端口、密钥、跳板机等）和
   规范化远端目录；参数变化会重建连接，并同步复用连接的设备身份。
4. **grep 生命周期**：grep 包装命令放入子 shell，`exit 0` 不再退出持久 SSH shell；
   匹配、无匹配和真实错误后都能继续执行命令。已在真实设备上读取 `/etc/hostname`
   后继续执行 `hostname`／`whoami`。
5. **SSH 角色隔离**：只认七个 `SSH_AGENT_IDS`，不凭 `ssh-` 前缀放行自定义角色；
   非 SSH 角色无法调用任何插件 SSH 工具，本机 shell 中可静态识别的 `ssh`／`scp`／
   `sftp`（含支持的包装、子 shell 和命令替换）会直接拒绝并提示手动切换。
   设备界面连接也会从服务端会话读取真实角色，而不是信任调用方参数。
6. **当前目录标记**：命令结束标记携带远端 shell 的实际 `pwd`，用于检查当前目录；
   连接时的初始目录与真实当前目录的合并边界仍未完整验收，执行位置有疑问时应先确认
   `pwd` 或使用绝对路径。连接复用仍按初始目录判断。
7. **断连明确失败**：连接在授权或传输期间失效时，`executeCommand` 抛出错误而不是
   返回提示文本；下载不会把错误文本当 Base64 写入本地文件或报告成功。

严格的“每个新终端独立确认设备”尚未实现。当前 SDK 的工具上下文没有终端 ID，
不能用 `sessionID` 标记或 TUI 本地内存冒充；该要求在现有共享服务架构下无法可靠
满足，不能把本次角色隔离视为设备确认门槛。

### 上一轮追加：PS4/-x 风险与原生验收

修复前已用无害标记文件确认：解析器接受 `bash -xc` 加字面量 `PS4` 脚本，资源中只有
Bash 和 `true`，但真实 Bash 跟踪展开实际执行了隐藏的 `printf`，并在临时目录创建了
内容为 `TRIGGERED` 的文件。判断依据是文件存在及内容，不是跟踪输出中出现了命令文字。
未执行真实 `git push`。

上一轮采用保守拒绝：
- 在 AST 赋值、前置赋值、已解码 `env` 参数及 `for` 变量目标中统一拒绝 `PS4` 写入。
- 受支持的 shell 选项不再允许 `x`，覆盖 `-x`、`-xc`、`-cx` 与分离选项形式；
  `eval`、绝对路径和嵌套包装入口复用同一检查。原本不支持的 `-o xtrace` 等仍拒绝。
- 普通数据不受该规则影响，例如 `echo '-x'`、`echo 'PS4=trace'`；
  `bash -c true -x` 中的 `-x` 是位置参数而不是开关，仍允许；`env -u PS4` 也仍允许。
- 不改写原文、不预先发送 `set +x`，保留完整分析、原生授权、最后发送的顺序。

回归脚本保留该无害标记复现：未经插件检查的本地 Bash 创建标记；经真实 SSH 工具
入口的同一输入（包括前面带普通命令）直接拒绝，权限调用和传输写入均为零，标记不产生。

### 已保留的 AST 授权边界

**原因**：原先用 `shell-split.ts` 按 `;`／`&`／`|` 做文本切分，看不见 `$()`、
反引号、`if…then`、子 shell 等结构。于是 `echo "$(git push)"` 只产出一条
`echo "$(git push)"`，`git push*` 的拒绝规则落空；并且对无法分析的写法按原文放行。

第一次 AST 实现仍有漏检：参数未去引号，`-lc`／绝对路径 shell 未识别，包装命令
仍猜测文本后缀，`eval` 多参数也未按实际语义拼接。因此撤回此前「58 项通过即修复完成」的结论。

**本次改法**：`src/shell-parser.ts` 从 AST 还原确定的 argv，生成规范化 `shell`
权限资源；显式支持的包装命令按其选项规则找到实际命令，并递归分析。执行顺序仍为：

```text
解析整条命令 → 提取全部权限相关命令 → V2 原生 shell 规则求值 → 全部通过 → 才写入 SSH stdin
```

- `git 'push'`、`git pu"sh"`、`git pu\sh` 都产出 `git push`；`echo 'git push'`
  只产出 `echo git push`，不会把引用数据当成另一个命令。
- `bash -lc 'git push'`、`/bin/bash -c 'git push'`、`eval git 'push origin main'`
  均递归产出实际脚本中的命令。带路径的可执行文件同时检查原路径和 basename。
- `env "git" push`、`sudo -u root git push`、`command env bash -c 'git push'`
  根据已解码的参数递归分析，不再按空白切后缀。未知包装选项直接拒绝。
- 只有受支持的 AST 节点会被处理；解析成功不代表支持该语法。语法错误、未知节点、
  动态命令名／参数、未知包装入口或超过分析上限 → 直接拒绝，**不按原文降级授权**。
- `$()`／反引号中的可见子命令会被递归检查；但替换结果让外层 argv 不确定时，
  **整条命令直接拒绝**。例如 `echo "$(git push)"` 不发送，也不进入权限询问。
- 支持字面量命令、重定向、列表／流水线、if、while／until、字面量 for、括号／花括号。
  动态展开、here-doc、函数／别名定义、数组／算术、case、声明命令、`source`、`xargs`
  等当前未支持；这包括一些此前放行的写法，是有意收紧，不是兼容全部 Bash。

grammar 随插件分发（来源、SHA-256 与完整许可证见 `grammar/`）。构建核对固定摘要、
复制 WASM／来源说明／许可证，并实际加载解析一次；安装器在目标 bundle 安装依赖后，
再从运行包布局加载解析，避免干净环境在依赖安装前失败。构建同时删除被替换的旧
`dist/src/shell-split.js`，不再随包残留。

**可复跑的验证入口**（不新增测试框架／依赖，不连接远端）：

```bash
npm run verify:ssh-permissions
SSH_VERIFY_OPENCODE=/path/to/opencode-2.0.31 npm run verify:ssh-permissions:native
```

前者走真实编译产物并记录 SSH stdin，检查资源、授权拒绝传播、原文发送、取消（含排队）、
缺失／损坏 grammar、语法和资源限制、源码布局；另用无副作用的本地 Bash 函数对照去引号结果。
其权限边界是明确注入的通过／拒绝，不模拟原生匹配，更不冒充原生验收。

后者使用指定 CLI，在 `/tmp/opencode/` 下创建隔离配置、数据库和临时插件，直接调用
原生 `ctx.permission.assert`，验证 allow／deny／ask、回复、拒绝反馈、取消和零写入；
还验证同次多资源 ask／deny 冲突在两种命令顺序下均直接 deny、不产生待决询问，
以及 `always` 对精确字面量命令在本会话和同项目新会话生效、不扩大为前缀、不能覆盖 deny。
无需模型、SDK 安装或共享服务。

本轮使用官方 npm `@opencode/cli-linux-x64@2.0.31` 的临时二进制，下载到 `/tmp/opencode/`，
完整归档经官方 manifest 的 SHA-512 SRI 校验：

```text
sha512-RYbqR/HzKTH9OSh98VOt78bgQ8sgidUCCCKR9CABSc06AFxZdycezIg8dUmh+uBdp2mf4ckWVq9BbGblbxtFZQ==
```

版本输出及实际 `permission.assert` 能力均已确认，并非仅根据版本号判通过。
未修改全局安装、PATH、仓库依赖或用户已有服务。运行脚本会清理临时服务、配置、数据库和会话。
不指定 `SSH_VERIFY_OPENCODE` 时仍使用全局 CLI：本机2.0.28缺少所需 API，
该运行方式仍会明确报阻塞，不能把隔离验收通过理解为旧环境已兼容。安装器现在也会在
选择 `ssh` 组时拒绝低于 2.0.31 的版本；插件 `setup` 还会再次检查实际能力。

### 已确认且未扩大授权处理的保存限制

仍使用 `save: [整条原文]`，不保存宽前缀或分别放行子命令。原生2.0.31实测：
- `git status --short` 的 `always` 保存后，相同命令免再次询问；`git status --branch` 仍询问。
  即使已有保存审批，随后添加匹配的配置 deny 仍直接拒绝、零写入。
- `git 'status' --porcelain` 及 `git status --porcelain && pwd` 保存原文后，重复执行仍会询问：
  原文模式不能匹配去引号／拆分后的权限资源。单独子命令也未被顺带放行。

后两项作为已确认兼容限制由专项脚本明确输出，而不是宣称所有形式的“始终允许”均已修复。

### 其他遗留（本轮未处理）

上一轮宣称「12 项全部修复」，但其 57 项检查只验证了源码字符串与纯逻辑，
不足以证明修复成立。随后的全量复查发现仍有问题，其中前两项是上一轮引入的：

| 问题 | 位置 |
| --- | --- |
| 去掉 `trim()` 后未消费结束标记自身的换行，下一次命令输出多出开头空行 | `src/session/reader.ts` |
| 会话失败仍匹配旧事件名 `session.error`，当前 SDK 用 `session.execution.failed` | `src/index.ts` |
| 设备编辑需要 `id`，但列表与保存结果都不返回 `id`，自然语言更新走不通 | `src/tools/devices-tool.ts` |
| `temperature` 被选项接受但未应用；单独覆盖 `variant` 也可能被忽略 | `src/options.ts`、`src/index.ts` |

### 检查结果

- `typecheck:ssh-workshop`、`build:ssh-workshop`、`stage:runtime`（402 文件）通过；
  grammar 在源码、编译产物与暂存布局均实际加载解析成功。
- `verify:ssh-permissions`：198个本地案例通过，覆盖 PS4 标记行为、分析拒绝、取消、
  解析故障、权限 API 门槛、连接身份、grep 生命周期、角色隔离、当前目录标记与断连
  零写入；本地注入权限边界不冒充原生规则求值。角色隔离测试还通过真实 `setup`
  验证了 `execute.before` 的注册和委托。
- `verify:ssh-permissions:native`：指定临时2.0.31后155个原生案例通过，使用真实
  `permission.assert` 和记录型 SSH stdin；保存匹配限制如上，未改宽模式来消除提示。
- 干净源码副本（无 `node_modules`）的隔离 `workshop,ssh` 安装通过：目标目录完成
  `npm ci` 后，从 bundle 布局实际加载解析器并输出预期资源；2.0.28 选择 SSH 被拒绝，
  单独安装 `workshop` 仍成功。
- 真实设备只读传输层通过（直接调用编译产物连接层，未经过 OpenCode 工具权限）：
  连接后执行 `hostname`／`whoami`／`pwd`；grep 读取 `/etc/hostname` 后继续执行同一会话
  命令成功。未创建、修改或删除远端文件。
- 真实设备小文件链路通过：`ssh_write` 覆盖写、`ssh_read` 分段读、`ssh_grep`、`ssh_glob`、
  `ssh_upload` 与 `ssh_download` 往返内容一致；`ssh` 的 `cd` 状态在后续命令中保持。
  `ssh_devices` 的 list／save／remove 及使用已保存设备连接均已通过。
- 当前目录标记用真实 Bash 命令载荷验证：`pwd` 的 Base64 值被正确解析并去掉行尾；
  这只证明标记解析，不替代初始目录与真实目录边界的完整验收。断连下载测试确认不会
  调用本地写入。
- `ssh_use.md` 已实际出现在源码根目录、`runtime-stage` 和隔离安装 bundle；stage 的
  必需文件断言包含它，安装器顶层复制缺失会中止安装。
- 最终上述指定环境检查无失败；大文件／并发传输、`/ssh-devices` TUI 及其他已列出的
  功能仍未验收。
- 本轮未修改其他插件、配置模板、默认 Agent 或安装组合。

### 仍未验证 / 已知限制

- **大文件／并发写入未验证**：小文件写入、覆盖读、上传下载已验证；大文件／并发传输、
  Worker 继承设备与目录仍需要专门验收。
- **TUI 未验证**：`/ssh-devices` 的选择、编辑、连接流程没有在终端里实际操作过。
- **角色隔离部署后未复验**：当前活动 bundle 尚未换成这份新代码，因此本轮没有把
  活动会话里的 Code Mode 调用当作新 guard 的运行验收；部署后需要重新验证
  `execute.before` 对真实工具调用的拦截。
- **每终端设备确认未实现**：`sessionID` 不能区分同一会话的多个终端，TUI 本地内存
  也不能被服务端工具上下文读取；不使用弱标记冒充硬限制。
- **存储作用域未验证**：设备档案用 `ctx.storage`；官方文档只说明按插件 ID 作用域，
  重启与切换项目后的共享行为仍未实测。
- **Code Mode 兜底未实测**：`execute.before` 钩子用于阻止 SSH 角色经 `execute` 触达
  本地工具，钩子接线已确认，但运行时是否覆盖嵌套调用未实测。
- **不是沙箱**：只覆盖受支持的 Bash 命令结构和已知调度入口，不解释任意程序内部行为，
  也不读取外部脚本、shell 启动配置或远端预置函数／别名。`npm run`、任意程序的参数语义
  与内部副作用不在静态保障内；不能把危险命令 deny 清单视为任意远端副作用的防护。
- **受支持的包装选项有界**：仅处理明确列出的 `env`、`sudo`、`command`、`builtin`、
  `exec`、`nohup`、`setsid`、`time`、`nice`、`timeout` 选项；其他形式拒绝，不再猜测。
- **不支持本次调用启用 shell 跟踪或写入 PS4**。这不等于检查或清理远端预置的 shell 状态，
  仍不承诺对外部脚本或任意程序内部行为提供沙箱保证。
- **分析上限**：累计脚本文本 100000 字符、32 层嵌套、20000 节点访问、512 条去重资源。
  续行转义目前也会拒绝，避免 grammar 的分词与实际 Bash argv 不一致。
- **模型继承依赖加载顺序**：需要 Workshop 插件先于本插件加载（安装器已保证该顺序）。
  手工配置时若把本插件放在前面，SSH 角色读不到对应角色模型。
- **界面连接会二次确认**：`/ssh-devices` 先弹选择确认，再走一次 `ssh_connect` 权限检查。
  这是有意保留的安全检查，不是重复缺陷。
- **`ssh_read` 截断按字符计数**：`MAX_OUTPUT_BYTES` 实际比较的是字符串长度而非字节数，
  只影响超长输出的截断提示措辞。
- **上游遗留**：`markerRegex` 只转义前后缀、不转义 id；标记 id 由
  `Math.random().toString(36)` 生成（仅 `[a-z0-9]`），实际不会触发，本轮未改动上游行为。

### 对此前交付表述的更正

- **远端命令使用 `shell` action 符合 ADR-0002，不属于偏离设计。** 本地与远端使用
  同名 action 本身不是缺陷；不能因此推断当前授权实现已完成运行验收。
- **仓库 `config/opencode.jsonc` 与 `config/cli.json` 是生成的参考模板。**
  `--all --render config` 只导出这些模板，不能据此声称用户当前生效的 OpenCode 配置
  已被修改、插件已经启用或已部署成功。
- **“已实现”不等于“验收完成”。** 类型检查与构建通过，不证明权限职责、远端操作和
  设备管理满足全部需求。

本轮修改限于 SSH 安装接入、解析器／连接／grep／角色隔离源码、对应编译产物、
`scripts/verify-permissions.mjs` 与相关说明文档；没有修改 `opencode-matt-workshop`、
默认 Agent、其他插件或 quota-zh，也没有暂存、提交、推送或改写 Git 历史。
本次源码修改未自动部署到当前活动 bundle；当前运行配置仍使用已部署的旧版本，
角色隔离需要重新安装或切换 bundle 后才生效。以下功能介绍和配置示例应结合上述
交付状态阅读。

## 能力

沿用上游的六项基础能力：`ssh_connect`、`ssh`、`ssh_disconnect`、`ssh_info`、
`ssh_upload`、`ssh_download`。新增：

| 工具 | 作用 |
| --- | --- |
| `ssh_devices` | 列出、保存、删除设备档案（自然语言入口） |
| `ssh_read` | 读远端文件（本地 `read` 的远端对应物） |
| `ssh_write` | 写远端文件（本地 `write` 的远端对应物） |
| `ssh_glob` | 按 glob 找远端文件 |
| `ssh_grep` | 按正则搜远端文件内容 |

`/ssh-devices` 是中文管理界面，与 `ssh_devices` 工具读写同一份数据。

## SSH 角色

原有角色保留，另加七个对应角色：`ssh-drafter`、`ssh-tinker`、`ssh-foreman` 三个主角色，
`ssh-maker`、`ssh-inspector`、`ssh-archivist`、`ssh-surveyor` 四个 Worker。

- SSH 角色会从工具列表里移除本地文件与 shell 工具，并在执行前兜底拒绝；
  远端对应物是 `ssh_read`、`ssh_write`、`ssh_glob`、`ssh_grep`、`ssh`。
- 只有七个声明的 SSH 角色可以调用 SSH 工具；本机角色调用会被拒绝，并提示手动
  切换。本机 shell 中可静态识别的 `ssh`／`scp`／`sftp` 也会在执行前拒绝。
- 代码按**主会话**管理设备与远端工作目录，设计上供 SSH 主角色与 SSH Worker 共用，
  不同主会话各自连接；真实继承行为尚未运行验收。
- 切回原角色即恢复本机操作方式，不会自动切换角色。
- 默认 Agent 仍是 `tinker`。

## 设备档案

连接成功后自动记住，也可用 `/ssh-devices` 或 `ssh_devices` 手动添加、编辑、删除。
保存的是**非秘密**连接信息：地址、用户名、端口、密钥文件路径、可选远端目录。
不保存密码或私钥内容，沿用上游「仅密钥／SSH agent 认证」的边界。

档案通过 `ctx.storage` 保存，不写入项目 Git。跨本机项目共用是已确认的需求，
但当前实现的真实跨项目共享与重启恢复行为尚未验证，不能仅由存储接口名称推定已经通过。

## 权限

设计上所有入口（含 `/ssh-devices` 界面）使用 V2 权限检查，需要提供 `permission.assert`
的兼容运行时。`ssh` 工具只接受可静态分析的命令，全部资源求值通过后才发送原文：

| 操作 | action | 资源 |
| --- | --- | --- |
| 连接 | `ssh_connect` | 最终目标，例如 `axiang@192.168.1.20` |
| 远端命令 | `shell` | AST 还原的规范化命令及支持的内部命令；保存审批建议仍是整条原文 |
| 读远端文件 | `read` | `host:远端路径` |
| 写远端文件 | `edit` | `host:远端路径` |
| 远端 glob | `glob` | 请求的模式 |
| 远端 grep | `grep` | 请求的正则 |
| 上传 | `read`（本地）→ `edit`（远端） | 本地路径，`host:远端路径` |
| 下载 | `read`（远端）→ `edit`（本地） | `host:远端路径`，本地路径 |

SSH 角色策略将 `ssh_connect` 设为默认 `ask`，用户规则可以覆盖它。
以下是显式放行的配置示例，并非启用插件的必要条件，也不能修复上述权限缺陷：

```jsonc
{
  "permissions": [
    { "action": "ssh_connect", "resource": "*", "effect": "allow" },
    { "action": "ssh_devices", "resource": "*", "effect": "allow" }
  ]
}
```

按设备细分的写法：

```jsonc
{
  "permissions": [
    { "action": "ssh_connect", "resource": "axiang@10.0.0.5", "effect": "allow" },
    { "action": "ssh_connect", "resource": "*@production*", "effect": "deny" },
    { "action": "shell", "resource": "sudo *", "effect": "deny" }
  ]
}
```

## 配置

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "./opencode-zh-bundle/plugins/opencode-ssh-workshop"
  ],
  "agents": {
    "ssh-drafter": { "mode": "primary" },
    "ssh-tinker": { "mode": "primary" },
    "ssh-foreman": { "mode": "primary" },
    "ssh-maker": { "mode": "subagent" },
    "ssh-inspector": { "mode": "subagent" },
    "ssh-archivist": { "mode": "subagent" },
    "ssh-surveyor": { "mode": "subagent" }
  }
}
```

七个 SSH 角色必须先在 `agents` 里声明，插件只做 `update`——与 Workshop 原角色同一路子。

插件选项：

```jsonc
{
  "plugins": [
    {
      "package": "./opencode-zh-bundle/plugins/opencode-ssh-workshop",
      "options": {
        "agents": { "ssh-tinker": { "model": "openai/gpt-5.6-sol", "variant": "high" } },
        "rememberDevices": true
      }
    }
  ]
}
```

`/ssh-devices` 是 TUI 入口，需要在 `cli.json` 里加载同一个包（自动通过 `./tui` 导出找到）：

```jsonc
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["./opencode-zh-bundle/plugins/opencode-ssh-workshop"]
}
```

## 首次使用

1. 选一个 SSH 角色（如 `ssh-tinker`）。
2. 用 `/ssh-devices` 添加设备，或直接让 Agent 连接某个 `host`——成功后会自动记住。
3. 用 `ssh_info` 确认连接与远端工作目录。

## 已知边界

- 只支持密钥或 SSH agent 认证，不支持密码与交互式提示（沿用上游）。
- 目标是能运行 Bash 的 Linux 主机，不含网络设备专用命令行。
- 远端命令非交互：不支持 `vim`、`top` 等。
- 「记住设备」不等于「保持连接」；重启后仍需重新连接。

## License

MIT（见 `LICENSE`；上游作者 Pedro Klein）。
