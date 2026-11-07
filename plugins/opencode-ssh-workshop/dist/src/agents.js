import { SSH_AGENT_IDS } from "./options.js";
import { sshArchivistPrompt, sshDrafterPrompt, sshForemanPrompt, sshInspectorPrompt, sshMakerPrompt, sshSurveyorPrompt, sshTinkerPrompt, } from "./prompts.js";
const allow = "allow";
const ask = "ask";
const deny = "deny";
function rule(action, resource, effect) {
    return { action, resource, effect };
}
/**
 * V2 原生基础策略（`/v2/docs/permissions` 的 Defaults 节）。
 * 合并时识别到这段前缀，就能把用户规则插在我们的 policy 之后、hard 之前。
 */
const NATIVE_BASE = [
    rule("*", "*", allow),
    rule("read", "*.env", ask),
    rule("read", "*.env.*", ask),
    rule("read", "*.env.example", allow),
];
/** 敏感环境文件：宽放行之后必须重新收紧，否则会被后面的 `read *` 覆盖。 */
const sensitiveReadPolicy = [
    rule("read", "*.env", ask),
    rule("read", "*.env.*", ask),
    rule("read", "*.env.example", allow),
];
/** 与 Workshop 同一份高风险清单；远端执行同样适用，因为代价一样落在主机上。 */
const highRiskCommands = [
    "sudo*",
    "su *",
    "rm -rf*",
    "git reset*",
    "git clean*",
    "git checkout*",
    "git rebase*",
    "git push*",
    "systemctl*",
    "service*",
    "shutdown*",
    "reboot*",
    "mkfs*",
    "dd *",
];
/**
 * SSH 角色的共享策略。
 *
 * 关键点：远端命令走 `shell`（资源是规范化命令及子命令），远端文件走 `read`/`edit`/`glob`/`grep`
 * （资源带 `host:` 前缀），连接走 `ssh_connect`。因此用户可以按设备或按命令细分规则，
 * 本地传输另用默认 ask 的 ssh_local_read / ssh_local_edit，避免远端规则放行本机文件。
 *
 * `ssh_connect` 默认 `ask`：这是在恢复上游「连接需确认」的既有默认，V2 的原生
 * `* * allow` 会把它放行掉，所以显式写一条放回 policy 层（用户规则仍可覆盖）。
 */
const sshSharedPolicy = [
    rule("read", "*", allow),
    rule("glob", "*", allow),
    rule("grep", "*", allow),
    rule("edit", "*", allow),
    rule("shell", "*", allow),
    ...highRiskCommands.map((resource) => rule("shell", resource, ask)),
    rule("ssh_connect", "*", ask),
    rule("ssh_devices", "*", allow),
    rule("ssh_local_read", "*", ask),
    rule("ssh_local_edit", "*", ask),
    rule("external_directory", "*", ask),
    rule("skill", "*", allow),
    rule("question", "*", allow),
    rule("webfetch", "*", allow),
    rule("websearch", "*", allow),
    ...sensitiveReadPolicy,
];
const sshWorkerIds = ["ssh-maker", "ssh-inspector", "ssh-archivist", "ssh-surveyor"];
const sshDelegationPolicy = [
    rule("subagent", "*", deny),
    ...sshWorkerIds.map((id) => rule("subagent", id, allow)),
];
const sshReadOnlyDelegationPolicy = [
    rule("subagent", "*", deny),
    rule("subagent", "ssh-inspector", allow),
    rule("subagent", "ssh-archivist", allow),
    rule("subagent", "ssh-surveyor", allow),
];
/** SSH Worker 硬限制：禁递归委派、禁提问、高风险命令与自主 Git 变更。 */
const sshWorkerHardRules = [
    rule("subagent", "*", deny),
    rule("question", "*", deny),
    ...highRiskCommands.map((resource) => rule("shell", resource, deny)),
    rule("shell", "git commit*", deny),
    rule("shell", "git add*", deny),
    rule("shell", "git revert*", deny),
];
const sshReadOnlyHardRules = [rule("edit", "*", deny), rule("ssh_local_edit", "*", deny)];
/**
 * 规划角色不执行远端命令。
 *
 * 这与本地 Drafter 的 `noShellHardRule` 对应：它靠只读工具调查，靠 ssh_write 产出
 * 规划文档。注意这里会同时挡住 `ssh` 工具——这是有意的，规划角色不该改远端状态。
 */
const sshNoShellHardRule = [rule("shell", "*", deny)];
const planningEditPolicy = [
    // 先全局拒绝，再逐个放行规划产物——与 Workshop 原 Drafter 的写法一致。
    // 顺序很关键：sshSharedPolicy 里已有 `edit *` allow，这里必须重新收紧，
    // 否则 `ssh-drafter` 实际可以改任意远端文件。
    rule("edit", "*", deny),
    rule("edit", "*.md", allow),
    rule("edit", "**/*.md", allow),
    rule("edit", "*.html", allow),
    rule("edit", "**/*.html", allow),
];
const markdownOnlyEditPolicy = [
    rule("edit", "*", deny),
    rule("edit", "*.md", allow),
    rule("edit", "**/*.md", allow),
];
/**
 * 与 Workshop 的分层合并同构，但用 4 条原生基础策略作前缀识别：
 * base → SSH policy → 用户规则 → SSH hard。
 * hard 只放纯 deny，永远最后生效，因此用户规则无法解除职责硬限制。
 */
export function mergeSshPermissions(existing, layers) {
    const startsWithBase = existing.length >= NATIVE_BASE.length &&
        NATIVE_BASE.every((entry, index) => {
            const current = existing[index];
            return (current !== undefined &&
                current.action === entry.action &&
                current.resource === entry.resource &&
                current.effect === entry.effect);
        });
    if (startsWithBase) {
        return [
            ...existing.slice(0, NATIVE_BASE.length),
            ...layers.policy,
            ...existing.slice(NATIVE_BASE.length),
            ...layers.hard,
        ];
    }
    return [...layers.policy, ...existing, ...layers.hard];
}
function withOverride(base, override) {
    return override ? { ...base, ...override } : base;
}
/** 生成七个 SSH 角色的定义；权限用上面的分层，模型与其余字段由 options 覆盖。 */
export function buildSshAgents(overrides) {
    /** 三个主角色共享的策略：日常能力 + 委派四个 SSH Worker（不含本地 Worker）。 */
    const primaryLayers = {
        policy: [...sshSharedPolicy, ...sshDelegationPolicy],
        hard: [],
    };
    const definitions = {
        "ssh-drafter": withOverride({
            description: "在远端设备上只做规划与只读调查，产出 Implementation Plan。",
            mode: "primary",
            color: "#7C3AED",
            prompt: sshDrafterPrompt(),
            permissions: {
                policy: [...sshSharedPolicy, ...planningEditPolicy, ...sshReadOnlyDelegationPolicy],
                hard: sshNoShellHardRule,
            },
        }, overrides["ssh-drafter"]),
        "ssh-tinker": withOverride({
            description: "默认远端通用助手：在已连接设备上解释、调研、设计、实现与调试，可委派四个 SSH Worker。",
            mode: "primary",
            color: "#059669",
            prompt: sshTinkerPrompt(),
            permissions: primaryLayers,
        }, overrides["ssh-tinker"]),
        "ssh-foreman": withOverride({
            description: "远端协作重心：主线自持，按 leverage 委派 SSH Worker。",
            mode: "primary",
            color: "#D97706",
            prompt: sshForemanPrompt(),
            permissions: primaryLayers,
        }, overrides["ssh-foreman"]),
        "ssh-maker": withOverride({
            description: "在远端 Assigned Scope 内实施一个有界端到端单元。",
            mode: "subagent",
            steps: 40,
            color: "#EA580C",
            prompt: sshMakerPrompt(),
            permissions: {
                policy: sshSharedPolicy,
                hard: sshWorkerHardRules,
            },
        }, overrides["ssh-maker"]),
        "ssh-inspector": withOverride({
            description: "在远端只读独立审查一个 Standards、Spec 或设计维度。",
            mode: "subagent",
            steps: 24,
            color: "#DC2626",
            prompt: sshInspectorPrompt(),
            permissions: {
                policy: sshSharedPolicy,
                hard: [...sshWorkerHardRules, ...sshReadOnlyHardRules],
            },
        }, overrides["ssh-inspector"]),
        "ssh-archivist": withOverride({
            description: "在远端调研一手来源并写入指定 Markdown 报告。",
            mode: "subagent",
            steps: 20,
            color: "#2563EB",
            prompt: sshArchivistPrompt(),
            permissions: {
                policy: [...sshSharedPolicy, ...markdownOnlyEditPolicy],
                hard: sshWorkerHardRules,
            },
        }, overrides["ssh-archivist"]),
        "ssh-surveyor": withOverride({
            description: "在远端只读映射代码、约定和关系。",
            mode: "subagent",
            steps: 32,
            color: "#0891B2",
            prompt: sshSurveyorPrompt(),
            permissions: {
                policy: sshSharedPolicy,
                hard: [...sshWorkerHardRules, ...sshReadOnlyHardRules],
            },
        }, overrides["ssh-surveyor"]),
    };
    return definitions;
}
/**
 * SSH 角色要移除的本地工具：文件与 shell 全部换成远端对应物。
 *
 * 同时列出 `bash` 与 `shell`：V2 的 Shell 工具名是 `shell`，而上游文档与旧配置
 * 常写作 `bash`。两个都留在列表里，任一侧改名都不会重新打开本机执行通道。
 */
export const LOCAL_TOOLS_TO_HIDE = [
    "read",
    "write",
    "edit",
    "glob",
    "grep",
    "patch",
    "list",
    "bash",
    "shell",
];
export function isSshAgent(agentID) {
    return SSH_AGENT_IDS.includes(agentID);
}
/** SSH 角色对应的 Workshop 原角色 id；用于继承模型等运行配置。 */
export function counterpartAgentID(agentID) {
    return isSshAgent(agentID) ? agentID.slice("ssh-".length) : undefined;
}
export function isHiddenLocalTool(toolName) {
    return LOCAL_TOOLS_TO_HIDE.includes(toolName);
}
