export type KimiQuotaEndpointId = "global" | "cn";

interface KimiQuotaEndpoint {
  id: KimiQuotaEndpointId;
  label: string;
  apiBaseUrl: string;
  quotaUrl: string;
}

const KIMI_QUOTA_ENDPOINTS: Readonly<Record<KimiQuotaEndpointId, KimiQuotaEndpoint>> = {
  global: {
    id: "global",
    label: "Kimi Code",
    apiBaseUrl: "https://api.kimi.ai/coding/v1",
    quotaUrl: "https://api.kimi.ai/coding/v1/usages",
  },
  cn: {
    id: "cn",
    label: "Kimi Code (CN)",
    apiBaseUrl: "https://api.kimi.com/coding/v1",
    quotaUrl: "https://api.kimi.com/coding/v1/usages",
  },
};

export function getKimiQuotaEndpoint(id: KimiQuotaEndpointId): KimiQuotaEndpoint {
  return KIMI_QUOTA_ENDPOINTS[id];
}
