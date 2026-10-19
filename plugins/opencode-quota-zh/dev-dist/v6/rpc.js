import { parseCalendarDate } from "./lib/calendar-date.js";
import { isRecord } from "./lib/json-guards.js";
export const QUOTA_RPC_ID = "slkiser.opencode-quota";
/**
 * A Standard Schema that runs `check` and passes the value through unchanged. OpenCode
 * validates every input and output with it. `types` only carries T for TypeScript.
 */
function schema(check) {
    return {
        "~standard": {
            version: 1,
            vendor: "opencode-quota",
            validate: (value) => {
                const issue = check(value);
                return issue ? { issues: [{ message: issue }] } : { value: value };
            },
        },
    };
}
/** The same for event data, which OpenCode requires to be an object. */
function eventSchema(check) {
    return {
        "~standard": {
            version: 1,
            vendor: "opencode-quota",
            validate: (value) => {
                const issue = check(value);
                return issue ? { issues: [{ message: issue }] } : { value: value };
            },
        },
    };
}
/** An input with no fields of its own. */
function checkObjectInput(value) {
    return isRecord(value) ? null : "input must be an object";
}
/** An input whose only field is an optional session id. */
function checkSessionInput(value) {
    return isRecord(value) ? checkOptionalString(value, "sessionID") : "input must be an object";
}
function checkOptionalString(input, field) {
    return input[field] === undefined || typeof input[field] === "string"
        ? null
        : `${field} must be a string`;
}
function checkOptionalStringList(input, field) {
    const value = input[field];
    return value === undefined ||
        (Array.isArray(value) && value.every((item) => typeof item === "string"))
        ? null
        : `${field} must be a list of strings`;
}
function checkSnapshotOutput(value) {
    return isRecord(value) && isRecord(value.snapshot) ? null : "output must carry a snapshot";
}
const REFRESH_REASONS = ["poll", "turn", "manual"];
/** What each usage range needs besides itself. */
const USAGE_RANGE_NEEDS = {
    today: "nothing",
    "24h": "nothing",
    "7d": "nothing",
    "30d": "nothing",
    "90d": "nothing",
    all: "nothing",
    session: "sessionID",
    between: "dates",
};
function checkUsageInput(value) {
    if (!isRecord(value))
        return "input must be an object";
    const range = value.range;
    if (typeof range !== "string" || !Object.hasOwn(USAGE_RANGE_NEEDS, range)) {
        return `range must be one of ${Object.keys(USAGE_RANGE_NEEDS).join(", ")}`;
    }
    const typeIssue = checkOptionalString(value, "sessionID") ??
        checkOptionalString(value, "from") ??
        checkOptionalString(value, "to");
    if (typeIssue)
        return typeIssue;
    const needs = USAGE_RANGE_NEEDS[range];
    if (needs === "sessionID" && !value.sessionID)
        return `sessionID is required for range ${range}`;
    if (needs !== "dates")
        return null;
    for (const field of ["from", "to"]) {
        if (!parseCalendarDate(value[field]))
            return `${field} must be a date like 2026-01-31`;
    }
    return value.from > value.to ? "to must not be before from" : null;
}
export const QuotaRpc = {
    id: QUOTA_RPC_ID,
    events: {
        changed: { schema: eventSchema(checkSnapshotOutput) },
    },
    methods: {
        snapshot: {
            input: schema(checkSessionInput),
            output: schema(checkSnapshotOutput),
        },
        refresh: {
            input: schema((value) => {
                if (!isRecord(value))
                    return "input must be an object";
                if (!REFRESH_REASONS.includes(value.reason)) {
                    return `reason must be one of ${REFRESH_REASONS.join(", ")}`;
                }
                return (checkOptionalStringList(value, "providerIds") ?? checkOptionalString(value, "sessionID"));
            }),
            output: schema(checkSnapshotOutput),
        },
        notices: {
            input: schema(checkObjectInput),
            output: schema((value) => isRecord(value) && typeof value.homeLine === "string"
                ? null
                : "output must carry a homeLine string"),
        },
        noticeList: {
            input: schema(checkObjectInput),
            output: schema((value) => isRecord(value) && Array.isArray(value.notices) ? null : "output must carry notices"),
        },
        status: {
            input: schema(checkSessionInput),
            output: schema((value) => isRecord(value) && typeof value.text === "string" ? null : "output must carry a text"),
        },
        usage: {
            input: schema(checkUsageInput),
            output: schema((value) => isRecord(value) && isRecord(value.report) ? null : "output must carry a report"),
        },
        downloadPrices: {
            input: schema(checkObjectInput),
            output: schema((value) => isRecord(value) && typeof value.ok === "boolean" && typeof value.message === "string"
                ? null
                : "output must carry ok and a message"),
        },
        settings: {
            input: schema(checkObjectInput),
            output: schema((value) => isRecord(value) &&
                isRecord(value.values) &&
                Array.isArray(value.providers) &&
                Array.isArray(value.custom)
                ? null
                : "output must carry values, providers and custom"),
        },
        saveSettings: {
            input: schema((value) => {
                if (!isRecord(value) || !isRecord(value.patch))
                    return "input must carry a patch object";
                const switches = value.customEnabled;
                if (switches === undefined)
                    return null;
                return isRecord(switches) &&
                    Object.values(switches).every((item) => isRecord(item) &&
                        typeof item.enabled === "boolean" &&
                        typeof item.fingerprint === "string")
                    ? null
                    : "customEnabled must map provider ids to { enabled, fingerprint }";
            }),
            output: schema((value) => isRecord(value) && typeof value.ok === "boolean" && Array.isArray(value.issues)
                ? null
                : "output must carry ok and issues"),
        },
    },
};
