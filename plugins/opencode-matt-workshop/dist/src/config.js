import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkshopAgents } from "./agents.js";
import { buildWorkshopCommands } from "./commands.js";
const replacedAgents = ["build", "plan", "general", "explore", "scout"];
function skillsPath() {
    const candidates = [new URL("../skills", import.meta.url), new URL("../../skills", import.meta.url)];
    const match = candidates.map((path) => fileURLToPath(path)).find(existsSync);
    if (!match)
        throw new Error("opencode-matt-workshop: adapted skills directory not found");
    if (existsSync(join(match, "..", ".matt-sync-in-progress")))
        throw new Error("opencode-matt-workshop: incomplete Matt skill sync detected");
    return match;
}
export const WORKSHOP_SKILLS_PATH = skillsPath();
export function applyWorkshopConfig(config, options) {
    config.agent ??= {};
    if (options.replace_builtin_agents) {
        for (const id of replacedAgents)
            config.agent[id] = { ...(config.agent[id] ?? {}), disable: true };
    }
    Object.assign(config.agent, buildWorkshopAgents(options));
    config.default_agent = "tinker";
    config.skills ??= {};
    const paths = config.skills.paths ?? [];
    if (!paths.includes(WORKSHOP_SKILLS_PATH))
        config.skills.paths = [...paths, WORKSHOP_SKILLS_PATH];
    config.command ??= {};
    Object.assign(config.command, buildWorkshopCommands());
}
