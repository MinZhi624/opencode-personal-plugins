/**
 * Codex CLI auth.json reader (read-only, server side).
 *
 * `codex login` stores its ChatGPT login at `${CODEX_HOME:-~/.codex}/auth.json`
 * with the tokens under a top-level `tokens` object. Those tokens are issued
 * by the ChatGPT login flow and can read the usage endpoint, so the quota
 * background uses them as the last credential candidate when neither the host
 * connection nor OpenCode's own auth.json can read usage.
 *
 * The file belongs to an external tool: it is only read, never written, and a
 * missing or malformed file resolves to "no credential" without throwing so a
 * broken Codex install cannot break the rest of the candidate chain.
 */

import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

import {
  getAccountIdFromJwt,
  getEmailFromJwt,
  OPENAI_CODEX_AUTH_SOURCE_KEY,
  type ResolvedOpenAIOAuth,
} from "./openai.js";

interface CodexAuthFile {
  tokens?: {
    access_token?: unknown;
    refresh_token?: unknown;
    account_id?: unknown;
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Codex CLI login file path (honours CODEX_HOME, defaults to ~/.codex). */
export function getCodexAuthPath(params?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): string {
  const env = params?.env ?? process.env;
  const home = params?.homeDir ?? homedir();
  const codexHome = env.CODEX_HOME?.trim() || join(home, ".codex");
  return join(codexHome, "auth.json");
}

/**
 * Read the Codex CLI login as an OpenAI credential candidate.
 *
 * Returns `{ state: "none" }` when the file is missing, unreadable, or does
 * not match the expected shape; never throws.
 */
export async function readCodexAuthCredential(params?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): Promise<ResolvedOpenAIOAuth> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(getCodexAuthPath(params), "utf8"));
  } catch {
    return { state: "none" };
  }

  const tokens =
    parsed && typeof parsed === "object" ? (parsed as CodexAuthFile).tokens : undefined;
  const accessToken = nonEmptyString(tokens?.access_token);
  if (!accessToken) {
    return { state: "none" };
  }

  return {
    state: "configured",
    sourceKey: OPENAI_CODEX_AUTH_SOURCE_KEY,
    accessToken,
    refreshToken: nonEmptyString(tokens?.refresh_token),
    // Codex keeps the ChatGPT account id in the file, not only in the token
    // claims; it is what the usage endpoint expects in ChatGPT-Account-Id.
    accountId: nonEmptyString(tokens?.account_id) ?? getAccountIdFromJwt(accessToken) ?? undefined,
    email: getEmailFromJwt(accessToken) ?? undefined,
  };
}

/** True when a usable Codex CLI login exists. */
export async function hasOpenAICodexAuth(): Promise<boolean> {
  return (await readCodexAuthCredential()).state === "configured";
}
