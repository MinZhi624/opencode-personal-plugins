/**
 * Alibaba Personal Token Plan quota from the official `bl` CLI.
 *
 * Production invocation is exactly:
 *   bl usage token-plan --output json
 *
 * Console authentication belongs to the CLI. This module never installs `bl`,
 * never runs login, never reads credential stores, and never uses a shell.
 * Only darwin and linux are supported, so all paths use POSIX semantics.
 */
import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { REQUEST_TIMEOUT_MS } from "./http.js";
import { asRecord } from "./json-guards.js";
const ALIBABA_TOKEN_PLAN_COMMAND = "bl";
const ALIBABA_TOKEN_PLAN_ARGS = ["usage", "token-plan", "--output", "json"];
const ALIBABA_TOKEN_PLAN_STDOUT_LIMIT_BYTES = 256 * 1024;
const ALIBABA_TOKEN_PLAN_STDERR_LIMIT_BYTES = 16 * 1024;
const ALIBABA_TOKEN_PLAN_KILL_GRACE_MS = 250;
const AUTH_EXIT_CODE = 3;
const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);
const MAX_RESET_TIME_MS = 4_102_444_800_000;
/** `bl.cmd` and `bl.bat` are probed only so a found launcher reports "shell launcher rejected". */
const EXECUTABLE_NAMES = [ALIBABA_TOKEN_PLAN_COMMAND, "bl.cmd", "bl.bat"];
const SHELL_LAUNCHER_NAMES = new Set([
    "bash",
    "bash.exe",
    "cmd",
    "cmd.exe",
    "command.com",
    "cscript.exe",
    "csh",
    "dash",
    "fish",
    "ksh",
    "powershell",
    "powershell.exe",
    "pwsh",
    "pwsh.exe",
    "sh",
    "sh.exe",
    "tcsh",
    "wscript.exe",
    "zsh",
]);
const SHELL_LAUNCHER_EXTENSIONS = new Set([
    ".bash",
    ".bat",
    ".cmd",
    ".com",
    ".fish",
    ".ps1",
    ".sh",
    ".zsh",
]);
export const ERROR_MESSAGES = {
    unsupported_platform: "当前平台不支持 Alibaba Personal Token Plan。",
    executable_not_found: "在受信任的 PATH 里找不到 Alibaba Cloud CLI (bl)。",
    shell_launcher_rejected: "Alibaba Personal Token Plan 拒绝为 bl 使用 shell 启动器。",
    workspace_path_rejected: "Alibaba Personal Token Plan 忽略了工作区与相对 PATH 条目。",
    spawn_failed: "无法启动 Alibaba Cloud CLI。",
    timeout: "运行 Alibaba Cloud CLI 超时。",
    output_truncated: "Alibaba Cloud CLI 输出超过大小上限。",
    nonzero_exit: "无法读取 Alibaba Personal Token Plan 额度。",
    not_authenticated: "Alibaba Cloud 控制台登录缺失或已过期。请运行 `bl auth login --console`。",
    invalid_json: "Alibaba Cloud CLI 返回的 JSON 无效。",
    invalid_schema: "Alibaba Cloud CLI 返回的 Personal Token Plan 数据无效。",
    no_data: "Alibaba Personal Token Plan 用量没有返回额度窗口。",
};
function fail(kind) {
    return { ok: false, error: { kind, message: ERROR_MESSAGES[kind] } };
}
export function isAlibabaTokenPlanSupportedPlatform(platform = process.platform) {
    return SUPPORTED_PLATFORMS.has(platform);
}
function isPathInside(parent, candidate) {
    const relative = path.posix.relative(parent, candidate);
    return (relative === "" ||
        (relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative)));
}
function stripPathQuotes(value) {
    const trimmed = value.trim();
    if (trimmed.length >= 2 &&
        ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
            (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}
/**
 * The folder whose PATH entries and executables are not trusted: the project folder quota is
 * computed for. For OpenCode opened at the home folder, and for the terminal command, that is
 * the home folder. The home folder is not a project, so it gives none.
 */
function untrustedProjectFolder(cwd, home) {
    const resolved = path.posix.resolve(cwd);
    return resolved === path.posix.resolve(home ?? homedir()) ? null : resolved;
}
/** Absolute PATH directories outside the project folder, deduplicated, in PATH order. */
function listTrustedPathDirectories(pathEnv, cwd, home) {
    const projectFolder = untrustedProjectFolder(cwd, home);
    const trusted = new Set();
    for (const rawEntry of (pathEnv ?? "").split(":")) {
        const entry = stripPathQuotes(rawEntry);
        if (!path.posix.isAbsolute(entry))
            continue;
        const resolved = path.posix.resolve(entry);
        if (projectFolder !== null && isPathInside(projectFolder, resolved))
            continue;
        trusted.add(resolved);
    }
    return [...trusted];
}
function isShellLauncherPath(file) {
    return (SHELL_LAUNCHER_EXTENSIONS.has(path.posix.extname(file).toLowerCase()) ||
        SHELL_LAUNCHER_NAMES.has(path.posix.basename(file).toLowerCase()));
}
/** True for a regular file, following symlinks; false when missing or broken. */
async function isRegularFile(file) {
    try {
        return (await stat(file)).isFile();
    }
    catch {
        return false;
    }
}
export async function resolveAlibabaTokenPlanExecutable(params) {
    if (!isAlibabaTokenPlanSupportedPlatform(params.platform)) {
        return fail("unsupported_platform");
    }
    const projectFolder = untrustedProjectFolder(params.cwd, params.homedir);
    const trusted = listTrustedPathDirectories(params.pathEnv ?? process.env.PATH, params.cwd, params.homedir);
    let sawShellLauncher = false;
    for (const directory of trusted) {
        for (const name of EXECUTABLE_NAMES) {
            const candidate = path.posix.join(directory, name);
            if (!(await isRegularFile(candidate)))
                continue;
            const resolved = await realpath(candidate).catch(() => candidate);
            if (isShellLauncherPath(candidate) || isShellLauncherPath(resolved)) {
                sawShellLauncher = true;
                continue;
            }
            if (projectFolder !== null && isPathInside(projectFolder, resolved)) {
                return fail("workspace_path_rejected");
            }
            return { ok: true, file: resolved };
        }
    }
    return fail(sawShellLauncher ? "shell_launcher_rejected" : "executable_not_found");
}
/** One window: a used fraction 0..1 and an optional epoch-ms reset. A reset alone is invalid. */
function parseWindow(payload, prefix) {
    const percentageKey = `${prefix}Percentage`;
    const resetKey = `${prefix}ResetTime`;
    const resetPresent = Object.hasOwn(payload, resetKey);
    if (!Object.hasOwn(payload, percentageKey))
        return resetPresent ? "invalid" : undefined;
    const used = payload[percentageKey];
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 1) {
        return "invalid";
    }
    const percentRemaining = 100 - used * 100;
    if (!resetPresent)
        return { percentRemaining };
    const reset = payload[resetKey];
    if (typeof reset !== "number" ||
        !Number.isFinite(reset) ||
        reset <= 0 ||
        reset > MAX_RESET_TIME_MS) {
        return "invalid";
    }
    return { percentRemaining, resetTimeIso: new Date(reset).toISOString() };
}
export function parseAlibabaTokenPlanUsageJson(text) {
    let payload;
    try {
        payload = JSON.parse(text);
    }
    catch {
        return fail("invalid_json");
    }
    const record = asRecord(payload);
    if (!record)
        return fail("invalid_schema");
    const fiveHour = parseWindow(record, "per5Hour");
    const weekly = parseWindow(record, "per1Week");
    if (fiveHour === "invalid" || weekly === "invalid")
        return fail("invalid_schema");
    if (!fiveHour && !weekly)
        return fail("no_data");
    return {
        ok: true,
        ...(fiveHour ? { fiveHour } : {}),
        ...(weekly ? { weekly } : {}),
    };
}
function errorCode(error) {
    return error && typeof error === "object" && "code" in error
        ? String(error.code)
        : undefined;
}
/** Signal the child's whole process group, falling back to the child alone. */
function signalProcessGroup(child, signal) {
    if (!child.pid)
        return;
    try {
        process.kill(-child.pid, signal);
    }
    catch {
        try {
            child.kill(signal);
        }
        catch {
            // already exited
        }
    }
}
/**
 * Run the CLI without a shell, with stdin ignored and stdout/stderr capped. A timeout or an
 * overflow sends SIGTERM to the process group, then SIGKILL after `killGraceMs`.
 */
export async function runAlibabaTokenPlanProcess(request) {
    return await new Promise((resolve) => {
        let child;
        try {
            child = spawn(request.file, [...request.args], {
                cwd: request.cwd,
                env: request.env,
                argv0: request.file,
                shell: false,
                detached: true,
                stdio: ["ignore", "pipe", "pipe"],
            });
        }
        catch (error) {
            resolve({
                code: null,
                stdout: Buffer.alloc(0),
                stderr: Buffer.alloc(0),
                timedOut: false,
                truncated: false,
                spawnErrorCode: errorCode(error),
            });
            return;
        }
        const stdoutChunks = [];
        const stderrChunks = [];
        let timedOut = false;
        let truncated = false;
        let killTimer;
        let settled = false;
        function stop() {
            if (killTimer !== undefined)
                return;
            signalProcessGroup(child, "SIGTERM");
            killTimer = setTimeout(() => signalProcessGroup(child, "SIGKILL"), request.killGraceMs);
        }
        function collect(chunks, limit) {
            let size = 0;
            return (chunk) => {
                const room = limit - size;
                if (room > 0 && chunk.length <= room) {
                    chunks.push(chunk);
                    size += chunk.length;
                    return;
                }
                if (room > 0)
                    chunks.push(chunk.subarray(0, room));
                size = limit;
                if (!truncated) {
                    truncated = true;
                    stop();
                }
            };
        }
        function finish(code, spawnErrorCode) {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            clearTimeout(killTimer);
            resolve({
                code,
                stdout: Buffer.concat(stdoutChunks),
                stderr: Buffer.concat(stderrChunks),
                timedOut,
                truncated,
                ...(spawnErrorCode ? { spawnErrorCode } : {}),
            });
        }
        const timeout = setTimeout(() => {
            timedOut = true;
            stop();
        }, request.timeoutMs);
        child.stdout?.on("data", collect(stdoutChunks, request.stdoutLimitBytes));
        child.stderr?.on("data", collect(stderrChunks, request.stderrLimitBytes));
        child.on("error", (error) => finish(null, errorCode(error)));
        child.on("close", (code) => finish(code));
    });
}
function mapSpawnResult(result) {
    if (result.truncated)
        return fail("output_truncated");
    if (result.timedOut)
        return fail("timeout");
    if (result.spawnErrorCode === "ENOENT")
        return fail("executable_not_found");
    if (result.spawnErrorCode)
        return fail("spawn_failed");
    if (result.code === AUTH_EXIT_CODE)
        return fail("not_authenticated");
    if (result.code !== 0)
        return fail("nonzero_exit");
    return parseAlibabaTokenPlanUsageJson(result.stdout.toString("utf8"));
}
export async function queryAlibabaTokenPlanQuota(options) {
    const runtime = options.runtime;
    const platform = runtime.platform ?? process.platform;
    if (!isAlibabaTokenPlanSupportedPlatform(platform)) {
        return fail("unsupported_platform");
    }
    const cwd = path.posix.resolve(runtime.cwd);
    const home = runtime.homedir ?? homedir();
    const pathEnv = runtime.pathEnv ?? runtime.env?.PATH ?? process.env.PATH;
    const resolved = await resolveAlibabaTokenPlanExecutable({
        pathEnv,
        cwd,
        homedir: home,
        platform,
    });
    if (!resolved.ok)
        return resolved;
    // Run outside the project folder so the CLI never picks up project files.
    const processCwd = [runtime.tmpdir ?? tmpdir(), home]
        .map((candidate) => path.posix.resolve(candidate))
        .find((candidate) => !isPathInside(cwd, candidate)) ?? "/";
    const request = {
        file: resolved.file,
        args: ALIBABA_TOKEN_PLAN_ARGS,
        cwd: processCwd,
        env: {
            ...(runtime.env ?? process.env),
            PATH: listTrustedPathDirectories(pathEnv, cwd, home).join(":"),
        },
        timeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
        stdoutLimitBytes: ALIBABA_TOKEN_PLAN_STDOUT_LIMIT_BYTES,
        stderrLimitBytes: ALIBABA_TOKEN_PLAN_STDERR_LIMIT_BYTES,
        stdin: "ignore",
        shell: false,
        killGraceMs: ALIBABA_TOKEN_PLAN_KILL_GRACE_MS,
    };
    const run = runtime.spawn ?? runAlibabaTokenPlanProcess;
    try {
        return mapSpawnResult(await run(request));
    }
    catch {
        return fail("spawn_failed");
    }
}
