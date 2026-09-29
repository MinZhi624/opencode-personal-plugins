/** @jsxImportSource @opentui/solid */

import type { Context } from "@opencode/plugin/tui/context"
import { QuotaPanel } from "../../opencode-quota-zh/dist/tui-v2.tsx"

export interface QuotaCardProps {
  readonly context: Context
  readonly sessionID: string
}

/** 「额度」卡片内容：原样复用 opencode-quota-zh 已构建的 QuotaPanel。
 *
 * 责任区边界（第二阶段规格「quota 责任区」）：
 * - 展示与交互只在 TUI；额度查询、Provider 核算与凭据留在 opencode-quota-zh 服务端；
 * - 数据只经服务端 RPC（snapshot／settings）传递结构化非敏感结果，TUI 不取得
 *   access／refresh token；
 * - 既有 RPC 状态（ready／disabled）与展示状态（加载中／额度查询失败／额度后台未启用／
 *   暂无额度数据）由 QuotaPanel 原样保留，本插件不改口径、不注册命令、不复制渲染逻辑。
 *
 * 注意：QuotaPanel 组件内部自带「额度设置面板」keymap 命令（部分错误显示方式），
 * 这是既有面板自身交互，随卡片渲染创建、随卡片卸载消失，不属于本插件 setup 的命令注册。
 */
export function QuotaCard(props: QuotaCardProps) {
  return <QuotaPanel context={props.context} sessionID={props.sessionID} />
}
