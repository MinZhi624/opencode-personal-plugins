import { realpathSync } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { writeTextAtomic } from "./atomic-json.js";
export const MAX_CONFIG_SYMLINK_HOPS = 40;
export const NEW_CONFIG_FILE_MODE = 0o600;
export const NEW_CONFIG_DIRECTORY_MODE = 0o700;
export class ConfigWriteTargetError extends Error {
    path;
    reason;
    constructor(message, path, reason) {
        super(message);
        this.path = path;
        this.reason = reason;
        this.name = "ConfigWriteTargetError";
    }
}
function fsCode(error) {
    if (error && typeof error === "object" && "code" in error) {
        return String(error.code);
    }
    return "";
}
function isNotFound(error) {
    return fsCode(error) === "ENOENT";
}
function isPermission(error) {
    const code = fsCode(error);
    return code === "EACCES" || code === "EPERM";
}
function throwFsError(error, path) {
    if (isPermission(error) || fsCode(error) === "ELOOP") {
        throw new ConfigWriteTargetError(fsCode(error) === "ELOOP"
            ? `配置文件的符号链接成环：${path}`
            : `无法检查配置文件路径：${path}`, path, fsCode(error) === "ELOOP" ? "loop" : "permission");
    }
    throw error;
}
export function configWriteTargetsEqual(left, right) {
    return (left.configuredPath === right.configuredPath &&
        left.writePath === right.writePath &&
        left.terminalExisted === right.terminalExisted &&
        left.hops.length === right.hops.length &&
        left.hops.every((hop, index) => {
            const other = right.hops[index];
            return other !== undefined && hop.path === other.path && hop.linkText === other.linkText;
        }));
}
export function assertSameConfigWriteTarget(planned, current) {
    if (configWriteTargetsEqual(planned, current)) {
        return;
    }
    throw new ConfigWriteTargetError(`预览之后配置写入目标发生了变化：${planned.configuredPath}`, planned.configuredPath, "changed");
}
export async function resolveConfigWriteTarget(path) {
    const configuredPath = resolve(path);
    const hops = [];
    const seen = new Set();
    let current = configuredPath;
    for (;;) {
        let stats;
        try {
            stats = await lstat(current);
        }
        catch (error) {
            if (isNotFound(error)) {
                if (hops.length === 0) {
                    return { configuredPath, writePath: current, hops, terminalExisted: false };
                }
                throw new ConfigWriteTargetError(`配置文件的符号链接悬空：${configuredPath}`, current, "dangling");
            }
            throwFsError(error, current);
        }
        if (stats.isSymbolicLink()) {
            if (seen.has(current)) {
                throw new ConfigWriteTargetError(`配置文件的符号链接成环：${configuredPath}`, current, "loop");
            }
            if (hops.length >= MAX_CONFIG_SYMLINK_HOPS) {
                throw new ConfigWriteTargetError(`配置文件的符号链接链超过 ${MAX_CONFIG_SYMLINK_HOPS} 跳：${configuredPath}`, current, "depth");
            }
            seen.add(current);
            let linkText;
            try {
                linkText = await readlink(current);
            }
            catch (error) {
                throwFsError(error, current);
            }
            hops.push({ path: current, linkText });
            let parentReal;
            try {
                parentReal = realpathSync(dirname(current));
            }
            catch (error) {
                throwFsError(error, current);
            }
            current = resolve(parentReal, linkText);
            continue;
        }
        if (!stats.isFile()) {
            throw new ConfigWriteTargetError(`配置写入目标不是普通文件：${current}`, current, "non-regular");
        }
        let writePath;
        try {
            writePath = realpathSync(current);
        }
        catch (error) {
            throwFsError(error, current);
        }
        return { configuredPath, writePath, hops, terminalExisted: true };
    }
}
async function existingFileMode(path) {
    try {
        const stats = await lstat(path);
        if (!stats.isFile()) {
            throw new ConfigWriteTargetError(`配置写入目标不是普通文件：${path}`, path, "non-regular");
        }
        return stats.mode & 0o777;
    }
    catch (error) {
        if (error instanceof ConfigWriteTargetError) {
            throw error;
        }
        if (isNotFound(error)) {
            throw new ConfigWriteTargetError(`预览之后配置写入目标发生了变化：${path}`, path, "changed");
        }
        throwFsError(error, path);
    }
}
async function configurationWriteOptions(snapshot) {
    const fileMode = snapshot.terminalExisted
        ? await existingFileMode(snapshot.writePath)
        : NEW_CONFIG_FILE_MODE;
    return {
        policy: "configuration",
        directoryMode: NEW_CONFIG_DIRECTORY_MODE,
        fileMode,
    };
}
export async function writeResolvedConfigText(snapshot, content, beforeCommit) {
    const options = await configurationWriteOptions(snapshot);
    await writeTextAtomic(snapshot.writePath, content, { ...options, beforeCommit });
}
