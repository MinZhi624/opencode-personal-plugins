/**
 * Ticket 02 runtime-boundary golden tests.
 *
 * Locks the current Chinese v1.0.1 user-facing behavior with fixtures drawn
 * from the PRE-Ticket-01 runtime distribution (plugins/opencode-quota-zh/dist):
 * scripts/capture-runtime-golden.mjs executed the shipped dist modules and
 * recorded their outputs (plus byte snapshots of the TUI runtime entry files).
 *
 * These tests run against src/ (the hand-maintained truth). Passing proves
 * source behavior reproduces the pre-existing runtime outputs — the fixture
 * expectations are runtime outputs, never implementation details.
 *
 * The wall clock is pinned to FIXED_NOW_MS (fake timers) and the timezone to
 * Asia/Shanghai, matching the capture environment.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.TZ = "Asia/Shanghai";

import {
  FIXED_NOW_MS,
  compactStatusErrorOnlySample,
  compactStatusNarrowSample,
  compactStatusSample,
  formatUtilsSample,
  quotaCommandSample,
  sessionTokensSample,
  statsReportCompactSample,
  statsReportSample,
  statsReportSessionSample,
  syntheticModelsDevApi,
} from "./fixtures/runtime-golden/samples.mjs";

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN_DIR = join(PLUGIN_DIR, "tests", "fixtures", "runtime-golden");

async function readFixtureJson(name) {
  return JSON.parse(await readFile(join(GOLDEN_DIR, name), "utf8"));
}

async function readFixtureText(name) {
  return await readFile(join(GOLDEN_DIR, name), "utf8");
}

beforeEach(() => {
  vi.useFakeTimers({
    now: FIXED_NOW_MS,
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("/quota command output (Chinese runtime golden)", () => {
  it("reproduces the pre-existing runtime /quota output byte-for-byte", async () => {
    const { formatQuotaCommand } = await import("../src/lib/quota-command-format.js");
    const fixture = await readFixtureJson("quota-command-format.json");
    expect(formatQuotaCommand(quotaCommandSample)).toBe(fixture.formatQuotaCommand);
  });
});

describe("command surface (Chinese runtime golden)", () => {
  it("registers exactly the v1.0.1 command ids in v1.0.1 order", async () => {
    const { QUOTA_DIALOG_COMMANDS } = await import("../src/lib/quota-dialog-commands.js");
    const fixture = await readFixtureJson("quota-dialog-commands.json");
    expect(QUOTA_DIALOG_COMMANDS.map((spec) => spec.id)).toEqual(fixture.commandIds);
  });

  it("reproduces the v1.0.1 command titles/descriptions/kinds for /quota, /quota_status, /tokens_*", async () => {
    const { QUOTA_DIALOG_COMMANDS } = await import("../src/lib/quota-dialog-commands.js");
    const fixture = await readFixtureJson("quota-dialog-commands.json");
    const serializeCommand = (spec) => {
      const out = {};
      for (const key of [
        "id",
        "slashName",
        "template",
        "title",
        "metadataTitle",
        "description",
        "kind",
        "windowMs",
        "dialogSize",
        "requiresSession",
        "acceptsArguments",
        "topModels",
        "topSessions",
      ]) {
        if (spec[key] !== undefined) out[key] = spec[key];
      }
      if (typeof spec.titleForRange === "function") {
        out.titleForRange = spec.titleForRange("2026-01-01", "2026-01-15");
      }
      return out;
    };
    expect(QUOTA_DIALOG_COMMANDS.map(serializeCommand)).toEqual(fixture.QUOTA_DIALOG_COMMANDS);
  });
});

describe("/tokens_* report output (Chinese runtime golden)", () => {
  it("reproduces the standard weekly report rendering", async () => {
    const { formatQuotaStatsReport } = await import("../src/lib/quota-stats-format.js");
    const fixture = await readFixtureJson("quota-stats-format.json");
    expect(formatQuotaStatsReport(statsReportSample)).toBe(fixture.standard);
  });

  it("reproduces the compact/narrow-width report rendering", async () => {
    const { formatQuotaStatsReport } = await import("../src/lib/quota-stats-format.js");
    const fixture = await readFixtureJson("quota-stats-format.json");
    expect(formatQuotaStatsReport(statsReportCompactSample)).toBe(fixture.compact);
  });

  it("reproduces the session-scoped report rendering", async () => {
    const { formatQuotaStatsReport } = await import("../src/lib/quota-stats-format.js");
    const fixture = await readFixtureJson("quota-stats-format.json");
    expect(formatQuotaStatsReport(statsReportSessionSample)).toBe(fixture.session);
  });
});

describe("format-utils (Chinese runtime golden)", () => {
  it("reproduces displayed-percent labels, token counts, and Chinese reset countdown", async () => {
    const formatUtils = await import("../src/lib/format-utils.js");
    const fixture = await readFixtureJson("format-utils.json");
    expect(formatUtilsSample.formatDisplayedPercentLabel.map(([value, mode]) =>
      formatUtils.formatDisplayedPercentLabel(value, mode),
    )).toEqual(fixture.formatDisplayedPercentLabel);
    expect(formatUtilsSample.formatTokenCount.map((value) => formatUtils.formatTokenCount(value))).toEqual(
      fixture.formatTokenCount,
    );
    expect(formatUtilsSample.formatResetCountdown.map(({ iso, opts }) =>
      formatUtils.formatResetCountdown(iso, opts),
    )).toEqual(fixture.formatResetCountdown);
  });
});

describe("session-tokens-format (Chinese runtime golden)", () => {
  it("reproduces the heading and wide/narrow/sidebar-summary rendering", async () => {
    const { SESSION_TOKEN_SECTION_HEADING, renderSessionTokensLines, renderSidebarSessionTokenSummaryLines } =
      await import("../src/lib/session-tokens-format.js");
    const fixture = await readFixtureJson("session-tokens-format.json");
    expect(SESSION_TOKEN_SECTION_HEADING).toBe(fixture.SESSION_TOKEN_SECTION_HEADING);
    expect(renderSessionTokensLines(sessionTokensSample.sessionTokens, sessionTokensSample.renderWide)).toEqual(
      fixture.wide,
    );
    expect(renderSessionTokensLines(sessionTokensSample.sessionTokens, sessionTokensSample.renderNarrow)).toEqual(
      fixture.narrow,
    );
    expect(
      renderSessionTokensLines(sessionTokensSample.sessionTokens, sessionTokensSample.renderVeryNarrow),
    ).toEqual(fixture.veryNarrow);
    expect(
      renderSidebarSessionTokenSummaryLines(sessionTokensSample.sessionTokens, sessionTokensSample.sidebarSummary),
    ).toEqual(fixture.sidebarSummary);
  });
});

describe("compact status (Chinese runtime golden)", () => {
  it("reproduces the compact status line (normal, narrow, error-only)", async () => {
    const { buildCompactQuotaStatusLine } = await import("../src/lib/tui-compact-format.js");
    const fixture = await readFixtureJson("tui-compact-format.json");
    expect(buildCompactQuotaStatusLine(compactStatusSample)).toBe(fixture.normal);
    expect(buildCompactQuotaStatusLine(compactStatusNarrowSample)).toBe(fixture.narrow);
    expect(buildCompactQuotaStatusLine(compactStatusErrorOnlySample)).toBe(fixture.errorOnly);
  });
});

describe("pricing semantics (Chinese runtime golden)", () => {
  it("builds the models.dev snapshot with reasoning costs and no fixed provider allowlist", async () => {
    const modelsdevPricing = await import("../src/lib/modelsdev-pricing.js");
    const fixture = await readFixtureJson("modelsdev-pricing.json");

    modelsdevPricing.__resetPricingSnapshotForTests();
    const runtimeRoot = await mkdtemp(join(tmpdir(), "quota-zh-pricing-golden-"));
    const runtimeDirs = {
      dataDir: join(runtimeRoot, "data"),
      configDir: join(runtimeRoot, "config"),
      cacheDir: join(runtimeRoot, "cache"),
      stateDir: join(runtimeRoot, "state"),
    };
    try {
      const result = await modelsdevPricing.maybeRefreshPricingSnapshot({
        runtimeDirs,
        nowMs: FIXED_NOW_MS,
        force: true,
        fetchFn: async () =>
          new Response(JSON.stringify(syntheticModelsDevApi), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      });
      expect({
        attempted: result.attempted,
        updated: result.updated,
        reason: result.reason ?? null,
        error: result.error ?? null,
      }).toEqual(fixture.refresh);

      const snapshotPath = modelsdevPricing.getRuntimePricingSnapshotPath(runtimeDirs);
      const snapshotJson = await readFile(snapshotPath, "utf8");
      expect(snapshotJson).toBe(fixture.snapshotJson);
    } finally {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });
});

describe("TUI runtime entry (Chinese runtime golden)", () => {
  it("preserves the pre-Ticket-01 tui.tsx byte snapshot as provenance", async () => {
    const fixture = await readFixtureText("tui.tsx.runtime");
    expect(fixture.length).toBeGreaterThan(0);
    expect(fixture).toContain("ChineseSidebarContentView");
    expect(fixture).toContain("quota-zh-sidebar");
  });

  it("preserves the pre-Ticket-01 quota-zh-sidebar.tsx byte snapshot as provenance", async () => {
    const fixture = await readFixtureText("quota-zh-sidebar.tsx.runtime");
    expect(fixture.length).toBeGreaterThan(0);
    expect(fixture).toContain("ChineseSidebarContentView");
    expect(fixture).toContain("collectQuotaRenderData");
  });

  it("ships the TUI entry pair byte-identical to src (generated, not hand-maintained)", async () => {
    // The v1.0.1 byte-identity contract ended at Ticket 04/05: upstream v4.5.1
    // async registration and v4.6.0 initial-load reuse were synced into
    // src/tui.tsx and src/quota-zh-sidebar.tsx, so the runtime entries
    // legitimately diverge from the pre-Ticket-01 snapshots (still preserved
    // as provenance above). The generated-runtime contract is that dist/tui.tsx
    // and dist/quota-zh-sidebar.tsx are byte copies of src.
    const srcTui = await readFile(join(PLUGIN_DIR, "src", "tui.tsx"), "utf8");
    const distTui = await readFile(join(PLUGIN_DIR, "dist", "tui.tsx"), "utf8");
    const srcSidebar = await readFile(join(PLUGIN_DIR, "src", "quota-zh-sidebar.tsx"), "utf8");
    const distSidebar = await readFile(join(PLUGIN_DIR, "dist", "quota-zh-sidebar.tsx"), "utf8");
    expect(distTui).toBe(srcTui);
    expect(distSidebar).toBe(srcSidebar);
  });
});

describe("TUI runtime entrypoint invariants", () => {
  it("commits exactly one supported generated TUI entrypoint: dist/tui.tsx", async () => {
    const distDir = join(PLUGIN_DIR, "dist");
    await expect(readFile(join(distDir, "tui.tsx"), "utf8")).resolves.toBeTruthy();
    await expect(readFile(join(distDir, "quota-zh-sidebar.tsx"), "utf8")).resolves.toBeTruthy();
    await expect(readFile(join(distDir, "tui.js"), "utf8")).rejects.toThrow(/ENOENT/);
    await expect(readFile(join(distDir, "tui.jsx"), "utf8")).rejects.toThrow(/ENOENT/);
    await expect(readFile(join(distDir, "tui.d.ts"), "utf8")).rejects.toThrow(/ENOENT/);
  });
});

describe("runtime dist file set is production-only", () => {
  it("contains no sources, declarations, maps, or tsc .jsx duplicates besides the supported TUI entry", async () => {
    // The supported TUI entry is loaded by OpenCode as raw TSX (tui.jsonc
    // points at dist/tui.tsx, which imports ./quota-zh-sidebar.tsx). Everything
    // else in dist must be plain .js/.json production output: no .ts sources,
    // no .d.ts/.map artifacts, no tsc-emitted .jsx duplicates.
    const { readdir, stat } = await import("node:fs/promises");
    const distDir = join(PLUGIN_DIR, "dist");
    const tuiEntryFiles = new Set(["tui.tsx", "quota-zh-sidebar.tsx"]);
    const entries = await readdir(distDir, { recursive: true });
    for (const entry of entries) {
      const full = join(distDir, entry);
      if ((await stat(full)).isFile()) {
        if (tuiEntryFiles.has(entry)) continue;
        expect(entry.endsWith(".ts") || entry.endsWith(".tsx"), `unexpected source in dist: ${entry}`).toBe(false);
        expect(entry.endsWith(".d.ts"), `unexpected declaration in dist: ${entry}`).toBe(false);
        expect(entry.endsWith(".map"), `unexpected source map in dist: ${entry}`).toBe(false);
        expect(entry.endsWith(".jsx"), `unexpected tsc jsx artifact in dist: ${entry}`).toBe(false);
      }
    }
  });
});
