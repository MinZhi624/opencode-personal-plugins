/**
 * 快捷入口页的纯字段定义：三类 × 两通道的标题、说明与预设。
 * 显隐语义以 presentation.ts 的 shortcutVisible 为准（缺省＝显示）。
 */
import type { SidebarShortcutCategory, SidebarShortcuts } from "../presentation.ts"

export type ShortcutCategoryKey = keyof SidebarShortcuts
export type ShortcutChannelKey = keyof SidebarShortcutCategory

export const SHORTCUT_CATEGORY_TITLES: Record<ShortcutCategoryKey, string> = {
  subagentDisplay: "子代理展示设置",
  subagentRecords: "子代理记录管理",
  hostDirect: "宿主直接操作",
}

export const SHORTCUT_CATEGORY_DESCRIPTIONS: Record<ShortcutCategoryKey, string> = {
  subagentDisplay: "排序、数量、保留期限",
  subagentRecords: "标记完成、清空记录",
  hostDirect: "/sidebar-host-* 系列",
}

export const SHORTCUT_CHANNEL_TITLES: Record<ShortcutChannelKey, string> = {
  slash: "斜杠入口",
  palette: "命令面板入口",
}

export const SHORTCUT_CHANNEL_KEYS: readonly ShortcutChannelKey[] = ["slash", "palette"]

/** 「仅主入口」预设：三类两通道全部关闭，只保留 /sidebar-cards 主入口。 */
export const ONLY_MAIN_ENTRY_PRESET: SidebarShortcuts = {
  subagentDisplay: { slash: false, palette: false },
  subagentRecords: { slash: false, palette: false },
  hostDirect: { slash: false, palette: false },
}
