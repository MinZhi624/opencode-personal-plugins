import assert from "node:assert/strict"
import { test } from "node:test"
import {
  SESSION_DATA_SEAM_SYMBOL,
  acquireSessionData,
  installSessionDataSeam,
  retireLegacySessionDataSeams,
} from "../plugins/opencode-session-data/src/seam.ts"

function fixture() {
  const renderer = {}
  const previous = globalThis[SESSION_DATA_SEAM_SYMBOL]
  const registry = new WeakMap()
  globalThis[SESSION_DATA_SEAM_SYMBOL] = registry
  let location = { directory: "/project", workspaceID: "first" }
  let consumers = 0
  const seam = {
    orphaned: () => false,
    acquire: () => {
      consumers++
      return { release: () => { consumers-- } }
    },
  }
  registry.set(renderer, seam)
  return {
    renderer,
    context: { renderer, data: { location: { default: () => location } } },
    switchTo: (next) => { location = next },
    consumers: () => consumers,
    restore: () => {
      if (previous === undefined) delete globalThis[SESSION_DATA_SEAM_SYMBOL]
      else globalThis[SESSION_DATA_SEAM_SYMBOL] = previous
    },
  }
}

test("one TUI keeps its data provider across session location switches", () => {
  const f = fixture()
  try {
    const first = acquireSessionData(f.context)
    assert.ok(first)
    first.release()
    f.switchTo({ directory: "/project", workspaceID: "second" })
    const sameProject = acquireSessionData(f.context)
    assert.ok(sameProject, "switching conversations in one project must retain the shared provider")
    sameProject.release()
    f.switchTo({ directory: "/other-project", workspaceID: "second" })
    const second = acquireSessionData(f.context)
    assert.ok(second, "switching tabs must not leave the card unavailable while its data plugin is installed")
    second.release()
    assert.equal(f.consumers(), 0)
  } finally {
    f.restore()
  }
})

test("another TUI renderer cannot consume this TUI's seam", () => {
  const f = fixture()
  try {
    assert.equal(acquireSessionData({ ...f.context, renderer: {} }), undefined)
  } finally {
    f.restore()
  }
})

test("v2 retires every v1 location without touching a second TUI", () => {
  const symbol = Symbol.for("opencode-session-data.seam.v1")
  const previous = globalThis[symbol]
  const renderer = {}
  const other = {}
  let released = 0
  const seam = { dispose: () => { released++ } }
  const otherSeam = { dispose: () => { throw new Error("another TUI was disposed") } }
  const locations = new Map([["/project\u0000", seam], ["/project\u0000workspace", seam]])
  const otherLocations = new Map([["/other\u0000", otherSeam]])
  globalThis[symbol] = new WeakMap([[renderer, locations], [other, otherLocations]])
  const replacement = { acquire: () => ({ release() {} }) }
  try {
    retireLegacySessionDataSeams(globalThis, renderer, replacement)
    assert.equal(released, 1)
    assert.equal(locations.size, 2)
    assert.ok([...locations.values()].every((value) => value === replacement))
    assert.equal(otherLocations.size, 1)
  } finally {
    if (previous === undefined) delete globalThis[symbol]
    else globalThis[symbol] = previous
  }
})

test("real installation survives a location switch and a stale generation cleanup", () => {
  const previous = globalThis[SESSION_DATA_SEAM_SYMBOL]
  delete globalThis[SESSION_DATA_SEAM_SYMBOL]
  const renderer = {}
  const client = {}
  let location = { directory: "/project" }
  const context = { renderer, client, data: { location: { default: () => location } } }
  const runtime = {
    metrics: { pause() {}, resume() {} },
    arm() { this.armed = true },
    disarm() { this.armed = false },
    dispose() { this.disposed = true },
  }
  let created = 0
  const createRuntime = () => { created++; return runtime }
  const first = installSessionDataSeam(globalThis, context, createRuntime)
  try {
    const handle = acquireSessionData(context)
    assert.ok(handle)
    location = { directory: "/other-project" }
    const switched = acquireSessionData(context)
    assert.ok(switched, "switching tabs must not look up a location the data plugin never installed")
    switched.release()
    const next = installSessionDataSeam(globalThis, context, createRuntime)
    assert.equal(next.adopted, true)
    assert.equal(created, 1, "hot reload must keep only one runtime")
    first.dispose()
    const afterCleanup = acquireSessionData(context)
    assert.ok(afterCleanup, "cleanup of the old plugin generation must not orphan the new one")
    afterCleanup.release()
    handle.release()
    next.dispose()
  } finally {
    if (previous === undefined) delete globalThis[SESSION_DATA_SEAM_SYMBOL]
    else globalThis[SESSION_DATA_SEAM_SYMBOL] = previous
  }
})

test("installing v2 notifies v1 consumers only after v2 is available", () => {
  const legacySymbol = Symbol.for("opencode-session-data.seam.v1")
  const previousLegacy = globalThis[legacySymbol]
  const previous = globalThis[SESSION_DATA_SEAM_SYMBOL]
  delete globalThis[SESSION_DATA_SEAM_SYMBOL]
  const renderer = {}
  const context = { renderer, client: {}, data: { location: { default: () => ({ directory: "/project" }) } } }
  let reconnected = false
  const old = new Map([["/project\u0000", {
    dispose() {
      const handle = old.get("/project\u0000")?.acquire("legacy-overview")
      assert.ok(handle, "a v1 consumer must be able to acquire the v2 replacement")
      reconnected = true
      handle.release()
    },
  }]])
  globalThis[legacySymbol] = new WeakMap([[renderer, old]])
  const runtime = { arm() {}, disarm() {}, dispose() {}, metrics: {} }
  try {
    const installed = installSessionDataSeam(globalThis, context, () => runtime)
    assert.equal(reconnected, true)
    assert.equal(installed.seam.version, 2)
    assert.equal(old.get("/project\u0000"), installed.seam)
    installed.dispose()
  } finally {
    if (previous === undefined) delete globalThis[SESSION_DATA_SEAM_SYMBOL]
    else globalThis[SESSION_DATA_SEAM_SYMBOL] = previous
    if (previousLegacy === undefined) delete globalThis[legacySymbol]
    else globalThis[legacySymbol] = previousLegacy
  }
})
