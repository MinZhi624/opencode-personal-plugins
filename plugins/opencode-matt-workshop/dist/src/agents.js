import { tmpdir } from "node:os";
import { join } from "node:path";
import { archivistPrompt, drafterPrompt, foremanPrompt, inspectorPrompt, makerPrompt, surveyorPrompt, tinkerPrompt, } from "./prompts.js";
const allow = "allow";
const ask = "ask";
const deny = "deny";
function rule(action, resource, effect) {
    return { action, resource, effect };
}
/** 日常检索：读取、路径匹配、内容搜索。 */
const inspectPolicy = [
    rule("read", "*", allow),
    rule("glob", "*", allow),
    rule("grep", "*", allow),
];
/**
 * 敏感环境文件一律 ask（置于 read * allow 之后，保证 ask 覆盖宽允许）；
 * 示例文件沿用原生默认的放行。属于 policy：用户显式规则可覆盖它。
 */
const sensitiveReadPolicy = [
    rule("read", "*.env", ask),
    rule("read", "*.env.*", ask),
    rule("read", "*.env.example", allow),
];
const externalDirectoryPolicy = rule("external_directory", "*", allow);
const skillPolicy = rule("skill", "*", allow);
const questionPolicy = rule("question", "*", allow);
const webPolicy = [rule("webfetch", "*", allow), rule("websearch", "*", allow)];
const editPolicy = rule("edit", "*", allow);
/** 原 dangerousBash 中的高风险命令清单；Primary 放宽为 ask，Worker 保持 deny。 */
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
/** Primary 日常 bash：默认 allow，高风险 ask；Git 提交/暂存保持原有 ask（用户意图由提示词负责澄清）。 */
const primaryBashPolicy = [
    rule("shell", "*", allow),
    ...highRiskCommands.map((resource) => rule("shell", resource, ask)),
    rule("shell", "git commit*", ask),
    rule("shell", "git add*", ask),
];
const workerIds = ["maker", "inspector", "archivist", "surveyor"];
/** 可委派四个 Worker 的 Primary：先全局 deny，再把四个 Worker 逐个 allow（后出现的具体规则先生效）。 */
const workerDelegationPolicy = [
    rule("subagent", "*", deny),
    ...workerIds.map((id) => rule("subagent", id, allow)),
];
/** Drafter 只委派只读调查与评估：Inspector / Archivist / Surveyor，不呼叫 Maker。 */
const readOnlyDelegationPolicy = [
    rule("subagent", "*", deny),
    rule("subagent", "inspector", allow),
    rule("subagent", "archivist", allow),
    rule("subagent", "surveyor", allow),
];
/** Worker 硬限制：禁止递归委派、禁止提问用户、禁止自行 Git 变更、高风险命令保持 deny。 */
const workerHardRules = [
    rule("subagent", "*", deny),
    rule("question", "*", deny),
    ...highRiskCommands.map((resource) => rule("shell", resource, deny)),
    rule("shell", "git commit*", deny),
    rule("shell", "git add*", deny),
    rule("shell", "git revert*", deny),
];
/** 只读 Worker 硬限制（纯 deny）：不通过 shell 写文件（含重定向），审查所需 diff 由 Parent 提供；不得 edit。 */
const readOnlyHardRules = [
    rule("shell", "*", deny),
    rule("edit", "*", deny),
];
/** 不通过 shell 写文件的硬限制（纯 deny）。 */
const noShellHardRule = rule("shell", "*", deny);
/** Archivist 的编辑范围（默认策略，可被用户显式规则覆盖）：只放行 Markdown 报告。 */
const markdownOnlyEditPolicy = [
    rule("edit", "*", deny),
    rule("edit", "*.md", allow),
    rule("edit", "**/*.md", allow),
];
/** Primary 共享 policy：日常检索、敏感环境文件、skill 与公开网络资料。bash 与委派按角色另给。 */
const primarySharedPolicy = [
    ...inspectPolicy,
    ...sensitiveReadPolicy,
    externalDirectoryPolicy,
    questionPolicy,
    skillPolicy,
    ...webPolicy,
];
/** Worker 共享 policy：按职责开放 skill 与公开网络资料；不在此层放行 edit / question / subagent / shell。 */
const workerSharedPolicy = [
    ...inspectPolicy,
    ...sensitiveReadPolicy,
    externalDirectoryPolicy,
    skillPolicy,
    ...webPolicy,
];
/**
 * OpenCode v2 原生 agent 默认规则（@opencode/schema Agent.Info.default，按原生顺序）。
 * 这是与运行时的**兼容约定**：完整前缀用于让 Workshop policy 可以覆盖其中条目
 * （例如 external_directory ask → allow）；它不能证明规则来源，用户逐字写出
 * 同样的五条时同样按此约定处理。
 */
const NATIVE_DEFAULT_RULES = [
    { action: "*", resource: "*", effect: "allow" },
    { action: "external_directory", resource: "*", effect: "ask" },
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*.env.*", effect: "ask" },
    { action: "read", resource: "*.env.example", effect: "allow" },
];
function sameRule(left, right) {
    return (left !== undefined &&
        right !== undefined &&
        left.action === right.action &&
        left.resource === right.resource &&
        left.effect === right.effect);
}
function startsWithSequence(rules, sequence) {
    if (sequence.length > rules.length)
        return false;
    return sequence.every((entry, index) => sameRule(rules[index], entry));
}
/**
 * 原生 last-match 顺序合并，不构建任何模式匹配器、不维持自制状态：
 * - 现有规则被完整保留且相对顺序不变（用户的 allow 例外与 deny 都靠顺序自然生效）；
 * - 能识别完整原生默认前缀时：base(原生默认) → Workshop policy → 用户规则 → Workshop hard；
 * - 无法可靠区分原生默认与用户规则时：Workshop policy → 现有规则(全部视为用户) → Workshop hard，
 *   此时 external_directory 等被原生默认收紧的能力退回 ask（保守，可接受）；
 * - Workshop policy 永不在用户规则之后，因此不会静默放宽任何现有 ask / deny；
 * - hard 只放纯 deny 的职责硬限制（禁递归 / 禁自行 Git 变更 / 只读不 edit / 不通过 shell 写文件），
 *   始终位于最后，优先于用户规则生效；格式范围（Drafter 的 md/html、Archivist 的 md）属于
 *   policy 默认策略，用户显式规则可按原生顺序覆盖，提示词继续约束行为，文档说明这不是 OS 隔离；
 * - 原生 transform 每次以新 state 重放，幂等由重放保证；此处不追加权层。
 */
export function mergePermissions(existing, layers) {
    if (startsWithSequence(existing, NATIVE_DEFAULT_RULES)) {
        return [
            ...existing.slice(0, NATIVE_DEFAULT_RULES.length),
            ...layers.policy,
            ...existing.slice(NATIVE_DEFAULT_RULES.length),
            ...layers.hard,
        ];
    }
    return [...layers.policy, ...existing, ...layers.hard];
}
function withOverride(base, override) {
    return override ? { ...base, ...override } : base;
}
export function buildWorkshopAgents(options) {
    const temporaryDirectory = tmpdir();
    /**
     * Drafter 的编辑范围（默认策略，可被用户显式规则覆盖）：只允许规划产物
     * （Markdown / HTML），先全局 deny 再逐个 allow。提示词继续约束不得实施生产。
     */
    const planningEditPolicy = [
        rule("edit", "*", deny),
        rule("edit", "*.md", allow),
        rule("edit", "**/*.md", allow),
        rule("edit", "*.html", allow),
        rule("edit", "**/*.html", allow),
        rule("edit", join(temporaryDirectory, "*.md"), allow),
        rule("edit", join(temporaryDirectory, "*.html"), allow),
    ];
    const primaryLayers = {
        policy: [...primarySharedPolicy, ...primaryBashPolicy, ...workerDelegationPolicy, editPolicy],
        hard: [],
    };
    return {
        drafter: withOverride({
            description: "只做规划与只读调查，产出 Implementation Plan。",
            mode: "primary",
            color: "#8B5CF6",
            prompt: drafterPrompt(),
            permissions: {
                policy: [...primarySharedPolicy, ...planningEditPolicy, ...readOnlyDelegationPolicy],
                hard: [noShellHardRule],
            },
        }, options.agents.drafter),
        tinker: withOverride({
            description: "默认通用助手：解释、调研、设计、实现与调试，可按需委派四个 Worker。",
            mode: "primary",
            color: "#10B981",
            prompt: tinkerPrompt(),
            permissions: primaryLayers,
        }, options.agents.tinker),
        foreman: withOverride({
            description: "协作重心：主线自持，按 leverage 委派 Worker。",
            mode: "primary",
            color: "#F59E0B",
            prompt: foremanPrompt(),
            permissions: primaryLayers,
        }, options.agents.foreman),
        maker: withOverride({
            description: "在 Assigned Scope 内实施一个有界端到端单元。",
            mode: "subagent",
            hidden: false,
            steps: 40,
            color: "#F97316",
            prompt: makerPrompt(),
            permissions: {
                policy: [...workerSharedPolicy, rule("shell", "*", allow), editPolicy],
                hard: workerHardRules,
            },
        }, options.agents.maker),
        inspector: withOverride({
            description: "只读独立审查一个 Standards、Spec 或设计维度。",
            mode: "subagent",
            hidden: false,
            steps: 24,
            color: "#EF4444",
            prompt: inspectorPrompt(),
            permissions: {
                policy: workerSharedPolicy,
                hard: [...workerHardRules, ...readOnlyHardRules],
            },
        }, options.agents.inspector),
        archivist: withOverride({
            description: "调研一手来源并写入指定 Markdown 报告。",
            mode: "subagent",
            steps: 20,
            color: "#3B82F6",
            prompt: archivistPrompt(),
            permissions: {
                policy: [...workerSharedPolicy, ...markdownOnlyEditPolicy],
                hard: [...workerHardRules, noShellHardRule],
            },
        }, options.agents.archivist),
        surveyor: withOverride({
            description: "只读映射代码、约定和关系。",
            mode: "subagent",
            steps: 32,
            color: "#06B6D4",
            prompt: surveyorPrompt(),
            permissions: {
                policy: workerSharedPolicy,
                hard: [...workerHardRules, ...readOnlyHardRules],
            },
        }, options.agents.surveyor),
    };
}
