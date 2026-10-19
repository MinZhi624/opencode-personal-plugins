const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
export function daysInMonth(year, month) {
    if (month === 2) {
        const leapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
        return leapYear ? 29 : 28;
    }
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
/** The day `text` names, or null when it is not a real "YYYY-MM-DD" day. */
export function parseCalendarDate(text) {
    if (typeof text !== "string")
        return null;
    const match = DATE_PATTERN.exec(text);
    if (!match)
        return null;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month))
        return null;
    return { year, month, day };
}
