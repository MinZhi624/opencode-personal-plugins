import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const packageJsonPath = path.join(repoRoot, "package.json");

const packageJsonRaw = await readFile(packageJsonPath, "utf8");
const packageJson = JSON.parse(packageJsonRaw);
const packageVersion = typeof packageJson.version === "string" ? packageJson.version : "";

if (!packageVersion) {
  console.error("package.json is missing a valid string version");
  process.exit(1);
}

const githubRef = process.env.GITHUB_REF ?? "";
const tagPrefix = "refs/tags/";

if (!githubRef.startsWith(tagPrefix)) {
  console.log("No tag ref detected; skipping release version verification.");
  process.exit(0);
}

const rawTag = githubRef.slice(tagPrefix.length);
const tagVersion = rawTag.startsWith("v") ? rawTag.slice(1) : rawTag;

if (!tagVersion) {
  console.error(`Unable to parse tag version from GITHUB_REF=${githubRef}`);
  process.exit(1);
}

if (tagVersion !== packageVersion) {
  console.error(
    `Version mismatch: tag ${rawTag} expects ${tagVersion}, but package.json has ${packageVersion}`,
  );
  process.exit(1);
}

console.log(`Release version verified: ${rawTag} matches package.json ${packageVersion}`);
