# Bash grammar 资源

`tree-sitter-bash.wasm` 用于在远端命令执行前静态解析 Bash 语法，
提取权限资源（见 `../src/shell-parser.ts`）。它随插件一起分发，
不是构建期依赖：漏掉它时插件会在第一次远端命令执行时拒绝执行。

## 来源

- 上游：<https://github.com/tree-sitter/tree-sitter-bash>
- 获取自 npm 包 `tree-sitter-bash@0.25.1` 的预编译 wasm：
  <https://cdn.jsdelivr.net/npm/tree-sitter-bash@0.25.1/tree-sitter-bash.wasm>
- 许可证：MIT，完整原文见同目录 `LICENSE`（Copyright (c) 2017 Max Brunsfeld）。
  该文件和本说明随 WASM 一起复制进 `dist/grammar/` 与运行包。

## 完整性

| 项 | 值 |
| --- | --- |
| 文件 | `tree-sitter-bash.wasm` |
| 字节数 | 1358224 |
| SHA-256 | `8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a` |

核对：

```bash
sha256sum plugins/opencode-ssh-workshop/grammar/tree-sitter-bash.wasm
```

它需要与根 `web-tree-sitter`（当前 0.25.10）配合使用；升级其中任一方时，
应重新跑一遍 `npm run typecheck:ssh-workshop`、`npm run verify:ssh-permissions`
以及兼容 OpenCode 运行时上的 `npm run verify:ssh-permissions:native`。
构建还会核对 SHA-256 并实际加载 WASM 解析一次字面量命令。
