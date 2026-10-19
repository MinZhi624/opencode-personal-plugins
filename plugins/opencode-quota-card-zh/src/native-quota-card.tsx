/** @jsxImportSource @opentui/solid */

/**
 * 「额度」卡片内容：Quota 原生侧栏面板（SidebarPanel）的本地 Adapter。
 *
 * 责任区边界（ticket01：原生额度纳入侧栏宿主）：
 * - 只经本地桥接（`local-tui-bridge`）读取原生 TUI 已发布的 `SurfaceHost`：
 *   同一份额度客户端、同一份显示设置草稿，与宿主外的原生窗口／状态栏／
 *   Home footer 完全一致，不建立第二份额度数据或设置；
 * - 原生布局优先：直接渲染上游 `SidebarPanel`，不恢复旧定制 QuotaPanel，
 *   不复制其 20 格条、双百分比与多行排版，也不伪造兼容字段；
 * - 侧栏专属进度条形状（ticket03 接合处）：经宿主 presentation 的
 *   `useSidebarBarShape` 取得覆盖，只派生本卡片使用的 `host.display()`，
 *   不改写宿主对象本身，其他原生 surface 不受影响；
 * - 显示计数沿用原生 host：`editing.sidebarShown()` 只随 SidebarPanel 的
 *   实际挂载建立与释放，隐藏、卸载、宿主换代不残留可见计数；会话加载则由
 *   本 Adapter 按 host/session 额外保持一份 `quota.watch`（客户端引用计数，
 *   与面板的那一份合并为同一次轮询），使中止态卸载面板后仍能自然恢复；
 * - 无桥接（原生 TUI 插件未加载／已停用）时给出明确不可用状态；原生客户端
 *   一时没有快照时，用既有本地 snapshot RPC 分辨「后台未启用／查询失败」，
 *   并设宽限上限与「重试」（复用原生手动刷新），不把未知状态显示成无限
 *   「加载中」，也不要求用户重启 TUI。
 */
import type { JSX } from "@opentui/solid";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import type { Context } from "@opencode/plugin/tui/context";
import {
  readLocalQuotaHost,
  subscribeLocalQuotaHost,
} from "../../opencode-quota-zh/dist/local-tui-bridge.js";
// 运行时值与类型一律取自 quota-zh 的 dist（发行包只含 dist，src 不随运行时分发）。
// 注意：dist 的 v6/tui 是按字节复制的 TSX，其仅类型依赖在编译产物中丢失，
// 按 bundler 检查时有已知噪声（README「类型检查」记载，均不在本插件内）；
// 因此本文件对桥接宿主一律显式标注 SurfaceHost，不依赖推断。
import { SidebarPanel, type SurfaceHost } from "../../opencode-quota-zh/dist/v6/tui/sidebar.js";
import { quotaCallOptions } from "../../opencode-quota-zh/dist/v6/tui/client.js";
import { quotaRpc } from "../../opencode-quota-zh/dist/quota-rpc.js";
import { sanitizeDisplayText } from "../../opencode-quota-zh/dist/v6/lib/display-sanitize.js";
import { useSidebarBarShape } from "../../opencode-sidebar-host-zh/src/presentation.ts";

/** 稳定卡片身份：宿主按它保存排序／显隐，也用它查找侧栏样式覆盖。 */
export const QUOTA_CARD_ID = "quota";
const CARD_TITLE = "额度";

/** 宽限上限：状态读取确认服务可答后，原生客户端仍未给出快照的等待时间。 */
const NATIVE_SNAPSHOT_GRACE_MS = 10_000;

/** 卡片展示状态：`native`＝原生面板自行负责；其余为明确的中止态。 */
type Fallback =
  | { kind: "native" }
  | { kind: "disabled" }
  | { kind: "error"; message: string }
  | { kind: "unresponsive" };

export interface NativeQuotaCardProps {
  readonly context: Context;
  readonly sessionID: string;
}

export function NativeQuotaCard(props: NativeQuotaCardProps): JSX.Element {
  // 桥接宿主：每次发布／撤销后重读。在 memo 或渲染里读它会跟踪该信号，
  // 因此任一模块图里的发布与撤销都能到达本卡片。
  const [hostTick, setHostTick] = createSignal(0);
  const bridgeHost = (): SurfaceHost | undefined => {
    hostTick();
    return readLocalQuotaHost();
  };
  const unsubscribeHost = subscribeLocalQuotaHost(() => setHostTick((tick) => tick + 1));
  onCleanup(unsubscribeHost);

  // 侧栏专属进度条形状（ticket03 接合处）：卡片覆盖优先，其次整体形状；
  // 都没有时返回 undefined，沿用卡片（原生）自身设置。
  const barShape = useSidebarBarShape(QUOTA_CARD_ID);

  // 每座桥接宿主只包一层：display() 在调用时读取形状覆盖，因此形状变化
  // 不需要重挂面板（watch 与显示计数不重置）；宿主换代则随 keyed Show 重挂。
  const wrappedHost = createMemo((): SurfaceHost | undefined => {
    const current = bridgeHost();
    if (!current) return undefined;
    const display = current.display;
    return {
      ...current,
      display: () => {
        const value = display();
        const override = barShape();
        if (!override || value.layout.bar === override) return value;
        return { ...value, layout: { ...value.layout, bar: override } };
      },
    };
  });

  // 面板开合：随卡片实例保留，宿主换代重挂不重置用户的展开选择。
  const [open, setOpen] = createSignal(true);

  const [fallback, setFallback] = createSignal<Fallback>({ kind: "native" });
  const [retrying, setRetrying] = createSignal(false);

  // 异步状态读取代次：effect 每次重跑（快照到达、宿主发布／撤销、会话切换）
  // 与 effect 清理（卸载）都递增，迟到结果一律丢弃；回调落地前再确认宿主、
  // 会话未变且快照仍未到达，任何结果都不覆盖已到达的快照。
  let requestGeneration = 0;

  // 原生客户端一时没有快照时，用既有本地 snapshot RPC 分辨原因：后台未启用
  // 是明确状态；查询失败原样上报（不伪装成零额度）；服务可答时交给原生面板
  // 自己加载（它的 watch 会立刻发起同一次查询）。不渲染旧卡片、不新增 RPC。
  const readFallbackStatus = async (sessionID: string): Promise<Fallback> => {
    try {
      const result = await props.context.client.rpc(quotaRpc).snapshot(
        { sessionID },
        quotaCallOptions(props.context),
      );
      return result.status === "disabled" ? { kind: "disabled" } : { kind: "native" };
    } catch (error: unknown) {
      const message = sanitizeDisplayText(error instanceof Error ? error.message : String(error));
      return { kind: "error", message };
    }
  };

  // 会话加载：按 host/session 保持一份原生 watch。中止态会卸载 SidebarPanel
  // （它持有唯一 watch 时会让该会话停止加载、失去自然恢复），故由 Adapter
  // 兜底；原生客户端是引用计数，面板再挂载只是同一次轮询的第二次引用，
  // 不改变 quota client 的算法，也不注册第二套后台。
  createEffect(() => {
    const current = bridgeHost();
    if (!current) return;
    const stop = current.quota.watch(props.sessionID);
    onCleanup(stop);
  });

  createEffect(() => {
    const generation = ++requestGeneration;
    onCleanup(() => {
      requestGeneration++;
    });
    const current = bridgeHost();
    if (!current) {
      setFallback({ kind: "native" });
      return;
    }
    const sessionID = props.sessionID;
    if (current.quota.snapshot(sessionID)) {
      setFallback({ kind: "native" });
      return;
    }
    void readFallbackStatus(sessionID).then((result) => {
      if (generation !== requestGeneration) return;
      if (bridgeHost() !== current) return;
      if (props.sessionID !== sessionID) return;
      // 读取在途时快照已到达：原生面板自己会显示，任何结果都不覆盖它。
      if (current.quota.snapshot(sessionID)) return;
      setFallback(result);
    });
  });

  // 宽限上限：原生面板负责加载，但不得无限「加载中」。定时器随状态与快照
  // 信号重置，原生快照到达即取消；面板重挂或卸载时由 onCleanup 清除。
  createEffect(() => {
    const current = bridgeHost();
    const state = fallback();
    if (!current || state.kind !== "native") return;
    if (current.quota.snapshot(props.sessionID)) return;
    const timer = setTimeout(() => {
      if (!current.quota.snapshot(props.sessionID)) setFallback({ kind: "unresponsive" });
    }, NATIVE_SNAPSHOT_GRACE_MS);
    onCleanup(() => clearTimeout(timer));
  });

  // 重试：复用原生客户端的手动刷新与同一套状态读取——不新建轮询、不改算法，
  // 让失败态可以原地恢复，而不是只能重启 TUI。
  const retry = () => {
    const current = bridgeHost();
    if (!current) return;
    const sessionID = props.sessionID;
    const generation = ++requestGeneration;
    setRetrying(true);
    void (async () => {
      try {
        await current.quota.refresh("manual", sessionID).catch(() => undefined);
        if (generation !== requestGeneration) return;
        if (bridgeHost() !== current) return;
        if (current.quota.snapshot(sessionID)) {
          setFallback({ kind: "native" });
          return;
        }
        const result = await readFallbackStatus(sessionID);
        if (generation !== requestGeneration) return;
        setFallback(result);
      } finally {
        // 代次已变（快照到达、宿主换代、切会话）时由新状态负责展示，这里只解除
        // 重试标记，避免中止态面板残留「重试中…」。
        setRetrying(false);
      }
    })();
  };

  return (
    <Show
      when={wrappedHost()}
      keyed={true}
      fallback={
        <StatePanel
          context={props.context}
          message="额度界面暂不可用：未检测到 opencode-quota-zh 的 TUI 插件"
          detail="接入后自动显示；/quota 命令与额度后台不受本卡片影响。"
        />
      }
    >
      {(host: SurfaceHost) => (
        <Show
          when={fallback().kind === "native"}
          fallback={
            <FallbackPanel
              context={props.context}
              state={fallback()}
              retrying={retrying()}
              onRetry={retry}
            />
          }
        >
          <SidebarPanel host={host} sessionID={props.sessionID} open={open} setOpen={setOpen} />
        </Show>
      )}
    </Show>
  );
}

/** 无桥接宿主时的明确状态：不是加载中，也不需要用户操作即可自愈。 */
function StatePanel(props: { context: Context; message: string; detail?: string }): JSX.Element {
  const theme = () => props.context.theme;
  return (
    <box flexDirection="column">
      <text fg={theme().text.action.primary.base} wrapMode="none" selectable={false}>
        <b>{CARD_TITLE}</b>
      </text>
      <text fg={theme().text.muted}>{props.message}</text>
      {props.detail ? <text fg={theme().text.muted}>{props.detail}</text> : null}
    </box>
  );
}

/** 原生面板中止时的明确状态：后台未启用、查询失败或超过宽限仍无响应。 */
function FallbackPanel(props: {
  context: Context;
  state: Fallback;
  retrying: boolean;
  onRetry: () => void;
}): JSX.Element {
  const theme = () => props.context.theme;
  // 文案随状态信号派生：不用组件 setup 时捕获的常量，error→disabled/
  // unresponsive 切换时立即换文，重试中也有明确反馈。
  const view = createMemo(() => {
    const state = props.state;
    if (state.kind === "error") {
      return { headline: "额度查询失败", detail: state.message, error: true };
    }
    if (state.kind === "disabled") {
      return {
        headline: "额度后台未启用",
        detail: "请在原生额度设置中启用额度后台后重试",
        error: false,
      };
    }
    if (state.kind === "unresponsive") {
      return {
        headline: "额度界面暂无响应",
        detail: "可点下方「重试」重新加载，或打开 /quota 查看额度",
        error: false,
      };
    }
    return { headline: CARD_TITLE, detail: "", error: false };
  });
  const retryLabel = () => (props.retrying ? "重试中…" : "重试");
  return (
    <box flexDirection="column">
      <text fg={theme().text.action.primary.base} wrapMode="none" selectable={false}>
        <b>{CARD_TITLE}</b>
      </text>
      <text fg={view().error ? theme().text.feedback.error.base : theme().text.muted}>
        {view().headline}
      </text>
      {view().detail ? <text fg={theme().text.muted}>{view().detail}</text> : null}
      <text
        fg={theme().text.action.primary.base}
        wrapMode="none"
        selectable={false}
        onMouseDown={() => {
          if (!props.retrying) props.onRetry();
        }}
      >
        {retryLabel()}
      </text>
    </box>
  );
}
