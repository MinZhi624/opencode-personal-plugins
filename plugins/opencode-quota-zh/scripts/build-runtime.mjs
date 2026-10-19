/**
 * Ticket 02 runtime build: generates the reproducible runtime distribution
 * (plugins/opencode-quota-zh/dist) from src/.
 *
 * The runtime distribution is generated, never hand-maintained:
 *   1. tsc compiles src/ to plain ESM .js (tsconfig.runtime.json, outDir=dist);
 *      the vendored v6 TUI .tsx modules are excluded, so no .jsx is emitted;
 *   2. src/data/modelsdev-pricing.min.json is copied verbatim;
 *   3. the vendored v6 tree (src/v6) ships its own data snapshot next to its
 *      compiled output, because v6 reads it relative to its own module URL;
 *   4. the raw vendored v6 TUI modules (src/v6/tui, every TSX file) are staged
 *      byte-for-byte with a generated .js re-export each, so their upstream .js import
 *      specifiers resolve without a Babel toolchain (see scripts/lib/v6-tui-dist.mjs);
 *   5. the v2 TUI entry (src/tui-v2.tsx) is copied byte-for-byte, because
 *      OpenCode loads it as raw TSX (config/cli.json points at
 *      dist/tui-v2.tsx). It is excluded from the tsc pass so no .jsx
 *      duplicates are emitted.
 *
 * Invocation:
 *   node scripts/build-runtime.mjs            # writes dist/
 *
 * The build is deterministic: the same src/ always yields the same dist/.
 * Staging (scripts/stage-runtime.mjs) only admits production output plus the
 * plugin metadata files; sources and dev config never ship.
 */
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSync, typescriptInvocation } from "./lib/cross-platform-command.mjs";
import { isRawTuiModule, stageRawTuiModules } from "./lib/v6-tui-dist.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(rootDir, "dist");
const srcDir = join(rootDir, "src");

// The TUI entry pair is loaded by OpenCode as raw TSX; it is copied from src
// byte-for-byte instead of being compiled.
const TUI_ENTRY_FILES = ["tui-v2.tsx"];

// Data snapshots are read at runtime relative to the module that loads them, so each
// tree keeps its own copy: the local core's and the vendored v6 core's.
const DATA_SNAPSHOTS = ["data/modelsdev-pricing.min.json", "v6/data/modelsdev-pricing.min.json"];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const full = join(directory, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
      }),
    )
  ).flat();
}

async function verifyProductionOnly(target) {
  const violations = [];
  for (const file of await walk(target)) {
    const rel = relative(target, file);
    if (TUI_ENTRY_FILES.includes(rel)) continue;
    if (isRawTuiModule(rel)) continue;
    for (const suffix of [".ts", ".tsx", ".d.ts", ".map", ".jsx"]) {
      if (rel.endsWith(suffix)) violations.push(`unexpected non-production artifact in runtime dist: ${rel}`);
    }
  }
  if (violations.length) throw new Error(violations.join("\n"));
}

async function build(target) {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  // tsc is invoked through the shared cross-platform interface.
  runSync(typescriptInvocation(), ["--project", join(rootDir, "tsconfig.runtime.json"), "--outDir", target], {
    cwd: rootDir,
    stdio: "inherit",
  });
  for (const snapshot of DATA_SNAPSHOTS) {
    await mkdir(dirname(join(target, snapshot)), { recursive: true });
    await copyFile(join(srcDir, snapshot), join(target, snapshot));
  }
  await stageRawTuiModules({ srcRoot: srcDir, distDir: target });
  for (const entry of TUI_ENTRY_FILES) {
    await copyFile(join(rootDir, "src", entry), join(target, entry));
  }
  await verifyProductionOnly(target);
  return target;
}

await build(distDir);
console.log(`quota-zh runtime dist regenerated from src: ${distDir}`);
