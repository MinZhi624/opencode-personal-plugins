/** @jsxImportSource @opentui/solid */

import "@opentui/solid/preload"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"
import { WorkshopPresetRpc } from "../shared/rpc.ts"
import type { PresetState } from "../shared/presets.ts"
import { activatePreset, fetchPresetState } from "./rpc-client.ts"
import { PresetCard } from "./preset-card.tsx"
import { PresetPage } from "./preset-page.tsx"
import { startPresetWeb, stopPresetWeb } from "./web-server.ts"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function switchCurrentSessionModel(context: Context, state: PresetState): Promise<string | undefined> {
  const route = context.ui.router.current()
  if (route.type !== "session") return undefined
  const session = context.data.session.get(route.sessionID)
  const agent = session?.agent ?? "tinker"
  const resolved = state.resolved[agent]
  if (!resolved?.model) return undefined
  const separator = resolved.model.indexOf("/")
  if (separator <= 0) return undefined
  try {
    await context.client.session.switchModel({
      sessionID: route.sessionID,
      model: {
        providerID: resolved.model.slice(0, separator),
        id: resolved.model.slice(separator + 1),
        ...(resolved.variant ? { variant: resolved.variant } : {}),
      },
    })
    return resolved.model
  } catch {
    return undefined
  }
}

export default Plugin.define({
  id: "opencode-matt-workshop.tui",
  async setup(context) {
    const [state, setState] = createSignal<PresetState>()

    const refresh = async (): Promise<PresetState> => {
      const next = await fetchPresetState(context)
      setState(next)
      return next
    }

    void refresh().catch((error: unknown) => {
      console.warn("[opencode-matt-workshop] 读取预设失败", error)
    })

    // 网页保存/应用后由 Server 发出 changed；侧栏卡片随之刷新，不需要重开 TUI。
    const eventController = new AbortController()
    try {
      context.client.rpc(WorkshopPresetRpc).events.on(
        "changed",
        () => {
          if (eventController.signal.aborted) return
          void refresh().catch((error: unknown) => {
            console.warn("[opencode-matt-workshop] 预设变更后刷新失败", error)
          })
        },
        { signal: eventController.signal },
      )
    } catch (error: unknown) {
      console.warn("[opencode-matt-workshop] 订阅预设变更失败", error)
    }

    const toastError = (title: string, error: unknown) => {
      context.ui.toast.show({ title, message: errorMessage(error), variant: "error", duration: 8000 })
    }

    const applyPreset = async (name: string): Promise<void> => {
      const next = await activatePreset(context, name)
      setState(next)
      const switched = await switchCurrentSessionModel(context, next)
      context.ui.toast.show({
        title: "模型预设",
        message:
          name === "base"
            ? "已恢复插件基础模型；新派发的子代理生效。"
            : `已应用「${name}」；新派发的子代理使用新模型。${switched ? ` 当前会话已切到 ${switched}。` : ""}`,
        variant: "success",
        duration: 7000,
      })
    }

    const closePage = (returnTo: unknown) => {
      if (
        returnTo &&
        typeof returnTo === "object" &&
        (returnTo as { type?: unknown }).type === "session" &&
        typeof (returnTo as { sessionID?: unknown }).sessionID === "string"
      ) {
        context.ui.router.navigate({
          type: "session",
          sessionID: (returnTo as { sessionID: string }).sessionID,
        })
        return
      }
      context.ui.router.navigate({ type: "home" })
    }

    const openManager = () => {
      const route = context.ui.router.current()
      const returnTo = route.type === "session"
        ? { type: "session" as const, sessionID: route.sessionID }
        : { type: "home" as const }
      // 网页可能刚改过文件；先刷新一次，让预设页显示最新内容。
      void refresh().catch((error: unknown) => {
        console.warn("[opencode-matt-workshop] 打开预设页前刷新失败", error)
      })
      context.ui.router.navigate({ type: "plugin", name: "presets", data: { returnTo } })
    }

    const switchPreset = async (input?: string): Promise<void> => {
      const name = input?.trim()
      if (!name) {
        openManager()
        return
      }
      try {
        await applyPreset(name)
      } catch (error: unknown) {
        toastError("切换预设失败", error)
      }
    }

    const openWeb = async (): Promise<void> => {
      try {
        const handle = await startPresetWeb(context)
        await refresh()
        context.ui.toast.show({
          title: "模型预设编辑器",
          message: handle.url,
          variant: "info",
          duration: 15_000,
        })
      } catch (error: unknown) {
        toastError("打开网页编辑器失败", error)
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "matt.preset.switch",
          title: "切换模型预设",
          group: "Matt Workshop",
          palette: true,
          slash: { name: "preset" },
          enabled: () => true,
          run: async () => switchPreset(undefined),
        },
        {
          id: "matt.preset.apply",
          title: "应用命名模型预设",
          group: "Matt Workshop",
          palette: true,
          slash: { name: "apply-preset", arguments: true },
          enabled: () => true,
          run: async (input?: string) => switchPreset(input),
        },
        {
          id: "matt.preset.web",
          title: "打开模型预设网页编辑器",
          group: "Matt Workshop",
          palette: true,
          slash: { name: "web-preset" },
          enabled: () => true,
          run: async () => openWeb(),
        },
      ],
    }))

    const unregisterRoute = context.ui.router.register({
      name: "presets",
      render: ({ data }) => {
        const returnTo = data?.returnTo
        return (
          <PresetPage
            context={context}
            state={state}
            onApply={async (name) => {
              try {
                await applyPreset(name)
                closePage(returnTo)
              } catch (error: unknown) {
                toastError("切换预设失败", error)
              }
            }}
            onClose={() => closePage(returnTo)}
          />
        )
      },
    })

    // 有侧栏宿主时按宿主卡片注册，这样 /sidebar-cards 可以排序、隐藏；
    // 没有宿主（或宿主动态加载失败）时退回直接追加 sidebar.content。
    let fallbackSlot: (() => void) | undefined
    let hostCard: { status: () => { state: string }; dispose: () => void } | undefined

    const mountDirectSlot = () => {
      if (fallbackSlot) return
      fallbackSlot = context.ui.slot({
        append: "sidebar.content",
        render: () => <PresetCard context={context} state={state} />,
      })
    }

    try {
      // 宿主已在或还没加载都交给它的队列：排队状态不会因宿主接管而翻转，
      // 所以这里不能再做“超时后直接追加”的兜底，否则会多出一份不受 /sidebar-cards 控制的卡片。
      const host = await import("../../opencode-sidebar-host-zh/src/register-card.ts")
      hostCard = host.registerSidebarCard({
        id: "workshopPreset",
        owner: "opencode-matt-workshop.tui",
        title: "模型预设",
        requiredSeam: 1,
        render: () => <PresetCard context={context} state={state} />,
        onStatus: (status) => {
          if (status.state === "rejected") {
            console.warn("[opencode-matt-workshop] 预设卡片注册被侧栏宿主拒绝", status.code, status.message)
          }
        },
      })
    } catch {
      // 宿主包不存在（只装 workshop 组）：直接追加，至少保留卡片。
      mountDirectSlot()
    }

    return () => {
      eventController.abort()
      unregisterRoute()
      hostCard?.dispose()
      fallbackSlot?.()
      void stopPresetWeb()
    }
  },
})
