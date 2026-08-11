import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { homedir, platform } from "os";
import { join } from "path";

import { parseJsonOrJsonc } from "./jsonc.js";
import { getAuthPaths } from "./opencode-auth.js";
import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";
import { getQuotaProviderRuntimeIds } from "./provider-metadata.js";
import {
  CURSOR_LEGACY_PROVIDER_ID,
} from "./cursor-pricing.js";
import type { AuthData, CursorOAuthAuthData } from "./types.js";

export interface CursorAuthPresence {
  state: "missing" | "present" | "invalid";
  selectedPath?: string;
  presentPaths: string[];
  candidatePaths: string[];
  error?: string;
}

export interface CursorOpenCodeIntegration {
  pluginEnabled: boolean;
  providerConfigured: boolean;
  matchedPaths: string[];
  checkedPaths: string[];
}

export const CURSOR_CANONICAL_PLUGIN_PACKAGE = "@playwo/opencode-cursor-oauth";
const CURSOR_LEGACY_PLUGIN_PACKAGES = ["opencode-cursor", "opencode-cursor-oauth"];
const CURSOR_COMPAT_PLUGIN_PACKAGES = new Set([
  CURSOR_CANONICAL_PLUGIN_PACKAGE,
  ...CURSOR_LEGACY_PLUGIN_PACKAGES,
  CURSOR_LEGACY_PROVIDER_ID,
  "open-cursor",
  "@rama_nigg/open-cursor",
]);
const CURSOR_COMPAT_PLUGIN_SUFFIXES = [
  `/${CURSOR_CANONICAL_PLUGIN_PACKAGE}`,
  ...CURSOR_LEGACY_PLUGIN_PACKAGES.map((pkg) => `/${pkg}`),
  "/open-cursor",
];

function dedupe(list: string[]): string[] {
  return [...new Set(list.filter(Boolean))];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function getCursorHomeDir(): string {
  return process.env.CURSOR_ACP_HOME_DIR?.trim() || homedir();
}

export function getCursorAuthCandidatePaths(): string[] {
  const home = getCursorHomeDir();
  const authFiles = ["cli-config.json", "auth.json"];
  const paths: string[] = [];

  if (platform() === "darwin") {
    for (const file of authFiles) paths.push(join(home, ".cursor", file));
    for (const file of authFiles) paths.push(join(home, ".config", "cursor", file));
  } else {
    for (const file of authFiles) paths.push(join(home, ".config", "cursor", file));

    const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
    if (xdgConfigHome && xdgConfigHome !== join(home, ".config")) {
      for (const file of authFiles) paths.push(join(xdgConfigHome, "cursor", file));
    }

    for (const file of authFiles) paths.push(join(home, ".cursor", file));
  }

  return dedupe(paths);
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidCursorOAuthEntry(value: unknown): value is CursorOAuthAuthData {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return entry.type === "oauth" && (hasNonEmptyString(entry.refresh) || hasNonEmptyString(entry.access));
}

export async function inspectCursorAuthPresence(): Promise<CursorAuthPresence> {
  const authCandidatePaths = getAuthPaths();
  const legacyCandidatePaths = getCursorAuthCandidatePaths();
  const candidatePaths = dedupe([...authCandidatePaths, ...legacyCandidatePaths]);
  const presentPaths = candidatePaths.filter((path) => existsSync(path));
  let invalidPath: string | undefined;
  let invalidError: string | undefined;

  for (const path of authCandidatePaths) {
    if (!existsSync(path)) continue;

    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as AuthData;
      const cursorAuth = parsed?.cursor;

      if (!cursorAuth) continue;
      if (isValidCursorOAuthEntry(cursorAuth)) {
        return {
          state: "present",
          selectedPath: path,
          presentPaths,
          candidatePaths,
        };
      }

      invalidPath ??= path;
      invalidError ??= "Cursor auth entry in auth.json is missing a valid oauth token payload";
    } catch (error) {
      invalidPath ??= path;
      invalidError ??= error instanceof Error ? error.message : String(error);
    }
  }

  for (const path of legacyCandidatePaths) {
    if (!existsSync(path)) continue;

    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return {
          state: "present",
          selectedPath: path,
          presentPaths,
          candidatePaths,
        };
      }
    } catch (error) {
      invalidPath ??= path;
      invalidError ??= error instanceof Error ? error.message : String(error);
    }
  }

  if (invalidPath) {
    return {
      state: "invalid",
      selectedPath: invalidPath,
      presentPaths,
      candidatePaths,
      error: invalidError,
    };
  }

  return {
    state: "missing",
    presentPaths,
    candidatePaths,
  };
}

function pluginIncludesCursor(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return (
    CURSOR_COMPAT_PLUGIN_PACKAGES.has(normalized) ||
    CURSOR_COMPAT_PLUGIN_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

function providerConfigIncludesCursor(value: unknown): boolean {
  const providerConfig = asRecord(value);
  if (!providerConfig) return false;
  return getQuotaProviderRuntimeIds("cursor").some((id) =>
    Object.prototype.hasOwnProperty.call(providerConfig, id),
  );
}

function parseOpenCodeConfig(raw: string, isJsonc: boolean): {
  plugin: unknown[];
  provider: Record<string, unknown> | null;
} {
  const parsed = asRecord(parseJsonOrJsonc(raw, isJsonc));
  return {
    plugin: Array.isArray(parsed?.plugin) ? parsed.plugin : [],
    provider: asRecord(parsed?.provider),
  };
}

export async function inspectCursorOpenCodeIntegration(): Promise<CursorOpenCodeIntegration> {
  const { configDirs } = getOpencodeRuntimeDirCandidates();
  const checkedPaths = dedupe(
    [...configDirs, process.cwd()].flatMap((dir) => [
      join(dir, "opencode.json"),
      join(dir, "opencode.jsonc"),
    ]),
  );

  const matchedPaths: string[] = [];
  let pluginEnabled = false;
  let providerConfigured = false;

  for (const path of checkedPaths) {
    if (!existsSync(path)) continue;

    try {
      const raw = await readFile(path, "utf8");
      const { plugin, provider } = parseOpenCodeConfig(raw, path.endsWith(".jsonc"));

      const matchedPlugin = plugin.some(pluginIncludesCursor);
      const matchedProvider = providerConfigIncludesCursor(provider);
      if (matchedPlugin || matchedProvider) {
        matchedPaths.push(path);
      }
      pluginEnabled ||= matchedPlugin;
      providerConfigured ||= matchedProvider;
    } catch {
      // Ignore invalid user configs here and let status output show missing matches.
    }
  }

  return {
    pluginEnabled,
    providerConfigured,
    matchedPaths,
    checkedPaths,
  };
}
