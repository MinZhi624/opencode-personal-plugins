/** @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid";
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiPromptRef,
} from "@opencode-ai/plugin/tui";
import { Show, createEffect, createSignal, onCleanup } from "solid-js";

import type { SessionTokenError } from "./lib/quota-status.js";
import { formatDisplayedPercentLabel, formatResetCountdown } from "./lib/format-utils.js";
import { createTuiRefreshLifecycle } from "./lib/tui-refresh-lifecycle.js";
import { extractSingleWindowWindowLabel } from "./lib/quota-entry-display.js";
import type { TuiCommandDisplay } from "./lib/types.js";
import type {
  CompactStatusState,
  HomeBottomState,
  PromptBarState,
  SidebarPanelState,
  StartupHintState,
} from "./lib/tui-panel-state.js";

import {
  getCompactStatusText,
  getHomeBottomAnnouncementText,
  shouldRenderCompactStatus,
  shouldRenderHomeBottom,
} from "./lib/tui-panel-state.js";
import {
  createTuiQuotaClient,
  getTuiRuntimeRootHints,
  getTuiSessionModelMeta,
  loadTuiHomeBottomStatus,
  loadTuiSessionQuotaSurfaces,
  loadTuiStartupHint,
  normalizeTuiSessionID,
  resolveTuiSurfaceRegistration,
  writeTuiQuotaExportIfEnabled,
  type TuiInitialRuntimeSeed,
  type TuiSurfaceRegistration,
} from "./lib/tui-runtime.js";
import { disposeQuotaTelemetryOwner } from "./lib/quota-telemetry.js";
import {
  QUOTA_DIALOG_COMMANDS,
  buildQuotaDialogCommandOutput,
  type QuotaDialogCommandId,
  type QuotaDialogCommandSpec,
} from "./lib/quota-dialog-commands.js";
import { ChineseSidebarContentView } from "./quota-zh-sidebar.tsx";

const id = "@local/opencode-quota-zh";
// Place Quota near the top so variable-height built-in sections
// (MCP/LSP/Todo/Files) do not push it below the visible fold.
const SIDEBAR_ORDER = 40;
const COMPACT_ORDER = 90;
const REFRESH_INTERVAL_MS = 60_000;
const EVENT_REFRESH_DELAYS_MS = [150, 600] as const;
const MOUNT_RECOVERY_DELAYS_MS = [500, 1_500, 4_000] as const;

type TuiPromptRefCallback = (ref: TuiPromptRef | undefined) => void;
type DialogSize = "medium" | "large" | "xlarge";

// Upstream v4.6.0: initial-load reuse. resolveTuiSurfaceRegistration captures
// the resolved runtime context once; the first session/home loads reuse it so
// the first quota frame appears without re-reading configuration, and each
// seed is consumed at most once per surface.
//
// Chinese fork: the sidebar_content slot hosts its own ChineseSidebarContentView
// (collectQuotaRenderData path) instead of the upstream session resource, so a
// dedicated sidebar ticket lets the Chinese sidebar and the session resource
// each reuse the seed exactly once on their first load.
type TuiInitialLoadCoordinator = {
  takeInitialSession: () => TuiInitialRuntimeSeed | undefined;
  takeSidebarSession: () => TuiInitialRuntimeSeed | undefined;
  takeInitialHome: () => TuiInitialRuntimeSeed | undefined;
  takeStartupHintHome: () => TuiInitialRuntimeSeed | undefined;
};

type TuiRegistrationState =
  | { status: "pending" }
  | {
      status: "active";
      registration: TuiSurfaceRegistration;
      initialLoads?: TuiInitialLoadCoordinator;
    }
  | { status: "disposed" };

type TuiRegistrationGate = {
  current: () => TuiRegistrationState;
  activate: (
    registration: TuiSurfaceRegistration,
    initialLoads?: TuiInitialLoadCoordinator,
  ) => void;
  dispose: () => void;
};

const FALLBACK_SURFACE_REGISTRATION: TuiSurfaceRegistration = {
  commandDisplay: "inline",
  sidebar: { enabled: true },
  compact: {
    enabled: false,
    homeBottom: false,
    sessionPrompt: false,
    hasNativeProviderQuota: false,
    suppressedByNativeProviderQuota: false,
  },
  promptBar: { enabled: false },
  startupHint: { enabled: false },
  announcements: { homeBottom: false },
  homeBottom: false,
};

function createTuiInitialLoadCoordinator(seed: TuiInitialRuntimeSeed): TuiInitialLoadCoordinator {
  let sessionAvailable = true;
  let sidebarAvailable = true;
  let homeAvailable = true;
  let startupHintHomeAvailable = true;

  return {
    takeInitialSession() {
      if (!sessionAvailable) return undefined;
      sessionAvailable = false;
      return seed;
    },
    takeSidebarSession() {
      if (!sidebarAvailable) return undefined;
      sidebarAvailable = false;
      return seed;
    },
    takeInitialHome() {
      if (!homeAvailable) return undefined;
      homeAvailable = false;
      return seed;
    },
    takeStartupHintHome() {
      if (!startupHintHomeAvailable) return undefined;
      startupHintHomeAvailable = false;
      return seed;
    },
  };
}

function createTuiRegistrationGate(): TuiRegistrationGate {
  const [current, setCurrent] = createSignal<TuiRegistrationState>({ status: "pending" });

  return {
    current,
    activate(registration, initialLoads) {
      if (current().status !== "pending") return;
      setCurrent({ status: "active", registration, initialLoads });
    },
    dispose() {
      if (current().status === "disposed") return;
      setCurrent({ status: "disposed" });
    },
  };
}

type QuotaDialogCommandState = {
  lastSessionTokenError?: SessionTokenError;
};
type SessionQuotaResource = {
  sessionID: string;
  sidebar: () => SidebarPanelState;
  compact: () => CompactStatusState;
  promptBar: () => PromptBarState;
  retain: () => SessionQuotaResource;
  release: () => void;
};

type HomeBottomResource = {
  bottom: () => HomeBottomState;
  retain: () => HomeBottomResource;
  release: () => void;
};

const sessionResources = new WeakMap<TuiPluginApi, Map<string, SessionQuotaResource>>();
const homeResources = new WeakMap<TuiPluginApi, HomeBottomResource>();

function getSessionResourceMap(api: TuiPluginApi): Map<string, SessionQuotaResource> {
  const existing = sessionResources.get(api);
  if (existing) return existing;

  const next = new Map<string, SessionQuotaResource>();
  sessionResources.set(api, next);
  return next;
}

function createSessionQuotaResource(
  api: TuiPluginApi,
  sessionID: string,
  initialLoads?: TuiInitialLoadCoordinator,
): SessionQuotaResource {
  const [sidebar, setSidebar] = createSignal<SidebarPanelState>({
    status: "loading",
    lines: [],
  });
  const [compact, setCompact] = createSignal<CompactStatusState>({ status: "loading" });
  const [promptBar, setPromptBar] = createSignal<PromptBarState>({ status: "loading" });

  let loadOrdinal = 0;
  const lifecycle = createTuiRefreshLifecycle({
    load: () => {
      const initialRuntimeSeed = loadOrdinal === 0 ? initialLoads?.takeInitialSession() : undefined;
      loadOrdinal += 1;
      return loadTuiSessionQuotaSurfaces({
        api,
        sessionID,
        ...(initialRuntimeSeed ? { initialRuntimeSeed } : {}),
      });
    },
    apply: (next) => {
      setSidebar(next.sidebar);
      setCompact(next.compact);
      setPromptBar(next.promptBar ?? { status: "loading" });
    },
    intervalMs: REFRESH_INTERVAL_MS,
    eventRefreshDelaysMs: EVENT_REFRESH_DELAYS_MS,
    // TUI/session state can hydrate asynchronously after mount or session switch,
    // so retry a few times to recover from empty first-load reads.
    recoveryDelaysMs: MOUNT_RECOVERY_DELAYS_MS,
    subscribe: (scheduleRefresh) => [
      api.event.on("session.updated", (event) => {
        if (event.properties?.info?.id === sessionID) {
          scheduleRefresh();
        }
      }),
      api.event.on("message.updated", (event) => {
        if (event.properties?.info?.sessionID === sessionID) {
          scheduleRefresh();
        }
      }),
      api.event.on("message.removed", (event) => {
        if (event.properties?.sessionID === sessionID) {
          scheduleRefresh();
        }
      }),
      api.event.on("tui.session.select", (event) => {
        if (event.properties?.sessionID === sessionID) {
          scheduleRefresh();
        }
      }),
    ],
    onDispose: () => {
      getSessionResourceMap(api).delete(sessionID);
    },
  });

  const resource: SessionQuotaResource = {
    sessionID,
    sidebar,
    compact,
    promptBar,
    retain: () => {
      lifecycle.retain();
      return resource;
    },
    release: lifecycle.release,
  };

  return resource;
}

function acquireSessionQuotaResource(
  api: TuiPluginApi,
  sessionID: string,
  initialLoads?: TuiInitialLoadCoordinator,
): SessionQuotaResource {
  const resources = getSessionResourceMap(api);
  const existing = resources.get(sessionID);
  if (existing) return existing.retain();

  const next = createSessionQuotaResource(api, sessionID, initialLoads).retain();
  resources.set(sessionID, next);
  return next;
}

function createHomeBottomResource(
  api: TuiPluginApi,
  compactHomeBottomEnabled: boolean,
  initialLoads?: TuiInitialLoadCoordinator,
): HomeBottomResource {
  const [bottom, setBottom] = createSignal<HomeBottomState>({
    status: "loading",
    compact: compactHomeBottomEnabled ? { status: "loading" } : { status: "disabled" },
  });

  let loadOrdinal = 0;
  const lifecycle = createTuiRefreshLifecycle({
    load: () => {
      const initialRuntimeSeed = loadOrdinal === 0 ? initialLoads?.takeInitialHome() : undefined;
      loadOrdinal += 1;
      return loadTuiHomeBottomStatus({
        api,
        ...(initialRuntimeSeed ? { initialRuntimeSeed } : {}),
      });
    },
    apply: setBottom,
    afterApply: () => {
      // Fire-and-forget: write export file if enabled. A failed write must
      // never affect TUI rendering, so log a warning and continue.
      void writeTuiQuotaExportIfEnabled({ api }).catch((err) => {
        console.warn(`[opencode-quota] quota export write failed: ${String(err)}`);
      });
    },
    intervalMs: REFRESH_INTERVAL_MS,
    eventRefreshDelaysMs: EVENT_REFRESH_DELAYS_MS,
    subscribe: (scheduleRefresh) => [
      api.event.on("session.updated", scheduleRefresh),
      api.event.on("message.updated", scheduleRefresh),
      api.event.on("message.removed", scheduleRefresh),
      api.event.on("tui.session.select", scheduleRefresh),
    ],
    onDispose: () => {
      homeResources.delete(api);
    },
  });

  const resource: HomeBottomResource = {
    bottom,
    retain: () => {
      lifecycle.retain();
      return resource;
    },
    release: lifecycle.release,
  };

  return resource;
}

function acquireHomeBottomResource(
  api: TuiPluginApi,
  compactHomeBottomEnabled: boolean,
  initialLoads?: TuiInitialLoadCoordinator,
): HomeBottomResource {
  const existing = homeResources.get(api);
  if (existing) return existing.retain();

  const next = createHomeBottomResource(api, compactHomeBottomEnabled, initialLoads).retain();
  homeResources.set(api, next);
  return next;
}

function useSessionQuotaResource(
  api: TuiPluginApi,
  sessionID: () => string,
  initialLoads?: TuiInitialLoadCoordinator,
): () => SessionQuotaResource {
  let current = acquireSessionQuotaResource(api, sessionID(), initialLoads);
  const [resource, setResource] = createSignal(current);

  createEffect(() => {
    const nextSessionID = sessionID();
    if (current.sessionID === nextSessionID) return;

    const previous = current;
    current = acquireSessionQuotaResource(api, nextSessionID, initialLoads);
    setResource(current);
    previous.release();
  });

  onCleanup(() => {
    current.release();
  });

  return resource;
}

function SidebarContentView(props: {
  api: TuiPluginApi;
  sessionID: string;
  initialLoads?: TuiInitialLoadCoordinator;
}) {
  return (
    <ChineseSidebarContentView api={props.api} sessionID={props.sessionID} initialLoads={props.initialLoads} />
  );
}

function CompactStatusLine(props: {
  api: TuiPluginApi;
  panel: () => CompactStatusState;
  justifyContent: "flex-start" | "center" | "flex-end";
  blankLineBefore?: boolean;
}) {
  const text = () => {
    const panel = props.panel();
    if (!shouldRenderCompactStatus(panel)) return "";
    return getCompactStatusText(panel);
  };

  const line = () => (
    <box flexDirection="row" justifyContent={props.justifyContent}>
      <text fg={props.api.theme.current.textMuted} wrapMode="none">
        {text()}
      </text>
    </box>
  );

  return (
    <Show when={text()}>
      <Show when={props.blankLineBefore} fallback={line()}>
        <box gap={0}>
          <text> </text>
          {line()}
        </box>
      </Show>
    </Show>
  );
}

function SessionPromptWithCompactStatus(props: {
  api: TuiPluginApi;
  sessionID: string;
  visible?: boolean;
  disabled?: boolean;
  onSubmit?: () => void;
  promptRef?: TuiPromptRefCallback;
  initialLoads?: TuiInitialLoadCoordinator;
}) {
  const resource = useSessionQuotaResource(props.api, () => props.sessionID, props.initialLoads);
  const panel = () => resource().compact();

  return (
    <box gap={0}>
      <props.api.ui.Prompt
        sessionID={props.sessionID}
        visible={props.visible}
        disabled={props.disabled}
        onSubmit={props.onSubmit}
        ref={props.promptRef}
      />
      <CompactStatusLine api={props.api} panel={panel} justifyContent="flex-end" />
    </box>
  );
}

function HomeBottomView(props: {
  api: TuiPluginApi;
  compactHomeBottomEnabled: boolean;
  initialLoads?: TuiInitialLoadCoordinator;
}) {
  const resource = acquireHomeBottomResource(
    props.api,
    props.compactHomeBottomEnabled,
    props.initialLoads,
  );
  onCleanup(() => resource.release());

  const announcement = () => getHomeBottomAnnouncementText(resource.bottom());
  const compact = () => resource.bottom().compact;
  const visible = () => shouldRenderHomeBottom(resource.bottom());

  return (
    <box gap={0}>
      <Show when={visible()}>
        <text> </text>
      </Show>
      <Show when={visible() && announcement()}>
        <box flexDirection="row" justifyContent="center">
          <text fg={props.api.theme.current.textMuted} wrapMode="none">
            {announcement()}
          </text>
        </box>
      </Show>
      <Show when={visible()}>
        <CompactStatusLine api={props.api} panel={compact} justifyContent="center" />
      </Show>
    </box>
  );
}

// Ticket 07: startup hint resource. The hint is the first real consumer of the
// unified quota snapshot projection seam; it renders once on the OpenCode home
// page as a quiet single line and refreshes with the normal home lifecycle.
const startupHintResources = new WeakMap<TuiPluginApi, StartupHintResource>();

type StartupHintResource = {
  hint: () => StartupHintState;
  retain: () => StartupHintResource;
  release: () => void;
};

function createStartupHintResource(
  api: TuiPluginApi,
  initialLoads?: TuiInitialLoadCoordinator,
): StartupHintResource {
  const [hint, setHint] = createSignal<StartupHintState>({ status: "loading" });

  let loadOrdinal = 0;
  const lifecycle = createTuiRefreshLifecycle({
    load: () => {
      const initialRuntimeSeed =
        loadOrdinal === 0 ? initialLoads?.takeStartupHintHome() : undefined;
      loadOrdinal += 1;
      return loadTuiStartupHint({
        api,
        ...(initialRuntimeSeed ? { initialRuntimeSeed } : {}),
      });
    },
    apply: setHint,
    intervalMs: REFRESH_INTERVAL_MS,
    eventRefreshDelaysMs: EVENT_REFRESH_DELAYS_MS,
    subscribe: (scheduleRefresh) => [
      api.event.on("session.updated", scheduleRefresh),
      api.event.on("message.updated", scheduleRefresh),
      api.event.on("message.removed", scheduleRefresh),
      api.event.on("tui.session.select", scheduleRefresh),
    ],
    onDispose: () => {
      startupHintResources.delete(api);
    },
  });

  const resource: StartupHintResource = {
    hint,
    retain: () => {
      lifecycle.retain();
      return resource;
    },
    release: lifecycle.release,
  };

  return resource;
}

function acquireStartupHintResource(
  api: TuiPluginApi,
  initialLoads?: TuiInitialLoadCoordinator,
): StartupHintResource {
  const existing = startupHintResources.get(api);
  if (existing) return existing.retain();

  const next = createStartupHintResource(api, initialLoads).retain();
  startupHintResources.set(api, next);
  return next;
}

function StartupHintView(props: { api: TuiPluginApi; initialLoads?: TuiInitialLoadCoordinator }) {
  const resource = acquireStartupHintResource(props.api, props.initialLoads);
  onCleanup(() => resource.release());

  const text = () => {
    const hint = resource.hint();
    return hint.status === "ready" ? hint.text : "";
  };

  return (
    <Show when={text()}>
      <box flexDirection="row" justifyContent="center">
        <text fg={props.api.theme.current.textMuted} wrapMode="none">
          {text()}
        </text>
      </box>
    </Show>
  );
}

// Upstream v4.6.1: opt-in TUI prompt quota bar. The bar renders under the
// prompt when quotaToast.tuiPromptBar.enabled is true (default false); the
// existing compact status remains the session_prompt fallback. Data selection
// prefers a five-hour window and falls back to the lowest remaining percent.
const PROMPT_BAR_WIDTH = 12;

function shouldRenderPromptBar(
  bar: PromptBarState,
): bar is Extract<PromptBarState, { status: "ready" }> {
  return bar.status === "ready" && Boolean(bar.entry);
}

function useSessionRunning(api: TuiPluginApi, sessionID: () => string): () => boolean {
  const [running, setRunning] = createSignal(false);
  createEffect(() => {
    const id = sessionID();
    if (!id) {
      setRunning(false);
      return;
    }
    const update = () => {
      try {
        const sessionState = api.state.session as {
          status?: (sessionID: string) => { type?: string } | undefined;
        };
        const status = sessionState.status?.(id);
        setRunning(status?.type === "busy" || status?.type === "retry");
      } catch {
        setRunning(false);
      }
    };
    update();
    const disposers = [
      api.event.on("session.status", (event) => {
        if (event.properties?.sessionID === id) {
          update();
        }
      }),
      api.event.on("session.updated", (event) => {
        if (event.properties?.info?.id === id) {
          update();
        }
      }),
    ];
    onCleanup(() => {
      for (const dispose of disposers) {
        if (typeof dispose === "function") {
          dispose();
        }
      }
    });
  });
  return running;
}

function buildPromptBarParts(params: {
  bar: () => PromptBarState;
  running: () => boolean;
  phase: () => number;
}): { label: string; barText: string; meta: string } | undefined {
  const bar = params.bar();
  if (!shouldRenderPromptBar(bar)) return undefined;
  const entry = bar.entry;
  if (!entry) return undefined;
  const windowLabel =
    extractSingleWindowWindowLabel(entry.label ?? "") ??
    extractSingleWindowWindowLabel(entry.name ?? "") ??
    "额度";
  const percent = formatDisplayedPercentLabel(
    entry.percentRemaining ?? 0,
    bar.percentDisplayMode ?? "remaining",
  );
  const reset = entry.resetTimeIso
    ? formatResetCountdown(entry.resetTimeIso, {
        compactRounded: true,
        decimals: bar.resetTimeDecimals,
      })
    : "";
  const p = Math.max(0, Math.min(100, Math.round(entry.percentRemaining ?? 0)));
  const filled = Math.round((p / 100) * PROMPT_BAR_WIDTH);
  const empty = PROMPT_BAR_WIDTH - filled;
  let barText = "█".repeat(filled) + "░".repeat(empty);
  if (params.running() && filled > 0) {
    const cells = Array(filled).fill("▓");
    const center = params.phase() % filled;
    const gradient = ["▒", "▓", "█", "▓", "▒"];
    for (let offset = -2; offset <= 2; offset++) {
      const position = (center + offset + filled) % filled;
      cells[position] = gradient[offset + 2];
    }
    barText = cells.join("") + "░".repeat(empty);
  }
  return {
    label: windowLabel,
    barText,
    meta: [percent.replace(/\s+left$/u, ""), reset].filter(Boolean).join(" | "),
  };
}

function PromptQuotaHint(props: {
  api: TuiPluginApi;
  bar: () => PromptBarState;
  running: () => boolean;
  phase: () => number;
}) {
  const parts = () => buildPromptBarParts(props);
  const barColor = () => props.api.theme.current.textMuted;
  const label = () => parts()?.label ?? "";
  const bar = () => parts()?.barText ?? "";
  const meta = () => parts()?.meta ?? "";

  return (
    <Show when={parts()}>
      <box flexDirection="row" justifyContent="flex-end" gap={1}>
        <text fg={props.api.theme.current.textMuted} wrapMode="none">
          {label()}
        </text>
        <text fg={barColor()} wrapMode="none">
          {bar()}
        </text>
        <text fg={props.api.theme.current.textMuted} wrapMode="none">
          {meta()}
        </text>
      </box>
    </Show>
  );
}

function SessionQuotaPromptBar(props: {
  api: TuiPluginApi;
  sessionID: string;
  initialLoads?: TuiInitialLoadCoordinator;
  visible?: boolean;
  disabled?: boolean;
  onSubmit?: () => void;
  promptRef?: TuiPromptRefCallback;
}) {
  const resource = useSessionQuotaResource(props.api, () => props.sessionID, props.initialLoads);
  const promptBar = () => resource().promptBar();
  const running = useSessionRunning(props.api, () => props.sessionID);
  const [phase, setPhase] = createSignal(0);
  createEffect(() => {
    if (!running() || !shouldRenderPromptBar(promptBar())) {
      setPhase(0);
      return;
    }
    const interval = setInterval(() => setPhase((p) => p + 1), 160);
    onCleanup(() => clearInterval(interval));
  });

  return (
    <box gap={0}>
      <props.api.ui.Prompt
        sessionID={props.sessionID}
        visible={props.visible}
        disabled={props.disabled}
        onSubmit={props.onSubmit}
        ref={props.promptRef}
      />
      <PromptQuotaHint api={props.api} bar={promptBar} running={running} phase={phase} />
    </box>
  );
}

function getActiveTuiSessionID(api: TuiPluginApi): string | undefined {
  if (api.route.current.name !== "session") return undefined;
  return normalizeTuiSessionID(api.route.current.params?.sessionID);
}

function getTuiCommandArguments(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["arguments", "args", "query"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function CommandLoadingDialog(props: { api: TuiPluginApi; title: string }) {
  return (
    <box gap={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <text fg={props.api.theme.current.text}>
        <b>{props.title}</b>
      </text>
      <text fg={props.api.theme.current.textMuted}>正在加载本地统计...</text>
    </box>
  );
}

function CommandOutputDialog(props: { api: TuiPluginApi; title: string; output: string }) {
  const lines = () => props.output.split("\n");
  const bodyHeight = () => Math.min(28, Math.max(6, lines().length));
  return (
    <box gap={1} width="100%" flexGrow={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <text fg={props.api.theme.current.text}>
        <b>{props.title}</b>
      </text>
      <scrollbox width="100%" flexGrow={1} minHeight={bodyHeight()} maxHeight={28}>
        <box gap={0} width="100%" minWidth={0}>
          {lines().map((line) => (
            <text fg={props.api.theme.current.text} wrapMode="word" width="100%">
              {line || " "}
            </text>
          ))}
        </box>
      </scrollbox>
      <text fg={props.api.theme.current.textMuted}>按 Esc 关闭</text>
    </box>
  );
}

function CommandErrorDialog(props: { api: TuiPluginApi; title: string; error: unknown }) {
  const message = props.error instanceof Error ? props.error.message : String(props.error);
  return (
    <box gap={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <text fg={props.api.theme.current.text}>
        <b>{props.title}</b>
      </text>
      <text fg={props.api.theme.current.text}>额度命令执行失败。</text>
      <text fg={props.api.theme.current.textMuted} wrapMode="none">
        {message || "未知错误"}
      </text>
      <text fg={props.api.theme.current.textMuted}>按 Esc 关闭</text>
    </box>
  );
}

function getCommandPromptCopy(spec: QuotaDialogCommandSpec): {
  title: string;
  placeholder: string;
  description: string;
} {
  switch (spec.id) {
    case "tokens_between":
      return {
        title: "OpenCode 额度 token 日期范围",
        placeholder: "YYYY-MM-DD YYYY-MM-DD",
        description: "输入开始和结束日期，例如：2026-01-01 2026-01-15",
      };
    case "quota_status":
      return {
        title: "OpenCode 额度状态选项",
        placeholder: '可选 JSON，例如 {"refreshGoogleTokens":true}',
        description: "留空执行普通诊断，或输入一个 JSON 选项对象。",
      };
    default:
      return {
        title: spec.title,
        placeholder: "可选参数",
        description: "留空即可无参数执行。",
      };
  }
}

function replaceDialog(api: TuiPluginApi, size: DialogSize, render: () => JSX.Element): void {
  api.ui.dialog.replace(render);
  // OpenCode dialog.replace() resets size to medium.
  api.ui.dialog.setSize(size);
}

async function runQuotaDialogCommandAsync(
  api: TuiPluginApi,
  command: QuotaDialogCommandId,
  commandDisplay: TuiCommandDisplay,
  rawInput?: unknown,
  state?: QuotaDialogCommandState,
): Promise<void> {
  const spec = QUOTA_DIALOG_COMMANDS.find((item) => item.id === command)!;
  const argumentsText = getTuiCommandArguments(rawInput);
  const sessionID = getActiveTuiSessionID(api);

  if (spec.acceptsArguments && rawInput === undefined) {
    const prompt = getCommandPromptCopy(spec);
    replaceDialog(api, "medium", () => (
      <api.ui.DialogPrompt
        title={prompt.title}
        placeholder={prompt.placeholder}
        description={() => (
          <text fg={api.theme.current.textMuted} wrapMode="word">
            {prompt.description}
          </text>
        )}
        onCancel={() => api.ui.dialog.clear()}
        onConfirm={(value) => {
          void runQuotaDialogCommandAsync(
            api,
            command,
            commandDisplay,
            { arguments: value.trim() },
            state,
          );
        }}
      />
    ));
    return;
  }

  const destination =
    commandDisplay === "inline" && sessionID
      ? { type: "inline" as const, sessionID }
      : { type: "dialog" as const };
  if (destination.type === "dialog") {
    replaceDialog(api, spec.dialogSize, () => (
      <CommandLoadingDialog api={api} title={spec.title} />
    ));
  }

  try {
    const result = await buildQuotaDialogCommandOutput({
      command,
      arguments: argumentsText,
      client: createTuiQuotaClient(api),
      roots: getTuiRuntimeRootHints(api),
      sessionID,
      resolveSessionMeta: (id) => getTuiSessionModelMeta(api, id),
      lastSessionTokenError: state?.lastSessionTokenError,
      setLastSessionTokenError: state
        ? (error) => {
            state.lastSessionTokenError = error;
          }
        : undefined,
      log: async (message, extra) => {
        await api.client.app.log({
          body: {
            service: "quota-toast",
            level: "debug",
            message,
            extra,
          },
        });
      },
    });

    if (result.state === "noop") {
      if (destination.type === "dialog") api.ui.dialog.clear();
      return;
    }

    if (destination.type === "inline") {
      await api.client.session.prompt({
        sessionID: destination.sessionID,
        noReply: true,
        parts: [{ type: "text", text: result.output, ignored: true }],
      });
      return;
    }

    replaceDialog(api, result.dialogSize, () => (
      <CommandOutputDialog api={api} title={result.title} output={result.output} />
    ));
  } catch (error) {
    replaceDialog(api, "large", () => (
      <CommandErrorDialog api={api} title={spec.title} error={error} />
    ));
    api.ui.toast({
      variant: "error",
        message: "额度命令执行失败",
    });
  }
}

// Upstream v4.6.0: commands are registered once; each run consults the
// registration gate so no command executes before the surface registration
// settles or after disposal.
function registerQuotaDialogCommands(api: TuiPluginApi, gate: TuiRegistrationGate): void {
  const commandState: QuotaDialogCommandState = {};
  const dispose = api.keymap.registerLayer({
    commands: QUOTA_DIALOG_COMMANDS.map((spec) => ({
      namespace: "palette",
      name: `opencode-quota.${spec.id}`,
      title: spec.title,
      desc: spec.description,
       category: "OpenCode 额度",
      slashName: spec.slashName,
      run(input?: unknown) {
        const state = gate.current();
        if (state.status !== "active") return;
        void runQuotaDialogCommandAsync(
          api,
          spec.id,
          state.registration.commandDisplay,
          input,
          commandState,
        );
      },
    })),
    bindings: [],
  });

  api.lifecycle.onDispose(dispose);
}

// Upstream v4.6.0: slots are registered up front (so OpenCode never sees a
// missing surface), but each slot renders nothing until the registration gate
// turns active with the matching surface enabled. The Chinese sidebar content
// keeps its own collectQuotaRenderData view; session_prompt/home_bottom reuse
// the shared session/home resources with the initial-load coordinator.
function registerStableTuiSlots(api: TuiPluginApi, current: () => TuiRegistrationState): void {
  api.slots.register({
    order: SIDEBAR_ORDER,
    slots: {
      sidebar_content(_ctx, props: { session_id: string }) {
        const state = current();
        if (state.status !== "active" || !state.registration.sidebar.enabled) return null;
        return (
          <SidebarContentView
            api={api}
            sessionID={props.session_id}
            initialLoads={state.initialLoads}
          />
        );
      },
    },
  });

  api.slots.register({
    order: COMPACT_ORDER,
    slots: {
      session_prompt(
        _ctx,
        props: {
          session_id: string;
          visible?: boolean;
          disabled?: boolean;
          on_submit?: () => void;
          ref?: TuiPromptRefCallback;
        },
      ) {
        const state = current();
        if (state.status !== "active") return null;
        if (state.registration.promptBar.enabled) {
          return (
            <SessionQuotaPromptBar
              api={api}
              sessionID={props.session_id}
              initialLoads={state.initialLoads}
              visible={props.visible}
              disabled={props.disabled}
              onSubmit={props.on_submit}
              promptRef={props.ref}
            />
          );
        }
        if (!state.registration.compact.sessionPrompt) return null;
        return (
          <SessionPromptWithCompactStatus
            api={api}
            sessionID={props.session_id}
            initialLoads={state.initialLoads}
            visible={props.visible}
            disabled={props.disabled}
            onSubmit={props.on_submit}
            promptRef={props.ref}
          />
        );
      },
      home_bottom() {
        const state = current();
        if (state.status !== "active") return null;
        const startupHintEnabled = state.registration.startupHint?.enabled === true;
        const homeBottomEnabled = state.registration.homeBottom === true;
        if (!startupHintEnabled && !homeBottomEnabled) return null;
        if (!startupHintEnabled) {
          return (
            <HomeBottomView
              api={api}
              compactHomeBottomEnabled={state.registration.compact.homeBottom}
              initialLoads={state.initialLoads}
            />
          );
        }
        if (!homeBottomEnabled) {
          return <StartupHintView api={api} initialLoads={state.initialLoads} />;
        }
        // Conditional children (ternaries) keep component mounting explicit;
        // StartupHintView/HomeBottomView manage their own refresh lifecycles.
        return (
          <box gap={0}>
            {<StartupHintView api={api} initialLoads={state.initialLoads} />}
            {
              <HomeBottomView
                api={api}
                compactHomeBottomEnabled={state.registration.compact.homeBottom}
                initialLoads={state.initialLoads}
              />
            }
          </box>
        );
      },
    },
  });
}

// Upstream v4.5.1 + v4.6.0: configuration checks may be slow, so TUI startup
// must not block on them. The gate starts pending, the stable slots are
// registered immediately (they render nothing until active), and commands
// execute only after the gate activates. The resolved runtime context is
// captured once and handed to the first session/home loads so the first quota
// frame appears without re-reading configuration.
async function initializeTuiRegistration(
  api: TuiPluginApi,
  gate: TuiRegistrationGate,
): Promise<void> {
  let initialRuntimeSeed: TuiInitialRuntimeSeed | undefined;
  let surfaceRegistration: Promise<{
    registration: TuiSurfaceRegistration;
    initialRuntimeSeed?: TuiInitialRuntimeSeed;
  }>;
  try {
    surfaceRegistration = resolveTuiSurfaceRegistration(api, {
      captureInitialRuntime(seed) {
        initialRuntimeSeed = seed;
      },
    })
      .then((registration) => ({ registration, initialRuntimeSeed }))
      .catch(() => ({ registration: FALLBACK_SURFACE_REGISTRATION }));
  } catch {
    surfaceRegistration = Promise.resolve({ registration: FALLBACK_SURFACE_REGISTRATION });
  }

  registerQuotaDialogCommands(api, gate);
  void surfaceRegistration.then(({ registration, initialRuntimeSeed: seed }) =>
    gate.activate(
      registration,
      seed ? createTuiInitialLoadCoordinator(seed) : undefined,
    ),
  );
  registerStableTuiSlots(api, gate.current);
}

const tui: TuiPlugin = async (api) => {
  const registrationGate = createTuiRegistrationGate();
  api.lifecycle.onDispose(() => {
    registrationGate.dispose();
    disposeQuotaTelemetryOwner(createTuiQuotaClient(api));
  });

  void initializeTuiRegistration(api, registrationGate).catch(() => {});
};

const pluginModule: TuiPluginModule & { id: string } = {
  id,
  tui,
};

export default pluginModule;
