/**
 * Ticket 02 one-time golden capture: executes the PRE-Ticket-01 runtime
 * distribution (plugins/opencode-quota-zh/dist, the current Chinese v1.0.1
 * runtime) and records its user-facing outputs as golden fixtures under
 * tests/fixtures/runtime-golden/.
 *
 * The fixtures are "drawn from the pre-existing runtime outputs": they are
 * produced by executing the shipped dist modules (never by asserting on
 * implementation details), plus byte snapshots of the TUI runtime entry files
 * that OpenCode loads directly (dist/tui.tsx, dist/quota-zh-sidebar.tsx).
 *
 * Usage (must run BEFORE regenerating dist from source):
 *   node plugins/opencode-quota-zh/scripts/capture-runtime-golden.mjs
 *
 * The wall clock is pinned to FIXED_NOW_MS so the captured outputs are
 * deterministic and reproducible by tests/runtime-golden.test.ts (which pins
 * the same clock with fake timers).
 */
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Pin the timezone so local-time rendering (formatLocalCallTimestamp etc.) is
// deterministic and identical to tests/runtime-golden.test.ts.
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
} from "../tests/fixtures/runtime-golden/samples.mjs";

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(pluginDir, "dist");
const fixtureDir = join(pluginDir, "tests", "fixtures", "runtime-golden");

// Pin the wall clock: new Date() and Date.now() both return FIXED_NOW_MS.
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(FIXED_NOW_MS);
    else super(...args);
  }
  static now() {
    return FIXED_NOW_MS;
  }
};

const quotaCommandFormat = await import(join(distDir, "lib", "quota-command-format.js"));
const quotaDialogCommands = await import(join(distDir, "lib", "quota-dialog-commands.js"));
const quotaStatsFormat = await import(join(distDir, "lib", "quota-stats-format.js"));
const formatUtils = await import(join(distDir, "lib", "format-utils.js"));
const sessionTokensFormat = await import(join(distDir, "lib", "session-tokens-format.js"));
const tuiCompactFormat = await import(join(distDir, "lib", "tui-compact-format.js"));
const modelsdevPricing = await import(join(distDir, "lib", "modelsdev-pricing.js"));

const fixtures = {};

// --- /quota command output -------------------------------------------------
fixtures["quota-command-format.json"] = {
  _fixture: {
    runtime: "plugins/opencode-quota-zh/dist (pre-Ticket-01 Chinese v1.0.1 runtime)",
    surface: "/quota verbose command output",
    clock: new RealDate(FIXED_NOW_MS).toISOString(),
  },
  formatQuotaCommand: quotaCommandFormat.formatQuotaCommand(quotaCommandSample),
};

// --- command surface (QUOTA_DIALOG_COMMANDS registry) ----------------------
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

fixtures["quota-dialog-commands.json"] = {
  _fixture: {
    runtime: "plugins/opencode-quota-zh/dist (pre-Ticket-01 Chinese v1.0.1 runtime)",
    surface: "/quota, /quota_status, /tokens_* command registry (ids, order, Chinese titles)",
    clock: new RealDate(FIXED_NOW_MS).toISOString(),
  },
  QUOTA_DIALOG_COMMANDS: quotaDialogCommands.QUOTA_DIALOG_COMMANDS.map(serializeCommand),
  commandIds: quotaDialogCommands.QUOTA_DIALOG_COMMANDS.map((spec) => spec.id),
};

// --- /tokens_* report outputs ----------------------------------------------
fixtures["quota-stats-format.json"] = {
  _fixture: {
    runtime: "plugins/opencode-quota-zh/dist (pre-Ticket-01 Chinese v1.0.1 runtime)",
    surface: "/tokens_* markdown report rendering (standard, compact/narrow, session)",
    clock: new RealDate(FIXED_NOW_MS).toISOString(),
  },
  standard: quotaStatsFormat.formatQuotaStatsReport(statsReportSample),
  compact: quotaStatsFormat.formatQuotaStatsReport(statsReportCompactSample),
  session: quotaStatsFormat.formatQuotaStatsReport(statsReportSessionSample),
};

// --- format-utils ----------------------------------------------------------
fixtures["format-utils.json"] = {
  _fixture: {
    runtime: "plugins/opencode-quota-zh/dist (pre-Ticket-01 Chinese v1.0.1 runtime)",
    surface: "displayed-percent labels, token counts, reset countdown (Chinese units)",
    clock: new RealDate(FIXED_NOW_MS).toISOString(),
  },
  formatDisplayedPercentLabel: formatUtilsSample.formatDisplayedPercentLabel.map(([value, mode]) =>
    formatUtils.formatDisplayedPercentLabel(value, mode),
  ),
  formatTokenCount: formatUtilsSample.formatTokenCount.map((value) => formatUtils.formatTokenCount(value)),
  formatResetCountdown: formatUtilsSample.formatResetCountdown.map(({ iso, opts }) =>
    formatUtils.formatResetCountdown(iso, opts),
  ),
};

// --- session-tokens-format -------------------------------------------------
fixtures["session-tokens-format.json"] = {
  _fixture: {
    runtime: "plugins/opencode-quota-zh/dist (pre-Ticket-01 Chinese v1.0.1 runtime)",
    surface: "session token section heading + wide/narrow/sidebar-summary rendering",
    clock: new RealDate(FIXED_NOW_MS).toISOString(),
  },
  SESSION_TOKEN_SECTION_HEADING: sessionTokensFormat.SESSION_TOKEN_SECTION_HEADING,
  wide: sessionTokensFormat.renderSessionTokensLines(sessionTokensSample.sessionTokens, sessionTokensSample.renderWide),
  narrow: sessionTokensFormat.renderSessionTokensLines(sessionTokensSample.sessionTokens, sessionTokensSample.renderNarrow),
  veryNarrow: sessionTokensFormat.renderSessionTokensLines(sessionTokensSample.sessionTokens, sessionTokensSample.renderVeryNarrow),
  sidebarSummary: sessionTokensFormat.renderSidebarSessionTokenSummaryLines(
    sessionTokensSample.sessionTokens,
    sessionTokensSample.sidebarSummary,
  ),
};

// --- compact status --------------------------------------------------------
fixtures["tui-compact-format.json"] = {
  _fixture: {
    runtime: "plugins/opencode-quota-zh/dist (pre-Ticket-01 Chinese v1.0.1 runtime)",
    surface: "TUI compact status line (normal, narrow, error-only)",
    clock: new RealDate(FIXED_NOW_MS).toISOString(),
  },
  normal: tuiCompactFormat.buildCompactQuotaStatusLine(compactStatusSample),
  narrow: tuiCompactFormat.buildCompactQuotaStatusLine(compactStatusNarrowSample),
  errorOnly: tuiCompactFormat.buildCompactQuotaStatusLine(compactStatusErrorOnlySample),
};

// --- pricing semantics (modelsdev snapshot build) --------------------------
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
  const snapshotPath = modelsdevPricing.getRuntimePricingSnapshotPath(runtimeDirs);
  const snapshotJson = await readFile(snapshotPath, "utf8");

  fixtures["modelsdev-pricing.json"] = {
    _fixture: {
      runtime: "plugins/opencode-quota-zh/dist (pre-Ticket-01 Chinese v1.0.1 runtime)",
      surface:
        "models.dev snapshot build: reasoning cost bucket picked; no fixed provider allowlist (deepseek included)",
      clock: new RealDate(FIXED_NOW_MS).toISOString(),
    },
    refresh: {
      attempted: result.attempted,
      updated: result.updated,
      reason: result.reason ?? null,
      error: result.error ?? null,
    },
    snapshotJson,
    snapshot: JSON.parse(snapshotJson),
  };
} finally {
  await rm(runtimeRoot, { recursive: true, force: true });
}

// --- TUI runtime entry byte snapshots --------------------------------------
await mkdir(fixtureDir, { recursive: true });
await copyFile(join(distDir, "tui.tsx"), join(fixtureDir, "tui.tsx.runtime"));
await copyFile(join(distDir, "quota-zh-sidebar.tsx"), join(fixtureDir, "quota-zh-sidebar.tsx.runtime"));

for (const [name, value] of Object.entries(fixtures)) {
  await writeFile(join(fixtureDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

console.log(`Golden fixtures captured from pre-Ticket-01 runtime into ${fixtureDir}`);
console.log(`  command ids: ${fixtures["quota-dialog-commands.json"].commandIds.join(", ")}`);

// Restore the real Date (kept for consistency with the pinned clock above).
globalThis.Date = RealDate;
