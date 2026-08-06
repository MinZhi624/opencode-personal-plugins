import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkshopAgents } from "./agents.js";
import { buildWorkshopCommands } from "./commands.js";
const REPLACED_AGENT_IDS = ["build", "plan", "general", "explore", "scout"];
function resolveSkillsPath() {
    const candidates = [new URL("../skills", import.meta.url), new URL("../../skills", import.meta.url)];
    const match = candidates.map((candidate) => fileURLToPath(candidate)).find(existsSync);
    if (!match)
        throw new Error("opencode-matt-workshop: adapted skills directory not found");
    if (existsSync(join(match, "..", ".matt-sync-in-progress"))) {
        throw new Error("opencode-matt-workshop: incomplete Matt skill sync detected");
    }
    return match;
}
export const WORKSHOP_SKILLS_PATH = resolveSkillsPath();
export function applyWorkshopConfig(config, options) {
    const workshopConfig = config;
    workshopConfig.agent ??= {};
    if (options.replace_builtin_agents) {
        for (const agentId of REPLACED_AGENT_IDS) {
            workshopConfig.agent[agentId] = {
                ...(workshopConfig.agent[agentId] ?? {}),
                disable: true,
            };
        }
    }
    Object.assign(workshopConfig.agent, buildWorkshopAgents(options));
    workshopConfig.default_agent = "tinker";
    workshopConfig.skills ??= {};
    const paths = workshopConfig.skills.paths ?? [];
    if (!paths.includes(WORKSHOP_SKILLS_PATH)) {
        workshopConfig.skills.paths = [...paths, WORKSHOP_SKILLS_PATH];
    }
    workshopConfig.command ??= {};
    for (const [name, command] of Object.entries(buildWorkshopCommands())) {
        if (workshopConfig.command[name]) {
            console.warn(`opencode-matt-workshop: replacing existing /${name} command`);
        }
        workshopConfig.command[name] = command;
    }
}
//# sourceMappingURL=config.js.map