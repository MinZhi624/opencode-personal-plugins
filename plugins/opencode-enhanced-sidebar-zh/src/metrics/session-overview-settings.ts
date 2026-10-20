/**「指标」页的展示设置模型：纯归一化＋默认值，不含读写与渲染。
 *
 *  口径（简）：上下文占用＝最近消息五类 Token ÷ 模型上限；Token／花费共用一个统计范围。
 */

/** 统计范围：二选一，Token 与花费共用，切换即自动生效。 */
export const METRIC_SCOPES = ["session", "tree"] as const
export type MetricScope = (typeof METRIC_SCOPES)[number]

export const METRIC_SCOPE_TITLES: Record<MetricScope, string> = {
  session: "本对话",
  tree: "本对话+子代理",
}

/** 归一化后的展示设置。 */
export interface SessionOverviewDisplay {
  showContext: boolean
  showTokens: boolean
  showCost: boolean
  showCache: boolean
  showTps: boolean
  scope: MetricScope
}

/** 默认：全显示，范围＝本对话+子代理。 */
export const DISPLAY_DEFAULTS: SessionOverviewDisplay = {
  showContext: true,
  showTokens: true,
  showCost: true,
  showCache: true,
  showTps: true,
  scope: "tree",
}

/** 「精简显示」预设：隐藏缓存命中率与 TPS。 */
export const PRESET_COMPACT: SessionOverviewDisplay = {
  ...DISPLAY_DEFAULTS,
  showCache: false,
  showTps: false,
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

/** 容错归一化：非法值一律回落默认。 */
export function readDisplay(raw: Record<string, unknown> | undefined): SessionOverviewDisplay {
  const source = raw ?? {}
  return {
    showContext: boolOr(source.showContext, DISPLAY_DEFAULTS.showContext),
    showTokens: boolOr(source.showTokens, DISPLAY_DEFAULTS.showTokens),
    showCost: boolOr(source.showCost, DISPLAY_DEFAULTS.showCost),
    showCache: boolOr(source.showCache, DISPLAY_DEFAULTS.showCache),
    showTps: boolOr(source.showTps, DISPLAY_DEFAULTS.showTps),
    scope: (METRIC_SCOPES as readonly string[]).includes(String(source.scope))
      ? (source.scope as MetricScope)
      : DISPLAY_DEFAULTS.scope,
  }
}
