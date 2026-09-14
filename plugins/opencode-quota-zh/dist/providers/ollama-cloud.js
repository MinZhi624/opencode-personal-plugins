/**
 * Ollama Cloud provider wrapper.
 *
 * Queries the Ollama Cloud usage API and reports session/weekly quota.
 */
import { queryOllamaCloudQuota } from "../lib/ollama-cloud.js";
import { getOllamaCloudKeyDiagnostics, hasOllamaCloudApiKey } from "../lib/ollama-cloud-config.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import { attemptedResult, mapNullableProviderResult, simpleApiKeyStatusDetails, statusDetailsFromRecord, withStatusDetails, } from "./result-helpers.js";
const OLLAMA_CLOUD_PROVIDER_LABEL = "Ollama Cloud";
const REMOTE_API_ACCOUNTING = {
    acquisitionMethod: "remote_api",
    ownership: "maintained",
    authority: "provider_reported",
};
function mapOllamaCloudSuccess(result) {
    const entries = [];
    if (result.session) {
        entries.push({
            accounting: {
                resultType: "quota",
                ...REMOTE_API_ACCOUNTING,
            },
            name: `${OLLAMA_CLOUD_PROVIDER_LABEL} Session`,
            group: OLLAMA_CLOUD_PROVIDER_LABEL,
            label: "Session:",
            percentRemaining: result.session.percentRemaining,
        });
    }
    if (result.weekly) {
        entries.push({
            accounting: {
                resultType: "quota",
                ...REMOTE_API_ACCOUNTING,
            },
            name: `${OLLAMA_CLOUD_PROVIDER_LABEL} Weekly`,
            group: OLLAMA_CLOUD_PROVIDER_LABEL,
            label: "Weekly:",
            percentRemaining: result.weekly.percentRemaining,
        });
    }
    const errors = (result.rowErrors ?? []).map((message) => ({
        label: OLLAMA_CLOUD_PROVIDER_LABEL,
        message,
    }));
    if (entries.length === 0) {
        errors.push({
            label: OLLAMA_CLOUD_PROVIDER_LABEL,
            message: "No usable Ollama Cloud usage data",
        });
    }
    return withStatusDetails(attemptedResult(entries, errors), [
        ...statusDetailsFromRecord({
            session_usage_fraction: result.session?.usageFraction.toString(),
            weekly_usage_fraction: result.weekly?.usageFraction.toString(),
        }),
        ...(result.rowErrors ?? []).map((message, index) => ({
            key: `live_error_${index + 1}`,
            value: message,
        })),
    ]);
}
export const ollamaCloudProvider = {
    id: "ollama-cloud",
    async isAvailable(_ctx) {
        return await hasOllamaCloudApiKey();
    },
    matchesCurrentModel(model) {
        return modelProviderMatchesRuntimeId(model, "ollama-cloud");
    },
    async fetch(ctx) {
        const diagnostics = await getOllamaCloudKeyDiagnostics().catch(() => ({
            configured: false,
            source: null,
            checkedPaths: [],
            authPaths: [],
        }));
        const result = await queryOllamaCloudQuota({
            requestTimeoutMs: ctx.config?.requestTimeoutMs,
        });
        const providerResult = mapNullableProviderResult(result, {
            errorLabel: OLLAMA_CLOUD_PROVIDER_LABEL,
            onSuccess: mapOllamaCloudSuccess,
        });
        return withStatusDetails(providerResult, [
            ...simpleApiKeyStatusDetails(diagnostics),
            ...(providerResult.statusDetails ?? []),
        ]);
    },
};
