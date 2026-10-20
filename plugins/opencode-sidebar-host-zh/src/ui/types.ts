/**
 * 统一设置窗口（/sidebar-cards）与宿主之间的契约类型。
 *
 * 这里只有类型，不 import context、不做 IO：
 * - 设置形状直接用 `SidebarCardSettings`（host-settings 已含 bar/bars 全字段）；
 * - `ControlWindowHost` 是窗口向宿主索取的唯一接口：宿主拥有持久化与预览语义，
 *   窗口只做交互与草稿。
 */
import type { Context } from "@opencode/plugin/tui/context"
import type { RGBA } from "@opentui/core"
import type { SidebarAppearance, SidebarShortcuts } from "../presentation.ts"
import type { RegisteredCard } from "../seam.ts"
import type { SidebarCardSettings } from "../host-settings.ts"

/** 主题色令牌：OpenCode 把自己的颜色值交给渲染器，宿主只透传、不解析。 */
export type ThemeColor = string | RGBA

/** 窗口读到的主题令牌（只用本仓库其他 TUI 已验证存在的角色）。 */
export interface WindowTheme {
  readonly background?: {
    readonly raised: { readonly high: ThemeColor }
    readonly action?: { readonly primary?: { readonly focused?: ThemeColor } }
  }
  readonly text: {
    readonly base: ThemeColor
    readonly muted: ThemeColor
    readonly action: { readonly primary: { readonly base: ThemeColor; readonly focused?: ThemeColor } }
    readonly feedback: {
      readonly success: { readonly base: ThemeColor }
      readonly warning: { readonly base: ThemeColor }
      readonly error: { readonly base: ThemeColor }
    }
  }
}

/** cli.json 的写入面状态，供页脚与保存前检查。 */
export interface ControlFileState {
  readonly writable: boolean
  readonly reason: string
  readonly path: string
  /** 文件里是否已有 sidebarCards（决定导入是否被拒绝）。 */
  readonly configured: boolean
  /** 环境变量是否覆盖了 CLI 配置（此时文件只读）。 */
  readonly inline: boolean
}

/** 一次保存的结果。失败时 `message` 面向用户，草稿由调用方保留。 */
export interface SaveResult {
  readonly ok: boolean
  readonly message?: string
  /** 保存成功后的新原始基线（写后确认读到的文件值）。 */
  readonly baseline?: SidebarCardSettings
}

export interface ControlWindowHost {
  readonly context: Context
  /** 完整序列：含未写盘的新注册卡片，侧栏与窗口都按它展示。 */
  fullSettings(): SidebarCardSettings
  /** 原始基线：cli.json／options 里已持久化的值。绝不用内存补齐后的 full 与磁盘比较。 */
  rawSettings(): SidebarCardSettings
  /** 排列／显隐草稿的内存预览（不落盘）；undefined = 回到已保存状态。 */
  previewArrangement(next: SidebarCardSettings | undefined): void
  /** 重新读取 cli.json 并应用（refreshStatus(true)），随后由窗口重建基线。 */
  refreshFromDisk(): Promise<void>
  /** 保存排列草稿。内部用 sameSidebarCards(current, baseline) 防止覆盖外部修改。 */
  saveCards(draft: SidebarCardSettings, baseline: SidebarCardSettings): Promise<SaveResult>
  /** 保存外观草稿：只写 bar/bars 等展示字段，不动磁盘上的 order/hidden。 */
  saveAppearance(appearance: SidebarAppearance, baseline: SidebarCardSettings): Promise<SaveResult>
  /** 保存快捷入口草稿：整份替换 shortcuts，其余字段原样保留。 */
  saveShortcuts(shortcuts: SidebarShortcuts, baseline: SidebarCardSettings): Promise<SaveResult>
  /** 已保存的外观（原始基线里的 bar/bars）。 */
  savedAppearance(): SidebarAppearance
  /** 外观草稿发布：宿主 effect 消费；undefined = 回到已保存值。 */
  setAppearanceDraft(value: SidebarAppearance | undefined): void
  /** 宿主既有导入流程（对话框预览确认后写 cli.json）。 */
  runImport(): Promise<void>
  labelFor(id: string): string
  registrations(): readonly RegisteredCard[]
  fileState(): ControlFileState
}
