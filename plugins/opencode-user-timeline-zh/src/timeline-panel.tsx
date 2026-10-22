/** @jsxImportSource @opentui/solid */

import "@opentui/solid/preload"
import type { BoxRenderable } from "@opentui/core"
import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import { useCardControlPreview } from "../../opencode-sidebar-host-zh/src/card-controls.ts"
import { useSidebarDisplay } from "../../opencode-sidebar-host-zh/src/presentation.ts"
import {
  formatTime,
  groupNodes,
  isUser,
  latestGroups,
  navigable,
  sameTimelineNode,
  sleep,
  timelineNode,
  truncate,
  waitForFrames,
  type TimelineGroup,
  type TimelineNode,
  type UserMessage,
} from "./timeline-model.ts"
import { TIMELINE_CARD_ID, type TimelineOptions } from "./timeline-options.ts"

export type MaskState = { show: boolean; preview: string }

/** 遮盖层控制：由 setup 里的 slot 渲染提供，不走 dialog（宿主滚动命令会清弹层）。 */
export interface MaskControl {
  show(preview: string): void
  drop(): Promise<void>
}

type PagedHostMessages = Context["data"]["session"]["message"] & {
  more?(sessionID: string): boolean
  loading?(sessionID: string): boolean
  /** 2.0.10 起接受可选 options：{ all: true } 单次拉全量，旧宿主忽略该参数（单次一页）。 */
  loadMore?(sessionID: string, options?: { all?: boolean }): Promise<unknown>
}

/** 宿主当前缓存里的用户消息——保持宿主原序（宿主导航认这个顺序，不能重排）。 */
function hostUsers(context: Context, sessionID: string): UserMessage[] {
  try {
    return (context.data.session.message.list(sessionID) ?? []).filter(isUser)
  } catch {
    return []
  }
}

async function waitForRenderable(
  context: Context,
  id: string,
  active: () => boolean,
  timeout = 10_000,
) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (!active()) return false
    // 会话行嵌在 session scrollbox 深层；getRenderable 只查直接子节点。
    if (context.renderer.root.findDescendantById(id)) return true
    await waitForFrames(1)
  }
  return false
}

/** 把目标消息逐页加载进宿主缓存，不触碰会话滚动锚。 */
async function ensureLoaded(
  context: Context,
  sessionID: string,
  id: string,
  active: () => boolean,
): Promise<boolean> {
  const messages = context.data.session.message as PagedHostMessages
  const more = messages.more?.bind(messages)
  const loading = messages.loading?.bind(messages)
  const loadMore = messages.loadMore?.bind(messages)

  // v2 当前把底层分页对象原样交给插件，只是公开类型暂未列出这三个方法（2.0.10 仍如此）。
  // 直接分页不会像 session.first 那样留下一个最终 scrollTo(0) 的异步回调。
  if (more && loading && loadMore) {
    const deadline = Date.now() + 60_000
    for (let page = 0; page < 400 && Date.now() < deadline; ) {
      if (!active()) return false
      if (hostUsers(context, sessionID).some((message) => message.id === id)) return true
      if (loading(sessionID)) {
        await sleep(50)
        continue
      }
      if (!more(sessionID)) return false
      try {
        // 2.0.10：{ all: true } 由宿主在单次调用内循环翻页到 cursor 尽头（每页 200），
        // 目标在很老的历史里时一次调用即可到位；旧宿主忽略该参数，仍按单页循环。
        await loadMore(sessionID, { all: true })
      } catch {
        return false
      }
      page++
    }
    return active() && hostUsers(context, sessionID).some((message) => message.id === id)
  }

  // 旧版兼容：没有分页 API 时才退回宿主命令，并在目标出现后等缓存静止，
  // 避免 session.first 尚未结束的回调覆盖最终落点。
  const deadline = Date.now() + 60_000
  let lastCount = -1
  let quietSince = Date.now()
  while (Date.now() < deadline) {
    if (!active()) return false
    const hosts = hostUsers(context, sessionID)
    if (hosts.length !== lastCount) {
      lastCount = hosts.length
      quietSince = Date.now()
    }
    if (hosts.some((message) => message.id === id)) {
      if (Date.now() - quietSince >= 800) return true
      await sleep(100)
      continue
    }
    try {
      context.keymap.dispatch("session.first")
    } catch {
      return false
    }
    await sleep(200)
  }
  return false
}

/** 全屏遮盖层：绝对定位 + 高 zIndex，盖在会话区上（不依赖 dialog，不会被宿主滚动命令清掉）。 */
export function MaskVeil(props: { context: Context; mask: MaskState }) {
  const accent = () => props.context.theme.text.action.primary.base
  const body = () => props.context.theme.text.base
  const muted = () => props.context.theme.text.muted
  const background = () => props.context.theme.background?.raised?.high

  return (
    <Show when={props.mask.show}>
      <box
        position="absolute"
        top={0}
        left={0}
        right={0}
        bottom={0}
        zIndex={999}
        backgroundColor={background()}
        justifyContent="center"
        alignItems="center"
      >
        <box border borderColor={accent()} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} flexDirection="column">
          <box flexDirection="row" gap={1}>
            <text fg={accent()}>{"◆"}</text>
            <text fg={body()}>{"正在定位消息…"}</text>
          </box>
          <text fg={muted()}>{props.mask.preview}</text>
        </box>
      </box>
    </Show>
  )
}

type PanelProps = {
  context: Context
  sessionID: string
  options: () => TimelineOptions
  mask: MaskControl
}

/** 侧边栏面板：当前会话的用户消息节点列表（固定行高，剩余的可滚轮滚动）。 */
export function TimelinePanel(props: PanelProps) {
  // 节点池：id → 紧凑时间线节点。TUI 本地缓存只有"已加载窗口"（向上滚动才分页加载更早的），
  // 所以本地缓存负责实时增量，全量历史由 client.message.list 直接向服务端分页拉取。
  const [pool, setPool] = createSignal<Map<string, TimelineNode>>(new Map())
  // 初次打开时先不要把 TUI 的懒加载窗口直接画出来，避免 5 条本地缓存先闪现、
  // 服务端全量回来后又变成 10 条。全量请求失败时仍会揭示本地缓存作为兜底。
  const [initialReady, setInitialReady] = createSignal(false)
  const [selected, setSelected] = createSignal<string>("")
  const [measured, setMeasured] = createSignal(0)
  const [stored, updateStored] = props.context.storage.store("timeline", {
    initial: { open: true },
  })

  // 统一窗口的预览只覆盖显示，不写 cli.json；保存或放弃后回到已保存选项。
  const preview = useCardControlPreview(TIMELINE_CARD_ID)
  // 侧栏专属外观：颜色与行内布局走宿主桥（卡片覆盖 › 整体），未设置时回退主题。
  const shown = useSidebarDisplay(TIMELINE_CARD_ID)

  const titleColor = () => shown().colors.title ?? props.context.theme.text.action.primary.base
  const bodyColor = () => shown().colors.body ?? props.context.theme.text.base
  const mutedColor = () => shown().colors.muted ?? props.context.theme.text.muted
  const dividerColor = () => shown().colors.divider ?? mutedColor()
  const successColor = () => props.context.theme.text.feedback.success.base
  const withDivider = () => shown().layout.divider === true

  const visibleRows = () => {
    const value = preview()?.visibleRows
    return typeof value === "number" ? value : props.options().visibleRows
  }
  const scroll = () => {
    const value = preview()?.scroll
    return typeof value === "boolean" ? value : props.options().scroll
  }
  const open = () => stored.open !== false
  const toggleOpen = () => {
    void updateStored((draft) => {
      draft.open = !draft.open
    })
  }

  // 时间列 5 列、标记 1 列、两处 gap 与左右 padding 共 4 列；剩余宽度给摘要。
  const summaryWidth = () => {
    const width = measured()
    return width > 0 ? Math.max(6, width - 10) : 26
  }

  let prevLocalCount = 0 // 本地缓存中用户消息数：下降（undo）触发全量重拉
  let initialSessionID = ""
  let generation = 0
  let jumping = false
  let jumpGeneration = -1

  const isActive = (sessionID: string, current: number) =>
    generation === current && props.sessionID === sessionID

  // 只截停滚轮冒泡，不主动 focus/blur 内部 scrollbox：卡片在宿主侧栏里，
  // 抢焦点会让 TUI 的会话输入失去焦点。滚轮仍由命中的 scrollbox 自己处理。
  function captureTimelineScroll(event: { stopPropagation: () => void }) {
    if (!open() || !scroll()) return
    event.stopPropagation()
  }

  function finishInitialLoad(sessionID: string) {
    if (props.sessionID === sessionID && initialSessionID === sessionID) setInitialReady(true)
  }

  function mergeNodes(values: Iterable<TimelineNode>) {
    setPool((prev) => {
      let next: Map<string, TimelineNode> | undefined
      for (const node of values) {
        const existing = prev.get(node.id)
        if (existing && sameTimelineNode(existing, node)) continue
        next ??= new Map(prev)
        next.set(node.id, node)
      }
      return next ?? prev
    })
  }

  /** 合并本地缓存增量；新增走增量同步，undo 才请求权威全量历史。 */
  function mergeLocal(refetch: boolean) {
    let users: UserMessage[]
    try {
      const list = props.context.data.session.message.list(props.sessionID) ?? []
      users = list.filter(isUser)
    } catch {
      return // 本地缓存尚未就绪，等下一轮。
    }

    // untrack：本函数会在追踪 sessionID 的 createEffect 里执行；
    // 若不切断，"effect 内又读又写 pool" 会造成无限自触发（栈溢出）。
    const current = untrack(pool)
    let added = false
    let mutated = false
    const updates: TimelineNode[] = []
    for (const message of users) {
      const node = timelineNode(message)
      const existing = current.get(node.id)
      if (!existing) added = true
      else if (!sameTimelineNode(existing, node)) mutated = true
      else continue
      updates.push(node)
    }
    const dropped = users.length < prevLocalCount
    prevLocalCount = users.length

    if (added || mutated) mergeNodes(updates)
    if (!refetch) return
    if (dropped) scheduleFetch("all")
    else if (added) scheduleFetch("latest")
  }

  /**
   * 服务端分页约束（2.0.2 → 2.0.10 均如此）：limit 上限 200；翻页时只能带 cursor 单独传
   * （cursor 内部已编码 order，重复带 order 参数会报 InvalidCursorError）。
   */
  async function fetchPage(sessionID: string, cursor?: string) {
    let response: Awaited<ReturnType<Context["client"]["message"]["list"]>>
    try {
      response = await props.context.client.message.list({
        sessionID,
        limit: 200,
        ...(cursor ? { cursor } : { order: "desc" as const }),
      })
    } catch {
      return undefined
    }
    return {
      data: response?.data ?? [],
      next: response?.cursor?.next ?? null,
    }
  }

  type FetchMode = "all" | "latest"
  let fetching: FetchMode | undefined
  let queued: FetchMode | undefined

  /** 同一面板只跑一条分页链；全量请求会覆盖排队中的增量请求。 */
  function scheduleFetch(mode: FetchMode) {
    if (fetching) {
      if (mode === "all" || !queued) queued = mode
      return
    }
    fetching = mode
    const task = mode === "all" ? doFetchAll() : doFetchLatest()
    void task
      .catch(() => undefined)
      .finally(() => {
        fetching = undefined
        const next = queued
        queued = undefined
        if (next) scheduleFetch(next)
      })
  }

  /**
   * 首次进入和 undo 时分页拉取完整历史；只有完整走到 cursor 尾端才权威替换，
   * 中途失败的部分结果只做合并，不能把已有早期节点截掉。
   * 实测约束（2.0.2 → 2.0.10）：limit 上限 200；翻页时只能带 cursor 单独传
   * （cursor 内部已编码 order，重复带 order 参数服务端直接报
   * InvalidCursorError："Cursor cannot be combined with order"）。
   * fresh === 0 与页数上限是双保险，cursor 语义未来再变也不会死循环。
   */
  async function doFetchAll() {
    const sessionID = props.sessionID
    const collected = new Map<string, TimelineNode>()
    const seen = new Set<string>() // 全部消息 id，用于检测分页没有推进
    let cursor: string | undefined
    let complete = false

    for (let pageIndex = 0; pageIndex < 40; pageIndex++) {
      const page = await fetchPage(sessionID, cursor)
      if (!page || props.sessionID !== sessionID) {
        if (props.sessionID === sessionID) {
          mergeLocal(false)
          finishInitialLoad(sessionID)
        }
        return
      }
      let fresh = 0
      for (const message of page.data) {
        if (seen.has(message.id)) continue
        seen.add(message.id)
        fresh++
        if (isUser(message)) collected.set(message.id, timelineNode(message))
      }
      if (!page.next) {
        complete = true
        break
      }
      if (fresh === 0) break
      cursor = page.next
    }

    if (props.sessionID !== sessionID) return
    if (complete) {
      setPool(new Map(collected))
      mergeLocal(false)
      finishInitialLoad(sessionID)
      return
    }
    if (collected.size > 0) mergeNodes(collected.values())
    finishInitialLoad(sessionID)
  }

  /** 新增消息只从最新页向后拉，遇到任意已知用户节点立即停止。 */
  async function doFetchLatest() {
    const sessionID = props.sessionID
    const known = new Set(untrack(pool).keys())
    if (known.size === 0) {
      await doFetchAll()
      return
    }

    const collected = new Map<string, TimelineNode>()
    const seen = new Set<string>()
    let cursor: string | undefined
    for (let pageIndex = 0; pageIndex < 40; pageIndex++) {
      const page = await fetchPage(sessionID, cursor)
      if (!page || props.sessionID !== sessionID) return
      let fresh = 0
      let overlap = false
      for (const message of page.data) {
        if (seen.has(message.id)) continue
        seen.add(message.id)
        fresh++
        if (!isUser(message)) continue
        if (known.has(message.id)) overlap = true
        else collected.set(message.id, timelineNode(message))
      }
      if (overlap || !page.next || fresh === 0) break
      cursor = page.next
    }
    if (props.sessionID === sessionID && collected.size > 0) mergeNodes(collected.values())
  }

  /**
   * 点击跳转：dispatch 宿主自带的导航命令。
   * 先跳到最后一个可定位的用户消息，再按“目标之后还有几条可定位消息”往回走 N 步。
   *
   * 关键：步数必须用宿主当前缓存里的消息列表计算——宿主导航只在这个集合里移动，
   * 用插件的全量列表（服务端历史）会因两边时间差导致光标落偏。
   */
  async function jumpTo(clicked: TimelineNode) {
    const sessionID = props.sessionID
    const current = generation
    // 同一会话一次只跑一条定位链；会话切换后旧链不得阻塞新会话的点击。
    if (jumping && jumpGeneration === current) return
    const active = () => isActive(sessionID, current)
    jumping = true
    jumpGeneration = current
    let masked = false
    try {
      let hosts = hostUsers(props.context, sessionID)
      if (!hosts.some((node) => node.id === clicked.id)) {
        // 上罩（含目标预览），加载阶段视图滚动全部被遮住。
        props.mask.show(truncate(clicked.summary, 34))
        masked = true
        const loaded = await ensureLoaded(props.context, sessionID, clicked.id, active)
        if (!active()) return
        if (!loaded) {
          await props.mask.drop()
          masked = false
          props.context.ui.toast.show({ message: "这条消息没能加载出来", variant: "warning" })
          return
        }
        hosts = hostUsers(props.context, sessionID)
      }

      const index = hosts.findIndex((node) => node.id === clicked.id)
      if (index < 0) return
      const steps = hosts.slice(index + 1).filter(navigable).length
      const targets = hosts.filter(navigable)
      const landing = targets[Math.max(0, targets.length - 1 - steps)]
      if (!landing) {
        props.context.ui.toast.show({ message: "当前会话没有可定位的文本消息", variant: "warning" })
        return
      }
      let positioned = false
      try {
        props.context.keymap.dispatch("session.messages_last_user")

        if (masked) {
          // 首次分页后，data 中出现目标早于 createSessionRows 完成。last_user 会触发
          // ensureAllRows；等最终落点的 renderable 出现后，再让起点锚定回调走完两帧。
          const mounted = await waitForRenderable(props.context, landing.id, active)
          if (!active()) return
          if (!mounted) {
            props.context.ui.toast.show({ message: "消息已加载，但会话行尚未准备好", variant: "warning" })
            return
          }
          await waitForFrames(2)
        }

        for (let i = 0; i < steps; i++) props.context.keymap.dispatch("session.message.user.previous")
        positioned = true
      } catch {
        props.context.ui.toast.show({ message: "当前版本不支持消息跳转", variant: "warning" })
      }
      if (masked && positioned) {
        // previous 链已在完整 renderable 集合上同步确定终点，再等两帧提交 scrollTo。
        await waitForFrames(2)
        await props.mask.drop()
        masked = false
      }
    } finally {
      if (masked) await props.mask.drop()
      // 旧会话的迟到收尾不得把新会话正在跑的定位标志清掉。
      if (jumpGeneration === current) jumping = false
    }
  }

  // 切换会话（sessionID 变化）时重新拉取并清空选中态。
  // 体内除 sessionID 外一律 untrack：hostUsers/mergeLocal 会读宿主响应式数据库，
  // 不切断订阅的话流式期间 effect 会被消息更新反复触发（重挂载刷屏）。
  createEffect(() => {
    props.sessionID
    generation++
    untrack(() => {
      initialSessionID = props.sessionID
      setInitialReady(false)
      setSelected("")
      prevLocalCount = 0
      setPool(new Map())
      mergeLocal(false)
      scheduleFetch("all")
    })
  })

  // 服务端事件驱动刷新：只有用户消息集合变化才会触发服务端同步；
  // 新增只拉到首个已知节点，undo 才全量重建。
  const stopListen = props.context.data.listen(({ details }) => {
    const type = (details as { type?: unknown } | undefined)?.type
    if (typeof type !== "string") return
    if (!type.startsWith("message") && !type.startsWith("session")) return
    mergeLocal(true)
  })

  // 事件监听为主，20 秒低频轮询只负责最终一致性兜底。
  const poll = setInterval(() => mergeLocal(true), 20_000)

  onCleanup(() => {
    stopListen()
    clearInterval(poll)
    // 卡片被隐藏或插件停用时，未完成的定位不得继续遮住会话。
    generation++
    jumping = false
    void props.mask.drop()
  })

  const nodes = createMemo(() => [...pool().values()].sort((a, b) => a.created - b.created))
  const readyNodes = createMemo(() => (initialReady() ? nodes() : []))
  const groups = createMemo(() => groupNodes(readyNodes()))
  // 滚动模式显示全部；静态回退只显示最新 N 条消息，并保留日期标题。
  const shownGroups = createMemo(() => (scroll() ? groups() : latestGroups(groups(), visibleRows())))
  const latestID = createMemo(() => readyNodes()[readyNodes().length - 1]?.id ?? "")

  /** 单个节点行（滚动 / 静态两种容器共用）。 */
  function NodeRow(propsRow: { node: TimelineNode }) {
    const active = createMemo(() => selected() === propsRow.node.id)
    const latest = createMemo(() => latestID() === propsRow.node.id)
    return (
      <box
        flexDirection="row"
        gap={1}
        onMouseUp={() => {
          setSelected(propsRow.node.id)
          void jumpTo(propsRow.node)
        }}
      >
        <text fg={mutedColor()}>{formatTime(propsRow.node.created)}</text>
        <text fg={active() ? titleColor() : latest() ? successColor() : mutedColor()}>
          {active() || latest() ? "●" : "─"}
        </text>
        <text fg={active() ? titleColor() : bodyColor()}>
          {truncate(propsRow.node.summary, summaryWidth())}
        </text>
      </box>
    )
  }

  function DateGroup(propsGroup: { group: TimelineGroup }) {
    return (
      <box flexDirection="column">
        <text fg={titleColor()}>{`── ${propsGroup.group.label} ──`}</text>
        <For each={propsGroup.group.nodes}>{(node) => <NodeRow node={node} />}</For>
      </box>
    )
  }

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      alignSelf="stretch"
      width="100%"
      paddingLeft={1}
      paddingRight={1}
      onSizeChange={function (this: BoxRenderable) {
        if (this.width > 0 && this.width !== measured()) queueMicrotask(() => setMeasured(this.width))
      }}
      onMouseScroll={captureTimelineScroll}
    >
      <box flexDirection="row" gap={1} onMouseDown={toggleOpen}>
        <text fg={titleColor()}>{open() ? "▼" : "▶"}</text>
        <text fg={titleColor()}><b>{"用户节点"}</b></text>
        <text fg={mutedColor()}>{initialReady() ? `(${readyNodes().length})` : "(加载中…)"}</text>
      </box>
      <Show when={open()}>
        <Show when={withDivider()}>
          <text fg={dividerColor()}>{"─".repeat(Math.max(4, measured() || 20))}</text>
        </Show>
        <Show when={initialReady()} fallback={<text fg={mutedColor()}>{"正在加载用户消息…"}</text>}>
          <Show when={readyNodes().length > 0} fallback={<text fg={mutedColor()}>{"暂无用户消息"}</text>}>
            <Show
              when={scroll()}
              fallback={<For each={shownGroups()}>{(group) => <DateGroup group={group} />}</For>}
            >
              {/* 固定可视行数，剩余全部滚轮滚动；stickyScroll 保证新消息进来时保持在底部 */}
              <scrollbox
                focusable={false}
                height={visibleRows()}
                width="100%"
                alignSelf="stretch"
                stickyScroll
                stickyStart="bottom"
                // 嵌套在宿主侧边栏滚动容器中；无论事件命中行、content 还是
                // scrollbox 本身，都在这里截断冒泡，避免外层跟着滚动。
                onMouseScroll={captureTimelineScroll}
                verticalScrollbarOptions={{ visible: false }}
              >
                <box flexDirection="column" width="100%">
                  <For each={shownGroups()}>{(group) => <DateGroup group={group} />}</For>
                </box>
              </scrollbox>
            </Show>
          </Show>
        </Show>
      </Show>
    </box>
  )
}
