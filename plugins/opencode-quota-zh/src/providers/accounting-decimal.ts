export function accountingDecimalFromNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError("Accounting quantity value must be finite");
  }
  if (Object.is(value, -0)) return "0";

  const raw = String(Number(value.toPrecision(16)));
  if (!/[eE]/u.test(raw)) return raw;

  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/u.exec(raw);
  if (!match) throw new TypeError("Accounting quantity value must be decimal-compatible");
  const [, sign, integer, fraction = "", exponentRaw] = match;
  const digits = `${integer}${fraction}`;
  const decimalIndex = integer.length + Number(exponentRaw);
  if (decimalIndex <= 0) return `${sign}0.${"0".repeat(-decimalIndex)}${digits}`;
  if (decimalIndex >= digits.length) {
    return `${sign}${digits}${"0".repeat(decimalIndex - digits.length)}`;
  }
  return `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}
