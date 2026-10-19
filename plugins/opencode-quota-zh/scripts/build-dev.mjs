/**
 * Ticket 01 dev-only build: compiles the restored upstream TypeScript source into
 * plugins/opencode-quota-zh/dev-dist, including the vendored v6 tree (src/v6).
 *
 * This is NOT the runtime distribution: it never writes to plugins/opencode-quota-zh/dist
 * (the current Chinese runtime stays byte-for-byte untouched) and its output is
 * excluded from runtime staging (see scripts/stage-runtime.mjs).
 *
 * Mirrors the upstream build pipeline (tsc + data copy) with the output redirected
 * to the dev baseline location. The vendored v6 TUI modules are staged the same way
 * the runtime build stages them (raw TSX plus a generated .js re-export), so dev-dist
 * stays loadable and free of the .jsx files `jsx: preserve` would otherwise leave.
 * The runtime distribution is generated separately by scripts/build-runtime.mjs
 * (see tsconfig.runtime.json), which copies the raw TSX entry instead of bundling it.
 */
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSync, typescriptInvocation } from "./lib/cross-platform-command.mjs";
import { stageRawTuiModules } from "./lib/v6-tui-dist.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const devDist = join(rootDir, "dev-dist");
const srcDir = join(rootDir, "src");

const DATA_SNAPSHOTS = ["data/modelsdev-pricing.min.json", "v6/data/modelsdev-pricing.min.json"];

await rm(devDist, { recursive: true, force: true });
// Invoke the TypeScript compiler through the shared cross-platform interface:
// Windows runs the bare `tsc` via cmd.exe (shell) so PATHEXT resolves
// tsc.cmd; POSIX runs the executable directly without a shell.
runSync(typescriptInvocation(), ["--project", join(rootDir, "tsconfig.json")], { cwd: rootDir, stdio: "inherit" });
for (const snapshot of DATA_SNAPSHOTS) {
  await mkdir(dirname(join(devDist, snapshot)), { recursive: true });
  await copyFile(join(srcDir, snapshot), join(devDist, snapshot));
}
await stageRawTuiModules({ srcRoot: srcDir, distDir: devDist });

console.log(`quota-zh dev build written to ${devDist} (runtime dist/ untouched)`);
