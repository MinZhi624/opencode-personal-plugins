import { createHmac, randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
const RESOLVED_AUTH_IDENTITY_VERSION = "resolved-auth-identity-v1";
const RESOLVED_AUTH_KEY_DIRNAME = "opencode-quota-zh";
const RESOLVED_AUTH_KEY_FILENAME = "resolved-auth-key-v1";
const RESOLVED_AUTH_KEY_PREFIX = "v1:";
const RESOLVED_AUTH_KEY_BYTES = 32;
const RESOLVED_AUTH_IDENTITY_PREFIX = "rai1_";
const WINNER_READ_ATTEMPTS = 20;
const WINNER_READ_DELAY_MS = 5;
const resolvedAuthIdentityBrand = Symbol("ResolvedAuthIdentity");
let identityKeyPromise = null;
export function isProtectedResolvedAuthStorageSupported(params) {
    return params.platform !== "win32" && params.hasOwnerIdentity;
}
function canProtectIdentityStorage() {
    return isProtectedResolvedAuthStorageSupported({
        platform: process.platform,
        hasOwnerIdentity: typeof process.getuid === "function",
    });
}
export function getResolvedAuthIdentityKeyPath() {
    return join(getOpencodeRuntimeDirs().stateDir, RESOLVED_AUTH_KEY_DIRNAME, RESOLVED_AUTH_KEY_FILENAME);
}
function decodeIdentityKey(raw) {
    const normalized = raw.trim();
    if (!normalized.startsWith(RESOLVED_AUTH_KEY_PREFIX))
        return null;
    try {
        const key = Buffer.from(normalized.slice(RESOLVED_AUTH_KEY_PREFIX.length), "base64url");
        return key.length === RESOLVED_AUTH_KEY_BYTES ? key : null;
    }
    catch {
        return null;
    }
}
async function readProtectedIdentityKey(path) {
    try {
        if (!canProtectIdentityStorage())
            return null;
        const uid = process.getuid?.();
        if (uid === undefined)
            return null;
        let info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid)
            return null;
        if ((info.mode & 0o077) !== 0) {
            await chmod(path, 0o600);
            info = await lstat(path);
            if ((info.mode & 0o077) !== 0)
                return null;
        }
        return decodeIdentityKey(await readFile(path, "utf8"));
    }
    catch {
        return null;
    }
}
async function readPublishedIdentityKey(path) {
    for (let attempt = 0; attempt < WINNER_READ_ATTEMPTS; attempt += 1) {
        const key = await readProtectedIdentityKey(path);
        if (key)
            return key;
        if (attempt + 1 < WINNER_READ_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, WINNER_READ_DELAY_MS));
        }
    }
    return null;
}
async function protectIdentityKeyDirectory(directory) {
    if (!canProtectIdentityStorage())
        return false;
    const uid = process.getuid?.();
    if (uid === undefined)
        return false;
    let info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid)
        return false;
    if ((info.mode & 0o077) !== 0) {
        await chmod(directory, 0o700);
        info = await lstat(directory);
        if ((info.mode & 0o077) !== 0)
            return false;
    }
    return true;
}
async function writeTemporaryIdentityKey(path, key) {
    const handle = await open(path, "wx", 0o600);
    try {
        await handle.writeFile(`${RESOLVED_AUTH_KEY_PREFIX}${key.toString("base64url")}\n`, "utf8");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
async function createOrReadIdentityKey() {
    if (!canProtectIdentityStorage())
        return null;
    const path = getResolvedAuthIdentityKeyPath();
    const directory = join(getOpencodeRuntimeDirs().stateDir, RESOLVED_AUTH_KEY_DIRNAME);
    try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (!(await protectIdentityKeyDirectory(directory)))
            return null;
        const existing = await readProtectedIdentityKey(path);
        if (existing)
            return existing;
        const generated = randomBytes(RESOLVED_AUTH_KEY_BYTES);
        const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
        try {
            await writeTemporaryIdentityKey(temporaryPath, generated);
            if (!(await readProtectedIdentityKey(temporaryPath)))
                return null;
            try {
                await link(temporaryPath, path);
                return await readProtectedIdentityKey(path);
            }
            catch (error) {
                if (error?.code !== "EEXIST")
                    return null;
                return await readPublishedIdentityKey(path);
            }
        }
        finally {
            await rm(temporaryPath, { force: true }).catch(() => undefined);
        }
    }
    catch {
        return null;
    }
}
async function getIdentityKey() {
    const existing = identityKeyPromise;
    if (existing)
        return existing;
    const attempt = createOrReadIdentityKey();
    identityKeyPromise = attempt;
    try {
        const key = await attempt;
        if (!key && identityKeyPromise === attempt)
            identityKeyPromise = null;
        return key;
    }
    catch (error) {
        if (identityKeyPromise === attempt)
            identityKeyPromise = null;
        throw error;
    }
}
function identityPayload(parts) {
    return JSON.stringify([RESOLVED_AUTH_IDENTITY_VERSION, ...parts]);
}
async function keyedIdentity(parts) {
    const key = await getIdentityKey();
    if (!key)
        return null;
    return `${RESOLVED_AUTH_IDENTITY_PREFIX}${createHmac("sha256", key)
        .update(identityPayload(parts))
        .digest("base64url")}`;
}
export async function deriveResolvedAuthIdentity(params) {
    const value = params.principal.value.trim();
    if (!params.providerId || !value)
        return null;
    return keyedIdentity([
        "principal",
        params.providerId,
        params.principal.kind,
        value,
        params.qualifiers ?? [],
    ]);
}
export async function composeResolvedAuthIdentities(params) {
    if (!params.providerId || params.identities.length === 0)
        return null;
    return keyedIdentity([
        "composition",
        params.providerId,
        [...params.identities],
        params.qualifiers ?? [],
    ]);
}
export function isResolvedAuthIdentity(value) {
    return (typeof value === "string" &&
        new RegExp(`^${RESOLVED_AUTH_IDENTITY_PREFIX}[A-Za-z0-9_-]{43}$`, "u").test(value));
}
export function __resetResolvedAuthIdentityForTests() {
    identityKeyPromise = null;
}
