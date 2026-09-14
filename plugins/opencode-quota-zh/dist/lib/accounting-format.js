import { isBooleanEntry, isPercentEntry, isQuantityEntry, isValueEntry } from "./entries.js";
const CANONICAL_DECIMAL_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const RESULT_TYPE_LABELS = {
    quota: "额度",
    rate_limit: "速率限制",
    usage: "用量",
    spend: "花费",
    budget: "预算",
    balance: "余额",
    status: "状态",
};
const RESULT_TYPE_ORDER = {
    quota: 0,
    rate_limit: 1,
    budget: 2,
    usage: 3,
    spend: 4,
    balance: 5,
    status: 6,
};
const WINDOW_LABELS = {
    rpm: "RPM",
    hour: "每小时",
    five_hour: "5 小时",
    day: "每日",
    week: "每周",
    month: "每月",
    year: "每年",
    mcp: "MCP",
    code_review: "代码审查",
};
const WINDOW_ORDER = {
    rpm: 0,
    hour: 1,
    five_hour: 2,
    day: 3,
    week: 4,
    month: 5,
    year: 6,
    mcp: 7,
    code_review: 8,
};
const COMPONENT_LABELS = {
    current_balance: "当前余额",
    total_balance: "总余额",
    cash_balance: "现金余额",
    gift_balance: "赠送余额",
    granted_balance: "授予余额",
    topped_up_balance: "充值余额",
    remaining_credits: "剩余积分",
    auto_reload: "自动充值",
    auto_reload_amount: "自动充值金额",
    auto_reload_trigger: "自动充值阈值",
};
const COMPONENT_ORDER = {
    current_balance: 0,
    remaining_credits: 0,
    total_balance: 1,
    cash_balance: 2,
    gift_balance: 3,
    granted_balance: 4,
    topped_up_balance: 5,
    auto_reload: 6,
    auto_reload_amount: 7,
    auto_reload_trigger: 8,
};
const COUNT_LABELS = {
    request: ["次请求", "次请求"],
    token: [" Token", " Token"],
    credit: ["积分", "积分"],
    message: ["条消息", "条消息"],
    interaction: ["次交互", "次交互"],
    unit: ["单位", "单位"],
};
export function isCanonicalAccountingDecimal(value) {
    if (!CANONICAL_DECIMAL_RE.test(value))
        return false;
    if (!value.startsWith("-"))
        return true;
    return !/^0(?:\.0+)?$/u.test(value.slice(1));
}
function splitDecimal(decimal) {
    const negative = decimal.startsWith("-");
    const unsigned = negative ? decimal.slice(1) : decimal;
    const [integer = "0", fraction = ""] = unsigned.split(".", 2);
    return { negative, integer, fraction };
}
function groupInteger(integer) {
    return integer.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}
function isBelowOneCent(integer, fraction) {
    return (integer === "0" &&
        fraction.length > 0 &&
        !/^0+$/u.test(fraction) &&
        fraction.padEnd(2, "0").slice(0, 2) === "00");
}
function incrementIntegerString(integer) {
    return (BigInt(integer) + 1n).toString();
}
function formatCurrencyAmount(decimal) {
    const { negative, integer, fraction } = splitDecimal(decimal);
    if (isBelowOneCent(integer, fraction)) {
        if (!negative)
            return "<0.01";
        return `-${integer}.${fraction}`;
    }
    const padded = `${fraction}000`;
    let cents = Number(padded.slice(0, 2));
    let roundedInteger = integer;
    if (Number(padded[2]) >= 5)
        cents += 1;
    if (cents === 100) {
        roundedInteger = incrementIntegerString(integer);
        cents = 0;
    }
    return `${negative ? "-" : ""}${groupInteger(roundedInteger)}.${String(cents).padStart(2, "0")}`;
}
function formatExactAmount(decimal) {
    const { negative, integer, fraction } = splitDecimal(decimal);
    return `${negative ? "-" : ""}${groupInteger(integer)}${fraction ? `.${fraction}` : ""}`;
}
export function accountingUnitsEqual(left, right) {
    if (left.kind !== right.kind)
        return false;
    if (left.kind === "currency" && right.kind === "currency")
        return left.code === right.code;
    if (left.kind === "count" && right.kind === "count")
        return left.unit === right.unit;
    if (left.kind === "custom" && right.kind === "custom")
        return left.symbol === right.symbol;
    return false;
}
export function formatAccountingQuantity(quantity) {
    if (!isCanonicalAccountingDecimal(quantity.decimal)) {
        throw new TypeError("Accounting quantity decimal must be canonical");
    }
    if (quantity.unit.kind === "currency") {
        return `${quantity.unit.code} ${formatCurrencyAmount(quantity.decimal)}`;
    }
    const amount = formatExactAmount(quantity.decimal);
    if (quantity.unit.kind === "custom")
        return `${amount} ${quantity.unit.symbol}`;
    const labels = COUNT_LABELS[quantity.unit.unit];
    const singular = /^1(?:\.0+)?$/u.test(quantity.decimal);
    return `${amount} ${singular ? labels[0] : labels[1]}`;
}
export function formatAccountingBoolean(value, semantic) {
    if (semantic?.metric.kind === "named" && semantic.metric.name === "Availability") {
        return value ? "Available" : "Low balance";
    }
    return value ? "Enabled" : "Disabled";
}
export function formatAccountingBasisSummary(basis, mode) {
    if (mode === "remaining" && basis.remaining) {
        return `Remaining: ${formatAccountingQuantity(basis.remaining.quantity)}`;
    }
    if (mode === "used" && basis.used) {
        return `Used: ${formatAccountingQuantity(basis.used.quantity)}`;
    }
    if (basis.used && basis.limit) {
        return `Used: ${formatAccountingQuantity(basis.used.quantity)} / Limit: ${formatAccountingQuantity(basis.limit.quantity)}`;
    }
    return null;
}
function buildAccountingBasisFacts(basis) {
    const facts = [];
    if (basis.used) {
        facts.push({ role: "used", text: `Used: ${formatAccountingQuantity(basis.used.quantity)}` });
    }
    if (basis.limit) {
        facts.push({ role: "limit", text: `Limit: ${formatAccountingQuantity(basis.limit.quantity)}` });
    }
    if (basis.remaining) {
        facts.push({
            role: "remaining",
            text: `Remaining: ${formatAccountingQuantity(basis.remaining.quantity)}`,
        });
    }
    return facts;
}
export function formatAccountingBasisDetails(basis) {
    return buildAccountingBasisFacts(basis).map((fact) => fact.text);
}
export function formatAccountingResultTypeLabel(resultType) {
    return RESULT_TYPE_LABELS[resultType];
}
export function formatAccountingWindowLabel(window) {
    return WINDOW_LABELS[window];
}
export function formatAccountingComponentLabel(component) {
    return COMPONENT_LABELS[component];
}
export function formatAccountingSemanticLabel(resultType, semantic, entryKind) {
    const resultLabel = RESULT_TYPE_LABELS[resultType];
    const metric = semantic.metric;
    if (metric.kind === "aggregate")
        return resultLabel;
    if (metric.kind === "window") {
        return `${WINDOW_LABELS[metric.window]} ${resultLabel.toLowerCase()}`;
    }
    if (metric.kind === "component") {
        if (metric.component === "remaining_credits" && entryKind === "percent")
            return "Credits";
        return COMPONENT_LABELS[metric.component];
    }
    if (resultType === "status")
        return metric.name;
    return `${metric.name} ${resultLabel.toLowerCase()}`;
}
export function getAccountingSemanticSortKey(entry) {
    const semantic = entry.semantic;
    if (!semantic)
        return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0];
    const resultRank = RESULT_TYPE_ORDER[entry.accounting.resultType];
    const metric = semantic.metric;
    if (metric.kind === "aggregate")
        return [resultRank, 0, 0];
    if (metric.kind === "window")
        return [resultRank, 1, WINDOW_ORDER[metric.window]];
    if (metric.kind === "component")
        return [resultRank, 2, COMPONENT_ORDER[metric.component]];
    return [resultRank, 3, 0];
}
export function compareAccountingSemanticEntries(left, right) {
    const leftKey = getAccountingSemanticSortKey(left);
    const rightKey = getAccountingSemanticSortKey(right);
    return leftKey[0] - rightKey[0] || leftKey[1] - rightKey[1] || leftKey[2] - rightKey[2];
}
export function getAccountingEntryLabel(entry) {
    if (!entry.semantic)
        return entry.metricLabel?.trim() || entry.label?.trim() || entry.name;
    return formatAccountingSemanticLabel(entry.accounting.resultType, entry.semantic, isPercentEntry(entry) ? "percent" : entry.kind);
}
export function interpretAccountingRow(entry, options) {
    const label = getAccountingEntryLabel(entry);
    let display;
    if (isPercentEntry(entry)) {
        display = { kind: "percent", percentRemaining: entry.percentRemaining };
    }
    else if (isValueEntry(entry)) {
        display = { kind: "value", entryKind: "value", text: entry.value };
    }
    else if (isQuantityEntry(entry)) {
        display = {
            kind: "value",
            entryKind: "quantity",
            text: formatAccountingQuantity(entry.quantity),
        };
    }
    else if (isBooleanEntry(entry)) {
        display = {
            kind: "value",
            entryKind: "boolean",
            text: formatAccountingBoolean(entry.value, options.booleanWording === "semantic" ? entry.semantic : undefined),
        };
    }
    else {
        return entry;
    }
    if (!isPercentEntry(entry) || !entry.basis || !options.basis) {
        return { label, display };
    }
    const basis = options.basis.kind === "summary"
        ? {
            kind: "summary",
            text: formatAccountingBasisSummary(entry.basis, options.basis.mode),
        }
        : { kind: "detailed", facts: buildAccountingBasisFacts(entry.basis) };
    return { label, display, basis };
}
