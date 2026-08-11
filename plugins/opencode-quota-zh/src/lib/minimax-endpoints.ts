export type MiniMaxQuotaEndpointId = "international" | "china";

export interface MiniMaxQuotaEndpoint {
  id: MiniMaxQuotaEndpointId;
  label: string;
  apiBaseUrl: string;
  quotaUrl: string;
}

export const MINIMAX_QUOTA_ENDPOINTS: Readonly<Record<MiniMaxQuotaEndpointId, MiniMaxQuotaEndpoint>> = {
  international: {
    id: "international",
    label: "MiniMax International",
    apiBaseUrl: "https://api.minimax.io",
    quotaUrl: "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
  },
  china: {
    id: "china",
    label: "MiniMax China",
    apiBaseUrl: "https://api.minimaxi.com",
    // CN Token Plan docs use this path on minimaxi.com; api.minimaxi.com returns MiniMax base_resp auth errors for it.
    quotaUrl: "https://api.minimaxi.com/v1/token_plan/remains",
  },
};

export function getMiniMaxQuotaEndpoint(id: MiniMaxQuotaEndpointId): MiniMaxQuotaEndpoint {
  return MINIMAX_QUOTA_ENDPOINTS[id];
}
