import { fileURLToPath } from "node:url";
import { defineConfig, configDefaults } from "vitest/config";

/**
 * Offline test baseline for the restored upstream opencode-quota v4.4.1 source
 * (see UPSTREAM-PROVENANCE.md and tests/baseline-boundary.test.ts).
 *
 * The baseline runs fully offline: it reads no real credentials and issues no
 * Provider or network requests. Excluded files are upstream release/repo tooling
 * that requires git exec, npm registry access, the upstream release package.json,
 * .github workflows, or the third-party plugin reference tree
 * (references/upstream-plugins/) — none of which are part of this bundle's
 * runtime or source validation. The reference tree and its sync/review tooling
 * are deliberately absent from the local baseline (see UPSTREAM-PROVENANCE.md):
 * the upstream-plugin tests below are retained byte-for-byte as upstream history
 * originals, but they are NOT part of the local baseline and must stay excluded.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    environment: "node",
    cache: false,
    include: ["tests/**/*.test.ts"],
    exclude: [
      ...configDefaults.exclude,
      // All automated TUI tests are excluded per the maintainer decision: visual
      // OpenCode Home/TUI confirmation is maintainer-owned, not automated. This
      // glob covers every tests/tui-*.test.ts now and in the future; the fast
      // lane (npm run test:quota-zh:fast) selects an explicit non-TUI subset.
      "tests/tui-*.test.ts",
      // Release/repo tooling that executes git or expects the upstream repo layout.
      "tests/release-gates.test.ts",
      "tests/verify-release-version.test.ts",
      "tests/package-manifest.test.ts",
      "tests/github-workflows.test.ts",
      // Reads the fork runtime package.json (name/version differ from upstream).
      "tests/v4-migration-docs.test.ts",
      // Validates the upstream release artifact (esbuild/babel TUI bundle) in dist/.
      "tests/tui-dist-packaging.test.ts",
      // Upstream plugin-reference sync/review tooling tests. Their scripts
      // (scripts/{sync-upstream-plugin-references,check-upstream-plugin-updates,
      // prepare-upstream-plugin-review}.mjs) and lib helpers (scripts/lib/
      // upstream-plugin-*.mjs) target the removed third-party
      // references/upstream-plugins tree, which is not part of the local baseline.
      // The tests are kept byte-for-byte as upstream history originals but are NOT
      // part of the local offline baseline: they cannot run without the removed
      // tooling/tree and must stay excluded.
      "tests/upstream-plugin-identity.test.ts",
      "tests/upstream-plugin-issues.test.ts",
      "tests/upstream-plugin-lock.test.ts",
      "tests/upstream-plugin-reference-integrity.test.ts",
      "tests/upstream-plugin-registry.test.ts",
      "tests/upstream-plugin-review.test.ts",
      "tests/upstream-plugin-sanitization.test.ts",
      "tests/upstream-plugin-specs.test.ts",
      "tests/upstream-plugin-sync.test.ts",
      // Validates the removed third-party Cursor OAuth plugin reference snapshot
      // (references/upstream-plugins/opencode-cursor-oauth), not bundle
      // runtime/source. Retained byte-for-byte as an upstream history original,
      // but the reference tree is not part of the local baseline, so this test is
      // NOT part of the local offline baseline and must stay excluded.
      "tests/upstream.cursor-oauth.reference.test.ts",
    ],
    setupFiles: ["tests/setup.ts"],
  },
});
