/**
 * 本地网页编辑器的最小 HTTP 宿主。
 *
 * 只绑定 127.0.0.1，使用一次性 token 保护 API；页面与静态资源同源，
 * 不引入任何外部 CDN。Server 插件的 RPC 仍是唯一读写预设文件的地方。
 */
import { randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server } from "node:http"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import type { Context } from "@opencode/plugin/tui/context"
import type { PresetDefinition } from "../shared/presets.ts"
import { activatePreset, fetchPresetState, savePresetDefinitions } from "./rpc-client.ts"

const WEB_ROOT = fileURLToPath(new URL("../web/", import.meta.url))
const MAX_BODY_BYTES = 2 * 1024 * 1024
// 网页偏好（隐藏模型）不属于预设语义，单独存放；由本机 TUI 宿主读写，不进 presets.json。
const UI_PREFS_PATH = join(
  process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"),
  "opencode",
  "opencode-matt-workshop",
  "ui.json",
)
const MODEL_REF = /^[^/\s]+\/[^/\s]+$/
const MAX_HIDDEN_MODELS = 500

interface UiPrefs {
  readonly hiddenModels: readonly string[]
}

interface RunningServer {
  readonly url: string
  readonly server: Server
}

let running: RunningServer | undefined

export interface PresetWebHandle {
  readonly url: string
  close(): Promise<void>
}

export async function startPresetWeb(context: Context): Promise<PresetWebHandle> {
  if (running) {
    const existing = running
    openInBrowser(existing.url)
    return {
      url: existing.url,
      close: async () => closeRunning(existing),
    }
  }

  const token = randomBytes(18).toString("hex")
  const server = createServer((request, response) => {
    void handleRequest(context, request, response, token).catch((error: unknown) => {
      writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === "string") {
    server.close()
    throw new Error("网页编辑器启动失败：没有拿到本地端口")
  }
  const url = `http://127.0.0.1:${address.port}/?token=${token}`
  const handle: RunningServer = { url, server }
  running = handle
  openInBrowser(url)
  return {
    url,
    close: async () => closeRunning(handle),
  }
}

async function closeRunning(handle: RunningServer): Promise<void> {
  if (running === handle) running = undefined
  await new Promise<void>((resolve) => handle.server.close(() => resolve()))
}

export function stopPresetWeb(): Promise<void> | undefined {
  return running ? closeRunning(running) : undefined
}

async function handleRequest(
  context: Context,
  request: IncomingMessage,
  response: import("node:http").ServerResponse,
  token: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1")
  const path = url.pathname

  if (request.method === "GET" && (path === "/" || path === "/index.html")) {
    return serveAsset(response, "index.html", "text/html; charset=utf-8")
  }
  if (request.method === "GET" && path === "/app.js") {
    return serveAsset(response, "app.js", "text/javascript; charset=utf-8")
  }
  if (request.method === "GET" && path === "/styles.css") {
    return serveAsset(response, "styles.css", "text/css; charset=utf-8")
  }
  if (request.method === "GET" && path === "/health") {
    return writeJson(response, 200, { ok: true })
  }

  if (!path.startsWith("/api/")) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    response.end("Not found")
    return
  }

  const supplied = url.searchParams.get("token") ?? header(request, "x-preset-token")
  if (supplied !== token) {
    return writeJson(response, 401, { error: "无效的编辑器 token" })
  }

  if (request.method === "GET" && path === "/api/state") {
    return writeJson(response, 200, await fetchPresetState(context))
  }

  if (request.method === "GET" && path === "/api/prefs") {
    return writeJson(response, 200, await readUiPrefs())
  }

  if (request.method === "POST" && path === "/api/prefs") {
    return writeJson(response, 200, await writeUiPrefs(await readJson(request)))
  }

  if (request.method === "POST" && path === "/api/activate") {
    const body = (await readJson(request)) as { name?: unknown }
    const name = typeof body?.name === "string" ? body.name.trim() : ""
    if (!name) throw new Error("缺少预设名")
    return writeJson(response, 200, await activatePreset(context, name))
  }

  if (request.method === "POST" && path === "/api/save") {
    const body = (await readJson(request)) as {
      presets?: Readonly<Record<string, PresetDefinition>>
      active?: string | null
    }
    if (!body?.presets || typeof body.presets !== "object") throw new Error("缺少 presets")
    return writeJson(
      response,
      200,
      await savePresetDefinitions(
        context,
        body.presets,
        body.active === undefined ? undefined : body.active,
      ),
    )
  }

  return writeJson(response, 404, { error: "未知 API" })
}

async function serveAsset(
  response: import("node:http").ServerResponse,
  file: string,
  type: string,
): Promise<void> {
  const content = await readFile(join(WEB_ROOT, file))
  response.writeHead(200, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  })
  response.end(content)
}

function normalizeHiddenModels(values: readonly unknown[]): string[] {
  const result = new Set<string>()
  for (const value of values) {
    if (typeof value === "string" && MODEL_REF.test(value)) result.add(value)
  }
  return [...result]
}

async function readUiPrefs(): Promise<UiPrefs> {
  try {
    const parsed = JSON.parse(await readFile(UI_PREFS_PATH, "utf8")) as { hiddenModels?: unknown }
    const values = Array.isArray(parsed?.hiddenModels) ? parsed.hiddenModels : []
    return { hiddenModels: normalizeHiddenModels(values) }
  } catch {
    return { hiddenModels: [] }
  }
}

async function writeUiPrefs(body: unknown): Promise<UiPrefs> {
  const input = body as { hiddenModels?: unknown }
  if (!Array.isArray(input?.hiddenModels)) throw new Error("hiddenModels 必须是字符串数组")
  const hiddenModels = normalizeHiddenModels(input.hiddenModels)
  if (hiddenModels.length > MAX_HIDDEN_MODELS) throw new Error(`隐藏模型不能超过 ${MAX_HIDDEN_MODELS} 个`)
  const directory = dirname(UI_PREFS_PATH)
  await mkdir(directory, { recursive: true })
  const temp = join(directory, `.${randomBytes(6).toString("hex")}.ui.tmp`)
  await writeFile(temp, `${JSON.stringify({ hiddenModels }, null, 2)}\n`)
  await rename(temp, UI_PREFS_PATH)
  return { hiddenModels }
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error("请求体超过 2MB 上限")
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

function writeJson(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  })
  response.end(body)
}

function openInBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? { bin: "open", args: [url] }
      : process.platform === "win32"
        ? { bin: "cmd", args: ["/c", "start", "", url] }
        : { bin: "xdg-open", args: [url] }
  try {
    const child = spawn(command.bin, command.args, { detached: true, stdio: "ignore" })
    child.on("error", () => {})
    child.unref()
  } catch {
    // 打不开浏览器时仍把 URL 交给 TUI toast；这里不阻塞。
  }
}
