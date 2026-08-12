/**
 * Ticket 01 dev-only build: compiles the restored upstream v4.4.1 TypeScript
 * source into plugins/opencode-quota-zh/dev-dist.
 *
 * This is NOT the runtime distribution: it never writes to plugins/opencode-quota-zh/dist
 * (the current Chinese runtime stays byte-for-byte untouched) and its output is
 * excluded from runtime staging (see scripts/stage-runtime.mjs).
 *
 * Mirrors the upstream build pipeline (tsc + copy-data) with the output redirected
 * to the dev baseline location. The runtime distribution is generated separately
 * by scripts/build-runtime.mjs (see tsconfig.runtime.json; the upstream
 * esbuild/babel TUI bundling in prepare-tui-dist.mjs is retained as upstream
 * history only and is superseded by that pipeline's raw-TSX entry copies).
 */
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSync, typescriptInvocation } from "./lib/cross-platform-command.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const devDist = join(rootDir, "dev-dist");

await rm(devDist, { recursive: true, force: true });
// Invoke the TypeScript compiler through the shared cross-platform interface:
// Windows runs the bare `tsc` via cmd.exe (shell) so PATHEXT resolves
// tsc.cmd; POSIX runs the executable directly without a shell.
runSync(typescriptInvocation(), ["--project", join(rootDir, "tsconfig.json")], { cwd: rootDir, stdio: "inherit" });
await mkdir(join(devDist, "data"), { recursive: true });
await copyFile(
  join(rootDir, "src", "data", "modelsdev-pricing.min.json"),
  join(devDist, "data", "modelsdev-pricing.min.json"),
);

console.log(`quota-zh dev build written to ${devDist} (runtime dist/ untouched)`);
