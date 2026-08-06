import { abbreviateDisplayedModelName } from "./format-utils.js";
import { renderMarkdownReport, } from "./report-document.js";
import { emptyTokenBuckets, totalTokenBuckets } from "./token-buckets.js";
/** Use markdown-conceal for proper TUI alignment (strips markdown syntax for width calc) */
const TABLE_WIDTH_MODE = "markdown-conceal";
function fmtUsd(n) {
    if (!Number.isFinite(n))
        return "$0.00";
    return `$${n.toFixed(2)}`;
}
function hasRenderableSessionUsage(row) {
    return totalTokenBuckets(row.tokens) > 0 || row.costUsd > 0;
}
function appendSessionRow(sessionRows, row, current = "") {
    sessionRows.push([
        current,
        row.sessionID,
        fmtUsd(row.costUsd),
        fmtCompact(totalTokenBuckets(row.tokens)),
        fmtCompact(row.messageCount),
        truncateTitle(row.title),
    ]);
}
function treeRelationLabel(depth) {
    if (depth <= 0)
        return "当前会话";
    if (depth === 1)
        return "子会话";
    if (depth === 2)
        return "孙会话";
    return `后代会话（${depth}）`;
}
function missingFocusSessionLabel(hasRawFocus) {
    return hasRawFocus
        ? "（当前会话在所选时间范围内没有 token 用量）"
        : "（当前会话不在所选时间范围内）";
}
/**
 * Format a timestamp as human-readable local time: "HH:MM YYYY-MM-DD"
 */
function fmtLocalDateTime(ms) {
    const d = new Date(ms);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hours = String(d.getHours()).padStart(2, "0");
    const minutes = String(d.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes} ${year}-${month}-${day}`;
}
function fmtWindow(params) {
    if (!params.sinceMs && !params.untilMs)
        return "全部时间";
    const since = typeof params.sinceMs === "number" ? fmtLocalDateTime(params.sinceMs) : "-";
    const until = typeof params.untilMs === "number" ? fmtLocalDateTime(params.untilMs) : "现在";
    return `${since} .. ${until}`;
}
function fmtCompact(n) {
    if (!Number.isFinite(n))
        return "0";
    const abs = Math.abs(n);
    const sign = n < 0 ? "-" : "";
    const units = [
        { v: 1_000_000_000, s: "B" },
        { v: 1_000_000, s: "M" },
        { v: 1_000, s: "K" },
    ];
    for (const u of units) {
        if (abs >= u.v) {
            const x = abs / u.v;
            // Keep output stable and compact: 1 decimal unless very large.
            const digits = x >= 100 ? 0 : 1;
            return `${sign}${x.toFixed(digits)}${u.s}`;
        }
    }
    return `${Math.trunc(n)}`;
}
function normalizeSourceName(providerID) {
    const p = (providerID ?? "unknown").toLowerCase();
    if (p === "opencode" || p.includes("opencode"))
        return "OpenCode";
    if (p.includes("cursor"))
        return "Cursor";
    if (p.includes("claude") || p.includes("anthropic"))
        return "Claude";
    if (p.includes("github") || p.includes("copilot"))
        return "Copilot";
    if (p.includes("openai") || p.includes("chatgpt") || p.includes("codex"))
        return "OpenAI";
    if (p.includes("google") || p.includes("antigravity") || p.includes("gemini"))
        return "Google";
    // Common OpenCode provider ids people use
    if (p.includes("azure"))
        return "Azure";
    return providerID || "Unknown";
}
function normalizeSourceModelId(modelID) {
    return (modelID ?? "unknown").trim();
}
function middleEllipsize(text, maxWidth) {
    const safeWidth = Math.trunc(maxWidth);
    if (!Number.isFinite(safeWidth) || safeWidth <= 0)
        return "";
    if (text.length <= safeWidth)
        return text;
    if (safeWidth === 1)
        return "…";
    const keep = safeWidth - 1;
    const head = Math.ceil(keep / 2);
    const tail = Math.floor(keep / 2);
    return `${text.slice(0, head)}…${tail > 0 ? text.slice(-tail) : ""}`;
}
function formatSourceModelId(modelID, maxWidth) {
    const displayed = abbreviateDisplayedModelName(normalizeSourceModelId(modelID));
    return maxWidth ? middleEllipsize(displayed, maxWidth) : displayed;
}
function formatDiagnosticSourceModelId(modelID, maxWidth) {
    if (!maxWidth)
        return abbreviateDisplayedModelName(modelID);
    return middleEllipsize(abbreviateDisplayedModelName(normalizeSourceModelId(modelID)), maxWidth);
}
function sourceSortKey(source) {
    const s = source.toLowerCase();
    if (s === "opencode")
        return 1;
    if (s === "claude")
        return 2;
    if (s === "cursor")
        return 3;
    if (s === "copilot")
        return 4;
    if (s === "openai")
        return 5;
    if (s === "google")
        return 6;
    if (s === "azure")
        return 7;
    return 99;
}
/**
 * Truncate a title to first 10 + last 10 chars with ellipsis in the middle.
 */
function truncateTitle(title) {
    if (!title)
        return "(untitled)";
    const trimmed = title.trim();
    if (trimmed.length <= 23)
        return trimmed;
    // first 10 + ellipsis + last 10
    return trimmed.slice(0, 10) + "…" + trimmed.slice(-10);
}
export function formatQuotaStatsReport(params) {
    const topModels = params.topModels ?? 12;
    const topSessions = params.topSessions ?? 8;
    const r = params.result;
    const tableOptions = params.tableOptions ?? {};
    const reportKind = params.reportKind ?? (params.sessionOnly ? "session" : "standard");
    const sessionOnly = reportKind === "session";
    const sessionTreeMode = reportKind === "session_tree";
    const sessionTree = params.sessionTree;
    if (sessionTreeMode && !sessionTree) {
        throw new Error("formatQuotaStatsReport requires sessionTree for session_tree reports");
    }
    const combinedTokens = totalTokenBuckets(r.totals.priced) +
        totalTokenBuckets(r.totals.unknown) +
        totalTokenBuckets(r.totals.unpriced);
    const sections = [];
    // Session-scoped reports use a compact summary without the time window column.
    if (sessionOnly) {
        sections.push({
            id: "summary",
            blocks: [
                {
                    kind: "table",
                    headers: tableOptions.compactHeaders
                        ? ["消息", "token", "费用"]
                        : ["消息数", "token", "费用"],
                    aligns: ["right", "right", "right"],
                    widthMode: TABLE_WIDTH_MODE,
                    rows: [
                        [
                            fmtCompact(r.totals.messageCount),
                            fmtCompact(combinedTokens),
                            fmtUsd(r.totals.costUsd),
                        ],
                    ],
                },
            ],
        });
    }
    else if (sessionTreeMode) {
        sections.push({
            id: "summary",
            blocks: [
                {
                    kind: "table",
                    headers: tableOptions.compactHeaders
                        ? ["消息", "会话", "token", "费用"]
                        : ["消息数", "会话数", "token", "费用"],
                    aligns: ["right", "right", "right", "right"],
                    widthMode: TABLE_WIDTH_MODE,
                    rows: [
                        [
                            fmtCompact(r.totals.messageCount),
                            fmtCompact(sessionTree.nodes.length),
                            fmtCompact(combinedTokens),
                            fmtUsd(r.totals.costUsd),
                        ],
                    ],
                },
            ],
        });
    }
    else {
        sections.push({
            id: "summary",
            blocks: [
                {
                    kind: "table",
                    headers: tableOptions.compactHeaders
                        ? ["范围", "消息", "会话", "token", "费用"]
                        : ["时间范围", "消息数", "会话数", "token", "费用"],
                    aligns: ["left", "right", "right", "right", "right"],
                    widthMode: TABLE_WIDTH_MODE,
                    rows: [
                        [
                            fmtWindow(r.window),
                            fmtCompact(r.totals.messageCount),
                            fmtCompact(r.totals.sessionCount),
                            fmtCompact(combinedTokens),
                            fmtUsd(r.totals.costUsd),
                        ],
                    ],
                },
            ],
        });
    }
    const hasAnyReasoning = r.totals.priced.reasoning > 0 ||
        r.totals.unknown.reasoning > 0 ||
        r.totals.unpriced.reasoning > 0;
    const headers = tableOptions.compactHeaders
        ? ["来源", "模型", "输入", "输出", "缓存读", "缓存写"]
        : ["来源", "模型", "输入", "输出", "缓存读取", "缓存写入"];
    const aligns = ["left", "left", "right", "right", "right", "right"];
    if (hasAnyReasoning) {
        headers.push(tableOptions.compactHeaders ? "推理" : "推理 token");
        aligns.push("right");
    }
    headers.push(tableOptions.compactHeaders ? "token" : "总计", "费用");
    aligns.push("right", "right");
    const rows = [];
    const grouped = new Map();
    for (const row of r.bySourceModel) {
        const src = normalizeSourceName(row.sourceProviderID);
        const list = grouped.get(src);
        if (list)
            list.push(row);
        else
            grouped.set(src, [row]);
    }
    const sources = Array.from(grouped.keys()).sort((a, b) => {
        const ka = sourceSortKey(a);
        const kb = sourceSortKey(b);
        if (ka !== kb)
            return ka - kb;
        return a.localeCompare(b);
    });
    for (let i = 0; i < sources.length; i++) {
        const src = sources[i];
        const list = grouped.get(src);
        list.sort((a, b) => b.costUsd - a.costUsd);
        for (const row of list.slice(0, topModels)) {
            const t = row.tokens;
            const out = [
                src,
                formatSourceModelId(row.sourceModelID, tableOptions.modelNameMaxWidth),
                fmtCompact(t.input),
                fmtCompact(t.output),
                fmtCompact(t.cache_read),
                fmtCompact(t.cache_write),
            ];
            if (hasAnyReasoning)
                out.push(fmtCompact(t.reasoning));
            out.push(fmtCompact(totalTokenBuckets(t)), fmtUsd(row.costUsd));
            rows.push(out);
        }
        // blank separator row between source groups
        if (i !== sources.length - 1) {
            rows.push(new Array(headers.length).fill(""));
        }
    }
    if (rows.length > 0) {
        sections.push({
            id: "models",
            title: "模型",
            blocks: [
                {
                    kind: "table",
                    headers,
                    rows,
                    aligns,
                    widthMode: TABLE_WIDTH_MODE,
                },
            ],
        });
    }
    if (sessionTreeMode) {
        const sessionUsageByID = new Map(r.bySession.map((row) => [row.sessionID, row]));
        const sessionTreeRows = sessionTree.nodes.map((node) => {
            const usage = sessionUsageByID.get(node.sessionID);
            return [
                treeRelationLabel(node.depth),
                node.parentID ?? "-",
                node.sessionID,
                fmtUsd(usage?.costUsd ?? 0),
                fmtCompact(totalTokenBuckets(usage?.tokens ?? emptyTokenBuckets())),
                fmtCompact(usage?.messageCount ?? 0),
                truncateTitle(node.title ?? usage?.title),
            ];
        });
        sections.push({
            id: "session-tree",
            title: "Session Tree",
            blocks: [
                {
                    kind: "table",
                    headers: tableOptions.compactHeaders
                        ? ["关系", "父级", "会话", "费用", "token", "消息", "标题"]
                        : ["关系", "父级", "会话", "费用", "token", "消息数", "标题"],
                    aligns: ["left", "left", "left", "right", "right", "right", "left"],
                    widthMode: TABLE_WIDTH_MODE,
                    rows: sessionTreeRows,
                },
            ],
        });
    }
    // Skip Top Sessions for session-scoped reports (e.g., /tokens_session, /tokens_session_all).
    if (reportKind === "standard") {
        const sessionRows = [];
        const visibleSessions = r.bySession.filter(hasRenderableSessionUsage);
        const focus = params.focusSessionID
            ? visibleSessions.find((s) => s.sessionID === params.focusSessionID)
            : undefined;
        const rawFocus = params.focusSessionID
            ? r.bySession.find((s) => s.sessionID === params.focusSessionID)
            : undefined;
        if (focus) {
            appendSessionRow(sessionRows, focus, "*");
            // After showing the current session, show top sessions excluding it.
            const rest = visibleSessions.filter((s) => s.sessionID !== params.focusSessionID);
            for (const row of rest.slice(0, topSessions)) {
                appendSessionRow(sessionRows, row);
            }
        }
        else if (params.focusSessionID) {
            sessionRows.push(["*", missingFocusSessionLabel(Boolean(rawFocus)), "-", "-", "-", "-"]);
            for (const row of visibleSessions.slice(0, topSessions)) {
                appendSessionRow(sessionRows, row);
            }
        }
        else {
            // No focus session, just list top sessions.
            for (const row of visibleSessions.slice(0, topSessions)) {
                appendSessionRow(sessionRows, row);
            }
        }
        sections.push({
            id: "top-sessions",
            title: "主要会话",
            blocks: sessionRows.length > 0
                ? [
                    {
                        kind: "table",
                        headers: tableOptions.compactHeaders
                        ? ["当前", "会话", "费用", "token", "消息", "标题"]
                        : ["当前会话", "会话", "费用", "token", "消息数", "标题"],
                        aligns: ["left", "left", "right", "right", "right", "left"],
                        widthMode: TABLE_WIDTH_MODE,
                        rows: sessionRows,
                    },
                ]
                : [{ kind: "lines", lines: ["（暂无会话）"] }],
        });
    }
    if (r.unpriced.length > 0) {
        sections.push({
            id: "unpriced-models",
            title: "未定价模型",
            blocks: [
                {
                    kind: "table",
                    headers: tableOptions.compactHeaders
                        ? ["来源", "模型", "映射", "原因", "token", "消息"]
                        : ["来源", "模型", "已映射", "原因", "token", "消息数"],
                    aligns: ["left", "left", "left", "left", "right", "right"],
                    widthMode: TABLE_WIDTH_MODE,
                    rows: r.unpriced.slice(0, 20).map((u) => {
                        const mapped = `${u.key.mappedProvider}/${u.key.mappedModel}`;
                        return [
                            normalizeSourceName(u.key.sourceProviderID),
                            formatDiagnosticSourceModelId(u.key.sourceModelID, tableOptions.modelNameMaxWidth),
                            mapped,
                            u.key.reason,
                            fmtCompact(totalTokenBuckets(u.tokens)),
                            fmtCompact(u.messageCount),
                        ];
                    }),
                },
            ],
        });
    }
    if (r.unknown.length > 0) {
        sections.push({
            id: "unknown-pricing",
            title: "未知价格",
            blocks: [
                {
                    kind: "table",
                    headers: tableOptions.compactHeaders
                        ? ["来源", "模型", "映射", "token", "消息"]
                        : ["来源", "模型", "已映射", "token", "消息数"],
                    aligns: ["left", "left", "left", "right", "right"],
                    widthMode: TABLE_WIDTH_MODE,
                    rows: r.unknown.slice(0, 20).map((u) => {
                        const mappedBase = u.key.mappedProvider && u.key.mappedModel
                            ? `${u.key.mappedProvider}/${u.key.mappedModel}`
                            : "-";
                        const candidateSuffix = u.key.providerCandidates && u.key.providerCandidates.length > 0
                            ? `candidates: ${u.key.providerCandidates.join(",")}`
                            : "";
                        const mapped = candidateSuffix.length > 0
                            ? mappedBase === "-"
                                ? candidateSuffix
                                : `${mappedBase} (${candidateSuffix})`
                            : mappedBase;
                        return [
                            normalizeSourceName(u.key.sourceProviderID),
                            formatDiagnosticSourceModelId(u.key.sourceModelID, tableOptions.modelNameMaxWidth),
                            mapped,
                            fmtCompact(totalTokenBuckets(u.tokens)),
                            fmtCompact(u.messageCount),
                        ];
                    }),
                },
                {
                    kind: "lines",
                    lines: ["运行 /quota_status 查看完整的价格诊断报告。"],
                },
            ],
        });
    }
    const document = {
        heading: {
            title: params.title,
            generatedAtMs: params.generatedAtMs,
        },
        sections,
    };
    return renderMarkdownReport(document);
}
//# sourceMappingURL=quota-stats-format.js.map
