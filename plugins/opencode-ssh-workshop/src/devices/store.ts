import { randomUUID } from "node:crypto"
import {
  DeviceError,
  type DeviceInput,
  type DeviceProfile,
  normalizeDeviceInput,
} from "./types.js"
import type { PluginContext } from "../types.js"

const STORAGE_KEY = "device-profiles"

interface StoreShape {
  devices: DeviceProfile[]
}

function readDevices(raw: unknown): DeviceProfile[] {
  if (!raw || typeof raw !== "object") return []
  const devices = (raw as StoreShape).devices
  return Array.isArray(devices) ? devices.filter((d) => d && typeof d === "object") : []
}

/**
 * 设备档案的持久化读写。
 *
 * 存储落在 OpenCode 的插件级持久存储里，因此**跨本机项目共用**，且不会进入
 * 任何项目 Git。存的是连接信息本身，不含密码与私钥内容。
 */
export interface DeviceStore {
  list(): Promise<DeviceProfile[]>
  get(id: string): Promise<DeviceProfile | undefined>
  /** 按名称（别名）或 id 查找；用于「连接开发服务器」这类自然语言说法。 */
  find(selector: string): Promise<DeviceProfile | undefined>
  save(input: Partial<DeviceInput> & { id?: string }): Promise<DeviceProfile>
  remove(id: string): Promise<boolean>
  touch(id: string, at: number): Promise<void>
}

export function createDeviceStore(ctx: PluginContext): DeviceStore {
  async function write(devices: DeviceProfile[]): Promise<void> {
    // OpenCode 的存储值类型是 JSON；这里用宽转换跳过「接口没有索引签名」的检查，
    // 序列化后读回仍走下面的 readDevices 做形状校验。
    await ctx.storage.set(STORAGE_KEY, { devices } as never)
  }

  async function list(): Promise<DeviceProfile[]> {
    return readDevices(await ctx.storage.get(STORAGE_KEY))
  }

  return {
    list,
    async get(id) {
      return (await list()).find((device) => device.id === id)
    },
    async find(selector) {
      const key = selector.trim().toLowerCase()
      if (!key) return undefined
      const devices = await list()
      return (
        devices.find((device) => device.id === key) ??
        devices.find((device) => device.name.toLowerCase() === key) ??
        devices.find((device) => device.host.toLowerCase() === key)
      )
    },
    async save(input) {
      const normalized = normalizeDeviceInput(input)
      const devices = await list()
      const now = Date.now()
      const existing = input.id ? devices.find((device) => device.id === input.id) : undefined
      if (input.id && !existing) throw new DeviceError(`未找到设备 ${input.id}，不能更新。`)

      const clash = devices.find(
        (device) => device.id !== existing?.id && device.name.toLowerCase() === normalized.name.toLowerCase(),
      )
      if (clash) throw new DeviceError(`已存在同名设备「${clash.name}」，请换一个名称。`)

      const saved: DeviceProfile = {
        id: existing?.id ?? randomUUID(),
        ...normalized,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        lastConnectedAt: existing?.lastConnectedAt ?? null,
      }

      const next = existing
        ? devices.map((device) => (device.id === existing.id ? saved : device))
        : [...devices, saved]
      await write(next)
      return saved
    },
    async remove(id) {
      const devices = await list()
      const next = devices.filter((device) => device.id !== id)
      if (next.length === devices.length) return false
      await write(next)
      return true
    },
    async touch(id, at) {
      const devices = await list()
      const index = devices.findIndex((device) => device.id === id)
      if (index < 0) return
      const current = devices[index]!
      devices[index] = { ...current, lastConnectedAt: at }
      await write(devices)
    },
  }
}
