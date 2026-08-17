# 故障排查

## 插件安装后没有变化

OpenCode 不热重载配置、插件、智能体或 skills。彻底退出所有 OpenCode 进程后重新启动。

确认配置路径：

```bash
opencode debug paths
opencode debug config
```

## `Cannot find package` / `Cannot find module`

依赖没有安装，或者安装在错误目录。执行：

```bash
cd ~/.config/opencode/opencode-zh-bundle
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
node scripts/verify.mjs
```

不要在四个插件目录中分别安装依赖；本包设计为共用 bundle 根目录的一份 `node_modules`。

## npm 显示 `glob@9.3.5` deprecated 或 audit 警告

这是锁定的 OpenCode/OpenTUI 依赖链带来的传递依赖提示，不表示安装失败。截至本发布快照，`npm audit --omit=dev` 报告 4 个 low severity、没有 high/critical。

不要执行 `npm audit fix --force`：npm 当前给出的强制修复会安装不兼容的旧版 `@opencode-ai/plugin`。等待 OpenCode/OpenTUI 上游升级后重新制作 bundle 更安全。

## OpenCode 版本不兼容

```bash
opencode --version
opencode upgrade
```

本快照按 1.18.12 打包。TUI 插件 API 变化较快；升级到未来大版本后若侧边栏加载失败，应重新验证或重新构建发布包。

## 配置无效，OpenCode 无法启动

优先恢复安装器生成的备份：

```text
~/.config/opencode/opencode.jsonc.bak.时间戳
~/.config/opencode/tui.jsonc.bak.时间戳
```

如果原配置扩展名是 `.json`，备份名相应为 `opencode.json.bak.时间戳` 或 `tui.json.bak.时间戳`。

也可在终端运行 `opencode debug config` 查看错误。常见原因是 JSON 逗号、重复键、把带注释内容保存为 `.json`，或路径拼写错误。

## 侧边栏不显示

1. 确认 `tui.json(c)` 中存在两个 bundle TUI 条目。
2. 确认没有旧路径的重复条目。
3. 运行 `node ~/.config/opencode/opencode-zh-bundle/scripts/verify.mjs`。
4. 彻底重启 OpenCode，而不只是切换会话。

`opencode debug config` 主要验证 Server 配置；TUI 插件要在实际 TUI 启动时加载。

## `/quota_status` 没有目标 Provider 数据

- 先用 `/connect` 或 `opencode providers login` 登录目标 Provider。
- 某些 Provider 没有官方额度接口，只能显示本地 token 或估算数据。
- 检查 `/quota_status` 的诊断内容，不要把包含本机路径或账户信息的完整结果直接公开。

## Workshop 智能体或 skills 不见了

```bash
opencode debug agent tinker
opencode debug skill
```

确认以下文件存在：

```text
~/.config/opencode/opencode-zh-bundle/plugins/opencode-matt-workshop/dist/src/index.js
~/.config/opencode/opencode-zh-bundle/plugins/opencode-matt-workshop/skills/ask-matt/SKILL.md
```

Workshop 插件会自动把随附 `skills/` 加入 OpenCode 的 skills 搜索路径，不需要再复制到全局 `skills/`。

## Workshop 提示模型不存在

发布模板没有固定模型。若手工添加了 `agents.*.model`，必须使用 `/models` 中当前账户真实可用的 `provider/model-id`。删除无效覆盖后，该角色会重新继承当前模型。

## 重置卡提示找不到凭证

在 TUI 中执行 `/connect`，选择：

```text
OpenAI → ChatGPT Plus/Pro
```

重置卡工具识别：

```text
~/.codex/auth.json
${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json
```

也可设置 `CODEX_AUTH_PATH`。只填写普通 OpenAI API key 通常不包含需要的 OAuth access token。

## 重置卡提示 `helper failed`

检查 Python：

```bash
python3 --version
```

要求 Python 3.10+。如果 Python 可执行文件不叫 `python3`：

```bash
export OPENCODE_PYTHON=/实际路径/python
opencode
```

Windows 可持久设置：

```powershell
[Environment]::SetEnvironmentVariable("OPENCODE_PYTHON", "python", "User")
```

环境变量值应是单个可执行文件名或路径，不要附加命令参数。

## 重置卡返回 401

OpenAI/Codex OAuth 凭证已过期。重新执行 `/connect` 登录 ChatGPT Plus/Pro。不要复制其他人的 `auth.json`。

## 重置卡数量为 0

这通常不是安装问题。账户可能没有获得重置卡、卡已使用/过期，或当前产品计划不提供该资源。

## 兑换状态是 `uncertain`

不要自动重试。插件已故意设计为在 POST 后回查不一致时停止，以避免重复兑换。稍后只执行查询，核对卡片列表和限流状态。

## Windows 原生环境问题

OpenCode 官方推荐 WSL。若原生 Windows 出现 TSX、终端渲染或 Python 启动问题，优先在 WSL 中安装本包；配置路径会变为 WSL 用户的 `~/.config/opencode/`。
