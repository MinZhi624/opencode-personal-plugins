import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
function manifestPath() {
    const candidates = [new URL("../skill-manifest.json", import.meta.url), new URL("../../skill-manifest.json", import.meta.url)];
    const match = candidates.find((candidate) => existsSync(fileURLToPath(candidate)));
    if (!match)
        throw new Error("opencode-matt-workshop: skill manifest not found");
    return fileURLToPath(match);
}
export const manifest = JSON.parse(readFileSync(manifestPath(), "utf8"));
export const skillNames = manifest.skills.map((skill) => skill.name);
export const skillByName = new Map(manifest.skills.map((skill) => [skill.name, skill]));
