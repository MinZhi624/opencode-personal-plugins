/**
 * 设备档案：可跨本机项目复用的连接信息。
 *
 * 只保存连接所需的**非秘密**信息：地址、用户、端口、密钥文件路径与可选的
 * 远端工作目录。不保存密码、私钥内容或任何认证材料——沿用上游
 * 「仅密钥／SSH agent 认证」的既有边界。
 */
import { parseConnectionOptions, serializeConnectionOptions, validateTarget } from "../connection-options.js";
export class DeviceError extends Error {
    issue;
    constructor(issue) {
        super(issue);
        this.issue = issue;
        this.name = "DeviceError";
    }
}
function clean(value) {
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}
function cleanNumber(value) {
    if (typeof value === "number" && Number.isInteger(value))
        return value;
    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value.trim());
        if (Number.isInteger(parsed))
            return parsed;
    }
    return null;
}
/** 校验并规整用户输入；不做的只是「猜」——字段缺失一律留空。 */
export function normalizeDeviceInput(input) {
    const name = clean(input.name);
    if (!name)
        throw new DeviceError("设备名称不能为空。");
    const host = clean(input.host);
    if (!host)
        throw new DeviceError("设备地址不能为空。");
    const user = clean(input.user);
    const options = clean(input.options);
    try {
        if (host.includes("@"))
            throw new Error("设备地址不含用户名；请使用 user 字段。");
        validateTarget(user ? `${user}@${host}` : host);
        parseConnectionOptions(options);
    }
    catch (error) {
        throw new DeviceError(error instanceof Error ? error.message : String(error));
    }
    const port = input.port === undefined || input.port === null ? null : cleanNumber(input.port);
    if (input.port !== undefined && input.port !== null && port === null) {
        throw new DeviceError("端口必须是整数。");
    }
    if (port !== null && (port < 1 || port > 65535)) {
        throw new DeviceError("端口必须在 1–65535 之间。");
    }
    const normalized = {
        name,
        host,
        user,
        port,
        identityFile: clean(input.identityFile),
        options,
        remoteDirectory: clean(input.remoteDirectory),
    };
    try {
        deviceOptions(normalized);
    }
    catch (error) {
        throw new DeviceError(error instanceof Error ? error.message : String(error));
    }
    return normalized;
}
/** 组装 `ssh` 的目标参数，例如 `axiang@192.168.1.20`。 */
export function deviceTarget(device) {
    return device.user ? `${device.user}@${device.host}` : device.host;
}
/** 组装追加的 ssh 参数，例如 `-p 2222 -i ~/.ssh/id_ed25519`。 */
export function deviceOptions(device) {
    const parts = [];
    if (device.port)
        parts.push("-p", String(device.port));
    if (device.identityFile)
        parts.push("-i", device.identityFile);
    parts.push(...parseConnectionOptions(device.options));
    const result = serializeConnectionOptions(parts);
    parseConnectionOptions(result);
    return result;
}
/**
 * 尝试把一次手工连接的目标拆成档案字段：`user@host` 可分出用户，
 * `-p` 可分出端口、`-i` 可分出密钥。拆不出来的（如 SSH config 别名）留空，
 * 让用户自己补——不猜。
 */
export function profileFromTarget(host, options) {
    let user = null;
    let target = host.trim();
    const at = target.lastIndexOf("@");
    if (at > 0) {
        user = target.slice(0, at);
        target = target.slice(at + 1);
    }
    let port = null;
    let identityFile = null;
    const rest = [];
    const tokens = parseConnectionOptions(options);
    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (token === "-p" && tokens[i + 1]) {
            const parsed = Number(tokens[++i]);
            if (Number.isInteger(parsed))
                port = parsed;
        }
        else if (token.startsWith("-p") && token.length > 2) {
            const parsed = Number(token.slice(2));
            if (Number.isInteger(parsed))
                port = parsed;
        }
        else if (token === "-i" && tokens[i + 1]) {
            identityFile = tokens[++i];
        }
        else {
            rest.push(token);
        }
    }
    return {
        host: target,
        user,
        port,
        identityFile,
        options: serializeConnectionOptions(rest) ?? null,
    };
}
