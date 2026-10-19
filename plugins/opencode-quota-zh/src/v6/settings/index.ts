/**
 * The server settings, one module: `loadSettings`, `saveSettings(patch)`, `editSettings`,
 * `editSettingsFile`, `watchSettings`, `convertV5` and the schema the agent tools describe and
 * check values with.
 * Every client reads these settings from settings.jsonc through the quota RPC.
 */
export type { ConvertedKey, SkippedKey, V5Conversion } from "./convert.js";
export {
  type CustomSwitch,
  convertV5,
  editSettings,
  editSettingsFile,
  type LoadedSettings,
  loadSettings,
  type SaveResult,
  type SettingsChange,
  type SettingsFileEdit,
  type SettingsWatch,
  saveSettings,
  settingsPath,
  watchSettings,
} from "./file.js";
export {
  type ClientSettings,
  type CursorPlan,
  type CustomProviderSwitch,
  checkSetting,
  clientSettings,
  customProviderFingerprint,
  defaultSettings,
  describeRule,
  keysUnder,
  type PercentStyle,
  PROVIDER_IDS,
  type ResetStyle,
  SETTINGS_SCHEMA,
  type SettingRule,
  type Settings,
  type SettingsIssue,
  type SettingsPatch,
} from "./schema.js";
