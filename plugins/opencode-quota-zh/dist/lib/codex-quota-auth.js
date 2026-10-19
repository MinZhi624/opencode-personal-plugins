/** Local compatibility adapter. Read-only; Codex CLI owns login and refresh. */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveOpenAIOAuth } from "../v6/lib/openai.js";
export async function readCodexQuotaAuth() {
    try {
        const path = join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "auth.json");
        const data = JSON.parse(await readFile(path, "utf8"));
        const tokens = data?.tokens;
        if (typeof tokens?.access_token !== "string" || !tokens.access_token.trim())
            return;
        const auth = resolveOpenAIOAuth({
            codex: {
                type: "oauth",
                access: tokens.access_token,
                ...(typeof tokens.account_id === "string" && tokens.account_id.trim()
                    ? { accountId: tokens.account_id.trim() } : {}),
            },
        });
        if (auth.state !== "configured")
            return undefined;
        // Codex's selected account takes precedence over a token's default account.
        if (typeof tokens.account_id === "string" && tokens.account_id.trim()) {
            auth.accountId = tokens.account_id.trim();
        }
        return auth;
    }
    catch {
        // Missing/malformed external credentials must not break host accounts.
        return undefined;
    }
}
