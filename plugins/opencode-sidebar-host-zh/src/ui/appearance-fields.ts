/**
 * 布局／颜色两页的纯字段定义与草稿补丁：只放数据与纯函数，
 * 交互（对话框、预览、脏标记）留在 control-window。
 *
 * 与 ui/appearance.ts 的分工：那边管 bar/bars 形状与从文件提取校验，
 * 这边管宽度、布局数值、角色色与预设，并统一「未设置即删除」的补丁写法。
 * 布局数值范围取自 host-settings 的 SIDEBAR_LAYOUT_LIMITS：界面与文件校验同一份数。
 */
import { SIDEBAR_LAYOUT_LIMITS, type SidebarLayoutNumberField } from "../host-settings.ts"
import {
  SIDEBAR_COLOR_ROLES,
  type SidebarBarWidth,
  type SidebarColorRole,
  type SidebarColors,
  type SidebarLayout,
} from "../presentation.ts"

/** 进度条宽度可选项（整体行）：填满或固定列数。 */
export const BAR_WIDTH_VALUES: readonly SidebarBarWidth[] = ["fill", 4, 6, 8, 10, 12, 16, 20]

/** 进度条宽度可选项（覆盖行）：多一个「继承」（删除覆盖）。 */
export const BAR_WIDTH_CHOICES: readonly (SidebarBarWidth | undefined)[] = [undefined, ...BAR_WIDTH_VALUES]

export function widthTitle(width: SidebarBarWidth | undefined, unset: string): string {
  if (width === undefined) return unset
  return width === "fill" ? "填满可用宽度" : `${width} 列`
}

/** 布局数值字段的界面词（标题与单位共用一份）。 */
export const LAYOUT_NUMBER_FIELDS: readonly { key: SidebarLayoutNumberField; title: string; unit: string }[] = [
  { key: "gap", title: "卡片间距", unit: "空行" },
  { key: "lineGap", title: "卡片内附加行距", unit: "空行" },
  { key: "indent", title: "缩进", unit: "空格" },
  { key: "labelWidth", title: "行名宽度", unit: "字符" },
]

export function layoutUnit(field: SidebarLayoutNumberField): string {
  return LAYOUT_NUMBER_FIELDS.find((item) => item.key === field)?.unit ?? ""
}

/** 数值字段可选项：未设置＋合法范围（含两端）。 */
export function layoutNumberChoices(field: SidebarLayoutNumberField): readonly (number | undefined)[] {
  const { min, max } = SIDEBAR_LAYOUT_LIMITS[field]
  const values: number[] = []
  for (let value = min; value <= max; value++) values.push(value)
  return [undefined, ...values]
}

/** 标题分隔线可选项：未设置＋开／关。 */
export const DIVIDER_CHOICES: readonly (boolean | undefined)[] = [undefined, true, false]

export function dividerTitle(value: boolean | undefined, unset: string): string {
  return value === undefined ? unset : value ? "开" : "关"
}

/** 某个布局字段的可选项（未设置＋合法值）：数值走范围，分隔线走开／关。 */
export function layoutChoices(field: SidebarLayoutNumberField | "divider"): readonly (number | boolean | undefined)[] {
  return field === "divider" ? DIVIDER_CHOICES : layoutNumberChoices(field)
}

/** 某个布局字段的显示词；未设置用调用方给的词（未设置／继承）。 */
export function layoutFieldTitle(
  field: SidebarLayoutNumberField | "divider",
  value: number | boolean | undefined,
  unset: string,
): string {
  if (field === "divider") return dividerTitle(value as boolean | undefined, unset)
  return layoutNumberTitle(value as number | undefined, unset, layoutUnit(field))
}

export function layoutNumberTitle(value: number | undefined, unset: string, unit: string): string {
  return value === undefined ? unset : `${value} ${unit}`
}

/** Quota 风格预设：只写草稿；颜色清空（跟随主题）。 */
export const QUOTA_STYLE_PRESET: { bar: "line"; barWidth: "fill"; layout: SidebarLayout } = {
  bar: "line",
  barWidth: "fill",
  layout: { gap: 1, lineGap: 0, indent: 0, labelWidth: 12, divider: true },
}

/** 六角色的中文名。 */
export const COLOR_ROLE_TITLES: Record<SidebarColorRole, string> = {
  title: "标题",
  body: "正文",
  muted: "次要文字",
  divider: "分隔线",
  bar: "进度条",
  warn: "告警",
}

/** 整体行「没有覆盖」的显示词。 */
export const FOLLOW_THEME_TITLE = "跟随主题"

export interface ColorPreset {
  readonly title: string
  readonly colors: SidebarColors
}

/** 三套角色色预设：浅色（深字浅底）、深色（浅字深底）、高对比（纯黑纯白＋亮黄告警）。 */
export const COLOR_PRESETS: readonly ColorPreset[] = [
  { title: "浅色", colors: { title: "#262626", body: "#404040", muted: "#757575", divider: "#d4d4d4", bar: "#1d4ed8", warn: "#b45309" } },
  { title: "深色", colors: { title: "#ececec", body: "#c8c8c8", muted: "#8f8f8f", divider: "#3d3d3d", bar: "#4cc38a", warn: "#f4bf4f" } },
  { title: "高对比", colors: { title: "#000000", body: "#000000", muted: "#333333", divider: "#000000", bar: "#ffffff", warn: "#ffff00" } },
]

export function colorTitle(value: string | undefined, unset: string): string {
  return value === undefined ? unset : value
}

/** 两份角色色在持久化意义上是否相同（缺键与缺省等价）。 */
export function sameRoleColors(a: SidebarColors | undefined, b: SidebarColors | undefined): boolean {
  return SIDEBAR_COLOR_ROLES.every((role) => (a?.[role] ?? undefined) === (b?.[role] ?? undefined))
}

/** 整套角色色与哪套预设一致；没有匹配（自定义）返回 -1。 */
export function colorPresetIndexOf(colors: SidebarColors | undefined): number {
  return COLOR_PRESETS.findIndex((preset) => sameRoleColors(preset.colors, colors))
}

/**
 * 布局条目补丁：只改一个字段，未设置即删除该键；
 * 条目清空返回 undefined（等同没有覆盖）。
 */
export function patchLayoutField(
  entry: SidebarLayout | undefined,
  field: SidebarLayoutNumberField | "divider",
  value: number | boolean | undefined,
): SidebarLayout | undefined {
  const next: SidebarLayout = { ...entry }
  if (value === undefined) delete next[field]
  else Object.defineProperty(next, field, { value, enumerable: true, writable: true, configurable: true })
  return Object.keys(next).length > 0 ? next : undefined
}

/** 角色色补丁：未设置即删除该角色；整份清空返回 undefined（跟随主题／继承）。 */
export function patchColorRole(
  colors: SidebarColors | undefined,
  role: SidebarColorRole,
  value: string | undefined,
): SidebarColors | undefined {
  const next: SidebarColors = { ...colors }
  if (value === undefined) delete next[role]
  else Object.defineProperty(next, role, { value, enumerable: true, writable: true, configurable: true })
  return Object.keys(next).length > 0 ? next : undefined
}
