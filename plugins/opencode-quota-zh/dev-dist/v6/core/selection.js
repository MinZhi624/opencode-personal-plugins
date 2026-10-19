import { getCanonicalQuotaProviderId, getQuotaProviderIdsForRuntimeId, } from "../lib/provider-metadata.js";
export function matchesQuotaProviderCurrentSelection(params) {
    const matchesCurrentModel = (model) => params.provider.matchesCurrentModel
        ? params.provider.matchesCurrentModel(model, {
            enabledProviders: params.enabledProviders ?? "auto",
            automaticDiscovery: params.automaticDiscovery,
            ...(params.quotaProviders ? { quotaProviders: params.quotaProviders } : {}),
            ...(params.currentProviderID ? { currentProviderID: params.currentProviderID } : {}),
        })
        : true;
    if (params.provider.id === "quota-providers") {
        if (params.currentModel)
            return matchesCurrentModel(params.currentModel);
        if (!params.currentProviderID)
            return false;
        return Boolean(params.quotaProviders?.some((source) => source.enabled !== false &&
            source.providerId === params.currentProviderID &&
            source.modelIds === undefined));
    }
    if (params.currentProviderID) {
        const explicitId = params.currentProviderID.trim().toLowerCase();
        if (getCanonicalQuotaProviderId(explicitId) === explicitId) {
            return params.provider.id === explicitId;
        }
        const runtimeCandidates = getQuotaProviderIdsForRuntimeId(explicitId);
        if (runtimeCandidates.length === 1)
            return params.provider.id === runtimeCandidates[0];
        if (runtimeCandidates.length > 1) {
            if (!runtimeCandidates.some((candidate) => candidate === params.provider.id)) {
                return false;
            }
            if (!params.currentModel || !params.provider.matchesCurrentModel)
                return false;
            const qualifiedModel = params.currentModel.toLowerCase().startsWith(`${explicitId}/`)
                ? params.currentModel
                : `${explicitId}/${params.currentModel}`;
            return matchesCurrentModel(qualifiedModel);
        }
        return false;
    }
    return params.currentModel ? matchesCurrentModel(params.currentModel) : false;
}
