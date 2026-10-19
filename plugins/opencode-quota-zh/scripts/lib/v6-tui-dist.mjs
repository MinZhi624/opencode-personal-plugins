/**
 * Staging for the vendored upstream v6 TUI modules (`src/v6/tui`).
 *
 * Upstream ships its TUI as raw TSX/TS and compiles it with Babel
 * (`scripts/prepare-tui-dist.mjs` upstream: every TSX file under `src` becomes a real
 * `.js` next to the compiled output, and the `.jsx` files `tsc` leaves behind are
 * deleted), so the `.js` import specifiers the TUI uses internally keep resolving.
 *
 * This bundle adds no Babel toolchain. It stages the upstream TSX sources byte-for-byte
 * as raw modules — OpenCode loads them through `@opentui/solid/preload`'s Solid
 * transform, the same way every other TUI in this repo is loaded — and generates one
 * small `.js` re-export per module so upstream's `.js` specifiers resolve unchanged:
 *
 *   src/v6/tui/sidebar.tsx -> dist/v6/tui/sidebar.tsx  (raw, byte-for-byte copy)
 *                            dist/v6/tui/sidebar.js   (generated `export *` re-export)
 *
 * `tsc` never emits these `.tsx` files (`tsconfig.runtime.json` excludes them), so no
 * unloadable `.jsx` artifact is produced; the `verifyProductionOnly` step of both build
 * scripts still rejects a dist that contains one.
 *
 * Both staging scripts (dev and runtime) call this helper, so the two trees stay alike.
 */
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

/** Where the vendored v6 TUI lives, relative to both `src/` and the dist root. */
export const RAW_TUI_ROOT = "v6/tui";
const RAW_TUI_SUFFIX = ".tsx";

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

function toPosix(path) {
  return path.replaceAll("\\", "/");
}

/** The raw TUI modules of a source tree, as `src/`-relative POSIX paths. */
export async function rawTuiModules(srcRoot) {
  const files = await walk(join(srcRoot, RAW_TUI_ROOT));
  return files
    .filter((file) => file.endsWith(RAW_TUI_SUFFIX))
    .map((file) => toPosix(relative(srcRoot, file)))
    .sort();
}

/** True for a dist path that is a staged raw TUI module (allowed next to compiled JS). */
export function isRawTuiModule(relPath) {
  const posix = toPosix(relPath);
  return posix.startsWith(`${RAW_TUI_ROOT}/`) && posix.endsWith(RAW_TUI_SUFFIX);
}

/** The generated `.js` re-export that makes a raw module reachable by its `.js` name. */
function reExportSource(moduleName, hasDefaultExport) {
  const lines = [`export * from "./${moduleName}";`];
  // `export *` never carries a default export; only one vendored TUI module has one.
  if (hasDefaultExport) lines.push(`export { default } from "./${moduleName}";`);
  return `${lines.join("\n")}\n`;
}

function hasDefaultExport(source) {
  return /^export\s+default\b/m.test(source) || /export\s*\{[^}]*\bdefault\b[^}]*\}/m.test(source);
}

/**
 * Copies every raw TUI module into `distDir` and writes its `.js` re-export.
 * Returns the staged `src/`-relative module paths.
 */
export async function stageRawTuiModules({ srcRoot, distDir }) {
  const modules = await rawTuiModules(srcRoot);
  for (const rel of modules) {
    const source = join(srcRoot, rel);
    const target = join(distDir, rel);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    const stem = target.slice(0, -RAW_TUI_SUFFIX.length);
    // A dev build (`jsx: preserve`) also emits `<module>.jsx` for the same source;
    // drop it so the raw module stays the only copy of that module.
    await rm(`${stem}.jsx`, { force: true });
    await rm(`${stem}.jsx.map`, { force: true });
    const moduleName = basename(target);
    const hasDefault = hasDefaultExport(await readFile(source, "utf8"));
    await writeFile(join(dirname(target), `${basename(stem)}.js`), reExportSource(moduleName, hasDefault));
  }
  return modules;
}
