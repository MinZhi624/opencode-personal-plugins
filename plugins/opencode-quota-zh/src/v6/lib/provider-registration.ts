export interface QuotaProviderRegistrationSourceEntry {
  id: string;
  label: string;
  labelAliases?: readonly string[];
  runtimeIds: readonly string[];
  synonyms: readonly string[];
  liveLocalUsage?: true;
}

export const QUOTA_PROVIDER_REGISTRATION_SOURCE = [
  {
    id: "anthropic",
    label: "Anthropic",
    runtimeIds: ["anthropic"],
    synonyms: ["claude", "claude-code"],
  },
  {
    id: "copilot",
    label: "Copilot",
    runtimeIds: ["copilot", "github-copilot", "copilot-chat", "github-copilot-chat"],
    synonyms: ["github-copilot", "copilot-chat", "github-copilot-chat"],
  },
  {
    id: "openai",
    label: "OpenAI",
    runtimeIds: ["openai", "chatgpt", "codex"],
    synonyms: [],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    runtimeIds: ["openrouter"],
    synonyms: [],
  },
  {
    id: "kilo",
    label: "Kilo Gateway",
    runtimeIds: ["kilo"],
    synonyms: [],
  },
  {
    id: "cursor",
    label: "Cursor",
    runtimeIds: ["cursor", "cursor-acp"],
    synonyms: ["cursor-acp", "open-cursor", "@rama_nigg/open-cursor"],
    liveLocalUsage: true,
  },
  {
    id: "alibaba-coding-plan",
    label: "Alibaba Coding Plan",
    runtimeIds: ["alibaba-coding-plan"],
    synonyms: ["alibaba"],
    liveLocalUsage: true,
  },
  {
    id: "alibaba-token-plan",
    label: "Alibaba Personal Token Plan",
    runtimeIds: ["alibaba-token-plan"],
    synonyms: [],
  },
  {
    id: "synthetic",
    label: "Synthetic",
    runtimeIds: ["synthetic"],
    synonyms: [],
  },
  {
    id: "chutes",
    label: "Chutes",
    runtimeIds: ["chutes", "chutes-ai"],
    synonyms: [],
  },
  {
    id: "google-gemini-cli",
    label: "Gemini CLI",
    runtimeIds: ["google-gemini-cli", "gemini-cli", "gemini", "opencode-gemini-auth", "google"],
    synonyms: ["gemini-cli", "google-gemini", "opencode-gemini-auth", "gemini"],
  },
  {
    id: "google-agy",
    label: "Google AGY",
    runtimeIds: ["google-agy", "opencode-agy-auth", "google-agy-auth"],
    synonyms: ["opencode-agy-auth", "google-agy-auth"],
  },
  {
    id: "zai",
    label: "Z.ai",
    runtimeIds: ["zai", "glm", "zai-coding-plan"],
    synonyms: [],
  },
  {
    id: "zhipu",
    label: "Zhipu",
    runtimeIds: ["zhipu", "glm-coding-plan", "zhipu-coding-plan", "zhipuai-coding-plan"],
    synonyms: ["glm-coding-plan", "zhipu-coding-plan", "zhipuai-coding-plan"],
  },
  {
    id: "nanogpt",
    label: "NanoGPT",
    runtimeIds: ["nanogpt", "nano-gpt"],
    synonyms: ["nano-gpt"],
  },
  {
    id: "minimax-coding-plan",
    label: "MiniMax Token Plan",
    runtimeIds: ["minimax-coding-plan", "minimax"],
    synonyms: ["minimax"],
  },
  {
    id: "minimax-china-coding-plan",
    label: "MiniMax Token Plan (CN)",
    labelAliases: ["minimax-cn-coding-plan"],
    runtimeIds: [
      "minimax-china-coding-plan",
      "minimax-cn-coding-plan",
      "minimax-cn",
      "minimax-china",
    ],
    synonyms: ["minimax-cn", "minimax-china", "minimax-cn-coding-plan"],
  },
  {
    id: "kimi-code-plan-global",
    label: "Kimi Code",
    runtimeIds: ["kimi-code-plan-global"],
    synonyms: [],
  },
  {
    id: "kimi-code-plan-cn",
    label: "Kimi Code (CN)",
    labelAliases: ["kimi-code"],
    runtimeIds: ["kimi-code-plan-cn", "kimi-for-coding", "kimi", "kimi-code"],
    synonyms: ["kimi", "kimi-for-code", "kimi-code", "kimi-for-coding"],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    runtimeIds: ["deepseek"],
    synonyms: ["deep-seek"],
  },
  {
    id: "xai",
    label: "xAI",
    runtimeIds: ["xai"],
    synonyms: [],
  },
  {
    id: "xiaomi",
    label: "Xiaomi MiMo",
    runtimeIds: [
      "xiaomi",
      "xiaomi-token-plan-cn",
      "xiaomi-token-plan-ams",
      "xiaomi-token-plan-sgp",
    ],
    synonyms: ["xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"],
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    runtimeIds: ["opencode-go"],
    synonyms: ["opencode-go-subscription"],
  },
  {
    id: "opencode",
    label: "OpenCode Zen",
    runtimeIds: ["opencode", "opencode-zen"],
    synonyms: ["opencode-zen"],
  },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    runtimeIds: ["ollama-cloud"],
    synonyms: [],
  },
  {
    id: "quota-providers",
    label: "自定义提供商",
    runtimeIds: [],
    synonyms: [],
  },
] as const satisfies readonly QuotaProviderRegistrationSourceEntry[];

export type CanonicalQuotaProviderId = (typeof QUOTA_PROVIDER_REGISTRATION_SOURCE)[number]["id"];
