import {
  createProviderApiKeyResolver,
  getGlobalOpencodeConfigCandidatePaths,
} from "./api-key-resolver.js";
import { getAuthPaths, readAuthFile } from "./opencode-auth.js";

export interface KiloApiKeyResult {
  key: string;
  source: KiloKeySource;
}

export type KiloKeySource = "env:KILO_API_KEY" | "opencode.json" | "opencode.jsonc" | "auth.json";

export { getGlobalOpencodeConfigCandidatePaths as getOpencodeConfigCandidatePaths } from "./api-key-resolver.js";

const kiloApiKeyResolver = createProviderApiKeyResolver<KiloKeySource>({
  envVars: [{ name: "KILO_API_KEY", source: "env:KILO_API_KEY" }],
  providerKeys: ["kilo"],
  allowedEnvVars: ["KILO_API_KEY"],
  configJsonSource: "opencode.json",
  configJsoncSource: "opencode.jsonc",
  getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
  auth: {
    readAuth: readAuthFile,
    getAuthPaths,
    authSource: "auth.json",
  },
});

export async function resolveKiloApiKey(): Promise<KiloApiKeyResult | null> {
  return kiloApiKeyResolver.resolve();
}

export async function hasKiloApiKey(): Promise<boolean> {
  return kiloApiKeyResolver.has();
}

export async function getKiloKeyDiagnostics(): Promise<{
  configured: boolean;
  source: KiloKeySource | null;
  checkedPaths: string[];
  authPaths: string[];
}> {
  return kiloApiKeyResolver.diagnostics();
}
