import { isSshAgent, isHiddenLocalTool } from "./agents.js";
import { containsSshCommand } from "./shell-parser.js";
/** 插件实际注册的 SSH 工具；不要用宽前缀，避免误伤同名第三方工具。 */
export const SSH_TOOL_NAMES = new Set([
    "ssh",
    "ssh_connect",
    "ssh_disconnect",
    "ssh_info",
    "ssh_upload",
    "ssh_download",
    "ssh_devices",
    "ssh_read",
    "ssh_write",
    "ssh_glob",
    "ssh_grep",
]);
const LOCAL_SHELL_TOOL_NAMES = new Set(["shell", "bash"]);
export const SSH_AGENT_REQUIRED_MESSAGE = "当前角色不能操作 SSH，请手动切换到 ssh-tinker、ssh-drafter 或 ssh-foreman。";
/** 服务端 RPC 没有可信的调用者角色参数，必须读会话的当前角色。 */
export function assertSshSessionAgent(agentID) {
    if (!agentID || !isSshAgent(agentID)) {
        throw new Error(SSH_AGENT_REQUIRED_MESSAGE);
    }
}
function shellCommandFromInput(input) {
    if (typeof input === "string")
        return input;
    if (!input || typeof input !== "object")
        return undefined;
    const record = input;
    const value = record.command ?? record.cmd ?? record.script;
    if (typeof value === "string")
        return value;
    if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
        return value.join(" ");
    }
    return undefined;
}
/**
 * 工具执行前的角色门槛。
 *
 * 使用事件里的真实 `agent`，不信任模型给工具传入的任何角色字段；SSH 角色
 * 仍沿用原有的本地工具隐藏／拒绝逻辑，非 SSH 角色则不能进入 SSH 工具，
 * 也不能通过本机 shell 执行可识别的 ssh／scp／sftp。
 */
export async function guardToolCall(agentID, toolName, input) {
    const sshAgent = isSshAgent(agentID);
    if (sshAgent) {
        if (isHiddenLocalTool(toolName)) {
            throw new Error(`SSH 角色不能使用本地工具 ${toolName}；请改用 ssh_read / ssh_write / ssh_glob / ssh_grep / ssh。`);
        }
        return;
    }
    if (SSH_TOOL_NAMES.has(toolName)) {
        throw new Error(SSH_AGENT_REQUIRED_MESSAGE);
    }
    if (LOCAL_SHELL_TOOL_NAMES.has(toolName)) {
        const command = shellCommandFromInput(input);
        if (command && (await containsSshCommand(command))) {
            throw new Error(SSH_AGENT_REQUIRED_MESSAGE);
        }
    }
}
