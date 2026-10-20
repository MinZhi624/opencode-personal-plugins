/** 「指标」页的展示设置注册（统一窗口 provider 页）。
 *
 *  归属：存档 session-overview-zh-v2 归本插件 context，宿主不复制；隐藏卡片时同样可设置。
 *  口径（简）：上下文占用与 Token 是两个量；Token／花费共用一个统计范围；
 *  花费来自 Quota sessionUsage 报告；TPS 只做显隐、行为不变。
 */
import type { Context } from "@opencode/plugin/tui/context"
import {
  registerCardControls,
  sameCardControlValues,
  type CardControlField,
  type CardControlValues,
} from "../../opencode-sidebar-host-zh/src/card-controls.ts"
import {
  SESSION_OVERVIEW_CARD_ID,
  SESSION_OVERVIEW_SETTINGS_KEY,
} from "../../opencode-enhanced-sidebar-zh/src/tui-v2-session-overview.tsx"
import {
  DISPLAY_DEFAULTS,
  METRIC_SCOPES,
  METRIC_SCOPE_TITLES,
  PRESET_COMPACT,
  readDisplay,
  type SessionOverviewDisplay,
} from "../../opencode-enhanced-sidebar-zh/src/metrics/session-overview-settings.ts"

const OPEN_CHOICES = [
  { value: true, title: "展开" },
  { value: false, title: "折叠" },
] as const

const SHOW_CHOICES = [
  { value: true, title: "显示" },
  { value: false, title: "隐藏" },
] as const

type StoredShape = { version: number; open: boolean } & Partial<SessionOverviewDisplay>

function readStored(context: Context): { open: boolean; display: SessionOverviewDisplay } {
  const [settings] = context.storage.store<StoredShape>(SESSION_OVERVIEW_SETTINGS_KEY, {
    initial: { version: 2, open: true },
  })
  return { open: settings.open !== false, display: readDisplay(settings) }
}

function storedValues(context: Context): CardControlValues {
  const { open, display } = readStored(context)
  return { open, ...display }
}

function fields(): CardControlField[] {
  const toggle = (key: keyof SessionOverviewDisplay, title: string): CardControlField => ({
    key,
    title,
    choices: SHOW_CHOICES,
  })
  return [
    { key: "open", title: "卡片展开", choices: OPEN_CHOICES },
    toggle("showContext", "上下文占用"),
    toggle("showTokens", "Token"),
    toggle("showCost", "花费"),
    toggle("showCache", "缓存命中率"),
    toggle("showTps", "TPS"),
    {
      key: "scope",
      title: "统计范围",
      choices: METRIC_SCOPES.map((scope) => ({ value: scope as string, title: METRIC_SCOPE_TITLES[scope] })),
      description: "Token 与花费共用，切换即生效。",
    },
  ]
}

export function registerOverviewCardControls(context: Context): () => void {
  return registerCardControls({
    id: SESSION_OVERVIEW_CARD_ID,
    title: "指标",
    fields: fields(),
    presets: [
      {
        title: "精简显示",
        values: { open: true, ...PRESET_COMPACT } as CardControlValues,
      },
    ],
    read(): CardControlValues {
      return storedValues(context)
    },
    async save(values: CardControlValues, baseline: CardControlValues): Promise<void> {
      const [, update] = context.storage.store<StoredShape>(SESSION_OVERVIEW_SETTINGS_KEY, {
        initial: { version: 2, open: true },
      })
      await update((draft) => {
        // baseline 对比：存档已被其他窗口改过就拒绝，不静默覆盖。
        if (!sameCardControlValues(storedValuesFromDraft(draft), baseline)) {
          throw new Error("指标设置已被其他窗口修改，请重新读取后再保存")
        }
        // 草稿里缺键＝保持现值；其余按归一化写入。
        if (values.open !== undefined) draft.open = values.open === true
        for (const key of ["showContext", "showTokens", "showCost", "showCache", "showTps"] as const) {
          if (typeof values[key] === "boolean") draft[key] = values[key] === true
        }
        if (values.scope !== undefined) draft.scope = readDisplay({ ...readDisplay(draft), scope: values.scope }).scope
      })
    },
  })
}

function storedValuesFromDraft(draft: StoredShape): CardControlValues {
  return { open: draft.open !== false, ...readDisplay(draft) }
}
