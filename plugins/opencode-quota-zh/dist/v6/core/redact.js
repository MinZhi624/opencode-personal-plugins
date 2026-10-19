/**
 * Credential redaction for any provider text the store keeps or sends: error details, debug
 * details and logs. Provider errors can echo a request (an Authorization header, a key in the
 * query string, a token in a JSON body), so every such text passes here before it is cut to
 * length, saved or shown. `publicDetail` also hides the home dir, email addresses and account
 * ids, for the error and debug details the store keeps. /quota_status shows only structured
 * values and passes them through `publicDetail` as a second filter.
 */
import { homedir } from "node:os";
import { sanitizeDisplayText, sanitizeSingleLineDisplayText } from "../lib/display-sanitize.js";
import { replaceHomeDirWithTilde } from "../lib/home-dir-display.js";
const REDACTED = "[redacted]";
const PRIVATE_ID = "[id]";
const EMAIL_ADDRESS = "[email]";
/** Words that make a field name secret wherever they stand in it: "session_id", "x-api-key". */
const SECRET_WORDS = new Set([
    "token",
    "key",
    "apikey",
    "secret",
    "password",
    "passwd",
    "pwd",
    "cookie",
    "cookies",
    "session",
    "sessionid",
    "authorization",
    "credential",
    "credentials",
    "signature",
    "sig",
    "jwt",
    "bearer",
]);
/** Last words of a debug key that make it a fact about a secret: "api_key_source". */
const FACT_WORDS = new Set([
    "source",
    "env",
    "present",
    "configured",
    "set",
    "kind",
    "type",
    "status",
    "expires",
    "expiry",
    "age",
    "state",
    "path",
    "paths",
    "file",
    "name",
    "count",
    "diagnostics",
]);
/** A field name's words, split on anything but letters and digits and on camelCase. */
function nameWords(name) {
    return name
        .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/u)
        .filter(Boolean);
}
/**
 * True when a word of a field name is a secret word: "access_token", "apiKey", "XSRFToken",
 * "Set-Cookie", "session_id".
 */
function namesSecret(name) {
    return nameWords(name).some((word) => SECRET_WORDS.has(word));
}
/**
 * A field value: a JSON array (a "]" inside its strings included), quoted to its closing quote
 * (escaped quotes and spaces included; also with escaped quotes around it, as in JSON inside
 * JSON), or one unquoted word.
 */
const VALUE = String.raw `(?:\[(?:"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|[^\]"'])*\]?|\\"(?:[^\\]|\\(?!"))*(?:\\")?|"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|[^\s"'&,;}]+)`;
/** Between a name and its value: `=`, `: `, JSON's `":` and escaped JSON's `\":`. */
const SEPARATOR = String.raw `(\\?["']?\s*[:=]\s*)`;
/** `name: value`, `name=value`, `"name":"value"` (also `\"name\":\"value\"`). */
const NAMED_VALUE = String.raw `\b([A-Za-z_][\w-]{0,63})${SEPARATOR}${VALUE}`;
/** The value of every pair whose name holds a secret; other values are searched as well. */
function redactNamedValues(text) {
    const pattern = new RegExp(NAMED_VALUE, "gu");
    let result = "";
    let copied = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        const [whole, name = "", separator = ""] = match;
        const valueAt = match.index + name.length + separator.length;
        if (holdsSecret(name)) {
            result += `${text.slice(copied, valueAt)}${REDACTED}`;
            copied = match.index + whole.length;
        }
        else {
            // The value may hold pairs of its own: {"error":"bad api_key=abc"}.
            pattern.lastIndex = valueAt;
        }
    }
    return result + text.slice(copied);
}
/** Checked in order, before named values; each replaces what it matches. */
const SECRET_PATTERNS = [
    // Cookie, Set-Cookie and Authorization headers: the whole value, to the end of the line or
    // the next " | " joiner. The JSON forms ("cookie": "a=1") are named values.
    [
        /\b((?:set-)?cookie|(?:proxy-)?authorization)(\s*[:=]\s*)(?:(?! \| )[^\r\n])*/giu,
        `$1$2${REDACTED}`,
    ],
    // Bearer abc, Basic abc (outside a header too)
    [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/giu, `$1 ${REDACTED}`],
];
/** Well-known key shapes and JWT-shaped strings; after named values. */
const SHAPE_PATTERNS = [
    /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/gu,
    /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/gu,
    /\bAIza[0-9A-Za-z_-]{20,}/gu,
    /\bxai-[A-Za-z0-9]{10,}/gu,
    /eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)*/gu,
];
/**
 * One part of a name or model id: a word, also capitalised, camel-cased or with a number after
 * it ("Coder", "DeepSeek", "Qwen3", "FP8"), a number, or up to 4 letters and digits ("A35B").
 */
const NAME_PART = /^(?:[a-z]{1,20}|[A-Z]{1,20}\d{0,4}|(?:[A-Z]{1,6}|[A-Z]?[a-z]{2,20}){1,3}\d{0,4}|\d{1,14}|[A-Za-z0-9]{1,4})$/u;
/**
 * A long run of letters, digits, `_` and `-` is a token or session id, unless it is words and
 * numbers joined by separators: a model id ("Qwen3-Coder-480B-A35B-Instruct-FP8") or a name
 * ("custom_production-gateway-us_check").
 */
function hideOpaqueRun(run) {
    const parts = run.split(/[-_]+/u).filter(Boolean);
    const wordsOnly = parts.length >= 2 && parts.every((part) => NAME_PART.test(part));
    return wordsOnly ? run : REDACTED;
}
/** `text` with credential-looking parts replaced by "[redacted]". */
function redactSecrets(text) {
    let result = text;
    for (const [pattern, replacement] of SECRET_PATTERNS) {
        result = result.replace(pattern, replacement);
    }
    result = redactNamedValues(result);
    for (const pattern of SHAPE_PATTERNS)
        result = result.replace(pattern, REDACTED);
    return result.replace(/[A-Za-z0-9_-]{32,}/gu, hideOpaqueRun);
}
/**
 * The text as a screen shows it, before any pattern looks at it: JSON's `\u0049` escapes
 * decoded and control characters removed (an escape inside a name or home dir would hide it
 * from the patterns). Line breaks stay.
 */
function visibleText(text) {
    const decoded = text.replace(/(?<!\\)\\u([0-9A-Fa-f]{4})/gu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    return sanitizeDisplayText(decoded);
}
/** One safe line: control characters removed, credentials redacted, then cut to `maxLength`. */
export function safeDetail(text, maxLength) {
    return redactSecrets(sanitizeSingleLineDisplayText(visibleText(text))).slice(0, maxLength);
}
/**
 * True when a debug key's value is a secret: the key names one, and its last word does not
 * name a fact about it ("api_key_source", "token_expires_at", "apiKeyEnv").
 */
function holdsSecret(key) {
    const words = nameWords(key);
    const last = words.at(-1) === "at" ? words.at(-2) : words.at(-1);
    return namesSecret(key) && !FACT_WORDS.has(last ?? "");
}
/**
 * A debug detail's value made safe: fully redacted when its key holds a secret; any other
 * value still has the secrets inside it redacted.
 */
export function safeDebugValue(key, value, maxLength) {
    return holdsSecret(key) ? REDACTED : safeDetail(value, maxLength);
}
/** Whose data a field is about: a "<word> id" field holds a private identity. */
const PRIVATE_ID_WORDS = ["account", "team", "org", "organization", "user", "session"];
/** Checked in order; each replaces what it matches. */
const PRIVATE_ID_PATTERNS = [
    // account_id=abc, "teamId": "t_1", "user_ids": ["a", "b"], \"org_id\":\"o_1\"
    [
        new RegExp(`\\b((?:[A-Za-z0-9]+[_-])*(?:${PRIVATE_ID_WORDS.join("|")})[_-]?ids?)${SEPARATOR}${VALUE}`, "giu"),
        `$1$2${PRIVATE_ID}`,
    ],
    // alice@example.com, alice%40example.com
    [/[\w.%+-]+(?:@|%40)[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/giu, EMAIL_ADDRESS],
];
/** True when a field name ends in an account, team, org, user or session id: "teamId". */
function namesPrivateId(name) {
    const words = nameWords(name);
    const last = words.at(-1) ?? "";
    if (last === "id" || last === "ids")
        return PRIVATE_ID_WORDS.includes(words.at(-2) ?? "");
    return PRIVATE_ID_WORDS.some((word) => last === `${word}id` || last === `${word}ids`);
}
/**
 * Text a public issue may show: control characters removed first, then the home dir as "~"
 * (found before spaces are joined), then one line with credentials as "[redacted]", email
 * addresses as "[email]", and account, team, org, user and session ids as "[id]". It is cut to
 * `maxLength` last, so a cut never leaves part of a hidden value.
 */
export function publicDetail(text, maxLength, homeDir = homedir()) {
    let result = sanitizeSingleLineDisplayText(replaceHomeDirWithTilde(visibleText(text), homeDir));
    for (const [pattern, replacement] of PRIVATE_ID_PATTERNS) {
        result = result.replace(pattern, replacement);
    }
    return redactSecrets(result).slice(0, maxLength);
}
/** A detail's value as `publicDetail` shows it; all hidden when its key holds a secret or an id. */
export function publicDebugValue(key, value, maxLength, homeDir = homedir()) {
    if (namesPrivateId(key))
        return PRIVATE_ID;
    if (holdsSecret(key))
        return REDACTED;
    return publicDetail(value, maxLength, homeDir);
}
