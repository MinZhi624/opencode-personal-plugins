# OpenCode 中文插件整合包

这是一个面向朋友和其他设备的**最小运行分发包**。它整合四个本地组件，只保留运行所需代码、技能文件和许可证，不包含开发依赖、测试、Git 历史、源码映射、登录凭证或账户数据。

发布快照：2026-08-04；适配 OpenCode 1.18.12。

## 包含内容

| 组件 | 加载面 | 主要能力 |
| --- | --- | --- |
| `opencode-quota-zh` | Server + TUI | Provider 额度、token 统计、中文额度卡片和 `/quota*` 命令 |
| `opencode-enhanced-sidebar-zh` | TUI | 上下文使用率、TPS、花费估算和子代理面板 |
| `opencode-matt-workshop` | Server | Drafter / Foreman / Tinker 等 7 个智能体和 Matt 工作流 skills |
| `gpt-reset-credits` | Server | 查询 ChatGPT 重置卡；经原生权限确认后兑换 |

### 最小化策略

- 不携带任何 `node_modules`；目标设备只运行一次 `npm ci`，四个组件共用一份依赖。
- 不携带 `.git`、测试、构建脚本、备份、`*.map`、`*.d.ts`。
- `opencode-quota-zh` 使用已编译 `dist`；Workshop 使用已编译 `dist/src`。
- 增强侧边栏必须保留 TSX 源文件，由 OpenCode 自身加载。
- 不携带 `auth.json`、token、cookie、额度缓存、会话数据库或个人模型配置。

安装后目录约为：

```text
~/.config/opencode/
├── opencode.jsonc
├── tui.jsonc
└── opencode-zh-bundle/
    ├── package.json
    ├── package-lock.json
    ├── node_modules/             # 目标设备安装时生成
    ├── plugins/
    │   ├── opencode-quota-zh/
    │   ├── opencode-enhanced-sidebar-zh/
    │   ├── opencode-matt-workshop/
    │   └── gpt-reset-credits/
    └── scripts/verify.mjs
```

## 1. 环境要求

- OpenCode **1.18.12 或更高版本**。
- Node.js **22.6.0 或更高版本**，并带有 npm。
- Python **3.10 或更高版本**，仅 `gpt-reset-credits` 需要。
- 首次安装依赖时能访问 npm registry。
- 使用者自己的模型 Provider 账户；本包不提供模型、API key 或 ChatGPT 权益。

检查版本：

```bash
opencode --version
node --version
npm --version
python3 --version
```

如果尚未安装 OpenCode，官方安装方式之一是：

```bash
curl -fsSL https://opencode.ai/install | bash
```

也可使用：

```bash
npm install -g opencode-ai
```

Windows 官方推荐优先使用 WSL；原生 Windows 也可使用下方 PowerShell 安装器。

## 2. 快速安装

如果发布目录中带有 `release/opencode-zh-bundle-0.1.0.zip`，可直接把该 ZIP 和同名 `.sha256` 校验文件发给朋友。解压后再执行对应安装器。

### Linux / macOS / WSL

解压本目录后，在目录中执行：

```bash
bash install.sh
```

安装器会：

1. 检查 OpenCode、Node.js、npm 和 Python。
2. 把最小 bundle 复制到 `~/.config/opencode/opencode-zh-bundle/`。
3. 运行一次 `npm ci --omit=dev --ignore-scripts`，生成共享 `node_modules`；本包不需要 npm 生命周期脚本。
4. 验证运行文件、依赖和两个 Server 插件入口。
5. 仅在没有现有配置时安装 `opencode.jsonc` 和 `tui.jsonc`。

如果已有 OpenCode 配置，安装器**不会覆盖**，而会提示按
[`docs/MERGE_EXISTING_CONFIG.md`](docs/MERGE_EXISTING_CONFIG.md) 合并。

只有确认旧配置可以整体替换时才使用：

```bash
bash install.sh --replace-config
```

该选项会先把旧配置重命名为 `*.bak.时间戳`，但仍可能临时移除你原有的 Provider、MCP、权限或插件配置；通常建议手工合并。

### Windows PowerShell（原生）

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

如果已有配置，按文档手工合并。确认可整体替换时：

```powershell
.\install.ps1 -ReplaceConfig
```

若 Windows 只有 `python` 而没有 `py -3`，设置：

```powershell
[Environment]::SetEnvironmentVariable("OPENCODE_PYTHON", "python", "User")
```

重新打开终端后再启动 OpenCode。

## 3. 登录模型 Provider

每位使用者必须登录自己的账户：

```bash
opencode providers login
```

也可以进入 TUI 后执行：

```text
/connect
/models
```

配置模板没有复制原设备的 OpenAI、DeepSeek 或私有模型 ID。Workshop 默认让所有角色继承当前所选模型，因此先选择一个具备稳定工具调用能力的模型即可。

### 为重置卡单独登录 OpenAI

`gpt-reset-credits` 需要 ChatGPT/Codex OAuth access token。请在 `/connect` 中选择 **OpenAI → ChatGPT Plus/Pro** 登录；只填写 OpenAI API key 通常不能提供重置卡接口需要的 access token。

插件只读取以下位置之一：

- 环境变量 `CODEX_AUTH_PATH` 指定的文件；
- `~/.codex/auth.json`；
- `${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json`。

不要把这些文件发送给其他人。

## 4. 重启并验证

配置和插件只在 OpenCode 启动时加载，安装后必须**彻底退出并重新启动**。

先在普通终端验证解析后的 Server 配置：

```bash
opencode debug config
opencode debug agent tinker
opencode debug skill
```

然后启动 TUI：

```bash
opencode
```

建议依次检查：

1. 默认智能体为 `tinker`，可切换到 `drafter` / `foreman`。
2. `opencode debug skill` 中有 `ask-matt`、`code-review`、`tdd` 等技能。
3. 侧边栏出现中文额度区域，以及“上下文 / 子代理”区域。
4. `/quota_status` 能显示额度诊断。
5. `/gpt-reset-credits` 能查询可用重置卡。

## 5. 基本用法

### 额度与 token

```text
/quota
/quota_status
/tokens_today
/tokens_weekly
/tokens_monthly
/tokens_all
/tokens_session
```

### Matt Workshop

- `tinker`：默认，用于局部、可立即检查的小改动。
- `drafter`：规划、澄清、规格和架构工作。
- `foreman`：实施明确的工作，可协调 Maker 和双轴审查。
- `maker`、`inspector`、`archivist`、`surveyor`：隐藏子代理，由主智能体按需调用。

常用命令：

```text
/ask-matt
/grill-me
/implement
/teach
/handoff
```

### ChatGPT 重置卡

```text
/gpt-reset-credits
/gpt-reset-credits 兑换
/gpt-reset-credits 兑换第 2 张
```

- 查询不会兑换任何资源。
- 兑换是不可逆操作，插件会重新查询并校验目标，再弹出 OpenCode 原生权限确认。
- 只有工具返回 `redeem_success` 才表示兑换成功。
- 没有重置卡、没有待重置限流窗口或账户不支持该功能都可能是正常结果。

## 6. 可选：为 Workshop 指定不同模型

默认配置最便携：所有角色继承当前模型。如果朋友已登录多个 Provider，可以在 `~/.config/opencode/opencode.jsonc` 的 Workshop 选项中加入：

```jsonc
[
  "./opencode-zh-bundle/plugins/opencode-matt-workshop/dist/src/index.js",
  {
    "replace_builtin_agents": true,
    "max_parallel_makers": 3,
    "agents": {
      "drafter": {
        "model": "provider/model-id",
        "reasoningEffort": "high"
      },
      "tinker": {
        "model": "provider/model-id"
      }
    }
  }
]
```

把占位符替换为 `/models` 中真实可用的 `provider/model-id`。未列出的角色继续继承当前模型。

若希望保留 OpenCode 内置 `build` / `plan` 等智能体，把 `replace_builtin_agents` 改为 `false`。

## 7. 手工安装

不使用脚本时：

1. 把整个发布目录复制为 `~/.config/opencode/opencode-zh-bundle/`。
2. 在该目录执行：

   ```bash
   npm ci --omit=dev --ignore-scripts --no-audit --no-fund
   node scripts/verify.mjs
   ```

3. 若没有旧配置：

   ```bash
   cp config/opencode.jsonc ~/.config/opencode/opencode.jsonc
   cp config/tui.jsonc ~/.config/opencode/tui.jsonc
   ```

4. 若有旧配置，按合并文档追加插件条目。
5. 重启 OpenCode。

## 8. 更新与卸载

### 更新

用新发布目录再次运行 `bash install.sh` 或 `install.ps1`。安装器会替换 bundle 中受管理的插件文件并重新安装锁定依赖，但默认保留已有 OpenCode 配置。

### 卸载

1. 从 `opencode.json(c)` 的 `plugin` 数组删除三个 Server 条目。
2. 从 `tui.json(c)` 的 `plugin` 数组删除两个 TUI 条目。
3. 删除 `~/.config/opencode/opencode-zh-bundle/`。
4. 重启 OpenCode。

卸载不会删除 OpenCode 登录凭证或会话数据。

## 9. 安全说明

- 发送前可确认发布目录中没有 `node_modules`、`auth.json`、`.env` 或个人绝对路径。
- 不要分享 `~/.local/share/opencode/auth.json`、`~/.codex/auth.json` 或会话数据库。
- `opencode debug config` 可能展示本机配置；不要未经检查直接公开其完整输出。
- 重置卡兑换经权限确认，但它仍是不可逆的账户操作，请核对目标卡后再允许。

故障排查见 [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)，第三方许可证见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

## 官方参考

- [OpenCode 安装](https://opencode.ai/docs/)
- [OpenCode 配置与配置位置](https://opencode.ai/docs/config/)
- [OpenCode Provider 登录](https://opencode.ai/docs/providers/)
- [OpenCode Windows / WSL](https://opencode.ai/docs/windows-wsl)
