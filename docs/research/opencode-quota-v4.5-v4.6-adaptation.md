# slkiser/opencode-quota v4.5.x–v4.6.x 适配调研

**调研日期：2026-08-11**　**比较基线：**`73dfcf1a4c4c6214f73993de5c81b22d394ff0a5`（v4.4.1）→ v4.6.1

> **2026-08-14 更新：** 本文档中涉及「补 snapshot/fixture 回归」「四表面回归」「补测试」的
> 建议已过时。quota-zh 已删除全部自动化测试（`tests/`、vitest），改为人工校验：
> 重启 OpenCode 后检查 `/quota`、`/quota_status`、TUI 侧边栏与配置迁移。后续适配
> （Kilo Pass、Kimi K3、prompt bar、reset 通知等）只做构建/typecheck 门禁 + 人工验证，
> 不再新增测试。

## 结论先行

这不是一次 v4.0 式迁移：4.5.x/4.6.x 的 release notes 没有宣布配置或 JSON schema breaking change，普通用户主要得到更快的 TUI、Kilo/Kimi 数据和两个可选通知/展示面。因此“只看上游更新”难度低到中等；但本地中文 fork 同时改了 TUI、侧栏和几乎所有格式化层，且计划加入启动提示、额度告警、命名空间隔离和恢复 `src`，所以**直接覆盖 bundle 不安全**。应以逐 tag 的 source diff 重放，优先恢复 source，再逐层合并。

## 一手来源与范围

- 上游 v4.5.0、v4.5.1、v4.6.0、v4.6.1 的官方 release notes：[releases API](https://api.github.com/repos/slkiser/opencode-quota/releases?per_page=20)。
- 逐 tag 官方 compare/diff：[v4.4.1..v4.5.0](https://github.com/slkiser/opencode-quota/compare/v4.4.1...v4.5.0)、[v4.5.0..v4.5.1](https://github.com/slkiser/opencode-quota/compare/v4.5.0...v4.5.1)、[v4.5.1..v4.6.0](https://github.com/slkiser/opencode-quota/compare/v4.5.1...v4.6.0)、[v4.6.0..v4.6.1](https://github.com/slkiser/opencode-quota/compare/v4.6.0...v4.6.1)。完整基线比较确认是 **47 commits ahead、0 behind**：[官方 compare](https://github.com/slkiser/opencode-quota/compare/73dfcf1a4c4c6214f73993de5c81b22d394ff0a5...v4.6.1)。
- 相关 source：[v4.6.1 `src/tui.tsx`](https://raw.githubusercontent.com/slkiser/opencode-quota/v4.6.1/src/tui.tsx)、[v4.6.1 `src/lib/config.ts`](https://raw.githubusercontent.com/slkiser/opencode-quota/v4.6.1/src/lib/config.ts)。发布包入口和版本可由官方 npm 包 [@slkiser/opencode-quota](https://www.npmjs.com/package/@slkiser/opencode-quota) 复核。

## 逐个 release/tag

| tag | 用户可见变化 | 关键 source/commit 与模块 | breaking 判断 |
|---|---|---|---|
| **v4.5.0** | Kilo Gateway 增加 Kilo Pass 配额、剩余 credit、续期和安全 accounting；无 Pass 时回退余额。TUI/OpenTUI 依赖对齐 OpenCode 1.18.11；文档和打包验证流程整理。 | [release](https://github.com/slkiser/opencode-quota/releases/tag/v4.5.0)；Kilo 的 PR/合并提交链从 [#195](https://github.com/slkiser/opencode-quota/pull/195) 可见，涉及 `src/providers/kilo`、结果/分组 formatter、测试和 provider metadata；同 tag diff 还显示 package/dependency、docs、CI/package smoke 变更。 | Release 没有列 breaking。Kilo 是 provider 行为/API 改造，属于**潜在运行时兼容风险**，不是配置迁移 breaking；Kilo 使用者必须做真实响应回归。 |
| **v4.5.1** | 慢配置检查不再阻塞 TUI 启动；AGY authentication snapshot 升至 1.1.10。 | [release](https://github.com/slkiser/opencode-quota/releases/tag/v4.5.1)；`src/tui.tsx` 的异步、disposal-aware 注册见 [diff 文件 patch](https://github.com/slkiser/opencode-quota/compare/v4.5.0...v4.5.1.diff)；AGY 快照/lock/package 变更见同一官方 diff。关键 TUI commit 为 [`1237152`](https://github.com/slkiser/opencode-quota/commit/123715203dec05c88f9f10cec0d1465d43434d4a)，AGY 为 [`9be1f17`](https://github.com/slkiser/opencode-quota/commit/9be1f173ba41f5618b478c3636975cadce2df71b)。 | 无声明 breaking；但命令和 slots 可能在配置解析完成后才出现，dispose 竞态下可不注册，这是 TUI 生命周期语义变化，需测试。 |
| **v4.6.0** | 启动时更早显示初始 TUI quota、减少启动工作；增加**可选** quota window reset 通知；Kimi K3 文档模型开始按官方价格计算 token cost；Windows `~\...` export path 正确展开；贡献者验证/外部 integration 文档扩充。 | [release](https://github.com/slkiser/opencode-quota/releases/tag/v4.6.0)；reset 的实现/隐私/持久状态设计见 [#200](https://github.com/slkiser/opencode-quota/pull/200) 和 [`c2dca3c`](https://github.com/slkiser/opencode-quota/commit/c2dca3c14904fef36712b682b28b54d9d7c149d0)；Kimi 官方价格、`k3`/`k3-256k` 映射见 [#208](https://github.com/slkiser/opencode-quota/pull/208) 与 [`0b824e3`](https://github.com/slkiser/opencode-quota/commit/0b824e3452876fe9e034bae4ab3e7d767461b7f6)；export path 见 [#207](https://github.com/slkiser/opencode-quota/pull/207)。模块横跨 `config/types`、reset state/observer、toast、TUI runtime、`quota-export`、Kimi pricing、tests/docs。 | Release 无 breaking。reset 通知默认关闭、复用已取得的 provider results、不发新请求；但它新增本地持久状态和主动 toast，属于可见行为/数据变化。 |
| **v4.6.1** | 补回 v4.6.0 漏掉的 reset notification follow-up；新增 TUI prompt 下 quota bar（最终为 opt-in，关闭时保留旧 compact status）。bar 优先 5h window，显示剩余百分比/倒计时，运行中轻微动画。 | [release](https://github.com/slkiser/opencode-quota/releases/tag/v4.6.1)；prompt bar 的 source 设计和测试范围见 [#210](https://github.com/slkiser/opencode-quota/pull/210)，实现核心 [`5ce5d08`](https://github.com/slkiser/opencode-quota/commit/5ce5d08001ffc94840b8f8bfe2d714dc6152f151)，最终 opt-in/空结果/fallback 修复 [`4bb4b86`](https://github.com/slkiser/opencode-quota/commit/4bb4b860faa14d397256f2ae47430a28c1dbbe57)，发布合并 [`c57ba5e`](https://github.com/slkiser/opencode-quota/commit/c57ba5ee5e5273c876bab7aa0de42c98c06c8da1)。涉及 `types/config`、`tui-panel-state`、`tui-runtime`、`src/tui.tsx`、TUI smoke/runtime/startup tests。 | 无声明 breaking；默认关闭使旧用户兼容。若本地曾把 prompt/compact slot 改成中文专用布局，则是高冲突而非上游 breaking。 |

### 4.5.x 的关键 diff 归纳

4.5.0 的变化集中在 Kilo provider/accounting 和依赖/工具链，而不是公共配置 schema；4.5.1 的实质代码很小但碰到 TUI 注册时机。4.5.1 官方 diff 还明确把 AGY 1.1.10 的 request-model fallback/enum handling 同步进 bundle，同时说明 auth、quota、credential layout 保持兼容（见 [`9be1f17`](https://github.com/slkiser/opencode-quota/commit/9be1f173ba41f5618b478c3636975cadce2df71b)）。

### 4.6.x 的关键 diff 归纳

reset observer 的契约是：provider-neutral、opt-in、按 hash 后的 account/window identity 存本地观察值，只有跨过 reset boundary 且新 quota 增长时聚合通知；PR #200 明确说“不增加 provider requests”，并覆盖 persistence、account isolation、server-toast tests。它与“危险额度告警”不是同一触发器。prompt bar 则是新的 `quotaToast.tuiPromptBar.enabled` 配置和新 panel state；官方 source 还显示它与 `tuiCompactStatus.sessionPrompt` 走互斥 fallback，而不是同时绘制。

## 配置、数据、Provider、TUI、测试与工具链影响

- **配置/数据：** 新增 `resetNotifications.enabled/windows`、`tuiPromptBar.enabled`；reset 观察状态是新的本地数据，必须使用独立 schema/命名空间。export path 是语义修复，不是格式迁移。4.6.1 source 的 setting-source tracking 也意味着中文 fork 若有自己的 config merge，不能只拷贝 UI。
- **Provider/价格：** Kilo 从 v4.5.0 开始是最大 provider 风险点；Kimi K3 是低风险、可隔离的 pricing/alias 数据变更。AGY 是依赖快照更新，不能把上游完整 `dist` 覆盖本地中文 bundle。
- **TUI：** v4.5.1 的异步 surface registration、v4.6.0 的 initial-load reuse、v4.6.1 的 prompt bar 都集中触碰 `tui.tsx`/`tui-runtime`/slot registration；这是本地改动最密集的区域。
- **测试：** 上游把 TUI startup、配置来源、selection/fallback/layout/lifecycle、reset persistence/account isolation、Kilo stream cancellation 和 Kimi pricing 纳入测试；本地当前可见交付物主要是 `plugins/opencode-quota-zh/dist`，没有对应上游测试树，适配后至少要补 snapshot/fixture 和四表面回归。
- **工具链：** 4.5.0 对齐 OpenCode 1.18.11/OpenTUI；上游 PR 验证包含 Node 22/24、TypeScript 7、build、package smoke 和完整 suite（例如 [#210](https://github.com/slkiser/opencode-quota/pull/210)）。这不是用户配置 breaking，但恢复 source 时必须把依赖和构建链一起纳入基线。

## 对本地 `opencode-quota-zh` 的冲突与可移植性评估

本地相对 v4.4.1 的已知中文改动是：`dist/tui.tsx`、`dist/quota-zh-sidebar.tsx`、`format-utils`、`quota-command-format`、`quota-dialog-commands`、`quota-stats-format`、`session-tokens-format`、`tui-compact-format`、`modelsdev-pricing`。因此：

| 类别 | 判断 | 处理建议 |
|---|---|---|
| Kimi K3 prices/aliases | **可直接移植，低冲突** | 先比较 `modelsdev-pricing` 的数据模型；只引入官方 K3 价格和精确 ID 映射，不改中文显示层。 |
| Windows export path、AGY snapshot、Kilo provider | **可按文件/commit 移植，中冲突** | provider 与工具库可优先重放；Kilo 必须用真实 response fixture，AGY 只同步上游 snapshot/lock，不覆盖中文文案。 |
| reset notification | **需手工重放，中高冲突** | 与本地规划的“额度告警”共享状态机/账号隔离思路，但 reset 是恢复事件通知，危险阈值告警是另一 episode；不要共用触发条件或把失败当耗尽。 |
| prompt quota bar / startup prompt | **需手工重放，高冲突** | 上游 bar 是 prompt slot 的新布局；本地“启动提示”应是 passive hint，不能替换每次 prompt。抽取上游 `PromptBarState`/runtime selection，再接中文 `format-utils` 和本地命名空间。 |
| `tui.tsx`、sidebar、全部 formatter | **高冲突** | 不做整文件 cherry-pick；按“数据结构 → runtime → formatter → surface”拆 patch，保留中文标签和 narrow-width 规则。 |
| `modelsdev-pricing` | **中冲突** | 数据可合并，金额/未定价语义必须保持：未知价格不能渲染为 0。用 Kimi 官方 PR 的 exact-match 规则补测试。 |
| 恢复 `src` | **前置工作** | 现有 package 的入口是 `dist/index.js`，而 source-level forward merge 需要 source tree。先从本地 dist/source map 或最后可信 upstream source 重建可编译 source，再开始升级。 |

命名空间隔离尤其重要：上游 reset 设计已对 account/window 做 hash，但本地未来的 quota alert、startup hint、中文插件状态不能写入同一 key；建议至少按 `opencode-quota-zh/<feature>/<provider-account-window>` 隔离，并保存版本号和完整性状态。

## 建议基线顺序与粗略难度

1. **基线 A：恢复 `src` + 固化 v4.4.1 中文行为**（中高，约 1–2 天）：不改生产配置，建立可 build 的 source、provider fixture、formatter snapshot。
2. **基线 B：v4.5.0**（中，约 0.5–1 天）：先依赖/工具链，再 Kilo，再 docs/tests；不要先碰 TUI 中文布局。
3. **基线 C：v4.5.1**（中，约 0.5 天）：手工重放异步注册和 AGY snapshot，验证启动、dispose、命令出现时机。
4. **基线 D：v4.6.0**（中高，约 1–2 天）：先 Kimi pricing/export path，再 reset observer 的独立状态；最后接 passive startup hint/未来 alert 的抽象。
5. **基线 E：v4.6.1**（高，约 1–2 天）：抽取 prompt-bar 数据管线，手工接中文 surface；默认关闭，确保旧 compact 行不变。
6. 每一步都跑 typecheck/build、最小 provider fixtures、TUI smoke、四 surface（command/toast/sidebar/compact）快照；Kilo 和 reset 再做跨进程/空结果/恢复边界测试。

综合估计：**只升级功能、不保留中文深改：低到中；保留现有中文改动并加入已确认规划：中高**。最稳的交付策略是“上游核心数据/生命周期先跟进，中文文案和显示适配最后手工重放”，而不是把 v4.6.1 的 `dist` 当作可直接替换包。

## 2026-08-14 适配状态核对（本地 opencode-quota-zh）

对照上游逐 tag diff（v4.4.1→v4.6.1）核对本地实现的适配状态。结论：**P1 候选均已在本地实现或对齐，无待补代码缺口**（“恢复 src 基线”`9119b7a`、checkpoint `0374b7e` 及 v2 提交 `4eb13a6` 已覆盖）。

| 候选 | 上游来源 | 本地结论 |
|---|---|---|
| Kilo Pass 配额/剩余 credit/续期/安全 accounting | v4.5.0（PR #195） | ✅ `src/lib/kilo.ts` 与上游 v4.5.0 逐字节一致；`src/providers/kilo.ts` 仅多本地 v2 告警 balance fact（有意扩展）；`kilo-config.ts`/`registry.ts`/`entries.ts` 对齐 |
| Kimi K3 / k3-256k 官方价格与精确映射 | v4.6.0（PR #208） | ✅ HEAD 已含：`modelsdev-pricing.min.json` 的 `kimi-k3`（input 3 / output 15 / cache_read 0.3）、`quota-stats.ts` 的 `kimi-for-coding→moonshotai` 别名与 `k3`/`k3-256k→kimi-k3` 映射，与上游 diff 一致 |
| AGY snapshot 1.1.10（凭证布局兼容） | v4.5.1（`9be1f17`） | ✅ 无待办：上游该 commit 只改 `references/upstream-plugins/opencode-agy-auth` vendored 快照（1.1.8→1.1.10），零 src 改动；本地无 vendor 树，运行时不受该版本号影响 |
| TUI 异步注册生命周期 | v4.5.1（`1237152`） | ✅ 已实现：`initializeTuiRegistration` 异步启动、`FALLBACK_SURFACE_REGISTRATION` 失败回退、dispose-aware `gate.activate`（dispose 后不再注册），命令/slots 在配置解析后激活 |
| prompt bar 数据管线 | v4.6.1（PR #210） | ✅ 已实现并标注 “Upstream v4.6.1”：`pickPromptBarEntry` 优先 5h window、最低剩余百分比回退、160ms 运行动画、与 `tuiCompactStatus.sessionPrompt` 互斥 fallback、`tuiPromptBar`↔`promptBar` 双键同步、默认关闭 |
| reset 自动通知 | v4.6.0（PR #200） | ⏭️ 维持跳过：与本地“危险额度告警”不是同一触发器，按历史 Ticket 05 决定不实施 |
| Windows export path `~\` 展开 | v4.6.0（PR #207） | ✅ 已实现：`quota-export.ts` 对 `~/` 与 `~\` 展开 `homedir()` |
| 初始 TUI quota 提前显示（initial-load reuse） | v4.6.0 | ✅ 已实现：`resolveTuiSurfaceRegistration` 捕获初始 runtime，首个 session/home 加载复用 seed |

剩余人工验证（涉及真实账户，无法自动化）：有 **Kilo Pass** 或 **AGY** 账户的用户重启 OpenCode 后核对 `/quota` 中对应 provider 输出与 `/quota_status` 诊断——Kilo 上游明确要求真实响应回归。

## 引用索引

所有外部事实均来自上游官方 GitHub release、commit、compare/diff、source 或 npm：

1. [v4.5.0 release](https://github.com/slkiser/opencode-quota/releases/tag/v4.5.0)
2. [v4.5.1 release](https://github.com/slkiser/opencode-quota/releases/tag/v4.5.1)
3. [v4.6.0 release](https://github.com/slkiser/opencode-quota/releases/tag/v4.6.0)
4. [v4.6.1 release](https://github.com/slkiser/opencode-quota/releases/tag/v4.6.1)
5. [v4.4.1..v4.6.1 official compare](https://github.com/slkiser/opencode-quota/compare/73dfcf1a4c4c6214f73993de5c81b22d394ff0a5...v4.6.1)
6. [reset notification PR #200](https://github.com/slkiser/opencode-quota/pull/200)
7. [Kimi pricing PR #208](https://github.com/slkiser/opencode-quota/pull/208)
8. [Windows export path PR #207](https://github.com/slkiser/opencode-quota/pull/207)
9. [TUI prompt bar PR #210](https://github.com/slkiser/opencode-quota/pull/210)
10. [published npm package](https://www.npmjs.com/package/@slkiser/opencode-quota)
