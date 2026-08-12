/**
 * Ticket 02 runtime build: generates the reproducible runtime distribution
 * (plugins/opencode-quota-zh/dist) from src/.
 *
 * The runtime distribution is generated, never hand-maintained:
 *   1. tsc compiles src/ to plain ESM .js (tsconfig.runtime.json, outDir=dist);
 *   2. src/data/modelsdev-pricing.min.json is copied verbatim;
 *   3. the single supported TUI entry pair (src/tui.tsx and its directly
 *      imported src/quota-zh-sidebar.tsx) is copied byte-for-byte, because
 *      OpenCode loads them as raw TSX (config/tui.jsonc points at
 *      dist/tui.tsx). They are excluded from the tsc pass so no .jsx
 *      duplicates are emitted.
 *
 * Invocation:
 *   node scripts/build-runtime.mjs            # writes dist/
 *   node scripts/build-runtime.mjs --check    # builds to a temp dir and
 *                                             # compares byte-for-byte with the
 *                                             # committed dist/; fails on any
 *                                             # difference (clean-build
 *                                             # reproducibility gate)
 *
 * The build is deterministic: the same src/ always yields the same dist/.
 * Staging (scripts/stage-runtime.mjs) only admits production output plus the
 * plugin metadata files; sources, tests, fixtures and dev config never ship.
 */
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSync, typescriptInvocation } from "./lib/cross-platform-command.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(rootDir, "dist");
const checkMode = process.argv.includes("--check");

// The TUI entry pair is loaded by OpenCode as raw TSX; it is copied from src
// byte-for-byte instead of being compiled.
const TUI_ENTRY_FILES = ["tui.tsx", "quota-zh-sidebar.tsx"];

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
    for (const suffix of [".ts", ".tsx", ".d.ts", ".map", ".jsx"]) {
      if (rel.endsWith(suffix)) violations.push(`unexpected non-production artifact in runtime dist: ${rel}`);
    }
  }
  if (violations.length) throw new Error(violations.join("\n"));
}

async function fileDigest(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function treeDigests(directory) {
  const digests = new Map();
  for (const file of (await walk(directory)).sort()) {
    digests.set(relative(directory, file).replaceAll("\\", "/"), await fileDigest(file));
  }
  return digests;
}

async function build(target) {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  // tsc is invoked through the shared cross-platform interface; the CLI
  // --outDir overrides tsconfig.runtime.json so --check can emit to a temp dir.
  runSync(typescriptInvocation(), ["--project", join(rootDir, "tsconfig.runtime.json"), "--outDir", target], {
    cwd: rootDir,
    stdio: "inherit",
  });
  await mkdir(join(target, "data"), { recursive: true });
  await copyFile(join(rootDir, "src", "data", "modelsdev-pricing.min.json"), join(target, "data", "modelsdev-pricing.min.json"));
  for (const entry of TUI_ENTRY_FILES) {
    await copyFile(join(rootDir, "src", entry), join(target, entry));
  }
  await verifyProductionOnly(target);
  return target;
}

if (checkMode) {
  const temp = await mkdtemp(join(tmpdir(), "quota-zh-dist-"));
  try {
    await build(temp);
    const expected = await treeDigests(distDir);
    const actual = await treeDigests(temp);
    if (expected.size === 0) throw new Error("runtime dist is empty; committed dist missing");
    const problems = [];
    for (const [file, digest] of expected) {
      if (actual.get(file) !== digest) problems.push(`dist/${file} differs from clean build`);
    }
    for (const [file] of actual) {
      if (!expected.has(file)) problems.push(`dist/${file} is missing from the committed dist`);
    }
    if (problems.length) throw new Error(`Committed runtime dist is not reproducible:\n${problems.join("\n")}`);
    console.log(`Runtime dist byte-identical to clean build (${expected.size} files).`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
} else {
  await build(distDir);
  console.log(`quota-zh runtime dist regenerated from src: ${distDir}`);
}
