import { Plugin } from "@opencode/plugin/tui"
import { SshDevicesRpc } from "./devices/rpc.js"

interface DeviceRecord {
  id: string
  name: string
  host: string
  user: string | null
  port: number | null
  identityFile: string | null
  options: string | null
  remoteDirectory: string | null
  lastConnectedAt: number | null
}

function deviceLine(device: DeviceRecord): string {
  const target = device.user ? `${device.user}@${device.host}` : device.host
  const extras: string[] = []
  if (device.port) extras.push(`端口 ${device.port}`)
  if (device.identityFile) extras.push(`密钥 ${device.identityFile}`)
  if (device.remoteDirectory) extras.push(device.remoteDirectory)
  return extras.length ? `${device.name} — ${target} · ${extras.join(" · ")}` : `${device.name} — ${target}`
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as { message?: unknown; error?: { message?: unknown } }
    if (typeof record.message === "string" && record.message) return record.message
    if (typeof record.error?.message === "string" && record.error.message) return record.error.message
  }
  return String(error)
}

export default Plugin.define({
  id: "opencode-ssh-workshop.tui",
  setup(context) {
    const devices = context.client.rpc(SshDevicesRpc)

    /**
     * 逐字段编辑。输入框展示的是占位提示，不是预填值；因此留空一律视为
     * **保持原值**，不会像修前那样把用户名、端口、密钥、远端目录清空。
     */
    async function editDevice(device: DeviceRecord): Promise<void> {
      const name = await context.ui.dialog.prompt({
        title: "设备名称（留空保持原值）",
        placeholder: device.name,
      })
      if (name === undefined) return
      const host = await context.ui.dialog.prompt({
        title: "地址（留空保持原值）",
        placeholder: device.host,
      })
      if (host === undefined) return
      const user = await context.ui.dialog.prompt({
        title: "用户名（留空保持原值）",
        placeholder: device.user ?? "（未设置）",
      })
      if (user === undefined) return
      const port = await context.ui.dialog.prompt({
        title: "端口（留空保持原值）",
        placeholder: device.port ? String(device.port) : "（默认 22）",
      })
      if (port === undefined) return
      const identityFile = await context.ui.dialog.prompt({
        title: "密钥文件路径（留空保持原值；只存路径，不存密钥内容）",
        placeholder: device.identityFile ?? "（未设置）",
      })
      if (identityFile === undefined) return
      const remoteDirectory = await context.ui.dialog.prompt({
        title: "默认远端目录（留空保持原值）",
        placeholder: device.remoteDirectory ?? "（登录目录）",
      })
      if (remoteDirectory === undefined) return
      const options = await context.ui.dialog.prompt({
        title: "附加 ssh 参数（留空保持原值，例如 -J jump.example.com）",
        placeholder: device.options ?? "（未设置）",
      })
      if (options === undefined) return

      const trimmedPort = port.trim()
      try {
        await devices.save({
          id: device.id,
          name: name.trim() || device.name,
          host: host.trim() || device.host,
          user: user.trim() || device.user,
          port: trimmedPort ? Number(trimmedPort) : device.port,
          identityFile: identityFile.trim() || device.identityFile,
          remoteDirectory: remoteDirectory.trim() || device.remoteDirectory,
          options: options.trim() || device.options,
        })
        context.ui.toast.show({ title: "SSH 设备", message: "已更新设备。", variant: "success" })
      } catch (error) {
        context.ui.toast.show({ title: "SSH 设备", message: errorMessage(error), variant: "error" })
      }
    }

    async function addDevice(): Promise<void> {
      const name = await context.ui.dialog.prompt({ title: "设备名称", placeholder: "开发服务器" })
      if (name === undefined) return
      const host = await context.ui.dialog.prompt({ title: "地址（IP 或主机名）", placeholder: "192.168.1.20" })
      if (host === undefined) return
      const user = await context.ui.dialog.prompt({ title: "用户名（可留空）", placeholder: "axiang" })
      if (user === undefined) return
      const port = await context.ui.dialog.prompt({ title: "端口（可留空）", placeholder: "22" })
      if (port === undefined) return
      const identityFile = await context.ui.dialog.prompt({
        title: "密钥文件路径（可留空；只存路径，不存密钥内容）",
        placeholder: "~/.ssh/id_ed25519",
      })
      if (identityFile === undefined) return
      const remoteDirectory = await context.ui.dialog.prompt({
        title: "默认远端目录（可留空）",
        placeholder: "/home/axiang/project",
      })
      if (remoteDirectory === undefined) return

      const trimmedPort = port.trim()
      try {
        await devices.save({
          name: name.trim(),
          host: host.trim(),
          user: user.trim() || undefined,
          port: trimmedPort ? Number(trimmedPort) : undefined,
          identityFile: identityFile.trim() || undefined,
          remoteDirectory: remoteDirectory.trim() || undefined,
        })
        context.ui.toast.show({ title: "SSH 设备", message: "已保存设备。", variant: "success" })
      } catch (error) {
        context.ui.toast.show({ title: "SSH 设备", message: errorMessage(error), variant: "error" })
      }
    }

    async function connectDevice(device: DeviceRecord): Promise<void> {
      const sessionID = currentSessionID()
      if (!sessionID) {
        context.ui.toast.show({
          title: "SSH 设备",
          message: "请先打开一个会话，再连接设备。",
          variant: "error",
        })
        return
      }
      const confirmed = await context.ui.dialog.confirm({
        title: "连接设备",
        message: `连接到「${device.name}」？该会话及其 SSH 子代理将共用这一条连接。`,
        label: { confirm: "连接", cancel: "取消" },
      })
      if (!confirmed) return
      try {
        const result = await devices.connect({ sessionID, deviceID: device.id })
        context.ui.toast.show({ title: "SSH 设备", message: (result as { message?: string }).message ?? "已连接。" })
      } catch (error) {
        context.ui.toast.show({ title: "SSH 设备", message: errorMessage(error), variant: "error" })
      }
    }

    async function removeDevice(device: DeviceRecord): Promise<void> {
      const confirmed = await context.ui.dialog.confirm({
        title: "删除设备",
        message: `删除「${device.name}」？只是移除记录，不会影响已建立的连接。`,
        label: { confirm: "删除", cancel: "取消" },
      })
      if (!confirmed) return
      try {
        await devices.remove({ id: device.id })
        context.ui.toast.show({ title: "SSH 设备", message: "已删除设备。", variant: "success" })
      } catch (error) {
        context.ui.toast.show({ title: "SSH 设备", message: errorMessage(error), variant: "error" })
      }
    }

    function currentSessionID(): string | undefined {
      const route = context.ui.router.current() as { type?: string; sessionID?: string }
      return route?.type === "session" ? route.sessionID : undefined
    }

    async function openDeviceManager(): Promise<void> {
      let list: DeviceRecord[] = []
      try {
        const result = await devices.list({})
        list = ((result as { devices?: DeviceRecord[] }).devices ?? []) as DeviceRecord[]
      } catch (error) {
        context.ui.toast.show({ title: "SSH 设备", message: errorMessage(error), variant: "error" })
        return
      }

      const options = [
        ...list.map((device) => ({
          title: deviceLine(device),
          value: `device:${device.id}`,
          category: "已保存设备",
        })),
        { title: "添加设备…", value: "action:add", category: "操作" },
      ]

      const selected = await context.ui.dialog.select({
        title: "SSH 设备",
        options,
        search: (query, entries) =>
          entries.filter((entry) => entry.title.toLowerCase().includes(query.trim().toLowerCase())),
      })
      if (!selected) return

      if (selected === "action:add") {
        await addDevice()
        return
      }

      const id = selected.slice("device:".length)
      const device = list.find((entry) => entry.id === id)
      if (!device) return

      const action = await context.ui.dialog.select({
        title: device.name,
        options: [
          { title: "连接", value: "connect", category: "设备" },
          { title: "编辑", value: "edit", category: "设备" },
          { title: "删除", value: "remove", category: "设备" },
        ],
      })
      if (action === "connect") await connectDevice(device)
      else if (action === "edit") await editDevice(device)
      else if (action === "remove") await removeDevice(device)
    }

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "opencode-ssh-workshop.devices",
          title: "SSH 设备管理",
          group: "SSH",
          palette: true,
          slash: { name: "ssh-devices", arguments: true },
          enabled: () => true,
          suggested: true,
          run: () => {
            void openDeviceManager()
          },
        },
      ],
    }))
  },
})
