import { assertPermission } from "../permission.js";
import { DeviceError, deviceTarget } from "../devices/types.js";
/** 设备档案的展示文本；刻意不列出任何认证材料（本来也不保存）。 */
function formatDevice(device) {
    const parts = [`${device.name}（${deviceTarget(device)}）`];
    if (device.port)
        parts.push(`端口 ${device.port}`);
    if (device.identityFile)
        parts.push(`密钥 ${device.identityFile}`);
    if (device.remoteDirectory)
        parts.push(`远端目录 ${device.remoteDirectory}`);
    if (device.options)
        parts.push(`附加参数 ${device.options}`);
    if (device.lastConnectedAt) {
        parts.push(`上次连接 ${new Date(device.lastConnectedAt).toLocaleString()}`);
    }
    return parts.join(" · ");
}
/**
 * 自然语言版的设备管理：让 Agent 可以列出、添加、修改、删除设备档案，
 * 与 `/ssh-devices` 界面读写同一份数据。
 *
 * 存储里不含密码与私钥内容，因此这个工具不接触任何秘密。
 */
export function createDevicesTool(runtime) {
    return {
        name: "ssh_devices",
        description: "List, save or remove saved SSH device profiles. Devices are remembered across projects " +
            "and are reused by `ssh_connect` via its `device` argument. Only non-secret connection " +
            "details are stored (address, user, port, key file path, optional remote directory) — " +
            "never passwords or key contents. Use action 'save' to add or update, 'remove' to delete.",
        input: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["list", "save", "remove"], description: "What to do" },
                id: { type: "string", description: "Existing device id, when updating a specific device" },
                name: { type: "string", description: "Device name / alias (required for save, used to find for remove)" },
                host: { type: "string", description: "IP address or hostname (required for save)" },
                user: { type: "string", description: "SSH user" },
                port: { type: "number", description: "SSH port" },
                identityFile: { type: "string", description: "Path to the private key file (path only, never key contents)" },
                options: { type: "string", description: "Extra raw ssh flags, e.g. '-J jump.example.com'" },
                remoteDirectory: { type: "string", description: "Default remote working directory" },
            },
            additionalProperties: false,
        },
        async execute(input, tool) {
            const args = (input ?? {});
            await assertPermission(runtime.ctx, tool, {
                action: "ssh_devices",
                resources: ["*"],
                save: ["*"],
                metadata: { operation: args.action ?? "list" },
            });
            const action = (args.action ?? "list").trim();
            try {
                if (action === "save") {
                    const saved = await runtime.devices.save({
                        id: args.id,
                        name: args.name,
                        host: args.host,
                        user: args.user,
                        port: args.port,
                        identityFile: args.identityFile,
                        options: args.options,
                        remoteDirectory: args.remoteDirectory,
                    });
                    return { content: `已保存设备：\n${formatDevice(saved)}` };
                }
                if (action === "remove") {
                    const selector = args.name?.trim() || args.id?.trim();
                    if (!selector)
                        return { content: "删除设备需要提供 name 或 id。" };
                    const existing = await runtime.devices.find(selector);
                    if (!existing)
                        return { content: `未找到设备「${selector}」。` };
                    await runtime.devices.remove(existing.id);
                    return { content: `已删除设备：${formatDevice(existing)}` };
                }
                const devices = await runtime.devices.list();
                if (!devices.length) {
                    return {
                        content: "还没有保存任何设备。可用 action=save 添加（name 与 host 必填），" +
                            "或在连接时直接使用 host 参数——连接成功后会自动记住。",
                    };
                }
                return {
                    content: `已保存的设备（${devices.length}）：\n${devices.map((d) => `· ${formatDevice(d)}`).join("\n")}`,
                };
            }
            catch (error) {
                if (error instanceof DeviceError)
                    return { content: error.issue };
                throw error;
            }
        },
    };
}
