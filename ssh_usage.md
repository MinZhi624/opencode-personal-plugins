# SSH 连接使用指南

适用于已经在另一台电脑安装 `ssh` 组、准备通过 OpenCode 连接远端 Linux 主机的情况。
OpenCode 和模型调用留在本机，远端不需要安装 OpenCode。

> [!IMPORTANT]
> SSH 组要求 OpenCode **2.0.31+**，并且必须和 `workshop` 组一起安装。安装完成后如果
> 修改了插件文件但没有重启服务，先重启 OpenCode。本文以已安装并重启后的环境为前提。

## 1. 先确认三件事

1. OpenCode 版本正确：

   ```bash
   opencode --version
   ```

2. 本机 SSH agent 里有可用密钥：

   ```bash
   ssh-add -l
   ```

   如果列表为空或提示 `agent refused operation`，先执行：

   ```bash
   ssh-add -t 1h ~/.ssh/id_ed25519
   ```

3. 已切换到 SSH 角色。默认的 `tinker` 等本机角色不能调用 SSH 工具，需手动切换到
   `ssh-tinker`、`ssh-drafter` 或 `ssh-foreman`。

### 第一次使用必须配置密钥吗

不一定要**新建**密钥，但第一次必须有一种可用的认证方式。满足下面任意一种即可：

- 本机已有私钥，且对应公钥已加入远端账户的 `~/.ssh/authorized_keys`；
- 私钥已经解锁并加载到 SSH agent，`ssh-add -l` 能看到它；
- `~/.ssh/config` 已为该主机配置了可用的 `IdentityFile`，并且密钥有权限使用。

先在普通终端验证：

```bash
ssh -o BatchMode=yes user@example-host true
```

如果这条命令不再询问密码并返回成功，就不需要重新生成密钥，设备档案中的“密钥文件”
可以留空，或填入该私钥的绝对路径。如果提示密码、`Permission denied` 或
`agent refused operation`，才需要按 [2.3 密钥路径怎么填](#23-密钥路径怎么填) 配置
密钥或重新解锁 agent。

> 插件不支持在 OpenCode 内输入密码。只有密码登录、没有可用密钥的远端，第一次需要
> 先在普通终端用 `ssh-keygen`／`ssh-copy-id` 配置密钥；不会把密码保存到设备档案。

## 2. 添加设备

推荐用 TUI 添加，设备档案会保存在 OpenCode 的本机插件存储中，不会写入项目 Git，
也不会保存密码或私钥内容。

### 2.1 通过 `/ssh-devices`

1. 在 OpenCode 输入：

   ```text
   /ssh-devices
   ```

2. 选择“添加设备”。
3. 填写以下字段，保存前确认名称和地址没有填反。

| 字段 | 示例 | 说明 |
| --- | --- | --- |
| 名称 | `开发机` | 自定义别名，之后可以直接用名称连接；不能重名 |
| 地址 | `example-host` | 远端 IP 或主机名 |
| 用户名 | `user` | 远端登录用户，不是本机用户名 |
| 端口 | `22` | 1–65535 的整数；非标准端口必须填写实际值 |
| 密钥文件 | `/home/you/.ssh/id_ed25519` | 本机私钥的绝对路径，只保存路径；不要填 `.pub` 公钥 |
| 附加参数 | `-J jump-host` | 可选，跳板机等额外 SSH 参数 |
| 远端目录 | `/home/user` | 可选；留空则停在远端登录目录 |

密钥文件不是必填项；如果不知道路径，先看 [2.3 密钥路径怎么填](#23-密钥路径怎么填)。

4. 保存后回到设备列表，选中新设备。
5. 选择连接。第一次连接通常会弹出权限确认；按需要选择允许一次或保存审批。
6. 连接成功后先执行 `ssh_info`，确认主机、设备和当前目录。

如果“远端目录”不确定，先留空；连接后执行 `pwd` 查看真实位置，再使用绝对路径或
重新编辑设备档案。不要把密码填进任何字段。

### 2.2 让 Agent 添加设备

也可以直接对 Agent 说：

```text
使用 ssh_devices 的 save 操作保存设备：
名称=开发机
地址=example-host
用户=user
端口=22
密钥文件=/home/you/.ssh/id_ed25519
远端目录=/home/user

只保存并列出结果，不要连接，也不要修改其他设备。
```

设备已存在时，先让 Agent 用 `ssh_devices` 的 `list` 操作列出设备，找到名称后再更新；
不要用同一名称重复创建。地址字段只填 IP 或主机名，不要把 `user@` 写进去。

### 2.3 密钥路径怎么填

“密钥文件”填的是**本机私钥**的路径，不是远端服务器上的路径。私钥文件通常没有
`.pub` 后缀；`.pub` 是对应的公钥，不能用来登录。

#### 先查找已有密钥

Linux／macOS：

```bash
ls -la ~/.ssh
```

重点看这些文件：

```text
~/.ssh/id_ed25519        # 推荐的 ED25519 私钥
~/.ssh/id_rsa            # 旧式 RSA 私钥
~/.ssh/id_ecdsa
```

如果文件存在，设备档案里优先填写它的**绝对路径**。例如：

```text
/home/you/.ssh/id_ed25519
```

不建议在设备字段里写 `~`：插件把路径作为 SSH 参数传给子进程，不保证 `~` 会被展开。
复制路径时可以用：

```bash
realpath ~/.ssh/id_ed25519
```

Windows PowerShell：

```powershell
Get-ChildItem "$HOME\.ssh"
Resolve-Path "$HOME\.ssh\id_ed25519"
```

设备字段示例：

```text
C:\Users\you\.ssh\id_ed25519
```

如果密钥不在默认目录，按实际位置填写，例如 `/home/you/keys/work_ed25519`。

#### 通过 ssh config 查找

如果你平时直接运行 `ssh 主机名` 就能登录，密钥可能配置在 `~/.ssh/config` 中：

```bash
grep -n -i 'IdentityFile' ~/.ssh/config
```

看到类似：

```text
IdentityFile ~/.ssh/id_ed25519
```

就填写展开后的绝对路径。也可以让 SSH 打印当前生效的配置：

```bash
ssh -G your-host | grep -i identityfile
```

#### 没有密钥时生成

在**本机**生成一把新的 ED25519 密钥（把邮箱换成注释，不是远端用户名）：

```bash
ssh-keygen -t ed25519 -C "your-name@example" -f ~/.ssh/id_ed25519
```

按提示设置私钥口令，或直接回车不设口令。生成后会有两个文件：

```text
~/.ssh/id_ed25519       # 私钥，设备档案填这个
~/.ssh/id_ed25519.pub   # 公钥，需要放到远端
```

把公钥安装到远端（推荐）：

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub user@example-host
```

如果远端没有 `ssh-copy-id`，把 `.pub` 文件内容追加到远端的
`~/.ssh/authorized_keys`，并确保远端权限正确：

```bash
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
```

本机私钥权限也应保持仅当前用户可读：

```bash
chmod 700 ~/.ssh
chmod 600 ~/.ssh/id_ed25519
```

#### 解锁到 SSH agent

设备连接使用 `BatchMode=yes`，不能在 OpenCode 里输入私钥口令。每次解锁或密钥被
锁定后，在本机普通终端执行：

```bash
ssh-add -t 1h ~/.ssh/id_ed25519
ssh-add -l
```

`ssh-add -l` 显示一把或多把密钥的指纹即可。若使用 1Password、系统 keyring 等
外部 agent，确认 OpenCode 后台服务使用同一个 `SSH_AUTH_SOCK`：

```bash
echo "$SSH_AUTH_SOCK"
```

#### 设备字段可以留空吗

可以。`密钥文件`是可选字段；留空时 SSH 会使用自己的默认密钥、`~/.ssh/config` 或
已加载的 agent 密钥。只有在有多个密钥、需要明确选择，或默认密钥不是要用的那一把时，
才必须填写路径。

#### 常见错误

| 填写 | 结果 | 正确做法 |
| --- | --- | --- |
| `~/.ssh/id_ed25519.pub` | 把公钥当私钥，认证失败 | 填没有 `.pub` 的私钥文件 |
| `/home/user/.ssh/id_ed25519` | 这是远端路径，不是本机路径 | 填本机当前用户的绝对路径 |
| `~/.ssh/id_ed25519` | 某些启动方式下 `~` 不展开 | 用 `realpath` 得到绝对路径 |
| 空路径且有多把密钥 | 可能选错密钥 | 明确填写要用的私钥路径 |
| 私钥权限过宽 | SSH 可能拒绝使用 | `chmod 600` 私钥文件 |

## 3. 连接并验证

在 `/ssh-devices` 中选择设备并连接，或者对 Agent 说：

```text
连接已保存的设备“开发机”。
先执行 ssh_info，再执行 hostname; whoami; pwd。
超时 10 秒，不写文件。
```

成功的标志是：

- `ssh_info` 显示主机、设备、当前目录和连接状态；
- `hostname`、`whoami`、`pwd` 返回远端的结果；
- 没有出现 `No active SSH session` 或 `Permission denied`。

连接是持久 shell，`cd` 和导出的变量会在后续调用中保留。若 `pwd` 与设备档案中的
“远端目录”不一致，以 `pwd` 为准；执行位置不确定时使用绝对路径。

## 4. 连接后的常用操作

### 执行远端命令

```text
在远端执行：ls -la /home/user/project，返回原始输出。
```

命令会先做 Bash 静态分析，再走 OpenCode 权限检查；无法可靠分析的语法会直接拒绝，
不会发送到远端。

### 读取、写入和搜索

```text
读取远端 /home/user/project/README.md 前 80 行。
```

```text
在远端 /home/user/project 搜索 TODO，忽略大小写。
```

```text
把以下内容写入远端 /home/user/project/notes.md：
...
```

SSH 角色隐藏本机文件与 shell 工具；读写搜索都通过远端对应工具完成，不会把同名路径
写到本机。

### 上传和下载

```text
把本地 /home/user/tmp/report.csv 上传到远端 /home/user/project/report.csv。
```

```text
把远端 /home/user/project/result.log 下载到本地 /home/user/tmp/result.log。
```

传输复用当前 SSH 连接，不会另开 `scp`。连接在授权或传输中途失效时会明确失败；
下载不会把错误文本写成文件，也不会在失败后报告成功。

### 断开连接

```text
断开当前 SSH 连接。
```

## 5. 权限说明

- 首次连接通常会询问；用户规则可以按设备放行。
- 配置中的 `deny` 优先，保存过“始终允许”也不能覆盖它。
- “始终允许”对精确目标或精确原文生效；带引号、复合命令或参数变化可能再次询问。
- 非 SSH 角色不能调用 SSH 工具，也不能从本机 shell 执行可识别的 `ssh`／`scp`／
  `sftp`；请切换到 SSH 角色。
- SSH 角色原有的只读、规划和危险命令限制继续保留。

## 6. 常见故障

### `/ssh-devices` 没有出现

确认安装时选择了 `ssh` 组，并且 `cli.json` 中有 `opencode-ssh-workshop` 条目；安装
或更新插件后重启 OpenCode。只安装 `workshop` 组不会提供设备界面。

### 设备列表为空

先在 `/ssh-devices` 添加设备，不要直接猜地址。也可以让 Agent 调用 `ssh_devices` 的
`save` 操作；保存成功后再连接。

### `agent refused operation`

密钥存在但 agent 拒绝签名。在普通终端重新解锁：

```bash
ssh-add -t 1h ~/.ssh/id_ed25519
ssh-add -l
```

仍失败时先移除再添加：

```bash
ssh-add -d ~/.ssh/id_ed25519
ssh-add -t 1h ~/.ssh/id_ed25519
```

不要用 `ssh-add -D` 清空其他仍需要的密钥。

### `Permission denied (publickey)`

检查设备档案中的地址、用户名、端口、密钥路径是否与远端账户一致；用相同的
`BatchMode=yes` 方式在普通终端验证。不要通过关闭 host key 校验来绕过。

### `No active SSH session`

先在 `/ssh-devices` 连接设备，再使用 `ssh_info`、远端文件工具或 `ssh` 命令。连接
中途断开时工具会明确失败，重新连接即可。

### 提示当前角色不能操作 SSH

这是角色隔离，不是权限故障。切换到 `ssh-tinker`、`ssh-drafter` 或 `ssh-foreman`
后重试。

### 安装时提示版本过旧

SSH 需要 OpenCode 2.0.31+。先升级并确认 `opencode --version`，再运行安装器；安装器
不会自动修改全局 OpenCode。

## 7. 使用限制

- 不支持密码、交互式口令或远端 TUI 命令。
- 命令分析只覆盖受支持的 Bash 结构和包装入口；外部脚本、任意程序内部行为不在静态
  保证范围内，也不能当作 OS 网络沙箱。
- 当前版本尚未实现“每个新终端独立确认设备”；设备选择和远端工作区按会话管理。
- 大文件／并发传输、设备档案跨项目共享和重启恢复仍需按实际环境验收。
- 连接初始目录与真实当前目录的边界尚未完整验收；执行位置有疑问时先确认 `pwd`，
  或直接使用绝对路径。
- 保存审批对引用／复合命令可能再次询问。

更完整的安装、权限和验证记录见
[`opencode-ssh-workshop` 交付说明](plugins/opencode-ssh-workshop/README.md#交付说明当前状态)。
