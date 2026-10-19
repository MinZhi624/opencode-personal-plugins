/** @jsxImportSource @opentui/solid */

import "@opentui/solid/preload"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { sanitizeDisplayText } from "./v6/lib/display-sanitize.js"
import nativeTuiPlugin from "./v6/tui/index.js"
import type { DisplaySettings } from "./v6/tui/display.js"
import type { Words } from "./v6/core/types.js"
import {
  DEFAULT_WORDS,
  type BarShape,
  barParts,
  evenUseCell,
  formatDuration,
} from "./v6/view/format.js"
import {
  buildV6QuotaSidebarCards,
  evenUseLeft,
  QUOTA_SIDEBAR_UNKNOWN_VALUE,
  type QuotaSidebarCard,
  type QuotaSidebarPercentRow,
  type QuotaSidebarRow,
  type QuotaSidebarValueRow,
  type QuotaSnapshotResponse,
} from "./lib/quota-sidebar-cards.js"
import { readLocalQuotaHost, subscribeLocalQuotaHost } from "./local-tui-bridge.js"
import { quotaCallOptions } from "./v6/tui/client.js"
import { quotaRpc } from "./quota-rpc.js"

// The sidebar card model — cards, rows, snapshot statuses and the unknown
// marker — is defined once in ./lib/quota-sidebar-cards.js and shared with the
// V2 server RPC. This renderer only consumes those types; it never redefines
// or forks them. Percent rows keep the raw remaining percentage so the panel
// never has to parse display text back into numbers.
//
// Quota data comes from the shared bridge host while the native TUI has
// published one: the same quota client and the same settings draft every
// native surface reads, so the card previews edits and follows publish,
// revoke and another plugin copy's data. Without a host — and before the
// host's first snapshot — the panel keeps its own snapshot RPC polling as
// the fallback, so a stopped quota background or a failing RPC surfaces as
// an error or its last good data instead of an endless "加载中".

const BAR_CELLS = 20
/** A bar under this many cells gets no even-use mark, as upstream draws it. */
const EVEN_USE_MIN_CELLS = 3
/** The mark where even use would be, as the upstream bars draw it. */
const EVEN_USE_MARK = "┃"
/** The bar shape without the host's settings: the local default. */
const BAR_SHAPE_FALLBACK: BarShape = "blocks"
/** The countdown's units in the local words, for the upstream styles. */
const COUNTDOWN_UNITS: Record<string, string> = { d: "天", h: "小时", m: "分钟", s: "秒" }

// Quota data comes from the shared bridge host when the native TUI published
// one: the same quota client and settings draft every native surface reads.
// Without a host the panel keeps its own snapshot RPC polling as the
// fallback. A failed query surfaces as the panel error state instead of
// falling back to a local V1-style path. The snapshot RPC is the public quota
// data interface: it stays available regardless of card visibility, and
// reports a disabled quota background as its own status instead of an empty
// card list. There is no local partial-error preference anymore; the server
// decides what a card shows.
async function loadQuota(context: Context, sessionID: string): Promise<QuotaSnapshotResponse> {
  // The native client's call options: the TUI's own workspace location (its
  // `location`, else `data.location.default()`) and the RPC timeout, so the
  // server answers for this folder. Without a location the call fails with
  // that error instead of guessing a directory.
  return await context.client.rpc(quotaRpc).snapshot({ sessionID }, quotaCallOptions(context))
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function percentColor(context: Context, percent: number): string {
  const feedback = context.theme.text.feedback
  if (percent >= 50) return feedback.success?.base ?? "#00C853"
  if (percent >= 25) return feedback.warning?.base ?? "#F9A825"
  return feedback.error?.base ?? "#D32F2F"
}

type BarRun = { text: string; kind: "filled" | "empty" | "mark" }

/**
 * The bar's runs: the part left, the used part, and — with `evenLeft`, the
 * percent even use would leave now — the ┃ mark in place of the cell where
 * even use would be. `barParts` draws the shape the settings picked, and the
 * mark follows the upstream rule, so a bar too short for one gets none.
 */
function barRuns(shape: BarShape, percent: number, evenLeft?: number): BarRun[] {
  const [filled, empty] = barParts(shape, percent, BAR_CELLS)
  const cells: BarRun[] = [
    ...[...filled].map((text) => ({ text, kind: "filled" as const })),
    ...[...empty].map((text) => ({ text, kind: "empty" as const })),
  ]
  if (evenLeft !== undefined && shape !== "none" && BAR_CELLS >= EVEN_USE_MIN_CELLS) {
    const at = evenUseCell(evenLeft, BAR_CELLS)
    if (at >= 0 && at < cells.length) cells[at] = { text: EVEN_USE_MARK, kind: "mark" }
  }
  const runs: BarRun[] = []
  for (const cell of cells) {
    const last = runs[runs.length - 1]
    if (last && last.kind === cell.kind) last.text += cell.text
    else runs.push({ ...cell })
  }
  return runs
}

function QuotaBar(props: { context: Context; percent: number; shape: BarShape; evenLeft?: number }) {
  const theme = () => props.context.theme
  return (
    <box flexDirection="row">
      <For each={barRuns(props.shape, props.percent, props.evenLeft)}>
        {(run) => (
          <text
            fg={
              run.kind === "filled"
                ? percentColor(props.context, props.percent)
                : run.kind === "mark"
                  ? theme().text.base
                  : theme().text.muted
            }
          >
            {run.text}
          </text>
        )}
      </For>
    </box>
  )
}

/**
 * The countdown in the style the words picked, in the local units: the
 * upstream duration rules — all five styles and their precision — with the
 * Chinese words for their units, so "2h 35m" reads "2小时35分钟".
 */
function countdownText(ms: number, words: Words): string {
  const text = formatDuration(ms, words.reset, words.resetDecimals)
  return text.replace(/[dhms]/g, (unit) => COUNTDOWN_UNITS[unit] ?? unit).replace(/\s+/g, "")
}

function formatReset(resetTimeIso: string | undefined, words: Words, nowMs: number): string {
  if (!resetTimeIso) return ""
  const reset = new Date(resetTimeIso)
  if (Number.isNaN(reset.getTime())) return ""
  const absolute = reset.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
  // The countdown is measured against the panel clock, which ticks on its
  // own, so it counts down between snapshots instead of freezing.
  const diff = reset.getTime() - nowMs
  // A reset time in the past means the provider has not reported fresh data
  // yet; saying "已重置" would claim a quota the server has not confirmed.
  // The absolute reset time stays either way: it is when the window resets.
  if (diff <= 0) return `已到重置时间，待刷新（${absolute}）`
  return `剩余 ${countdownText(diff, words)}（${absolute}）`
}

/** Clock label for a card's own okAtIso; empty when missing or unparsable. */
function formatOkAt(okAtIso?: string): string {
  if (!okAtIso) return ""
  const time = new Date(okAtIso)
  if (Number.isNaN(time.getTime())) return ""
  return time.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
}

function okAtSuffix(okAtIso?: string): string {
  const clock = formatOkAt(okAtIso)
  return clock ? `，上次成功 ${clock}` : ""
}

function QuotaRow(props: {
  context: Context
  row: QuotaSidebarRow
  /** The panel clock, so a countdown ticks between snapshots. */
  nowMs: () => number
  /** The words of the snapshot the card shows, or the defaults without one. */
  words: () => Words
  /** The host's display settings, or undefined without a bridge host. */
  display: () => DisplaySettings | undefined
}) {
  const theme = () => props.context.theme
  if (props.row.kind === "percent") {
    const row = props.row
    // A missing/non-finite percentage must never render as a real 0% quota;
    // the server already maps those to unknown value rows, this is the
    // render-side guard keeping failures visually distinct from zero quota.
    if (!Number.isFinite(row.percentRemaining)) {
      return (
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme().text.muted}>{row.label}</text>
          <text fg={theme().text.base}>{QUOTA_SIDEBAR_UNKNOWN_VALUE}</text>
        </box>
      )
    }
    const percent = clampPercent(row.percentRemaining)
    // The dual percentage is the local card's own look: the upstream percent
    // words never replace "已用 / 剩余" here.
    const used = 100 - percent
    const shape = () => props.display()?.layout.bar ?? BAR_SHAPE_FALLBACK
    // The even-use mark only exists with the setting on and a window to judge
    // the row by; without either there is no mark.
    const evenLeft = () =>
      props.display()?.layout.evenUse === true ? evenUseLeft(row, props.nowMs()) : undefined
    return (
      <box flexDirection="column">
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme().text.base}>{row.label}</text>
          <text fg={theme().text.muted}>{formatReset(row.resetTimeIso, props.words(), props.nowMs())}</text>
        </box>
        <QuotaBar context={props.context} percent={percent} shape={shape()} evenLeft={evenLeft()} />
        <box flexDirection="row" justifyContent="flex-end">
          <text fg={theme().text.muted}>
            {row.right ? `${row.right} · ` : ""}
            {used}% 已用 /{" "}
          </text>
          <text fg={percentColor(props.context, percent)}>{percent}% 剩余</text>
        </box>
      </box>
    )
  }
  return (
    <box flexDirection="row" justifyContent="space-between">
      <text fg={theme().text.muted}>{props.row.label}</text>
      <text fg={theme().text.base}>{props.row.value || props.row.right || "—"}</text>
    </box>
  )
}

function QuotaCard(props: {
  context: Context
  card: QuotaSidebarCard
  stale?: boolean
  nowMs: () => number
  words: () => Words
  display: () => DisplaySettings | undefined
}) {
  const theme = () => props.context.theme
  // A card that kept its rows after a failed check is stale — whether the
  // failure came from the provider (card.error with rows retained) or from
  // the RPC transport (panel-level stale flag). The freshness note always
  // uses this card's own okAtIso, never a time borrowed from other cards.
  const stale = () =>
    (props.card.error !== undefined || props.stale === true) && props.card.rows.length > 0
  return (
    <box flexDirection="column">
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text.base}>
          <b>{props.card.label}</b>
        </text>
        <Show when={props.card.refreshing}>
          <text fg={theme().text.muted}>刷新中…</text>
        </Show>
      </box>
      {/* A card error stays attached to its card: the previously fetched rows
          keep rendering below it so a partial failure never hides old values. */}
      <Show when={props.card.error}>
        <text fg={theme().text.feedback.error.base}>错误：{props.card.error}</text>
      </Show>
      <Show when={stale()}>
        <text fg={theme().text.muted}>未更新{okAtSuffix(props.card.okAtIso)}</text>
      </Show>
      <For each={props.card.rows}>
        {(row) => (
          <QuotaRow
            context={props.context}
            row={row}
            nowMs={props.nowMs}
            words={props.words}
            display={props.display}
          />
        )}
      </For>
    </box>
  )
}

function QuotaOverview(props: { context: Context; cards: QuotaSidebarCard[] }) {
  const theme = () => props.context.theme
  return (
    <box flexDirection="column">
      <text fg={theme().text.muted}>概述</text>
      <For each={props.cards}>
        {(card) => {
          // Derived per card item so the summary always tracks the current
          // card object instead of a value captured when the item was built.
          const summary = createMemo(() => {
            const percents = card.rows
              .filter((row): row is QuotaSidebarPercentRow => row.kind === "percent")
              .map((row) =>
                Number.isFinite(row.percentRemaining)
                  ? `${clampPercent(row.percentRemaining)}%`
                  : QUOTA_SIDEBAR_UNKNOWN_VALUE,
              )
            const values = card.rows
              .filter((row): row is QuotaSidebarValueRow => row.kind === "value")
              .map((row) => row.value)
              .filter(Boolean)
            if (card.rows.length === 0) return card.error ? "错误" : "—"
            const base =
              percents.length > 0
                ? `${percents.join(" / ")} 剩余`
                : values.length > 0
                  ? values.join(" · ")
                  : "—"
            return card.error ? `${base} · 部分错误` : base
          })
          return (
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme().text.muted}>{card.label}</text>
              <text
                fg={
                  card.error && card.rows.length === 0
                    ? theme().text.feedback.error.base
                    : theme().text.base
                }
              >
                {summary()}
              </text>
            </box>
          )
        }}
      </For>
    </box>
  )
}

export function QuotaPanel(props: { context: Context; sessionID: string }) {
  // Same storage key as before: an existing stored `open` preference keeps
  // working and is never overwritten by the initial value. It is the panel's
  // own expand state, not a second copy of any display setting.
  const [settings, updateSettings] = props.context.storage.store("quota-zh-view-v2", {
    initial: { version: 2, open: true },
  })
  const [state, setState] = createSignal<"loading" | "ready" | "error" | "disabled">("loading")
  const [cards, setCards] = createSignal<QuotaSidebarCard[]>([])
  const [errorMessage, setErrorMessage] = createSignal<string>()
  // The bridge host, re-read after every publish and revoke. Reading it
  // inside a memo or the render tracks this signal, so a host change from
  // either module graph reaches the panel.
  const [hostTick, setHostTick] = createSignal(0)
  const host = () => {
    hostTick()
    return readLocalQuotaHost()
  }
  // Reset times count down between snapshots, and every new snapshot re-reads
  // the clock, so a countdown never freezes on a stale Date.now().
  const [nowMs, setNowMs] = createSignal(Date.now())
  const clock = setInterval(() => setNowMs(Date.now()), 60_000)
  onCleanup(() => clearInterval(clock))
  let disposed = false
  let running = false
  let queued = false

  const refresh = () => {
    if (disposed) return
    // The shared host answers by itself once its client holds a snapshot;
    // polling beside it would ask the same server for the same data twice.
    // While the host has no snapshot yet — the quota background stopped, or
    // the RPC failing — this poll is the panel's only answer, so it runs.
    if (hostSnapshot()) return
    if (running) {
      queued = true
      return
    }
    running = true
    void loadQuota(props.context, props.sessionID)
      .then((result) => {
        if (disposed) return
        setCards(result.cards)
        setErrorMessage(undefined)
        // A disabled quota background is an explicit state, distinct from an
        // empty ready result and from a failed request.
        setState(result.status === "disabled" ? "disabled" : "ready")
        setNowMs(Date.now())
      })
      .catch((error: unknown) => {
        if (disposed) return
        // A failed poll keeps the last successful cards on screen and only
        // marks them stale; it never replaces them with a bare error that
        // would hide the previously fetched values.
        setErrorMessage(
          sanitizeDisplayText(error instanceof Error ? error.message : String(error)),
        )
        setState("error")
      })
      .finally(() => {
        running = false
        if (queued) {
          queued = false
          refresh()
        }
      })
  }

  // The host's snapshot for this session: the same client the native surfaces
  // read, so its signals carry publish, revoke, `changed` events and another
  // plugin copy's refreshes. `watch` keeps this session's part loading; its
  // stop runs on a host change and on unmount.
  const words = () => hostSnapshot()?.words ?? DEFAULT_WORDS
  const display = () => host()?.display()
  // The Settings tabs preview the panel open (Sidebar tab) or collapsed
  // (Collapsed tab); the stored choice stands while no tab edits it.
  const panelOpen = () => host()?.editing.panelOpen() ?? settings.open
  const hostSnapshot = createMemo(() => host()?.quota.snapshot(props.sessionID))
  const hostCards = createMemo(() => {
    const snapshot = hostSnapshot()
    const surface = host()
    if (!snapshot || !surface) return undefined
    // The host's display is the draft while the Settings tabs edit it and the
    // saved settings otherwise; the card previews it either way, and a
    // discarded draft falls back to the saved state on its own. The surface
    // follows the panel: each one's hidden rows and orders are its own.
    return buildV6QuotaSidebarCards(
      snapshot,
      surface.display(),
      panelOpen() ? "sidebar" : "collapsed",
    )
  })
  // One card list: the host's snapshot while it has one — the same draft and
  // the same single client every native surface reads — and the panel's own
  // fallback otherwise. The fallback also answers while the host is still
  // waiting for its first snapshot, so a stopped quota background or a
  // failing RPC surfaces as its own state instead of an endless loading.
  const view = createMemo(() => {
    const shared = hostCards()
    if (shared) return { state: "ready" as const, cards: shared, error: undefined }
    // No host snapshot: the fallback's own answer stands — its last good
    // cards, its error, or the server's explicit disabled status. Nothing
    // here asserts why the data is missing.
    return { state: state(), cards: cards(), error: errorMessage() }
  })

  createEffect(() => {
    const current = host()
    if (!current) return
    const stop = current.quota.watch(props.sessionID)
    onCleanup(stop)
  })
  createEffect(() => {
    hostSnapshot()
    setNowMs(Date.now())
  })
  const unsubscribeHost = subscribeLocalQuotaHost(() => {
    setHostTick((tick) => tick + 1)
    // A revoked host hands the panel back to its own polling; ask at once
    // instead of waiting for the next timer.
    refresh()
  })

  const theme = () => props.context.theme
  const hasCards = () => view().cards.length > 0
  const showQuotaData = () => (view().state === "ready" || view().state === "error") && hasCards()
  // `sidebar.show` is the switch for the whole quota content, as it is for
  // the native panel: with it off the expanded card shows no numbers and the
  // collapsed one no summary, so the status line never repeats what the card
  // does not show. The card's own title stays either way: where it sits and
  // whether it shows at all remain the sidebar host's business, not this
  // setting's. Without a host there are no settings, so both stand on.
  const sidebarEnabled = () => display()?.surfaces.sidebar.enabled ?? true
  // The collapsed summary is quota content too, so `sidebar.show` gates it as
  // well: with the sidebar surface off there is no quota on screen at all,
  // and the native status line is free to take its place.
  const collapsedEnabled = () => sidebarEnabled() && (display()?.surfaces.collapsed.enabled ?? true)
  const showExpanded = () => showQuotaData() && sidebarEnabled()
  const showCollapsed = () => showQuotaData() && collapsedEnabled()

  // The native status line asks whether a sidebar panel with quota is on
  // screen. This panel is that panel, so it counts itself — but only while it
  // really renders quota data (expanded rows or the collapsed summary) under
  // a surface the settings leave on, which is exactly when the card shows
  // numbers. The count belongs to the host that published it: the effect's
  // own cleanup disposes that host's count before a host switch registers
  // the new one, and on unmount, so no count is stranded on a revoked host
  // and none is released twice.
  createEffect(() => {
    const current = host()
    if (!current) return
    if (!(panelOpen() ? showExpanded() : showCollapsed())) return
    const stop = current.editing.sidebarShown()
    onCleanup(stop)
  })

  // Polling is the fallback update mechanism; it does not depend on any
  // changed event from the quota background.
  refresh()
  const timers = [150, 600, 1500].map((delay) => setTimeout(refresh, delay))
  const interval = setInterval(refresh, 60_000)
  const unsubs = [
    props.context.data.on("session.step.ended", (event) => {
      if (event.data.sessionID === props.sessionID) refresh()
    }),
    props.context.data.on("session.execution.failed", (event) => {
      if (event.data.sessionID === props.sessionID) refresh()
    }),
  ]
  onCleanup(() => {
    disposed = true
    timers.forEach(clearTimeout)
    clearInterval(interval)
    unsubs.forEach((unsubscribe) => unsubscribe())
    unsubscribeHost()
  })

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1} onMouseDown={() => void updateSettings((draft) => { draft.open = !draft.open })}>
        <text fg={theme().text.action.primary.base}>{panelOpen() ? "▼" : "▶"}</text>
        <text fg={theme().text.action.primary.base}><b>额度</b></text>
        <Show when={!panelOpen() && hasCards() && collapsedEnabled()}>
          <text fg={theme().text.muted}>（{view().cards.length} 个提供商）</text>
        </Show>
      </box>
      <Show when={!panelOpen()}>
        <Show when={view().state === "loading"}>
          <text fg={theme().text.muted}>加载中…</text>
        </Show>
        <Show when={view().state === "disabled"}>
          <text fg={theme().text.muted}>额度后台未启用</text>
        </Show>
        <Show when={view().state === "error" && !hasCards()}>
          <box flexDirection="column">
            <text fg={theme().text.feedback.error.base}>额度查询失败</text>
            <Show when={view().error}>
              <text fg={theme().text.muted}>{view().error}</text>
            </Show>
          </box>
        </Show>
        <Show when={view().state === "ready" && !hasCards()}>
          <text fg={theme().text.muted}>暂无额度数据</text>
        </Show>
        <Show when={showCollapsed()}>
          <box flexDirection="column">
            <Show when={view().state === "error"}>
              <text fg={theme().text.feedback.error.base}>额度更新失败</text>
            </Show>
            <QuotaOverview context={props.context} cards={view().cards} />
          </box>
        </Show>
      </Show>
      <Show when={panelOpen()}>
        <Show when={view().state === "loading"}>
          <text fg={theme().text.muted}>加载中…</text>
        </Show>
        <Show when={view().state === "disabled"}>
          <text fg={theme().text.muted}>额度后台未启用</text>
        </Show>
        <Show when={view().state === "error" && !hasCards()}>
          <box flexDirection="column">
            <text fg={theme().text.feedback.error.base}>额度查询失败</text>
            <Show when={view().error}>
              <text fg={theme().text.muted}>{view().error}</text>
            </Show>
          </box>
        </Show>
        <Show when={view().state === "ready" && !hasCards()}>
          <text fg={theme().text.muted}>暂无额度数据</text>
        </Show>
        <Show when={showExpanded()}>
          <box flexDirection="column" gap={1}>
            <Show when={view().state === "error"}>
              <box flexDirection="column">
                <text fg={theme().text.feedback.error.base}>额度更新失败</text>
                <Show when={view().error}>
                  <text fg={theme().text.muted}>{view().error}</text>
                </Show>
              </box>
            </Show>
            <For each={view().cards}>
              {(card) => (
                <QuotaCard
                  context={props.context}
                  card={card}
                  stale={view().state === "error"}
                  nowMs={nowMs}
                  words={words}
                  display={display}
                />
              )}
            </For>
          </box>
        </Show>
      </Show>
    </box>
  )
}

// The stable local TUI plugin id — this stays the only TUI plugin registration
// for the quota surfaces. Its setup delegates to the native v6 TUI plugin,
// which registers the app, status-line, Home-footer and quota-window slots,
// publishes the bridge host the local quota card reads, and returns their
// cleanup; the session sidebar panel is not registered by the native plugin —
// the local quota card plugin (`opencode-quota-card-zh`, stable card id
// `quota`) renders the native `SidebarPanel` from the published host, so the
// sidebar shows the native layout once, ordered and hidden by the sidebar
// host. The delegation runs inside the caller's Solid owner — no new root is
// created — so the native slots keep OpenCode's own ownership.
export default Plugin.define({
  id: "opencode-quota-zh",
  setup(context) {
    const started = nativeTuiPlugin.setup(context)
    const runCleanup = (cleanup: (() => void) | void) => {
      if (typeof cleanup !== "function") return
      try {
        const done = cleanup() as void | Promise<void>
        // A cleanup may be async; a late rejection must not escape as an
        // unhandled error during plugin teardown.
        if (done instanceof Promise) {
          done.catch((error: unknown) => {
            console.error("opencode-quota-zh: native TUI cleanup failed", error)
          })
        }
      } catch (error) {
        console.error("opencode-quota-zh: native TUI cleanup failed", error)
      }
    }
    // The native setup is synchronous today; the promise branch only keeps the
    // cleanup contract if it ever returns one.
    if (started instanceof Promise) return started.then(runCleanup)
    return () => runCleanup(started)
  },
})
