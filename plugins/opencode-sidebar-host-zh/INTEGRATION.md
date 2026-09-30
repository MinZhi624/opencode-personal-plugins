# 下游侧栏卡片对接指南

## 范围与实现状态（2026-09-30）

已决定不建设通用自动适配器：不承诺把任意第三方插件路径填入配置就能接管其侧栏。原作者、本仓库维护者或第三方适配器维护者均可完成一次接入，**不要求最终用户自己写适配代码**。

| 能力 | 当前状态 |
| --- | --- |
| 卡片通过 `registerSidebarCard` 向宿主注册 | 已实现 |
| `cli.json` 的插件对象条目将 `options` 传给该插件 | OpenCode V2 官方能力；各参数须由对应插件实现 |
| 宿主从 `options.sidebarCards` 读取排序／隐藏 | 已实现，运行验收待使用者完成 |
| `/sidebar-cards` 安全写回 `cli.json` | 已实现，不再写旧排序 storage；运行验收待使用者完成 |
| 任意插件自动转换、旧 API 通用兼容层 | 不在本次范围 |

宿主跨插件 JSX 接合处是本仓库自有协议（seam v1），目前仅标称在 OpenCode 2.0.18 验证，不是官方跨插件 UI API。升级 OpenCode、Solid/OpenTUI 或变更打包方式均须复验。

## 责任划分

- **宿主**：承载已注册卡片，按稳定卡片 ID 排序／隐藏，提供管理菜单及逐卡渲染错误隔离；不导入具体业务插件。
- **卡片／适配器**：初始化业务、获取数据、提供 Solid/OpenTUI 展示、注册并清理卡片；读取自己的 `context.options`。
- **原插件**：提供可复用展示接口，或者由适配器维护者完成针对性接入／迁移。
- **用户**：安装可兼容的包，配置插件加载及各自参数，不负责写适配器。

可走两条路径：`宿主 ← 已适配原插件`，或 `宿主 ← 专用适配器 ← 原插件`。后者必须避免原插件和适配器同时输出同一面板；只停用原侧栏出口，不应误停所需后台功能。若原插件无法独立关闭出口或提供可复用入口，应维护适配版本，不宣称只改配置即可。

## 最小接入示例（现有接口）

下面示例是下游插件的 TUI 入口；使用插件自身的 `context`，宿主只传入 `sessionID`。

```tsx
/** @jsxImportSource @opentui/solid */
import "@opentui/solid/preload"
import { Plugin } from "@opencode/plugin/tui"
import { registerSidebarCard } from "opencode-sidebar-host-zh/card"

export default Plugin.define({
  id: "vendor-example-plugin",
  setup(context) {
    const compact = context.options.compact === true
    const registration = registerSidebarCard({
      id: "vendor.example",
      owner: "vendor-example-plugin",
      title: "示例卡片",
      requiredSeam: 1,
      render: ({ sessionID }) => (
        <text>{compact ? "示例" : `示例会话：${sessionID}`}</text>
      ),
    })
    return () => registration.dispose()
  },
})
```

示例中的包名导入要求安装环境已能解析宿主包。本仓库宿主目前是 `private: true` 的本地包，**不能把示例理解成它已经发布到 npm**。本仓库同级插件的 `src/tui.tsx` 可参照额度卡，使用 `../../opencode-sidebar-host-zh/src/register-card.ts`；其他目录须按实际位置调整，不使用开发者机器的绝对路径。

下游包需通过 `package.json` 的 `exports["./tui"]` 暴露 TUI 入口，并满足 OpenTUI/Solid 的运行时兼容要求；本宿主当前声明的 peers 是 `@opentui/core >=0.5.8`、`@opentui/solid >=0.5.8`、`solid-js >=1.9.0`。保持与 CLI 的运行时共享方式兼容，不将相互隔离的 Solid 运行时打进卡片。包依赖安装与 CLI 插件启用是两件事：安装了宿主依赖不代表宿主已启用，本地源码也不能假定已完成构建和依赖安装。

真实复用范例：`../opencode-quota-card-zh/src/tui.tsx` 注册卡片，`../opencode-quota-card-zh/src/quota-card.tsx` 复用已有 `QuotaPanel`。

### 注册契约

| 字段 | 约定 |
| --- | --- |
| `id` | 非空、跨重启和升级稳定的卡片 ID；新下游使用命名空间，例如 `vendor.example`；不是目录名 |
| `owner` | 非空，通常为插件 ID；用于注册所有权及清理 |
| `title` | 非空的人类可读名称；改名不应改变 `id` |
| `requiredSeam` | 所需协议版本；当前为 `1`，省略时使用注册助手的版本 |
| `render` | 接收 `{ sessionID: string }`，返回卡片展示；闭包捕获卡片自己的 context／状态 |
| `dispose` | 可选，注册撤销时的卡片侧清理；设计为幂等 |
| `onStatus` | 可选，接收注册助手报告的排队／已注册／被拒绝状态；排障结合宿主诊断 |

调用返回的 `registration.dispose()` 应放入插件 cleanup，清除注册和待接单请求。插件自身 setup 创建的订阅／定时器也须在 cleanup 清理；组件内资源用 Solid `onCleanup` 清理。

- 宿主缺席时排队，**不要回退自行绘制侧栏**；宿主后到可接管队列。
- 相同 ID、不同 owner，以及协议版本不兼容，会被拒绝；不得偷偷换随机 ID 绕过冲突。
- `hidden` 是隐藏展示，不是停用整个插件；组件可能被卸载，不能把必须持续运行的后台任务只放在组件挂载期间。
- 不把宿主配置传给业务插件，不让卡片读写其他插件配置或凭据。

## `cli.json` 参数化

文件位于 `~/.config/opencode/cli.json`，设置 `XDG_CONFIG_HOME` 时位于 `$XDG_CONFIG_HOME/opencode/cli.json`；不是项目内配置，也不是旧 `tui.json`。以下是相关条目的示意，实际编辑时合并到现有 `plugins`，保留其他插件。

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "./opencode-zh-bundle/plugins/opencode-sidebar-host-zh",
      "options": {
        "sidebarCards": {
          "order": ["sessionOverview", "quota", "vendor.example", "skill"],
          "hidden": ["skill"]
        }
      }
    },
    {
      "package": "./plugins/vendor-example",
      "options": {
        "compact": true
      }
    }
  ]
}
```

`./plugins/vendor-example` 是示意安装路径，须替换为实际可加载的包；本示例不包含所有内置卡片加载条目。只有安装并启用注册该 ID 的卡片，宿主才有内容可显示。

配置语义：

1. 宿主的 `options.sidebarCards.order/hidden` 控制卡片之间的顺序和显隐；下游自己的 `options` 控制卡片内部行为，参数名由下游定义并校验。不存在可控制所有插件的通用业务参数。
2. `order` 使用卡片 ID；未列出的已注册卡片按注册顺序追加。未知／暂未安装的 ID 保留，但不会因此自动安装或加载插件。
3. `hidden` 隐藏卡片而不禁用插件；卸载后保留其配置，重新加载可恢复。`session.sidebar: "hide"` 则是 OpenCode 的整栏开关。
4. `plugins` 加载顺序不等于宿主内卡片顺序；此配置不重排 OpenCode 原生侧栏或其他插件独立输出的内容。
5. 文件为权威；菜单写回同一位置，不以旧 storage 覆盖文件。安全写入不可用时只读降级，给出手动修改提示；不静默改写其他插件配置。
6. 官方支持有效配置编辑重载，但插件 options 的实际重载效果须在安装版验证；未同步时重启 TUI，或打开 `/sidebar-cards` 重新读取。本窗口确认菜单保存后立即应用。环境变量 `OPENCODE_CLI_CONFIG_CONTENT` 的覆盖优先级更高，设置时菜单保守拒写磁盘。

## 下游验收清单

- 单独启用下游而未启用宿主：无重复侧栏，排队可诊断；宿主后到后能显示。
- 宿主先到和后到均可；禁用下游后没有残留卡片、订阅、定时器或待接单请求。
- 同一面板只显示一份；保留原插件所需的命令和后台功能。
- 切换会话、折叠／展开、隐藏／恢复、宿主重载后无串会话或重复监听。
- ID 冲突和协议不兼容有诊断；一个卡片抛错不阻断其他卡片。
- 卡片业务参数从自己的 `context.options` 读取，错误值有默认值或清晰诊断。
- 手改顺序／隐藏、菜单写回及重启结果一致；卸载再装偏好保留；写入失败不谎报成功。以上运行验收本次未执行。

## `opencode-subagent-magazine` 的边界

2026-09-30 检查本地源码（包版本 `1.5.3`）：`src/index.tsx` 通过旧 `api.slots.register` 提交 `sidebar_content`，但同时依赖旧存储、会话数据、事件、命令、弹窗和导航接口。截获侧栏注册仅能解决展示交接，不能证明整个插件已兼容 V2。它需要专用适配／V2 迁移及功能验收；本次不实现其适配器，不把它写入自动兼容名单。

## 参考

- [OpenCode V2 CLI 配置](https://opencode.ai/v2/docs/cli/config)
- [CLI 插件加载](https://opencode.ai/v2/docs/cli/plugins)
- [CLI 插件接口](https://opencode.ai/v2/docs/build/plugins/cli)
- 本包 `src/register-card.ts` 与 `src/seam.ts`：现有注册契约的代码依据。
