/** @jsxImportSource @opentui/solid */

import "@opentui/solid/preload"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal, For, onCleanup, Show } from "solid-js"
import { sanitizeDisplayText } from "./lib/display-sanitize.js"
import {
  buildQuotaDialogCommandOutput,
  QUOTA_DIALOG_COMMANDS,
  type QuotaDialogCommandId,
} from "./lib/quota-dialog-commands.js"
import type { QuotaSidebarCard, QuotaSidebarRow } from "./lib/quota-sidebar-cards.js"
import type { QuotaSessionModelContext } from "./lib/quota-runtime-context.js"
import { quotaRpc } from "./quota-rpc.js"

type QuotaView = { cards: QuotaSidebarCard[] }

const BAR_CELLS = 20

function sessionModel(context: Context, sessionID: string): QuotaSessionModelContext {
  const model = context.data.session.get(sessionID)?.model
  return model ? { modelID: model.id, providerID: model.providerID } : {}
}

// Quota data always comes from the V2 server RPC; a failed query surfaces as
// the panel error state instead of falling back to a local V1-style path.
async function loadQuota(context: Context, sessionID: string): Promise<QuotaView> {
  return await context.client.rpc(quotaRpc).snapshot({ sessionID })
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function percentColor(context: Context, percent: number): string {
  const feedback = context.theme.text.feedback
  if (percent >= 50) return feedback.success?.base ?? "#00C853"
  if (percent >= 25) return feedback.warning?.base ?? "#F9A825"
  return feedback.error?.base ?? "#D32F2F"
}

function QuotaBar(props: { context: Context; percent: number }) {
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round(props.percent / 5)))
  return (
    <box flexDirection="row">
      <text fg={percentColor(props.context, props.percent)}>{"█".repeat(filled)}</text>
      <text fg={props.context.theme.text.muted}>{"░".repeat(BAR_CELLS - filled)}</text>
    </box>
  )
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)

  if (days > 0) return `${days}天${hours}小时`
  if (hours > 0) return `${hours}小时${minutes}分钟`
  if (minutes > 0) return `${minutes}分钟`
  return `${totalSeconds % 60}秒`
}

function formatReset(resetTimeIso?: string): string {
  if (!resetTimeIso) return ""
  const reset = new Date(resetTimeIso)
  if (Number.isNaN(reset.getTime())) return ""
  const diff = reset.getTime() - Date.now()
  if (diff <= 0) return "已重置"

  const absolute = reset.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
  return `剩余 ${formatDuration(diff)}（${absolute}）`
}

function QuotaRow(props: { context: Context; row: QuotaSidebarRow }) {
  const theme = () => props.context.theme
  if (props.row.kind === "percent") {
    const percent = clampPercent(props.row.percentRemaining)
    const used = 100 - percent
    return (
      <box flexDirection="column">
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme().text.base}>{props.row.label}</text>
          <text fg={theme().text.muted}>{formatReset(props.row.resetTimeIso)}</text>
        </box>
        <QuotaBar context={props.context} percent={percent} />
        <box flexDirection="row" justifyContent="flex-end">
          <text fg={theme().text.muted}>
            {props.row.right ? `${props.row.right} · ` : ""}
            {used}% 已用 /{" "}
          </text>
          <text fg={percentColor(props.context, percent)}>{percent}% 剩余</text>
        </box>
      </box>
    )
  }
  return (
    <box flexDirection="row" justifyContent="space-between">
      <text fg={theme().text.muted}>{props.row.label}</text>
      <text fg={theme().text.base}>{props.row.value || props.row.right || "—"}</text>
    </box>
  )
}

function QuotaCard(props: { context: Context; card: QuotaSidebarCard }) {
  const theme = () => props.context.theme
  return (
    <box flexDirection="column">
      <text fg={theme().text.base}>
        <b>{props.card.label}</b>
      </text>
      <Show when={props.card.error}>
        <text fg={theme().text.feedback.error.base}>错误：{props.card.error}</text>
      </Show>
      <For each={props.card.rows}>{(row) => <QuotaRow context={props.context} row={row} />}</For>
    </box>
  )
}

function QuotaOverview(props: { context: Context; cards: QuotaSidebarCard[] }) {
  const theme = () => props.context.theme
  return (
    <box flexDirection="column">
      <text fg={theme().text.muted}>概述</text>
      <For each={props.cards}>
        {(card) => {
          const percents = card.rows
            .filter((row): row is Extract<QuotaSidebarRow, { kind: "percent" }> => row.kind === "percent")
            .map((row) => `${clampPercent(row.percentRemaining)}%`)
          const values = card.rows
            .filter((row) => row.kind === "value")
            .map((row) => (row.kind === "value" ? row.value : ""))
            .filter(Boolean)
          const summary =
            percents.length > 0
              ? `${percents.join(" / ")} 剩余`
              : values.length > 0
                ? values.join(" · ")
                : "—"
          return (
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().text.muted}>{card.label}</text>
              <text fg={theme().text.base}>{card.error ? "错误" : summary}</text>
            </box>
          )
        }}
      </For>
    </box>
  )
}

export function QuotaPanel(props: { context: Context; sessionID: string }) {
  const [settings, updateSettings] = props.context.storage.store("quota-zh-view-v2", {
    initial: { version: 2, open: true },
  })
  const [state, setState] = createSignal<"loading" | "ready" | "error">("loading")
  const [cards, setCards] = createSignal<QuotaSidebarCard[]>([])
  let disposed = false
  let running = false
  let queued = false

  const refresh = () => {
    if (disposed) return
    if (running) {
      queued = true
      return
    }
    running = true
    void loadQuota(props.context, props.sessionID)
      .then((result) => {
        if (disposed) return
        setCards(result.cards)
        setState("ready")
      })
      .catch(() => !disposed && setState("error"))
      .finally(() => {
        running = false
        if (queued) {
          queued = false
          refresh()
        }
      })
  }

  refresh()
  const timers = [150, 600, 1500].map((delay) => setTimeout(refresh, delay))
  const interval = setInterval(refresh, 60_000)
  const unsubs = [
    props.context.data.on("session.step.ended", (event) => {
      if (event.data.sessionID === props.sessionID) refresh()
    }),
    props.context.data.on("session.execution.failed", (event) => {
      if (event.data.sessionID === props.sessionID) refresh()
    }),
  ]
  onCleanup(() => {
    disposed = true
    timers.forEach(clearTimeout)
    clearInterval(interval)
    unsubs.forEach((unsubscribe) => unsubscribe())
  })

  const theme = () => props.context.theme
  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1} onMouseDown={() => void updateSettings((draft) => { draft.open = !draft.open })}>
        <text fg={theme().text.action.primary.base}>{settings.open ? "▼" : "▶"}</text>
        <text fg={theme().text.action.primary.base}><b>额度</b></text>
        <Show when={!settings.open && cards().length > 0}>
          <text fg={theme().text.muted}>（{cards().length} 个提供商）</text>
        </Show>
      </box>
      <Show when={!settings.open}>
        <Show when={state() === "loading"}>
          <text fg={theme().text.muted}>加载中…</text>
        </Show>
        <Show when={state() === "error"}>
          <text fg={theme().text.feedback.error.base}>额度查询失败</text>
        </Show>
        <Show when={state() === "ready" && cards().length === 0}>
          <text fg={theme().text.muted}>暂无额度数据</text>
        </Show>
        <Show when={state() === "ready" && cards().length > 0}>
          <QuotaOverview context={props.context} cards={cards()} />
        </Show>
      </Show>
      <Show when={settings.open}>
        <Show when={state() === "loading"}>
          <text fg={theme().text.muted}>加载中…</text>
        </Show>
        <Show when={state() === "error"}>
          <text fg={theme().text.feedback.error.base}>额度查询失败</text>
        </Show>
        <Show when={state() === "ready" && cards().length === 0}>
          <text fg={theme().text.muted}>暂无额度数据</text>
        </Show>
        <Show when={state() === "ready" && cards().length > 0}>
          <box flexDirection="column" gap={1}>
            <For each={cards()}>{(card) => <QuotaCard context={props.context} card={card} />}</For>
          </box>
        </Show>
      </Show>
    </box>
  )
}

function commandArguments(input: unknown): string | undefined {
  if (typeof input === "string") return input.trim() || undefined
  if (!input || typeof input !== "object") return
  const value = (input as Record<string, unknown>).arguments
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

async function runCommand(
  context: Context,
  command: QuotaDialogCommandId,
  sessionID: string | undefined,
  input?: unknown,
) {
  const spec = QUOTA_DIALOG_COMMANDS.find((item) => item.id === command)!
  let args = commandArguments(input)
  if (spec.acceptsArguments && args === undefined) {
    const answer = await context.ui.dialog.prompt({ title: spec.title, placeholder: "可选参数" })
    if (answer === undefined) return
    args = answer.trim() || undefined
  }
  try {
    const result = await buildQuotaDialogCommandOutput({
      command,
      arguments: args,
      client: context.client as never,
      roots: { fallbackDirectory: context.location?.directory ?? process.cwd() },
      sessionID,
      resolveSessionMeta: (id) => Promise.resolve(sessionModel(context, id)),
    })
    if (result.state === "noop") return
    const alert = context.ui.dialog.alert({ title: result.title, message: result.output })
    context.ui.dialog.set({ size: result.dialogSize })
    await alert
  } catch (error) {
    context.ui.toast.show({
      title: "额度",
      variant: "error",
      message: sanitizeDisplayText(error instanceof Error ? error.message : String(error)),
    })
  }
}

export default Plugin.define({
  id: "opencode-quota-zh",
  setup(context) {
    let activeSessionID: string | undefined
    const disposeCommands = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: QUOTA_DIALOG_COMMANDS.map((spec) => ({
            id: `quota-zh.${spec.id}`,
            title: spec.title,
            group: "额度",
            palette: true,
            slash: { name: spec.slashName, ...(spec.acceptsArguments ? { arguments: true as const } : {}) },
            run: (input?: unknown) => void runCommand(context, spec.id, activeSessionID, input),
          })),
        }))
        return null
      },
    })
    return () => {
      disposeCommands()
    }
  },
})
