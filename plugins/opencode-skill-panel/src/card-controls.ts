/** 技能卡片的展示设置注册（统一窗口的“技能”页）。
 *
 *  归属：skillPanelMaxUsed / skillPanelDefaultOpen 是本插件的 cli.json 插件选项，
 *  经 host/src/plugin-options.ts 的既有安全写回 helper 定位唯一 CLI 插件条目：
 *  保留注释与其他选项、加锁、写入前后重读比对、环境变量覆盖时拒写。
 *  宿主不复制这份设置；隐藏卡片时同样可设置（setup 注册、cleanup 撤销）。
 */
import type { Context } from "@opencode/plugin/tui/context"
import { fileURLToPath } from "node:url"
import {
  registerCardControls,
  sameCardControlValues,
  type CardControlValues,
} from "../../opencode-sidebar-host-zh/src/card-controls.ts"
import { createPluginOptionsConfig } from "../../opencode-sidebar-host-zh/src/plugin-options.ts"
import {
  readSkillPanelOptions,
  SKILL_PANEL_MAX_USED_MAX,
  SKILL_PANEL_MAX_USED_MIN,
  writeDefaultOpen,
  writeMaxUsed,
  type SkillPanelDisplayOptions,
} from "./skill-options.ts"

const PACKAGE_NAME = "opencode-skill-panel"
const CARD_ID = "skill"

const MAX_USED_CHOICES = [0, 3, 5, 8, 10, 15, 20, 30].map((value) => ({ value, title: value === 0 ? "不列项目" : `${value} 条` }))
const OPEN_CHOICES = [
  { value: true, title: "展开" },
  { value: false, title: "折叠" },
] as const

/** 控制窗口的取值形状：只有简单值，和 cli.json options 的键一一对应。 */
function controlValues(options: SkillPanelDisplayOptions): CardControlValues {
  return { skillPanelMaxUsed: options.skillPanelMaxUsed, skillPanelDefaultOpen: options.skillPanelDefaultOpen }
}

export function registerSkillCardControls(
  context: Context,
  onSaved: (options: SkillPanelDisplayOptions) => void,
): () => void {
  // 只读使用 host 的写回 helper：它负责唯一条目定位、注释与其他选项保留、锁与冲突检测。
  const config = createPluginOptionsConfig(PACKAGE_NAME, fileURLToPath(new URL("../", import.meta.url)))
  return registerCardControls({
    id: CARD_ID,
    title: "技能",
    fields: [
      // choices 只是建议值：已有的其他合法取值（含更大的数）同样有效，min/max 才是边界。
      { key: "skillPanelMaxUsed", title: "最多显示", choices: MAX_USED_CHOICES, min: SKILL_PANEL_MAX_USED_MIN, max: SKILL_PANEL_MAX_USED_MAX, integer: true },
      { key: "skillPanelDefaultOpen", title: "初始展开", choices: OPEN_CHOICES },
    ],
    note: "保存在 cli.json 本插件条目的 options（最多显示填 0 或正整数，0 表示不列项目）；保存后本窗口立即生效，其他窗口重启 TUI。",
    async read(): Promise<CardControlValues> {
      // 文件优先：读到的就是保存后的权威值，失败（条目缺失／重复／环境变量覆盖）直接抛出。
      const options = await config.read()
      return controlValues(readSkillPanelOptions(options))
    },
    async save(values: CardControlValues, baseline: CardControlValues): Promise<void> {
      const saved = await config.update((current) => {
        // baseline 在 owner 的写入操作里对比 normalize(current)，不只比旧内存：
        // 别的窗口改过 cli.json 就拒绝，不静默覆盖。
        if (!sameCardControlValues(controlValues(readSkillPanelOptions(current)), baseline)) {
          throw new Error("cli.json 的技能展示选项已被其他窗口修改，请重新读取后再保存")
        }
        // 只写用户实际改动的字段：未改动的既有值（含没写进文件的隐式默认）原样保留，
        // 不批量归一化，也不把已有配置收窄成别范围。
        const patch: Record<string, number | boolean> = {}
        if (values.skillPanelMaxUsed !== baseline.skillPanelMaxUsed) {
          patch.skillPanelMaxUsed = writeMaxUsed(values.skillPanelMaxUsed)
        }
        if (values.skillPanelDefaultOpen !== baseline.skillPanelDefaultOpen) {
          patch.skillPanelDefaultOpen = writeDefaultOpen(values.skillPanelDefaultOpen)
        }
        return patch
      })
      // 以实际写回的结果更新本窗口，不凭内存里的草稿宣称生效。
      onSaved(readSkillPanelOptions(saved))
    },
  })
}
