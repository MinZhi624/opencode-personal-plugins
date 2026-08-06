import { tmpdir } from "node:os";
import { join } from "node:path";
import { archivistPrompt, drafterPrompt, foremanPrompt, inspectorPrompt, makerPrompt, surveyorPrompt, tinkerPrompt, } from "./prompts.js";
const drafterBashRules = {
    "*": "deny",
    "*git *": "deny",
    "git *": "deny",
    "git status*": "allow",
    "git diff*": "allow",
    "git log*": "allow",
    "git show*": "allow",
    "git rev-parse*": "allow",
    "gh *": "ask",
    "glab *": "ask",
};
const codeBashRules = {
    "*": "allow",
    "*git *": "deny",
    "git *": "deny",
};
const foremanBashRules = {
    "*": "allow",
    "*git *": "deny",
    "git *": "deny",
    "git status*": "allow",
    "git diff*": "allow",
    "git log*": "allow",
    "git show*": "allow",
    "git rev-parse*": "allow",
    "git add*": "allow",
    "git commit*": "allow",
};
const supportTaskRules = {
    "*": "deny",
    inspector: "allow",
    archivist: "allow",
    surveyor: "allow",
};
const foremanTaskRules = {
    ...supportTaskRules,
    maker: "allow",
};
function skillRules(skills) {
    return Object.fromEntries([
        ["*", "deny"],
        ...skills.map((skill) => [skill, "allow"]),
    ]);
}
function readRules(sensitiveAction) {
    return {
        "*": "allow",
        "*.env": sensitiveAction,
        "*.env.*": sensitiveAction,
        "*.env.example": "allow",
    };
}
function drafterPermissions() {
    const temporaryDirectory = tmpdir();
    return {
        read: readRules("ask"),
        glob: "allow",
        grep: "allow",
        list: "allow",
        edit: {
            "*": "deny",
            "*.md": "allow",
            "**/*.md": "allow",
            [join(temporaryDirectory, "*.md")]: "allow",
            [join(temporaryDirectory, "architecture-review-*.html")]: "allow",
        },
        bash: {
            ...drafterBashRules,
            [`xdg-open ${temporaryDirectory}/architecture-review-*.html`]: "allow",
            [`open ${temporaryDirectory}/architecture-review-*.html`]: "allow",
        },
        task: supportTaskRules,
        external_directory: {
            "*": "deny",
            [`${temporaryDirectory}/**`]: "allow",
        },
        todowrite: "allow",
        question: "allow",
        webfetch: "allow",
        websearch: "allow",
        lsp: "allow",
        doom_loop: "deny",
        skill: skillRules([
            "ask-matt",
            "grill-me",
            "grilling",
            "grill-with-docs",
            "triage",
            "improve-codebase-architecture",
            "setup-matt-pocock-skills",
            "to-spec",
            "to-issues",
            "wayfinder",
            "research",
            "domain-modeling",
            "codebase-design",
            "handoff",
            "writing-great-skills",
        ]),
    };
}
function foremanPermissions() {
    return {
        read: readRules("ask"),
        edit: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        bash: foremanBashRules,
        task: foremanTaskRules,
        external_directory: "ask",
        todowrite: "allow",
        question: "allow",
        webfetch: "allow",
        websearch: "allow",
        lsp: "allow",
        doom_loop: "deny",
        skill: skillRules([
            "implement",
            "tdd",
            "diagnosing-bugs",
            "prototype",
            "code-review",
            "resolving-merge-conflicts",
            "research",
            "domain-modeling",
            "codebase-design",
            "handoff",
            "writing-great-skills",
        ]),
    };
}
function tinkerPermissions() {
    return {
        read: readRules("ask"),
        edit: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        bash: codeBashRules,
        task: supportTaskRules,
        external_directory: "ask",
        todowrite: "deny",
        question: "allow",
        webfetch: "allow",
        websearch: "allow",
        lsp: "allow",
        doom_loop: "deny",
        skill: "allow",
    };
}
function makerPermissions() {
    return {
        read: readRules("deny"),
        edit: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        bash: codeBashRules,
        task: "deny",
        external_directory: "deny",
        todowrite: "allow",
        question: "deny",
        webfetch: "deny",
        websearch: "deny",
        lsp: "allow",
        doom_loop: "deny",
        skill: skillRules(["tdd", "diagnosing-bugs", "prototype", "codebase-design"]),
    };
}
function inspectorPermissions() {
    return {
        read: readRules("deny"),
        edit: "deny",
        glob: "allow",
        grep: "allow",
        list: "allow",
        bash: "deny",
        task: "deny",
        external_directory: "deny",
        todowrite: "deny",
        question: "deny",
        webfetch: "deny",
        websearch: "deny",
        lsp: "allow",
        doom_loop: "deny",
        skill: "deny",
    };
}
function archivistPermissions() {
    return {
        read: readRules("deny"),
        edit: { "*": "deny", "*.md": "allow", "**/*.md": "allow" },
        glob: "allow",
        grep: "allow",
        list: "allow",
        bash: "deny",
        task: "deny",
        external_directory: "deny",
        todowrite: "deny",
        question: "deny",
        webfetch: "allow",
        websearch: "allow",
        lsp: "deny",
        doom_loop: "deny",
        skill: "deny",
    };
}
function surveyorPermissions() {
    return {
        read: readRules("deny"),
        edit: "deny",
        glob: "allow",
        grep: "allow",
        list: "allow",
        bash: "deny",
        task: "deny",
        external_directory: "deny",
        todowrite: "deny",
        question: "deny",
        webfetch: "deny",
        websearch: "deny",
        lsp: "allow",
        doom_loop: "deny",
        skill: "deny",
    };
}
function withRuntimeOptions(config, runtime) {
    if (!runtime)
        return config;
    const { reasoningEffort, ...agentRuntime } = runtime;
    return {
        ...config,
        ...agentRuntime,
        ...(reasoningEffort ? { options: { ...config.options, reasoningEffort } } : {}),
    };
}
export function buildWorkshopAgents(options) {
    return {
        drafter: withRuntimeOptions({
            description: "Plans with Matt workflows, sharpens decisions, and maintains domain language.",
            mode: "primary",
            color: "#8B5CF6",
            prompt: drafterPrompt(),
            permission: drafterPermissions(),
        }, options.agents.drafter),
        foreman: withRuntimeOptions({
            description: "Implements Ready Work directly or coordinates Makers through an Acceptance Gate.",
            mode: "primary",
            color: "#F59E0B",
            prompt: foremanPrompt(options.max_parallel_makers),
            permission: foremanPermissions(),
        }, options.agents.foreman),
        tinker: withRuntimeOptions({
            description: "Default low-friction agent for clear, local, directly inspectable changes.",
            mode: "primary",
            color: "#10B981",
            prompt: tinkerPrompt(),
            permission: tinkerPermissions(),
        }, options.agents.tinker),
        maker: withRuntimeOptions({
            description: "Implements one bounded end-to-end slice for Foreman.",
            mode: "subagent",
            hidden: true,
            color: "#F97316",
            prompt: makerPrompt(),
            permission: makerPermissions(),
        }, options.agents.maker),
        inspector: withRuntimeOptions({
            description: "Performs one independent review axis or constrained design alternative.",
            mode: "subagent",
            hidden: true,
            color: "#EF4444",
            prompt: inspectorPrompt(),
            permission: inspectorPermissions(),
        }, options.agents.inspector),
        archivist: withRuntimeOptions({
            description: "Researches external primary sources and writes one cited report.",
            mode: "subagent",
            hidden: true,
            color: "#3B82F6",
            prompt: archivistPrompt(),
            permission: archivistPermissions(),
        }, options.agents.archivist),
        surveyor: withRuntimeOptions({
            description: "Maps local code, tests, conventions, and relationships without editing.",
            mode: "subagent",
            hidden: true,
            color: "#06B6D4",
            prompt: surveyorPrompt(),
            permission: surveyorPermissions(),
        }, options.agents.surveyor),
    };
}
//# sourceMappingURL=agents.js.map
