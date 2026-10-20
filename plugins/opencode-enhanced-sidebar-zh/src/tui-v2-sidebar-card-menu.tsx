/** @jsxImportSource @opentui/solid */

import "@opentui/solid/preload"
import type { Context } from "@opencode/plugin/tui/context"

/**
 * 卡片排列／显隐的旧命令面板入口（原 slash "sidebar-cards"）已去注册：
 * 宿主统一展示控制窗口（/sidebar-cards，「卡片」页）是唯一主入口，
 * 排序／显隐／导入／重新读取都在那里完成，避免同名 slash 双注册。
 *
 * 保留本模块导出签名以兼容既有调用方（聚合入口 tui-v2.tsx）；现在是空注册。
 */
export function registerSidebarCardCommands(_context: Context): () => void {
  return () => {}
}
