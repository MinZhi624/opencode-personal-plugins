# SSH 从零使用指南

本指南说明如何在本机 OpenCode 中通过 SSH 操作远端 Linux 主机。OpenCode 与模型调用
留在本机，远端文件读写和命令执行通过 SSH 落到目标设备；远端不需要安装 OpenCode。

## 另一台电脑安装后的最短流程

如果你已经在另一台电脑安装本包，按下面的顺序操作即可。不要先猜远端地址，也不要把
密码写进设备档案。

1. 打开 OpenCode，确认版本不低于 2.0.31：

   ```bash
   opencode --version
   ```

2. 在普通终端准备 SSH agent（只需首次或密钥锁定后执行）：

   ```bash
   ssh-add -t 1h ~/.ssh/id_ed25519
   ssh-add -l
   ```

3. 在 OpenCode 中切换到 `ssh-tinker`（或 `ssh-drafter`、`ssh-foreman`）。默认的
   `tinker` 等本机角色不能调用 SSH 工具，这是有意的角色隔离。

4. 打开设备管理：

   ```text
   /ssh-devices
   ```

5. 选择“添加设备”，至少填写名称、地址、用户名和端口；需要指定私钥时填写密钥文件
   路径。保存后回到列表，选择该设备并连接。第一次连接通常会弹出权限确认。

6. 连接后让 Agent 先执行：

   ```text
   ssh_info
   ```

7. 再做一次最小验证：

   ```text
   hostname; whoami; pwd
   ```

8. 工作完成后断开：

   ```text
   断开当前 SSH 连接。
   ```

如果第 4 步列表里没有设备，不要直接连接；先在 `/ssh-devices` 添加，或让 Agent 调用
`ssh_devices` 的 `save` 操作。下面各节解释每个字段和常见故障。

> [!IMPORTANT]
> SSH 组要求 OpenCode **2.0.31+**，**2.0.28 不兼容**。本指南描述的是本仓库当前版本；
> 仅完成进程内小文件读写和断连路径的主流程验证，不代表所有远端、TUI 或大文件场景均
> 已验收。详细状态见 [`opencode-ssh-workshop` 交付说明](plugins/opencode-ssh-workshop/README.md#交付说明当前状态)。

## 1. 准备条件

| 项目 | 要求 |
| --- | --- |
| 本机 | Node.js 26.4+、npm、OpenCode 2.0.31+ |
| 远端 | 可运行 Bash 的 Linux；支持 `ssh`、`scp`、`base64`、`grep` 等常用命令 |
| 认证 | 私钥或 SSH agent；不支持密码交互，也不保存密码或私钥内容 |
| 网络 | 本机能访问远端 SSH 端口，默认 22 |
| 组件 | `ssh` 组依赖 `workshop` 组，须同时安装 |

本指南不会自动升级 OpenCode。若本机低于 2.0.31，先按现有方式升级并确认：

```bash
opencode --version
```

## 2. 安装 SSH 组

从源码目录运行安装器。已有用户配置默认保留，安装器不会整份覆盖：

```bash
bash install.sh --only workshop,ssh
```

全部组件（包含 SSH）使用：

```bash
bash install.sh --all
```

安装器会检查版本；选择 `ssh` 组时低于 2.0.31 会直接拒绝。安装器会先备份再自动
补齐缺失的配置条目和键，保留已有的 Provider、模型、权限和注释；不要使用
`--replace-config` 覆盖自己的配置。安装完成后重启 OpenCode。

Windows PowerShell：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1 --only workshop,ssh
```

手工合并配置时：

- Workshop 插件必须排在 SSH 插件之前；
- 在已有的 `agents` 对象中加入七条 `ssh-*` 声明，不要再建第二个 `agents`；
- `cli.json` 也需要加入 SSH 插件条目，供 `/ssh-devices` 使用。

## 3. 准备 SSH agent

插件使用 `BatchMode=yes`，不能在 OpenCode 内弹出私钥口令或密码输入。首次使用前，在
一个普通本机终端把私钥解锁到 SSH agent：

```bash
ssh-add -t 1h ~/.ssh/id_ed25519
```

按提示输入私钥口令，然后检查：

```bash
ssh-add -l
```

如果本机使用系统 keyring，确认当前终端和 OpenCode 后台服务使用同一个
`SSH_AUTH_SOCK`：

```bash
echo "$SSH_AUTH_SOCK"
```

不要在普通终端里另起一个新的 `ssh-agent` 后直接回到 OpenCode；服务端不会自动使用
那个新 socket。需要时让 OpenCode 服务在同一用户环境下重启。

用与插件相同的非交互方式验证一次（把示例地址换成实际目标）：

```bash
ssh -o BatchMode=yes \
    -o IdentitiesOnly=yes \
    -p 22 -i ~/.ssh/id_ed25519 \
    user@example-host 'hostname; whoami; pwd'
```

必须不再询问口令并成功返回。看到 `agent refused operation` 或
`Permission denied (publickey)` 时，先在终端重新执行 `ssh-add`；不要通过改插件或
关闭主机校验来绕过。

## 4. 保存设备档案

在 OpenCode TUI 输入：

```text
/ssh-devices
```

### 4.1 在 TUI 中添加设备

1. 输入 `/ssh-devices`，进入设备列表。
2. 选择“添加设备”。列表为空时也可以直接添加。
3. 按字段填写下面的信息。保存前确认名称和地址没有填反。
4. 保存后回到设备列表，选中刚添加的设备。
5. 选择连接；第一次连接会弹出权限确认，确认后等待连接结果。

| 字段 | 示例 | 说明 |
| --- | --- | --- |
| 名称 | `开发机` | 自定义别名，之后可直接用名称连接；不能与已有设备重名 |
| 地址 | `example-host` | IP 或主机名，按实际设备填写 |
| 用户名 | `user` | 远端登录用户；不是本机用户名 |
| 端口 | `22` | 标准端口可填 22；非标准端口必须填实际值 |
| 密钥文件 | `~/.ssh/id_ed25519` | 本机私钥路径，只保存路径，不保存密钥内容 |
| 附加参数 | `-J jump-host` | 可选；跳板机等额外 SSH 参数 |
| 远端目录 | `/home/user` | 可选；连接后相对路径的初始目录。留空则停在登录目录 |

设备档案保存在 OpenCode 的本机插件存储中，跨项目可用，不写入项目 Git，也不保存密码、
私钥内容或认证 token。**这不等于会在每个终端自动确认设备**；设备选择和远端工作区按
会话管理。

如果不想手填 TUI，也可以直接对 Agent 说：

```text
使用 ssh_devices 保存设备：
名称=开发机，地址=example-host，用户=user，端口=22，
密钥文件=~/.ssh/id_ed25519，远端目录=/home/user。
只保存并列出结果，不要连接。
```

Agent 会调用 `ssh_devices` 的 `save` 操作。若提示名称重复，改用另一个名称，或先用
`action=list` 找到已有设备再更新。地址只填主机名/IP，不要把 `user@` 重复写进地址和
用户名两个字段。

### 4.2 连接前检查

- `ssh-add -l` 能看到要用的密钥；
- 设备名称、地址、用户名、端口和密钥路径与远端账户一致；
- 远端已安装并启动 SSH 服务，且本机能访问该端口；
- 连接后先只读验证 `pwd`，确认目录再写文件。

连接后先执行 `ssh_info`，再用 `hostname; whoami; pwd` 做最小验证。若 `pwd` 与设备档案
里的“远端目录”不一致，先使用 `pwd` 显示的目录或绝对路径，不要凭猜测写文件。

## 5. 选择角色并连接

原有本机角色保留。进行远端工作前，手动切换到 SSH 角色：

| 角色 | 用途 |
| --- | --- |
| `ssh-tinker` | 远端通用执行、调试、文件操作 |
| `ssh-drafter` | 远端规划与只读调查，不执行远端 shell |
| `ssh-foreman` | 远端协作与委派 |
| `ssh-maker` | 在给定范围内实施 |
| `ssh-inspector` | 只读独立审查 |
| `ssh-archivist` | 远端调研并写 Markdown 报告 |
| `ssh-surveyor` | 只读映射代码与关系 |

示例请求：

```text
连接开发机。
先调用 ssh_info 确认真实主机和当前目录，再运行 hostname、whoami、pwd。
不要修改任何文件。
```

也可以直接提供目标：

```text
连接 user@example-host，端口 22，密钥 ~/.ssh/id_ed25519。
```

连接成功后：

```text
ssh_info
```

会显示主机、设备、当前目录、连接时长和忙碌状态。连接是持久 shell：`cd`、导出的变量
等状态会在后续命令中保留。命令结束后插件会尝试更新远端当前目录；连接时的初始目录
与真实当前目录的边界仍需按实际环境确认。执行位置有疑问时，先运行 `pwd` 或 `ssh_info`
确认，再决定使用相对路径还是绝对路径。完成工作后执行：

```text
断开 SSH 连接
```

## 6. 常用操作

### 执行命令

```text
在远端执行：ls -la，并返回原始输出。
```

命令会先做静态 Bash 分析，再走 OpenCode 原生权限检查。无法可靠分析或不受支持的语法
会直接拒绝，不会发送到远端。

### 读取、写入和搜索文件

```text
读取远端 /home/user/project/README.md 前 80 行。
```

```text
在远端 /home/user/project 搜索 TODO，忽略大小写。
```

写入会创建或覆盖远端文件；执行前确认目标路径：

```text
把以下内容写入远端 /home/user/project/notes.md：
...
```

远端文件工具只操作远端路径，不会把同名路径写到本机。SSH 角色会隐藏本机文件与 shell
工具，避免误改本机文件。

### 上传和下载

```text
把本地 /home/user/tmp/report.csv 上传到远端 /home/user/project/report.csv。
```

```text
把远端 /home/user/project/result.log 下载到本地 /home/user/tmp/result.log。
```

上传和下载使用已建立的 SSH 连接，不另开 scp 进程。连接在授权或传输中途失效时，操作
会明确失败；不会把错误提示当成文件内容，下载也不会覆盖本地目标后报告成功。

## 7. 权限与角色边界

| 操作 | action | 资源 |
| --- | --- | --- |
| 连接 | `ssh_connect` | 最终目标，例如 `user@example-host` |
| 远端命令 | `shell` | 解析后的命令资源，保存审批建议是整条原文 |
| 读远端文件 | `read` | `host:远端路径` |
| 写远端文件 | `edit` | `host:远端路径` |
| 远端 glob | `glob` | 请求的模式 |
| 远端 grep | `grep` | 请求的正则 |
| 上传 | `read`（本地）→ `edit`（远端） | 本地路径与 `host:远端路径` |
| 下载 | `read`（远端）→ `edit`（本地） | `host:远端路径` 与本地路径 |

- `ssh_connect` 默认会询问；用户规则可以按设备覆盖。
- 配置中的 `deny` 始终优先，保存审批不能覆盖它。
- “始终允许”对精确目标或精确原文生效；带引号、复合命令或不同参数可能再次询问。
- 非 SSH 角色不能调用任何 SSH 工具，也不能在本机 shell 中执行可识别的 `ssh`、
  `scp`、`sftp`；需要手动切换 SSH 角色。
- SSH 角色原有的只读、规划和危险命令限制继续保留。

## 8. 故障排查

### 连接提示 `agent refused operation`

agent 里有密钥但拒绝签名，通常是 agent 被锁定或密钥没有正确解锁。在普通终端执行：

```bash
ssh-add -t 1h ~/.ssh/id_ed25519
ssh-add -l
```

仍失败时先移除这把密钥再加入：

```bash
ssh-add -d ~/.ssh/id_ed25519
ssh-add -t 1h ~/.ssh/id_ed25519
```

不要使用 `ssh-add -D` 清空其他仍需要的密钥。

### `Permission denied (publickey)`

确认设备档案里的用户名、端口、密钥路径和远端账户是否匹配；用相同的 `BatchMode`
命令在终端验证。不要通过关闭 host key 校验来绕过问题。

### 安装时提示版本过旧

SSH 需要 OpenCode 2.0.31+。先升级并确认 `opencode --version`，再运行安装器；安装器
不会自动修改全局 OpenCode。

### `/ssh-devices` 命令没有出现

确认安装时选择了 `ssh` 组，并且 `cli.json` 中有 `opencode-ssh-workshop` 条目。安装后
重启 OpenCode 再试；只安装 `workshop` 组不会提供 SSH 设备界面。

### 添加设备时报名称重复或端口无效

名称必须唯一；端口必须是 1–65535 的整数。地址字段只填 IP／主机名，用户名单独填写。
如果只是修改已有设备，先用 `/ssh-devices` 列表找到它，不要用相同名称再建一份。

### 选择了错误的设备或端口

在 `/ssh-devices` 中编辑设备；端口、密钥或附加参数改变后，下一次连接会重新建立，
不会静默复用旧连接。

### 没有活动的 SSH 会话

先连接设备，再使用 `ssh_info`、文件和命令工具。如果设备列表为空，先用本节前面的
方法添加设备；如果提示“未找到设备”，检查名称是否拼错，或先用 `ssh_devices` 的
`list` 操作列出设备。连接在授权或传输过程中断开时，工具会返回失败，不会继续使用
失效连接的提示文本。

### 远端命令被拒绝

当前命令可能包含动态参数、不支持的 Bash 语法、未知包装命令或高风险操作。按提示拆分
命令；本插件不是完整 Bash 解释器，也不是 OS 沙箱。

### 本机角色调用 SSH 被拒绝

这是角色隔离，不是权限故障。手动切换到 `ssh-tinker`、`ssh-drafter` 或
`ssh-foreman` 后重试。

## 9. 当前限制

- 不支持密码、交互式口令或远端 TUI 命令。
- 命令分析只覆盖受支持的 Bash 结构和包装入口；动态命令名、外部脚本、任意程序内部
  行为不在静态保证范围内，也不能把它当作 OS 网络沙箱。
- 当前版本尚未实现“每个新终端独立确认设备”；设备选择和远端工作区按会话管理，同一
  会话内的终端可能共享。
- 大文件／并发传输、`/ssh-devices` TUI 的部分交互、设备档案跨项目共享和重启恢复
  仍需按实际部署环境验收。
- 连接初始目录与真实当前目录的边界尚未完整验收；执行位置有疑问时使用 `pwd` 或
  绝对路径，不要依赖未确认的相对路径。
- 保存审批对引用／复合命令可能再次询问；这是当前已知限制。

## 10. 停止使用与清理

只想停用 SSH 时，重新运行安装器去掉 `ssh` 组，再从 `opencode.jsonc` 的
`plugins` 数组删除 SSH 条目，并从 `agents` 对象删除七条 `ssh-*` 声明。不要删除
其他组件条目。

完全卸载本包时，从 `opencode.json(c)` 和 `cli.json` 移除本包插件，删除安装 bundle
目录，然后重启 OpenCode。设备档案和会话数据库不会因为卸载插件而自动删除。

更完整的状态和验证记录见
[`opencode-ssh-workshop` 交付说明](plugins/opencode-ssh-workshop/README.md#交付说明当前状态)。
