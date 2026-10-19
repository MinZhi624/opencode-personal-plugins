# Upstream Provenance: opencode-quota-zh 当前核心（v6）

`opencode-quota-zh` 的当前核心源码同步自
[`slkiser/opencode-quota`](https://github.com/slkiser/opencode-quota)：

- 上游版本：`v6.0.0-beta.1`（固定 tag）
- 固定提交：`358f58c3ffa3c9cf8efa6374ca37f7f8d298346a`
- 引入日期：2026-10-17
- 落地位置：`src/v6/**`（上游生产源码整体隔离在该子树内，上游内部相对导入路径不变，
  本地代码只经 `src/v6/plugin.js` 与 `src/v6/rpc.js` 两个入口进入）

> 版本标识只认上面的 tag + commit。仓库内留存的 `package.upstream.json` 是上游
> `package.json` 的快照（已对齐固定 v6 源码，`version` 字段为 `5.0.3`）；该字段仍是
> 与固定 tag 不同步的陈旧标识，不得据此推断上游版本，更不可据其写成 v4 或其它陈旧来源。
> 此快照不参与安装。

## 引入时排除的内容

以下上游内容不进入本仓库：

- 测试（tests）与 smoke 测试
- CI 工作流
- references 参考树
- pnpm 工作流
- `bin/index.ts`（上游 CLI 入口）
- 上游重复的 sqlite ambient 声明（`src/` 根下仅保留 `better-sqlite3`、`bun:sqlite`、
  `node:sqlite` 三个互不重复的模块声明）

## 当前架构与边界

上游 v6 后端是本仓库唯一的额度实现：Provider、认证、多账号、缓存、设置、命令、
session hooks 与报表全部来自 `src/v6/**`。本地只做接入与展示，主要接合文件如下
（并非全部本地代码，`pricing`／`sessionUsage` RPC 与 `pricingChanged` 事件等扩展
也分布在 `src/index.ts` 与 `src/quota-rpc.ts` 中）：

| 本地文件 | 角色 |
| --- | --- |
| `src/index.ts` | 服务器入口 wrapper：以本地插件 id `opencode-quota-zh` 调用真实的 v6 `QuotaToastPlugin.setup`，并在其上叠加一个本地 RPC |
| `src/quota-rpc.ts` | 本地 `opencode-quota-zh` RPC 定义（`snapshot`、`pricing`、`sessionUsage` 及 `pricingChanged` 事件） |
| `src/lib/quota-sidebar-cards.ts` | 将 v6 结构化 snapshot 转换为中文侧边栏卡片（4.9 时代本地核心树移除后仅剩此文件） |
| `src/tui-v2.tsx` | TUI 入口（raw TSX）：只渲染结构化卡片，不再从展示文本反推数值 |

本地适配与事件：本地 `opencode-quota-zh` RPC 在 `snapshot` 之外还扩展到
`pricing` 与 `sessionUsage`，并在价格来源或选择变化时向消费者发出 `pricingChanged`
事件唤醒刷新。`snapshot` 处理器经 `context.rpc(QuotaRpc)` 调用上游
`slkiser.opencode-quota` 通道取得结构化 snapshot，再转换为侧边栏卡片；查询失败以
RPC 错误原样上报，卡片显示失败态而非编造数据，凭据不跨边界。共享统计与 v6 报表
使用同一服务端用量引擎（单次遍历、按会话去重、价格守卫、稳定额度行身份），保证
同范围、同价格快照、同数据时点下两侧结果一致。

中文展示保持既有形态：多行卡片、20 格剩余条（`█`）、"已用 x% / 剩余 y%"双百分比、
以及"剩余时长（绝对时间）"的中文＋绝对重置时间。

## 构建与分发

构建不引入 Babel。`npm run build:quota-zh:runtime`（`scripts/build-runtime.mjs`）：

1. `tsc`（`tsconfig.runtime.json`）编译非 TUI 源码为 ESM `.js`（v6 TUI 的 `.tsx`
   与本地 TUI 入口被排除，不产生 `.jsx`）；
2. `src/data/modelsdev-pricing.min.json` 原样复制；
3. `src/v6/data/modelsdev-pricing.min.json` 随 v6 编译输出一同复制（v6 相对自身
   模块 URL 读取该数据）；
4. `src/v6/tui/**/*.tsx` 逐文件字节级复制，并为每个模块生成一个 `.js` re-export，
   使上游 `.js` 导入说明符保持可解析（见 `scripts/lib/v6-tui-dist.mjs`）；
5. `src/tui-v2.tsx` 字节级复制（OpenCode 按 raw TSX 加载）。

数据目前有两份：旧的 `src/data`（4.9 时代遗留快照，后续可清理）与 v6 的
`src/v6/data`。`dist/` 只由构建生成，禁止手改；根级 `npm run stage:runtime` 只纳入
生产输出与插件元数据文件。本仓库不引入上游测试与 CI；按维护决定由用户重启
OpenCode 后人工验收。

## 宿主环境与验收状态

- 根 `package.json` 的 `@opencode/plugin` 固定为 `2.0.28`；`engines.node` 为
  `^22.13.0 || >=23.4.0`；上游 v6 tag 声明 OpenCode 最低 `2.0.26`。
- 已知风险：随附 OpenTUI `0.5.x` 声明 `node >=26.4`，与当前 `v24.21` 存在 engine
  告警风险；不宣称已兼容，也不在未验收前擅自改动依赖版本。
- 源码已切换为 v6 核心＋本地 wrapper，`dist/` 已按新源码重建（含 `dist/v6`），
  中间 typecheck／build 通过，但运行验收未完成，不得据构建通过宣称已验证。

## 历史溯源（不适用于当前核心）

以下仅作历史记录，**不适用于当前 v6 核心**：

- 4.9.0 基线：提交 `fa9e66b53f8a5de1e0dc4c2ef623c83bef38c8b7`
  （`git describe`：`v4.9.0-34-gfa9e66b`），同步日期 2026-09-14。
- 2026-10-06 本地补丁"OpenAI 凭据来源与令牌能力"（宿主连接 → OpenCode auth.json →
  Codex 登录的候选链、Codex 登录文件读取器、JWT 令牌能力识别等）只针对 4.9 核心。
  原补丁没有整体移植；旧 OpenCode auth.json 候选链与 JWT 能力判断仍不启用。

## 当前本地兼容补丁：Codex 额度

- `src/lib/codex-quota-auth.ts` 只读 `${CODEX_HOME:-~/.codex}/auth.json`，由 Codex CLI 管理登录与刷新；插件不写入或刷新凭据。
- `src/v6/providers/openai.ts` 保留宿主多账号查询，额外查询 Codex 登录；结果独立标为「Codex CLI 登录」，不假定它与宿主账号相同（相同账号也可能显示两份来源）。
- 文件缺失或损坏不影响宿主账号；请求失败独立报告，可运行 `codex login` 更新凭据。凭据不进入 RPC 或诊断输出。
- 本机真实额度请求已返回 Plus 的 hourly/weekly 窗口；构建通过。真实 TUI 展示及完整运行验收仍待完成。
