const COMMAND_SPECS = {
    "ask-matt": {
        description: "Choose the Matt workflow or skill that fits the current situation.",
        owner: "drafter",
    },
    "grill-with-docs": {
        description: "Sharpen an idea while maintaining domain language and decisions.",
        owner: "drafter",
    },
    "grill-me": {
        description: "Relentlessly interview the user about a plan or design.",
        owner: "drafter",
    },
    triage: {
        description: "Move an incoming Issue through the configured triage state machine.",
        owner: "drafter",
    },
    "improve-codebase-architecture": {
        description: "Find and explore codebase deepening opportunities.",
        owner: "drafter",
    },
    "setup-matt-pocock-skills": {
        description: "Configure the repository's Issue tracker and domain documentation layout.",
        owner: "drafter",
    },
    "to-spec": {
        description: "Synthesize the current context into a Spec on the configured Issue tracker.",
        owner: "drafter",
    },
    "to-tickets": {
        description: "Break work into tracer-bullet Issues with explicit blocking relationships.",
        owner: "drafter",
    },
    wayfinder: {
        description: "Map and resolve the decisions in a huge, foggy effort.",
        owner: "drafter",
    },
    implement: {
        description: "Implement Ready Work directly or through coordinated Makers.",
        owner: "foreman",
    },
    teach: {
        description: "Run a stateful teaching flow in the current workspace.",
        owner: "tinker",
    },
    handoff: {
        description: "Write a redacted handoff document for a fresh OpenCode session.",
    },
    "writing-great-skills": {
        description: "Apply Matt's vocabulary and principles for predictable skills.",
    },
};
function commandTemplate(skillName) {
    return `Load the \`${skillName}\` Workflow Skill with OpenCode's skill tool and follow it exactly. Treat the text below as the user's arguments and context for that workflow.\n\n$ARGUMENTS`;
}
function skillNameForCommand(commandName) {
    return commandName === "to-tickets" ? "to-issues" : commandName;
}
export function buildWorkshopCommands() {
    return Object.fromEntries(Object.entries(COMMAND_SPECS).map(([name, spec]) => [
        name,
        {
            template: commandTemplate(skillNameForCommand(name)),
            description: spec.description,
            ...("owner" in spec && spec.owner ? { agent: spec.owner } : {}),
        },
    ]));
}
//# sourceMappingURL=commands.js.map
