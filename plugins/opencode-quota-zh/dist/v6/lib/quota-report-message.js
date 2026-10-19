import { DEFAULT_WORDS } from "../view/format.js";
import { quickLookText } from "../view/quick-look.js";
import { sanitizeDisplayText } from "./display-sanitize.js";
/** Metadata key on every quota report message. OpenCode stores message metadata with the message. */
export const QUOTA_REPORT_METADATA_KEY = "opencodeQuota";
/**
 * First and last line of every quota report message; Web and Desktop show them too.
 * When OpenCode compacts a session, it copies recent message text into the checkpoint
 * before plugin hooks run, so the metadata is lost there. These lines let the plugin cut
 * the report back out of that text.
 */
const QUOTA_REPORT_START = "[OpenCode 额度报告]";
const QUOTA_REPORT_END = "[OpenCode 额度报告结束]";
/** Reports from before the Chinese wording are marked in English; old sessions still hold those. */
const LEGACY_QUOTA_REPORT_START = "[OpenCode Quota report]";
const LEGACY_QUOTA_REPORT_END = "[End of OpenCode Quota report]";
const QUOTA_REPORT_BLOCKS = /\[(?:OpenCode 额度报告|OpenCode Quota report)\][\s\S]*?\[(?:OpenCode 额度报告结束|End of OpenCode Quota report)\]/g;
export function formatQuotaReportMessage(report) {
    return `${QUOTA_REPORT_START}\n${report}\n${QUOTA_REPORT_END}`;
}
export function containsQuotaReport(text) {
    return text.includes(QUOTA_REPORT_START) || text.includes(LEGACY_QUOTA_REPORT_START);
}
/** Cuts every complete quota report, first to last line, out of the text. */
export function removeQuotaReports(text) {
    return text.replace(QUOTA_REPORT_BLOCKS, "");
}
const EVERY_ROW = { enabled: true, hidden: [], providerOrder: [], rowOrder: {} };
/** Web and Desktop have no display settings: every provider and row, in the server's order. */
const NO_DISPLAY_CHOICES = {
    labels: {},
    window: {},
    surfaces: { sidebar: EVERY_ROW, collapsed: EVERY_ROW, statusLine: EVERY_ROW, toast: EVERY_ROW },
};
/**
 * The limits of every provider as the /quota report of Web and Desktop writes them, without its
 * usage and notices: what the TUI's Limits tab copies. Like that tab, it ignores
 * `onlyCurrentModel`.
 */
export function quotaLimitsText(snapshot, nowMs) {
    const words = { ...(snapshot.words ?? DEFAULT_WORDS), onlyCurrentModel: false };
    const text = quickLookText({
        snapshot: { ...snapshot, words },
        usage: undefined,
        settings: NO_DISPLAY_CHOICES,
        nowMs,
    });
    return sanitizeDisplayText(text);
}
/**
 * The /quota report of Web and Desktop: the short text of `view/quick-look.ts` for every
 * provider, then all active notices.
 */
export function quotaMessageText(params) {
    const { snapshot, usage, nowMs } = params;
    const quickLook = quickLookText({ snapshot, usage, settings: NO_DISPLAY_CHOICES, nowMs });
    const notices = params.notices.flatMap((notice) => [
        `- ${notice.message}`,
        ...(notice.url ? [`  ${notice.url}`] : []),
    ]);
    return [quickLook, ...(notices.length > 0 ? ["", "公告", ...notices] : [])].join("\n");
}
