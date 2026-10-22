/**
 * TUI 侧的预设 RPC 客户端。
 *
 * TUI 不直接读写预设文件：Server 插件是唯一写入者。这样远程 Server 时，
 * 文件仍然写在 Server 所在机器，TUI 只发请求并刷新展示。
 */
import type { Context } from "@opencode/plugin/tui/context"
import { WorkshopPresetRpc } from "../shared/rpc.ts"
import type { PresetDefinition, PresetState } from "../shared/presets.ts"

export interface RpcCallOptions {
  readonly location: { readonly directory: string }
  readonly signal: AbortSignal
}

export function presetCallOptions(context: Context): RpcCallOptions {
  const location = context.location ?? context.data.location.default()
  if (!location?.directory) throw new Error("OpenCode 没有提供当前目录，无法读取预设")
  return { location, signal: AbortSignal.timeout(30_000) }
}

export async function fetchPresetState(context: Context): Promise<PresetState> {
  return (await context.client.rpc(WorkshopPresetRpc).state({}, presetCallOptions(context))) as PresetState
}

export async function activatePreset(context: Context, name: string): Promise<PresetState> {
  return (await context.client.rpc(WorkshopPresetRpc).activate({ name }, presetCallOptions(context))) as PresetState
}

export async function savePresetDefinitions(
  context: Context,
  presets: Readonly<Record<string, PresetDefinition>>,
  active?: string | null,
): Promise<PresetState> {
  return (await context.client.rpc(WorkshopPresetRpc).save(
    {
      presets,
      ...(active === undefined ? {} : { active }),
    },
    presetCallOptions(context),
  )) as PresetState
}
