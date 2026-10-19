import { resolve } from "path";

import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";

/**
 * OpenCode's SQLite database path, resolved the way OpenCode 2 does
 * (`packages/cli/src/database-path.ts`): `OPENCODE_DB` (absolute, or relative
 * to the data dir; `:memory:` passes through), else `<data dir>/opencode.db`.
 *
 * Credentials, sessions, and messages all live in this one database.
 */
export function getOpenCodeDbPath(): string {
  const override = process.env.OPENCODE_DB?.trim();
  if (override === ":memory:") return override;
  return resolve(getOpencodeRuntimeDirs().dataDir, override || "opencode.db");
}
