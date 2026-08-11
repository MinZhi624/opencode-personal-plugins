import { mkdir, rename, rm, writeFile } from "fs/promises";
import { dirname } from "path";
import { fileURLToPath } from "url";

const SOURCE_URL = "https://models.dev/api.json";
const DEFAULT_PROVIDERS = ["anthropic", "google", "moonshotai", "openai", "xai", "zai"];
const COST_KEYS = ["input", "output", "cache_read", "cache_write"];
const FETCH_TIMEOUT_MS = 15_000;

function parseProviderArgs(argv) {
  const providerArg = argv.find((arg) => arg.startsWith("--providers="));
  if (!providerArg) return DEFAULT_PROVIDERS;

  const raw = providerArg.slice("--providers=".length).trim();
  if (!raw) return DEFAULT_PROVIDERS;

  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function pickCostBuckets(rawCost) {
  if (!rawCost || typeof rawCost !== "object") return null;
  const picked = {};

  for (const key of COST_KEYS) {
    const value = rawCost[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      picked[key] = value;
    }
  }

  return Object.keys(picked).length > 0 ? picked : null;
}

function sortObjectByKeys(obj) {
  const sorted = {};
  for (const key of Object.keys(obj).sort((a, b) => a.localeCompare(b))) {
    sorted[key] = obj[key];
  }
  return sorted;
}

async function fetchModelsDevJson() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(SOURCE_URL, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch ${SOURCE_URL}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function writeFileAtomic(path, content) {
  const dir = dirname(path);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  await mkdir(dir, { recursive: true });
  await writeFile(tmp, content, "utf8");

  const safeRm = async (target) => {
    try {
      await rm(target, { force: true });
    } catch {
      // best-effort cleanup
    }
  };

  try {
    await rename(tmp, path);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
    const shouldRetryAsReplace =
      code === "EPERM" || code === "EEXIST" || code === "EACCES" || code === "ENOTEMPTY";

    if (!shouldRetryAsReplace) {
      await safeRm(tmp);
      throw err;
    }

    await safeRm(path);
    await rename(tmp, path);
  }
}

function buildSnapshot(api, providerIDs) {
  const providers = {};

  for (const providerID of providerIDs) {
    const models = api?.[providerID]?.models;
    if (!models || typeof models !== "object") continue;

    const pricedModels = {};
    for (const modelID of Object.keys(models)) {
      const cost = pickCostBuckets(models[modelID]?.cost);
      if (cost) pricedModels[modelID] = cost;
    }

    if (Object.keys(pricedModels).length > 0) {
      providers[providerID] = sortObjectByKeys(pricedModels);
    }
  }

  const providerList = Object.keys(providers).sort((a, b) => a.localeCompare(b));

  return {
    _meta: {
      generatedAt: Date.now(),
      providers: providerList,
      source: SOURCE_URL,
      units: "USD per 1M tokens",
    },
    providers,
  };
}

async function main() {
  const providerIDs = parseProviderArgs(process.argv.slice(2));
  const api = await fetchModelsDevJson();
  const snapshot = buildSnapshot(api, providerIDs);

  const outPath = new URL("../src/data/modelsdev-pricing.min.json", import.meta.url);
  await writeFileAtomic(fileURLToPath(outPath), `${JSON.stringify(snapshot, null, 2)}\n`);

  console.log(
    `Wrote ${outPath.pathname} with ${snapshot._meta.providers.length} providers and ${Object.values(snapshot.providers).reduce((sum, models) => sum + Object.keys(models).length, 0)} priced models.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
