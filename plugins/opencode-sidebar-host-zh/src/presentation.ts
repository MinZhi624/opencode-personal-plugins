/** Sidebars only: a small in-process display bridge, never Quota's global settings. */
import { createSignal, onCleanup } from "solid-js"

export const SIDEBAR_BAR_SHAPES = ["blocks", "shades", "line", "squares", "dots", "none"] as const
export type SidebarBarShape = (typeof SIDEBAR_BAR_SHAPES)[number]
export interface SidebarAppearance {
  bar?: SidebarBarShape
  bars?: Record<string, SidebarBarShape>
}

type AppearanceState = { owner?: object; value: SidebarAppearance; listeners: Set<() => void> }
const KEY = Symbol.for("opencode-sidebar-host-zh.appearance.v1")
function state(): AppearanceState {
  const scope = globalThis as unknown as Record<symbol, AppearanceState | undefined>
  return scope[KEY] ??= { value: {}, listeners: new Set() }
}
export function isSidebarBarShape(value: unknown): value is SidebarBarShape {
  return typeof value === "string" && (SIDEBAR_BAR_SHAPES as readonly string[]).includes(value)
}
export function createSidebarAppearancePublisher() {
  const owner = {}
  const current = state()
  const notify = () => { for (const listener of [...current.listeners]) listener() }
  return {
    publish(value: SidebarAppearance) { current.owner = owner; current.value = value; notify() },
    dispose() { if (current.owner === owner) { current.owner = undefined; current.value = {}; notify() } },
  }
}
export function useSidebarBarShape(cardID: string): () => SidebarBarShape | undefined {
  const current = state()
  const [tick, setTick] = createSignal(0)
  const listener = () => setTick((value) => value + 1)
  current.listeners.add(listener)
  onCleanup(() => current.listeners.delete(listener))
  return () => {
    tick()
    const bars = current.value.bars
    const own = bars && Object.hasOwn(bars, cardID) ? bars[cardID] : undefined
    return isSidebarBarShape(own) ? own : current.value.bar
  }
}

/** Filled and empty runs; callers retain their own percentage and warning semantics. */
export function sidebarBarParts(shape: SidebarBarShape, percent: number, width: number): [string, string] {
  if (shape === "none") return ["", ""]
  const glyphs = { blocks: ["█", "░"], shades: ["▓", "░"], line: ["━", "─"], squares: ["■", "□"], dots: ["●", "○"] } as const
  const cells = Math.max(0, Math.floor(width))
  const used = Math.round(Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0)) * cells / 100)
  const [filled, empty] = glyphs[shape]
  return [filled.repeat(used), empty.repeat(cells - used)]
}
