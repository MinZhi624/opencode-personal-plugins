/**
 * OpenCode Quota Plugin
 *
 * Shows quota status in OpenCode without LLM invocation.
 *
 * @packageDocumentation
 */
import { Plugin } from "@opencode/plugin";
import { queryDeepSeekBalance } from "./lib/deepseek.js";
import { queryOpenAIQuota } from "./lib/openai.js";
import { quotaRpc } from "./quota-rpc.js";
function resetText(resetTimeIso) {
    if (!resetTimeIso)
        return "";
    const remaining = Date.parse(resetTimeIso) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0)
        return " · 即将重置";
    const minutes = Math.ceil(remaining / 60_000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const mins = minutes % 60;
    return ` · 重置 ${days ? `${days}天` : ""}${hours ? `${hours}小时` : ""}${mins}分`;
}
// Quota queries and rendering are registered by the CLI plugin. This server
// entry reserves the bundle ID for server-only credentials and alerts.
export default Plugin.define({
    id: "opencode-quota-zh",
    async setup(context) {
        await context.rpc.register(quotaRpc, {
            async snapshot() {
                const lines = [];
                let providerCount = 0;
                for (const integrationID of ["openai", "chatgpt", "codex"]) {
                    const connection = await context.integration.connection.active(integrationID);
                    if (!connection)
                        continue;
                    const credential = await context.integration.connection.resolve(connection);
                    if (credential?.type !== "oauth")
                        continue;
                    const result = await queryOpenAIQuota({ credential });
                    if (result?.success) {
                        providerCount++;
                        lines.push(result.label);
                        for (const [label, window] of [
                            ["5h", result.windows.hourly],
                            ["Weekly", result.windows.weekly],
                            ["Monthly", result.windows.monthly],
                            ["Code Review", result.windows.codeReview],
                        ]) {
                            if (window)
                                lines.push(`${label}: ${Math.round(window.percentRemaining)}% 剩余${resetText(window.resetTimeIso)}`);
                        }
                    }
                    break;
                }
                const deepseekConnection = await context.integration.connection.active("deepseek");
                if (deepseekConnection) {
                    const credential = await context.integration.connection.resolve(deepseekConnection);
                    if (credential?.type === "key") {
                        const result = await queryDeepSeekBalance({ apiKey: credential.key });
                        if (result?.success) {
                            providerCount++;
                            lines.push("DeepSeek");
                            for (const balance of result.balanceInfos) {
                                if (balance.totalBalance !== undefined)
                                    lines.push(`余额: ${balance.currency} ${balance.totalBalance}`);
                            }
                        }
                    }
                }
                return { lines, providerCount };
            },
        });
    },
});
// Re-export types for consumers (types are erased at runtime, so safe to export)
export { QUOTA_PROVIDER_MODES, QUOTA_PROVIDER_REMOTE_FORMATS, QUOTA_PROVIDER_WINDOW_TYPES, validateQuotaProviders, } from "./lib/quota-providers.js";
