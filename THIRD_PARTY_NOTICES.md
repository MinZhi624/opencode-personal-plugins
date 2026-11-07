# 第三方来源与许可证

本发布包保留各组成部分随附的许可证文本；安装时通过 npm 下载的依赖不打包在发布目录中，其许可证位于安装后的 `node_modules` 内。

## opencode-quota-zh

- 基于 `@slkiser/opencode-quota` 的中文 Fork。
- 原项目及本地副本声明为 MIT。
- 许可证：`plugins/opencode-quota-zh/LICENSE`。

## opencode-enhanced-sidebar-zh

- 子代理监控代码源自 `opencode-subagent-magazine`。
- 成本和 models.dev 定价逻辑源自 `@slkiser/opencode-quota`。
- 相关许可证位于 `plugins/opencode-enhanced-sidebar-zh/LICENSES/`。

## opencode-user-timeline-zh

- 基于 `opencode-user-timeline` 0.2.3（commit `f1364dd`）移植，接入本套侧栏宿主。
- 上游使用 MIT 许可证；许可证文本：`plugins/opencode-user-timeline-zh/LICENSE`。
- 本包修改了侧栏出口、显隐归属、主题配色与卡片控制接入；跳转逻辑保留上游实现。

## opencode-matt-workshop

- `skills/` 是 Matt Pocock 全部 promoted engineering 与 productivity skills 的适配版本（上游 v1.2.3）。
- 上游 skills 使用 MIT 许可证。
- 许可证：`plugins/opencode-matt-workshop/licenses/MATT-POCOCK-SKILLS-LICENSE`。
- Workshop 适配层原目录未声明独立许可证；本包不替其补充或推定许可证。

## opencode-ssh-workshop

- 基于 `PedroKlein/opencode-ssh-session` v0.3.0（commit `c1c9d7c`）的 OpenCode V2 兼容扩展。
- 上游快照保留于 `plugins/opencode-ssh-workshop/vendor/opencode-ssh-session/`，来源与摘要见同目录 `upstream-provenance.json`。
- 原项目及本地副本声明为 MIT。
- 许可证：`plugins/opencode-ssh-workshop/LICENSE`（Copyright (c) 2026 Pedro Klein）。
- 上游为 V1 插件，不会被加载；V2 实现在 `src/` 中复用其会话层并适配 Node 进程接口。
- 远端命令权限检查使用 `tree-sitter-bash` 预编译 wasm 解析 Bash 语法；
  来源、版本与完整性记录见 `plugins/opencode-ssh-workshop/grammar/README.md`。上游
  [tree-sitter-bash](https://github.com/tree-sitter/tree-sitter-bash) 及运行时
  [web-tree-sitter](https://github.com/tree-sitter/tree-sitter) 均为 MIT。
  Bash grammar 完整许可证见 `plugins/opencode-ssh-workshop/grammar/LICENSE`；
  运行包中的来源记录与许可证位于该插件的 `dist/grammar/`。

## gpt-reset-credits

- 本地 OpenCode 插件，使用用户自己的 OpenCode/Codex 登录凭证访问 ChatGPT 重置卡接口。
- 本发布包不包含 access token、cookie、认证文件或账户数据。
