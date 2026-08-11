import { spawn } from "child_process";
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

export const DEFAULT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

function parseEnabled(value) {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(normalized);
}

function parseMaxAgeMs(value) {
  if (!value) return DEFAULT_MAX_AGE_MS;
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) return DEFAULT_MAX_AGE_MS;
  return Math.floor(days * 24 * 60 * 60 * 1000);
}

export function shouldAutoRefresh(meta, nowMs, maxAgeMs = DEFAULT_MAX_AGE_MS) {
  const generatedAt = Number(meta?.generatedAt);
  if (!Number.isFinite(generatedAt) || generatedAt <= 0) return true;
  return nowMs - generatedAt > maxAgeMs;
}

async function readSnapshotMeta() {
  const snapshotUrl = new URL("../src/data/modelsdev-pricing.min.json", import.meta.url);
  const raw = await readFile(snapshotUrl, "utf8");
  const parsed = JSON.parse(raw);
  const meta = parsed?._meta;
  return meta && typeof meta === "object" ? meta : null;
}

function runRefreshScript() {
  const scriptPath = fileURLToPath(new URL("./refresh-modelsdev-pricing.mjs", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`refresh-modelsdev-pricing.mjs exited with code ${code ?? "unknown"}`));
    });
  });
}

export async function main() {
  if (!parseEnabled(process.env.OPENCODE_QUOTA_PRICING_AUTO_REFRESH)) {
    console.log("Skipping pricing auto-refresh: OPENCODE_QUOTA_PRICING_AUTO_REFRESH disables it.");
    return;
  }

  const maxAgeMs = parseMaxAgeMs(process.env.OPENCODE_QUOTA_PRICING_MAX_AGE_DAYS);
  const nowMs = Date.now();

  let meta = null;
  try {
    meta = await readSnapshotMeta();
  } catch {
    meta = null;
  }

  if (!shouldAutoRefresh(meta, nowMs, maxAgeMs)) {
    const generatedAt = Number(meta?.generatedAt);
    const ageMs = Math.max(0, nowMs - generatedAt);
    console.log(
      `Pricing snapshot is fresh (age ${ageMs}ms <= max ${maxAgeMs}ms). Skipping auto-refresh.`,
    );
    return;
  }

  console.log(
    `Pricing snapshot is stale or missing (max age ${maxAgeMs}ms). Refreshing from models.dev...`,
  );
  try {
    await runRefreshScript();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `Pricing auto-refresh failed (${message}). Continuing build with the existing bundled snapshot.`,
    );
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
