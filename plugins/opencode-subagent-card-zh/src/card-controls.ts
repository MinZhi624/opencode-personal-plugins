/** 子代理卡片的展示设置注册（统一窗口的「子代理管理」页）。
 *
 *  归属：排序、条数与保留期限沿用现有 subagent-magazine-settings-v2 存档
 *  （命令面板与卡片渲染读写的是同一份），经 context.storage.store 保存；
 *  宿主不复制这份设置，隐藏卡片时同样可设置。
 *  「标记运行记录为完成」「清空当前会话记录」是业务操作：即时执行、保留既有
 *  确认规则，不经展示草稿保存；标记完成绝不取消实际任务。
 */
import type { Context } from "@opencode/plugin/tui/context"
import {
  registerCardControls,
  sameCardControlValues,
  type CardControlValues,
} from "../../opencode-sidebar-host-zh/src/card-controls.ts"
import {
  clampMaxEntries,
  clampTtlDays,
  clearSubagentSessionRecords,
  markSubagentRunningDone,
  normalizeSortOrder,
  resolveSubagentSettings,
  SUBAGENT_CARD_ID,
  SUBAGENT_SETTINGS_KEY,
  SUBAGENT_TTL_OPTIONS,
  type SubagentPluginOptions,
  type SubagentSettings,
  type SubagentSortOrder,
} from "../../opencode-enhanced-sidebar-zh/src/tui-v2-subagent-magazine.tsx"

const SORT_CHOICES = [
  { value: "desc", title: "新的在上" },
  { value: "asc", title: "旧的在上" },
] as const

const MAX_ENTRIES_CHOICES = [3, 5, 10, 20, 30, 50].map((value) => ({ value, title: `${value} 条` }))

const TTL_CHOICES = SUBAGENT_TTL_OPTIONS.map((value) => ({
  value: value as number,
  title: value === 0 ? "不限" : `${value} 天`,
}))

/** 当前生效值：存档 > cli.json 插件选项 > 默认，和卡片渲染读的是同一套规则。 */
function effectiveValues(context: Context, stored: SubagentSettings | undefined) {
  const effective = resolveSubagentSettings(stored, context.options as SubagentPluginOptions | undefined)
  return { sortOrder: effective.sortOrder, maxEntries: effective.maxEntries, ttlDays: effective.ttlDays }
}

function sortOrderValue(value: unknown): SubagentSortOrder {
  return normalizeSortOrder(value)
}

/** 动作用的当前会话：会话路由优先，插件窗口聚焦时回退到活动标签页。 */
function activeSessionID(context: Context): string | undefined {
  const route = context.ui.router.current()
  if (route.type === "session") return route.sessionID
  return context.ui.tabs.list().find((tab) => tab.active)?.sessionID
}

export function registerSubagentCardControls(context: Context): () => void {
  const store = () => context.storage.store(SUBAGENT_SETTINGS_KEY, { initial: { version: 2 } as SubagentSettings })
  return registerCardControls({
    id: SUBAGENT_CARD_ID,
    title: "子代理管理",
    fields: [
      { key: "sortOrder", title: "排序方式", choices: SORT_CHOICES, description: "列表内条目顺序；与 /subagent-sort 同一份设置。" },
      { key: "maxEntries", title: "显示条数", choices: MAX_ENTRIES_CHOICES, min: 1, max: 50, integer: true, description: "列表最多显示几条；与 /subagent-max 同一份设置。" },
      { key: "ttlDays", title: "保留期限", choices: TTL_CHOICES, description: "只清理已结束记录，运行中的永远保留；与 /subagent-ttl 同一份设置。" },
    ],
    note: "展示设置改动按页草稿保存；下面的操作即时执行。标记完成只把记录标为完成，绝不取消实际任务。",
    actions: [
      {
        title: "标记运行记录为完成（不取消实际任务）",
        run: () => markSubagentRunningDone(context, activeSessionID(context)),
      },
      {
        title: "清空当前会话记录",
        run: () => clearSubagentSessionRecords(context, activeSessionID(context)),
      },
    ],
    read(): CardControlValues {
      const [settings] = store()
      const effective = effectiveValues(context, settings as SubagentSettings)
      return { sortOrder: effective.sortOrder, maxEntries: effective.maxEntries, ttlDays: effective.ttlDays }
    },
    async save(values: CardControlValues, baseline: CardControlValues): Promise<void> {
      const [, update] = store()
      await update((draft) => {
        // baseline 对比：存档或插件选项已被别处改过就拒绝，不静默覆盖。
        if (!sameCardControlValues(effectiveValues(context, draft), baseline)) {
          throw new Error("子代理管理设置已被其他窗口修改，请重新读取后再保存")
        }
        // 只写展示字段；version 与记录本体原样保留。
        draft.sortOrder = sortOrderValue(values.sortOrder)
        draft.maxEntries = clampMaxEntries(values.maxEntries)
        draft.ttlDays = clampTtlDays(values.ttlDays)
      })
    },
  })
}
