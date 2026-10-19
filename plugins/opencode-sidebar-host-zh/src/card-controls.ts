/** Card-owned settings at the existing card seam. The host does not own their persistence. */
import { createSignal, onCleanup } from "solid-js"

export type CardControlValue = string | number | boolean
export type CardControlValues = Record<string, CardControlValue>
export interface CardControlField {
  key: string
  title: string
  choices: readonly { value: CardControlValue; title: string }[]
  /** An existing stored value may be valid even when absent from the suggested choices. */
  min?: number
  max?: number
  integer?: boolean
}
export interface CardControls {
  id: string
  title: string
  fields: readonly CardControlField[]
  read(): CardControlValues | Promise<CardControlValues>
  /** Must compare against the baseline inside the owner's existing write operation. */
  save(values: CardControlValues, baseline: CardControlValues): Promise<void>
  actions?: readonly { title: string; run(): void | Promise<void> }[]
  note?: string
}
type Entry = { controls: CardControls; preview?: CardControlValues; previewOwner?: object; listeners: Set<() => void> }
type Registry = { entries: Map<string, Entry>; listeners: Set<() => void> }
const KEY = Symbol.for("opencode-sidebar-host-zh.controls.v1")
function registry(): Registry {
  const scope = globalThis as unknown as Record<symbol, Registry | undefined>
  return scope[KEY] ??= { entries: new Map(), listeners: new Set() }
}
function notify(listeners: Set<() => void>) { for (const listener of [...listeners]) listener() }
export function registerCardControls(controls: CardControls): () => void {
  const current = registry()
  const previous = current.entries.get(controls.id)
  const entry: Entry = { controls, listeners: previous?.listeners ?? new Set() }
  current.entries.set(controls.id, entry)
  notify(entry.listeners)
  notify(current.listeners)
  return () => {
    if (current.entries.get(controls.id) !== entry) return
    current.entries.delete(controls.id)
    notify(entry.listeners)
    notify(current.listeners)
  }
}
export function useCardControls(): () => readonly CardControls[] {
  const current = registry()
  const [version, setVersion] = createSignal(0)
  const changed = () => setVersion((value) => value + 1)
  current.listeners.add(changed)
  onCleanup(() => current.listeners.delete(changed))
  return () => { version(); return [...current.entries.values()].map((entry) => entry.controls) }
}
export function setCardControlPreview(id: string, values: CardControlValues | undefined, owner?: object): void {
  const entry = registry().entries.get(id)
  if (!entry) return
  // An old window's late cleanup must not revoke a replacement window's preview.
  if (values === undefined && owner !== entry.previewOwner) return
  entry.preview = values
  entry.previewOwner = values === undefined ? undefined : owner
  notify(entry.listeners)
}
export function useCardControlPreview(id: string): () => CardControlValues | undefined {
  const current = registry()
  const [version, setVersion] = createSignal(0)
  const changed = () => setVersion((value) => value + 1)
  let attached: Entry | undefined
  const attach = () => {
    attached?.listeners.delete(changed)
    attached = current.entries.get(id)
    attached?.listeners.add(changed)
    changed()
  }
  attach()
  current.listeners.add(attach)
  onCleanup(() => { attached?.listeners.delete(changed); current.listeners.delete(attach) })
  return () => { version(); return current.entries.get(id)?.preview }
}
export function sameCardControlValues(a: CardControlValues, b: CardControlValues): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
}
