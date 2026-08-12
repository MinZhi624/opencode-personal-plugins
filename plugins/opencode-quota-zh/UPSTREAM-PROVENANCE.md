# Upstream Provenance: opencode-quota v4.4.1 source baseline

本目录下的 `src/`、`tests/`、`scripts/`、`docs/`、`contributing/`、`references/` 与下列根级文件
是从上游项目恢复的可追溯基线，供 Ticket 01 及后续 Ticket 从源码继续工作，**不参与运行时分发**。
## 来源

| 项目 | 值 |
|---|---|
| 上游仓库 | [slkiser/opencode-quota](https://github.com/slkiser/opencode-quota) |
| 版本 / Tag | v4.4.1 |
| 固定 Commit | `73dfcf1a4c4c6214f73993de5c81b22d394ff0a5` |
| 已知上游错位 | v4.4.1 tag 内 `package.json` 的 `version` 字段为 `4.4.0`（上游发布时未同步 tag 与内部版本号）；基线原样保留该版本号，不是本 fork 的改动 |
| 来源归档 | `https://github.com/slkiser/opencode-quota/archive/refs/tags/v4.4.1.tar.gz` |
| SHA-256 | `d936af7c36b97f0284b2ad9e46ba7f17d86baf2242e3ff3f14549008c28b17b7` |
| 许可证 | MIT（原文见 `LICENSE.upstream`；中文 Fork 自身许可证保持 `LICENSE`） |

获取与校验方式：

```bash
curl -L -o v4.4.1.tar.gz https://github.com/slkiser/opencode-quota/archive/refs/tags/v4.4.1.tar.gz
sha256sum v4.4.1.tar.gz   # 必须等于上表 SHA-256
```

## 恢复内容

- `src/`：上游 v4.4.1 TypeScript 源码（含 `src/data/modelsdev-pricing.min.json`）。
- `tests/`：上游 v4.4.1 测试树，含 `tests/fixtures/` 与 `tests/helpers/`。
- `scripts/`：上游构建/发布辅助脚本中**支持本地源码构建与离线校验**的子集
  （`build-dev.mjs` 为本仓库新增，见下）；仅服务于已删除第三方 reference 树的
  upstream-plugin 同步/校验工具链未恢复（见「第三方 plugin references」一节）。
- `docs/`、`contributing/`、`README.md`：上游仓库内容，供上游文档一致性测试使用。
- `references/`：只保留上游文档类参考 —— `references/upstream-quota/CONTRIBUTING.md`。
- `references/upstream-quota/CONTRIBUTING.md`：上游 v4.4.1 的 `CONTRIBUTING.md` 原文（pnpm 工作流），
  未改动。本目录**不在插件根级提供** `CONTRIBUTING.md`，避免上游 pnpm/CI 工作流被误当作本
  fork（统一使用根 `package.json` 的 npm 工作流）的贡献者入口；上游原文仅作可追溯参考。
- `LICENSE.upstream`：上游 MIT 许可证原文；`package.upstream.json`、`tsconfig.upstream.json`、
  `vitest.config.upstream.ts`：上游原始清单/构建/测试配置，未改动，仅作对照。
- 未纳入：`pnpm-lock.yaml`、`pnpm-workspace.yaml`（本仓库统一使用根 `package-lock.json` 单一 npm
  锁文件，不引入第二套包管理器或锁文件）、`.husky`、`.lintstagedrc`、`.git`，以及第三方
  plugin references（`references/upstream-plugins/`，见下）。

### 第三方 plugin references 未纳入本地离线 baseline

上游仓库的 `references/upstream-plugins/` 是**第三方插件**（`opencode-cursor-oauth`、
`opencode-agy-auth`、`opencode-antigravity-auth`、`opencode-gemini-auth`、
`opencode-qwencode-auth` 等）的 npm 同步快照，包含大量第三方 dist 产物与 `lock.json`。
它不属于本 bundle 的 runtime/source：该树未纳入本地离线 baseline（也不会被恢复），
且其同步/校验工具链同样未恢复 —— 只服务于该树的
`scripts/sync-upstream-plugin-references.mjs`、`scripts/check-upstream-plugin-updates.mjs`、
`scripts/prepare-upstream-plugin-review.mjs` 与 `scripts/lib/upstream-plugin-*.mjs`
（死路径 helper）已删除，不留下任何可重建已删树的命令。

相关上游测试（`tests/upstream-plugin-identity/issues/lock/reference-integrity/registry/
review/sanitization/specs/sync`、`tests/upstream.cursor-oauth.reference.test.ts`）
按上游原文**逐字保留**，作为上游历史原文，但已从离线 baseline 显式排除（见下方
vitest 排除项）：它们验证的是第三方插件同步参考及其已删除工具链，不属于本 bundle 的
runtime/source。`pricing-resolver.coverage.test.ts` 中唯一依赖该参考树的
「Cursor upstream fallback model id」覆盖用例已随参考树删除，不保留永远 skip 的死代码；
其余真实 runtime pricing 用例全部保留。

## 本地适配（Ticket 01/02）

1. `tsconfig.json`：以上游 `tsconfig.upstream.json` 为基础，仅把 `outDir` 改为 `./dev-dist`，
   使根命令构建到**非运行时**的开发输出；`dist/` 由 Ticket 02 的运行时构建生成（见下），
   不作为手写维护目标。
2. `scripts/lib/cross-platform-command.mjs`：跨平台 child-process 调用助手。契约是
   「裸命令名 + shell 标志」（`{ command, shell }`），不是平台化文件名：Windows 上
   `execFileSync` 不能直接启动 `npm.cmd`/`tsc.cmd` 这类 shim，所以 Windows 以裸
   `npm`/`tsc` 经 `cmd.exe`（`shell: true`）执行，非 Windows 直接执行、不用 shell；
   `runSync()` 供真实调用。`build-dev.mjs`/`build-runtime.mjs` 的 `tsc` 与
   `tests/baseline-boundary.test.ts` 的 `npm run build*` 都经它执行。
3. `scripts/build-dev.mjs`：`npm run build:quota-zh` 的入口 —— 清理 `dev-dist`、经
   `cross-platform-command.mjs` 运行 `tsc --project tsconfig.json`、拷贝 `src/data` 数据。
4. `tsconfig.runtime.json`：运行时构建配置 —— 继承 `tsconfig.json`，`outDir` 为 `./dist`，
   并排除 `src/tui.tsx` 与 `src/quota-zh-sidebar.tsx`（这两个 TUI 入口由 OpenCode 以原始
   TSX 加载，按字节拷贝，不参与编译，避免产生 `.jsx` 重复产物）。
5. `scripts/build-runtime.mjs`：`npm run build:quota-zh:runtime` 的入口 —— 从 `src/` 生成
   可重复验证的运行时分发 `dist/`：tsc 编译为纯 ESM `.js`、拷贝 `src/data`、按字节拷贝
   唯一受支持的 TUI 入口对（`tui.tsx` + `quota-zh-sidebar.tsx`），并断言 dist 不含
   源码/声明/映射/`.jsx` 产物。`--check` 模式在临时目录执行干净构建并与已提交 `dist/`
   逐文件 SHA-256 比较（干净构建字节同一性门禁）。上游的 esbuild/babel TUI 打包
   （`prepare-tui-dist.mjs`）已被该管线取代，脚本仅作为上游历史原文保留。
6. `vitest.config.ts`：离线测试基线配置（`root` 指向本目录，`include: tests/**/*.test.ts`）。
   以下上游测试因依赖 git 执行、npm registry、上游发布版 `package.json`、`.github`
   workflows 或第三方 plugin references 树（`references/upstream-plugins/`），不属于本
   bundle 的离线基线，故显式排除：
   `release-gates`、`verify-release-version`、`package-manifest`、`github-workflows`、
   `v4-migration-docs`、`tui-dist-packaging`、`upstream-plugin-identity/issues/lock/
   reference-integrity/registry/review/sanitization/specs/sync`、
   `upstream.cursor-oauth.reference`（后两者验证的是第三方插件同步参考及其已删除工具链，
   不是本 bundle 的 runtime/source；测试按上游原文逐字保留为历史原文，但配置明确它们
   不属于本地 baseline）。基线测试全部离线运行：不读取真实凭证、不请求 Provider/网络。
7. `tests/setup.ts`：离线测试网络守卫 —— 对全局 `fetch` 与 `node:http`/`https`/`net`/`tls`/
   `dns` 的 `get`/`request`/`connect`/`lookup` 等入口强制抛错，使整个基线在任何未安装
   per-test mock 的情况下快速失败而不是泄漏真实流量。
8. `scripts/stage-runtime.mjs`：quota-zh 的 runtime staging 只允许
   `dist/`、`package.json`、`LICENSE`、`README.zh.md`，其余（src/tests/fixtures/dev 配置）一律
   拒绝。staging 的 quota-zh 内容与当前 `dist/` 逐文件一致。
9. `tests/baseline-boundary.test.ts`：Ticket 01/02 边界验证 —— 源码基线存在性与可追溯性、
   开发构建不触碰 `dist/`、运行时构建从 `src/` 重新生成 `dist/` 且干净构建字节同一性
   （`build:quota-zh:runtime -- --check`）、staging 不携带非运行时文件、上游
   `CONTRIBUTING.md` 仅以 `references/upstream-quota/CONTRIBUTING.md` 参考形式存在
   （插件根级不存在贡献者入口）。child-process 调用断言直接验证 `{ command, shell }` 语义，
   不依赖对脚本源码的文本匹配。
10. `tests/runtime-golden.test.ts` + `tests/fixtures/runtime-golden/`：Ticket 02 运行时黄金
    fixture —— `scripts/capture-runtime-golden.mjs` 在切换运行时分发前，对既有中文 v1.0.1
    `dist/` 执行并记录 `/quota`、`/quota_status`、`/tokens_*`、format-utils、compact status、
    modelsdev 价格快照与 TUI 入口字节快照；测试对 `src/` 断言同样输入产生逐字节相同输出，
    证明源码行为重放了既有中文运行行为（未定价≠零、窄宽布局、命令注册顺序等）。fixture
    还锁定 dist 只保留唯一受支持的 TUI 入口对且不携带开发产物。

## 上游 tag 顺序重放记录（Ticket 03–06，Wave A）

按上游 tag 顺序逐边界重放，每个边界的来源归档、SHA-256、已采用/明确跳过与验证结果
记录在各 Ticket 的实现记录中（`.scratch/opencode-quota-zh-v2/issues/03…06`）。摘要：

| 边界 | 来源归档 SHA-256 | 主要采用 | 明确跳过 |
|---|---|---|---|
| v4.4.1 → v4.5.0（Ticket 03） | `a231749f2b468d5183ac13d9ba03b9bd9b0c387e1499e42031fc31c9f96b9723` | Kilo Pass/余额回退/安全 accounting、rawDetails 消毒与深拷贝、kilo 状态 section；非中文文件逐字重放；`@opencode-ai/plugin` 对齐 1.18.11 | 中文文件中的纯 import 排序；puppeteer/biome/lefthook/TS7 工具链 |
| v4.5.0 → v4.5.1（Ticket 04） | `972535099ad14303f9008b664f7a219d860594586b538c5c6b0ccaabd0d773e5` | TUI 异步注册生命周期（disposal-aware）、AGY 快照 1.1.10（凭证布局兼容，第三方面板树仍不纳入基线） | 无（AGY 参考树按 Ticket 01 排除项保留排除） |
| v4.5.1 → v4.6.0（Ticket 05） | `9e80398e2af003e6f4424561e18f404a0b98dce37424bdbb22a4dddbcd659a62` | Kimi `k3`/`k3-256k` 官方价格与精确映射、Windows `~\` 导出路径、TUI initial-load 复用（registration gate + 初始 seed 协调器；中文侧边栏独立 ticket） | reset 自动通知整体：`quota-reset-notifications.ts`、plugin observer/toast、`resetNotifications` 配置 schema、`providerResults` 字段、`lib.quota-reset-notifications.test.ts` |
| v4.6.0 → v4.6.1（Ticket 06） | `beb433a2d5845bdbca6f3ddd0c54542b31a7f62239e5d21f133094d52872e764` | prompt bar 数据管线（5h 优先/最低剩余 fallback）、panel state、compact 互斥 fallback；默认关闭 | reset 通知（同 Ticket 05）；不覆盖中文 compact/会话界面 |

## 与当前中文版运行时的关系

Ticket 01 建立独立开发基线时，当前 `dist/` 内已安装的中文版产物、`package.json` 入口、
TUI/Server 行为均不因该 Ticket 改变。Ticket 02 起，中文行为已完整重放进 `src/`（由黄金
fixture 逐字节锁定），`dist/` 成为**由源码生成并提交**的可重复构建产物：`npm run
build:quota-zh:runtime` 重新生成，`-- --check` 与干净构建逐文件比较，`npm run check` 全量
验证。后续 Ticket 从 `src/` 出发按上游 tag 顺序同步，再重新生成运行时产物。
