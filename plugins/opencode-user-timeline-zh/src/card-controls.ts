/** 用户节点卡片的展示设置（统一窗口的「用户节点」页）。
 *
 *  归属：visibleRows / scroll 是本插件的 cli.json 插件选项，经宿主既有的
 *  plugin-options 安全写回 helper 定位唯一 CLI 插件条目：保留注释与其他选项、
 *  加锁、写入前后重读比对、环境变量覆盖时拒写。宿主不复制这份设置；
 *  折叠状态属于卡片自己的 storage，不在本页保存。
 */

import type { Context } from "@opencode/plugin/tui/context"
import { fileURLToPath } from "node:url"
import {
  registerCardControls,
  sameCardControlValues,
  type CardControlValues,
} from "../../opencode-sidebar-host-zh/src/card-controls.ts"
import { createPluginOptionsConfig } from "../../opencode-sidebar-host-zh/src/plugin-options.ts"
import {
  readTimelineOptions,
  TIMELINE_CARD_ID,
  TIMELINE_MAX_VISIBLE_ROWS,
  TIMELINE_MIN_VISIBLE_ROWS,
  writeScroll,
  writeVisibleRows,
  type TimelineOptions,
} from "./timeline-options.ts"

const PACKAGE_NAME = "opencode-user-timeline-zh"

const ROW_CHOICES = [6, 8, 10, 12, 15].map((value) => ({ value, title: `${value} 行` }))
const SCROLL_CHOICES = [
  { value: true, title: "滚轮浏览" },
  { value: false, title: "只显示最新" },
] as const

function controlValues(options: TimelineOptions): CardControlValues {
  return { visibleRows: options.visibleRows, scroll: options.scroll }
}

export function registerTimelineCardControls(
  context: Context,
  onSaved: (options: TimelineOptions) => void,
): () => void {
  // 只读使用宿主写回 helper：它负责唯一条目定位、注释与其他选项保留、锁与冲突检测。
  const config = createPluginOptionsConfig(PACKAGE_NAME, fileURLToPath(new URL("../", import.meta.url)))
  return registerCardControls({
    id: TIMELINE_CARD_ID,
    title: "用户节点",
    fields: [
      {
        key: "visibleRows",
        title: "显示行数",
        choices: ROW_CHOICES,
        min: TIMELINE_MIN_VISIBLE_ROWS,
        max: TIMELINE_MAX_VISIBLE_ROWS,
        integer: true,
        description: "滚动模式下固定显示的行数",
      },
      {
        key: "scroll",
        title: "浏览方式",
        choices: SCROLL_CHOICES,
        description: "滚轮浏览全部历史，或只显示最新若干条",
      },
    ],
    note: "显示行数与浏览方式保存在 cli.json；折叠状态在卡片标题行切换。",
    async read(): Promise<CardControlValues> {
      // 文件优先：读到的就是保存后的权威值；失败（条目缺失／重复／环境变量覆盖）直接抛出。
      const options = await config.read()
      return controlValues(readTimelineOptions(options))
    },
    async save(values: CardControlValues, baseline: CardControlValues): Promise<void> {
      const saved = await config.update((current) => {
        // baseline 在 owner 的写入操作里对比 normalize(current)，不只比旧内存：
        // 别的窗口改过 cli.json 就拒绝，不静默覆盖。
        if (!sameCardControlValues(controlValues(readTimelineOptions(current)), baseline)) {
          throw new Error("cli.json 的用户节点展示选项已被其他窗口修改，请重新读取后再保存")
        }
        // 只写用户实际改动的字段：未改动的既有值（含隐式默认）原样保留。
        const patch: Record<string, number | boolean> = {}
        if (values.visibleRows !== baseline.visibleRows) {
          patch.visibleRows = writeVisibleRows(values.visibleRows)
        }
        if (values.scroll !== baseline.scroll) {
          patch.scroll = writeScroll(values.scroll)
        }
        return patch
      })
      // 以实际写回的结果更新本窗口，不凭内存里的草稿宣称生效。
      onSaved(readTimelineOptions(saved))
    },
  })
}
