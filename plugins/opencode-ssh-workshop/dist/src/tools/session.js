import { isAlive } from "../session/commands.js";
function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}
/** 迁移上游 `ssh_disconnect`。关闭的是本主会话的连接。 */
export function createDisconnectTool(runtime) {
    return {
        name: "ssh_disconnect",
        description: "Close the active persistent SSH session for this session and its SSH subagents. " +
            "Shell state is lost. You can reconnect later with ssh_connect.",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute(_input, tool) {
            const rootID = await runtime.workspaces.resolveRoot(tool.sessionID);
            const message = runtime.sessions.remove(rootID);
            runtime.workspaces.clear(rootID);
            return { content: message };
        },
    };
}
/** 迁移上游 `ssh_info`，额外显示当前绑定的设备与远端工作目录。 */
export function createInfoTool(runtime) {
    return {
        name: "ssh_info",
        description: "Get information about the current SSH session: host, device, remote working directory, " +
            "duration and whether it is busy. Use this to check connection status before running commands.",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute(_input, tool) {
            const resolved = await runtime.peekFor(tool);
            const state = resolved?.state;
            if (!resolved || !state || !isAlive(state) || !state.host) {
                return { content: "No active SSH session." };
            }
            const device = state.deviceID ? await runtime.devices.get(state.deviceID) : undefined;
            const duration = state.connectedAt ? formatDuration(Date.now() - state.connectedAt) : "unknown";
            const queueLength = state.commandQueue.length;
            return {
                content: [
                    `Host: ${state.host}`,
                    device ? `Device: ${device.name}` : null,
                    state.remoteDirectory ? `Working directory: ${state.remoteDirectory}` : null,
                    `Connected: ${duration}`,
                    `Busy: ${state.running ? "yes" : "no"}`,
                    queueLength > 0 ? `Queued commands: ${queueLength}` : null,
                ]
                    .filter((line) => line !== null)
                    .join("\n"),
            };
        },
    };
}
