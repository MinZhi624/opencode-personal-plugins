/**
 * Tools for AI agents: read the server settings, change the provider, checking and pricing
 * settings, and add, test and remove custom providers. Words, export and telemetry
 * are the user's, edited in the quota window or the settings file. Every write
 * holds the settings lock and goes into OpenCode Quota's own settings file, never opencode.json.
 *
 * Keys: a provider added by an agent is saved switched off (`"enabled": false`), so it is never
 * fetched and its key is never sent until the user switches it on. No tool switches a provider
 * on. Every answer is cleaned in one place: each key the plugin can read, and anything in a
 * known key format, is replaced before the agent sees it.
 */
import { rowsFromProviderResult } from "./core/rows.js";
import {
  getGlobalOpencodeConfigCandidatePaths,
  getProviderConfigSettings,
  readConfigCandidate,
} from "./lib/api-key-resolver.js";
import { resolveEnvTemplate } from "./lib/env-template.js";
import { isRecord } from "./lib/json-guards.js";
import { readCredentialRows } from "./lib/opencode-auth.js";
import {
  describeQuotaProviderRequest,
  QUOTA_PROVIDER_FIELDS,
  QUOTA_PROVIDERS_AGGREGATE_ID,
  type QuotaProviderDefinition,
} from "./lib/quota-providers.js";
import { collectLocalQuotaProviderEstimate } from "./lib/quota-providers-local.js";
import {
  fetchRemoteQuotaProvider,
  resolveQuotaProviderApiKey,
} from "./lib/quota-providers-remote.js";
import type { ProviderFetchResult, ProviderRow } from "./providers/contract.js";
import { customAccount } from "./providers/quota-providers.js";
import {
  checkSetting,
  describeRule,
  editSettings,
  editSettingsFile,
  loadSettings,
  SETTINGS_SCHEMA,
  type Settings,
  type SettingsIssue,
  type SettingsPatch,
  settingsPath,
} from "./settings/index.js";

type QuotaAgentToolsHost = {
  /** The providers OpenCode serves now; a custom provider shows only when its providerId is one. */
  openCodeProviderIds(): Promise<readonly string[]>;
};

/** A tool as `ctx.tool.transform(editor => editor.add(tool))` takes it. */
type QuotaAgentTool = {
  name: string;
  description: string;
  input: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
    additionalProperties: false;
  };
  execute(input: unknown): Promise<{ content: string }>;
};

/** What a tool reports back to the agent, as JSON text. */
type ToolResult = Record<string, unknown>;

/** Replaces every key in one string; see `credentialRedactor`. */
type Redact = (text: string) => string;

const REDACTED = "[redacted]";

/** The top-level settings agents may change; the user changes the others in /quota_settings. */
const AGENT_GROUPS: readonly string[] = ["providers"];

const TOP_LEVEL_SETTINGS: ReadonlySet<string> = new Set(
  Object.keys(SETTINGS_SCHEMA).map((key) => key.split(".")[0]),
);

const DEFINITION_SECRET_MESSAGE =
  "看起来像密钥或其他机密，因此什么都没保存。请把密钥放进环境变量，并把 apiKeyEnv 设为该变量名；" +
  "不设 apiKeyEnv 则使用 OpenCode 里该 provider 的密钥。";

/** How the agent tells the user to switch a provider on. */
function switchOnStep(): string {
  return `请让用户启用它：在 ${settingsPath()} 里把 "enabled" 设为 true，或在 /quota_settings → Providers 打开`;
}

const SETTING_SECRET_MESSAGE = "看起来像密钥或其他机密，因此什么都没保存";

/** A top-level definition field that would hold a secret; `apiKeyEnv` holds only a name. */
const SECRET_FIELD_PATTERN = /key|token|secret|passw|bearer|cookie|credential|authorization/i;

/** Known key formats, found anywhere in a text: refused in inputs, replaced in answers. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI, Anthropic, OpenRouter, DeepSeek, Moonshot
  /\b(?:gh[opsur]|github_pat)_[A-Za-z0-9_]{20,}/g, // GitHub
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /\bya29\.[0-9A-Za-z_-]{20,}/g, // Google OAuth access token
  /\b1\/\/[0-9A-Za-z_-]{20,}/g, // Google OAuth refresh token
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g, // JWT, all three parts
  /\bbearer\s+\S{8,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];

/** Fields holding names (ids, model names, URLs, JSON paths): long runs pass in them. */
const NAME_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "providerId",
  "modelIds",
  "url",
  "path",
  "rowsPath",
  "pricingModelMap",
]);

/** The validator's rule for an environment variable name, the only thing apiKeyEnv holds. */
const VARIABLE_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Environment variables whose values the answers never show: the names keys go by. */
const KEY_VARIABLE_NAME = /API_?KEY|TOKEN|SECRET|PASSW|COOKIE|CREDENTIAL/i;

/** Keys this long are replaced anywhere; shorter ones only as a whole token, so no word is cut. */
const LONG_KEY_LENGTH = 8;

/**
 * True when a run of 20+ letters and digits switches between letters, digits and case so often
 * that its pieces average under 3 characters: a random token, not words. A camelCase name such
 * as "AvailableBalanceUSD2024Total" splits into Available|Balance|USD|2024|Total and passes; a
 * hex or base62 key splits into pieces of 1-2 characters.
 */
function looksRandom(run: string): boolean {
  if (!/[0-9]/.test(run) || !/[A-Za-z]/.test(run)) return false;
  const pieces = run.match(/[0-9]+|[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? [];
  return run.length / pieces.length < 3;
}

/**
 * True when a value holds something shaped like a key: a known key format, a random run of
 * letters and digits, or (outside name fields) any run of 24+ of them. Any other character ends
 * a run, so model names such as "Qwen3-Coder-480B-A35B-Instruct-2507", UUIDs and version
 * strings pass. A heuristic: keys never belong in a definition or a setting, only in an
 * environment variable.
 */
function looksSecret(text: string, isName: boolean): boolean {
  return (
    SECRET_PATTERNS.some((pattern) => text.search(pattern) !== -1) ||
    (text.match(/[A-Za-z0-9]{20,}/g) ?? []).some(
      (run) => looksRandom(run) || (!isName && run.length >= 24),
    )
  );
}

/** A copy of a JSON value with `redact` applied to every string in it, property names too. */
function redactStrings(value: unknown, redact: Redact): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, redact));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [redact(name), redactStrings(item, redact)]),
    );
  }
  return value;
}

/**
 * True when a value holds a string, or a property name, that looks like a secret. Property names
 * are checked like ids (a pricingModelMap is keyed by model ids).
 */
function holdsSecret(value: unknown, isName: boolean): boolean {
  if (typeof value === "string") return looksSecret(value, isName);
  if (Array.isArray(value)) return value.some((item) => holdsSecret(item, isName));
  if (isRecord(value)) {
    return Object.entries(value).some(
      ([name, item]) =>
        looksSecret(name, true) || holdsSecret(item, isName || NAME_FIELDS.has(name)),
    );
  }
  return false;
}

/**
 * The definition fields that look like they hold a secret. An issue names a definition field, or
 * the position of a field definitions do not have; never a name from the input. A field named
 * like a secret is refused whatever it holds; a valid variable name in apiKeyEnv is only a name.
 */
function definitionSecretIssues(definition: Record<string, unknown>): SettingsIssue[] {
  return Object.entries(definition).flatMap(([field, value], index): SettingsIssue[] => {
    if (field === "apiKeyEnv" && typeof value === "string" && VARIABLE_NAME.test(value)) return [];
    if (QUOTA_PROVIDER_FIELDS.includes(field)) {
      return holdsSecret(value, NAME_FIELDS.has(field))
        ? [{ key: `definition.${field}`, message: DEFINITION_SECRET_MESSAGE }]
        : [];
    }
    const secret =
      SECRET_FIELD_PATTERN.test(field) || looksSecret(field, true) || holdsSecret(value, false);
    return secret
      ? [{ key: "definition", message: `第 ${index + 1} 个字段${DEFINITION_SECRET_MESSAGE}` }]
      : [];
  });
}

/**
 * Every key the plugin can read: variables named like keys or named by a switched-on custom
 * provider; keys in the global opencode.json(c); and API-key logins saved in OpenCode for the
 * providers OpenCode has. OAuth tokens are not read (that could refresh them); `SECRET_PATTERNS`
 * covers their shape. The key of a switched-off provider (and of one a tool saves, always
 * switched off) is never read: until the user switches it on, nothing touches it.
 */
async function credentialValues(host: QuotaAgentToolsHost): Promise<string[]> {
  // Each provider's key variable and OpenCode provider.
  const sources = (await loadSettings()).settings.providers.custom
    .filter((definition) => definition.enabled !== false)
    .map((definition) => ({
      variable: definition.mode === "remote-api" ? definition.apiKeyEnv : undefined,
      providerId: definition.providerId,
    }));
  const variables = new Set(
    Object.keys(process.env).filter((name) => KEY_VARIABLE_NAME.test(name)),
  );
  for (const { variable } of sources) {
    if (typeof variable === "string") variables.add(variable);
  }
  const values: unknown[] = [...variables].map((name) => process.env[name]);

  for (const candidate of getGlobalOpencodeConfigCandidatePaths()) {
    const config = await readConfigCandidate(candidate);
    if (!isRecord(config)) continue;
    const providerIds = [config.provider, config.providers].flatMap((group) =>
      isRecord(group) ? Object.keys(group) : [],
    );
    for (const providerId of providerIds) {
      const apiKey = getProviderConfigSettings(config, providerId)?.apiKey;
      if (typeof apiKey === "string") values.push(resolveEnvTemplate(apiKey.trim()));
    }
  }

  const providerIds = new Set([
    ...(await host.openCodeProviderIds()),
    ...sources.map(({ providerId }) => providerId),
  ]);
  const logins = await readCredentialRows([...providerIds], { methods: ["key"] });
  values.push(...logins.map((row) => row.value.key));

  return values.flatMap((value) =>
    typeof value === "string" && value.trim() ? [value.trim()] : [],
  );
}

/**
 * Replaces, in one string, each key the plugin can read and each known key format. A key under
 * LONG_KEY_LENGTH counts only as a whole token (letters, digits, `_` and `-`).
 */
async function credentialRedactor(host: QuotaAgentToolsHost): Promise<Redact> {
  // Longest first, so a key that contains another is replaced whole.
  const values = [...new Set(await credentialValues(host))].sort((a, b) => b.length - a.length);
  const long = values.filter((value) => value.length >= LONG_KEY_LENGTH);
  const short = values
    .filter((value) => value.length < LONG_KEY_LENGTH)
    .map((value) => {
      const escaped = value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "g");
    });
  return (text) => {
    let redacted = text;
    for (const value of long) redacted = redacted.split(value).join(REDACTED);
    for (const pattern of short) redacted = redacted.replace(pattern, REDACTED);
    for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, REDACTED);
    return redacted;
  };
}

function valueAt(settings: Settings, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>((value, part) => (isRecord(value) ? value[part] : undefined), settings);
}

/** Where each remote custom provider reads its API key: a variable name, never its value. */
function apiKeySources(definitions: readonly QuotaProviderDefinition[]): ToolResult[] {
  return definitions.flatMap((definition): ToolResult[] => {
    if (definition.mode !== "remote-api") return [];
    if (!definition.apiKeyEnv) {
      return [
        {
          provider: definition.id,
          apiKeyEnv: null,
          readsFrom: `OpenCode 里 provider "${definition.providerId}" 的密钥`,
        },
      ];
    }
    return [
      {
        provider: definition.id,
        apiKeyEnv: definition.apiKeyEnv,
        isSet: Boolean(process.env[definition.apiKeyEnv]?.trim()),
      },
    ];
  });
}

async function getSettings(): Promise<ToolResult> {
  const loaded = await loadSettings();
  const fromFile = new Set(loaded.fromFile);
  const settings = Object.fromEntries(
    Object.entries(SETTINGS_SCHEMA).map(([key, rule]) => [
      key,
      {
        value: valueAt(loaded.settings, key),
        from: fromFile.has(key) ? "file" : "default",
        allowed:
          rule.kind === "customProviders"
            ? "自定义提供商定义；请用 quota_provider_add 和 quota_provider_remove 修改"
            : describeRule(rule),
      },
    ]),
  );
  const notes = [
    `quota_settings_set 只修改 ${AGENT_GROUPS.join(", ")}，以嵌套对象提交，例如 ` +
      '{ "providers": { "checking": { "minIntervalMs": 600000 } } }；null 表示重置该项。' +
      "其余设置由用户在 /quota_settings 里修改。",
    "所有额度设置都在这个文件里。展示类设置由用户在 /quota_settings 里修改。",
  ];
  if (!loaded.exists && loaded.conversion) {
    notes.push(
      `文件还不存在：标记为 "file" 的值来自 ${loaded.conversion.sources.join(", ")}。第一次修改时会写出该文件。`,
    );
  }
  return {
    file: loaded.path,
    fileExists: loaded.exists,
    settings,
    apiKeys: apiKeySources(loaded.settings.providers.custom),
    ...(loaded.issues.length > 0 ? { problemsInFile: loaded.issues } : {}),
    notes,
  };
}

/** True when a patch would change the custom providers, which only the provider tools do. */
function touchesCustomProviders(patch: Record<string, unknown>): boolean {
  if (!Object.hasOwn(patch, "providers")) return false;
  const providers = patch.providers;
  return providers === null || (isRecord(providers) && Object.hasOwn(providers, "custom"));
}

/**
 * What an agent may not change in a patch; checked before anything is saved. An issue names a
 * settings key, or the position of a name that is not one; never a name from the patch. Names
 * deeper in a group are checked by the save, which reports them the same way.
 */
function patchIssues(patch: Record<string, unknown>): SettingsIssue[] {
  const agentGroups = AGENT_GROUPS.join(", ");
  const issues = Object.entries(patch).flatMap(([group, value], index): SettingsIssue[] => {
    const position = `补丁的第 ${index + 1} 个键`;
    if (group.includes(".")) {
      return [
        {
          key: "patch",
          message: `请用嵌套对象而不是点分键（${position}），例如 { "providers": { "checking": { "minIntervalMs": 600000 } } }`,
        },
      ];
    }
    if (!TOP_LEVEL_SETTINGS.has(group)) {
      return [
        {
          key: "patch",
          message: `未知设置（${position}）；允许修改：${agentGroups}`,
        },
      ];
    }
    if (!AGENT_GROUPS.includes(group)) {
      return [
        {
          key: group,
          message: `${group} 由用户在 /quota_settings 里修改；允许修改：${agentGroups}`,
        },
      ];
    }
    return holdsSecret(value, false) ? [{ key: group, message: SETTING_SECRET_MESSAGE }] : [];
  });
  if (touchesCustomProviders(patch)) {
    issues.push({
      key: "providers.custom",
      message:
        "自定义提供商请用 quota_provider_add 和 quota_provider_remove 修改；" +
        "要重置其他 provider 设置，请把对应项设为 null",
    });
  }
  return issues;
}

async function setSettings(input: unknown): Promise<ToolResult> {
  const patch = isRecord(input) ? input.patch : undefined;
  const issues = isRecord(patch)
    ? patchIssues(patch)
    : [{ key: "patch", message: "需要一个设置对象" }];
  if (issues.length > 0) return { ok: false, issues, message: "什么都没保存。" };
  // Agents may also write settings /quota_settings does not show, such as the Claude CLI path.
  const saved = await editSettings(() => patch as SettingsPatch, { allowFileOnly: true });
  if (!saved.ok) return { ok: false, issues: saved.issues, message: "什么都没保存。" };
  return {
    ok: true,
    file: settingsPath(),
    diff: saved.diff,
    message: saved.diff.length > 0 ? "已保存。" : "没有变化。",
  };
}

/** A list with a bad entry loads as empty, so changing it would drop every entry the user has. */
function customProviderIssues(issues: readonly SettingsIssue[]): SettingsIssue[] {
  return issues.filter((issue) => issue.key.startsWith("providers.custom"));
}

function fixFileFirst(problems: SettingsIssue[]): ToolResult {
  return {
    ok: false,
    issues: problems,
    message: `没有任何改动：请先修正 ${settingsPath()} 里的自定义提供商。`,
  };
}

/** The id the caller sent is not repeated; the ids in the file are listed instead. */
function notFound(ids: readonly string[]): ToolResult {
  return { ok: false, message: "没有这个 id 的自定义提供商。", ids };
}

/**
 * The rows the sidebar would show for one reply of a definition, or why there are none. Row
 * ids are made from the names and ids in them, so every string in them is redacted first, to a
 * placeholder a row id may hold.
 */
function testedRows(
  definition: QuotaProviderDefinition,
  rows: readonly ProviderRow[],
  rowErrors: readonly string[],
  redact: Redact,
): ToolResult {
  const result: ProviderFetchResult = {
    attempted: true,
    accounts: [customAccount(definition, rows, rowErrors)],
    debug: [],
  };
  const fetched = rowsFromProviderResult(
    QUOTA_PROVIDERS_AGGREGATE_ID,
    redactStrings(result, (text) => redact(text).replaceAll(REDACTED, "redacted")) as typeof result,
  );
  const problems = fetched.debug.map((detail) => detail.value);
  if (fetched.rows.length === 0) {
    return { ok: false, error: "返回内容里没有可读取的额度行。", problems };
  }
  return { ok: true, rows: fetched.rows, ...(problems.length > 0 ? { problems } : {}) };
}

/**
 * One fetch of one switched-on definition now, as the rows the sidebar would show, or why it
 * failed. Its key is read the way the plugin reads it.
 */
async function testFetch(
  definition: QuotaProviderDefinition,
  requestTimeoutMs: number,
  redact: Redact,
): Promise<ToolResult> {
  if (definition.enabled === false) {
    return { ok: false, error: `未测试：它处于关闭状态。${switchOnStep()}，然后再测试。` };
  }
  if (definition.mode === "local-estimate") {
    return testedRows(
      definition,
      (await collectLocalQuotaProviderEstimate(definition)).rows,
      [],
      redact,
    );
  }
  const { key } = await resolveQuotaProviderApiKey(definition);
  if (!key) {
    return {
      ok: false,
      error:
        `没有找到 API key。它取自 ${describeQuotaProviderRequest(definition)?.key}。` +
        "请用户把密钥保存到那里并重启 OpenCode，然后运行 quota_provider_test。",
    };
  }
  const result = await fetchRemoteQuotaProvider(definition, key, requestTimeoutMs);
  if (!result.success) return { ok: false, error: result.error };
  return testedRows(definition, result.rows, result.rowErrors ?? [], redact);
}

/** Why a saved definition would still not show, so the agent can fix it. */
async function visibilityNotes(
  definition: QuotaProviderDefinition,
  settings: Settings,
  host: QuotaAgentToolsHost,
): Promise<string[]> {
  const notes: string[] = [];
  const off = settings.providers.off;
  if (off.includes("custom")) {
    notes.push(
      'providers.off 里列了 "custom"，自定义提供商不会显示；请用 quota_settings_set 把它移除。',
    );
  }
  let openCodeIds: readonly string[] | undefined;
  try {
    openCodeIds = await host.openCodeProviderIds();
  } catch {
    // Without the list, say nothing rather than guess.
  }
  if (openCodeIds && !openCodeIds.includes(definition.providerId)) {
    notes.push(
      `OpenCode 里没有 provider "${definition.providerId}"，这一条不会显示。` +
        `请把 providerId 设为它要跟踪的 OpenCode provider；现有：${openCodeIds.join(", ")}。`,
    );
  }
  return notes;
}

async function addProvider(input: unknown, host: QuotaAgentToolsHost): Promise<ToolResult> {
  const definition = isRecord(input) ? input.definition : undefined;
  if (!isRecord(definition)) {
    return {
      ok: false,
      issues: [{ key: "definition", message: "需要一个对象" }],
      message: "什么都没保存。",
    };
  }
  const secrets = definitionSecretIssues(definition);
  if (secrets.length > 0) return { ok: false, issues: secrets, message: "Nothing was saved." };

  // Written as the agent sent it, so the file gets no filled-in defaults; a label that only
  // repeats the id is left out. Always switched off, also when it replaces one that was on.
  const { label, ...withoutLabel } = definition;
  const entry = { ...(label === definition.id ? withoutLabel : definition), enabled: false };
  // The entry alone, so its problems point into it; the save checks the whole list.
  const alone = checkSetting("providers.custom", [entry]);
  if (alone.issues.length > 0) {
    return {
      ok: false,
      issues: alone.issues.map((issue) => ({
        ...issue,
        key: issue.key.replace(/^providers\.custom\[0\]/, "definition"),
      })),
      message: "什么都没保存。请修正定义后重新添加。",
    };
  }
  const added = (alone.value as QuotaProviderDefinition[])[0];
  let problems: SettingsIssue[] = [];
  let replaced = false;
  const saved = await editSettingsFile((current, issues) => {
    problems = customProviderIssues(issues);
    if (problems.length > 0) return undefined;
    const at = current.providers.custom.findIndex((item) => item.id === added.id);
    replaced = at !== -1;
    // Only this entry changes (-1 appends), so the others keep their comments.
    return [{ path: ["providers", "custom", at], value: entry }];
  });
  if (problems.length > 0) return fixFileFirst(problems);
  if (!saved.ok) return { ok: false, issues: saved.issues, message: "Nothing was saved." };

  // What the user checks before switching it on: where the key would go, and from where.
  const request = describeQuotaProviderRequest(added);
  const check = request ? `，并确认 ${request.url} 会收到 ${request.key}` : "";
  const notes = await visibilityNotes(added, (await loadSettings()).settings, host);
  return {
    ok: true,
    [replaced ? "replaced" : "added"]: added.id,
    file: settingsPath(),
    enabled: false,
    ...(request ? { request } : {}),
    ...(notes.length > 0 ? { notes } : {}),
    message:
      `已保存，但处于关闭状态：暂不查询，密钥也不会发送。${switchOnStep()}${check}` +
      "，然后用 quota_provider_test 测试。",
  };
}

async function testProvider(
  input: unknown,
  host: QuotaAgentToolsHost,
  redact: Redact,
): Promise<ToolResult> {
  const id = isRecord(input) ? input.id : undefined;
  const loaded = await loadSettings();
  const definitions = loaded.settings.providers.custom;
  const definition = definitions.find((item) => item.id === id);
  if (!definition) {
    const problems = customProviderIssues(loaded.issues);
    return {
      ...notFound(definitions.map((item) => item.id)),
      ...(problems.length > 0 ? { problemsInFile: problems } : {}),
    };
  }
  const test = await testFetch(
    definition,
    loaded.settings.providers.checking.requestTimeoutMs,
    redact,
  );
  const notes = await visibilityNotes(definition, loaded.settings, host);
  return { id: definition.id, ...test, ...(notes.length > 0 ? { notes } : {}) };
}

async function removeProvider(input: unknown): Promise<ToolResult> {
  const id = isRecord(input) ? input.id : undefined;
  let problems: SettingsIssue[] = [];
  let ids: string[] = [];
  let found = false;
  const saved = await editSettingsFile((current, issues) => {
    problems = customProviderIssues(issues);
    if (problems.length > 0) return undefined;
    ids = current.providers.custom.map((item) => item.id);
    const at = typeof id === "string" ? ids.indexOf(id) : -1;
    found = at !== -1;
    // Only this entry goes, so the others keep their comments.
    return found ? [{ path: ["providers", "custom", at], value: undefined }] : undefined;
  });
  if (problems.length > 0) return fixFileFirst(problems);
  if (!saved.ok) return { ok: false, issues: saved.issues, message: "没有移除任何内容。" };
  if (!found) return notFound(ids);
  return {
    ok: true,
    removed: id,
    remaining: ids.filter((item) => item !== id),
    message: "已移除。",
  };
}

function tool(
  host: QuotaAgentToolsHost,
  name: string,
  description: string,
  properties: QuotaAgentTool["input"]["properties"],
  run: (input: unknown, redact: Redact) => Promise<ToolResult>,
): QuotaAgentTool {
  return {
    name,
    description,
    input: {
      type: "object",
      properties,
      // Every input is required; an empty list is not valid in every JSON Schema draft.
      ...(Object.keys(properties).length > 0 ? { required: Object.keys(properties) } : {}),
      additionalProperties: false,
    },
    async execute(input) {
      let redact: Redact;
      try {
        redact = await credentialRedactor(host);
      } catch {
        const message = "没有执行任何操作：无法读取需要从回答里隐藏的已存密钥。";
        return { content: JSON.stringify({ ok: false, message }, null, 2) };
      }
      let result: ToolResult;
      try {
        result = await run(input, redact);
      } catch (error) {
        // A thrown error would reach the agent as an internal failure without its reason.
        result = { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      // The one place answers are cleaned: whatever a file or an endpoint holds, no key gets out.
      // Each string is cleaned on its own, so a replacement never reaches the JSON around it.
      return { content: JSON.stringify(redactStrings(result, redact), null, 2) };
    },
  };
}

const ID_INPUT = { type: "string", description: "自定义提供商的 id。" };

const DEFINITION_EXAMPLE = JSON.stringify({
  id: "my-gateway-quota",
  providerId: "my-gateway",
  mode: "remote-api",
  url: "https://gateway.example/v1/quota",
  format: "quota-v1",
  apiKeyEnv: "MY_GATEWAY_API_KEY",
});

export function quotaAgentTools(host: QuotaAgentToolsHost): QuotaAgentTool[] {
  return [
    tool(
      host,
      "quota_settings_get",
      "读取 OpenCode Quota 的服务端设置。返回每项设置的值、来源（文件或默认）、允许取值、" +
        "设置文件路径，以及每个自定义提供商读取密钥的环境变量。",
      {},
      () => getSettings(),
    ),
    tool(
      host,
      "quota_settings_set",
      "以嵌套对象的合并补丁修改 OpenCode Quota 的 providers、checking 或 pricing 设置；" +
        "null 重置该项。返回改动内容，或返回问题清单（此时什么都没保存）。" +
        "自定义提供商请用 quota_provider_add 和 quota_provider_remove。",
      {
        patch: {
          type: "object",
          description:
            '要修改的嵌套设置，例如 { "providers": { "checking": { "minIntervalMs": 600000 } } }。',
        },
      },
      setSettings,
    ),
    tool(
      host,
      "quota_provider_add",
      "添加自定义 OpenCode Quota 提供商，或替换同 id 的已有项。保存后默认关闭；" +
        "用户启用后（设置文件或 /quota_settings → Providers），quota_provider_test 才会查询它。" +
        "定义里不要放密钥：apiKeyEnv 指定存放密钥的环境变量名；不设则使用 OpenCode 为 providerId 配置的密钥。" +
        "规则：https://github.com/slkiser/opencode-quota/blob/main/docs/readme/providers.md#custom-providers",
      {
        definition: {
          type: "object",
          description: `一个自定义提供商定义，例如 ${DEFINITION_EXAMPLE}。`,
        },
      },
      (input) => addProvider(input, host),
    ),
    tool(
      host,
      "quota_provider_test",
      "立即按 id 查询一个已启用的自定义 OpenCode Quota 提供商。返回额度行或错误。",
      { id: ID_INPUT },
      (input, redact) => testProvider(input, host, redact),
    ),
    tool(
      host,
      "quota_provider_remove",
      "按 id 移除一个自定义 OpenCode Quota 提供商。返回剩余的 id。",
      { id: ID_INPUT },
      removeProvider,
    ),
  ];
}
