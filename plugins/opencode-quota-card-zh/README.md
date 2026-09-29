# opencode-quota-card-zh — 「额度」卡片（独立 TUI 插件）

第二阶段侧栏模块化（docs/refeactor/SIDEBAR-PHASE2-SPEC.md）中的**额度卡片**：可单独启停的
TUI 插件，向侧栏宿主注册一张稳定身份为 `quota`、标题「额度」的卡片。卡片内容原样复用
`opencode-quota-zh` 已构建的 `QuotaPanel`；额度查询、Provider 核算与凭据留在服务端。

## 安装

`cli.json` 的 `plugins` 中追加（仓库 `config/cli.json` 已包含该条目）：

```json
"./opencode-zh-bundle/plugins/opencode-quota-card-zh"
```

宿主（`opencode-sidebar-host-zh`）需同时启用，卡片才会显示；只装卡片不装宿主时卡片安全
排队、不显示（见「宿主缺席」）。额度后台 `opencode-quota-zh` 独立启停，与本插件互不捆绑。

## 行为边界

**做**：向宿主注册卡片；宿主缺席时安全排队；禁用时干净撤回注册与排队请求。

**不做**：

- 不注册任何命令、键位或槽位。`/quota` 等命令归 `opencode-quota-zh` 后台插件所有，
  卡片显隐、启停都不影响它们（规格用户故事 11／12）。
- 不自绘侧栏、不回退 `replace`。宿主缺席时绝不替换或重复原生侧栏（用户故事 22）。
- 不接触凭据。TUI 只经服务端 RPC（`snapshot`／`settings`）消费结构化非敏感数据，
  不取得 access／refresh token（规格「quota 责任区」红线）。
- 不改额度口径。既有 RPC 状态（`ready`／`disabled`）与展示状态（加载中／额度查询失败／
  额度后台未启用／暂无额度数据）由 `QuotaPanel` 原样保留，失败不显示为零额度。
- 不复制额度渲染逻辑；展示随 `opencode-quota-zh` 的构建产物单一来源演进。

三种操作互相独立：**隐藏卡片**＝宿主显示偏好；**禁用本插件**＝撤销注册并清理；
**停用额度后台**＝卡片显示「额度后台未启用」。

## 卡片身份与注册契约

| 字段 | 值 |
| --- | --- |
| `id` | `quota`（稳定身份，宿主按它保存排序／显隐） |
| `owner` | `opencode-quota-card-zh`（撤销只影响自己） |
| `title` | `额度` |
| `requiredSeam` | `1`（与宿主 `SEAM_VERSION` 不一致即确定性拒绝） |
| `render(input)` | `(input: { sessionID }) => JSX.Element`，返回 `QuotaCard`（包 `QuotaPanel`） |
| `dispose()` | 注册被撤销（含换代替换旧代）时由宿主调用 |

注册助手见 `../opencode-sidebar-host-zh/src/register-card.ts`。

## 生命周期

- **setup**：`registerSidebarCard` 发现宿主后注册，缺席则排队；被拒时提示原因。
- **cleanup**：调用注册句柄 `dispose()`，撤销本次注册及排队请求（含宿主代注册路径）。
- **宿主换代**：宿主卸载不撤销卡片注册，新宿主代接管同一注册表；本插件 cleanup 只在
  自身被禁用时运行。

## 集成注意（给宿主与协调方）

1. **Seam 锚点键**：与宿主共用唯一 `register-card.ts` 协议和固定的 `Symbol.for` 锚点；独立安装的第三方卡片也可复制这个公开协议，不依赖模块缓存。
2. **宿主渲染义务**：宿主应以 `append: "sidebar.content"` 放置卡片，并对每张卡片的
   `render` 结果包 `ErrorBoundary`，使单卡渲染异常不拖垮其他卡片与原生侧栏。
3. **卡片内交互**：`QuotaPanel` 自带折叠点击、60 秒刷新、事件订阅（`session.step.ended`／
   `session.execution.failed`）与组件级 `onCleanup` 释放；其内部的「额度设置面板」keymap
   命令（部分错误显示方式）是既有面板自身交互，随卡片渲染创建、随卸载消失，不属于本
   插件 setup 的命令注册。
4. **数据接口**：卡片只调用 `opencode-quota-zh` 注册的 RPC；该接口不被卡片显隐门控，
   停用本插件不影响 `/quota` 命令与后台查询。
5. **多 TUI**：每个 TUI 进程各自 setup、各自注册一份；排序／显隐设置由宿主持久化同步，
   卡片实例与订阅彼此隔离，不共享 JSX 节点。

## 类型检查

```bash
./node_modules/.bin/tsc --project plugins/opencode-quota-card-zh/tsconfig.json
```

已知噪声（均不在本插件内）：`plugins/opencode-quota-zh/dist/tui-v2.tsx` 的 8 条错误，
根因是该构建产物按其 `.js` 依赖推断类型时丢失了仅类型导出（`QuotaSidebarCard` 等），
属于生成产物的固有属性（任何导入方同理）。把同一字节文件换成
`plugins/opencode-quota-zh/src/tui-v2.tsx` 复跑为 0 错误，证明本插件自身类型完备。
运行时不读 `src`：暂存发行包只含 quota-zh 的 `dist`（见 scripts/stage-runtime.mjs），
因此导入路径必须是 `dist`。

## 未验证项

- 真实安装后的 TUI 端到端人工验收（宿主就绪后按 SIDEBAR-PHASE2-INSTALL-ACCEPTANCE.md 执行）。
- 其他 OpenCode 版本；跨插件注册是版本限定、需升级复验的自有接合处，非官方承诺接口。
