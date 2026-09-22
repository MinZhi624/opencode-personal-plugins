/**
 * OpenCode Quota Plugin
 *
 * Shows quota status in OpenCode without LLM invocation.
 *
 * @packageDocumentation
 */

import { Plugin } from "@opencode/plugin";
import { buildQuotaSidebarCards } from "./lib/quota-sidebar-cards.js";
import { collectQuotaRenderData } from "./lib/quota-render-data.js";
import {
  createQuotaRuntimeRequestContext,
  resolveQuotaRuntimeContext,
} from "./lib/quota-runtime-context.js";
import { quotaRpc } from "./quota-rpc.js";

// The upstream core only needs provider enumeration and the active config;
// both are available from the V2 server context domains.
function createQuotaCoreClient(context: Plugin.Context) {
  return {
    config: {
      providers: async () => {
        const response = await context.provider.list();
        return { data: { providers: response.data.map((provider) => ({ id: provider.id })) } };
      },
      get: async () => ({ data: {} }),
    },
  };
}

// Quota computation runs on the server through the shared upstream core; the
// TUI receives structured sidebar cards and only renders them.
export default Plugin.define({
  id: "opencode-quota-zh",
  async setup(context) {
    await context.rpc.register(quotaRpc, {
      async snapshot(input) {
        const runtime = await resolveQuotaRuntimeContext({
          client: createQuotaCoreClient(context),
          roots: {
            activeDirectory: context.location.directory,
            fallbackDirectory: context.location.directory,
          },
          sessionID: input.sessionID,
          resolveSessionMeta: async (sessionID) => {
            const session = await context.session.get({ sessionID });
            const model = session?.model;
            return model ? { modelID: model.id, providerID: model.providerID } : {};
          },
          includeSessionMeta: (config) => config.onlyCurrentModel,
        });
        if (!runtime.config.enabled || !runtime.config.tuiSidebarPanel.enabled) {
          return { cards: [] };
        }
        const result = await collectQuotaRenderData({
          client: runtime.client,
          resolveRuntimeProviderIds: runtime.resolveRuntimeProviderIds,
          config: runtime.config,
          configMeta: runtime.configMeta,
          request: createQuotaRuntimeRequestContext(runtime),
          surfaceExplicitProviderIssues: true,
          formatStyle: "allWindows",
          providers: runtime.providers,
          includeAllWindowsData: true,
        });
        return { cards: buildQuotaSidebarCards(result.allWindowsData ?? result.data) };
      },
    });
  },
});

export type {
  JsonV1Adapter,
  JsonV1Mapping,
  JsonV1Metric,
  JsonV1NumberSource,
  JsonV1Path,
  JsonV1TextSource,
  JsonV1TimestampEncoding,
  JsonV1TimestampSource,
  LocalEstimateQuotaProviderDefinition,
  LocalEstimateWindow,
  QuotaProviderDefinition,
  QuotaProviderRemoteFormat,
  RemoteApiQuotaProviderDefinition,
} from "./lib/quota-providers.js";

// Re-export types for consumers (types are erased at runtime, so safe to export)
export {
  QUOTA_PROVIDER_MODES,
  QUOTA_PROVIDER_REMOTE_FORMATS,
  QUOTA_PROVIDER_WINDOW_TYPES,
  validateQuotaProviders,
} from "./lib/quota-providers.js";
export type {
  CopilotEnterpriseUsageResult,
  CopilotOrganizationUsageResult,
  CopilotQuotaResult,
  GoogleModelId,
  GoogleModelQuota,
  GoogleQuotaResult,
  MaintainerAnnouncementsConfig,
  MiniMaxResult,
  MiniMaxResultEntry,
  PricingSnapshotSource,
  QuotaToastConfig,
  SessionTokenScope,
} from "./lib/types.js";
