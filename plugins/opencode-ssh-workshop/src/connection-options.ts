import { homedir } from "node:os"
import { resolve } from "node:path"

/** One validation seam for tools, saved profiles, RPC and the final spawn. */
export function validateTarget(target: string): string {
  const parts = target.split("@")
  if (parts.length > 2 || !target || /[\s\x00-\x1f\x7f]/.test(target)) {
    throw new Error("SSH 目标必须是无空白的 [user@]host。")
  }
  const host = parts.at(-1)!
  if (!/^[A-Za-z0-9_\[][-A-Za-z0-9_.:\[\]%]*$/.test(host)) {
    throw new Error("SSH 地址不能以 - 开头或包含命令／选项字符。")
  }
  if (parts.length === 2 && !/^[A-Za-z0-9_][-A-Za-z0-9_.]*$/.test(parts[0]!)) {
    throw new Error("SSH 用户名不能以 - 开头或包含空白／选项字符。")
  }
  return target
}

function port(value: string): void {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error("SSH 端口必须在 1–65535 之间。")
  }
}

// This only decodes argv quoting; no expansion, shell evaluation or free options.
function tokens(text: string): string[] {
  if (/[\x00-\x1f\x7f]/.test(text)) throw new Error("SSH 参数不允许控制字符。")
  const result: string[] = []
  let word = "", quote = "", started = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (quote) {
      if (char === quote) quote = ""
      else if (char === "\\" && quote === '"') word += text[++i] ?? ""
      else word += char
    } else if (char === "'" || char === '"') { quote = char; started = true }
    else if (/\s/.test(char)) {
      if (started) result.push(word)
      word = ""; started = false
    } else if (char === "\\") {
      if (++i >= text.length) throw new Error("SSH 参数转义不完整。")
      word += text[i]; started = true
    } else { word += char; started = true }
  }
  if (quote) throw new Error("SSH 参数引号不完整。")
  if (started) result.push(word)
  return result
}

export function parseConnectionOptions(options?: string | null): string[] {
  const input = tokens(options ?? "")
  const result: string[] = []
  for (let i = 0; i < input.length; i++) {
    const token = input[i]!
    const flag = token.slice(0, 2)
    if (!["-p", "-i", "-J", "-o"].includes(flag)) throw new Error(`不支持的 SSH 参数：${token}`)
    const value = token.length > 2 ? token.slice(2) : input[++i]
    if (!value || value.startsWith("-")) throw new Error(`SSH 参数 ${flag} 缺少有效值。`)
    if (flag === "-p") port(value)
    if (flag === "-i" && /[%\x00-\x1f\x7f]/.test(value)) throw new Error("密钥路径不支持 SSH token 或控制字符。")
    if (flag === "-J") {
      const jumps = value.split(",")
      if (jumps.length > 8) throw new Error("跳板机数量过多。")
      for (const jump of jumps) {
        const match = jump.match(/^(.+?)(?::(\d+))?$/)!
        if (!match) throw new Error("无效的 SSH 跳板机。")
        validateTarget(match[1]!)
        if (match[2]) port(match[2])
      }
    }
    if (flag === "-o") {
      const equal = value.indexOf("=")
      const key = value.slice(0, equal).toLowerCase()
      const setting = value.slice(equal + 1)
      const numeric = ["connecttimeout", "serveraliveinterval", "serveralivecountmax"]
      if (equal < 1 || !(numeric.includes(key) ? /^\d{1,6}$/.test(setting)
        : key === "identitiesonly" ? /^(yes|no)$/i.test(setting)
        : key === "stricthostkeychecking" && /^(yes|accept-new)$/i.test(setting))) {
        throw new Error(`不支持的 SSH -o 参数：${value}；禁止本地命令、库、配置与日志入口。`)
      }
    }
    result.push(flag, value)
  }
  return result
}

export function serializeConnectionOptions(argv: readonly string[]): string | undefined {
  return argv.length ? argv.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ") : undefined
}

export function buildSshArgs(target: string, options?: string | null): string[] {
  validateTarget(target)
  const extra = parseConnectionOptions(options)
  for (let i = 0; i < extra.length; i += 2) {
    if (extra[i] !== "-i") continue
    const path = extra[i + 1]!
    extra[i + 1] = resolve(path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path)
  }
  // Do not allow ~/.ssh/config or system configuration to reintroduce executable
  // hooks. -F is propagated by OpenSSH to its ProxyJump subprocess as well.
  return ["-F", "none", "-T", "-o", "BatchMode=yes", "-o", "PermitLocalCommand=no",
    "-o", "KnownHostsCommand=none", "-o", "PKCS11Provider=none", "-o", "SecurityKeyProvider=internal",
    ...extra, "-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=60",
    "-o", "ServerAliveCountMax=3", target, "bash", "-l"]
}

export function connectionPermission(target: string, options?: string | null, remoteDirectory?: string | null) {
  const argv = buildSshArgs(target, options)
  return {
    action: "ssh_connect",
    // Keep the host as the matchable resource so per-device rules remain usable.
    // The exact argv is exposed in metadata for the prompt and audit trail.
    resources: [target],
    // Do not persist a host-only approval that would also authorize changed options.
    // Explicit configured rules can still allow a known connection.
    save: [],
    metadata: { host: target, argv, remoteDirectory: remoteDirectory ?? null },
  }
}
