import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

import { SESSION_TOKEN_SECTION_HEADING } from "./session-tokens-format.js";

export function getSidebarBodyLineColor(
  line: string,
  theme: Pick<TuiPluginApi["theme"]["current"], "text" | "textMuted">,
): TuiPluginApi["theme"]["current"]["text"] | TuiPluginApi["theme"]["current"]["textMuted"] {
  return line.length > 0 && SESSION_TOKEN_SECTION_HEADING.startsWith(line)
    ? theme.text
    : theme.textMuted;
}
