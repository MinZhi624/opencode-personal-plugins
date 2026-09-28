/** @jsxImportSource @opentui/solid */

import "@opentui/solid/preload"
import type { Context } from "@opencode/plugin/tui/context"
import {
  moveSidebarCard,
  resolveSidebarCardSettings,
  setSidebarCardVisible,
  SIDEBAR_CARD_LABELS,
  SIDEBAR_CARD_SETTINGS_KEY,
  uninitializedSidebarCardSettings,
  type SidebarCardID,
  type SidebarCardSettings,
} from "./sidebar-cards.ts"

type CardAction = "show" | "hide" | "up" | "down" | "done"

/**
 * 命令面板入口：打开选择对话框，对四张新增卡片逐张显示／隐藏、上移／下移。
 *
 * - 第一个对话框列出完整序列里的全部卡片（含已隐藏者）及其显隐状态；
 * - 第二个对话框对选中的卡片执行显示／隐藏／上移／下移，操作后回到卡片列表，
 *   选“完成”或取消即退出；
 * - 设置写入 context.storage.store：重启后恢复，并按宿主能力在多个 TUI 间同步，
 *   不共享 TUI 内存运行时；
 * - 上移／下移以完整保存的序列为准，隐藏卡片也参与；边界操作只提示、不改顺序。
 */
export function registerSidebarCardCommands(context: Context) {
  const disposeSlot = context.ui.slot({
    append: "app",
    render: () => {
      context.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: "sidebar-zh.cards",
            title: "侧栏：管理新增卡片",
            description: "显示／隐藏、上移／下移额度、会话概览、子代理、技能卡片",
            group: "侧栏",
            palette: true,
            slash: { name: "sidebar-cards" },
            run: async () => {
              const [stored, updateSettings] = context.storage.store<SidebarCardSettings>(
                SIDEBAR_CARD_SETTINGS_KEY,
                { initial: uninitializedSidebarCardSettings() },
              )
              // 每次循环都重新读存档：刚写下的设置立即体现在下一个对话框里
              const current = () => resolveSidebarCardSettings(stored, context.options)
              for (;;) {
                const settings = current()
                const picked = await context.ui.dialog.select<SidebarCardID>({
                  title: "侧栏卡片",
                  placeholder: "选择要操作的卡片",
                  options: settings.order.map((id, index) => ({
                    title: `${index + 1}. ${SIDEBAR_CARD_LABELS[id]}`,
                    value: id,
                    description: settings.hidden.includes(id) ? "已隐藏" : "显示中",
                  })),
                })
                if (picked === undefined) return
                const shown = !settings.hidden.includes(picked)
                const action = await context.ui.dialog.select<CardAction>({
                  title: `${SIDEBAR_CARD_LABELS[picked]}（${shown ? "显示中" : "已隐藏"}）`,
                  options: [
                    shown
                      ? { title: "隐藏这张卡片", value: "hide", description: "不显示，但仍留在顺序里" }
                      : { title: "显示这张卡片", value: "show", description: "按顺序里的位置恢复显示" },
                    { title: "上移", value: "up", description: "和上一张交换位置" },
                    { title: "下移", value: "down", description: "和下一张交换位置" },
                    { title: "完成", value: "done" },
                  ],
                })
                if (action === undefined || action === "done") return
                const before = current()
                const next =
                  action === "show" || action === "hide"
                    ? setSidebarCardVisible(before, picked, action === "show")
                    : moveSidebarCard(before, picked, action)
                if (next === before) {
                  // 边界操作不改变顺序
                  context.ui.toast.show({
                    title: "侧栏卡片",
                    message: action === "up" ? "已经是第一张了" : "已经是最后一张了",
                    variant: "info",
                  })
                  continue
                }
                await updateSettings((draft) => {
                  draft.version = 1
                  draft.order = next.order
                  draft.hidden = next.hidden
                })
                context.ui.toast.show({
                  title: "侧栏卡片",
                  message:
                    action === "hide"
                      ? `已隐藏${SIDEBAR_CARD_LABELS[picked]}`
                      : action === "show"
                        ? `已显示${SIDEBAR_CARD_LABELS[picked]}`
                        : `已${action === "up" ? "上移" : "下移"}${SIDEBAR_CARD_LABELS[picked]}`,
                  variant: "success",
                })
              }
            },
          },
        ],
      }))
      return null
    },
  })
  return () => {
    disposeSlot()
  }
}
