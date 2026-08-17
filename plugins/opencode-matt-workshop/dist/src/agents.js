import { tmpdir } from "node:os";
import { join } from "node:path";
import { archivistPrompt, drafterPrompt, foremanPrompt, inspectorPrompt, makerPrompt, surveyorPrompt, tinkerPrompt, } from "./prompts.js";
const allow = "allow";
const ask = "ask";
const deny = "deny";
const sensitiveRead = (environmentFiles) => ({
    "*": allow,
    "*.env": environmentFiles,
    "*.env.*": environmentFiles,
    "*.env.example": allow,
});
const dangerousBash = {
    "sudo*": deny,
    "su *": deny,
    "rm -rf*": deny,
    "git reset*": deny,
    "git clean*": deny,
    "git checkout*": deny,
    "git rebase*": deny,
    "git push*": deny,
    "git commit*": ask,
    "git add*": ask,
    "systemctl*": deny,
    "service*": deny,
    "shutdown*": deny,
    "reboot*": deny,
    "mkfs*": deny,
    "dd *": deny,
};
const implementationBash = { "*": allow, ...dangerousBash };
const workerBash = {
    "*": allow,
    ...dangerousBash,
    "git commit*": deny,
    "git add*": deny,
    "git revert*": deny,
};
const drafterBash = {
    "*": allow,
    ...dangerousBash,
    "git commit*": deny,
    "git add*": deny,
    "git revert*": deny,
};
const supportTasks = {
    "*": deny,
    inspector: allow,
    archivist: allow,
    surveyor: allow,
};
const foremanTasks = {
    "*": deny,
    maker: allow,
    inspector: allow,
    archivist: allow,
    surveyor: allow,
};
const workerBase = {
    read: sensitiveRead("deny"),
    glob: allow,
    grep: allow,
    list: allow,
    bash: workerBash,
    task: deny,
    external_directory: deny,
    todowrite: deny,
    question: deny,
    webfetch: deny,
    websearch: deny,
    lsp: allow,
    skill: deny,
};
function withOverride(base, override) {
    return override ? { ...base, ...override } : base;
}
export function buildWorkshopAgents(options) {
    const temporaryDirectory = tmpdir();
    return {
        drafter: withOverride({
            description: "用 Matt 工作流澄清决策并产出 Implementation Plan。",
            mode: "primary",
            color: "#8B5CF6",
            prompt: drafterPrompt(),
            permission: {
                read: sensitiveRead("ask"),
                glob: allow,
                grep: allow,
                list: allow,
                edit: {
                    "*": deny,
                    "*.md": allow,
                    "**/*.md": allow,
                    "*.html": allow,
                    "**/*.html": allow,
                    [join(temporaryDirectory, "*.md")]: allow,
                    [join(temporaryDirectory, "*.html")]: allow,
                },
                bash: drafterBash,
                task: supportTasks,
                external_directory: ask,
                todowrite: allow,
                question: allow,
                webfetch: allow,
                websearch: allow,
                lsp: allow,
                skill: allow,
            },
        }, options.agents.drafter),
        tinker: withOverride({
            description: "默认的单 Agent Ready Work 实现角色。",
            mode: "primary",
            color: "#10B981",
            prompt: tinkerPrompt(),
            permission: {
                read: sensitiveRead("ask"),
                edit: allow,
                glob: allow,
                grep: allow,
                list: allow,
                bash: implementationBash,
                task: deny,
                external_directory: ask,
                todowrite: allow,
                question: allow,
                webfetch: allow,
                websearch: allow,
                lsp: allow,
                skill: allow,
            },
        }, options.agents.tinker),
        foreman: withOverride({
            description: "实施主线，并在有明确 leverage 时委派 Worker。",
            mode: "primary",
            color: "#F59E0B",
            prompt: foremanPrompt(),
            permission: {
                read: sensitiveRead("ask"),
                edit: allow,
                glob: allow,
                grep: allow,
                list: allow,
                bash: implementationBash,
                task: foremanTasks,
                external_directory: ask,
                todowrite: allow,
                question: allow,
                webfetch: allow,
                websearch: allow,
                lsp: allow,
                skill: allow,
            },
        }, options.agents.foreman),
        maker: withOverride({
            description: "在 Assigned Scope 内实施一个有界端到端单元。",
            mode: "subagent",
            hidden: true,
            steps: 40,
            color: "#F97316",
            prompt: makerPrompt(),
            permission: { ...workerBase, edit: allow },
        }, options.agents.maker),
        inspector: withOverride({
            description: "只读独立审查一个 Standards、Spec 或设计维度。",
            mode: "subagent",
            hidden: true,
            steps: 24,
            color: "#EF4444",
            prompt: inspectorPrompt(),
            permission: { ...workerBase, edit: deny },
        }, options.agents.inspector),
        archivist: withOverride({
            description: "调研一手来源并写入指定 Markdown 报告。",
            mode: "subagent",
            steps: 20,
            color: "#3B82F6",
            prompt: archivistPrompt(),
            permission: {
                ...workerBase,
                edit: { "*": deny, "*.md": allow, "**/*.md": allow },
                webfetch: allow,
                websearch: allow,
                lsp: deny,
            },
        }, options.agents.archivist),
        surveyor: withOverride({
            description: "只读映射代码、约定和关系。",
            mode: "subagent",
            steps: 32,
            color: "#06B6D4",
            prompt: surveyorPrompt(),
            permission: { ...workerBase, edit: deny },
        }, options.agents.surveyor),
    };
}
