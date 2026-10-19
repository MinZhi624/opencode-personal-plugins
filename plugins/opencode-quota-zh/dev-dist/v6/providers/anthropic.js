/**
 * Anthropic Claude: the 5h, weekly, Usage Credits and Fable weekly windows of each Claude login
 * stored in OpenCode, or of the login the Claude CLI or its credentials file holds.
 */
import { getAnthropicDiagnostics, hasAnthropicCredentialsConfigured, queryAnthropicQuota, queryAnthropicQuotaWithOAuth, } from "../lib/anthropic.js";
import { resolveAnthropicOAuth } from "../lib/anthropic-auth.js";
import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import { credentialRowAuthEntry, readCredentialRows } from "../lib/opencode-auth.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { FIVE_HOUR, failedAccount, fetchEachLogin, quotaRow, WEEKLY, } from "./contract.js";
import { statusDetailsFromRecord } from "./result-helpers.js";
function formatWindowDetail(window) {
    return window
        ? `${window.percentRemaining}% reset_at=${window.resetTimeIso ?? "(none)"}`
        : undefined;
}
/** The 5h, Weekly, Usage Credits and Fable weekly rows of one Claude account. */
function quotaRows(quota, method) {
    const rows = [
        quotaRow({
            ...FIVE_HOUR,
            percentRemaining: quota.five_hour.percentRemaining,
            resetsAt: quota.five_hour.resetTimeIso,
        }),
        quotaRow({
            ...WEEKLY,
            percentRemaining: quota.seven_day.percentRemaining,
            resetsAt: quota.seven_day.resetTimeIso,
        }),
    ];
    if (quota.extra_usage) {
        rows.push(quotaRow({
            key: "extra_usage",
            label: "Extra usage",
            window: "month",
            percentRemaining: quota.extra_usage.percentRemaining,
        }));
    }
    if (quota.fable_weekly) {
        rows.push(quotaRow({
            key: "weekly_fable",
            label: "Fable",
            window: "week",
            percentRemaining: quota.fable_weekly.percentRemaining,
            resetsAt: quota.fable_weekly.resetTimeIso,
        }));
    }
    return rows.map((row) => ({ ...row, method }));
}
export const anthropicProvider = {
    id: "anthropic",
    async isAvailable(ctx) {
        const providerAvailable = await isCanonicalProviderAvailable({
            ctx,
            providerId: "anthropic",
            fallbackOnError: false,
        });
        if (!providerAvailable)
            return false;
        return await hasAnthropicCredentialsConfigured({
            binaryPath: ctx.config?.anthropicBinaryPath,
        });
    },
    matchesCurrentModel(model) {
        return model.toLowerCase().startsWith("anthropic/");
    },
    async fetch(ctx) {
        const options = {
            binaryPath: ctx.config?.anthropicBinaryPath,
            requestTimeoutMs: ctx.config?.requestTimeoutMs,
        };
        let debug;
        let method = "local_cli";
        // A failed login stays in the list so it shows as its own error.
        const logins = (await readCredentialRows(["anthropic"], { methods: ["oauth"] })).flatMap((row) => {
            if (row.integrationId !== "anthropic")
                return [];
            const auth = resolveAnthropicOAuth({ anthropic: credentialRowAuthEntry(row) });
            return auth.state === "configured" || auth.state === "failed" ? [{ row, auth }] : [];
        });
        try {
            const diagnostics = await getAnthropicDiagnostics(options);
            const quota = diagnostics.quotaSupported ? diagnostics.quota : undefined;
            if (diagnostics.quotaSupported && diagnostics.quotaSource !== "claude-auth-status-json") {
                method = "remote_api";
            }
            debug = statusDetailsFromRecord({
                cli_installed: diagnostics.installed ? "true" : "false",
                cli_version: diagnostics.version ?? "(none)",
                binary_path: diagnostics.binaryPath ?? "(none)",
                auth_status: diagnostics.authStatus,
                quota_supported: diagnostics.quotaSupported ? "true" : "false",
                quota_source: diagnostics.quotaSource === "none" ? "(none)" : diagnostics.quotaSource,
                oauth_credential_source: diagnostics.oauthCredentialSource ?? "(none)",
                checked_commands: diagnostics.checkedCommands.join(" | ") || "(none)",
                message: diagnostics.message,
                five_hour_remaining: formatWindowDetail(quota?.five_hour),
                seven_day_remaining: formatWindowDetail(quota?.seven_day),
                fable_weekly_remaining: formatWindowDetail(quota?.fable_weekly),
            });
        }
        catch (error) {
            debug = statusDetailsFromRecord({
                cli_installed: "false",
                message: `failed to probe Claude CLI: ${sanitizeDisplayText(error instanceof Error ? error.message : String(error))}`,
            });
        }
        if (logins.length > 0) {
            const accounts = await fetchEachLogin({
                providerName: "Claude",
                logins,
                async fetchLogin({ auth }) {
                    const result = auth.state === "failed"
                        ? {
                            success: false,
                            error: `Anthropic sign-in could not be read: ${auth.error}. Run \`opencode auth login anthropic\`.`,
                        }
                        : await queryAnthropicQuotaWithOAuth(auth.accessToken, options.requestTimeoutMs);
                    if (!result)
                        return null;
                    if (!result.success)
                        return { rows: [], errors: [{ message: result.error }] };
                    return { rows: quotaRows(result, "remote_api"), errors: [] };
                },
            });
            return { attempted: true, accounts, debug };
        }
        const result = await queryAnthropicQuota(options);
        if (!result)
            return { attempted: false, accounts: [], debug };
        if (!result.success) {
            return { attempted: true, accounts: [failedAccount("Claude", result.error)], debug };
        }
        return {
            attempted: true,
            accounts: [{ name: "Claude", rows: quotaRows(result, method), errors: [] }],
            debug,
        };
    },
};
