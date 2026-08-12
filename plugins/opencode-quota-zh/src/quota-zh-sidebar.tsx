/** @jsxImportSource @opentui/solid */
import { For, Show, createSignal, onCleanup } from "solid-js";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { QuotaToastEntry } from "./lib/entries.js";
import { createQuotaRuntimeRequestContext, resolveQuotaRuntimeContext } from "./lib/quota-runtime-context.js";
import { collectQuotaRenderData } from "./lib/quota-render-data.js";
import {
  createTuiQuotaClient,
  getMatchingInitialRuntimeSeed,
  getTuiRuntimeRootHints,
  getTuiSessionModelMeta,
  type TuiInitialRuntimeSeed,
} from "./lib/tui-runtime.js";

// Ticket 05: the Chinese sidebar reuses the initial runtime seed captured
// during surface registration (like the session/home resources) so its first
// load does not re-read configuration. The seed is consumed at most once per
// surface by the registration gate coordinator in src/tui.tsx.
type SidebarInitialLoads = {
  takeSidebarSession: () => TuiInitialRuntimeSeed | undefined;
};

type SidebarRow = {
  label: string;
  percent?: number;
  value?: string;
  right?: string;
  resetTimeIso?: string;
};

type SidebarCard = {
  label: string;
  rows: SidebarRow[];
  error?: string;
};

type SidebarState =
  | { status: "loading"; cards: SidebarCard[] }
  | { status: "ready"; cards: SidebarCard[] }
  | { status: "disabled"; cards: SidebarCard[] }
  | { status: "error"; cards: SidebarCard[]; message: string };

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function barColor(percent: number): string {
  if (percent >= 50) return "#00C853";
  if (percent >= 25) return "#F9A825";
  return "#D32F2F";
}

function QuotaBar(props: { api: TuiPluginApi; percent: number }) {
  const filled = Math.max(0, Math.min(20, Math.round(props.percent / 5)));
  return (
    <text>
      <span style={{ fg: barColor(props.percent) }}>{"█".repeat(filled)}</span>
      <span style={{ fg: props.api.theme.current.textMuted }}>{"░".repeat(20 - filled)}</span>
    </text>
  );
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${minutes}分钟`;
  if (minutes > 0) return `${minutes}分钟`;
  return `${totalSeconds % 60}秒`;
}

function formatReset(resetTimeIso?: string): string {
  if (!resetTimeIso) return "";
  const reset = new Date(resetTimeIso);
  if (Number.isNaN(reset.getTime())) return "";
  const diff = reset.getTime() - Date.now();
  if (diff <= 0) return "已重置";

  const absolute = reset.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `剩余 ${formatDuration(diff)}（${absolute}）`;
}

function entryGroup(entry: QuotaToastEntry): string {
  return entry.group || entry.accounting.sourceId || entry.name;
}

function entryLabel(entry: QuotaToastEntry): string {
  const label = entry.group ? entry.label || entry.name : entry.name;
  return label.replace(/\bBalance\b:?/gi, "额度");
}

function displayLabel(label: string): string {
  return label.replace(/\bBalance\b:?/gi, "额度");
}

function buildCards(result: any): SidebarCard[] {
  const data = result.allWindowsData ?? result.data;
  const cards = new Map<string, SidebarCard>();

  for (const entry of (data?.entries ?? []) as QuotaToastEntry[]) {
    const key = entryGroup(entry);
    const card = cards.get(key) ?? { label: key, rows: [] };
    if (entry.kind === "value") {
      card.rows.push({
        label: entryLabel(entry),
        value: entry.value,
        right: entry.right,
        resetTimeIso: entry.resetTimeIso,
      });
    } else {
      card.rows.push({
        label: entryLabel(entry),
        percent: clampPercent(entry.percentRemaining),
        right: entry.right,
        resetTimeIso: entry.resetTimeIso,
      });
    }
    cards.set(key, card);
  }

  for (const error of (data?.errors ?? []) as Array<{ label: string; message: string }>) {
    const key = error.label || "额度";
    const card = cards.get(key) ?? { label: key, rows: [] };
    card.error = error.message;
    cards.set(key, card);
  }

  return [...cards.values()];
}

async function loadSidebar(
  api: TuiPluginApi,
  sessionID: string,
  initialLoads?: SidebarInitialLoads,
): Promise<SidebarState> {
  const client = createTuiQuotaClient(api);
  const initialRuntimeSeed = getMatchingInitialRuntimeSeed(
    api,
    initialLoads?.takeSidebarSession(),
  );
  const runtime = await resolveQuotaRuntimeContext({
    client,
    roots: getTuiRuntimeRootHints(api),
    sessionID,
    resolveSessionMeta: (id) => getTuiSessionModelMeta(api, id),
    includeSessionMeta: (config) => config.onlyCurrentModel,
    config: initialRuntimeSeed?.config,
    configMeta: initialRuntimeSeed?.configMeta,
    providers: initialRuntimeSeed?.providers,
  });

  if (!runtime.config.enabled || !runtime.config.tuiSidebarPanel.enabled) {
    return { status: "disabled", cards: [] };
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

  if (result.selection?.waitingForCurrentSelection) {
    return { status: "loading", cards: [] };
  }
  return { status: "ready", cards: buildCards(result) };
}

function QuotaCard(props: { api: TuiPluginApi; card: SidebarCard }) {
  const theme = () => props.api.theme.current;
  return (
    <box flexDirection="column" gap={0}>
      <text fg={theme().text}><b>{displayLabel(props.card.label)}</b></text>
      <Show when={props.card.error}>
        <text fg={theme().error}>错误：{props.card.error}</text>
      </Show>
      <For each={props.card.rows}>{(row) => (
        <Show when={row.percent !== undefined} fallback={
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme().textMuted}>{row.label}</text>
            <text fg={theme().text}>{row.value ?? row.right ?? "—"}</text>
          </box>
        }>
          <box flexDirection="column" gap={0}>
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().text}>{row.label}</text>
              <text fg={theme().textMuted}>{formatReset(row.resetTimeIso)}</text>
            </box>
            <QuotaBar api={props.api} percent={row.percent!} />
            <box flexDirection="row" justifyContent="flex-end">
              <text fg={theme().textMuted}>{row.right ? `${row.right} · ` : ""}{100 - row.percent!}% 已用 / </text>
               <text fg={barColor(row.percent!)}>{row.percent!}% 剩余</text>
            </box>
          </box>
        </Show>
      )}</For>
    </box>
  );
}

function QuotaOverview(props: { api: TuiPluginApi; cards: SidebarCard[] }) {
  const theme = () => props.api.theme.current;
  return (
    <box flexDirection="column" gap={0}>
      <text fg={theme().textMuted}>概述</text>
      <For each={props.cards}>{(card) => {
        const percentRows = card.rows.filter((row) => row.percent !== undefined);
        const valueRows = card.rows.filter((row) => row.percent === undefined);
        const summary = percentRows.length > 0
          ? percentRows.map((row) => `${row.percent}%`).join(" / ") + " 剩余"
          : valueRows.map((row) => row.value ?? row.right ?? "—").filter(Boolean).join(" · ") || "—";
        return (
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme().textMuted}>{displayLabel(card.label)}</text>
            <text fg={theme().text}>{card.error ? "错误" : summary}</text>
          </box>
        );
      }}</For>
    </box>
  );
}

export function ChineseSidebarContentView(props: {
  api: TuiPluginApi;
  sessionID: string;
  initialLoads?: SidebarInitialLoads;
}) {
  const [state, setState] = createSignal<SidebarState>({ status: "loading", cards: [] });
  const [collapsed, setCollapsed] = createSignal(
    props.api.kv?.get("quota-zh-sidebar-collapsed", false) ?? false,
  );
  let inFlight = false;
  let queued = false;
  let disposed = false;

  const reload = () => {
    if (disposed) return;
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    loadSidebar(props.api, props.sessionID, props.initialLoads)
      .then(setState)
      .catch((error) => {
        setState({
          status: "error",
          cards: [],
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        inFlight = false;
        if (queued) {
          queued = false;
          reload();
        }
      });
  };

  const timers = [
    setTimeout(reload, 150),
    setTimeout(reload, 600),
    setTimeout(reload, 1500),
  ];
  const interval = setInterval(reload, 60_000);
  const unsubs = [
    props.api.event.on("session.updated", (event) => {
      if (event?.properties?.info?.id === props.sessionID) reload();
    }),
    props.api.event.on("message.updated", (event) => {
      if (event?.properties?.info?.sessionID === props.sessionID) reload();
    }),
    props.api.event.on("message.removed", (event) => {
      if (event?.properties?.sessionID === props.sessionID) reload();
    }),
    props.api.event.on("tui.session.select", (event) => {
      if (event?.properties?.sessionID === props.sessionID) reload();
    }),
  ];
  reload();

  onCleanup(() => {
    disposed = true;
    clearInterval(interval);
    for (const timer of timers) clearTimeout(timer);
    for (const unsubscribe of unsubs) unsubscribe();
  });

  const toggleCollapsed = () => {
    const next = !collapsed();
    setCollapsed(next);
    props.api.kv?.set("quota-zh-sidebar-collapsed", next);
  };

  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="row" gap={1} onMouseDown={toggleCollapsed}>
        <text fg={props.api.theme.current.text}>{collapsed() ? "▶" : "▼"}</text>
        <text fg={props.api.theme.current.text}><b>额度</b></text>
        <Show when={collapsed() && state().status === "ready" && state().cards.length > 0}>
          <text fg={props.api.theme.current.textMuted}>（{state().cards.length} 个提供商）</text>
        </Show>
      </box>
      <Show when={collapsed()}>
        <Show when={state().status === "loading"}>
          <text fg={props.api.theme.current.textMuted}>加载中...</text>
        </Show>
        <Show when={state().status === "error"}>
          <text fg={props.api.theme.current.error}>加载失败：{(state() as { message: string }).message}</text>
        </Show>
        <Show when={state().status === "ready" && state().cards.length === 0}>
          <text fg={props.api.theme.current.textMuted}>暂无额度数据</text>
        </Show>
        <Show when={state().status === "ready" && state().cards.length > 0}>
          <QuotaOverview api={props.api} cards={state().cards} />
        </Show>
      </Show>
      <Show when={!collapsed()}>
        <Show when={state().status === "loading"}>
          <text fg={props.api.theme.current.textMuted}>加载中...</text>
        </Show>
        <Show when={state().status === "error"}>
          <text fg={props.api.theme.current.error}>加载失败：{(state() as { message: string }).message}</text>
        </Show>
        <Show when={state().status === "ready" && state().cards.length === 0}>
          <text fg={props.api.theme.current.textMuted}>暂无额度数据</text>
        </Show>
        <For each={state().cards}>{(card) => <QuotaCard api={props.api} card={card} />}</For>
      </Show>
    </box>
  );
}
