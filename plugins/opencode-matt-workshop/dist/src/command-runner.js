import { execFile, spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
const denied = [
    /(^|[;&|]\s*)(sudo|su|passwd|mkfs|wipefs|fdisk|gdisk|parted|reboot|shutdown|poweroff|halt)\b/i,
    /(^|[;&|]\s*)(git\s+(push|reset\s+--hard|clean|rebase|filter-branch|update-ref)|opencode\s+session\s+delete)\b/i,
    /(^|[;&|]\s*)(systemctl|service)\s+(enable|disable|start|stop|restart|mask|unmask)\b/i,
    /(^|[;&|]\s*)dd\s+[^;&|]*\bof=\/dev\//i,
    /\b(sqlite3|duckdb)\b[^\n]*(\.sqlite\b|\.db\b)/i,
    /\b(python|python3|node)\b[^\n]*(fetchall|readFileSync|readFile)\b[^\n]*(\.sqlite\b|\.db\b|\.log\b|\.zip\b|\.tar\b)/i,
];
const approval = [
    /\b(npm|pnpm|yarn|pip|pip3|uv|cargo|gem)\s+(install|add|update|upgrade)\b/i,
    /\b(curl|wget|docker|podman|ros2\s+(daemon|launch)|systemctl|service)\b/i,
    /(^|\s)(>|>>|tee\s+)\s*(~\/|\/home\/|\/etc\/|\/opt\/|\/usr\/)/i,
];
export class CommandRunner {
    preflightPromise;
    preflight() {
        return this.preflightPromise ??= (async () => {
            if (process.platform !== "linux")
                throw new Error("unsupported_runtime: controlled commands require Linux or WSL");
            await access("/sys/fs/cgroup/cgroup.controllers");
            const controllers = await readFile("/sys/fs/cgroup/cgroup.controllers", "utf8");
            for (const required of ["cpu", "memory", "pids"])
                if (!controllers.split(/\s+/).includes(required))
                    throw new Error(`unsupported_runtime: cgroup v2 ${required} controller is unavailable`);
            await promisify(execFile)("systemd-run", ["--user", "--quiet", "--wait", "--collect", "true"], { timeout: 5_000 });
        })();
    }
    classify(command) {
        if (denied.some((pattern) => pattern.test(command)))
            return "deny";
        if (approval.some((pattern) => pattern.test(command)))
            return "ask";
        return "allow";
    }
    async run(command, cwd, limits, signal) {
        await this.preflight();
        const args = ["--user", "--quiet", "--pipe", "--wait", "--collect", "-p", `MemoryMax=${limits.memory}`, "-p", `MemorySwapMax=${limits.swap}`, "-p", `CPUQuota=${limits.cpuQuota}`, "-p", `TasksMax=${limits.tasks}`, "--setenv", `PATH=${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`, "bash", "-c", command];
        return new Promise((resolve, reject) => {
            const child = spawn("systemd-run", args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
            let stdout = "", stderr = "", timedOut = false;
            const append = (current, chunk) => (current + chunk.toString("utf8")).slice(-1024 * 1024);
            child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
            child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
            const stop = () => { try {
                process.kill(-child.pid, "SIGTERM");
            }
            catch { } };
            signal.addEventListener("abort", stop, { once: true });
            const timer = setTimeout(() => { timedOut = true; stop(); }, limits.timeoutMs);
            child.once("error", (error) => { clearTimeout(timer); signal.removeEventListener("abort", stop); reject(error); });
            child.once("close", (exitCode) => { clearTimeout(timer); signal.removeEventListener("abort", stop); resolve({ exitCode, stdout, stderr, timedOut }); });
        });
    }
}
export const RESOURCE_LIMITS = {
    maker: { memory: "2G", swap: "512M", cpuQuota: "300%", tasks: 256, timeoutMs: 20 * 60_000 },
    inspector: { memory: "768M", swap: "256M", cpuQuota: "100%", tasks: 128, timeoutMs: 30 * 60_000 },
    archivist: { memory: "768M", swap: "256M", cpuQuota: "100%", tasks: 128, timeoutMs: 30 * 60_000 },
    surveyor: { memory: "1G", swap: "256M", cpuQuota: "100%", tasks: 128, timeoutMs: 30 * 60_000 },
    primary: { memory: "2G", swap: "512M", cpuQuota: "300%", tasks: 256, timeoutMs: 30 * 60_000 },
};
