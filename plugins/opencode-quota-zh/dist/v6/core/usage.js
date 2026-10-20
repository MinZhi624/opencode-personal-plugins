/**
 * The usage report: what OpenCode's own message history used and would cost at API list
 * prices, for one range, with every number the usage view shows: totals, cost by token type,
 * cache savings, the share of tokens without a price, and breakdowns by provider, model and
 * day. Plain JSON, because it travels over the RPC.
 *
 * Rules:
 * - Messages are OpenCode's assistant messages and the compactions that recorded usage, picked
 *   by creation time. A fork starts with copies of its parent's messages; only the parent
 *   counts them, in every range (`readUsageMessagePages` leaves them out).
 * - Cost comes from the shared pricing resolver (models.dev snapshot, Cursor's own table). A
 *   model without a price adds tokens but no cost; its tokens are the unpriced share. A failed
 *   compaction names no model, so its tokens are unpriced too (provider and model "unknown").
 * - The price list is captured once, when a report starts, and has to stay that same snapshot
 *   object until the read ends. A download or a source change in between rejects the report
 *   ("价格已更新，请刷新用量") instead of answering with two price lists mixed.
 * - Sessions count conversations: a subagent session counts as part of its top parent.
 * - "session" reads the session and its subagent sessions.
 * - Ranges and days are local calendar days: "7d" is today and the 6 days before it, and
 *   "between" includes both dates. "24h" is the rolling last 24 hours. "all" has no window.
 * - Token kinds: cached input = cache reads; uncached input = input + cache writes;
 *   output = output + reasoning; processed = all three. By type, input, cache reads, cache
 *   writes and output (with reasoning) each count on their own.
 * - The history is read in pages, and the plugin's other work runs between pages. Identical
 *   questions share one read: see `usageReport`.
 * - `sessionUsageReport` answers for one session tree out of that one cached "session"
 *   report: own, tree and every session share its numbers, price snapshot and time point.
 */
import { parseCalendarDate } from "../lib/calendar-date.js";
import { getPricingSnapshotForClients, maybeRefreshPricingSnapshot, } from "../lib/modelsdev-pricing.js";
import { getOpenCodeDbPath } from "../lib/opencode-db-path.js";
import { readAllSessionsIndex, readUsageMessagePages, resolveSessionTree, } from "../lib/opencode-storage.js";
import { resolveModelPricing } from "../lib/pricing-key.js";
import { emptyTokenBuckets, tokenBucketsFromMessage, } from "../lib/token-buckets.js";
import { calculateUsdFromTokenBuckets } from "../lib/token-cost.js";
export { DEFAULT_USAGE_RANGE, parseUsageArguments, USAGE_RANGES, usageRangeLabel, } from "./usage-ranges.js";
/** How many local days the rolling ranges cover, today included. */
const RANGE_DAYS = {
    today: 1,
    "7d": 7,
    "30d": 30,
    "90d": 90,
};
const HOUR_MS = 60 * 60 * 1000;
/** Rows read in one go: one page holds the event loop for a few milliseconds. */
const PAGE_ROWS = 250;
/** How long a report answers the same question again. */
const REPORT_REUSE_MS = 30_000;
/**
 * In-process identity for snapshot objects, so a snapshot of the same generation but a
 * different object (a fresh download, a reload after a source change) still makes its own
 * report and cache entry. A WeakMap keeps retired snapshots collectable; the numbers are
 * process-local and never travel with the report.
 */
const snapshotIdentities = new WeakMap();
let nextSnapshotIdentity = 1;
function pricingSnapshotIdentity(snapshot) {
    let identity = snapshotIdentities.get(snapshot);
    if (identity === undefined) {
        identity = nextSnapshotIdentity;
        nextSnapshotIdentity += 1;
        snapshotIdentities.set(snapshot, identity);
    }
    return identity;
}
/** The price list in use right now, in one read of the shared store. */
function capturePricingSnapshot() {
    const { snapshot, selection } = getPricingSnapshotForClients();
    return {
        snapshot,
        identity: pricingSnapshotIdentity(snapshot),
        selection,
        generation: snapshot._meta.generatedAt,
    };
}
/**
 * Refuses a report whose price list changed while its history was read: the snapshot object
 * and the selection it started with have to still be in use. Throwing fails the report,
 * which `usageReport` then drops from its cache, and the caller asks again.
 */
function assertPricingUnchanged(start) {
    const now = capturePricingSnapshot();
    if (now.snapshot !== start.snapshot || now.selection !== start.selection) {
        throw new Error("价格已更新，请刷新用量");
    }
}
/**
 * The local midnight that starts a day; `day` may run past the month. Unlike
 * `new Date(year, month, day)`, it keeps years below 100 as they are.
 */
function localDayStart(year, monthIndex, day) {
    const date = new Date(2000, 0, 1);
    date.setFullYear(year, monthIndex, day);
    return date.getTime();
}
function localMidnight(ms, dayOffset) {
    const date = new Date(ms);
    return localDayStart(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset);
}
function localDate(ms) {
    const date = new Date(ms);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${String(date.getFullYear()).padStart(4, "0")}-${month}-${day}`;
}
/** The local midnight that starts `text` ("2026-01-31"). */
function parseLocalDate(text, field) {
    // The RPC checks dates with this same rule, so a date it lets through never fails here.
    const date = parseCalendarDate(text);
    if (!date)
        throw new Error(`${field} must be a date like 2026-01-31`);
    return localDayStart(date.year, date.month - 1, date.day);
}
function resolveWindow(query, nowMs) {
    if (query.range === "24h")
        return { sinceMs: nowMs - 24 * HOUR_MS, untilMs: nowMs };
    const rangeDays = RANGE_DAYS[query.range];
    if (rangeDays !== undefined) {
        return { sinceMs: localMidnight(nowMs, 1 - rangeDays), untilMs: nowMs };
    }
    if (query.range !== "between")
        return {};
    const fromMs = parseLocalDate(query.from, "from");
    const toMs = parseLocalDate(query.to, "to");
    if (toMs < fromMs)
        throw new Error(`to (${query.to}) 早于 from (${query.from})`);
    // The storage bounds are inclusive: end 1 ms before the next day starts.
    return { sinceMs: fromMs, untilMs: localMidnight(toMs, 1) - 1 };
}
function requireSessionID(query) {
    if (!query.sessionID)
        throw new Error(`范围 ${query.range} 需要 sessionID`);
    return query.sessionID;
}
/**
 * The sessions "session" reads: the session and its subagent sessions. Undefined for the other
 * ranges, which read them all.
 */
async function sessionsToRead(query) {
    if (query.range !== "session")
        return undefined;
    return resolveSessionTree(requireSessionID(query));
}
/** The session at the top of `sessionID`'s parent chain (subagents belong to their parent). */
function topSessionID(sessionID, index) {
    const seen = new Set([sessionID]);
    let current = sessionID;
    for (let parentID = index[current]?.parentID; parentID && !seen.has(parentID);) {
        seen.add(parentID);
        current = parentID;
        parentID = index[current]?.parentID;
    }
    return current;
}
function messageUse(buckets, rates) {
    const tokens = {
        cachedInput: buckets.cache_read,
        uncachedInput: buckets.input + buckets.cache_write,
        output: buckets.output + buckets.reasoning,
    };
    const processed = tokens.cachedInput + tokens.uncachedInput + tokens.output;
    const tokensByType = {
        input: buckets.input,
        cacheRead: buckets.cache_read,
        cacheWrite: buckets.cache_write,
        output: buckets.output + buckets.reasoning,
    };
    if (!rates) {
        return {
            priced: false,
            tokens: { processed, ...tokens },
            tokensByType,
            costByType: emptyByType(),
            costUsd: 0,
            cacheSavingsUsd: 0,
        };
    }
    // Each kind through the one cost formula, so its rate fallbacks apply (a missing cache rate
    // costs as input, a missing reasoning rate as output).
    const costOf = (bucket, count) => calculateUsdFromTokenBuckets(rates, { ...emptyTokenBuckets(), [bucket]: count });
    const costByType = {
        input: costOf("input", buckets.input),
        cacheRead: costOf("cache_read", buckets.cache_read),
        cacheWrite: costOf("cache_write", buckets.cache_write),
        output: costOf("output", buckets.output) + costOf("reasoning", buckets.reasoning),
    };
    return {
        priced: true,
        tokens: { processed, ...tokens },
        tokensByType,
        costByType,
        costUsd: costByType.input + costByType.cacheRead + costByType.cacheWrite + costByType.output,
        // Cache savings: the cache reads at the plain input price, minus what they cost as reads.
        cacheSavingsUsd: costOf("input", buckets.cache_read) - costByType.cacheRead,
    };
}
/** `map`'s value for `key`, created and stored first when missing. */
function entryFor(map, key, create) {
    let value = map.get(key);
    if (value === undefined) {
        value = create();
        map.set(key, value);
    }
    return value;
}
function emptyByType() {
    return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}
function addByType(sum, part) {
    for (const kind of ["input", "cacheRead", "cacheWrite", "output"]) {
        sum[kind] += part[kind];
    }
}
function emptyTally() {
    return { costUsd: 0, tokens: 0, unpricedTokens: 0 };
}
function addUse(tally, use) {
    tally.costUsd += use.costUsd;
    tally.tokens += use.tokens.processed;
    if (!use.priced)
        tally.unpricedTokens += use.tokens.processed;
}
function emptySessionTally() {
    return { usd: 0, buckets: emptyTokenBuckets(), messageCount: 0, hasUsage: false, partial: false };
}
/**
 * One message's share of its session. The buckets come straight from the message, so
 * reasoning stays its own kind; unpriced counts only when there is usage to price.
 */
function addSessionUse(tally, buckets, use) {
    tally.usd += use.costUsd;
    tally.buckets.input += buckets.input;
    tally.buckets.output += buckets.output;
    tally.buckets.reasoning += buckets.reasoning;
    tally.buckets.cache_read += buckets.cache_read;
    tally.buckets.cache_write += buckets.cache_write;
    tally.messageCount += 1;
    const hasUsage = use.tokens.processed > 0;
    if (!hasUsage)
        return;
    tally.hasUsage = true;
    if (!use.priced)
        tally.partial = true;
}
function toSessionCost(tally) {
    return {
        usd: tally.usd,
        // A report exists only once its read finished, so every session in it is complete.
        complete: true,
        hasUsage: tally.hasUsage,
        partial: tally.partial,
        tokens: {
            input: tally.buckets.input,
            output: tally.buckets.output,
            reasoning: tally.buckets.reasoning,
            cache_read: tally.buckets.cache_read,
            cache_write: tally.buckets.cache_write,
        },
        messageCount: tally.messageCount,
    };
}
function share(part, whole) {
    return whole > 0 ? part / whole : 0;
}
function toRow(tally, total) {
    return {
        costUsd: tally.costUsd,
        costShare: share(tally.costUsd, total.costUsd),
        tokens: tally.tokens,
        tokenShare: share(tally.tokens, total.tokens),
        unpricedTokens: tally.unpricedTokens,
    };
}
function byCostThenTokens(a, b) {
    return b.costUsd - a.costUsd || b.tokens - a.tokens;
}
/** Every local day from the one holding `firstMs` to the one holding `lastMs`. */
function localDays(firstMs, lastMs) {
    const days = [];
    for (let dayMs = localMidnight(firstMs, 0); dayMs <= lastMs; dayMs = localMidnight(dayMs, 1)) {
        days.push(localDate(dayMs));
    }
    return days;
}
/** Reports started in the last `REPORT_REUSE_MS`, by question (see `usageReport`). */
const recentReports = new Map();
function isRecent(recent, nowMs) {
    const ageMs = nowMs - recent.startedMs;
    return ageMs >= 0 && ageMs < REPORT_REUSE_MS;
}
/**
 * The usage report for `query` at `nowMs`. Identical questions (same database, price
 * snapshot identity and selection, local day and query) share one read of the history: a
 * request made while the same report is being built waits for it, and a finished report
 * answers again for 30 s, except session reports, which only share in-flight reads so
 * step-completion refreshes can see newly persisted usage immediately. A failed report is not
 * kept, and a report whose price snapshot changed while the history was read fails with
 * "价格已更新，请刷新用量" instead of answering with two price lists mixed.
 */
export async function usageReport(query, nowMs = Date.now()) {
    for (const [key, recent] of recentReports) {
        if (!isRecent(recent, nowMs))
            recentReports.delete(key);
    }
    const { range, sessionID, from, to } = query;
    // The price list in use, captured here in one read: its identity and selection key the
    // cache below, and `buildUsageReport` holds the same object reference for its guard. A
    // new price list (another choice or a fresh download) is a new snapshot object, so it
    // makes a new report even at the same generation. Capturing it does not by itself freeze
    // the rates `resolveModelPricing` reads from the store; only the reference check at the
    // end of the read keeps one report on one price list.
    const pricing = capturePricingSnapshot();
    // The local day decides where the rolling ranges start: after midnight, a new report.
    const today = localDate(nowMs);
    const key = JSON.stringify([
        getOpenCodeDbPath(),
        [pricing.selection, pricing.identity],
        today,
        range,
        sessionID,
        from,
        to,
    ]);
    const recent = recentReports.get(key);
    if (recent)
        return recent.report;
    const report = buildUsageReport(query, nowMs, pricing);
    recentReports.set(key, { startedMs: nowMs, report });
    const forget = () => {
        if (recentReports.get(key)?.report === report)
            recentReports.delete(key);
    };
    // Session readers refresh on execution events. Reusing a completed report here
    // would turn those refreshes into stale reads (including a cached hasUsage=false).
    report.then(range === "session" ? forget : undefined, forget);
    return report;
}
/**
 * The session tree usage for `sessionID`, read out of the one cached "session" report: own,
 * tree and every session are that report's own numbers, price snapshot and time point, never
 * a second read or a second pricing. A report that fails throws, so a broken read cannot
 * pass for a complete zero.
 */
export async function sessionUsageReport(sessionID) {
    const report = await usageReport({ range: "session", sessionID });
    return {
        sessionID,
        sessionIDs: Object.keys(report.bySession),
        generatedAtMs: report.generatedAtMs,
        pricingGeneration: report.pricingGeneration,
        pricingSelection: report.pricingSelection,
        own: report.bySession[sessionID],
        tree: report.tree,
        bySession: report.bySession,
    };
}
async function buildUsageReport(query, nowMs, pricing) {
    const window = resolveWindow(query, nowMs);
    const sessionsIndex = await readAllSessionsIndex();
    const sessionIDs = await sessionsToRead(query);
    const totalTokens = { processed: 0, cachedInput: 0, uncachedInput: 0, output: 0 };
    const tokensByType = emptyByType();
    const costByType = emptyByType();
    const total = emptyTally();
    let cacheSavingsUsd = 0;
    const sessions = new Set();
    const topSessionIDs = new Map();
    const pricingByModel = new Map();
    const providers = new Map();
    const models = new Map();
    const days = new Map();
    const sessionTallies = new Map();
    const treeTally = emptySessionTally();
    let firstMs = Number.POSITIVE_INFINITY;
    let lastMs = Number.NEGATIVE_INFINITY;
    const pages = readUsageMessagePages({ ...window, sessionIDs, pageSize: PAGE_ROWS });
    for await (const page of pages) {
        for (const message of page) {
            // Storage always sets the creation time; it is what places a message on a day.
            const createdMs = message.time?.created;
            if (typeof createdMs !== "number")
                continue;
            const providerID = message.providerID ?? "unknown";
            const modelID = message.modelID ?? "unknown";
            const modelKey = `${providerID}\n${modelID}`;
            const modelPricing = entryFor(pricingByModel, modelKey, () => resolveModelPricing({ providerID: message.providerID, modelID: message.modelID }));
            const buckets = tokenBucketsFromMessage(message);
            const use = messageUse(buckets, modelPricing.kind === "priced" ? modelPricing.rates : null);
            const topSession = entryFor(topSessionIDs, message.sessionID, () => topSessionID(message.sessionID, sessionsIndex));
            const date = localDate(createdMs);
            addUse(total, use);
            for (const kind of ["processed", "cachedInput", "uncachedInput", "output"]) {
                totalTokens[kind] += use.tokens[kind];
            }
            addByType(tokensByType, use.tokensByType);
            addByType(costByType, use.costByType);
            cacheSavingsUsd += use.cacheSavingsUsd;
            sessions.add(topSession);
            // The same pass tallies every session: one read, one pricing, one set of numbers.
            addSessionUse(entryFor(sessionTallies, message.sessionID, emptySessionTally), buckets, use);
            addSessionUse(treeTally, buckets, use);
            const provider = entryFor(providers, providerID, () => ({
                tally: emptyTally(),
                sessions: new Set(),
            }));
            addUse(provider.tally, use);
            provider.sessions.add(topSession);
            const model = entryFor(models, modelKey, () => ({
                providerID,
                modelID,
                priced: use.priced,
                tally: emptyTally(),
                costByType: emptyByType(),
                tokensByType: emptyByType(),
                days: new Map(),
            }));
            addUse(model.tally, use);
            addByType(model.costByType, use.costByType);
            addByType(model.tokensByType, use.tokensByType);
            const modelDay = entryFor(model.days, date, () => ({ costUsd: 0, tokens: 0 }));
            modelDay.costUsd += use.costUsd;
            modelDay.tokens += use.tokens.processed;
            addUse(entryFor(days, date, emptyTally), use);
            firstMs = Math.min(firstMs, createdMs);
            lastMs = Math.max(lastMs, createdMs);
        }
        // Let the plugin's other work run before the next page: a long history must not stall it.
        await new Promise((resolve) => setImmediate(resolve));
    }
    // The read is over: the report may only answer while the price list it started with is
    // still the one in use. A download or a source change during the pages above priced some
    // models from the old snapshot and some from the new one; those mixed numbers are dropped
    // here rather than returned as if one price list had costed them all.
    assertPricingUnchanged(pricing);
    // "session" lists its whole tree, zero usage included, in the order the tree was resolved;
    // the other ranges list the sessions that used something, in the order the read met them.
    const bySession = {};
    if (sessionIDs) {
        for (const sessionID of sessionIDs) {
            bySession[sessionID] = toSessionCost(sessionTallies.get(sessionID) ?? emptySessionTally());
        }
    }
    else {
        for (const [sessionID, tally] of sessionTallies) {
            bySession[sessionID] = toSessionCost(tally);
        }
    }
    // The tree's money is the engine total itself, the number `totals` shows below; its token
    // counts are exact, and the per-session amounts add up to that total up to addition order.
    const tree = { ...toSessionCost(treeTally), usd: total.costUsd };
    const rowTotal = { costUsd: total.costUsd, tokens: total.tokens };
    // A time window lists all its days; the other ranges the days from first to last message.
    const dayFirstMs = window.sinceMs ?? firstMs;
    const dayLastMs = window.untilMs ?? lastMs;
    const dayList = dayFirstMs <= dayLastMs ? localDays(dayFirstMs, dayLastMs) : [];
    return {
        range: query.range,
        ...(window.sinceMs === undefined ? {} : { sinceMs: window.sinceMs }),
        ...(window.untilMs === undefined ? {} : { untilMs: window.untilMs }),
        ...(query.range === "session" ? { sessionID: requireSessionID(query) } : {}),
        generatedAtMs: nowMs,
        pricingGeneration: pricing.generation,
        pricingSelection: pricing.selection,
        totals: {
            costUsd: total.costUsd,
            sessions: sessions.size,
            tokens: totalTokens,
            tokensByType,
            costByType,
            cacheSavingsUsd,
            unpricedTokens: total.unpricedTokens,
            unpricedShare: share(total.unpricedTokens, total.tokens),
        },
        providers: [...providers]
            .map(([providerID, provider]) => ({
            providerID,
            sessions: provider.sessions.size,
            ...toRow(provider.tally, rowTotal),
        }))
            .sort((a, b) => byCostThenTokens(a, b) || a.providerID.localeCompare(b.providerID)),
        models: [...models.values()]
            .map((model) => ({
            providerID: model.providerID,
            modelID: model.modelID,
            priced: model.priced,
            ...toRow(model.tally, rowTotal),
            costByType: model.costByType,
            tokensByType: model.tokensByType,
            days: [...model.days]
                .map(([date, day]) => ({ date, ...day }))
                .sort((a, b) => a.date.localeCompare(b.date)),
        }))
            .sort((a, b) => byCostThenTokens(a, b) ||
            a.providerID.localeCompare(b.providerID) ||
            a.modelID.localeCompare(b.modelID)),
        days: dayList.map((date) => ({ date, ...toRow(days.get(date) ?? emptyTally(), rowTotal) })),
        bySession,
        tree,
    };
}
/**
 * Downloads the price list from models.dev now, whatever its age. With the settings on the
 * built-in price list, the download is kept but reports keep using the built-in one.
 */
export async function downloadPrices(source) {
    const result = await maybeRefreshPricingSnapshot({
        reason: "manual",
        force: true,
        snapshotSelection: source,
        allowRefreshWhenSelectionBundled: true,
    });
    if (!result.updated) {
        const reason = result.error ?? result.reason ?? "未知原因";
        return { ok: false, message: `无法下载新价格：${reason}。` };
    }
    if (source === "bundled") {
        return {
            ok: true,
            message: "已下载新价格。用量统计仍使用内置价格：价格来源设置为 bundled。",
        };
    }
    return { ok: true, message: "已从 models.dev 下载新价格。" };
}
