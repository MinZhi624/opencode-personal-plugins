# opencode-quota-card-zh — 「额度」卡片（独立 TUI 插件）

第二阶段侧栏模块化中的**额度卡片**：可单独启停的
TUI 插件，向侧栏宿主注册一张稳定身份为 `quota`、标题「额度」的卡片。卡片内容是
Quota v6 **原生侧栏面板**（`SidebarPanel`）的本地 Adapter：经本地桥接复用
`opencode-quota-zh` TUI 已发布的宿主（同一份额度客户端与显示设置草稿），
不恢复旧定制额度卡片；额度查询、Provider 核算与凭据留在服务端。

## 安装

`cli.json` 的 `plugins` 中追加（仓库 `config/cli.json` 已包含该条目）：

```json
"./opencode-zh-bundle/plugins/opencode-quota-card-zh"
```

宿主（`opencode-sidebar-host-zh`）需同时启用，卡片才会显示；只装卡片不装宿主时卡片安全
排队、不显示（见「宿主缺席」）。额度后台 `opencode-quota-zh` 独立启停，与本插件互不捆绑：
它同时提供 TUI 入口（发布桥接宿主）与服务端入口（额度 RPC）。

## 行为边界

**做**：向宿主注册稳定卡片；宿主缺席时安全排队；禁用时干净撤回注册、卡片设置入口与
会话订阅；经桥接渲染原生侧栏面板；按侧栏专属形状覆盖派生本卡片的 `host.display()`。

**不做**：

- 不自绘侧栏、不回退 `replace`。宿主缺席时绝不替换或重复原生侧栏。
- 不注册命令、键位或侧栏槽位。`/quota` 等命令归 `opencode-quota-zh` 后台插件所有，
  卡片显隐、启停都不影响它们；原生侧栏面板也由本卡片在宿主导管下渲染一份，
  不再由 `opencode-quota-zh` 的 TUI 独立挂载。
- 不复制额度业务与设置：只读桥接宿主与既有本地 `snapshot` RPC，不建立第二份设置，
  不渲染旧定制卡片，不新增 RPC，不改 quota client 的刷新算法。
- 不接触凭据。TUI 只经服务端 RPC 消费结构化非敏感数据，不取得 access／refresh token。

三种操作互相独立：**隐藏卡片**＝宿主显示偏好；**禁用本插件**＝撤销注册并清理；
**停用额度后台**＝卡片显示「额度后台未启用」并可重试。停用后台会改变数据能力，
与隐藏卡片不是同一件事。

## 卡片身份与注册契约

| 字段 | 值 |
| --- | --- |
| `id` | `quota`（稳定身份，宿主按它保存排序／显隐） |
| `owner` | `opencode-quota-card-zh`（撤销只影响自己） |
| `title` | `额度` |
| `requiredSeam` | `1`（与宿主 `SEAM_VERSION` 不一致即确定性拒绝） |
| `render(input)` | `(input: { sessionID }) => JSX.Element`，返回 `NativeQuotaCard`（原生 `SidebarPanel` 的 Adapter） |
| `dispose()` | 注册被撤销（含换代替换旧代）时由宿主调用 |

注册助手见 `../opencode-sidebar-host-zh/src/register-card.ts`。

## 展示状态与恢复

卡片按桥接宿主的有无与原生快照的有无呈现，任何状态都不是无限「加载中」：

| 状态 | 含义 |
| --- | --- |
| 原生面板 | 桥接宿主已发布且该会话已有快照：原生布局、开合、标记与计数 |
| 暂不可用 | 未检测到 `opencode-quota-zh` 的 TUI 插件（接入后自动恢复） |
| 额度后台未启用 | 本地 `snapshot` RPC 明确返回 `disabled`；提示启用后台后重试 |
| 额度查询失败 | 本地 `snapshot` RPC 失败：原样显示原因，不伪装成零额度 |
| 额度界面暂无响应 | 服务可答但原生客户端超过宽限（10s）仍未给出快照 |

中止态提供「重试」：复用原生客户端的 `refresh("manual", sessionID)` 与同一套状态读取，
不新建轮询。会话加载由 Adapter 按 host/session 额外保持一份 `quota.watch`（原生客户端
为引用计数，与面板那份合并为同一次轮询），因此中止态卸载面板后快照到达仍能自然恢复；
显示计数（`editing.sidebarShown()`）只随面板实际挂载建立与释放，隐藏、卸载、宿主换代
不残留可见计数。异步状态读取按代次校验：宿主发布／撤销、会话切换、快照到达与卸载都会
作废在途请求，迟到结果不覆盖新状态。

## 统一展示控制窗口中的卡片设置入口

向宿主 card seam 注册 `registerCardControls`（见
`../opencode-sidebar-host-zh/src/card-controls.ts`）：字段为空——额度业务设置仍由原生
额度窗口拥有，本插件不建立第二份同义设置；唯一动作「打开原生额度设置（/quota_settings）」
派发 `opencode-quota-zh` TUI 已注册的 `quota.settings` 命令，派发前先确认命令可达，
缺失时抛出明确错误，不静默假成功。侧栏专属进度条形状是另一作用域的展示偏好（见下）。

## 侧栏专属进度条形状（ticket03 接合处）

卡片调用宿主 `presentation.ts` 的 `useSidebarBarShape("quota")`：卡片覆盖优先，其次整体
形状，都没有时沿用原生自身设置。覆盖只派生本卡片传给 `SidebarPanel` 的 `host.display()`
（`layout.bar`），不改写宿主对象，因此 `/quota` 报表、状态栏、Home footer 与通知的外观
设置不受影响；形状变化不重挂面板。发布方由统一展示控制窗口接入，本插件只消费。

## 集成注意（给宿主与协调方）

1. **Seam 锚点键**：与宿主共用唯一 `register-card.ts` 协议和固定的 `Symbol.for` 锚点；独立安装的第三方卡片也可复制这个公开协议，不依赖模块缓存。
2. **宿主渲染义务**：宿主应以 `append: "sidebar.content"` 放置卡片，并对每张卡片的
    `render` 结果包 `ErrorBoundary`，使单卡渲染异常不拖垮其他卡片与原生侧栏。
3. **桥接宿主归属**：`opencode-quota-zh` 的 TUI setup 发布宿主、cleanup 撤销；本插件只读
   与订阅，不发布、不持有第二份。撤销后卡片显示「暂不可用」，重新接入自动恢复。
4. **命令与设置归属**：详细的额度命令与设置（`/quota`、`/quota_usage`、`/quota_status`、
   `/quota_settings`）由 `opencode-quota-zh` 的 TUI 独立注册，不随本卡片的渲染、隐藏或卸载
   而创建或消失。卡片上的动作只是跳转，不复制其业务。
5. **数据接口与后台命令**：卡片只调用 `opencode-quota-zh` 注册的 RPC。该接口与后台命令不被
   卡片显隐门控：在宿主隐藏本卡片、甚至禁用本卡片插件，都不会关闭 `/quota` 等命令与服务端
   额度查询。
6. **多 TUI**：每个 TUI 进程各自 setup、各自注册一份；排序／显隐设置由宿主持久化同步，
   卡片实例与订阅彼此隔离，不共享 JSX 节点。

## 类型检查

仓库现有的两条检查（改动后均应通过）：

```bash
npm run typecheck:sidebar   # 根脚本：含本插件 tui.ts 在内的侧栏相关入口
npm run typecheck:quota-zh  # 根脚本：quota-zh 工程自身
```

本插件自身文件在上述检查中无错误。另有的小型工程检查
`./node_modules/.bin/tsc --project plugins/opencode-quota-card-zh/tsconfig.json`
会在 **`plugins/opencode-quota-zh/dist/v6/tui/sidebar.tsx`（生成物）内** 报错：dist 的
v6/tui 是按字节复制的 TSX，其仅类型依赖（`QuotaClient`、`DisplaySettings`、`Theme` 等）
在编译出的 `.js` 同级文件中已擦除，从不同模块导入会暴露不同的丢失集合；这是导入
quota-zh dist 的既有限制，本轮不扩大修复。运行时不读 `src`：暂存发行包只含 quota-zh 的
`dist`，因此运行时导入路径必须是 `dist`（类型标注同样取自 dist 的 `SurfaceHost`）。

## 未验证项

- 真实安装后的 TUI 端到端人工验收（按安装版验收清单逐项执行，未勾选项不能视为通过）：
  侧栏只出现一份额度、顺序／显隐可管、隐藏不停后台、`/quota_settings` 跳转、中止态与
  重试、重开／重载／卸载无重复卡片或残留计数、统一窗口形状覆盖联动。
- 其他 OpenCode 版本；跨插件注册是版本限定、需升级复验的自有接合处，非官方承诺接口。
