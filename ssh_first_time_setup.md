# 新机器第一次配置 SSH 密钥

本文适用于：一台新电脑已经安装 OpenCode 和 `ssh` 组，第一次准备通过 OpenCode 连接
远端 Linux 主机。OpenCode 和模型调用留在本机，远端不需要安装 OpenCode。

> [!IMPORTANT]
> 插件使用 `BatchMode=yes`，不能在 OpenCode 内输入密码或私钥口令。第一次使用必须
> 先让**本机**具备一种可用的密钥认证方式；只有密码登录的远端需要先在普通终端配置
> 公钥。不要把密码、私钥内容写进设备档案。

## 0. 先判断是否已经有可用密钥

不要一上来就生成新密钥。先在本机普通终端执行：

```bash
ssh-add -l
ssh -o BatchMode=yes user@example-host true
```

把 `user@example-host` 换成远端账户。第二条命令如果**不询问密码并成功返回**，说明
本机已有可用密钥，可以直接跳到第 5 节，在 OpenCode 中填写设备；不需要重新生成。

如果第二条命令提示密码、`Permission denied (publickey)` 或 `agent refused operation`，
继续下面的步骤。

## 1. 确认本机密钥位置

Linux／macOS：

```bash
ls -la ~/.ssh
```

常见文件：

```text
~/.ssh/id_ed25519       # 推荐的 ED25519 私钥
~/.ssh/id_ed25519.pub   # 对应公钥，可以公开
~/.ssh/id_rsa           # 旧式 RSA 私钥
```

私钥文件通常**没有** `.pub` 后缀；设备档案要填私钥路径，不能填 `.pub` 公钥。

Windows PowerShell：

```powershell
Get-ChildItem "$HOME\.ssh"
```

默认位置通常是：

```text
C:\Users\<你的用户名>\.ssh\id_ed25519
```

如果已有 `id_ed25519`，不要重新生成，先测试它是否已经能登录远端。只有在没有可用密钥
或需要换一把新密钥时，才进入下一步。

## 2. 生成新密钥

在**本机**普通终端执行（不是远端，也不是 OpenCode）：

```bash
ssh-keygen -t ed25519 -C "your-name@example" -f ~/.ssh/id_ed25519
```

说明：

- `-t ed25519` 生成现代 SSH 密钥；
- `-C` 后面只是注释，方便识别，不是远端用户名；
- `-f` 指定私钥路径；
- 可以设置私钥口令，也可以直接回车不设口令。

如果文件已经存在，`ssh-keygen` 会询问是否覆盖。覆盖会破坏原来能用的密钥，除非你明确
知道要替换，否则不要输入 `y`。

生成后会得到两个文件：

```text
~/.ssh/id_ed25519       # 私钥：留在本机，不要发给别人
~/.ssh/id_ed25519.pub   # 公钥：安装到远端
```

设置本机权限：

```bash
chmod 700 ~/.ssh
chmod 600 ~/.ssh/id_ed25519
chmod 644 ~/.ssh/id_ed25519.pub
```

Windows 上使用默认的用户目录通常即可；如果复制了别人机器上的私钥，打开文件属性 →
安全 → 高级，确保只有当前 Windows 用户有读取权限。

## 3. 把公钥安装到远端

远端账户需要有对应公钥。最简单的本机命令是：

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub user@example-host
```

非标准端口：

```bash
ssh-copy-id -p 2222 -i ~/.ssh/id_ed25519.pub user@example-host
```

第一次执行 `ssh-copy-id` 时，普通终端可以输入远端密码；这是配置阶段，不是 OpenCode
插件在登录。

如果没有 `ssh-copy-id`，可以手工追加：

```bash
cat ~/.ssh/id_ed25519.pub | ssh user@example-host \
  'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'
```

然后在远端确认：

```bash
ssh user@example-host \
  'chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys; wc -l ~/.ssh/authorized_keys'
```

同一把公钥可以加入多台远端。不要把私钥复制到远端，也不要把私钥发送给其他人。

## 4. 用 BatchMode 验证

在设备档案之前，先在普通终端模拟插件的非交互登录：

```bash
ssh -o BatchMode=yes \
    -o IdentitiesOnly=yes \
    -p 22 \
    -i ~/.ssh/id_ed25519 \
    user@example-host 'hostname; whoami; pwd'
```

必须不再询问密码并返回远端的主机名、用户和目录。把 `-p 22` 改成设备实际端口；密钥
路径使用本机实际路径。

如果这里仍然失败，不要先改 OpenCode 配置，先按第 7 节排查终端 SSH；插件只是复用
同一套 SSH 认证。

## 5. 解锁到 SSH agent

如果私钥有口令，或者你想让 OpenCode 在后续连接中复用密钥，在本机普通终端执行：

```bash
ssh-add -t 1h ~/.ssh/id_ed25519
ssh-add -l
```

`ssh-add -l` 应显示一把密钥的指纹。`-t 1h` 表示一小时后自动失效；也可以使用更长的
时间或由系统 keyring 管理。

确认 OpenCode 后台服务和当前终端使用同一个 agent：

```bash
echo "$SSH_AUTH_SOCK"
```

如果这个变量为空，先使用桌面环境的 keyring／SSH agent；不要在一个终端里临时启动新的
`ssh-agent` 后直接回到 OpenCode，服务端通常不会继承那个新 socket。必要时在同一用户
环境下重启 OpenCode 服务。

如果使用 1Password、系统钥匙串或硬件密钥，密钥可能已经由 agent 管理，设备档案中的
“密钥文件”可以留空；只要 `ssh-add -l` 或 agent 界面能看到它即可。

## 6. 在 OpenCode 设备档案中填写

1. 切换到 `ssh-tinker`（或 `ssh-drafter`、`ssh-foreman`）。
2. 输入 `/ssh-devices`。
3. 选择“添加设备”。
4. 按下表填写。

| 字段 | 示例 | 说明 |
| --- | --- | --- |
| 名称 | `开发机` | 自定义别名，之后用名称连接 |
| 地址 | `example-host` | 远端 IP 或主机名 |
| 用户名 | `user` | 远端登录用户，不是本机用户 |
| 端口 | `22` | 必须是实际端口 |
| 密钥文件 | `/home/you/.ssh/id_ed25519` | 本机私钥绝对路径；不要填 `.pub` |
| 附加参数 | `-J jump-host` | 可选，跳板机等 |
| 远端目录 | `/home/user` | 可选，不确定就留空 |

“密钥文件”可以留空：SSH 会使用 agent、`~/.ssh/config` 或默认密钥。只有存在多把密钥、
需要明确选择，或默认密钥不是目标密钥时，才必须填写。

不建议在设备字段里使用 `~`。先取得绝对路径：

```bash
realpath ~/.ssh/id_ed25519
```

Windows 示例：

```text
C:\Users\you\.ssh\id_ed25519
```

保存后选中设备并连接。第一次连接会请求 OpenCode 权限；确认后再进入下一步验证。

## 7. 连接后的最小验证

```text
ssh_info
```

然后：

```text
hostname; whoami; pwd
```

应返回远端主机名、远端用户名和当前目录。若 `pwd` 与设备档案中的“远端目录”不一致，
以 `pwd` 为准；后续命令先使用绝对路径，避免在错误目录写文件。

## 8. 常见问题

### `agent refused operation`

密钥已加载但 agent 拒绝签名。通常是密钥被锁定或需要重新解锁：

```bash
ssh-add -t 1h ~/.ssh/id_ed25519
ssh-add -l
```

仍失败时先移除再添加：

```bash
ssh-add -d ~/.ssh/id_ed25519
ssh-add -t 1h ~/.ssh/id_ed25519
ssh-add -l
```

### `Permission denied (publickey)`

依次检查：

- 设备地址和用户名是否对应正确远端账户；
- 端口是否为实际 SSH 端口；
- 本机私钥路径是否填对；
- 远端 `~/.ssh/authorized_keys` 是否包含对应**公钥**；
- 远端 `~/.ssh` 是否为 `700`、`authorized_keys` 是否为 `600`；
- 是否把 `.pub` 公钥误填成设备私钥路径。

用终端命令排查，不要通过关闭 host key 校验或改插件来绕过权限问题：

```bash
ssh -v -o BatchMode=yes -i ~/.ssh/id_ed25519 user@example-host true
```

### `Bad permissions` 或提示私钥权限过宽

```bash
chmod 700 ~/.ssh
chmod 600 ~/.ssh/id_ed25519
```

### 设备连接时提示需要密码

插件使用 `BatchMode=yes`，不会弹出密码输入。请先在普通终端完成第 3、4 节的公钥安装，
再连接；不能在设备档案中保存密码来解决。

### 找不到私钥或路径错误

先确认文件存在：

```bash
test -f /home/you/.ssh/id_ed25519 && echo OK
```

设备字段应填写本机绝对路径，不是远端 `/home/user/.ssh/...`。

### 多个密钥时登录到错误账户

在设备档案中明确填写目标私钥的绝对路径，并在终端测试时使用同一个 `-i` 参数。

## 9. 安全清单

- 私钥只留在本机；只把 `.pub` 公钥安装到远端。
- 不要把密码、私钥内容或认证 token 写进设备档案。
- 私钥建议设置口令，并通过 agent 在需要时解锁。
- 不再使用的公钥要从远端 `authorized_keys` 删除。
- 设备档案只保存地址、用户名、端口、密钥路径和可选目录，不写入项目 Git。

完成以上步骤后，后续使用只需要：切换到 SSH 角色 → `/ssh-devices` 选择设备 → 连接 →
执行 `ssh_info` 验证。更完整的日常操作见 [`ssh_usage.md`](ssh_usage.md)。
