/** 上下文卡片的展示设置注册（统一窗口的“上下文”页）。
 *
 *  归属：展开状态存档 session-overview-zh-v2 归本插件 context，宿主不复制这份设置；
 *  统一窗口只经本模块读写，隐藏卡片时同样可用（setup 注册、cleanup 撤销）。
 *  持久化沿用 context.storage.store：跨 TUI 实例实时同步，重启后保留。
 */
import type { Context } from "@opencode/plugin/tui/context"
import {
  registerCardControls,
  sameCardControlValues,
  type CardControlValues,
} from "../../opencode-sidebar-host-zh/src/card-controls.ts"
import {
  SESSION_OVERVIEW_CARD_ID,
  SESSION_OVERVIEW_SETTINGS_KEY,
} from "../../opencode-enhanced-sidebar-zh/src/tui-v2-session-overview.tsx"

const OPEN_CHOICES = [
  { value: true, title: "展开" },
  { value: false, title: "折叠" },
] as const

/** 当前存档的展开状态；与卡片渲染读的是同一份 store。 */
function readOpen(context: Context): boolean {
  const [settings] = context.storage.store(SESSION_OVERVIEW_SETTINGS_KEY, { initial: { version: 2, open: true } })
  return settings.open !== false
}

export function registerOverviewCardControls(context: Context): () => void {
  return registerCardControls({
    id: SESSION_OVERVIEW_CARD_ID,
    title: "上下文",
    fields: [{ key: "open", title: "卡片展开", choices: OPEN_CHOICES }],
    note: "展开状态保存在本插件的会话存储，重启后保留；进度条形状在“整体外观”里调整。",
    read(): CardControlValues {
      return { open: readOpen(context) }
    },
    async save(values: CardControlValues, baseline: CardControlValues): Promise<void> {
      const next = values.open === true
      const [, update] = context.storage.store(SESSION_OVERVIEW_SETTINGS_KEY, { initial: { version: 2, open: true } })
      await update((draft) => {
        // baseline 对比：存档已被其他窗口改过就拒绝，不静默覆盖别处修改。
        if (!sameCardControlValues({ open: draft.open !== false }, baseline)) {
          throw new Error("上下文的展开状态已被其他窗口修改，请重新读取后再保存")
        }
        draft.open = next
      })
    },
  })
}
