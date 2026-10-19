import { homedir } from "os";
import { join, resolve } from "path";

export interface OpencodeRuntimeDirs {
  dataDir: string;
  configDir: string;
  cacheDir: string;
  stateDir: string;
}

/**
 * OpenCode 2's global dirs (oc2 packages/util/src/global-roots.ts): one dir per
 * kind on every platform, `$XDG_<KIND>_HOME/opencode` or the XDG default under
 * the home dir. `OPENCODE_CONFIG_DIR` replaces the config dir
 * (oc2 packages/cli/src/index.ts `Global.layerWith({ config })`).
 */
export function getOpencodeRuntimeDirs(params?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): OpencodeRuntimeDirs {
  const env = params?.env ?? process.env;
  const home = params?.homeDir ?? homedir();

  const dataBase = env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
  const configBase = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  const cacheBase = env.XDG_CACHE_HOME?.trim() || join(home, ".cache");
  const stateBase = env.XDG_STATE_HOME?.trim() || join(home, ".local", "state");
  const configuredConfigDir = env.OPENCODE_CONFIG_DIR?.trim();

  return {
    dataDir: join(dataBase, "opencode"),
    configDir: configuredConfigDir ? resolve(configuredConfigDir) : join(configBase, "opencode"),
    cacheDir: join(cacheBase, "opencode"),
    stateDir: join(stateBase, "opencode"),
  };
}
