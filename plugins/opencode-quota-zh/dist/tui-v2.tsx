/** @jsxImportSource @opentui/solid */

import "@opentui/solid/preload"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal, onCleanup, Show } from "solid-js"
import { sanitizeDisplayText } from "./lib/display-sanitize.js"
import {
  buildQuotaDialogCommandOutput,
  QUOTA_DIALOG_COMMANDS,
  type QuotaDialogCommandId,
} from "./lib/quota-dialog-commands.js"
import { collectQuotaRenderData } from "./lib/quota-render-data.js"
import {
  createQuotaRuntimeRequestContext,
  resolveQuotaRuntimeContext,
  type QuotaSessionModelContext,
} from "./lib/quota-runtime-context.js"
import { buildSidebarQuotaPanelLines } from "./lib/tui-sidebar-format.js"
import { quotaRpc } from "./quota-rpc.js"

type QuotaView = { lines: string[]; providerCount: number }

function sessionModel(context: Context, sessionID: string): QuotaSessionModelContext {
  const model = context.data.session.get(sessionID)?.model
  return model ? { modelID: model.id, providerID: model.providerID } : {}
}

async function loadQuota(context: Context, sessionID: string): Promise<QuotaView | undefined> {
  try {
    return await context.client.rpc(quotaRpc).snapshot({})
  } catch {
    // Older/local-only setups can still use the legacy file-backed providers.
  }
  const runtime = await resolveQuotaRuntimeContext({
    client: context.client as never,
    roots: { fallbackDirectory: context.location?.directory ?? process.cwd() },
    sessionID,
    sessionMeta: sessionModel(context, sessionID),
    includeSessionMeta: (config) => config.onlyCurrentModel,
  })
  if (!runtime.config.enabled || !runtime.config.tuiSidebarPanel.enabled) return
  const result = await collectQuotaRenderData({
    client: runtime.client,
    resolveRuntimeProviderIds: runtime.resolveRuntimeProviderIds,
    config: runtime.config,
    configMeta: runtime.configMeta,
    request: createQuotaRuntimeRequestContext(runtime),
    surfaceExplicitProviderIssues: true,
    formatStyle: runtime.config.tuiSidebarPanel.formatStyle ?? runtime.config.formatStyle,
    providers: runtime.providers,
  })
  if (!result.data) return { lines: [], providerCount: result.active.length }
  return {
    lines: buildSidebarQuotaPanelLines({ data: result.data, config: runtime.config }),
    providerCount: result.active.length,
  }
}

export function QuotaPanel(props: { context: Context; sessionID: string }) {
  const [settings, updateSettings] = props.context.storage.store("quota-zh-view-v2", {
    initial: { version: 2, open: true },
  })
  const [state, setState] = createSignal<"loading" | "ready" | "error">("loading")
  const [quota, setQuota] = createSignal<QuotaView>({ lines: [], providerCount: 0 })
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
        setQuota(result ?? { lines: [], providerCount: 0 })
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

  const body = () => quota().lines
  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1} onMouseDown={() => void updateSettings((draft) => { draft.open = !draft.open })}>
        <text fg={props.context.theme.text.action.primary.base}>{settings.open ? "▼" : "▶"}</text>
        <text fg={props.context.theme.text.action.primary.base}><b>额度</b></text>
        <Show when={!settings.open && quota().providerCount > 0}>
          <text fg={props.context.theme.text.muted}>（{quota().providerCount} 个提供商）</text>
        </Show>
      </box>
      <Show when={settings.open}>
        <Show when={state() === "loading"}>
          <text fg={props.context.theme.text.muted}>加载中…</text>
        </Show>
        <Show when={state() === "error"}>
          <text fg={props.context.theme.text.feedback.error.base}>额度查询失败</text>
        </Show>
        <Show when={state() === "ready" && body().length === 0}>
          <text fg={props.context.theme.text.muted}>暂无额度数据</text>
        </Show>
        <Show when={state() === "ready" && body().length > 0}>
          {body().map((line) => {
            const percent = Number(line.match(/(\d+)%\s*剩余/)?.[1])
            const quotaLine = line.match(/^([^:]+:)\s*(\d+%\s*剩余)(.*)$/)
            return <box flexDirection="column">
              <Show when={quotaLine} fallback={<text fg={props.context.theme.text.base} wrapMode="none">{line || " "}</text>}>
                <box flexDirection="row" gap={1}>
                  <text fg={props.context.theme.text.muted}>{quotaLine![1]}</text>
                  <text fg={props.context.theme.text.feedback.success.base}>{quotaLine![2]}</text>
                  <text fg={props.context.theme.text.muted}>{quotaLine![3]}</text>
                </box>
              </Show>
              <Show when={Number.isFinite(percent)}>
                <box flexDirection="row">
                  <text fg={props.context.theme.text.feedback.success.base}>{"█".repeat(Math.round(percent / 5))}</text>
                  <text fg={props.context.theme.text.muted}>{"░".repeat(20 - Math.round(percent / 5))}</text>
                </box>
              </Show>
            </box>
          })}
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
