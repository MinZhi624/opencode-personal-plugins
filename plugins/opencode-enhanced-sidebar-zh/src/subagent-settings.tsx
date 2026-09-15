/** @jsxImportSource @opentui/solid */

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { JSX } from "@opentui/solid"
import {
  clearSubAgentSession,
  KV_PREFIX,
  type ScrollMode,
  type SharedSignals,
  type SortOrder,
} from "./subagent-magazine.tsx"

type SettingId = "order" | "max" | "scroll" | "ttl" | "clear"

function replaceDialog(api: TuiPluginApi, render: () => JSX.Element) {
  api.ui.dialog.replace(render)
  api.ui.dialog.setSize("medium")
}

function toast(api: TuiPluginApi, message: string) {
  api.ui.toast({ message })
}

function openSubAgentSettings(
  api: TuiPluginApi,
  signals: SharedSignals,
  getSessionId: () => string,
) {
  const ttlLabel = () => signals.ttlDays() === 0 ? "无期限" : `${signals.ttlDays()} 天`
  replaceDialog(api, () => (
    <api.ui.DialogSelect
      title="子代理设置"
      options={[
        {
          title: "排序方式",
          description: signals.sortOrder() === "desc" ? "最新在前" : "最早在前",
          value: "order" as SettingId,
        },
        {
          title: "显示数量",
          description: `最多显示 ${signals.maxEntries()} 条`,
          value: "max" as SettingId,
        },
        {
          title: "滚动方式",
          description: signals.scrollMode() === "wheel" ? "滚轮翻页" : "点击翻页",
          value: "scroll" as SettingId,
        },
        {
          title: "数据保留期限",
          description: ttlLabel(),
          value: "ttl" as SettingId,
        },
        {
          title: "清除当前会话记录",
          description: "清除面板记录，不会终止正在运行的任务",
          value: "clear" as SettingId,
        },
      ]}
      onSelect={(option) => {
        switch (option.value as SettingId) {
          case "order":
            replaceDialog(api, () => (
              <api.ui.DialogSelect
                title="子代理排序方式"
                options={[
                  { title: "最新在前", value: "desc" as SortOrder },
                  { title: "最早在前", value: "asc" as SortOrder },
                ]}
                onSelect={(selected) => {
                  const value = selected.value as SortOrder
                  signals.setSortOrder(value)
                  api.kv.set(`${KV_PREFIX}.order`, value)
                  toast(api, value === "desc" ? "子代理已按最新在前排序" : "子代理已按最早在前排序")
                  api.ui.dialog.clear()
                }}
                onCancel={() => openSubAgentSettings(api, signals, getSessionId)}
              />
            ))
            break
          case "max":
            replaceDialog(api, () => (
              <api.ui.DialogPrompt
                title="子代理显示数量"
                value={String(signals.maxEntries())}
                placeholder="1–50"
                description={() => <text>输入侧边栏最多显示的子代理条目数（1–50）</text>}
                onConfirm={(raw) => {
                  const value = Math.max(1, Math.min(50, parseInt(raw, 10) || 10))
                  signals.setMaxEntries(value)
                  api.kv.set(`${KV_PREFIX}.max_entries`, value)
                  toast(api, `子代理最多显示 ${value} 条`)
                  api.ui.dialog.clear()
                }}
                onCancel={() => openSubAgentSettings(api, signals, getSessionId)}
              />
            ))
            break
          case "scroll":
            replaceDialog(api, () => (
              <api.ui.DialogSelect
                title="子代理滚动方式"
                options={[
                  { title: "滚轮翻页", value: "wheel" as ScrollMode },
                  { title: "点击翻页", value: "click" as ScrollMode },
                ]}
                onSelect={(selected) => {
                  const value = selected.value as ScrollMode
                  signals.setScrollMode(value)
                  api.kv.set(`${KV_PREFIX}.scroll_mode`, value)
                  toast(api, value === "wheel" ? "已启用滚轮翻页" : "已启用点击翻页")
                  api.ui.dialog.clear()
                }}
                onCancel={() => openSubAgentSettings(api, signals, getSessionId)}
              />
            ))
            break
          case "ttl":
            replaceDialog(api, () => (
              <api.ui.DialogSelect
                title="子代理数据保留期限"
                options={[
                  { title: "3 天", value: "3" },
                  { title: "7 天", value: "7" },
                  { title: "14 天", value: "14" },
                  { title: "30 天", value: "30" },
                  { title: "无期限", value: "0" },
                ]}
                onSelect={(selected) => {
                  const value = parseInt(selected.value, 10)
                  signals.setTtlDays(value)
                  api.kv.set(`${KV_PREFIX}.ttl_days`, String(value))
                  toast(api, value === 0 ? "子代理记录将无限期保留" : `子代理记录保留期限已设为 ${value} 天`)
                  api.ui.dialog.clear()
                }}
                onCancel={() => openSubAgentSettings(api, signals, getSessionId)}
              />
            ))
            break
          case "clear":
            replaceDialog(api, () => (
              <api.ui.DialogConfirm
                title="清除子代理记录"
                message="确定清除当前会话的全部子代理面板记录？此操作不会终止实际任务。"
                onConfirm={() => {
                  const count = clearSubAgentSession(api, getSessionId())
                  toast(api, count > 0 ? `已清除 ${count} 条子代理记录` : "当前会话没有子代理记录")
                  api.ui.dialog.clear()
                }}
                onCancel={() => openSubAgentSettings(api, signals, getSessionId)}
              />
            ))
            break
        }
      }}
      onCancel={() => api.ui.dialog.clear()}
    />
  ))
}

export function registerSubAgentSettings(
  api: TuiPluginApi,
  signals: SharedSignals,
  getSessionId: () => string,
) {
  const dispose = api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: "subagent.settings",
        title: "子代理设置",
        desc: "调整排序、显示数量、滚动方式、数据保留期限和清理记录。",
        category: "设置",
        run() {
          openSubAgentSettings(api, signals, getSessionId)
        },
      },
    ],
    bindings: [],
  })
  api.lifecycle.onDispose(dispose)
}
