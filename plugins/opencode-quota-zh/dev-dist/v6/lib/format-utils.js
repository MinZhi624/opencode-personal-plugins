/** Small text helpers for the providers: percents and dollar amounts. */
/**
 * Clamp a value to a percentage [0..100], rounding to the nearest integer.
 * Returns 0 for non-finite inputs.
 */
export function clampPercent(n) {
    if (!Number.isFinite(n))
        return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
}
/** A dollar amount with two decimals ("$12.50"); "$0.00" for a non-finite number. */
export function fmtUsdAmount(n) {
    if (!Number.isFinite(n))
        return "$0.00";
    return `$${n.toFixed(2)}`;
}
