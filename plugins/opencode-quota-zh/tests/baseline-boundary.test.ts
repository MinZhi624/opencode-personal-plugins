/**
 * Ticket 01 boundary verification: upstream v4.4.1 source baseline + build/staging boundary.
 *
 * Verifies that:
 *  1. The traceable upstream v4.4.1 source baseline (src/, tests/, fixtures, provenance,
 *     MIT attribution) is present and pinned to commit 73dfcf1a4c4c6214f73993de5c81b22d394ff0a5.
 *  2. The root build command compiles into a dev-only output (dev-dist), never into the
 *     runtime distribution (dist/), and leaves the current dist/ byte-for-byte unchanged.
 *  3. Runtime staging never carries source/tests/fixtures/dev config, and the staged
 *     quota-zh runtime files are byte-identical to the current runtime files.
 *
 * This test must run fully offline: no network, no real credentials, no Provider requests.
 * The shared setup (tests/setup.ts) force-blocks real network egress (fetch and the
 * common node:http/https/net/tls/dns entry points); the guard itself is exercised below.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  npmInvocation,
  runSync,
  typescriptInvocation,
  type CommandInvocation,
} from "../scripts/lib/cross-platform-command.mjs";

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(dirname(PLUGIN_DIR));
const RUNTIME_DIST = join(PLUGIN_DIR, "dist");
const DEV_DIST = join(PLUGIN_DIR, "dev-dist");
const UPSTREAM_COMMIT = "73dfcf1a4c4c6214f73993de5c81b22d394ff0a5";
const UPSTREAM_TAG = "v4.4.1";
const UPSTREAM_TAG_PACKAGE_JSON_VERSION = "4.4.0";

function run(invocation: CommandInvocation, args: string[], cwd: string): { stdout: string; stderr: string } {
  try {
    const stdout = runSync(invocation, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { stdout, stderr: "" };
  } catch (error) {
    const wrapped = error as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return {
      stdout: String(wrapped.stdout ?? ""),
      stderr: `exit ${wrapped.status}: ${String(wrapped.stderr ?? "")}`,
    };
  }
}

function walk(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function treeHashes(directory: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const file of walk(directory).sort()) {
    const hash = createHash("sha256");
    hash.update(readFileSync(file));
    hashes.set(relative(directory, file).replaceAll("\\", "/"), hash.digest("hex"));
  }
  return hashes;
}

const stagedRuntimeRoot = join(REPO_ROOT, "runtime-stage");

afterEach(async () => {
  await rm(stagedRuntimeRoot, { recursive: true, force: true });
});

describe("root bundle check coverage", () => {
  it("runs the quota-zh checks from the default root npm check", () => {
    const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    const check = rootPkg.scripts.check;
    expect(check, "root check must chain check:quota-zh").toContain("npm run check:quota-zh");
    expect(check, "root check must keep the Workshop verification").toContain("npm run check:matt-workshop");
    expect(check, "root check must keep the bundle verification").toContain("scripts/verify.mjs");
    expect(check).toContain("&&");
  });
});

describe("v4.4.1 source baseline is traceable", () => {
  it("restores the upstream TypeScript source and offline test baseline", () => {
    for (const file of [
      "src/index.ts",
      "src/plugin.ts",
      "src/tui.tsx",
      "src/lib/config.ts",
      "src/providers/registry.ts",
      "tests/setup.ts",
      "tests/helpers/plugin-test-harness.ts",
      "tests/fixtures/quota-providers.ts",
    ]) {
      expect(existsSync(join(PLUGIN_DIR, file)), `missing baseline file: ${file}`).toBe(true);
    }
    expect(walk(join(PLUGIN_DIR, "tests", "fixtures")).length).toBeGreaterThan(0);
  });

  it("keeps MIT attribution and provenance pinned to the official v4.4.1 commit", () => {
    const license = readFileSync(join(PLUGIN_DIR, "LICENSE.upstream"), "utf8");
    expect(license).toContain("MIT License");
    expect(license).toContain("Copyright");

    const provenance = JSON.parse(readFileSync(join(PLUGIN_DIR, "upstream-provenance.json"), "utf8"));
    expect(provenance.repository).toBe("https://github.com/slkiser/opencode-quota.git");
    expect(provenance.tag).toBe(UPSTREAM_TAG);
    expect(provenance.commit).toBe(UPSTREAM_COMMIT);
    expect(provenance.versionMismatch.tag).toBe(UPSTREAM_TAG);
    expect(provenance.versionMismatch.packageJsonVersion).toBe(UPSTREAM_TAG_PACKAGE_JSON_VERSION);

    const provenanceDoc = readFileSync(join(PLUGIN_DIR, "UPSTREAM-PROVENANCE.md"), "utf8");
    expect(provenanceDoc).toContain(UPSTREAM_TAG);
    expect(provenanceDoc).toContain(UPSTREAM_COMMIT);
    expect(provenanceDoc).toContain(UPSTREAM_TAG_PACKAGE_JSON_VERSION);
    expect(provenanceDoc).toContain("已知上游错位");
  });

  it("uses the root npm lockfile for repository dependency management", () => {
    expect(existsSync(join(REPO_ROOT, "package-lock.json"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "pnpm-lock.yaml"))).toBe(false);
  });
});

describe("upstream CONTRIBUTING is an upstream reference, not a fork entry point", () => {
  it("keeps the verbatim upstream contributing guide under the upstream reference location", () => {
    const path = join(PLUGIN_DIR, "references", "upstream-quota", "CONTRIBUTING.md");
    expect(existsSync(path), `missing upstream reference: ${path}`).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content).toContain("Contributing to opencode-quota");
    expect(content).toContain("pnpm");
    expect(content).toContain("corepack");
  });

  it("does not present the upstream pnpm workflow as the fork's contributor entry point", () => {
    expect(existsSync(join(PLUGIN_DIR, "CONTRIBUTING.md"))).toBe(false);
  });

  it("documents the upstream reference location in UPSTREAM-PROVENANCE.md", () => {
    const provenanceDoc = readFileSync(join(PLUGIN_DIR, "UPSTREAM-PROVENANCE.md"), "utf8");
    expect(provenanceDoc).toContain("references/upstream-quota/CONTRIBUTING.md");
  });
});

describe("dev build boundary", () => {
  it("declares a dev-only output that is not the runtime distribution", () => {
    const tsconfig = JSON.parse(readFileSync(join(PLUGIN_DIR, "tsconfig.json"), "utf8"));
    expect(tsconfig.compilerOptions.outDir).toBe("./dev-dist");
    expect(tsconfig.compilerOptions.outDir).not.toBe("./dist");
    expect(existsSync(join(PLUGIN_DIR, "scripts", "build-dev.mjs"))).toBe(true);
  });

  it("returns bare CLI names with explicit shell semantics, never platform file names", () => {
    // execFileSync cannot launch Windows shims (npm.cmd/tsc.cmd) directly, so
    // the contract is { command, shell }: Windows resolves the shims through
    // cmd.exe (shell: true), POSIX spawns the executable directly (no shell).
    expect(npmInvocation("win32")).toEqual({ command: "npm", shell: true });
    expect(npmInvocation("linux")).toEqual({ command: "npm", shell: false });
    expect(npmInvocation("darwin")).toEqual({ command: "npm", shell: false });
    expect(typescriptInvocation("win32")).toEqual({ command: "tsc", shell: true });
    expect(typescriptInvocation("linux")).toEqual({ command: "tsc", shell: false });
    expect(typescriptInvocation("darwin")).toEqual({ command: "tsc", shell: false });

    const npm = npmInvocation();
    expect(npm.command).toBe("npm");
    expect(npm.command).not.toMatch(/\.cmd$/);
    expect(npm.shell).toBe(process.platform === "win32");

    const tsc = typescriptInvocation();
    expect(tsc.command).toBe("tsc");
    expect(tsc.command).not.toMatch(/\.cmd$/);
    expect(tsc.shell).toBe(process.platform === "win32");
  });

  it("builds source into dev-dist and leaves dist/ byte-for-byte unchanged", () => {
    const before = treeHashes(RUNTIME_DIST);
    expect(before.size).toBeGreaterThan(0);

    const result = run(npmInvocation(), ["run", "build:quota-zh"], REPO_ROOT);
    expect(result.stderr, `build failed:\n${result.stdout}\n${result.stderr}`).toBe("");
    expect(existsSync(join(DEV_DIST, "index.js"))).toBe(true);
    expect(existsSync(join(DEV_DIST, "lib", "config.js"))).toBe(true);
    expect(existsSync(join(DEV_DIST, "data", "modelsdev-pricing.min.json"))).toBe(true);

    const after = treeHashes(RUNTIME_DIST);
    expect(after.size).toBe(before.size);
    for (const [file, hash] of before) {
      expect(after.get(file), `dist/${file} changed by dev build`).toBe(hash);
    }
  }, 15_000);
});

describe("runtime build boundary", () => {
  it("regenerates dist/ from src/ with the single supported TUI entry and no dev artifacts", () => {
    const result = run(npmInvocation(), ["run", "build:quota-zh:runtime"], REPO_ROOT);
    expect(result.stderr, `runtime build failed:\n${result.stdout}\n${result.stderr}`).toBe("");

    const distFiles = walk(RUNTIME_DIST).map((file) => relative(RUNTIME_DIST, file).replaceAll("\\", "/")).sort();
    expect(distFiles).toContain("index.js");
    expect(distFiles).toContain("lib/config.js");
    expect(distFiles).toContain("data/modelsdev-pricing.min.json");
    expect(distFiles).toContain("bin/opencode-quota.js");
    expect(distFiles).toContain("tui.tsx");
    expect(distFiles).toContain("quota-zh-sidebar.tsx");

    // Exactly one supported TUI entry pair: raw TSX files loaded by OpenCode.
    for (const artifact of ["tui.js", "tui.jsx", "tui.d.ts", "quota-zh-sidebar.jsx"]) {
      expect(existsSync(join(RUNTIME_DIST, artifact)), `unexpected TUI artifact: ${artifact}`).toBe(false);
    }
    for (const file of distFiles) {
      if (file === "tui.tsx" || file === "quota-zh-sidebar.tsx") continue;
      for (const suffix of [".ts", ".tsx", ".d.ts", ".map", ".jsx"]) {
        expect(file.endsWith(suffix), `non-production artifact in dist: ${file}`).toBe(false);
      }
    }
  }, 60_000);

  it("compares the committed dist/ byte-for-byte with a clean build (--check gate)", () => {
    const result = run(npmInvocation(), ["run", "build:quota-zh:runtime", "--", "--check"], REPO_ROOT);
    expect(result.stderr, `runtime reproducibility check failed:\n${result.stdout}\n${result.stderr}`).toBe("");
    expect(result.stdout).toContain("byte-identical to clean build");
  }, 60_000);
});

describe("runtime staging boundary", () => {
  it("accepts --check and rejects quota-zh source/fixtures/dev config in the staged runtime", () => {
    // node.exe is directly spawnable everywhere; only shim CLIs (npm/tsc) need
    // the shell flag.
    const check = run({ command: "node", shell: false }, ["scripts/stage-runtime.mjs", "--check"], REPO_ROOT);
    expect(check.stderr, `stage-runtime --check failed`).toBe("");
    expect(check.stdout).toContain("Runtime staging passed");
  });

  it("stages only current quota-zh runtime files under the runtime allowlist, byte-identical to the source runtime", () => {
    const staged = run({ command: "node", shell: false }, ["scripts/stage-runtime.mjs"], REPO_ROOT);
    expect(staged.stderr, `stage-runtime failed`).toBe("");

    const stagedQuota = join(stagedRuntimeRoot, "plugins", "opencode-quota-zh");
    const stagedFiles = walk(stagedQuota).map((file) => relative(stagedQuota, file).replaceAll("\\", "/"));

    // Single allowlist boundary: every staged quota-zh file must be a runtime file.
    const runtimeAllowlist = /^(dist\/|package\.json$|LICENSE$|README\.zh\.md$)/;
    for (const file of stagedFiles) {
      expect(
        runtimeAllowlist.test(file),
        `runtime staging must not carry non-runtime file: ${file}`,
      ).toBe(true);
    }

    expect(stagedFiles).toContain("dist/index.js");
    expect(stagedFiles).toContain("dist/tui.tsx");
    expect(stagedFiles).toContain("package.json");

    const stagedIndex = readFileSync(join(stagedQuota, "dist", "index.js"), "utf8");
    const sourceIndex = readFileSync(join(RUNTIME_DIST, "index.js"), "utf8");
    expect(stagedIndex).toBe(sourceIndex);
    expect(statSync(join(stagedQuota, "dist", "index.js")).size).toBeGreaterThan(0);
  });
});

describe("offline baseline network guard", () => {
  it("blocks globalThis.fetch when no per-test mock is installed", () => {
    expect(() => globalThis.fetch("https://example.invalid/quota")).toThrow(/offline/i);
  });

  it("blocks node:http get and request", async () => {
    const http = await import("node:http");
    expect(() => http.get("http://example.invalid/")).toThrow(/offline/i);
    expect(() => http.request("http://example.invalid/")).toThrow(/offline/i);
  });

  it("blocks node:https get and request", async () => {
    const https = await import("node:https");
    expect(() => https.get("https://example.invalid/")).toThrow(/offline/i);
    expect(() => https.request("https://example.invalid/")).toThrow(/offline/i);
  });

  it("blocks node:net connect and createConnection", async () => {
    const net = await import("node:net");
    expect(() => net.connect(80, "127.0.0.1")).toThrow(/offline/i);
    expect(() => net.createConnection(80, "127.0.0.1")).toThrow(/offline/i);
  });

  it("blocks node:tls connect", async () => {
    const tls = await import("node:tls");
    expect(() => tls.connect(443, "example.invalid")).toThrow(/offline/i);
  });

  it("blocks node:dns lookup and resolve", async () => {
    const dns = await import("node:dns");
    expect(() => dns.lookup("example.invalid")).toThrow(/offline/i);
    expect(() => dns.resolve("example.invalid")).toThrow(/offline/i);
    expect(() => dns.promises.lookup("example.invalid")).toThrow(/offline/i);
  });
});
