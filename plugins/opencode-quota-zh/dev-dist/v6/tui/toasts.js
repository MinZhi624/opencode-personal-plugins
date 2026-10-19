import { WINDOWS } from "../core/windows.js";
import { DEFAULT_WORDS, levelOf } from "../view/format.js";
import { visibleGroups } from "../view/select.js";
import { lineText, toastLines } from "../view/text.js";
/** The title of quota's one-line toasts (a hint, a wrong range); quota toasts have none. */
export const TOAST_TITLE = "OpenCode 额度";
/** What a toast without a title keeps right of its text: OpenCode's close "x", 2 columns in. */
const CLOSE_ROOM = 3;
/**
 * The columns of a quota toast's text: OpenCode's toast is at most 60 columns and 6 fewer than
 * the terminal, inside a border and 2 columns of padding on each side; a toast without a title
 * has its close "x" beside the text.
 */
export function toastRoom(terminalWidth) {
    return Math.min(60, terminalWidth - 6) - 6 - CLOSE_ROOM;
}
/** `groups` in the toast layout the settings pick, as wide as the toast's text. */
function layoutLines(groups, words, display, nowMs, terminalWidth, sessionTokens) {
    return toastLines({
        groups,
        words,
        nowMs,
        layout: display.toast.layout,
        bar: display.layout.bar,
        evenUse: display.layout.evenUse,
        room: toastRoom(terminalWidth),
        runsOut: display.runsOut.toast,
        ...(sessionTokens ? { sessionTokens } : {}),
    });
}
/** A quota toast's lines as its plain message. */
export function plainMessage(lines) {
    return lines.map(lineText).join("\n");
}
/** The session tokens a quota toast shows, when its settings show them. */
function toastTokens(snapshot, display) {
    return display.toast.sessionTokens ? snapshot.sessionTokens : undefined;
}
/** The rows the Toast tab shows, in its layout, then the session tokens. */
export function quotaToastLines(snapshot, display, nowMs, terminalWidth) {
    const words = snapshot.words ?? DEFAULT_WORDS;
    const groups = visibleGroups(snapshot, display, "toast", words);
    const tokens = toastTokens(snapshot, display);
    return layoutLines(groups, words, display, nowMs, terminalWidth, tokens);
}
function wantsTurnToast(display, trigger, anyLow) {
    if (trigger === "compaction")
        return display.toast.afterCompaction;
    if (trigger === "question")
        return display.toast.afterQuestion;
    return display.toast.afterReply === "always" || (display.toast.afterReply === "low" && anyLow);
}
function resetMessage(notice, snapshot, display) {
    const provider = snapshot.providers.find((item) => item.providerId === notice.providerId);
    const name = provider?.label ?? notice.providerId;
    const title = notice.account ? `${name} (${notice.account})` : name;
    const label = display.toast.names[notice.rowId] ?? notice.label;
    const left = Math.max(0, Math.min(100, Math.round(notice.percentRemaining)));
    return `${WINDOWS[notice.window].label} 额度重置：${title} ${label} 已恢复可用（剩余 ${left}%）。`;
}
export function createToasts(host) {
    const now = host.now ?? Date.now;
    /** Notices from before this TUI started were news to the TUI that saw them then. */
    const startedAtMs = now();
    const shownNotices = new Set();
    /** The "every provider fails" toast shows once until some provider answers again. */
    let allFailShown = false;
    /** Turns whose toast is being made; reset notices wait for them. */
    let turnsRunning = 0;
    let waitingNotices = [];
    function showNotices() {
        if (turnsRunning > 0 || waitingNotices.length === 0)
            return;
        host.show({
            variant: "success",
            title: "额度可用",
            message: waitingNotices.map((notice) => notice.message).join("\n"),
            duration: host.display().toast.seconds * 1000,
        });
        waitingNotices = [];
    }
    async function turnToast(trigger, sessionID) {
        const snapshot = await host.quota.refresh("turn", sessionID);
        const display = host.display();
        if (!snapshot || !display.surfaces.toast.enabled)
            return;
        const words = snapshot.words ?? DEFAULT_WORDS;
        const nowMs = now();
        const groups = visibleGroups(snapshot, display, "toast", words);
        const allFail = snapshot.providers.length > 0 && snapshot.providers.every((provider) => provider.error);
        if (!allFail)
            allFailShown = false;
        const anyLow = groups.some((group) => group.rows.some(({ row }) => row.percentRemaining !== undefined &&
            levelOf(row.percentRemaining, display.thresholds) !== "good"));
        const duration = display.toast.seconds * 1000;
        const width = host.terminalWidth();
        if (wantsTurnToast(display, trigger, anyLow)) {
            const tokens = toastTokens(snapshot, display);
            const lines = layoutLines(groups, words, display, nowMs, width, tokens);
            const message = plainMessage(lines);
            if (message)
                host.show({ variant: "info", message, duration }, lines);
            return;
        }
        if (allFail && display.toast.whenAllFail && !allFailShown) {
            allFailShown = true;
            const failing = groups.filter((group) => group.error);
            const lines = layoutLines(failing, words, display, nowMs, width);
            const message = plainMessage(lines);
            if (message)
                host.show({ variant: "error", message, duration }, lines);
        }
    }
    return {
        async afterTurn(trigger, sessionID) {
            if (host.isChildSession(sessionID))
                return;
            turnsRunning += 1;
            try {
                await turnToast(trigger, sessionID);
            }
            finally {
                turnsRunning -= 1;
                showNotices();
            }
        },
        showResetNotices(snapshot) {
            const display = host.display();
            for (const notice of snapshot.resetNotices) {
                if (shownNotices.has(notice.id))
                    continue;
                shownNotices.add(notice.id);
                const wanted = display.toast.resetNotice === "all" ||
                    (display.toast.resetNotice === "weekly" && notice.window === "week");
                if (!wanted || !display.surfaces.toast.enabled || notice.atMs < startedAtMs)
                    continue;
                waitingNotices.push({ id: notice.id, message: resetMessage(notice, snapshot, display) });
            }
            showNotices();
        },
        cancel() {
            for (const notice of waitingNotices)
                shownNotices.delete(notice.id);
            waitingNotices = [];
        },
    };
}
