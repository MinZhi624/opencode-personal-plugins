/** Small guards for reading untyped JSON (API replies, config files, stored logins). */
/** A non-null object that is not an array. */
export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function asRecord(value) {
    return isRecord(value) ? value : null;
}
/** The trimmed string, or undefined when it is not a string or only whitespace. */
export function nonEmptyString(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
}
/** The number, or undefined when it is not a finite number (strings are not parsed). */
export function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
/** True when every key of `value` is one of `allowed`. */
export function hasOnlyKeys(value, allowed) {
    const allowedSet = new Set(allowed);
    return Object.keys(value).every((key) => allowedSet.has(key));
}
