/** 子代理卡片的展示设置注册（统一窗口的“子代理”页）。
 *
 *  归属：排序与条数沿用现有 subagent-magazine-settings-v2 存档（命令面板写的是同一份），
 *  经 context.storage.store 保存；宿主不复制这份设置，隐藏卡片时同样可设置。
 *  保留期限（ttlDays）、清理、取消和标记完成仍是业务操作，不在此注册、不被展示偏好改写。
 */
import type { Context } from "@opencode/plugin/tui/context"
import {
  registerCardControls,
  sameCardControlValues,
  type CardControlValues,
} from "../../opencode-sidebar-host-zh/src/card-controls.ts"
import {
  clampMaxEntries,
  normalizeSortOrder,
  resolveSubagentSettings,
  SUBAGENT_CARD_ID,
  SUBAGENT_SETTINGS_KEY,
  type SubagentPluginOptions,
  type SubagentSettings,
  type SubagentSortOrder,
} from "../../opencode-enhanced-sidebar-zh/src/tui-v2-subagent-magazine.tsx"

const SORT_CHOICES = [
  { value: "desc", title: "新的在上" },
  { value: "asc", title: "旧的在上" },
] as const

const MAX_ENTRIES_CHOICES = [3, 5, 10, 20, 30, 50].map((value) => ({ value, title: `${value} 条` }))

/** 当前生效值：存档 > cli.json 插件选项 > 默认，和卡片渲染读的是同一套规则。 */
function effectiveValues(context: Context, stored: SubagentSettings | undefined) {
  const effective = resolveSubagentSettings(stored, context.options as SubagentPluginOptions | undefined)
  return { sortOrder: effective.sortOrder, maxEntries: effective.maxEntries }
}

function sortOrderValue(value: unknown): SubagentSortOrder {
  return normalizeSortOrder(value)
}

export function registerSubagentCardControls(context: Context): () => void {
  const store = () => context.storage.store(SUBAGENT_SETTINGS_KEY, { initial: { version: 2 } as SubagentSettings })
  return registerCardControls({
    id: SUBAGENT_CARD_ID,
    title: "子代理",
    fields: [
      { key: "sortOrder", title: "排序方式", choices: SORT_CHOICES },
      { key: "maxEntries", title: "显示条数", choices: MAX_ENTRIES_CHOICES, min: 1, max: 50, integer: true },
    ],
    note: "排序与条数保存在子代理记录设置（跨窗口同步、重启保留）；保留期限、清理与取消仍是卡片和命令里的业务操作。",
    read(): CardControlValues {
      const [settings] = store()
      const effective = effectiveValues(context, settings as SubagentSettings)
      return { sortOrder: effective.sortOrder, maxEntries: effective.maxEntries }
    },
    async save(values: CardControlValues, baseline: CardControlValues): Promise<void> {
      const [, update] = store()
      await update((draft) => {
        // baseline 对比：存档或插件选项已被别处改过就拒绝，不静默覆盖。
        if (!sameCardControlValues(effectiveValues(context, draft), baseline)) {
          throw new Error("子代理的排序或条数已被其他窗口修改，请重新读取后再保存")
        }
        // 只写展示字段；ttlDays 与 version 原样保留。
        draft.sortOrder = sortOrderValue(values.sortOrder)
        draft.maxEntries = clampMaxEntries(values.maxEntries)
      })
    },
  })
}
