export function shellQuote(value) {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}
