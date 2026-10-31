import { assertPermission } from "../permission.js";
import { connectSession } from "../connect-core.js";
import { deviceOptions, deviceTarget } from "../devices/types.js";
/**
 * 迁移上游 `ssh_connect`，并接上设备档案。
 *
 * 与上游的差异：
 * - 新增 `device` 参数：传设备名称或 id 即可连接，不必每次输入 IP；
 * - `context.ask` → `ctx.permission.assert`（action `ssh_connect`，资源为最终目标）；
 * - 连接成功后登记「远端工作区」并自动记住设备。
 *
 * 实际连接逻辑与 `/ssh-devices` 界面共用 `connectSession`。
 */
export function createConnectTool(runtime) {
    return {
        name: "ssh_connect",
        description: "Open a persistent SSH session to a remote host. " +
            "Pass `device` with a saved device name to reuse a remembered host, " +
            "or pass `host` directly (e.g. 'user@server', 'myalias', 'user@192.168.1.10'). " +
            "The whole session, including its SSH subagents, shares this one connection and " +
            "remote working directory. Use `ssh_disconnect` to close it.",
        input: {
            type: "object",
            properties: {
                device: {
                    type: "string",
                    description: "Saved device name or id from `ssh_devices`; preferred over `host`.",
                },
                host: {
                    type: "string",
                    description: "SSH host to connect to when not using a saved device.",
                },
                options: {
                    type: "string",
                    description: "Extra SSH flags (e.g. '-p 2222', '-i ~/.ssh/mykey'). Ignored for saved devices.",
                },
            },
            additionalProperties: false,
        },
        async execute(input, tool) {
            const args = (input ?? {});
            let target;
            let options;
            let remoteDirectory = null;
            let deviceID = null;
            let deviceName = null;
            if (args.device?.trim()) {
                const profile = await runtime.devices.find(args.device.trim());
                if (!profile) {
                    const known = (await runtime.devices.list()).map((d) => d.name).join("、");
                    return {
                        content: `未找到设备「${args.device}」。已保存的设备：${known || "（无）"}。可用 ssh_devices 添加。`,
                    };
                }
                target = deviceTarget(profile);
                options = deviceOptions(profile);
                remoteDirectory = profile.remoteDirectory;
                deviceID = profile.id;
                deviceName = profile.name;
            }
            else if (args.host?.trim()) {
                target = args.host.trim();
                options = args.options?.trim() || undefined;
            }
            else {
                return {
                    content: "需要提供 device（已保存的设备名）或 host（如 user@192.168.1.10）。" +
                        "可用 ssh_devices 查看或添加设备。",
                };
            }
            await assertPermission(runtime.ctx, tool, {
                action: "ssh_connect",
                resources: [target],
                save: [target],
                metadata: { host: target, device: deviceName },
            });
            const rootID = await runtime.workspaces.resolveRoot(tool.sessionID);
            return {
                content: await connectSession(runtime, rootID, {
                    target,
                    options,
                    remoteDirectory,
                    deviceID,
                    remember: !deviceID && runtime.rememberDevices,
                    signal: tool.signal,
                }),
            };
        },
    };
}
